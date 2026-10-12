const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanOrders, parseOrdersMaster, parseShopifyExport, parseDateTime } = require('../src/lib/clean');
const { computeMetrics, computeTrends } = require('../src/lib/metrics');
const { resolveWindow } = require('../src/lib/windows');
const { bucketize, DEFAULT_REASON_MAP } = require('../src/lib/reasons');
const T = require('../src/lib/istTime');

const NOW = T.istToDate(2026, 9, 9, 12, 0); // 9 Oct 2026 12:00 IST
const H = ['', 'Order ID', 'Name', 'Phone', 'Amount', 'Items', 'Order Link', 'COD/Prepaid', 'Order Confirmed', 'Dispatch Status', 'Delivery Status', 'NDR', 'RTO', 'NOTES', 'RTO REASON'];
//        date            id          name        phone            amt     items       link  pay             conf     disp   deliv          ndr  rto   notes  rtoReason
const R = (...c) => c;
const rows = [
  H,
  R('', ' #1024', 'A', '91 98765 43210', '999', 'Serum', '', 'COD', 'Yes', 'Yes', 'Delivered', '', 'Yes', '', 'refused at door'),
  R('', '#1038', 'B', 'b@x.com', '1299', 'Oil', '', 'Prepaid', 'Cancel', 'Yes', 'Instransit', '', '', 'dnp', ''),
  R('19/09 10:30', ' #1245', 'C', '9876500001', '1499', '\nhttps://admin.shopify.com/o/1', '', 'partial cod', 'Yes', '', '', '', '', '', ''),
  R('', '#1245', 'C', '9876500001', '1499', 'https://admin.shopify.com/o/1', '', 'Partial COD', 'Yes', 'Yes', 'Delivered', 'Yes', 'No', '', ''),
  R('', '#1245', 'C', '', '', '', '', '', '', '', '', '', '', '', ''),
  R('08/10 09:00', '#1260', 'Test User', '9000000000', '1', 'x', '', '', '', '', '', '', '', '', ''),
  R('08/10 09:10', '', 'NoId', '', '500', '', '', 'COD', '', '', '', '', '', '', ''),
  R('08/10 11:00', '#1262', 'D', '9000000001', '799', 'Cream', '', 'Prepaid', '', '', '', '', '', '', ''),
  R('', '#1030', 'E', '9000000002', '899', 'Cream', '', 'COD', 'Yes', 'Yes', 'In Transit', 'Yes', '', '', ''),
];

test('parseDateTime infers year and rolls back future dates', () => {
  assert.equal(T.fmtDateTime(parseDateTime('19/09 14:32', NOW, { inferYear: true })), '2026-09-19 14:32');
  assert.equal(T.fmtDateTime(parseDateTime('20/12 10:00', NOW, { inferYear: true })), '2025-12-20 10:00');
  assert.equal(parseDateTime('31/02 10:00', NOW, { inferYear: true }), null);
  assert.equal(T.fmtDateTime(parseDateTime('17/09/2026 20:46', NOW)), '2026-09-17 20:46');
  assert.equal(T.fmtDateTime(parseDateTime('2026-09-17 20:46:12 +0530', NOW)), '2026-09-17 20:46');
});

test('cleaning rules', () => {
  const master = parseOrdersMaster([['Order', 'Timestamp', 'Pincode'], ['#1024', '17/09/2026 20:46', '500001'], ['#1024', '18/09/2026 01:00', '500001']], NOW).map;
  const shop = parseShopifyExport([['Name', 'Created at'], ['#1030', '2026-08-30 18:00:00 +0530']], NOW);
  const { orders, summary } = cleanOrders(rows, { masterDates: master, shopifyDates: shop, now: NOW });
  const by = (r) => orders.find((o) => o.sheetRow === r);
  assert.equal(by(2).orderId, 1024);
  assert.equal(by(2).finalStatus, 'RTO'); // RTO beats Delivered
  assert.equal(T.fmtDateTime(by(2).orderDate), '2026-09-17 20:46'); assert.equal(by(2).dateSource, 'ordersmaster');
  assert.equal(by(3).finalStatus, 'In Transit'); assert.deepEqual(by(3).conflicts, ['Cancelled but dispatched']);
  assert.equal(by(3).email, 'b@x.com'); assert.equal(by(3).phone, null);
  assert.equal(by(2).phone, '9876543210');
  // duplicates of #1245: row 5 has most status columns -> kept, rows 4 and 6 flagged
  assert.equal(by(5).excluded, null); assert.equal(by(4).excluded, 'duplicate'); assert.equal(by(6).excluded, 'duplicate');
  assert.equal(by(5).product, 'Unknown'); assert.match(by(5).orderLink, /^https/);
  assert.equal(by(5).paymentMode, 'Partial COD');
  assert.equal(T.fmtDateTime(by(5).orderDate), '2026-09-19 10:30'); // borrowed from duplicate row
  assert.equal(by(7).excluded, 'test'); assert.equal(by(8).excluded, 'noid');
  assert.equal(T.fmtDateTime(by(10).orderDate), '2026-08-30 18:00'); assert.equal(by(10).dateSource, 'shopify-csv');
  assert.equal(summary.valid, 5); assert.equal(summary.tests, 1); assert.equal(summary.duplicates, 2); assert.equal(summary.missingId, 1);
  assert.equal(by(9).orderDate && T.fmtDateTime(by(9).orderDate), '2026-10-08 11:00');
});

test('metrics definitions and payment split', () => {
  const { orders } = cleanOrders(rows, { now: NOW });
  const valid = orders.filter((o) => !o.excluded);
  const m = computeMetrics(valid);
  const a = m.All;
  assert.equal(a.total, 5);
  assert.equal(a.pending, 1);
  assert.equal(a.confirmation.n, 3); assert.equal(a.confirmation.d, 5); // yes=3 (1024,1245,1030) of all 5 orders (cancel=1, pending=1)
  assert.equal(a.rto.n, 1); assert.equal(a.rto.d, 2); // RTO 1024, Delivered 1245
  assert.equal(a.inTransit, 2);
  assert.equal(a.netRevenue, 1499);
  assert.equal(a.ndr.n, 2); assert.equal(a.ndr.d, 4); // dispatched: 1024,1038,1245,1030
  assert.equal(m.COD.total, 2); assert.equal(m.Prepaid.total, 2); assert.equal(m['Partial COD'].total, 1);
  assert.equal(m.COD.mixCount.n, 2);
});

test('windows are IST and Monday-based', () => {
  const w = resolveWindow('this_week', NOW); // 9 Oct 2026 is a Friday
  assert.equal(T.fmtDate(w.start), '2026-10-05'); assert.equal(T.fmtDate(new Date(w.end - 1)), '2026-10-11'); assert.equal(w.partial, true);
  assert.equal(T.fmtDate(resolveWindow('yesterday', NOW).start), '2026-10-08');
  assert.equal(T.fmtDate(resolveWindow('last_month', NOW).start), '2026-09-01');
  const c = resolveWindow('custom', NOW, { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(T.fmtDate(c.prev.start), '2026-08-02');
  assert.equal(resolveWindow('all_time', NOW).prev, null);
});

test('trends fill empty buckets', () => {
  const { orders } = cleanOrders(rows, { now: NOW });
  const t = computeTrends(orders.filter((o) => !o.excluded && o.orderDate), 'weekly', null, null, NOW);
  assert.equal(t.points.length, 4); // weeks of 14 Sep, 21 Sep, 28 Sep, 5 Oct
  assert.equal(t.points.reduce((s, p) => s + p.All.orders, 0), 2); // only #1245 and #1262 are dated here
});

test('reason buckets', () => {
  assert.equal(bucketize('DNP', DEFAULT_REASON_MAP), 'Not reachable');
  assert.equal(bucketize('', DEFAULT_REASON_MAP), 'No reason recorded');
  assert.equal(bucketize('xyz', DEFAULT_REASON_MAP), 'Other');
});
