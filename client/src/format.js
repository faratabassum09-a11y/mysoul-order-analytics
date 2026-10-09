export const dash = '—';
export const int = (n) => (n == null ? dash : Number(n).toLocaleString('en-IN'));
export const inr = (n) => (n == null ? dash : `₹${Math.round(n).toLocaleString('en-IN')}`);
export const pct = (v, digits = 1) => (v == null ? dash : `${v.toFixed(digits)}%`);
export const MODES = ['COD', 'Partial COD', 'Prepaid'];
export const MODE_COLORS = { COD: '#c4661f', 'Partial COD': '#6a55b3', Prepaid: '#1c7c6c', All: '#1c2431', Unknown: '#8a93a0' };

// KPI definitions: one place that mirrors the metric table in the brief.
export const KPIS = [
  { key: 'total', label: 'Total orders', type: 'count', get: (b) => b.total, up: 'good', hint: 'Valid orders in the window (tests and duplicates excluded)' },
  { key: 'value', label: 'Order value', type: 'money', get: (b) => b.value, sub: (b) => `Average order ${inr(b.aov)}`, up: 'good', hint: 'Sum of Amount in INR' },
  { key: 'pending', label: 'Pending confirmation', type: 'count', get: (b) => b.pending, up: 'bad', hint: 'Orders whose Confirmed column is blank (not yet called)' },
  { key: 'confirmation', label: 'Confirmation', type: 'pct', get: (b) => b.confirmation, up: 'good', hint: 'Confirmed ÷ (Confirmed + Cancelled). Pending is left out of the base.' },
  { key: 'cancellation', label: 'Cancellation', type: 'pct', get: (b) => b.cancellation, up: 'bad', hint: 'Cancelled ÷ (Confirmed + Cancelled)' },
  { key: 'dispatch', label: 'Dispatch', type: 'pct', get: (b) => b.dispatch, up: 'good', hint: 'Dispatched ÷ Confirmed. The gap is confirmed orders still sitting.' },
  { key: 'ndr', label: 'NDR', type: 'pct', get: (b) => b.ndr, up: 'bad', hint: 'NDR orders ÷ dispatched. Reliable only from about order #1252.' },
  { key: 'ndrToRto', label: 'NDR to RTO', type: 'pct', get: (b) => b.ndrToRto, up: 'bad', hint: 'NDR orders that ended RTO ÷ NDR orders that have closed' },
  { key: 'deliveredRate', label: 'Delivered', type: 'pct', get: (b) => b.deliveredRate, up: 'good', sub: (b) => `${int(b.closed)} of ${int(b.shipments)} shipments closed`, hint: 'Delivered ÷ (Delivered + RTO), closed shipments only' },
  { key: 'rto', label: 'RTO', type: 'pct', get: (b) => b.rto, up: 'bad', sub: (b) => `${int(b.closed)} of ${int(b.shipments)} shipments closed · ${int(b.inTransit)} in transit`, hint: 'RTO ÷ (Delivered + RTO), closed shipments only. Young windows look better than they are.' },
  { key: 'inTransit', label: 'In transit', type: 'count', get: (b) => b.inTransit, up: null, hint: 'Shipments still open' },
  { key: 'netRevenue', label: 'Net delivered revenue', type: 'money', get: (b) => b.netRevenue, up: 'good', hint: 'Amount of orders with final status Delivered' },
];

export function fmtValue(type, v) {
  if (type === 'pct') return pct(v && v.v);
  if (type === 'money') return inr(v);
  return int(v);
}
export const ratioTitle = (v) => (v && v.d != null ? `${int(v.n)} of ${int(v.d)}` : '');

// Change vs previous window: percentage points for rates, relative % for counts and money.
export function delta(type, cur, prev) {
  if (prev == null) return null;
  if (type === 'pct') {
    if (!prev || !cur) return null;
    if (cur.v == null || prev.v == null) return null;
    return { diff: cur.v - prev.v, text: `${Math.abs(cur.v - prev.v).toFixed(1)} pp` };
  }
  if (prev === 0) return cur === 0 ? { diff: 0, text: '0%' } : null;
  const d = ((cur - prev) / prev) * 100;
  return { diff: d, text: `${Math.abs(d).toFixed(0)}%` };
}
