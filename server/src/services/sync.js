const cfg = require('../config');
const { Snapshot, ShopifyDate, Order, SyncRun } = require('../models');
const { cleanOrders, parseOrdersMaster, parseShopifyExport } = require('../lib/clean');
const { fetchSheets } = require('./sources');

let running = false;

async function saveSnapshot(tab, rows, source) {
  await Snapshot.findOneAndUpdate({ tab }, { tab, rows, source, fetchedAt: new Date() }, { upsert: true });
}

// Re-clean from the stored raw copies. The Order collection is a derived copy and is rebuilt in full.
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

  await Order.deleteMany({});
  if (orders.length) await Order.insertMany(orders, { ordered: false });
  await SyncRun.create({ trigger, source, ok: true, summary, warnings: allWarnings });
  return { summary, warnings: allWarnings };
}

async function guarded(trigger, source, fn) {
  if (running) throw Object.assign(new Error('A sync is already running'), { status: 409 });
  running = true;
  try { return await fn(); }
  catch (e) {
    await SyncRun.create({ trigger, source, ok: false, error: e.message }).catch(() => {});
    throw e;
  } finally { running = false; }
}

const syncFromSheet = (trigger = 'manual') => guarded(trigger, cfg.sheet.source, async () => {
  const { orderRows, masterRows, warnings } = await fetchSheets();
  await saveSnapshot('order', orderRows, cfg.sheet.source);
  if (masterRows) await saveSnapshot('master', masterRows, cfg.sheet.source);
  return recleanFromSnapshots(trigger, cfg.sheet.source, warnings);
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

function startAutoSync() {
  if (!cfg.syncIntervalMin || cfg.sheet.source === 'none') return;
  const run = () => syncFromSheet('auto').then(() => console.log('[sync] auto sync ok'), (e) => console.warn('[sync] auto sync failed:', e.message));
  setTimeout(run, 3000);
  setInterval(run, cfg.syncIntervalMin * 60 * 1000);
}

module.exports = { syncFromSheet, syncFromUpload, importShopifyExport, recleanOnly, startAutoSync };
