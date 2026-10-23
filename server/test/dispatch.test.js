const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/lib/dispatch');

const ist = (s) => new Date(`${s}+05:30`); // IST wall clock
const conf = P.normaliseDispatchConfig({}, P.DEFAULT_DISPATCH_CONFIG); // Mon-Sat, slip 12:00, packed 12:00, handover 18:00
const who = { id: 'u1', name: 'Ravi' };
// 2026-10-17 is a Saturday, 2026-10-18 a Sunday, 2026-10-19 a Monday
const confirmed = ist('2026-10-19T09:00:00');
const doc = (extra = {}) => ({ orderId: 1500, stage: 'dispatch', confirmedAt: confirmed, orderAt: confirmed, ...extra });
const apply = (d, t) => ({ ...d, ...t.set, log: [...(d.log || []), ...t.entries] });

// ------------------------------------------------------------ deadlines
test('before the cut-off the step is due the same working day', () => {
  assert.equal(P.dueFor(ist('2026-10-19T09:00:00'), conf.stages.slip, conf).getTime(), ist('2026-10-19T12:00:00').getTime());
  assert.equal(P.dueFor(ist('2026-10-19T13:00:00'), conf.stages.handover, conf).getTime(), ist('2026-10-19T18:00:00').getTime());
});

test('after the cut-off it rolls to the next working day', () => {
  assert.equal(P.dueFor(ist('2026-10-19T15:00:00'), conf.stages.slip, conf).getTime(), ist('2026-10-20T12:00:00').getTime());
  assert.equal(P.dueFor(ist('2026-10-19T12:00:00'), conf.stages.slip, conf).getTime(), ist('2026-10-20T12:00:00').getTime()); // exactly at the cut-off counts as late
});

test('Sunday is skipped when Sunday is not a working day', () => {
  assert.equal(P.dueFor(ist('2026-10-17T15:00:00'), conf.stages.slip, conf).getTime(), ist('2026-10-19T12:00:00').getTime()); // Saturday afternoon -> Monday
  assert.equal(P.dueFor(ist('2026-10-18T10:00:00'), conf.stages.slip, conf).getTime(), ist('2026-10-19T12:00:00').getTime()); // confirmed on Sunday -> Monday 12:00, not an already-past Sunday
});

test('holidays are skipped like non-working days', () => {
  const c = P.normaliseDispatchConfig({ holidays: ['2026-10-20'] }, conf);
  assert.equal(P.dueFor(ist('2026-10-19T15:00:00'), c.stages.slip, c).getTime(), ist('2026-10-21T12:00:00').getTime());
});

test('working days are configurable (Sunday on)', () => {
  const c = P.normaliseDispatchConfig({ workingDays: [0, 1, 2, 3, 4, 5, 6] }, conf);
  assert.equal(P.dueFor(ist('2026-10-17T15:00:00'), c.stages.slip, c).getTime(), ist('2026-10-18T12:00:00').getTime());
});

test('dayOffset counts working days after the start day', () => {
  const c = P.normaliseDispatchConfig({ stages: { packed: { dayOffset: 1, dueTime: '11:30' } } }, conf);
  assert.equal(P.dueFor(ist('2026-10-17T08:00:00'), c.stages.packed, c).getTime(), ist('2026-10-19T11:30:00').getTime()); // Sat + 1 working day = Mon
});

// ------------------------------------------------------------ settings
test('settings are validated with plain messages', () => {
  assert.throws(() => P.normaliseDispatchConfig({ stages: { slip: { dueTime: '25:00' } } }, conf), /12:00/);
  assert.throws(() => P.normaliseDispatchConfig({ stages: { packed: { dayOffset: 2.5 } } }, conf), /whole number/);
  assert.throws(() => P.normaliseDispatchConfig({ workingDays: [] }, conf), /at least one working day/);
  assert.throws(() => P.normaliseDispatchConfig({ holidays: ['8 Nov'] }, conf), /2026-11-08/);
  const c = P.normaliseDispatchConfig({ stages: { handover: { dueTime: '17:30', requirePhoto: false } } }, conf);
  assert.equal(c.stages.handover.dueTime, '17:30'); assert.equal(c.stages.handover.requirePhoto, false);
  assert.equal(c.stages.slip.dueTime, '12:00'); // untouched
  assert.equal(P.normaliseDispatchConfig({ stages: { slip: { requirePhoto: true } } }, conf).stages.slip.requirePhoto, undefined); // the slip step has no photo
});

// ------------------------------------------------------------ the three steps
test('an order confirmed before this feature existed starts at the packing slip', () => {
  assert.equal(P.stepOf(doc()), 'slip');
  assert.equal(P.stepOf({ ...doc(), stage: 'confirm' }), null);
});

test('slip -> packed -> handover -> dispatched, each stamped with who and when', () => {
  let d = doc();
  d = apply(d, P.slipDone(d, conf, who, ist('2026-10-19T10:00:00')));
  assert.equal(P.stepOf(d), 'packed');
  assert.equal(d.dq.slip.byName, 'Ravi'); assert.equal(d.dq.slip.late, false);
  assert.equal(P.dueAt(d, conf).getTime(), ist('2026-10-19T12:00:00').getTime()); // packed deadline counts from the slip

  d = apply(d, P.packedDone(d, { awb: ' 1491 0510 8234 ', courier: 'Delhivery', photoId: 'p1' }, conf, who, ist('2026-10-19T11:30:00')));
  assert.equal(P.stepOf(d), 'handover'); assert.equal(d.dq.packed.awb, '1491 0510 8234'.replace(/ /g, ''));
  assert.equal(P.dueAt(d, conf).getTime(), ist('2026-10-19T18:00:00').getTime());

  d = apply(d, P.handoverDone(d, { manifestId: 'm1' }, conf, who, ist('2026-10-19T17:00:00')));
  assert.equal(d.stage, 'dispatched'); assert.equal(d.dq.step, 'done');
  assert.equal(d.dispatch.awb, '149105108234'); assert.equal(d.dispatch.courier, 'Delhivery'); assert.equal(d.dq.handover.manifestId, 'm1');
  assert.equal(d.log[d.log.length - 1].action, 'dispatch'); // the Overview counts "dispatched" from this action
  assert.equal(P.stepOf(d), null);
});

test('a step done after its deadline is recorded as late', () => {
  let d = doc();
  const t = P.slipDone(d, conf, who, ist('2026-10-19T14:00:00')); // due 12:00
  assert.equal(t.set.dq.slip.late, true); assert.match(t.entries[0].label, /late/);
});

test('steps cannot be skipped or repeated', () => {
  const d = doc();
  assert.throws(() => P.packedDone(d, { awb: 'ABC12345', photoId: 'p' }, conf, who), /at “Packing slip”/);
  assert.throws(() => P.handoverDone(d, { manifestId: 'm' }, conf, who), /not “Order handover”/);
  const d2 = apply(d, P.slipDone(d, conf, who));
  assert.throws(() => P.slipDone(d2, conf, who), /at “Order packed”/);
  assert.throws(() => P.slipDone({ ...d, stage: 'cancelled' }, conf, who), /no longer in the dispatch queue/);
});

test('Order packed needs a valid AWB and no photo', () => {
  let d = apply(doc(), P.slipDone(doc(), conf, who));
  assert.throws(() => P.packedDone(d, { awb: '', photoId: 'p' }, conf, who), /AWB/);
  assert.throws(() => P.packedDone(d, { awb: 'AB', photoId: 'p' }, conf, who), /5 to 40/);
  assert.throws(() => P.packedDone(d, { awb: 'AB 12$45', photoId: 'p' }, conf, who), /AWB/);
  assert.equal(P.packedDone(d, { awb: 'ABC12345' }, conf, who).set.dq.packed.awb, 'ABC12345'); // no photo needed
  const off = P.normaliseDispatchConfig({ stages: { packed: { requirePhoto: false } } }, conf);
  assert.equal(P.packedDone(d, { awb: 'abc12345' }, off, who).set.dq.packed.awb, 'ABC12345'); // upper-cased
});

test('Order handover needs the manifest photo unless settings say otherwise', () => {
  let d = doc(); d = apply(d, P.slipDone(d, conf, who)); d = apply(d, P.packedDone(d, { awb: 'ABC12345', photoId: 'p' }, conf, who));
  assert.throws(() => P.handoverDone(d, {}, conf, who), /manifest/);
  const off = P.normaliseDispatchConfig({ stages: { handover: { requirePhoto: false } } }, conf);
  assert.equal(P.handoverDone(d, {}, off, who).set.stage, 'dispatched');
});

test('stepCounts: how many orders sit in each step, and how many are past their deadline', () => {
  const now = ist('2026-10-19T13:00:00');
  const docs = [
    doc({ orderId: 1 }), // slip, due 12:00 -> overdue
    doc({ orderId: 2, confirmedAt: ist('2026-10-19T12:30:00') }), // slip, due tomorrow
    doc({ orderId: 3, dq: { step: 'packed', stepAt: ist('2026-10-19T11:00:00') } }), // packed, due 12:00 -> overdue
    doc({ orderId: 4, dq: { step: 'handover', stepAt: ist('2026-10-19T12:10:00') } }), // handover, due 18:00
    doc({ orderId: 5, stage: 'confirm' }), // not in the queue
  ];
  const c = P.stepCounts(docs, conf, now);
  assert.deepEqual([c.slip, c.packed, c.handover, c.overdue], [2, 1, 1, 2]);
  assert.deepEqual(c.overdueBy, { slip: 1, packed: 1, handover: 0 });
});

test('timeLabel shows a 12-hour clock', () => {
  assert.equal(P.timeLabel('12:00'), '12:00 PM'); assert.equal(P.timeLabel('18:00'), '6:00 PM'); assert.equal(P.timeLabel('00:30'), '12:30 AM'); assert.equal(P.timeLabel('09:05'), '9:05 AM');
});

// ------------------------------------------------------------ several photos, AWB from Shipway
test('several package photos are kept, the first is also kept as photoId, and one is enough', () => {
  let d = doc(); d = apply(d, P.slipDone(d, conf, who));
  const t = P.packedDone(d, { awb: 'ABC12345', courier: 'Delhivery', photoIds: ['p1', 'p2', 'p2', 'p3'] }, conf, who);
  assert.deepEqual(t.set.dq.packed.photoIds, ['p1', 'p2', 'p3']); assert.equal(t.set.dq.packed.photoId, 'p1');
  assert.deepEqual(P.packedDone(d, { awb: 'ABC12345', photoIds: [] }, conf, who).set.dq.packed.photoIds, []);
  assert.throws(() => P.packedDone(d, { awb: 'ABC12345', photoIds: Array.from({ length: 11 }, (_, i) => `p${i}`) }, conf, who), /at most 10/);
  const off = P.normaliseDispatchConfig({ stages: { packed: { requirePhoto: false } } }, conf);
  assert.deepEqual(P.packedDone(d, { awb: 'ABC12345', photoIds: [] }, off, who).set.dq.packed.photoIds, []);
});

test('several manifest photos are kept for every order handed over', () => {
  let d = doc(); d = apply(d, P.slipDone(d, conf, who)); d = apply(d, P.packedDone(d, { awb: 'ABC12345', photoId: 'p' }, conf, who));
  const t = P.handoverDone(d, { manifestIds: ['m1', 'm2'] }, conf, who);
  assert.deepEqual(t.set.dq.handover.manifestIds, ['m1', 'm2']); assert.equal(t.set.dq.handover.manifestId, 'm1');
  assert.throws(() => P.handoverDone(d, { manifestIds: [] }, conf, who), /at least one photo/);
});

test('typing the AWB by hand is allowed by default and can be switched off', () => {
  assert.equal(conf.allowManualAwb, true);
  assert.equal(P.normaliseDispatchConfig({ allowManualAwb: false }, conf).allowManualAwb, false);
  assert.equal(P.normaliseDispatchConfig({ holidays: [] }, P.normaliseDispatchConfig({ allowManualAwb: false }, conf)).allowManualAwb, false); // later saves keep it
});

// ------------------------------------------------------------ hold and resume
test('hold needs a note, keeps the step and pauses the deadline', () => {
  const d = doc();
  assert.throws(() => P.holdOrder(d, { note: '  ' }, who), /note/i);
  const held = apply(d, P.holdOrder(d, { note: 'Customer changing the address' }, who, ist('2026-10-19T10:00:00')));
  assert.equal(P.isHeld(held), true);
  assert.equal(P.stepOf(held), 'slip');
  assert.equal(P.dueAt(held, conf), null);
  assert.equal(held.log[0].action, 'hold');
  assert.throws(() => P.holdOrder(held, { note: 'again' }, who), /already on hold/);
});

test('a held order cannot be moved along until it is resumed', () => {
  const held = apply(doc(), P.holdOrder(doc(), { note: 'Out of stock' }, who));
  assert.throws(() => P.slipDone(held, conf, who), (e) => e.status === 409 && /on hold/.test(e.message));
  assert.throws(() => P.packedDone({ ...held, dq: { ...held.dq, step: 'packed' } }, { awb: 'AWB12345' }, conf, who), /on hold/);
  assert.throws(() => P.handoverDone({ ...held, dq: { ...held.dq, step: 'handover' } }, {}, conf, who), /on hold/);
});

test('resume restarts the deadline from now and keeps the step', () => {
  const held = apply(doc(), P.holdOrder(doc(), { note: 'Out of stock' }, who, ist('2026-10-19T10:00:00')));
  const back = apply(held, P.resumeOrder(held, { note: 'Stock arrived' }, who, ist('2026-10-21T09:00:00')));
  assert.equal(P.isHeld(back), false);
  assert.equal(P.stepOf(back), 'slip');
  assert.equal(P.dueAt(back, conf).getTime(), ist('2026-10-21T12:00:00').getTime());
  assert.throws(() => P.resumeOrder(back, {}, who), /not on hold/);
  assert.match(back.log[back.log.length - 1].label, /Stock arrived/);
});

test('held orders are counted separately and are never overdue', () => {
  const late = doc({ orderId: 1 });
  const held = apply(doc({ orderId: 2 }), P.holdOrder(doc({ orderId: 2 }), { note: 'Waiting' }, who));
  const c = P.stepCounts([late, held], conf, ist('2026-10-25T10:00:00'));
  assert.equal(c.slip, 1); assert.equal(c.hold, 1); assert.equal(c.overdue, 1);
});

test('cancelling from the dispatch queue records reason and note', () => {
  const D = require('../src/lib/desk');
  const d = doc();
  const t = D.transition(d, 'cancel', { reason: 'Address not serviceable', note: 'Courier does not go there' }, D.DEFAULT_CONFIG, who);
  assert.equal(t.set.stage, 'cancelled'); assert.equal(t.set.cancel.fromStage, 'dispatch'); assert.equal(t.set.cancel.note, 'Courier does not go there');
  assert.throws(() => P.cleanNote('', { label: 'note' }), /note/);
});
