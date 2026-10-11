const crypto = require('crypto');
const cfg = require('../config');
const { Snapshot, ShopifyDate, Order, SyncRun } = require('../models');
const { cleanOrders, parseOrdersMaster, parseShopifyExport } = require('../lib/clean');
const { fetchSheets } = require('./sources');
const { getSheetConfig } = require('./sheetConfig');

// ---- one sync at a time, with a watchdog so a stuck run can never block the schedule for good ----
const STALE_LOCK_MS = 5 * 60 * 1000;
let runningSince = 0;
const state = { lastAutoAt: null }; // for the status screen

const hashRows = (rows) => crypto.createHash('sha1').update(JSON.stringify(rows || null)).digest('hex');

async function saveSnapshot(tab, rows, source, hash = hashRows(rows)) {
  await Snapshot.findOneAndUpdate({ tab }, { tab, rows, source, hash, fetchedAt: new Date() }, { upsert: true });
}

// Replace the derived Order copy WITHOUT an empty moment: upsert every row by sheet row,
// then delete rows that belong to an older sync. Dashboards never see a half-empty table,
// and a failure mid-way leaves the previous data in place.
async function swapOrders(orders) {
  const syncId = crypto.randomUUID();
  for (let i = 0; i < orders.length; i += 1000) {
    const ops = orders.slice(i, i + 1000).map((o) => ({
      replaceOne: { filter: { sheetRow: o.sheetRow }, replacement: { ...o, syncId }, upsert: true },
    }));
    await Order.bulkWrite(ops, { ordered: false });
  }
  await Order.deleteMany({ syncId: { $ne: syncId } });
}

// Re-clean from the stored raw copies. The Order collection is a derived copy.
async function recleanFromSnapshots(trigger, source, extraWarnings = []) {
  const orderSnap = await Snapshot.findOne({ tab: 'order' }).lean();
  if (!orderSnap) throw Object.assign(new Error('No Order Sheet data yet. Run a sync or upload a CSV export.'), { status: 409 });
  const masterSnap = await Snapshot.findOne({ tab: 'master' }).lean();
  const now = new Date();
  const m = parseOrdersMaster(masterSnap ? masterSnap.rows : null, now);
  const shopify = new Map((await ShopifyDate.find().lean()).map((d) => [d.orderId, d.createdAt]));
  const { orders, summary, warnings } = cleanOrders(orderSnap.rows, { masterDates: m.map, shopifyDates: shopify, now });
  const allWarnings = [...extraWarnings, ...m.warnings, ...warnings];
  summary.ordersMasterRows = m.map.size;
  summary.shopifyBackfillRows = shopify.size;
  summary.orderSheetFetchedAt = orderSnap.fetchedAt;

  await swapOrders(orders);
  await SyncRun.create({ trigger, source, ok: true, changed: true, summary, warnings: allWarnings });
  return { changed: true, summary, warnings: allWarnings };
}

async function guarded(trigger, source, fn) {
  if (runningSince && Date.now() - runningSince < STALE_LOCK_MS) throw Object.assign(new Error('A sync is already running'), { status: 409 });
  runningSince = Date.now();
  try { return await fn(); }
  catch (e) {
    if (e.status !== 409) await SyncRun.create({ trigger, source, ok: false, error: e.message }).catch(() => {});
    throw e;
  } finally { runningSince = 0; }
}

// force = true for the manual button (always re-clean). Auto and cron runs skip the clean when nothing changed.
const syncFromSheet = (trigger = 'manual', { force = trigger === 'manual' } = {}) => guarded(trigger, 'sheet', async () => {
  const sc = await getSheetConfig();
  if (sc.source === 'none') throw Object.assign(new Error('No Google Sheet connected yet. Paste the sheet link under "Connect Google Sheet" in Settings, or upload CSV files.'), { status: 400 });
  const { orderRows, masterRows, warnings } = await fetchSheets(sc);
  const orderHash = hashRows(orderRows);
  const masterHash = masterRows ? hashRows(masterRows) : null;

  if (!force) {
    const [oSnap, mSnap, haveOrders] = await Promise.all([
      Snapshot.findOne({ tab: 'order' }).select('hash').lean(),
      Snapshot.findOne({ tab: 'master' }).select('hash').lean(),
      Order.estimatedDocumentCount(),
    ]);
    const sameMaster = masterHash == null ? true : !!mSnap && mSnap.hash === masterHash;
    if (haveOrders > 0 && oSnap && oSnap.hash === orderHash && sameMaster) {
      await SyncRun.create({ trigger, source: sc.source, ok: true, changed: false, warnings });
      return { changed: false };
    }
  }
  await saveSnapshot('order', orderRows, sc.source, orderHash);
  if (masterRows) await saveSnapshot('master', masterRows, sc.source, masterHash);
  const result = await recleanFromSnapshots(trigger, sc.source, warnings);
  require('./shopifySync').kick(); // new rows in the sheet: fetch their customer details and items right away
  return result;
});

const syncFromUpload = ({ orderRows, masterRows }) => guarded('upload', 'upload', async () => {
  if (orderRows) await saveSnapshot('order', orderRows, 'upload');
  if (masterRows) await saveSnapshot('master', masterRows, 'upload');
  return recleanFromSnapshots('upload', 'upload');
});

const importShopifyExport = (rows) => guarded('shopify-upload', 'upload', async () => {
  const map = parseShopifyExport(rows);
  if (!map.size) throw Object.assign(new Error('No usable orders found in the Shopify export'), { status: 400 });
  await ShopifyDate.bulkWrite([...map].map(([orderId, createdAt]) => ({
    updateOne: { filter: { orderId }, update: { $set: { orderId, createdAt } }, upsert: true },
  })));
  const r = await recleanFromSnapshots('shopify-upload', 'upload');
  return { imported: map.size, ...r };
});

const recleanOnly = () => guarded('settings', 'snapshot', () => recleanFromSnapshots('settings', 'snapshot'));

// Used by the external trigger URL. Skips if a successful check happened very recently,
// so a pinger hitting every few minutes does not hammer Google.
async function syncIfDue(trigger = 'cron') {
  const last = await SyncRun.findOne({ ok: true, trigger: { $in: ['auto', 'cron', 'manual'] } }).sort({ at: -1 }).select('at').lean();
  if (last && Date.now() - new Date(last.at).getTime() < cfg.cronMinAgeMin * 60 * 1000) return { skipped: true, reason: `checked less than ${cfg.cronMinAgeMin} min ago` };
  return syncFromSheet(trigger, { force: false });
}

// Instant sync: the sheet calls the webhook the moment something changes. Bursts of edits are merged into one sync;
// if a sync is already running we wait for it; if Google's export has not caught up yet we look once more.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let soonTimer = null;
function requestSync(trigger = 'webhook', delayMs = 2000) {
  if (soonTimer) return; // one is already queued: it will pick up this change too
  soonTimer = setTimeout(async () => {
    soonTimer = null;
    try {
      let r;
      for (let i = 0; i < 8; i++) {
        try { r = await syncFromSheet(trigger, { force: false }); break; }
        catch (e) { if (e.status !== 409) throw e; await sleep(4000); } // another sync is running: wait our turn
      }
      if (r && r.changed === false) { // sheet export may lag a few seconds behind the edit
        await sleep(15000);
        r = await syncFromSheet(trigger, { force: false }).catch((e) => { if (e.status !== 409) throw e; });
      }
      console.log(`[webhook] sync ${r && r.changed === false ? 'ok, no changes' : 'ok'}`);
    } catch (e) { console.warn('[webhook] sync failed:', e.message); }
  }, delayMs);
}

function startAutoSync() {
  if (!cfg.syncIntervalMin) { console.log('[sync] auto sync is off (SYNC_INTERVAL_MIN=0)'); return; }
  const run = async () => {
    state.lastAutoAt = new Date();
    try {
      if ((await getSheetConfig()).source === 'none') return; // nothing connected: stay quiet
      const r = await syncFromSheet('auto', { force: false });
      console.log(`[sync] auto sync ok${r.changed === false ? ' (no changes)' : ''}`);
    } catch (e) { console.warn('[sync] auto sync failed:', e.message); }
  };
  setTimeout(run, 3000);
  setInterval(run, cfg.syncIntervalMin * 60 * 1000);
  console.log(`[sync] auto sync every ${cfg.syncIntervalMin} min`);
}

module.exports = { syncFromSheet, syncFromUpload, importShopifyExport, recleanOnly, syncIfDue, requestSync, startAutoSync, state };
