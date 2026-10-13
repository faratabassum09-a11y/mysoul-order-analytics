// Pulls orders from Shopify into the ShopifyOrder collection (customer + items) and keeps them fresh.
const cfg = require('../config');
const { ShopifyOrder, ShopifyDate, Setting } = require('../models');
const { normalizeOrder, ATTRS_V } = require('../lib/shopifyMap');
const client = require('./shopifyClient');
const auth = require('./shopifyAuth'); // also plugs the install-link token into the client

const LAST_KEY = 'shopify.last';
const CURSOR_KEY = 'shopify.cursor';
const ATTRS_KEY = 'shopify.attrsV'; // which marketing-mapping version has been loaded for all orders
const STALE_MS = 30 * 60 * 1000;

const state = { runningSince: 0, mode: null, progress: 0 };
const isRunning = () => !!state.runningSince && Date.now() - state.runningSince < STALE_MS;
const getSetting = async (k) => { const s = await Setting.findOne({ key: k }).lean(); return s ? s.value : null; };
const putSetting = (k, value) => Setting.findOneAndUpdate({ key: k }, { key: k, value }, { upsert: true });

async function upsertNodes(nodes) {
  const docs = nodes.map(normalizeOrder).filter(Boolean);
  if (!docs.length) return { saved: 0, newDates: 0 };
  const syncedAt = new Date();
  await ShopifyOrder.bulkWrite(docs.map((d) => ({ replaceOne: { filter: { orderId: d.orderId }, replacement: { ...d, syncedAt }, upsert: true } })), { ordered: false });
  // The order date also fills the "undated" rows in the sheet (same job the CSV backfill did).
  const dated = docs.filter((d) => d.createdAt);
  let newDates = 0;
  if (dated.length) {
    const r = await ShopifyDate.bulkWrite(dated.map((d) => ({ updateOne: { filter: { orderId: d.orderId }, update: { $setOnInsert: { orderId: d.orderId, createdAt: d.createdAt } }, upsert: true } })), { ordered: false });
    newDates = r.upsertedCount || 0;
  }
  return { saved: docs.length, newDates };
}

// Re-clean the sheet data when Shopify brought new dates, so undated rows pick them up.
async function applyNewDates() {
  const sync = require('./sync'); // lazy: sync.js also uses this file
  for (let i = 0; i < 4; i++) {
    try { await sync.recleanOnly(); return; } catch (e) { if (e.status !== 409) return; await new Promise((r) => setTimeout(r, 5000)); }
  }
}

// full = every order Shopify will give us (newest first). Otherwise only orders changed since the last run.
async function run({ full = false } = {}) {
  if (!client.isConfigured()) throw Object.assign(new Error('Shopify is not set up yet.'), { status: 400 });
  if (isRunning()) throw Object.assign(new Error('A Shopify sync is already running'), { status: 409 });
  state.runningSince = Date.now(); state.progress = 0;
  const startedAt = new Date();
  let saved = 0; let newDates = 0;
  try {
    const have = await ShopifyOrder.estimatedDocumentCount();
    const cursor = await getSetting(CURSOR_KEY);
    // Orders saved before the marketing fields existed get one full reload, then incremental syncing resumes.
    const needsMarketing = have > 0 && (await getSetting(ATTRS_KEY)) !== ATTRS_V;
    const doFull = full || !have || !cursor || needsMarketing;
    state.mode = doFull ? 'full' : 'incremental';
    const onPage = async (nodes) => { const r = await upsertNodes(nodes); saved += r.saved; newDates += r.newDates; state.progress = saved; };
    if (doFull) await client.pullOrders({ query: null, sortKey: 'CREATED_AT', reverse: true, onPage });
    else {
      const since = new Date(new Date(cursor).getTime() - 5 * 60 * 1000).toISOString(); // small overlap so nothing slips through
      await client.pullOrders({ query: `updated_at:>='${since}'`, sortKey: 'UPDATED_AT', reverse: false, onPage });
    }
    if (doFull) await putSetting(ATTRS_KEY, ATTRS_V);
    await putSetting(CURSOR_KEY, startedAt.toISOString());
    await putSetting(LAST_KEY, { at: new Date(), ok: true, mode: state.mode, saved, newDates });
    if (newDates > 0) await applyNewDates();
    return { mode: state.mode, saved, newDates };
  } catch (e) {
    await putSetting(LAST_KEY, { at: new Date(), ok: false, mode: state.mode, saved, error: e.message }).catch(() => {});
    throw e;
  } finally { state.runningSince = 0; state.mode = null; }
}

// Fire-and-forget (after a sheet sync brought something new).
function kick() {
  if (!client.isConfigured() || isRunning()) return;
  run({}).catch((e) => console.warn('[shopify] sync failed:', e.message));
}
// Right after the store has been linked: load everything Shopify allows.
function kickFull() {
  if (!client.isConfigured() || isRunning()) return;
  run({ full: true }).catch((e) => console.warn('[shopify] first load failed:', e.message));
}

// One order on demand, e.g. when someone opens an order the pull has not reached yet. Not repeated for 5 minutes.
const tried = new Map();
async function ensureOrder(orderId) {
  if (!client.isConfigured() || !Number.isFinite(orderId)) return null;
  const have = await ShopifyOrder.findOne({ orderId }).lean();
  if (have) return have;
  if (Date.now() - (tried.get(orderId) || 0) < 5 * 60 * 1000) return null;
  tried.set(orderId, Date.now());
  const node = await client.fetchByNumber(orderId);
  if (!node) return null;
  await upsertNodes([node]);
  return ShopifyOrder.findOne({ orderId }).lean();
}

async function status() {
  const [last, orders, cursor, link] = await Promise.all([getSetting(LAST_KEY), ShopifyOrder.estimatedDocumentCount(), getSetting(CURSOR_KEY), auth.info()]);
  return {
    configured: client.isConfigured(), shop: cfg.shopify.shop, apiVersion: cfg.shopify.apiVersion, intervalMin: cfg.shopify.syncIntervalMin,
    running: isRunning(), mode: state.mode, progress: state.progress, last, orders, cursor, auth: link,
  };
}

async function test() {
  const { shop, scopes } = await client.ping();
  const has = (s) => scopes.includes(s);
  const problems = [];
  if (!has('read_orders')) problems.push('Missing scope read_orders. Add it to the app version in the Dev Dashboard and release it.');
  if (!has('read_customers')) problems.push('Missing scope read_customers. Add it to the app version in the Dev Dashboard and release it.');
  // Read the newest order with every field we use: this is what exposes missing customer-data access.
  let sample = null;
  try {
    const n = await client.latestOrder();
    if (n) { const d = normalizeOrder(n); sample = { name: n.name, items: d.items.length, hasCustomerName: !!d.customer.name, hasEmail: !!d.customer.email, hasAddress: !!d.address.city }; }
  } catch (e) { problems.push(e.message); }
  if (sample && sample.items && !sample.hasCustomerName && !sample.hasEmail) problems.push('The newest order came back without any customer details. Customer data access may not be enabled for this app (see the README, Shopify section).');
  return { ok: problems.length === 0, shop, scopes, allOrdersScope: has('read_all_orders'), sample, problems };
}

function start() {
  if (!client.isConfigured()) { console.log('[shopify] not configured (SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET): skipped'); return; }
  const every = cfg.shopify.syncIntervalMin;
  const tick = () => run({}).catch((e) => { if (e.status !== 409) console.warn('[shopify] sync failed:', e.message); });
  setTimeout(tick, 10000);
  if (every > 0) setInterval(tick, every * 60 * 1000);
  console.log(`[shopify] connected to ${cfg.shopify.shop}${every > 0 ? `, pulling changes every ${every} min` : ''}`);
}

module.exports = { run, kick, kickFull, ensureOrder, status, test, start, upsertNodes };
