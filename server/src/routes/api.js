const express = require('express');
const multer = require('multer');
const { Order, SyncRun, Setting, ShopifyOrder, ShipwayShipment } = require('../models');
const { resolveWindow, dateFilter } = require('../lib/windows');
const { computeMetrics, computeTrends, computeOverviewTrends, overviewStart } = require('../lib/metrics');
const { computeCampaigns, diagnose, BY: CAMPAIGN_BY } = require('../lib/campaigns');
const { summarize, DEFAULT_REASON_MAP } = require('../lib/reasons');
const { RAW_HEADERS } = require('../lib/clean');
const { fmtDate, fmtDateTime } = require('../lib/istTime');
const sync = require('../services/sync');
const shopify = require('../services/shopifySync');
const shopifyAuth = require('../services/shopifyAuth');
const shipway = require('../services/shipwaySync');
const { GROUPS: SHIPWAY_GROUPS } = require('../lib/shipwayMap');
const { parseCsv, assertLooksLikeOrderSheet } = require('../services/sources');
const { getSheetConfig, saveSheetConfig } = require('../services/sheetConfig');
const cfg = require('../config');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MODES = ['COD', 'Partial COD', 'Prepaid'];
const STATUSES = ['Pending confirmation', 'Cancelled', 'Confirmed', 'In Transit', 'Delivered', 'RTO'];
const METRIC_FIELDS = 'orderId orderDate amount paymentMode confirmed dispatched finalStatus ndr';

const winOf = (q) => resolveWindow(q.window || 'this_month', new Date(), { from: q.from, to: q.to });
const validOrders = (range, extra = {}, fields = METRIC_FIELDS) =>
  Order.find({ excluded: null, ...dateFilter(range), ...extra }).select(fields).lean();
const rangeOut = (w) => ({
  key: w.key, label: w.label, partial: w.partial,
  start: w.start ? fmtDate(w.start) : null, end: w.end ? fmtDate(new Date(w.end - 1)) : null,
  prev: w.prev ? { start: fmtDate(w.prev.start), end: fmtDate(new Date(w.prev.end - 1)) } : null,
});

// ---------- sync ----------
router.get('/sync/status', wrap(async (req, res) => {
  const last = await SyncRun.findOne().sort({ at: -1 }).lean();
  const lastCheck = await SyncRun.findOne({ ok: true }).sort({ at: -1 }).select('at changed trigger').lean(); // sheet reached, even if nothing new
  const lastOk = await SyncRun.findOne({ ok: true, changed: { $ne: false } }).sort({ at: -1 }).lean();   // data actually updated
  const lastWebhook = await SyncRun.findOne({ trigger: 'webhook' }).sort({ at: -1 }).select('at').lean(); // last signal from the sheet itself
  const sc = await getSheetConfig();
  res.json({
    last, lastOk, lastCheck, lastWebhook,
    config: { source: sc.source, sheetConfigured: !!sc.sheetId, autoSyncMin: cfg.syncIntervalMin, cronEnabled: !!cfg.cronSecret, orderTab: sc.orderTab },
  });
}));
router.post('/sync', wrap(async (req, res) => res.json(await sync.syncFromSheet('manual', { force: true }))));
router.post('/sync/reclean', wrap(async (req, res) => res.json(await sync.recleanOnly())));
router.post('/sync/upload', upload.fields([{ name: 'orderSheet', maxCount: 1 }, { name: 'ordersMaster', maxCount: 1 }]), wrap(async (req, res) => {
  const f = req.files || {};
  if (!f.orderSheet && !f.ordersMaster) return res.status(400).json({ error: 'Attach orderSheet and/or ordersMaster CSV' });
  const rows = (file) => (file ? parseCsv(file[0].buffer.toString('utf8')) : null);
  if (f.orderSheet) assertLooksLikeOrderSheet(rows(f.orderSheet));
  res.json(await sync.syncFromUpload({ orderRows: rows(f.orderSheet), masterRows: rows(f.ordersMaster) }));
}));
router.post('/sync/shopify-csv', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach the Shopify orders CSV as "file"' });
  res.json(await sync.importShopifyExport(parseCsv(req.file.buffer.toString('utf8'))));
}));

// ---------- Google Sheet connection (set from the website) ----------
router.get('/settings/sheet', wrap(async (req, res) => {
  const sc = await getSheetConfig();
  res.json({
    connected: !!sc.sheetId, source: sc.source, fromEnv: !!sc.sheetId && !sc.fromUi,
    link: sc.sheetId ? `https://docs.google.com/spreadsheets/d/${sc.sheetId}/edit${sc.orderGid ? `?gid=${sc.orderGid}` : ''}` : '',
    orderTab: sc.orderTab, masterTab: sc.masterTab, masterGid: sc.masterGid,
  });
}));
router.put('/settings/sheet', wrap(async (req, res) => { await saveSheetConfig(req.body || {}); res.json({ saved: true }); }));

// ---------- metrics ----------
// ---------- Shopify (customer details + items) ----------
// A Shopify 401/404 must not look like "dashboard password needed" to the browser, so Shopify failures become 502.
const shopWrap = (fn) => wrap(async (req, res) => {
  try { await fn(req, res); } catch (e) { if (e.name === 'ShopifyError') e.status = e.status === 400 ? 400 : 502; throw e; }
});
router.get('/shopify/status', wrap(async (req, res) => res.json({ ...(await shopify.status()), redirectUri: shopifyAuth.redirectUri(req), scopes: cfg.shopify.scopes })));
router.post('/shopify/connect', shopWrap(async (req, res) => res.json(await shopifyAuth.beginUrl(req)))); // returns the Shopify approval address
router.post('/shopify/disconnect', wrap(async (req, res) => { await shopifyAuth.disconnect(); res.json({ disconnected: true }); }));
router.post('/shopify/test', shopWrap(async (req, res) => res.json(await shopify.test())));
router.post('/shopify/sync', shopWrap(async (req, res) => {
  const st = await shopify.status();
  if (!st.configured) return res.status(400).json({ error: 'Shopify is not set up yet. Add SHOPIFY_SHOP, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET on the server.' });
  if (st.running) return res.status(409).json({ error: 'A Shopify sync is already running' });
  shopify.run({ full: req.query.full === '1' }).catch((e) => console.warn('[shopify] sync failed:', e.message)); // runs in the background; progress shows in /shopify/status
  res.status(202).json({ started: true });
}));

// ---------- Shipway (dispatch and tracking status) ----------
const shipWrap = (fn) => wrap(async (req, res) => {
  try { await fn(req, res); } catch (e) { if (e.name === 'ShipwayError') e.status = e.status === 400 ? 400 : 502; throw e; }
});
router.get('/shipway/status', wrap(async (req, res) => res.json({ ...(await shipway.status()), groups: SHIPWAY_GROUPS })));
router.post('/shipway/test', shipWrap(async (req, res) => res.json(await shipway.test())));
router.post('/shipway/sync', shipWrap(async (req, res) => {
  const st = await shipway.status();
  if (!st.configured) return res.status(400).json({ error: 'Shipway is not set up yet. Add SHIPWAY_USERNAME and SHIPWAY_LICENSE_KEY on the server.' });
  if (st.running) return res.status(409).json({ error: 'A Shipway sync is already running' });
  shipway.run({ all: req.query.all === '1', limit: 1000 }).catch((e) => console.warn('[shipway] sync failed:', e.message)); // background; progress shows in /shipway/status
  res.status(202).json({ started: true });
}));

router.get('/metrics', wrap(async (req, res) => {
  const w = winOf(req.query);
  const [cur, prev, undated] = await Promise.all([
    validOrders(w),
    w.prev ? validOrders(w.prev) : null,
    Order.countDocuments({ excluded: null, orderDate: null }),
  ]);
  res.json({ range: rangeOut(w), current: computeMetrics(cur), previous: prev ? computeMetrics(prev) : null, undated });
}));

// Trends dashboard: full Overview metrics per day (30 days), week (12 weeks) or month (12 months), independent of the window picker.
router.get('/trends/overview', wrap(async (req, res) => {
  const gran = ['daily', 'weekly', 'monthly'].includes(req.query.granularity) ? req.query.granularity : 'daily';
  const now = new Date();
  const orders = await validOrders({ start: overviewStart(gran, now), end: new Date(now.getTime() + 24 * 3600 * 1000) });
  res.json(computeOverviewTrends(orders, gran, now));
}));

router.get('/trends', wrap(async (req, res) => {
  const w = winOf(req.query);
  const gran = ['daily', 'weekly', 'monthly'].includes(req.query.granularity) ? req.query.granularity : 'daily';
  const orders = await validOrders(w);
  res.json({ range: rangeOut(w), ...computeTrends(orders, gran, w.start, w.end) });
}));

// Ad performance: orders in the window grouped by campaign / ad set / ad / source ..., with the sheet's confirmation, RTO and delivered numbers.
router.get('/campaigns', wrap(async (req, res) => {
  const w = winOf(req.query);
  const by = Object.keys(CAMPAIGN_BY).includes(req.query.by) ? req.query.by : 'campaign';
  const modeQ = MODES.includes(req.query.mode) ? { paymentMode: req.query.mode } : {};
  const orders = await validOrders(w, modeQ);
  const ids = orders.map((o) => o.orderId).filter((n) => n != null);
  const sh = await ShopifyOrder.find({ orderId: { $in: ids } }).select('orderId marketing').lean();
  const byId = new Map(sh.filter((s) => s.marketing).map((s) => [s.orderId, s.marketing]));
  const [loaded, shopifyOrders] = await Promise.all([ShopifyOrder.countDocuments({ attrsV: { $gte: 1 } }), ShopifyOrder.estimatedDocumentCount()]);
  const out = computeCampaigns(orders, byId, by);
  const st = await shopify.status();
  res.json({ range: rangeOut(w), ...out, shopifyOrders, marketingLoaded: loaded, shopifyConfigured: st.configured, shopifyRunning: st.running, shopifyLast: st.last, why: diagnose({ ...out, shopifyOrders, marketingLoaded: loaded }) });
}));

// ---------- reasons ----------
async function getReasonMap() {
  const s = await Setting.findOne({ key: 'reasonMap' }).lean();
  return s ? s.value : DEFAULT_REASON_MAP;
}
router.get('/reasons', wrap(async (req, res) => {
  const w = winOf(req.query);
  const modeQ = MODES.includes(req.query.mode) ? { paymentMode: req.query.mode } : {};
  const map = await getReasonMap();
  const f = 'orderId orderDate confirmed finalStatus notes rtoReason';
  const [cancelled, rto] = await Promise.all([
    validOrders(w, { ...modeQ, confirmed: 'Cancel' }, f),
    validOrders(w, { ...modeQ, finalStatus: 'RTO' }, f),
  ]);
  res.json({ range: rangeOut(w), cancel: summarize(cancelled, (o) => o.notes, map), rto: summarize(rto, (o) => o.rtoReason, map) });
}));
router.get('/settings/reasons', wrap(async (req, res) => res.json({ map: await getReasonMap(), defaults: DEFAULT_REASON_MAP })));
router.put('/settings/reasons', wrap(async (req, res) => {
  const map = (req.body.map || [])
    .map((r) => ({ bucket: String(r.bucket || '').trim(), keywords: (r.keywords || []).map((k) => String(k).trim()).filter(Boolean) }))
    .filter((r) => r.bucket);
  if (!map.length) return res.status(400).json({ error: 'At least one bucket is required' });
  await Setting.findOneAndUpdate({ key: 'reasonMap' }, { key: 'reasonMap', value: map }, { upsert: true });
  res.json({ map });
}));

// ---------- orders list ----------
function ordersQuery(q) {
  const w = winOf(q);
  const f = { excluded: null, ...dateFilter(w) };
  if (STATUSES.includes(q.status)) f.finalStatus = q.status;
  if (MODES.includes(q.mode) || q.mode === 'Unknown') f.paymentMode = q.mode;
  if (q.ndr === 'yes') f.ndr = true; else if (q.ndr === 'no') f.ndr = false;
  if (q.shipway && /^[a-z]+$/.test(String(q.shipway))) f._shipway = String(q.shipway); // resolved to order ids in the route
  if (q.q) {
    const t = String(q.q).trim().replace(/^#/, '');
    const or = [{ name: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
    if (/^\d+$/.test(t)) or.push({ orderId: Number(t) });
    f.$or = or;
  }
  return { w, f };
}
const LIST_FIELDS = 'sheetRow orderId orderDate dateSource name amount product paymentMode confirmed deliveryStatus finalStatus ndr rto notes rtoReason conflicts';
const SORTS = { date: { orderDate: -1, orderId: -1 }, date_asc: { orderDate: 1 }, id: { orderId: -1 }, amount: { amount: -1 } };

// Turns the Shipway status filter into an order-id condition ("none" = not tracked in Shipway).
async function applyShipwayFilter(f) {
  const g = f._shipway; delete f._shipway;
  if (!g) return f;
  if (g === 'none') {
    const ids = await ShipwayShipment.find({ found: true }).distinct('orderId');
    f.orderId = { $nin: ids };
  } else {
    f.orderId = { $in: await ShipwayShipment.find({ found: true, group: g }).distinct('orderId') };
  }
  return f;
}
const shipwayCell = (s) => (s && s.found ? { status: s.status, code: s.statusCode, group: s.group, carrier: s.carrier, awb: s.awb, at: s.statusAt || s.changedAt } : null);

router.get('/orders', wrap(async (req, res) => {
  const { w, f } = ordersQuery(req.query);
  await applyShipwayFilter(f);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const [total, rows] = await Promise.all([
    Order.countDocuments(f),
    Order.find(f).select(LIST_FIELDS).sort(SORTS[req.query.sort] || SORTS.date).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  const sh = await ShopifyOrder.find({ orderId: { $in: rows.map((r) => r.orderId).filter((n) => n != null) } }).select('orderId itemsSummary address.city').lean();
  const byId = new Map(sh.map((s) => [s.orderId, s]));
  for (const r of rows) { const s = byId.get(r.orderId); if (s) { r.items = s.itemsSummary; r.city = s.address && s.address.city; } }
  const ship = await ShipwayShipment.find({ orderId: { $in: rows.map((r) => r.orderId).filter((n) => n != null) } }).select('orderId found status statusCode group carrier awb statusAt changedAt').lean();
  const shipById = new Map(ship.map((x) => [x.orderId, x]));
  for (const r of rows) r.shipway = shipwayCell(shipById.get(r.orderId));
  res.json({ range: rangeOut(w), total, page, limit, rows });
}));

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
router.get('/orders/export.csv', wrap(async (req, res) => {
  const { f } = ordersQuery(req.query);
  await applyShipwayFilter(f);
  const rows = await Order.find(f).sort(SORTS.date).lean(); // phone / email deliberately not exported
  const sw = new Map((await ShipwayShipment.find({ orderId: { $in: rows.map((r) => r.orderId).filter((n) => n != null) }, found: true }).select('orderId status carrier awb').lean()).map((x) => [x.orderId, x]));
  const mk = new Map((await ShopifyOrder.find({ orderId: { $in: rows.map((r) => r.orderId).filter((n) => n != null) } }).select('orderId marketing').lean()).map((x) => [x.orderId, x.marketing || {}]));
  const head = ['Order ID', 'Order date (IST)', 'Name', 'Amount', 'Product', 'Payment mode', 'Confirmed', 'Dispatched', 'Delivery status', 'Final status', 'NDR', 'RTO', 'Notes', 'RTO reason', 'Order link', 'Sheet row', 'Source', 'Campaign', 'Ad set', 'Ad', 'Shipway status', 'Courier', 'AWB'];
  const lines = [head.join(',')];
  for (const o of rows) {
    lines.push([o.orderId, o.orderDate ? fmtDateTime(o.orderDate) : 'undated', o.name, o.amount, o.product, o.paymentMode, o.confirmed, o.dispatched ? 'Yes' : '', o.deliveryStatus, o.finalStatus, o.ndr ? 'Yes' : '', o.rto, o.notes, o.rtoReason, o.orderLink, o.sheetRow, (mk.get(o.orderId) || {}).sourceGroup, (mk.get(o.orderId) || {}).utmCampaign, (mk.get(o.orderId) || {}).utmMedium, (mk.get(o.orderId) || {}).utmContent, (sw.get(o.orderId) || {}).status, (sw.get(o.orderId) || {}).carrier, (sw.get(o.orderId) || {}).awb].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${fmtDate(new Date())}.csv"`);
  res.send('\ufeff' + lines.join('\n'));
}));

// Customer details and items for the order drawer. Phone, email and the street address stay hidden until "Reveal".
async function shopifyBlock(orderId, reveal) {
  const st = await shopify.status();
  if (!st.configured) return { found: false, reason: 'not_configured' };
  let s = null;
  if (orderId != null) { try { s = await shopify.ensureOrder(orderId); } catch (e) { return { found: false, reason: 'error', error: e.message }; } }
  if (!s) return { found: false, reason: 'not_found' };
  const a = s.address || {}; const c = s.customer || {};
  const out = {
    found: true, syncedAt: s.syncedAt, createdAt: s.createdAt, financialStatus: s.financialStatus, fulfillmentStatus: s.fulfillmentStatus,
    paymentGateways: s.paymentGateways, currency: s.currency, subtotal: s.subtotal, shipping: s.shipping, discounts: s.discounts, total: s.total,
    note: s.note, tags: s.tags, cancelledAt: s.cancelledAt, test: s.test, items: s.items, marketing: s.marketing || null,
    customer: { name: c.name }, address: { city: a.city, state: a.state, country: a.country },
  };
  if (reveal) {
    out.customer = { name: c.name, email: c.email, phone: c.phone };
    out.address = { name: a.name, line1: a.line1, line2: a.line2, city: a.city, state: a.state, zip: a.zip, country: a.country, phone: a.phone };
  }
  return out;
}

// Shipway tracking for the order drawer. Refreshes the order first if the saved answer is old.
async function shipwayBlock(orderId) {
  const st = await shipway.status();
  if (!st.configured) return { found: false, reason: 'not_configured' };
  if (orderId == null) return { found: false, reason: 'no_id' };
  const s = await shipway.ensureFresh(orderId);
  if (!s || !s.found) return { found: false, reason: s && s.error ? 'error' : 'not_found', error: s && s.error, checkedAt: s && s.checkedAt };
  return {
    found: true, status: s.status, code: s.statusCode, group: s.group, final: s.final, carrier: s.carrier, awb: s.awb, from: s.from, to: s.to,
    pickupDate: s.pickupDate, statusTime: s.statusTime, statusAt: s.statusAt, checkedAt: s.checkedAt, history: s.history || [],
  };
}

router.get('/orders/:sheetRow', wrap(async (req, res) => {
  const o = await Order.findOne({ sheetRow: Number(req.params.sheetRow) }).lean();
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const reveal = req.query.reveal === '1';
  const raw = o.raw.map((v, i) => (!reveal && i === 3 && v ? 'hidden' : v));
  const out = { ...o, raw: RAW_HEADERS.map((h, i) => ({ column: String.fromCharCode(65 + i), header: h || '(no header)', value: raw[i] || '' })) };
  if (reveal) { out.phoneShown = o.phone; out.emailShown = o.email; }
  delete out.phone; delete out.email;
  out.shopify = await shopifyBlock(o.orderId, reveal);
  out.shipway = await shipwayBlock(o.orderId);
  res.json(out);
}));

// ---------- data issues ----------
router.get('/issues', wrap(async (req, res) => {
  const f = 'sheetRow orderId name amount orderDate paymentMode excluded excludedReason duplicateOf conflicts finalStatus';
  const q = (filter) => Order.find(filter).select(f).sort({ sheetRow: 1 }).limit(500).lean();
  const c = (filter) => Order.countDocuments(filter);
  const defs = {
    undated: { excluded: null, orderDate: null },
    duplicates: { excluded: 'duplicate' },
    tests: { excluded: 'test' },
    missingId: { excluded: 'noid' },
    conflicts: { excluded: null, 'conflicts.0': { $exists: true } },
    unknownPayment: { excluded: null, paymentMode: 'Unknown' },
    missingAmount: { excluded: null, amount: null },
  };
  const keys = Object.keys(defs);
  const counts = await Promise.all(keys.map((k) => c(defs[k])));
  const lists = await Promise.all(keys.map((k) => q(defs[k])));
  const total = await c({});
  res.json({
    totalRows: total,
    issues: keys.map((k, i) => ({ key: k, count: counts[i], rows: lists[i].map((o) => ({ ...o, orderDate: o.orderDate ? fmtDateTime(o.orderDate) : null })) })),
  });
}));

module.exports = router;
