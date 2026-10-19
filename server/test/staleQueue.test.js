const test = require('node:test');
const assert = require('node:assert/strict');
const { isStale } = require('../src/lib/staleQueue');
const start = new Date('2026-10-19T00:00:00+05:30');
const sys = [{ action: 'enter_queue', by: 'System' }, { action: 'assign', by: 'System' }];

test('an old order nobody touched is stale', () => assert.equal(isStale({ stage: 'confirm', orderAt: '2026-10-05', log: sys }, start), true));
test('an order on or after the start date is not stale', () => assert.equal(isStale({ stage: 'confirm', orderAt: '2026-10-19T10:00:00+05:30', log: sys }, start), false));
test('an old order somebody called (DNP, confirm, cancel ...) is never stale', () => {
  for (const action of ['dnp', 'confirm', 'cancel', 'partial_paid']) assert.equal(isStale({ stage: 'pending', orderAt: '2026-10-05', log: [...sys, { action, by: 'Ishika' }] }, start), false);
});
test('orders past the confirm / pending stages are never stale', () => {
  for (const stage of ['dispatch', 'dispatched', 'cancelled']) assert.equal(isStale({ stage, orderAt: '2026-10-05', log: sys }, start), false);
});
