// Keeps the ShipwayShipment collection fresh: one lookup per order, newest first, only where something can still change.
const cfg = require('../config');
const { Order, ShipwayShipment, Setting } = require('../models');
const { normalizeShipment, pickCandidates } = require('../lib/shipwayMap');
const client = require('./shipwayClient');

const LAST_KEY = 'shipway.last';
const STALE_MS = 30 * 60 * 1000;
const state = { runningSince: 0, progress: 0, total: 0 };
const isRunning = () => !!state.runningSince && Date.now() - state.runningSince < STALE_MS;
const getSetting = async (k) => { const s = await Setting.findOne({ key: k }).lean(); return s ? s.value : null; };
const putSetting = (k, value) => Setting.findOneAndUpdate({ key: k }, { key: k, value }, { upsert: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ask Shipway about one order and save the answer (keeps the list of status changes it has seen).
async function refreshOne(orderId) {
  const prev = await ShipwayShipment.findOne({ orderId }).lean();
  const now = new Date();
  let r;
  try { r = await client.getOrderShipmentDetails(orderId); } catch (e) {
    if (e.code === 'auth' || e.code === 'not_configured') throw e; // nothing else will work either
    await ShipwayShipment.updateOne({ orderId }, { $set: { checkedAt: now, error: e.message }, $setOnInsert: { orderId, found: false } }, { upsert: true });
    return { orderId, error: e.message };
  }
  if (!r.found) {
    // Never wipe a status we already have because of a lookup that came back empty.
    if (prev && prev.found) { await ShipwayShipment.updateOne({ orderId }, { $set: { checkedAt: now, error: '' } }); return { orderId, kept: true }; }
    await ShipwayShipment.updateOne({ orderId }, { $set: { found: false, checkedAt: now, error: '' }, $setOnInsert: { orderId } }, { upsert: true });
    return { orderId, found: false };
  }
  const d = normalizeShipment(r.response, r.id);
  const changed = !prev || prev.statusCode !== d.statusCode || prev.status !== d.status;
  const history = changed ? [...((prev && prev.history) || []), { code: d.statusCode, status: d.status, at: d.statusAt || now }].slice(-30) : prev.history;
  await ShipwayShipment.updateOne({ orderId }, { $set: { ...d, history, checkedAt: now, error: '', ...(changed ? { changedAt: now } : {}) }, $setOnInsert: { orderId } }, { upsert: true });
  return { orderId, found: true, changed };
}

// limit: how many orders to look up in this run (the timer uses a small batch, the button a big one).
async function run({ limit = 300, all = false } = {}) {
  if (!client.isConfigured()) throw Object.assign(new Error('Shipway is not set up yet.'), { status: 400 });
  if (isRunning()) throw Object.assign(new Error('A Shipway sync is already running'), { status: 409 });
  state.runningSince = Date.now(); state.progress = 0; state.total = 0;
  let checked = 0; let found = 0; let changed = 0; let missing = 0; let failed = 0;
  try {
    const [orders, docs] = await Promise.all([
      Order.find({ excluded: null, orderId: { $ne: null } }).select('orderId orderDate').sort({ orderDate: -1, orderId: -1 }).lean(),
      ShipwayShipment.find().select('orderId found final error checkedAt').lean(),
    ]);
    const ids = pickCandidates(orders, new Map(docs.map((d) => [d.orderId, d])), new Date(), { limit: all ? 100000 : limit });
    state.total = ids.length;
    const queue = [...ids];
    let authErr = null;
    const worker = async () => {
      while (queue.length && !authErr) {
        const id = queue.shift();
        try {
          const r = await refreshOne(id);
          checked++; if (r.error) failed++; else if (r.found) { found++; if (r.changed) changed++; } else if (!r.kept) missing++;
        } catch (e) { authErr = e; }
        state.progress = checked;
        await sleep(120); // be gentle with Shipway
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (authErr) throw authErr;
    await putSetting(LAST_KEY, { at: new Date(), ok: true, checked, found, changed, missing, failed });
    return { checked, found, changed, missing, failed };
  } catch (e) {
    await putSetting(LAST_KEY, { at: new Date(), ok: false, checked, error: e.message }).catch(() => {});
    throw e;
  } finally { state.runningSince = 0; }
}

// For the order drawer: a fresh look at one order if the saved answer is old (moving shipments) or missing.
const tried = new Map();
async function ensureFresh(orderId, maxAgeMin = 10) {
  if (!client.isConfigured() || !Number.isFinite(orderId)) return ShipwayShipment.findOne({ orderId }).lean();
  const have = await ShipwayShipment.findOne({ orderId }).lean();
  const stale = !have || (!have.final && Date.now() - new Date(have.checkedAt) > maxAgeMin * 60000);
  if (stale && Date.now() - (tried.get(orderId) || 0) > 2 * 60000) {
    tried.set(orderId, Date.now());
    try { await refreshOne(orderId); } catch (e) { return have || null; }
    return ShipwayShipment.findOne({ orderId }).lean();
  }
  return have;
}

async function status() {
  const [last, count, byGroup] = await Promise.all([
    getSetting(LAST_KEY),
    ShipwayShipment.countDocuments({ found: true }),
    ShipwayShipment.aggregate([{ $match: { found: true } }, { $group: { _id: '$group', n: { $sum: 1 } } }]),
  ]);
  return {
    configured: client.isConfigured(), username: cfg.shipway.username, intervalMin: cfg.shipway.syncIntervalMin, idFormat: cfg.shipway.orderIdFormat,
    running: isRunning(), progress: state.progress, total: state.total, last, tracked: count, byGroup: Object.fromEntries(byGroup.map((g) => [g._id || 'other', g.n])),
  };
}

// Login check plus one real lookup (newest order), so a wrong order-id format shows up here and not as an empty column.
async function test() {
  const problems = [];
  await client.authenticate();
  const recent = await Order.find({ excluded: null, orderId: { $ne: null } }).select('orderId').sort({ orderDate: -1, orderId: -1 }).limit(8).lean();
  let sample = null;
  for (const o of recent) {
    const r = await client.getOrderShipmentDetails(o.orderId);
    if (r.found) { const d = normalizeShipment(r.response, r.id); sample = { orderId: o.orderId, shipwayOrderId: r.id, status: d.status, code: d.statusCode, carrier: d.carrier, awb: d.awb }; break; }
  }
  if (!sample && recent.length) problems.push(`Login works, but Shipway has no shipment for the ${recent.length} newest orders (${recent.map((o) => o.orderId).join(', ')}). Either they are not dispatched yet, or Shipway holds them under a different order number. If dispatched orders appear in Shipway as something other than 1874 or #1874, tell the developer the exact format.`);
  return { ok: problems.length === 0, sample, problems };
}

function start() {
  if (!client.isConfigured()) { console.log('[shipway] not configured (SHIPWAY_USERNAME / SHIPWAY_LICENSE_KEY): skipped'); return; }
  const every = cfg.shipway.syncIntervalMin;
  const tick = () => run({ limit: 300 }).catch((e) => { if (e.status !== 409) console.warn('[shipway] sync failed:', e.message); });
  setTimeout(tick, 20000);
  if (every > 0) setInterval(tick, every * 60 * 1000);
  console.log(`[shipway] connected as ${cfg.shipway.username}${every > 0 ? `, refreshing every ${every} min` : ''}`);
}

module.exports = { run, refreshOne, ensureFresh, status, test, start };
