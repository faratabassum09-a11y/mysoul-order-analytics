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

// ---------------------------------------------------------------- task scorecard: assigned, due, on time
const taskRun = (docs, over = {}) => T.build({ range, prev, users, desk: T.fromDesk(docs), flow: T.fromFlow([], []), totals: new Map(), open: [], now: at(18, 20), ...over });
const fuEntry = (by, id, action, when, fu, stage = 'confirm') => ({ at: when, by, byId: id, action, stage, fu });

test('tasks: FU1 is due at the order time, a later follow-up is due after the previous no-answer; 2 hours of grace', () => {
  // order 8:00, FU1 due 8:00 -> answered 9:00 (on time, within 2 h). FU2 due 9:00+2h = 11:00 -> answered 14:00 (late)
  const r = taskRun([doc(1, at(18, 8), [fuEntry('Asha', 'u1', 'dnp', at(18, 9), 'FU1'), fuEntry('Asha', 'u1', 'dnp', at(18, 14), 'FU2')])]);
  const a = person(r, 'Asha').tasks;
  assert.equal(a.onTime, 1); assert.equal(a.late, 1); assert.equal(a.due, 2); assert.equal(a.missed, 0);
  assert.equal(a.score, 75); assert.equal(a.grade, 'good'); // (1 + 0.5) / 2
});

test('tasks: dispatch steps use their stored deadline and on-time flag', () => {
  const dq = { slip: { at: at(18, 10), byName: 'Ravi', byId: 'u2', dueAt: at(18, 11), late: false }, packed: { at: at(18, 15), byName: 'Ravi', byId: 'u2', dueAt: at(18, 12), late: true } };
  const t = person(taskRun([doc(5, at(18, 8), [], dq)]), 'Ravi').tasks;
  assert.deepEqual([t.onTime, t.late, t.due], [1, 1, 2]);
});

test('tasks: an open order past its deadline is missed for the person it is assigned to; not yet overdue is "to do"; unassigned goes to the team', () => {
  const open = [
    { orderId: 10, stage: 'confirm', dueAt: at(18, 9), assignee: { id: 'u1', name: 'Asha' } }, // now 20:00: 11 h overdue -> missed
    { orderId: 11, stage: 'confirm', dueAt: at(18, 19, 30), assignee: { id: 'u1', name: 'Asha' } }, // due 19:30, now 20:00: within grace -> to do
    { orderId: 12, stage: 'confirm', dueAt: at(18, 9), assignee: null },
  ];
  const r = taskRun([], { open });
  const a = person(r, 'Asha').tasks;
  assert.equal(a.missed, 1); assert.equal(a.toDo, 1); assert.equal(a.due, 1); assert.equal(a.score, 0);
  assert.equal(r.team.tasks.missed, 2); assert.equal(r.team.tasks.unassignedMissed, 1);
});

test('tasks: assignments are counted from the order history, work due in the period but done after it still counts', () => {
  const log = [{ at: at(18, 7), by: 'System', byId: 'system', action: 'assign', stage: 'confirm', fu: '', label: 'Assigned to Asha (auto)' }, fuEntry('Asha', 'u1', 'confirm', at(19, 1), 'FU1')];
  const r = taskRun([doc(20, at(18, 8), log)], { now: at(19, 2) });
  const a = person(r, 'Asha').tasks;
  assert.equal(a.assigned, 1);
  assert.equal(a.late, 1); // due 8:00 on the 18th, done at 1:00 on the 19th
});

test('tasks: a person with nothing due has no score; grades follow the score', () => {
  const r = taskRun([]);
  assert.equal(person(r, 'Idle Person').tasks.score, null);
  assert.deepEqual([95, 80, 60, 10].map(T.gradeOf), ['excellent', 'good', 'fair', 'poor']);
  assert.equal(T.assignedTo('Re-shared to Meera K by Boss'), 'Meera K');
  assert.equal(T.assignedTo('Ravi took this order'), 'Ravi');
});

// ---------------------------------------------------------------- Rahul / order #1969 case and restricted logins
const DP = require('../src/lib/dispatch');
const mon = { start: at(19, 0), end: at(20, 0) }; // Monday: a working day
const dispatchOpen = (orderId, assignee, stepAtH, step = 'packed') => ({ orderId, stage: 'dispatch', dq: { step, stepAt: at(19, stepAtH) }, assignee });

test('dispatch: a step past its deadline is DUE and MISSED at once for the person holding it (no 2-hour grace, same as the board)', () => {
  // step started 08:00, cut-off 12:00; now 12:30 -> the board shows "Overdue 30m"
  const open = [dispatchOpen(1969, { id: 'u2', name: 'Ravi' }, 8)];
  const r = run([], { open, now: at(19, 12, 30), range: mon });
  const p = person(r, 'Ravi');
  assert.equal(p.tasks.due, 1); assert.equal(p.tasks.missed, 1); assert.equal(p.tasks.toDo, 0); assert.equal(p.tasks.score, 0);
});

test('dispatch: before the deadline it is only "to do", not due', () => {
  const open = [dispatchOpen(1969, { id: 'u2', name: 'Ravi' }, 8)];
  const r = run([], { open, now: at(19, 11, 0), range: mon });
  const p = person(r, 'Ravi');
  assert.equal(p.tasks.due, 0); assert.equal(p.tasks.toDo, 1);
});

test('restricted view: a packing login sees only their own dispatch numbers and nobody else', () => {
  const dq = { slip: { at: at(19, 9), byName: 'Ravi', byId: 'u2', late: false, dueAt: at(19, 12) } };
  const other = { slip: { at: at(19, 9), byName: 'Boss', byId: 'u9', late: false, dueAt: at(19, 12) } };
  const docs = [doc(1, at(18, 8), [], dq), doc(2, at(18, 8), [], other), doc(3, at(19, 8), [entry('Asha', 'u1', 'confirm', at(19, 9))])];
  const open = [dispatchOpen(10, { id: 'u2', name: 'Ravi' }, 8), dispatchOpen(11, { id: 'u9', name: 'Boss' }, 8), dispatchOpen(12, null, 8)];
  const r = run(docs, { open, now: at(19, 12, 30), range: mon, viewer: { id: 'u2', name: 'Ravi', role: 'packing' } });
  assert.deepEqual(r.people.map((p) => p.name), ['Ravi']);
  assert.equal(r.team.total, 1); assert.equal(r.team.calls, 0);          // Asha's call and Boss's slip are invisible
  assert.equal(r.team.tasks.due, 2);                                       // slip done on time + the open packed step that is overdue
  assert.equal(r.team.tasks.missed, 1); assert.equal(r.team.tasks.unassignedMissed, 0);
  assert.equal(r.workload.open, 1); assert.equal(r.workload.unassigned, 0);
  assert.deepEqual(r.highlights, []); assert.deepEqual(r.idle, []);
  assert.equal(r.scope.mine, true);
});

test('restricted view: a confirmation login sees calls only, never dispatch work', () => {
  const docs = [doc(1, at(19, 8), [entry('Asha', 'u1', 'confirm', at(19, 9))]), doc(2, at(19, 8), [entry('Ravi', 'u2', 'dnp', at(19, 9))])];
  const open = [dispatchOpen(10, { id: 'u1', name: 'Asha' }, 8)];
  const r = run(docs, { open, now: at(19, 12, 30), range: mon, viewer: { id: 'u1', name: 'Asha', role: 'confirmation' } });
  assert.deepEqual(r.people.map((p) => p.name), ['Asha']);
  assert.equal(r.team.calls, 1); assert.equal(r.team.dispatchWork, 0);
  assert.equal(r.workload.open, 0);                                        // a dispatch order is not a confirmation task
});

test('an admin viewer still sees everyone', () => {
  const r = run([doc(1, at(18, 8), [entry('Asha', 'u1', 'confirm', at(18, 9))])], { viewer: { id: 'u9', name: 'Boss', role: 'admin' } });
  assert.ok(r.people.length > 1); assert.equal(r.scope.mine, false);
});

test('admins are never scored: their own tasks are not counted for them or for the team', () => {
  const dq = { slip: { at: at(19, 9), byName: 'Boss', byId: 'u9', late: false, dueAt: at(19, 12) } };
  const open = [{ orderId: 5, stage: 'dispatch', dq: { step: 'packed', stepAt: at(19, 8) }, assignee: { id: 'u9', name: 'Boss' } }];
  const r = T.build({ range: { start: at(19, 0), end: at(20, 0) }, prev: null, users, desk: T.fromDesk([doc(1, at(18, 8), [], dq)]), flow: T.fromFlow([], []), totals: new Map(), open, now: at(19, 12, 30) });
  const boss = r.people.find((p) => p.name === 'Boss');
  assert.equal(boss ? boss.tasks.due : 0, 0);
  assert.equal(r.team.tasks.onTime, 0);                 // the slip Boss did on time is not in the team score
  assert.equal(r.team.tasks.missed, 1);                 // the overdue order Boss holds counts against the team, not hidden
  assert.equal(r.team.tasks.unassignedMissed, 1);
});
