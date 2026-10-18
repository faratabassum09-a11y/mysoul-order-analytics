const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/lib/assign');

const team = [{ id: 'a', name: 'Asha', role: 'confirmation', active: true }, { id: 'b', name: 'Bala', role: 'confirmation', active: true }, { id: 'c', name: 'Chitra', role: 'confirmation', active: true }, { id: 'p', name: 'Ravi', role: 'packing', active: true }, { id: 'x', name: 'Boss', role: 'admin', active: true }];
const cfg = (slots) => A.normaliseAssignConfig({ slots }, A.DEFAULT_ASSIGN, team);

test('an order sits in the slot of the column it is in', () => {
  assert.equal(A.slotOf({ stage: 'confirm', fuNo: 2 }), 'confirm2');
  assert.equal(A.slotOf({ stage: 'pending', fuNo: 3 }), 'pending3');
  assert.equal(A.slotOf({ stage: 'dispatch' }), 'slip'); // no dq record yet = packing slip
  assert.equal(A.slotOf({ stage: 'dispatch', dq: { step: 'handover' } }), 'handover');
  assert.equal(A.slotOf({ stage: 'dispatched' }), null);
  assert.equal(A.slotOf({ stage: 'cancelled' }), null);
});

test('every column starts switched off, so nothing changes until an admin turns assignment on', () => {
  assert.ok(A.SLOTS.every((k) => A.DEFAULT_ASSIGN.slots[k].mode === 'off'));
  assert.equal(A.DEFAULT_ASSIGN.visibility, 'all');
});

test('settings are validated in plain words', () => {
  assert.throws(() => cfg({ confirm1: { mode: 'robot' } }), /Off, Manual or Auto/);
  assert.throws(() => cfg({ confirm1: { mode: 'auto', members: [] } }), /at least one person/);
  assert.throws(() => cfg({ nope: { mode: 'off' } }), /Unknown column/);
  assert.throws(() => cfg({ confirm1: { members: [{ id: 'a', weight: 0 }] } }), /whole number/);
  assert.throws(() => cfg({ confirm1: { members: [{ id: 'a' }, { id: 'a' }] } }), /once/);
  assert.throws(() => cfg({ confirm1: { members: [{ id: 'zzz' }] } }), /not an active/);
  assert.throws(() => cfg({ confirm1: { members: [{ id: 'p' }] } }), /wrong team/); // a packer on a call column
  assert.throws(() => A.normaliseAssignConfig({ visibility: 'some' }), /see all orders/);
  const ok = cfg({ confirm1: { mode: 'auto', members: [{ id: 'a', weight: 2 }, { id: 'x' }] }, slip: { mode: 'manual', members: [{ id: 'p' }] } });
  assert.equal(ok.slots.confirm1.members[1].weight, 1); assert.equal(ok.slots.confirm1.members[1].on, true);
  assert.equal(ok.slots.confirm2.mode, 'off'); // untouched
});

test('auto-assign shares orders in the ratio: 2 : 1 gives the first person twice as many', () => {
  const members = [{ id: 'a', weight: 2, on: true }, { id: 'b', weight: 1, on: true }];
  const load = new Map(); const got = { a: 0, b: 0 };
  for (let i = 0; i < 30; i++) { const id = A.pickAssignee(members, load); load.set(id, (load.get(id) || 0) + 1); got[id]++; }
  assert.deepEqual(got, { a: 20, b: 10 });
});

test('a new person joining catches up first, then everyone follows the ratio', () => {
  const members = [{ id: 'a', weight: 1, on: true }, { id: 'b', weight: 1, on: true }, { id: 'c', weight: 1, on: true }];
  const load = new Map([['a', 6], ['b', 6]]); // c has just been added
  const picks = [];
  for (let i = 0; i < 6; i++) { const id = A.pickAssignee(members, load); load.set(id, (load.get(id) || 0) + 1); picks.push(id); }
  assert.deepEqual(picks, ['c', 'c', 'c', 'c', 'c', 'c']);
  assert.equal(A.pickAssignee(members, load), 'a'); // level at 6 each: ties go to the first by id
});

test('a person switched off (absent today) gets nothing; nobody left means nobody is picked', () => {
  const members = [{ id: 'a', weight: 1, on: false }, { id: 'b', weight: 1, on: true }];
  assert.equal(A.pickAssignee(members, new Map([['b', 50]])), 'b');
  assert.equal(A.pickAssignee([{ id: 'a', weight: 1, on: false }]), null);
});

test('rebalance moves as few orders as possible', () => {
  const orders = Array.from({ length: 9 }, (_, i) => ({ orderId: 100 + i, assigneeId: 'a' })); // all piled on one person
  const members = [{ id: 'a', weight: 1, on: true }, { id: 'b', weight: 1, on: true }, { id: 'c', weight: 1, on: true }];
  const moves = A.planRebalance(orders, members);
  assert.equal(moves.size, 6);
  const final = orders.map((o) => moves.get(o.orderId) || o.assigneeId);
  assert.deepEqual(['a', 'b', 'c'].map((id) => final.filter((x) => x === id).length), [3, 3, 3]);
});

test('rebalance respects the ratio, takes work back from someone switched off, and fills unassigned orders', () => {
  const orders = [{ orderId: 1, assigneeId: 'a' }, { orderId: 2, assigneeId: 'a' }, { orderId: 3, assigneeId: 'gone' }, { orderId: 4 }, { orderId: 5 }, { orderId: 6 }];
  const members = [{ id: 'a', weight: 2, on: true }, { id: 'b', weight: 1, on: true }];
  const moves = A.planRebalance(orders, members);
  const final = orders.map((o) => moves.get(o.orderId) || o.assigneeId);
  assert.equal(final.filter((x) => x === 'a').length, 4); assert.equal(final.filter((x) => x === 'b').length, 2);
  assert.ok(final.every((x) => x === 'a' || x === 'b'));
  assert.equal(A.planRebalance([], members).size, 0);
  assert.equal(A.planRebalance(orders, []).size, 0);
});

const slotConf = { mode: 'auto', members: [{ id: 'a', weight: 1, on: true }, { id: 'b', weight: 1, on: true }] };
test('decide: a new order in an auto column gets the least-loaded person', () => {
  const r = A.decide({ stage: 'confirm', fuNo: 1 }, slotConf, { load: new Map([['a', 3]]) });
  assert.deepEqual(r, { assigneeId: 'b', reason: 'auto' });
});
test('decide: an order that already belongs to someone in this column is left alone', () => {
  assert.equal(A.decide({ stage: 'confirm', fuNo: 1, assignee: { id: 'a', slot: 'confirm1' } }, slotConf), null);
});
test('decide: when the order moves to the next column it is shared out again, or kept with the same person if asked', () => {
  const d = { stage: 'confirm', fuNo: 2, assignee: { id: 'a', slot: 'confirm1' } };
  assert.equal(A.decide(d, slotConf, { load: new Map([['a', 5]]) }).assigneeId, 'b');
  assert.deepEqual(A.decide(d, slotConf, { keepSamePerson: true, load: new Map([['a', 5]]) }), { assigneeId: 'a', reason: 'kept' });
  assert.equal(A.decide(d, slotConf, { keepSamePerson: true, isActive: (id) => id !== 'a' }).assigneeId, 'b'); // a was deactivated
});
test('decide: someone switched off or deactivated has their orders handed on', () => {
  const d = { stage: 'confirm', fuNo: 1, assignee: { id: 'a', slot: 'confirm1' } };
  const off = { mode: 'auto', members: [{ id: 'a', weight: 1, on: false }, { id: 'b', weight: 1, on: true }] };
  assert.deepEqual(A.decide(d, off), { assigneeId: 'b', reason: 'person_off' });
});
test('decide: manual columns never auto-assign; a stale person is cleared; off columns clear everything', () => {
  const manual = { mode: 'manual', members: [] };
  assert.equal(A.decide({ stage: 'confirm', fuNo: 1 }, manual), null);
  assert.equal(A.decide({ stage: 'confirm', fuNo: 1, assignee: { id: 'a', slot: 'confirm1' } }, manual), null); // an admin chose them: stays
  assert.equal(A.decide({ stage: 'confirm', fuNo: 2, assignee: { id: 'a', slot: 'confirm1' } }, manual).assigneeId, null);
  assert.equal(A.decide({ stage: 'confirm', fuNo: 1, assignee: { id: 'a', slot: 'confirm1' } }, { mode: 'off', members: [] }).assigneeId, null);
  assert.equal(A.decide({ stage: 'dispatched', assignee: { id: 'a', slot: 'handover' } }, slotConf).assigneeId, null); // done: nobody holds it
});

test('visibility: with "own only" people see their orders and the ones nobody holds; admins see all', () => {
  const mine = { assignee: { id: 'a' } }; const theirs = { assignee: { id: 'b' } }; const free = {};
  assert.equal(A.canWork({ id: 'a', role: 'confirmation' }, mine, 'own'), true);
  assert.equal(A.canWork({ id: 'a', role: 'confirmation' }, theirs, 'own'), false);
  assert.equal(A.canWork({ id: 'a', role: 'confirmation' }, free, 'own'), true);
  assert.equal(A.canWork({ id: 'a', role: 'confirmation' }, theirs, 'all'), true);
  assert.equal(A.canWork({ id: 'x', role: 'admin' }, theirs, 'own'), true);
});
