const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const D = require('../src/lib/desk');
const { verifyShopifyHmac } = require('../src/lib/shopifyHmac');

const H = D.HOUR; const DAY = D.DAY;
const conf = D.normaliseConfig({}, { ...D.DEFAULT_CONFIG, startFrom: '2026-10-01' }); // FU hours 0/2/4, pending days 1/2/3
const who = { id: 'u1', name: 'Asha' };
const t0 = new Date('2026-10-16T06:00:00Z');
const order = { orderId: 1500, createdAt: t0 };
const apply = (doc, t) => ({ ...doc, ...t.set, log: [...doc.log, ...t.entries] });
const step = (doc, action, input, now, o = { total: 1000 }) => apply(doc, D.transition(doc, action, input, conf, who, o, now));

test('a new order enters the confirm queue at FU1, due straight away by default', () => {
  const s = D.initialState(order, conf, t0);
  assert.equal(s.stage, 'confirm'); assert.equal(s.fuNo, 1);
  assert.equal(s.dueAt.getTime(), t0.getTime());
  assert.equal(D.fuLabel(s), 'FU1');
});

test('FU1 timing comes from settings (hours after the order)', () => {
  const c = D.normaliseConfig({ confirmHours: [0.5, 3, 6] }, conf);
  assert.equal(D.initialState(order, c, t0).dueAt.getTime(), t0.getTime() + 30 * 60000);
});

test('an order cancelled in Shopify goes straight to Cancelled with the reason', () => {
  const s = D.initialState({ ...order, cancelledAt: t0 }, conf, t0);
  assert.equal(s.stage, 'cancelled'); assert.equal(s.cancel.reason, 'Cancelled in Shopify'); assert.equal(s.cancel.auto, true);
});

test('DNP needs the WhatsApp yes/no answer', () => {
  const s = D.initialState(order, conf, t0);
  assert.throws(() => D.transition(s, 'dnp', {}, conf, who, {}, t0), /WhatsApp message was shared/);
  assert.throws(() => D.transition(s, 'dnp', { whatsappShared: 'maybe' }, conf, who, {}, t0), /WhatsApp/);
});

test('FU1 DNP -> FU2 due after the configured gap; FU2 DNP -> FU3; FU3 DNP -> Pending Day 1', () => {
  let d = D.initialState(order, conf, t0);
  d = step(d, 'dnp', { whatsappShared: 'yes' }, t0);
  assert.equal(d.fuNo, 2); assert.equal(d.stage, 'confirm');
  assert.equal(d.dueAt.getTime(), t0.getTime() + 2 * H);
  assert.equal(d.log.at(-1).whatsappShared, true);
  const t1 = new Date(t0.getTime() + 2 * H);
  d = step(d, 'dnp', { whatsappShared: 'no' }, t1);
  assert.equal(d.fuNo, 3); assert.equal(d.dueAt.getTime(), t1.getTime() + 4 * H);
  const t2 = new Date(t1.getTime() + 4 * H);
  d = step(d, 'dnp', { whatsappShared: true }, t2);
  assert.equal(d.stage, 'pending'); assert.equal(d.fuNo, 1); assert.equal(d.dnpCount, 3);
  assert.equal(d.dueAt.getTime(), t2.getTime() + DAY);
  assert.equal(d.log.at(-1).action, 'to_pending');
});

test('DNP before the follow-up is due is refused', () => {
  let d = D.initialState(order, conf, t0);
  d = step(d, 'dnp', { whatsappShared: 'yes' }, t0);
  assert.throws(() => D.transition(d, 'dnp', { whatsappShared: 'yes' }, conf, who, {}, new Date(t0.getTime() + H)), /not due yet/);
});

test('Pending: Day 1, 2, 3 are measured from the day it moved to Pending; Day 3 DNP auto-cancels', () => {
  let d = { ...D.initialState(order, conf, t0), stage: 'pending', fuNo: 1, pendingSince: t0, dueAt: new Date(t0.getTime() + DAY), dnpCount: 3 };
  const day1 = new Date(t0.getTime() + DAY + 5 * H); // answered late
  d = step(d, 'dnp', { whatsappShared: 'yes' }, day1);
  assert.equal(d.fuNo, 2); assert.equal(d.dueAt.getTime(), t0.getTime() + 2 * DAY); // not day1 + 1 day
  d = step(d, 'dnp', { whatsappShared: 'yes' }, new Date(t0.getTime() + 2 * DAY));
  assert.equal(d.fuNo, 3); assert.equal(d.dueAt.getTime(), t0.getTime() + 3 * DAY);
  d = step(d, 'dnp', { whatsappShared: 'no' }, new Date(t0.getTime() + 3 * DAY));
  assert.equal(d.stage, 'cancelled'); assert.equal(d.cancel.auto, true); assert.equal(d.dnpCount, 6);
  assert.match(d.cancel.reason, /6 follow-ups/);
  assert.equal(d.log.at(-1).action, 'auto_cancel');
});

test('Confirmed moves to the dispatch queue and remembers which follow-up got it', () => {
  let d = D.initialState(order, conf, t0);
  d = step(d, 'dnp', { whatsappShared: 'yes' }, t0);
  d = step(d, 'confirm', {}, new Date(t0.getTime() + 3 * H));
  assert.equal(d.stage, 'dispatch'); assert.equal(d.confirmedAtFu, 'FU2'); assert.equal(d.dueAt, null);
});

test('Cancelled needs a reason and keeps it with who cancelled', () => {
  const d = D.initialState(order, conf, t0);
  assert.throws(() => D.transition(d, 'cancel', { reason: ' ' }, conf, who, {}, t0), /reason/);
  const c = step(d, 'cancel', { reason: 'Price / COD charges', note: 'wants prepaid discount' }, t0);
  assert.equal(c.stage, 'cancelled'); assert.equal(c.cancel.reason, 'Price / COD charges'); assert.equal(c.cancel.byName, 'Asha'); assert.equal(c.cancel.auto, false);
});

test('Partial paid: amount below the total, screenshot required by default, balance worked out', () => {
  const d = D.initialState(order, conf, t0);
  assert.throws(() => D.transition(d, 'partial_paid', { amount: 0 }, conf, who, { total: 1000 }, t0), /how much/);
  assert.throws(() => D.transition(d, 'partial_paid', { amount: 1000, screenshotId: 's' }, conf, who, { total: 1000 }, t0), /Use Confirmed/);
  assert.throws(() => D.transition(d, 'partial_paid', { amount: 300 }, conf, who, { total: 1000 }, t0), /screenshot/);
  const p = step(d, 'partial_paid', { amount: 300, notes: 'UPI ref 123', screenshotId: 'shot1' }, t0);
  assert.equal(p.stage, 'dispatch'); assert.equal(p.partial.amount, 300); assert.equal(p.partial.balance, 700); assert.equal(p.partial.screenshotId, 'shot1');
  assert.equal(D.statusLabel(p), 'Partial paid · to dispatch');
  const off = D.normaliseConfig({ requireScreenshot: false }, conf);
  const q = apply(d, D.transition(d, 'partial_paid', { amount: 300 }, off, who, { total: 1000 }, t0));
  assert.equal(q.partial.screenshotId, null);
});

test('an unset partial object ({} from the database) does not count as partial', () => {
  assert.equal(D.statusLabel({ stage: 'dispatch', partial: {} }), 'Confirmed · to dispatch');
});

test('dispatch, and the wrong-stage guard', () => {
  let d = step(D.initialState(order, conf, t0), 'confirm', {}, t0);
  assert.throws(() => D.transition(d, 'dnp', { whatsappShared: 'yes' }, conf, who, {}, t0), /already dispatch queue/i);
  d = step(d, 'dispatch', { awb: ' AB123 ', courier: 'Delhivery' }, t0);
  assert.equal(d.stage, 'dispatched'); assert.equal(d.dispatch.awb, 'AB123');
  assert.throws(() => D.transition(d, 'confirm', {}, conf, who, {}, t0), /already/);
});

test('restore puts a cancelled order back at FU1', () => {
  let d = step(D.initialState(order, conf, t0), 'cancel', { reason: 'Other' }, t0);
  d = step(d, 'restore', {}, t0);
  assert.equal(d.stage, 'confirm'); assert.equal(d.fuNo, 1); assert.equal(d.cancel, null);
  assert.throws(() => D.transition(D.initialState(order, conf, t0), 'restore', {}, conf, who, {}, t0), /already/);
});

test('settings are validated', () => {
  assert.throws(() => D.normaliseConfig({ confirmHours: [0, 2] }, conf), /three numbers/);
  assert.throws(() => D.normaliseConfig({ confirmHours: [0, -1, 4] }, conf), /0 to 720/);
  assert.throws(() => D.normaliseConfig({ pendingDays: [3, 2, 1] }, conf), /later day/);
  assert.throws(() => D.normaliseConfig({ cancelReasons: [] }, conf), /between 1 and 30/);
  assert.throws(() => D.normaliseConfig({ startFrom: 'yesterday' }, conf), /2026-10-16/);
  assert.deepEqual(D.normaliseConfig({ cancelReasons: ['A ', 'A', ' B'] }, conf).cancelReasons, ['A', 'B']);
});

test('phone numbers and the WhatsApp link', () => {
  assert.equal(D.dialNumber('+91 98765-43210'), '+919876543210');
  assert.equal(D.dialNumber('09876543210'), '+919876543210');
  assert.equal(D.dialNumber('12345'), null);
  const l = D.waLink('98765 43210', 'Hi & bye');
  assert.equal(l, 'https://wa.me/919876543210?text=Hi%20%26%20bye');
  assert.equal(D.waLink('', 'x'), null);
  assert.equal(D.renderTemplate('Hi {name}, {order} ₹{amount} {nope}', { name: 'Asha', order: '#1500', amount: 999 }), 'Hi Asha, #1500 ₹999 {nope}');
});

test('collect amount: paid orders collect nothing, COD collects total minus partial', () => {
  assert.equal(D.collectAmount(1000, 'PAID', null), 0);
  assert.equal(D.collectAmount(1000, 'PENDING', null), 1000);
  assert.equal(D.collectAmount(1000, 'PENDING', { amount: 300 }), 700);
});

test('overview numbers add up', () => {
  const mk = (stage, total, extra = {}) => ({ total, desk: { stage, fuNo: 1, orderAt: t0, log: [], ...extra } });
  let a = D.initialState({ orderId: 1, createdAt: t0 }, conf, t0);
  a = step(a, 'dnp', { whatsappShared: 'yes' }, t0);
  a = step(a, 'confirm', {}, new Date(t0.getTime() + 3 * H));
  let b = D.initialState({ orderId: 2, createdAt: t0 }, conf, t0);
  b = step(b, 'cancel', { reason: 'Price / COD charges' }, new Date(t0.getTime() + H));
  const rows = [{ desk: a, total: 1000 }, { desk: b, total: 500 }, mk('pending', 300), { desk: null, total: 200 }];
  const s = D.overviewStats(rows, new Date(t0.getTime() + 10 * H));
  assert.equal(s.totalOrders, 4); assert.equal(s.stageCount.dispatch, 1); assert.equal(s.stageCount.cancelled, 1); assert.equal(s.stageCount.pending, 1); assert.equal(s.stageCount.none, 1);
  assert.equal(s.money.all, 2000); assert.equal(s.money.confirmed, 1000); assert.equal(s.money.cancelled, 500);
  assert.equal(s.confirmRate, 25); assert.equal(s.cancelRate, 25);
  const fu1 = s.byFu.find((x) => x.fu === 'FU1'); const fu2 = s.byFu.find((x) => x.fu === 'FU2');
  assert.equal(fu1.dnp, 1); assert.equal(fu1.whatsappYes, 1); assert.equal(fu1.cancelled, 1); assert.equal(fu2.confirmed, 1);
  assert.equal(s.reasons[0].reason, 'Price / COD charges');
  assert.equal(s.agents[0].name, 'Asha'); assert.equal(s.agents[0].calls, 3);
  assert.equal(Math.round(s.avgDecisionHours * 10) / 10, 2); // (3h + 1h) / 2
});

test('Shopify webhook signature', () => {
  const body = Buffer.from('{"id":1}'); const secret = 'shhh';
  const good = crypto.createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(verifyShopifyHmac(body, good, secret), true);
  assert.equal(verifyShopifyHmac(body, good, 'other'), false);
  assert.equal(verifyShopifyHmac(Buffer.from('{"id":2}'), good, secret), false);
  assert.equal(verifyShopifyHmac(body, '', secret), false);
  assert.equal(verifyShopifyHmac(undefined, good, secret), false);
  assert.equal(verifyShopifyHmac(body, good, ''), false);
});
