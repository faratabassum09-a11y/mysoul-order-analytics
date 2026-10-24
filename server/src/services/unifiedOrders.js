// Loads the orders of a window for the analytics pages: sheet rows before the cut-off date, dashboard orders from it on.
// See lib/unified.js for what "dashboard" means. Returns plain objects shaped like cleaned sheet rows.
const { Order, ShopifyOrder, DeskOrder, ShipwayShipment, ShipCase, Setting } = require('../models');
const { dateFilter } = require('../lib/windows');
const { cutoverOf, fromDashboard, DEFAULT_SHEET_UNTIL } = require('../lib/unified');
const { fmtDate } = require('../lib/istTime');

const SHEET_FIELDS = 'orderId orderDate amount paymentMode confirmed dispatched finalStatus ndr';

// The last day the sheet is trusted for. Set SHEET_UNTIL=YYYY-MM-DD on the server, or the "dashboard.sheetUntil" setting, to move it.
async function sheetUntil() {
  const s = await Setting.findOne({ key: 'dashboard.sheetUntil' }).lean();
  return (s && s.value) || process.env.SHEET_UNTIL || DEFAULT_SHEET_UNTIL;
}
async function cutover() { return cutoverOf(await sheetUntil()); }

// range: { start, end } (end exclusive; null = open). opts.mode: only one payment mode.
async function loadUnified(range = {}, opts = {}) {
  const cut = await cutover();
  const start = range.start || null; const end = range.end || null;
  const out = [];

  // 1. Sheet part: everything dated before the cut-off.
  const sEnd = end && end < cut ? end : cut;
  if (!start || start < sEnd) {
    const f = start ? dateFilter({ start, end: sEnd }) : { $or: [{ orderDate: null }, { orderDate: { $lt: sEnd } }] }; // all time also keeps the undated rows, as before
    const rows = await Order.find({ excluded: null, ...f }).select(SHEET_FIELDS).lean();
    for (const r of rows) out.push({ ...r, src: 'sheet' });
  }

  // 2. Dashboard part: from the cut-off on.
  const dStart = start && start > cut ? start : cut;
  if (!end || end > dStart) {
    const created = { $gte: dStart }; if (end) created.$lt = end;
    const shops = await ShopifyOrder.find({ test: { $ne: true }, createdAt: created }).select('orderId total createdAt cancelledAt financialStatus paymentGateways').limit(50000).lean();
    if (shops.length) {
      const ids = shops.map((s) => s.orderId);
      const [desks, ships, ndrs] = await Promise.all([
        DeskOrder.find({ orderId: { $in: ids } }).select('orderId stage partial cancel').lean(),
        ShipwayShipment.find({ orderId: { $in: ids }, found: true }).select('orderId group found').lean(),
        ShipCase.find({ type: 'ndr', orderId: { $in: ids } }).select('orderId').lean(),
      ]);
      const dBy = new Map(desks.map((d) => [d.orderId, d]));
      const hBy = new Map(ships.map((h) => [h.orderId, h]));
      const nSet = new Set(ndrs.map((n) => n.orderId));
      for (const s of shops) out.push(fromDashboard({ shop: s, desk: dBy.get(s.orderId) || null, ship: hBy.get(s.orderId) || null, hadNdr: nSet.has(s.orderId) }));
    }
  }
  return opts.mode ? out.filter((o) => o.paymentMode === opts.mode) : out;
}

// What the pages say about where the numbers come from.
async function sourceNote() {
  const until = await sheetUntil();
  return { sheetUntil: until, dashboardFrom: fmtDate(await cutover()) };
}

module.exports = { loadUnified, sheetUntil, cutover, sourceNote };
