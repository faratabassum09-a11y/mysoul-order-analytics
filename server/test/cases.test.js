const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/lib/cases');

const who = { id: 'u1', name: 'Asha' };
const t0 = new Date('2026-10-18T05:00:00Z');
const open = (over = {}) => ({ orderId: 1500, status: 'open', step: 1, dueAt: t0, ...over });

test('NDR: no answer moves FU1 -> FU2 -> FU3 with the set hours, then closes after FU3', () => {
  const cfg = { ndrHours: [0, 4, 24] };
  let c = open();
  let r = C.ndrAction(c, 'dnp', 'phone off', who, cfg, t0);
  assert.equal(r.set.step, 2); assert.equal(r.set.dueAt.getTime(), t0.getTime() + 4 * 3600e3);
  assert.equal(r.entries[0].note, 'phone off'); assert.match(r.entries[0].label, /FU1: did not pick up · phone off/);
  c = open({ step: 2, dueAt: r.set.dueAt });
  r = C.ndrAction(c, 'dnp', '', who, cfg, new Date(t0.getTime() + 4 * 3600e3));
  assert.equal(r.set.step, 3); assert.equal(r.set.dueAt.getTime(), t0.getTime() + 28 * 3600e3);
  c = open({ step: 3, dueAt: r.set.dueAt });
  r = C.ndrAction(c, 'dnp', '', who, cfg, new Date(t0.getTime() + 28 * 3600e3));
  assert.equal(r.set.status, 'resolved'); assert.equal(r.set.resolution.outcome, 'no_response');
});

test('NDR: a call before it is due cannot be logged as no answer, but "wants" / "does not want" always can', () => {
  const c = open({ step: 2, dueAt: new Date(t0.getTime() + 3600e3) });
  assert.throws(() => C.ndrAction(c, 'dnp', '', who, undefined, t0), /FU2 is not due yet/);
  assert.equal(C.ndrAction(c, 'wants', 'will be home Monday', who, undefined, t0).set.resolution.outcome, 'wants');
  assert.equal(C.ndrAction(c, 'not_wants', '', who, undefined, t0).set.resolution.outcome, 'not_wants');
});

test('NDR: notes are kept, trimmed and capped; unknown outcomes and closed cases are refused', () => {
  const r = C.ndrAction(open(), 'wants', `  ${'x'.repeat(900)}  `, who, undefined, t0);
  assert.equal(r.entries[0].note.length, 500);
  assert.throws(() => C.ndrAction(open(), 'maybe', '', who), /what the customer said/);
  assert.throws(() => C.ndrAction(open({ status: 'resolved' }), 'wants', '', who), /already closed/);
});

test('NDR: a case closes itself when Shipway shows delivered or RTO, and stays open while still undelivered', () => {
  assert.equal(C.ndrAutoClose(open(), { group: 'ndr', status: 'Undelivered' }), null);
  assert.equal(C.ndrAutoClose(open(), { group: 'delivered', status: 'Delivered' }).set.resolution.outcome, 'delivered');
  assert.equal(C.ndrAutoClose(open(), { group: 'rto', status: 'RTO in transit' }).set.resolution.outcome, 'rto');
  assert.equal(C.ndrAutoClose(open({ status: 'resolved' }), { group: 'delivered' }), null);
});

test('weight: review -> submit on Shipway -> final resolution, each step can carry a note', () => {
  let c = { orderId: 7, status: 'open', step: 1, weight: { extraCharge: 120 } };
  let r = C.weightAction(c, { decision: 'dispute', note: 'box was 500 g' }, who, t0);
  assert.equal(r.set.step, 2); assert.equal(r.entries[0].note, 'box was 500 g');
  c = { ...c, step: 2 };
  r = C.weightAction(c, { ref: 'TKT-77', note: 'photos attached' }, who, t0);
  assert.equal(r.set.step, 3); assert.equal(r.set.requestRef, 'TKT-77');
  c = { ...c, step: 3 };
  assert.equal(C.weightAction(c, { decision: 'reversed' }, who, t0).set.resolution.amount, 120);
  assert.equal(C.weightAction(c, { decision: 'rejected' }, who, t0).set.resolution.outcome, 'rejected');
  assert.equal(C.weightAction(c, { decision: 'partial', amount: '60' }, who, t0).set.resolution.amount, 60);
  assert.throws(() => C.weightAction(c, { decision: 'partial' }, who, t0), /amount Shipway credited/);
  assert.throws(() => C.weightAction(c, {}, who, t0), /final result/);
});

test('weight: accepting the charge at review closes it; a closed case refuses more steps', () => {
  const r = C.weightAction({ orderId: 7, status: 'open', step: 1 }, { decision: 'accept' }, who, t0);
  assert.equal(r.set.resolution.outcome, 'accepted');
  assert.throws(() => C.weightAction({ orderId: 7, status: 'resolved', step: 3 }, { decision: 'reversed' }, who), /already closed/);
  assert.throws(() => C.weightAction({ orderId: 7, status: 'open', step: 1 }, {}, who), /correct, or raise/);
});

test('weight file: finds the columns by their usual names, converts kg to grams, works out the difference', () => {
  const rows = [
    { 'Order ID': '#1501', 'AWB Number': ' ab 123 ', 'Entered Weight': '0.5', 'Charged Weight': '1', 'Excess Charge': '₹ 85.00', Courier: 'Delhivery', Date: '15/10/2026' },
    { 'Order ID': '', 'AWB Number': '', 'Entered Weight': '1', 'Charged Weight': '2' },
    { 'Order ID': '1502', 'AWB Number': 'X9', 'Entered Weight': '500 g', 'Charged Weight': '1.2 kg', 'Excess Charge': '40' },
  ];
  const p = C.parseWeightRows(rows, { unit: 'kg' });
  assert.equal(p.rows.length, 2); assert.equal(p.skipped.length, 1);
  assert.deepEqual([p.rows[0].orderId, p.rows[0].awb, p.rows[0].declaredG, p.rows[0].chargedG, p.rows[0].diffG, p.rows[0].extraCharge], [1501, 'AB123', 500, 1000, 500, 85]);
  assert.equal(p.rows[0].raisedAt.getTime(), new Date('2026-10-14T18:30:00Z').getTime()); // 15 Oct 2026, IST midnight
  assert.deepEqual([p.rows[1].declaredG, p.rows[1].chargedG, p.rows[1].diffG], [500, 1200, 700]); // units written in the cell win
  assert.equal(C.parseWeightRows([{ Foo: 1 }]).error, 'The file needs an Order ID column or an AWB column.');
  assert.equal(C.parseWeightRows([{ 'Order No': 5, Weight: 1, 'Charged Weight': 700 }], { unit: 'g' }).rows[0].chargedG, 700);
});

test('RTO: starts when Shipway first showed an RTO status; received only counts when the team ticked it', () => {
  const at = new Date('2026-10-10T00:00:00Z');
  assert.equal(C.rtoSince({ history: [{ code: 'INT', at: new Date('2026-10-01') }, { code: 'RTO', at }], changedAt: new Date('2026-10-12') }).getTime(), at.getTime());
  assert.equal(C.rtoSince({ history: [], changedAt: at }).getTime(), at.getTime());
  assert.equal(C.rtoState({ statusCode: 'RTO' }, false), 'on_way');
  assert.equal(C.rtoState({ statusCode: 'RTD' }, false), 'at_origin'); // Shipway says it is back, but nobody here confirmed it
  assert.equal(C.rtoState({ statusCode: 'RTD' }, true), 'received');
});

test('RTO: total, new in the period, received and pending', () => {
  const d = (s) => new Date(s);
  const items = [
    { since: d('2026-10-17'), state: 'on_way' }, { since: d('2026-10-18'), state: 'at_origin' },
    { since: d('2026-10-05'), state: 'received' }, { since: d('2026-10-18'), state: 'received' },
  ];
  const s = C.rtoStats(items, { start: d('2026-10-17'), end: d('2026-10-19') });
  assert.deepEqual([s.total, s.newInRange, s.received, s.pending, s.onWay, s.atOrigin], [4, 3, 2, 2, 1, 1]);
  assert.equal(C.rtoStats(items, null).newInRange, 4);
});

test('case settings are validated', () => {
  assert.deepEqual(C.normaliseCaseConfig({ ndrHours: [0, 2, 12] }).ndrHours, [0, 2, 12]);
  assert.throws(() => C.normaliseCaseConfig({ ndrHours: [1, 2] }), /three numbers/);
  assert.throws(() => C.normaliseCaseConfig({ ndrHours: [0, -1, 2] }), /follow-up 2/);
});
