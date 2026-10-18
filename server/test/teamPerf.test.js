const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/lib/teamPerf');
const { istToDate } = require('../src/lib/istTime');

const users = [
  { id: 'u1', name: 'Asha', role: 'confirmation', active: true },
  { id: 'u2', name: 'Ravi', role: 'packing', active: true },
  { id: 'u3', name: 'Idle Person', role: 'confirmation', active: true },
  { id: 'u9', name: 'Boss', role: 'admin', active: true },
];
const at = (d, h, m = 0) => istToDate(2026, 9, d, h, m); // October 2026, IST
const range = { start: at(18, 0), end: at(19, 0) };
const prev = { start: at(17, 0), end: at(18, 0) };
const now = at(18, 20);

const doc = (orderId, orderAt, log, dq) => ({ orderId, orderAt, log, dq });
const entry = (by, byId, action, when, extra = {}) => ({ at: when, by, byId, action, stage: 'confirm', fu: 'FU1', ...extra });

function run(deskDocs, over = {}) {
  return T.build({ range, prev, users, desk: T.fromDesk(deskDocs), flow: T.fromFlow([], []), totals: new Map(), open: [], now, ...over });
}
const person = (r, name) => r.people.find((p) => p.name === name);

test('calls are counted per person on the day they were made, system actions never count', () => {
  const r = run([
    doc(1, at(18, 8), [entry('Asha', 'u1', 'dnp', at(18, 9)), entry('Asha', 'u1', 'confirm', at(18, 11)), entry('System', 'system', 'assign', at(18, 8)), entry('System', 'system', 'auto_cancel', at(18, 12))]),
    doc(2, at(18, 8), [entry('Asha', 'u1', 'cancel', at(18, 10), { reason: 'x' })]),
    doc(3, at(16, 8), [entry('Asha', 'u1', 'confirm', at(16, 9))]), // outside both windows
  ]);
  const a = person(r, 'Asha');
  assert.equal(a.dnp, 1); assert.equal(a.confirmed, 1); assert.equal(a.cancelled, 1);
  assert.equal(a.calls, 3); assert.equal(a.total, 3);
  assert.equal(r.team.total, 3);
});

test('win rate is confirmed + partial over final decisions; did-not-pick-up calls are not decisions', () => {
  const r = run([
    doc(1, at(18, 8), [entry('Asha', 'u1', 'confirm', at(18, 9))]),
    doc(2, at(18, 8), [entry('Asha', 'u1', 'partial_paid', at(18, 9), { amount: 200 })]),
    doc(3, at(18, 8), [entry('Asha', 'u1', 'cancel', at(18, 9))]),
    doc(4, at(18, 8), [entry('Asha', 'u1', 'dnp', at(18, 9))]),
  ]);
  const a = person(r, 'Asha');
  assert.equal(a.decisions, 3);
  assert.equal(a.winRate.n, 2); assert.equal(a.winRate.d, 3);
  assert.ok(Math.abs(a.winRate.v - 66.666) < 0.01);
  assert.equal(a.collected, 200);
  assert.equal(a.pickupRate.n, 3); assert.equal(a.pickupRate.d, 4);
});

test('time to decision uses only the first final decision on an order', () => {
  const r = run([doc(1, at(18, 8), [entry('Asha', 'u1', 'dnp', at(18, 9)), entry('Asha', 'u1', 'confirm', at(18, 10)), entry('Asha', 'u1', 'cancel', at(18, 15))])]);
  const a = person(r, 'Asha');
  assert.equal(a.decisionN, 1);
  assert.equal(a.avgDecisionMs, 2 * 3600 * 1000);
});

test('order value won comes from the Shopify totals of confirmed and partial orders', () => {
  const r = run([
    doc(1, at(18, 8), [entry('Asha', 'u1', 'confirm', at(18, 9))]),
    doc(2, at(18, 8), [entry('Asha', 'u1', 'partial_paid', at(18, 9), { amount: 100 })]),
    doc(3, at(18, 8), [entry('Asha', 'u1', 'cancel', at(18, 9))]),
  ], { totals: new Map([[1, 999], [2, 501], [3, 7000]]) });
  assert.equal(person(r, 'Asha').valueWon, 1500);
  assert.equal(r.team.valueWon, 1500);
});

test('dispatch steps come from dq with their on-time flag; a handover is not counted twice', () => {
  const dq = { slip: { at: at(18, 9), byName: 'Ravi', byId: 'u2', late: false }, packed: { at: at(18, 11), byName: 'Ravi', byId: 'u2', late: true }, handover: { at: at(18, 17), byName: 'Ravi', byId: 'u2', late: false } };
  const r = run([doc(1, at(17, 8), [entry('Ravi', 'u2', 'slip_done', at(18, 9)), entry('Ravi', 'u2', 'packed', at(18, 11)), entry('Ravi', 'u2', 'dispatch', at(18, 17))], dq)]);
  const p = person(r, 'Ravi');
  assert.equal(p.slip, 1); assert.equal(p.packed, 1); assert.equal(p.handover, 1);
  assert.equal(p.total, 3);
  assert.equal(p.onTime.n, 2); assert.equal(p.onTime.d, 3); assert.equal(p.late, 1);
});

test('an order handed over before the 3-step dispatch queue existed still counts as a handover', () => {
  const r = run([doc(1, at(17, 8), [entry('Ravi', 'u2', 'dispatch', at(18, 12))])]);
  const p = person(r, 'Ravi');
  assert.equal(p.handover, 1);
  assert.equal(p.onTime.d, 0); assert.equal(p.onTime.v, null);
});

test('everyone with a login is listed, including people who did nothing', () => {
  const r = run([doc(1, at(18, 8), [entry('Asha', 'u1', 'confirm', at(18, 9))])]);
  assert.ok(person(r, 'Idle Person'));
  assert.equal(person(r, 'Idle Person').total, 0);
  assert.deepEqual(r.idle.map((p) => p.name), ['Idle Person', 'Ravi']); // the admin is never flagged as idle
});

test('the people list is ranked by total work, busiest first', () => {
  const r = run([
    doc(1, at(18, 8), [entry('Asha', 'u1', 'confirm', at(18, 9))]),
    doc(2, at(18, 8), [entry('Ravi', 'u2', 'dispatch', at(18, 9)), entry('Ravi', 'u2', 'dispatch', at(18, 10))]),
  ]);
  assert.equal(r.people[0].name, 'Ravi');
});

test('the previous window feeds the comparison numbers', () => {
  const r = run([
    doc(1, at(17, 8), [entry('Asha', 'u1', 'confirm', at(17, 9)), entry('Asha', 'u1', 'dnp', at(17, 10))]),
    doc(2, at(18, 8), [entry('Asha', 'u1', 'confirm', at(18, 9))]),
  ]);
  assert.equal(person(r, 'Asha').total, 1);
  assert.equal(person(r, 'Asha').prev.total, 2);
  assert.equal(r.teamPrev.total, 2);
  assert.equal(r.team.total, 1);
});

test('a single day is shown by the hour, a longer range by the day', () => {
  const one = run([doc(1, at(18, 8), [entry('Asha', 'u1', 'confirm', at(18, 9, 30)), entry('Asha', 'u1', 'dnp', at(18, 9, 45))])]);
  assert.equal(one.bucket, 'hour'); assert.equal(one.trend.length, 24);
  assert.equal(one.trend[9].won, 1); assert.equal(one.trend[9].dnp, 1);
  assert.equal(person(one, 'Asha').series[9], 2);
  const week = T.build({ range: { start: at(12, 0), end: at(19, 0) }, prev: null, users, desk: T.fromDesk([doc(1, at(12, 8), [entry('Asha', 'u1', 'confirm', at(14, 9))])]), flow: T.fromFlow([], []), now });
  assert.equal(week.bucket, 'day'); assert.equal(week.trend.length, 7);
  assert.equal(week.trend[2].key, '2026-10-14'); assert.equal(week.trend[2].won, 1);
  assert.equal(week.teamPrev, null);
});

test('ranges over a year are refused', () => {
  assert.throws(() => T.bucketPlan({ start: at(1, 0), end: new Date(at(1, 0).getTime() + 400 * 86400000) }), /at most 366 days/);
});

test('the older sheet-based Confirm queue and Dispatch desk count too, merged by person', () => {
  const flowEvents = [
    { orderId: 5, at: at(18, 9), byId: 'u1', byName: 'Asha', action: 'no_answer' },
    { orderId: 5, at: at(18, 10), byId: 'u1', byName: 'Asha', action: 'confirm' },
    { orderId: 6, at: at(18, 11), byId: 'u2', byName: 'Ravi', action: 'dispatched' },
    { orderId: 6, at: at(18, 11), byId: 'u2', byName: 'Ravi', action: 'proof_added' }, // not a counted action
  ];
  const r = T.build({ range, prev, users, desk: T.fromDesk([doc(1, at(18, 8), [entry('Asha', 'u1', 'confirm', at(18, 9))])]), flow: T.fromFlow(flowEvents, [{ orderId: 5, orderAt: at(18, 8), decidedAt: at(18, 10), decidedById: 'u1', decidedByName: 'Asha' }]), now });
  assert.equal(person(r, 'Asha').confirmed, 2); assert.equal(person(r, 'Asha').dnp, 1);
  assert.equal(person(r, 'Ravi').handover, 1);
  assert.equal(person(r, 'Asha').decisionN, 2); // one decision from each desk
});

test('work under a name with no login any more is still shown, marked as a former member', () => {
  const r = run([doc(1, at(18, 8), [entry('Gone Person', 'deleted-id', 'confirm', at(18, 9))])]);
  const g = person(r, 'Gone Person');
  assert.ok(g); assert.equal(g.former, true); assert.equal(g.confirmed, 1);
});

test('live workload counts open orders per holder and flags the overdue ones', () => {
  const open = [
    { orderId: 1, stage: 'confirm', dueAt: at(18, 10), assignee: { id: 'u1' } }, // due 2h20 ago: overdue
    { orderId: 2, stage: 'confirm', dueAt: at(18, 18), assignee: { id: 'u1' } }, // not due yet
    { orderId: 3, stage: 'pending', dueAt: at(18, 12), assignee: { id: 'u3' } },
    { orderId: 4, stage: 'confirm', dueAt: at(18, 10) }, // nobody holds it
  ];
  const r = run([], { open });
  assert.equal(person(r, 'Asha').open.assigned, 2); assert.equal(person(r, 'Asha').open.overdue, 1);
  assert.equal(r.workload.unassigned, 1); assert.equal(r.workload.open, 4); assert.equal(r.workload.overdue, 3);
  assert.equal(r.attention[0].name, 'Asha');
});

test('highlights name the top closer and the fastest decider only when there is data', () => {
  assert.equal(run([]).highlights.length, 0);
  const logs = [1, 2, 3].map((i) => doc(i, at(18, 8), [entry('Asha', 'u1', 'confirm', at(18, 9))]));
  const r = run(logs);
  assert.equal(r.highlights.find((h) => h.key === 'closer').name, 'Asha');
  assert.equal(r.highlights.find((h) => h.key === 'fast').name, 'Asha'); // 3 decisions: enough to compare
});
