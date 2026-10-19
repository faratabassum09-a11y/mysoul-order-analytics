// Overview numbers for confirmation / packing logins: the same counts the admin Overview shows, minus all money, limited to the role's own rates.
const { Order } = require('../models');
const { resolveWindow, dateFilter } = require('../lib/windows');
const { computeMetrics } = require('../lib/metrics');
const { fmtDate } = require('../lib/istTime');
const { forRole } = require('../lib/staffView');

const FIELDS = 'orderId orderDate amount paymentMode confirmed dispatched finalStatus ndr';
const rangeOut = (w) => ({
  key: w.key, label: w.label, partial: w.partial,
  start: w.start ? fmtDate(w.start) : null, end: w.end ? fmtDate(new Date(w.end - 1)) : null,
  prev: w.prev ? { start: fmtDate(w.prev.start), end: fmtDate(new Date(w.prev.end - 1)) } : null,
});

async function report(q = {}, staff) {
  const w = resolveWindow(q.window || 'this_month', new Date(), { from: q.from, to: q.to });
  const load = (r) => Order.find({ excluded: null, ...dateFilter(r) }).select(FIELDS).lean();
  const [cur, prev] = await Promise.all([load(w), w.prev ? load(w.prev) : null]);
  const out = forRole({ range: rangeOut(w), current: computeMetrics(cur), previous: prev ? computeMetrics(prev) : null }, staff.role);
  if (!out) throw Object.assign(new Error('Your role cannot see this.'), { status: 403 });
  return out;
}
module.exports = { report };
