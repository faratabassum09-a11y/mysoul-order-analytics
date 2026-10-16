// Runs the real flowService against a tiny in-memory stand-in for the database models (no MongoDB needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// ---- minimal fake of the Mongoose calls the service uses ----
let seq = 0;
const newId = () => (++seq).toString(16).padStart(24, '0');
const isOps = (c) => c && typeof c === 'object' && !(c instanceof Date) && !Buffer.isBuffer(c) && Object.keys(c).some((k) => k.startsWith('$'));
const nil = (v) => v === undefined || v === null;
const eq = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : nil(a) && nil(b) ? true : a === b);
function cond(v, c) {
  if (!isOps(c)) return eq(v, c);
  return Object.entries(c).every(([op, x]) => {
    if (op === '$in') return x.some((y) => eq(v, y));
    if (op === '$ne') return !eq(v, x);
    if (op === '$gte') return !nil(v) && v >= x;
    if (op === '$lt') return !nil(v) && v < x;
    throw new Error(`fake: operator ${op} not supported`);
  });
}
const match = (d, f) => Object.entries(f).every(([k, c]) => cond(d[k], c));
const clone = (d) => (d ? Object.assign(Object.create(null), structuredClone(d)) : d);

class Coll {
  constructor(name, { unique = [] } = {}) { this.name = name; this.docs = []; this.unique = unique; }
  _q(fn) {
    let sortBy = null, lim = Infinity, fields = null;
    const q = {
      select(f) { fields = typeof f === 'string' ? f.split(/\s+/).filter(Boolean) : null; return q; },
      sort(s) { sortBy = s; return q; }, limit(n) { lim = n; return q; }, skip() { return q; },
      lean() { return q; },
      then(res, rej) {
        try {
          let out = fn();
          if (Array.isArray(out)) {
            if (sortBy) { const [[k, dir]] = Object.entries(sortBy); out = [...out].sort((a, b) => ((a[k] > b[k]) - (a[k] < b[k])) * dir); }
            out = out.slice(0, lim).map(clone);
          } else out = clone(out);
          return Promise.resolve(out).then(res, rej);
        } catch (e) { return Promise.reject(e).then(res, rej); }
      },
    };
    return q;
  }
  find(f = {}) { return this._q(() => this.docs.filter((d) => match(d, f))); }
  findOne(f = {}) { return this._q(() => this.docs.find((d) => match(d, f)) || null); }
  findById(id) { return this.findOne({ _id: id }); }
  exists(f) { return this._q(() => (this.docs.find((d) => match(d, f)) ? { _id: 1 } : null)); }
  countDocuments(f = {}) { return Promise.resolve(this.docs.filter((d) => match(d, f)).length); }
  _apply(d, u) {
    if (!Object.keys(u).some((k) => k.startsWith('$'))) u = { $set: u }; // Mongoose treats a plain update document as $set
    for (const [k, v] of Object.entries(u.$set || {})) d[k] = v;
    for (const [k, v] of Object.entries(u.$inc || {})) d[k] = (d[k] || 0) + v;
    for (const [k, v] of Object.entries(u.$push || {})) (d[k] = d[k] || []).push(v);
    for (const u1 of this.unique) {
      if (!nil(d[u1]) && this.docs.some((o) => o !== d && o[u1] === d[u1])) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
  }
  findOneAndUpdate(f, u, opts = {}) {
    return this._q(() => {
      let d = this.docs.find((x) => match(x, f));
      if (!d && opts.upsert) {
        d = { _id: newId(), ...Object.fromEntries(Object.entries(f).filter(([, c]) => !isOps(c))), ...(u.$setOnInsert || {}) };
        this.docs.push(d);
      }
      if (!d) return null;
      const before = clone(d);
      try { this._apply(d, u); } catch (e) { Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, before); throw e; }
      return d;
    });
  }
  updateOne(f, u) { const d = this.docs.find((x) => match(x, f)); if (d) this._apply(d, u); return Promise.resolve({ matchedCount: d ? 1 : 0 }); }
  updateMany(f, u) { const ds = this.docs.filter((x) => match(x, f)); ds.forEach((d) => this._apply(d, u)); return Promise.resolve({ matchedCount: ds.length }); }
  deleteOne(f) { const i = this.docs.findIndex((x) => match(x, f)); if (i >= 0) this.docs.splice(i, 1); return Promise.resolve(); }
  async create(doc) { const d = { _id: newId(), at: new Date(), ...doc }; this.docs.push(d); return clone(d); }
}
const models = {
  Order: new Coll('Order'), ShopifyOrder: new Coll('ShopifyOrder'), ShipwayShipment: new Coll('ShipwayShipment'),
  OrderFlow: new Coll('OrderFlow', { unique: ['awb'] }), FlowEvent: new Coll('FlowEvent'), FlowProof: new Coll('FlowProof'), Setting: new Coll('Setting'),
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === 'dotenv') return { config() {} }; return origLoad.call(this, req, ...rest); };
require.cache[require.resolve('../src/models')] = { id: 'models', filename: require.resolve('../src/models'), loaded: true, exports: models };
const svc = require('../src/services/flowService');
const F = require('../src/lib/flow');

const HOUR = 3600 * 1000;
const NOW = new Date('2026-10-15T10:00:00Z');
const ago = (h) => new Date(NOW.getTime() - h * HOUR);
const asha = { id: 'u-asha', name: 'Asha', role: 'confirmation' };
const ravi = { id: 'u-ravi', name: 'Ravi', role: 'confirmation' };
const mina = { id: 'u-mina', name: 'Mina', role: 'packing' };
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const photo = { buffer: JPG };
const mkOrder = (orderId, hoursOld, extra = {}) => ({ orderId, orderDate: ago(hoursOld), name: 'Priya Sharma', phone: '9876543210', amount: 1499, paymentMode: 'COD', product: 'Serum', confirmed: 'Pending', excluded: null, dispatchYes: false, deliveryStatus: '', rto: '', log: [], ...extra });
const reset = () => { Object.values(models).forEach((c) => { c.docs = []; }); };
const events = (id) => models.FlowEvent.docs.filter((e) => e.orderId === id);
const rejects = (p, status, re) => assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (re) assert.match(e.message, re); return true; });

test('queue: oldest first, SLA bands, no phone numbers exposed', async () => {
  reset();
  models.Order.docs.push(mkOrder(11, 1), mkOrder(12, 5), mkOrder(13, 3), mkOrder(14, 1, { confirmed: 'Yes' }), mkOrder(15, 1, { excluded: 'test' }));
  const q = await svc.confirmQueue(NOW);
  assert.deepEqual(q.items.map((i) => i.orderId), [12, 13, 11]);
  assert.deepEqual(q.items.map((i) => i.band), ['red', 'amber', 'green']);
  assert.deepEqual(q.counts, { total: 3, green: 1, amber: 1, red: 1, escalated: 0 });
  assert.ok(!JSON.stringify(q).includes('9876543210'));
});

test('confirm: logs person, time and previous status; order copy updated; second tap is refused', async () => {
  reset(); models.Order.docs.push(mkOrder(21, 1));
  const r = await svc.confirmAction(asha, 21, 'confirm', {}, NOW);
  assert.equal(r.confirmStatus, 'confirmed'); assert.equal(r.dispatchStage, 'print_slip');
  const [ev] = events(21);
  assert.equal(ev.byName, 'Asha'); assert.equal(ev.byId, 'u-asha'); assert.equal(ev.previous, 'pending'); assert.equal(ev.next, 'confirmed'); assert.equal(ev.at.getTime(), NOW.getTime());
  const o = models.Order.docs[0];
  assert.equal(o.confirmed, 'Yes'); assert.equal(o.finalStatus, 'Confirmed'); assert.match(o.log[0], /Asha/);
  await rejects(svc.confirmAction(ravi, 21, 'confirm', {}, NOW), 409);
  assert.equal(events(21).length, 1);
  assert.equal((await svc.confirmQueue(NOW)).items.length, 0);
});

test('cancel needs a reason from the fixed list', async () => {
  reset(); models.Order.docs.push(mkOrder(31, 1));
  await rejects(svc.confirmAction(asha, 31, 'cancel', {}, NOW), 400, /reason/i);
  await rejects(svc.confirmAction(asha, 31, 'cancel', { reason: 'because i said so' }, NOW), 400);
  await svc.confirmAction(asha, 31, 'cancel', { reason: 'duplicate_order' }, NOW);
  assert.equal(models.OrderFlow.docs[0].cancelReason, 'duplicate_order');
  assert.equal(models.Order.docs[0].confirmed, 'Cancel');
  assert.match(events(31)[0].label, /Duplicate order/);
});

test('partial pay: amount required and capped at the order amount; goes to Dispatch Desk', async () => {
  reset(); models.Order.docs.push(mkOrder(41, 1));
  await rejects(svc.confirmAction(asha, 41, 'partial_pay', {}, NOW), 400);
  await rejects(svc.confirmAction(asha, 41, 'partial_pay', { amount: 0 }, NOW), 400);
  await rejects(svc.confirmAction(asha, 41, 'partial_pay', { amount: 5000 }, NOW), 400);
  await svc.confirmAction(asha, 41, 'partial_pay', { amount: 300 }, NOW);
  const f = models.OrderFlow.docs[0];
  assert.equal(f.partial.amount, 300); assert.equal(f.dispatchStage, 'print_slip');
  assert.equal(models.Order.docs[0].paymentMode, 'Partial COD');
  assert.equal(events(41)[0].meta.previousMode, 'COD');
});

test('no answer: attempts 1, 2, 3 then auto-cancel (with a gap between attempts)', async () => {
  reset(); models.Order.docs.push(mkOrder(51, 6));
  let r = await svc.confirmAction(asha, 51, 'no_answer', {}, NOW);
  assert.equal(r.noAnswerAttempts, 1); assert.equal(r.confirmStatus, 'no_answer');
  await rejects(svc.confirmAction(asha, 51, 'no_answer', {}, new Date(NOW.getTime() + 5 * 60000)), 409, /min/);
  const t2 = new Date(NOW.getTime() + 31 * 60000);
  r = await svc.confirmAction(ravi, 51, 'no_answer', {}, t2); // a different person can log the next attempt
  assert.equal(r.noAnswerAttempts, 2);
  const q = await svc.confirmQueue(t2);
  assert.equal(q.items[0].attempts, 2); assert.ok(q.items[0].nextAttemptAt);
  const t3 = new Date(t2.getTime() + 31 * 60000);
  r = await svc.confirmAction(asha, 51, 'no_answer', {}, t3);
  assert.equal(r.outcome, 'cancel'); assert.equal(r.confirmStatus, 'cancelled');
  const f = models.OrderFlow.docs[0];
  assert.equal(f.cancelReason, 'no_answer_x3'); assert.equal(f.noAnswerAttempts, 3);
  assert.deepEqual(events(51).map((e) => e.action), ['no_answer', 'no_answer', 'no_answer', 'auto_cancel']);
  assert.equal(events(51)[3].byName, 'System');
  assert.equal(models.Order.docs[0].confirmed, 'Cancel');
});

test('no answer: escalate option keeps the order in the queue, flagged, and blocks a 4th attempt', async () => {
  reset(); models.Order.docs.push(mkOrder(61, 6));
  await svc.saveConfig({ afterThree: 'escalate' });
  let t = NOW;
  for (let i = 0; i < 3; i++) { await svc.confirmAction(asha, 61, 'no_answer', {}, t); t = new Date(t.getTime() + 31 * 60000); }
  const q = await svc.confirmQueue(t);
  assert.equal(q.items[0].escalated, true); assert.equal(q.counts.escalated, 1);
  await rejects(svc.confirmAction(asha, 61, 'no_answer', {}, t), 409, /Three attempts/);
  await svc.confirmAction(asha, 61, 'confirm', {}, t); // a lead can still resolve it
  assert.equal(models.OrderFlow.docs[0].confirmStatus, 'confirmed');
  assert.equal(models.OrderFlow.docs[0].escalated, false);
});

test('an order already decided in the sheet cannot be acted on', async () => {
  reset(); models.Order.docs.push(mkOrder(71, 1, { confirmed: 'Yes' }));
  await rejects(svc.confirmAction(asha, 71, 'confirm', {}, NOW), 409, /already confirmed/);
});

test('contact: call and WhatsApp are logged and return the right link; payment link needs setup and a valid amount', async () => {
  reset(); models.Order.docs.push(mkOrder(81, 1));
  const c = await svc.contact(asha, 81, 'call', {}, NOW);
  assert.equal(c.url, 'tel:+919876543210');
  const w = await svc.contact(asha, 81, 'whatsapp', {}, NOW);
  assert.match(w.url, /^https:\/\/wa\.me\/919876543210\?text=Hi%20Priya/);
  assert.deepEqual(events(81).map((e) => e.action), ['call', 'whatsapp']);
  assert.equal(events(81)[0].stage, 'contact');
  await rejects(svc.contact(asha, 81, 'partial_link', { amount: 300 }, NOW), 400, /link is set up|payment link/i);
  await assert.rejects(svc.saveConfig({ partialLinkUrl: 'http://insecure.example' }), (e) => e.status === 400);
  await svc.saveConfig({ partialLinkUrl: 'https://pay.example.com/o/{orderId}?amt={amount}' });
  await rejects(svc.contact(asha, 81, 'partial_link', { amount: 99999 }, NOW), 400);
  const p = await svc.contact(asha, 81, 'partial_link', { amount: 300 }, NOW);
  assert.ok(decodeURIComponent(p.url).includes('https://pay.example.com/o/81?amt=300'));
  assert.ok(models.OrderFlow.docs[0].partialLinkSentAt);
  assert.equal(events(81).at(-1).action, 'partial_link');
});

test('contact: phone falls back to Shopify, and a missing phone is a clear error', async () => {
  reset(); models.Order.docs.push(mkOrder(91, 1, { phone: null }), mkOrder(92, 1, { phone: null }));
  models.ShopifyOrder.docs.push({ orderId: 91, customer: { phone: '+91 91234 56780' } });
  assert.equal((await svc.contact(asha, 91, 'call', {}, NOW)).url, 'tel:+919123456780');
  await rejects(svc.contact(asha, 92, 'call', {}, NOW), 404, /phone/);
});

async function confirmed(id, hoursAgo = 1) {
  models.Order.docs.push(mkOrder(id, 3));
  await svc.confirmAction(asha, id, 'confirm', {}, ago(hoursAgo));
}

test('Dispatch Desk: only confirmed orders appear, in Print Slip first', async () => {
  reset(); models.Order.docs.push(mkOrder(100, 2)); await confirmed(101);
  const d = await svc.dispatchDesk('print_slip', {}, NOW);
  assert.deepEqual(d.items.map((i) => i.orderId), [101]);
  assert.deepEqual(d.counts, { print_slip: 1, ready_for_pickup: 0, dispatched: 0, delayed: 0 });
});

test('NO PHOTO, NO PACKED: every missing piece blocks the status', async () => {
  reset(); await confirmed(111);
  await rejects(svc.pack(mina, 111, { awb: 'AWB1234567890', weight: '450', file: photo }, NOW), 409, /slip first/i);
  await svc.markSlipPrinted(mina, 111, NOW);
  await rejects(svc.markSlipPrinted(mina, 111, NOW), 409);
  await rejects(svc.pack(mina, 111, { awb: 'AWB1234567890', weight: '450' }, NOW), 400, /No photo, no Packed/);
  await rejects(svc.pack(mina, 111, { awb: 'AWB1234567890', weight: '450', file: { buffer: Buffer.from('MZ not an image at all') } }, NOW), 400, /not a photo/);
  await rejects(svc.pack(mina, 111, { awb: 'AWB1234567890', weight: '', file: photo }, NOW), 400, /weight/i);
  await rejects(svc.pack(mina, 111, { awb: 'x', weight: '450', file: photo }, NOW), 400, /AWB/);
  assert.equal(models.OrderFlow.docs[0].dispatchStage, 'print_slip');
  assert.equal(models.FlowProof.docs.length, 0);
  const r = await svc.pack(mina, 111, { awb: ' awb1234 567890\n', weight: '0.45', unit: 'kg', file: photo }, NOW);
  assert.equal(r.dispatchStage, 'ready_for_pickup'); assert.equal(r.weightG, 450); assert.equal(r.awb, 'AWB1234567890');
  const f = models.OrderFlow.docs[0];
  assert.equal(f.proofs, 1); assert.equal(f.packedByName, 'Mina');
  assert.equal(models.FlowProof.docs.length, 1);
  assert.equal(models.FlowProof.docs[0].sha256.length, 64);
  const ev = events(111).at(-1);
  assert.equal(ev.action, 'packed'); assert.equal(ev.previous, 'print_slip'); assert.equal(ev.next, 'ready_for_pickup'); assert.equal(ev.byName, 'Mina');
  await rejects(svc.pack(mina, 111, { awb: 'AWB1234567890', weight: '450', file: photo }, NOW), 409, /already at/);
});

test('AWB safety: must match Shipway for that order, and cannot be reused on another order', async () => {
  reset(); await confirmed(121); await confirmed(122);
  models.ShipwayShipment.docs.push({ orderId: 121, found: true, awb: 'SHIP0000111122' });
  await svc.markSlipPrinted(mina, 121, NOW); await svc.markSlipPrinted(mina, 122, NOW);
  await rejects(svc.pack(mina, 121, { awb: 'WRONG00001111', weight: '300', file: photo }, NOW), 422, /does not match/);
  await svc.pack(mina, 121, { awb: 'ship0000111122', weight: '300', file: photo }, NOW);
  await rejects(svc.pack(mina, 122, { awb: 'SHIP0000111122', weight: '300', file: photo }, NOW), 409, /already used on order #121/);
  assert.equal(models.FlowProof.docs.filter((p) => p.orderId === 122).length, 0); // no orphan photo
});

test('Ready for pickup to Dispatched, with on-time tracking against the 24 h plan', async () => {
  reset(); await confirmed(131, 30); await confirmed(132, 2);
  for (const id of [131, 132]) { await svc.markSlipPrinted(mina, id, NOW); await svc.pack(mina, id, { awb: `AWB${id}00000000`, weight: '500', file: photo }, NOW); }
  await rejects(svc.markDispatched(mina, 999, NOW), 409);
  const a = await svc.markDispatched(mina, 131, NOW);   // confirmed 30 h ago: late
  const b = await svc.markDispatched(mina, 132, NOW);   // confirmed 2 h ago: on time
  assert.equal(a.onTime, false); assert.equal(b.onTime, true);
  const d = await svc.dispatchDesk('dispatched', {}, NOW);
  assert.equal(d.items.length, 2); assert.equal(d.counts.dispatched, 2); assert.equal(d.counts.delayed, 0);
  await rejects(svc.markDispatched(mina, 131, NOW), 409);
});

test('Delayed Orders: confirmed more than 24 h ago and not dispatched; reason picked from a list', async () => {
  reset(); await confirmed(141, 26); await confirmed(142, 5); await confirmed(143, 40);
  await svc.markSlipPrinted(mina, 143, NOW); await svc.pack(mina, 143, { awb: 'AWB14300000000', weight: '500', file: photo }, NOW);
  const d = await svc.dispatchDesk('delayed', {}, NOW);
  assert.deepEqual(d.items.map((i) => i.orderId), [143, 141]); // oldest first, across Print Slip and Ready for Pickup
  assert.equal(d.counts.delayed, 2);
  assert.equal(d.items[0].delayed, true); assert.equal(Math.round(d.items[0].overdueMs / HOUR), 16);
  await rejects(svc.setDelayReason(mina, 141, 'whatever', NOW), 400);
  await svc.setDelayReason(mina, 141, 'awaiting_stock', NOW);
  assert.equal(models.OrderFlow.docs.find((f) => f.orderId === 141).delayReason, 'awaiting_stock');
  assert.equal(events(141).at(-1).action, 'delay_reason');
});

test('Cancelled orders never reach the Dispatch Desk', async () => {
  reset(); models.Order.docs.push(mkOrder(151, 2));
  await svc.confirmAction(asha, 151, 'cancel', { reason: 'fake_or_test' }, NOW);
  const d = await svc.dispatchDesk('print_slip', {}, NOW);
  assert.equal(d.items.length, 0);
});

test('timeline: full ordered history with who, when, previous and next status; proofs listed without file bytes', async () => {
  reset(); models.Order.docs.push(mkOrder(161, 3));
  await svc.contact(asha, 161, 'call', {}, ago(2.5));
  await svc.confirmAction(asha, 161, 'no_answer', {}, ago(2));
  await svc.confirmAction(ravi, 161, 'confirm', {}, ago(1));
  await svc.markSlipPrinted(mina, 161, ago(0.5));
  await svc.pack(mina, 161, { awb: 'AWB16100000000', weight: '620', file: photo }, ago(0.25));
  const t = await svc.timeline(161);
  assert.deepEqual(t.events.map((e) => e.action), ['call', 'no_answer', 'confirm', 'slip_printed', 'packed']);
  assert.deepEqual(t.events.map((e) => e.by), ['Asha', 'Asha', 'Ravi', 'Mina', 'Mina']);
  assert.equal(t.events[2].previous, 'no_answer'); assert.equal(t.events[2].next, 'confirmed');
  assert.equal(t.proofs.length, 1); assert.equal(t.proofs[0].weightG, 620); assert.ok(!('data' in t.proofs[0]));
  assert.ok(t.flow.planned);
  const untracked = await svc.timeline(999999);
  assert.equal(untracked.tracked, false); assert.deepEqual(untracked.events, []);
});

test('extra proof only after packing; video refused while switched off', async () => {
  reset(); await confirmed(171);
  await rejects(svc.addProof(mina, 171, photo, NOW), 409, /Pack the order first/);
  await svc.markSlipPrinted(mina, 171, NOW); await svc.pack(mina, 171, { awb: 'AWB17100000000', weight: '500', file: photo }, NOW);
  await svc.addProof(mina, 171, photo, NOW);
  assert.equal(models.OrderFlow.docs[0].proofs, 2);
  const mp4 = { buffer: Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(32)]) };
  await rejects(svc.addProof(mina, 171, mp4, NOW), 400, /Video/);
});

test('proof file lookup rejects malformed ids', async () => {
  await rejects(svc.proofFile('../etc/passwd'), 404);
  await rejects(svc.proofFile('0'.repeat(24)), 404);
});

test('overview: SLA %, per-person scorecards and open work', async () => {
  reset();
  models.Order.docs.push(mkOrder(201, 1), mkOrder(202, 5), mkOrder(203, 5));
  await svc.confirmAction(asha, 201, 'confirm', {}, ago(0.5));                    // 0.5 h after order: within 2 h
  await svc.confirmAction(ravi, 202, 'confirm', {}, ago(0.2));                    // 4.8 h: outside 4 h
  await svc.confirmAction(ravi, 203, 'cancel', { reason: 'ordered_by_mistake' }, ago(2));  // 3 h: amber
  await svc.markSlipPrinted(mina, 201, ago(0.4));
  await svc.pack(mina, 201, { awb: 'AWB20100000000', weight: '400', file: photo }, ago(0.3));
  await svc.markDispatched(mina, 201, ago(0.1));
  const o = await svc.overview(null, NOW);
  assert.equal(o.sla.confirm.timed, 3); assert.equal(o.sla.confirm.within2h.n, 1); assert.equal(o.sla.confirm.within4h.n, 2);
  const names = Object.fromEntries(o.confirmation.map((r) => [r.name, r]));
  assert.equal(names.Asha.confirmed, 1); assert.equal(names.Ravi.cancelled, 1); assert.equal(names.Ravi.confirmed, 1);
  assert.equal(o.packing[0].name, 'Mina'); assert.equal(o.packing[0].packed, 1); assert.equal(o.packing[0].withProof, 1);
  assert.equal(o.proofCoverage.v, 100);
  assert.equal(o.openWork.desk.print_slip, 1);
});
