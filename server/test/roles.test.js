// One login, several roles: a person can be on the Confirmation team AND the Dispatch (packing) team without being an admin.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/lib/staffAuth');
const AS = require('../src/lib/assign');
const V = require('../src/lib/staffView');
const T = require('../src/lib/teamPerf');
const { computeMetrics } = require('../src/lib/metrics');
const { istToDate } = require('../src/lib/istTime');

const both = { id: 'u5', name: 'Meena', role: 'confirmation', roles: ['confirmation', 'packing'] };

test('rolesOf: old logins with only `role` still work, new logins use the list', () => {
  assert.deepEqual(A.rolesOf({ role: 'packing' }), ['packing']);
  assert.deepEqual(A.rolesOf({ role: 'confirmation', roles: [] }), ['confirmation']);
  assert.deepEqual(A.rolesOf(both), ['confirmation', 'packing']);
  assert.deepEqual(A.rolesOf({ roles: ['packing', 'bogus', 'confirmation'] }), ['confirmation', 'packing']);
  assert.deepEqual(A.rolesOf(null), []);
});

test('Confirmation + Dispatch is not admin', () => {
  assert.equal(A.isAdmin(both), false);
  assert.equal(A.hasRole(both, 'confirmation'), true);
  assert.equal(A.hasRole(both, 'packing'), true);
  assert.equal(A.hasRole(both, 'admin'), false);
  assert.equal(A.isAdmin({ role: 'admin' }), true);
  assert.equal(A.isAdmin({ roles: ['admin'] }), true);
});

test('normaliseRoles: validates, orders, and lets admin stand alone', () => {
  assert.deepEqual(A.normaliseRoles(['packing', 'confirmation']), { roles: ['confirmation', 'packing'], role: 'confirmation' });
  assert.deepEqual(A.normaliseRoles(['packing']), { roles: ['packing'], role: 'packing' });
  assert.deepEqual(A.normaliseRoles('confirmation'), { roles: ['confirmation'], role: 'confirmation' }); // the old single-role form
  assert.deepEqual(A.normaliseRoles(['admin', 'packing']), { roles: ['admin'], role: 'admin' });
  assert.deepEqual(A.normaliseRoles(['packing', 'packing']), { roles: ['packing'], role: 'packing' });
  assert.throws(() => A.normaliseRoles([]), /at least one role/);
  assert.throws(() => A.normaliseRoles(undefined), /at least one role/);
  assert.throws(() => A.normaliseRoles(['superuser']), /Pick a role/);
});

test('assignment: a two-team person fits both call columns and dispatch columns', () => {
  assert.equal(AS.roleFits('confirm1', both), true);
  assert.equal(AS.roleFits('pending2', both), true);
  assert.equal(AS.roleFits('packed', both), true);
  assert.equal(AS.roleFits('confirm1', { role: 'packing' }), false);   // single-role rules unchanged
  assert.equal(AS.roleFits('packed', 'confirmation'), false);
  assert.equal(AS.roleFits('packed', 'admin'), true);
  const team = [{ id: 'u5', name: 'Meena', role: 'confirmation', roles: ['confirmation', 'packing'], active: true }];
  const ok = AS.normaliseAssignConfig({ slots: { confirm1: { mode: 'manual', members: [{ id: 'u5' }] }, packed: { mode: 'manual', members: [{ id: 'u5' }] } } }, undefined, team);
  assert.equal(ok.slots.packed.members[0].id, 'u5');
  assert.throws(() => AS.normaliseAssignConfig({ slots: { packed: { mode: 'manual', members: [{ id: 'u5' }] } } }, undefined, [{ id: 'u5', name: 'Meena', role: 'confirmation', active: true }]), /wrong team/);
});

test('assignment: "own orders only" still limits a two-team person, but not an admin', () => {
  const theirs = { assignee: { id: 'someone-else' } };
  assert.equal(AS.canWork(both, theirs, 'own'), false);
  assert.equal(AS.canWork({ id: 'x', roles: ['admin'] }, theirs, 'own'), true);
});

test('Overview: a two-team person gets the rates of both teams and still no money', () => {
  const orders = [{ orderId: 1, orderDate: new Date(), amount: 800, paymentMode: 'COD', confirmed: 'Yes', dispatched: 'Yes', finalStatus: 'Delivered', ndr: '' }];
  const m = { range: {}, current: computeMetrics(orders), previous: computeMetrics(orders), undated: 0 };
  const r = V.forRole(m, both);
  for (const k of [...V.ROLE_KPIS.confirmation, ...V.ROLE_KPIS.packing]) assert.ok(r.kpis.includes(k), k);
  assert.equal(new Set(r.kpis).size, r.kpis.length);                      // no repeats
  assert.equal(Object.values(r.current).some((b) => V.MONEY_KEYS.some((k) => k in b)), false);
  assert.equal(V.forRole(m, { roles: ['admin'] }), null);                 // admin is still not served here
  assert.deepEqual(V.forRole(m, 'packing').kpis, V.ROLE_KPIS.packing);   // the plain role string still works
});

test('Team performance: a two-team viewer sees their own calls AND dispatch work, never anyone else\'s', () => {
  const at = (d, h, m = 0) => istToDate(2026, 9, d, h, m);
  const range = { start: at(18, 0), end: at(19, 0) };
  const users = [
    { id: 'u5', name: 'Meena', role: 'confirmation', roles: ['confirmation', 'packing'], active: true },
    { id: 'u1', name: 'Asha', role: 'confirmation', active: true },
    { id: 'u2', name: 'Ravi', role: 'packing', active: true },
  ];
  const call = (by, byId) => ({ at: at(18, 9), by, byId, action: 'confirm', stage: 'confirm', fu: 'FU1' });
  const docs = [
    { orderId: 1, orderAt: at(18, 8), log: [call('Meena', 'u5')] },
    { orderId: 2, orderAt: at(18, 8), log: [call('Asha', 'u1')] },
    { orderId: 3, orderAt: at(18, 8), log: [], dq: { slip: { at: at(18, 10), byName: 'Meena', byId: 'u5', late: false, dueAt: at(18, 12) } } },
    { orderId: 4, orderAt: at(18, 8), log: [], dq: { slip: { at: at(18, 10), byName: 'Ravi', byId: 'u2', late: false, dueAt: at(18, 12) } } },
  ];
  const r = T.build({ range, prev: null, users, desk: T.fromDesk(docs), flow: T.fromFlow([], []), totals: new Map(), open: [], now: at(18, 20), viewer: both });
  assert.deepEqual(r.people.map((p) => p.name), ['Meena']);
  assert.equal(r.team.calls, 1);          // her own confirmation, not Asha's
  assert.equal(r.team.dispatchWork, 1);   // her own packing slip, not Ravi's
  assert.equal(r.scope.mine, true);
  assert.deepEqual(r.people[0].roles, ['confirmation', 'packing']);
  // and the same viewer with only one team sees only that team's kind of work
  const callsOnly = T.build({ range, prev: null, users, desk: T.fromDesk(docs), flow: T.fromFlow([], []), totals: new Map(), open: [], now: at(18, 20), viewer: { ...both, role: 'confirmation', roles: ['confirmation'] } });
  assert.equal(callsOnly.team.calls, 1); assert.equal(callsOnly.team.dispatchWork, 0);
});

test('Team performance: a two-team person is scored as a team member, an admin is not', () => {
  const at = (d, h, m = 0) => istToDate(2026, 9, d, h, m);
  const users = [{ id: 'u5', name: 'Meena', role: 'confirmation', roles: ['confirmation', 'packing'], active: true }, { id: 'u9', name: 'Boss', role: 'admin', roles: ['admin'], active: true }];
  const r = T.build({ range: { start: at(18, 0), end: at(19, 0) }, prev: null, users, desk: T.fromDesk([]), flow: T.fromFlow([], []), totals: new Map(), open: [], now: at(18, 20) });
  assert.equal(r.team.members, 1);
});
