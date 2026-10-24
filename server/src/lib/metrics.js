const T = require('./istTime');
const MODES = ['COD', 'Partial COD', 'Prepaid'];

const pct = (n, d) => ({ v: d > 0 ? (n / d) * 100 : null, n, d });

// Orders passed in must already be valid (not test / duplicate / missing id).
function computeBlock(orders) {
  const b = {
    total: orders.length, value: 0, amountCount: 0, pending: 0, confirmedYes: 0, cancel: 0,
    dispatched: 0, dispatchedConfirmed: 0, ndr: 0, ndrClosed: 0, ndrRto: 0,
    delivered: 0, rto: 0, inTransit: 0, netRevenue: 0,
  };
  for (const o of orders) {
    if (o.amount != null) { b.value += o.amount; b.amountCount++; }
    if (o.confirmed === 'Yes') b.confirmedYes++;
    else if (o.confirmed === 'Cancel') b.cancel++;
    else b.pending++;
    if (o.dispatched) { b.dispatched++; if (o.confirmed === 'Yes') b.dispatchedConfirmed++; }
    const fs = o.finalStatus;
    if (fs === 'Delivered') { b.delivered++; b.netRevenue += o.amount || 0; }
    else if (fs === 'RTO') b.rto++;
    else if (fs === 'In Transit') b.inTransit++;
    if (o.ndr) {
      b.ndr++;
      if (fs === 'Delivered' || fs === 'RTO') { b.ndrClosed++; if (fs === 'RTO') b.ndrRto++; }
    }
  }
  const closed = b.delivered + b.rto;
  const decided = b.confirmedYes + b.cancel;
  return {
    total: b.total,
    value: b.value,
    aov: b.amountCount ? b.value / b.amountCount : null,
    pending: b.pending,
    confirmedYes: b.confirmedYes,
    cancelled: b.cancel,
    dispatched: b.dispatched,
    confirmation: pct(b.confirmedYes, decided),
    cancellation: pct(b.cancel, decided),
    confirmedOfAll: pct(b.confirmedYes, b.total), // same base as the Order funnel's Confirmed %: pending orders count in the base
    cancelledOfAll: pct(b.cancel, b.total),
    dispatch: pct(b.dispatchedConfirmed, b.confirmedYes),
    ndr: pct(b.ndr, b.dispatched),
    ndrToRto: pct(b.ndrRto, b.ndrClosed),
    deliveredRate: pct(b.delivered, closed),
    rto: pct(b.rto, closed),
    delivered: b.delivered,
    rtoCount: b.rto,
    inTransit: b.inTransit,
    closed,
    shipments: closed + b.inTransit,
    netRevenue: b.netRevenue,
  };
}

// { All, COD, 'Partial COD', Prepaid, [Unknown] } with a mix block on every mode.
function computeMetrics(orders) {
  const out = { All: computeBlock(orders) };
  const totalCount = orders.length;
  const totalValue = out.All.value;
  const groups = { COD: [], 'Partial COD': [], Prepaid: [], Unknown: [] };
  for (const o of orders) (groups[o.paymentMode] || groups.Unknown).push(o);
  for (const m of [...MODES, 'Unknown']) {
    if (m === 'Unknown' && !groups.Unknown.length) continue;
    const blk = computeBlock(groups[m]);
    blk.mixCount = pct(blk.total, totalCount);
    blk.mixValue = pct(blk.value, totalValue);
    out[m] = blk;
  }
  return out;
}

function bucketStart(d, gran) {
  if (gran === 'weekly') return T.startOfWeek(d);
  if (gran === 'monthly') return T.startOfMonth(d);
  return T.startOfDay(d);
}
function nextBucket(d, gran) {
  if (gran === 'weekly') return new Date(d.getTime() + 7 * T.DAY);
  if (gran === 'monthly') return T.addMonths(d, 1);
  return new Date(d.getTime() + T.DAY);
}

// Trend points per bucket, per payment mode. Empty buckets are kept so charts show gaps honestly.
function computeTrends(orders, gran, start, end, now = new Date()) {
  const dated = orders.filter((o) => o.orderDate);
  if (!dated.length) return { gran, points: [] };
  const min = start || dated.reduce((a, o) => (o.orderDate < a ? o.orderDate : a), dated[0].orderDate);
  const max = end ? new Date(Math.min(end.getTime() - 1, now.getTime())) : now;
  const keys = [];
  for (let b = bucketStart(min, gran); b <= max && keys.length < 800; b = nextBucket(b, gran)) keys.push(b);
  const map = new Map(keys.map((k) => [k.getTime(), []]));
  for (const o of dated) {
    const k = bucketStart(o.orderDate, gran).getTime();
    if (map.has(k)) map.get(k).push(o);
  }
  const points = keys.map((k) => {
    const m = computeMetrics(map.get(k.getTime()));
    const p = { key: T.fmtDate(k) };
    for (const mode of ['All', ...MODES]) {
      const blk = m[mode] || computeBlock([]);
      p[mode] = {
        orders: blk.total,
        confirmation: blk.confirmation.v, confirmationN: blk.confirmation.n, confirmationD: blk.confirmation.d,
        ndr: blk.ndr.v, ndrN: blk.ndr.n, ndrD: blk.ndr.d,
        rto: blk.rto.v, rtoN: blk.rto.n, rtoD: blk.rto.d,
      };
    }
    return p;
  });
  return { gran, points };
}

// ---- Trends dashboard: fixed look-back per granularity, full Overview block per bucket and payment mode ----
// daily = last 30 days, weekly = last 12 weeks (Mon-Sun), monthly = last 12 calendar months. The last bucket is usually still in progress.
const LOOKBACK = { daily: 30, weekly: 12, monthly: 12 };
function overviewStart(gran, now = new Date()) {
  if (gran === 'weekly') return new Date(T.startOfWeek(now).getTime() - 11 * 7 * T.DAY);
  if (gran === 'monthly') return T.addMonths(T.startOfMonth(now), -11);
  return new Date(T.startOfDay(now).getTime() - 29 * T.DAY);
}
function computeOverviewTrends(orders, gran, now = new Date()) {
  const start = overviewStart(gran, now);
  const keys = [];
  for (let b = start; b <= now && keys.length < 40; b = nextBucket(b, gran)) keys.push(b);
  const map = new Map(keys.map((k) => [k.getTime(), []]));
  for (const o of orders) {
    if (!o.orderDate) continue;
    const k = bucketStart(o.orderDate, gran).getTime();
    if (map.has(k)) map.get(k).push(o);
  }
  const points = keys.map((k) => {
    const nb = nextBucket(k, gran);
    const m = computeMetrics(map.get(k.getTime()));
    const p = { key: T.fmtDate(k), end: T.fmtDate(new Date(nb.getTime() - 1)), partial: nb > now };
    for (const mode of ['All', ...MODES]) p[mode] = m[mode] || computeBlock([]);
    return p;
  });
  return { gran, lookback: LOOKBACK[gran], start: T.fmtDate(start), points };
}

module.exports = { computeBlock, computeMetrics, computeTrends, computeOverviewTrends, overviewStart, pct, MODES };
