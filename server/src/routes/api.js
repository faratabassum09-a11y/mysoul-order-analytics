const express = require('express');
const multer = require('multer');
const { Order, SyncRun, Setting } = require('../models');
const { resolveWindow, dateFilter } = require('../lib/windows');
const { computeMetrics, computeTrends } = require('../lib/metrics');
const { summarize, DEFAULT_REASON_MAP } = require('../lib/reasons');
const { RAW_HEADERS } = require('../lib/clean');
const { fmtDate, fmtDateTime } = require('../lib/istTime');
const sync = require('../services/sync');
const { parseCsv } = require('../services/sources');
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
  const lastOk = await SyncRun.findOne({ ok: true }).sort({ at: -1 }).lean();
  res.json({ last, lastOk, config: { source: cfg.sheet.source, sheetConfigured: !!cfg.sheet.id, autoSyncMin: cfg.syncIntervalMin, orderTab: cfg.sheet.orderTab } });
}));
router.post('/sync', wrap(async (req, res) => res.json(await sync.syncFromSheet('manual'))));
router.post('/sync/reclean', wrap(async (req, res) => res.json(await sync.recleanOnly())));
router.post('/sync/upload', upload.fields([{ name: 'orderSheet', maxCount: 1 }, { name: 'ordersMaster', maxCount: 1 }]), wrap(async (req, res) => {
  const f = req.files || {};
  if (!f.orderSheet && !f.ordersMaster) return res.status(400).json({ error: 'Attach orderSheet and/or ordersMaster CSV' });
  const rows = (file) => (file ? parseCsv(file[0].buffer.toString('utf8')) : null);
  res.json(await sync.syncFromUpload({ orderRows: rows(f.orderSheet), masterRows: rows(f.ordersMaster) }));
}));
router.post('/sync/shopify-csv', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach the Shopify orders CSV as "file"' });
  res.json(await sync.importShopifyExport(parseCsv(req.file.buffer.toString('utf8'))));
}));

// ---------- metrics ----------
router.get('/metrics', wrap(async (req, res) => {
  const w = winOf(req.query);
  const [cur, prev, undated] = await Promise.all([
    validOrders(w),
    w.prev ? validOrders(w.prev) : null,
    Order.countDocuments({ excluded: null, orderDate: null }),
  ]);
  res.json({ range: rangeOut(w), current: computeMetrics(cur), previous: prev ? computeMetrics(prev) : null, undated });
}));

router.get('/trends', wrap(async (req, res) => {
  const w = winOf(req.query);
  const gran = ['daily', 'weekly', 'monthly'].includes(req.query.granularity) ? req.query.granularity : 'daily';
  const orders = await validOrders(w);
  res.json({ range: rangeOut(w), ...computeTrends(orders, gran, w.start, w.end) });
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

router.get('/orders', wrap(async (req, res) => {
  const { w, f } = ordersQuery(req.query);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const [total, rows] = await Promise.all([
    Order.countDocuments(f),
    Order.find(f).select(LIST_FIELDS).sort(SORTS[req.query.sort] || SORTS.date).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  res.json({ range: rangeOut(w), total, page, limit, rows });
}));

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
router.get('/orders/export.csv', wrap(async (req, res) => {
  const { f } = ordersQuery(req.query);
  const rows = await Order.find(f).sort(SORTS.date).lean(); // phone / email deliberately not exported
  const head = ['Order ID', 'Order date (IST)', 'Name', 'Amount', 'Product', 'Payment mode', 'Confirmed', 'Dispatched', 'Delivery status', 'Final status', 'NDR', 'RTO', 'Notes', 'RTO reason', 'Order link', 'Sheet row'];
  const lines = [head.join(',')];
  for (const o of rows) {
    lines.push([o.orderId, o.orderDate ? fmtDateTime(o.orderDate) : 'undated', o.name, o.amount, o.product, o.paymentMode, o.confirmed, o.dispatched ? 'Yes' : '', o.deliveryStatus, o.finalStatus, o.ndr ? 'Yes' : '', o.rto, o.notes, o.rtoReason, o.orderLink, o.sheetRow].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${fmtDate(new Date())}.csv"`);
  res.send('\ufeff' + lines.join('\n'));
}));

router.get('/orders/:sheetRow', wrap(async (req, res) => {
  const o = await Order.findOne({ sheetRow: Number(req.params.sheetRow) }).lean();
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const reveal = req.query.reveal === '1';
  const raw = o.raw.map((v, i) => (!reveal && i === 3 && v ? 'hidden' : v));
  const out = { ...o, raw: RAW_HEADERS.map((h, i) => ({ column: String.fromCharCode(65 + i), header: h || '(no header)', value: raw[i] || '' })) };
  if (reveal) { out.phoneShown = o.phone; out.emailShown = o.email; }
  delete out.phone; delete out.email;
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
