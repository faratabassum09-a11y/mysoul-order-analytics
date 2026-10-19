const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/lib/staffView');
const { computeMetrics } = require('../src/lib/metrics');

const orders = [
  { orderId: 1, orderDate: new Date(), amount: 800, paymentMode: 'COD', confirmed: 'Yes', dispatched: 'Yes', finalStatus: 'Delivered', ndr: '' },
  { orderId: 2, orderDate: new Date(), amount: 500, paymentMode: 'Prepaid', confirmed: '', dispatched: '', finalStatus: 'Pending confirmation', ndr: '' },
];
const metrics = () => ({ range: {}, current: computeMetrics(orders), previous: computeMetrics(orders), undated: 0 });
const hasMoney = (m) => Object.values(m).some((b) => b && V.MONEY_KEYS.some((k) => k in b));

test('team members never receive money fields, in any payment-mode block, current or previous', () => {
  for (const role of ['confirmation', 'packing']) {
    const r = V.forRole(metrics(), role);
    assert.equal(hasMoney(r.current), false); assert.equal(hasMoney(r.previous), false);
    assert.equal(r.current.All.total, 2);
  }
});

test('each role gets only the rates its own work moves', () => {
  assert.deepEqual(V.forRole(metrics(), 'confirmation').kpis, ['total', 'pending', 'confirmation', 'cancellation', 'ndr', 'ndrToRto']);
  assert.ok(V.forRole(metrics(), 'packing').kpis.includes('dispatch'));
  assert.ok(!V.forRole(metrics(), 'packing').kpis.includes('pending'));
  assert.ok(!V.forRole(metrics(), 'confirmation').kpis.includes('rto'));
});

test('admin and unknown roles are not served by the restricted view', () => {
  assert.equal(V.forRole(metrics(), 'admin'), null);
  assert.equal(V.forRole(metrics(), 'hacker'), null);
});

test('the original metrics are not changed (admin Overview keeps its money)', () => {
  const m = metrics(); V.forRole(m, 'packing');
  assert.ok('value' in m.current.All);
});
