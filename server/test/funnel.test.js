const test = require('node:test');
const assert = require('node:assert/strict');
const FN = require('../src/lib/funnel');
const { resolveWindow } = require('../src/lib/windows');
const { fmtDate } = require('../src/lib/istTime');

const cod = { financialStatus: 'PENDING', paymentGateways: ['Cash on Delivery (COD)'] };
const paid = { financialStatus: 'PAID', paymentGateways: ['Razorpay'] };
const at = (s) => new Date(`${s}+05:30`);
// helpers: a row for one order
const row = (createdAt, shop, desk, ship) => ({ createdAt: at(createdAt), shop, desk, ship });
const dispatched = { stage: 'dispatched' };
const sh = (group) => ({ found: true, group });

// 10 orders on two days: 4 confirmed (one of them cancelled after confirming), 1 cancelled before confirming, 1 open, 3 never in the queue, 1 prepaid
const rows = [
  row('2026-10-01T10:00:00', cod, dispatched, sh('delivered')),
  row('2026-10-01T11:00:00', cod, { ...dispatched, partial: { amount: 200 } }, sh('rto')),
  row('2026-10-01T12:00:00', paid, dispatched, sh('transit')),
  row('2026-10-02T09:00:00', cod, { stage: 'dispatch', partial: { amount: 300 } }, null),
  row('2026-10-02T10:00:00', cod, { stage: 'cancelled', cancel: { fromStage: 'dispatch' } }, null),
  row('2026-10-02T11:00:00', cod, { stage: 'cancelled', cancel: { fromStage: 'confirm' } }, null),
  row('2026-10-02T12:00:00', cod, { stage: 'confirm' }, null),
  row('2026-10-02T13:00:00', cod, null, null),
];

test('COD vs prepaid: a COD order paid after delivery is still COD', () => {
  assert.equal(FN.isCod(cod), true);
  assert.equal(FN.isCod(paid), false);
  assert.equal(FN.isCod({ financialStatus: 'PAID', paymentGateways: ['Cash on Delivery (COD)'] }), true);
  assert.equal(FN.isCod({ financialStatus: 'PARTIALLY_PAID', paymentGateways: [] }), true);
  assert.equal(FN.isCod(null), true);
});

test('funnel counts and every rate use the right base', () => {
  const s = FN.funnelStats(rows);
  assert.equal(s.orders, 8); assert.equal(s.cod, 7);
  assert.equal(s.confirmed, 5); // 3 dispatched + 1 in dispatch queue + 1 cancelled after confirming
  assert.equal(s.partial, 2); assert.equal(s.dispatched, 3); assert.equal(s.delivered, 1); assert.equal(s.rto, 1); assert.equal(s.inTransit, 1);
  assert.equal(s.confirmedRatio, 8 / 5); // all new orders / confirmed orders
  assert.deepEqual(s.confirmedPct, { v: 62.5, n: 5, d: 8 });
  assert.deepEqual(s.partialPct, { v: (2 / 7) * 100, n: 2, d: 7 });
  assert.deepEqual(s.dispatchedPct, { v: 60, n: 3, d: 5 });
  assert.deepEqual(s.rtoPct, { v: (1 / 3) * 100, n: 1, d: 3 });
  assert.deepEqual(s.deliveredPct, { v: (1 / 3) * 100, n: 1, d: 3 });
});

test('no orders: ratios are empty, never NaN or Infinity', () => {
  const s = FN.funnelStats([]);
  assert.equal(s.confirmedRatio, null); assert.equal(s.confirmedPct.v, null); assert.equal(s.rtoPct.v, null);
});

test('a Shipway status only counts for orders the team handed over', () => {
  const s = FN.funnelStats([row('2026-10-01T10:00:00', cod, { stage: 'dispatch' }, sh('delivered')), row('2026-10-01T10:00:00', cod, null, sh('rto'))]);
  assert.equal(s.delivered, 0); assert.equal(s.rto, 0);
});

test('daily counts: one row per day, quiet days kept as zeros, running totals add up', () => {
  const { daily, running } = FN.funnelDaily(rows, at('2026-09-30T00:00:00'), at('2026-10-04T00:00:00'));
  assert.deepEqual(daily.map((d) => d.date), ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(daily[0].orders, 0);
  assert.equal(daily[1].orders, 3); assert.equal(daily[1].confirmed, 3); assert.equal(daily[1].delivered, 1); assert.equal(daily[1].rto, 1);
  assert.equal(daily[2].orders, 5); assert.equal(daily[2].confirmed, 2); assert.equal(daily[2].partial, 1);
  assert.equal(running[1].orders, 3); assert.equal(running[2].orders, 8); assert.equal(running[3].orders, 8);
  assert.equal(running[3].confirmed, 5); assert.equal(running[3].partial, 2);
  const sum = (k) => daily.reduce((n, d) => n + d[k], 0);
  for (const k of FN.KEYS) assert.equal(sum(k), FN.funnelStats(rows)[k === 'orders' ? 'orders' : k]);
});

test('daily counts for an open range (all time) run from the first to the last order', () => {
  const { daily } = FN.funnelDaily(rows, null, null);
  assert.deepEqual(daily.map((d) => d.date), ['2026-10-01', '2026-10-02']);
});

test('order late on 31 Oct IST lands on that day, not the next', () => {
  const { daily } = FN.funnelDaily([row('2026-10-31T23:30:00', cod, null, null)], at('2026-10-31T00:00:00'), at('2026-11-02T00:00:00'));
  assert.equal(daily[0].date, '2026-10-31'); assert.equal(daily[0].orders, 1); assert.equal(daily[1].orders, 0);
});

test('Last quarter is the previous calendar quarter; This year starts on 1 January', () => {
  const now = at('2026-10-23T12:00:00');
  const q = resolveWindow('last_quarter', now);
  assert.equal(fmtDate(q.start), '2026-07-01'); assert.equal(fmtDate(new Date(q.end - 1)), '2026-09-30');
  assert.equal(fmtDate(q.prev.start), '2026-04-01'); assert.equal(fmtDate(q.prev.end), '2026-07-01');
  const jan = resolveWindow('last_quarter', at('2026-02-10T12:00:00')); // crosses the year boundary
  assert.equal(fmtDate(jan.start), '2025-10-01'); assert.equal(fmtDate(new Date(jan.end - 1)), '2025-12-31');
  const y = resolveWindow('this_year', now);
  assert.equal(fmtDate(y.start), '2026-01-01'); assert.equal(fmtDate(new Date(y.end - 1)), '2026-12-31'); assert.equal(y.partial, true);
  assert.equal(fmtDate(y.prev.start), '2025-01-01');
  const w = resolveWindow('last_week', now); // 23 Oct 2026 is a Friday: last week is Mon 12 - Sun 18
  assert.equal(fmtDate(w.start), '2026-10-12'); assert.equal(fmtDate(new Date(w.end - 1)), '2026-10-18');
});
