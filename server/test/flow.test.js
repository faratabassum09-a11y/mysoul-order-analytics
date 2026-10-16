const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/lib/flow');
const A = require('../src/lib/staffAuth');

const H = F.HOUR;
const T0 = new Date('2026-10-10T04:00:00Z');
const plus = (d, h) => new Date(d.getTime() + h * H);

test('SLA bands: green under 2 h, amber 2 to 4 h, red after 4 h', () => {
  assert.equal(F.slaBand(0), 'green');
  assert.equal(F.slaBand(1.99 * H), 'green');
  assert.equal(F.slaBand(2 * H), 'amber');
  assert.equal(F.slaBand(4 * H), 'amber');
  assert.equal(F.slaBand(4 * H + 1000), 'red');
  assert.equal(F.slaBand(30 * H), 'red');
});

test('No Answer ladder: attempts 1, 2 retry; attempt 3 cancels or escalates', () => {
  assert.deepEqual(F.nextNoAnswer(0).outcome, 'retry');
  assert.equal(F.nextNoAnswer(0).attempts, 1);
  assert.equal(F.nextNoAnswer(1).outcome, 'retry');
  assert.equal(F.nextNoAnswer(1).attempts, 2);
  assert.equal(F.nextNoAnswer(2).outcome, 'cancel');
  assert.equal(F.nextNoAnswer(2, 'escalate').outcome, 'escalate');
  assert.equal(F.nextNoAnswer(2, 'escalate').attempts, 3);
});

test('weight parsing: grams or kg, sane range only', () => {
  assert.equal(F.parseWeightGrams('450'), 450);
  assert.equal(F.parseWeightGrams('0.45', 'kg'), 450);
  assert.equal(F.parseWeightGrams('1,250'), 1250);
  assert.equal(F.parseWeightGrams('0'), null);
  assert.equal(F.parseWeightGrams('abc'), null);
  assert.equal(F.parseWeightGrams('5'), null);        // below 20 g
  assert.equal(F.parseWeightGrams('90000'), null);    // above 50 kg
  assert.equal(F.parseWeightGrams(''), null);
});

test('AWB normalising: scanners add whitespace and newlines', () => {
  assert.equal(F.normaliseAwb(' 14321a 99887766\n'), '14321A99887766');
  assert.equal(F.normaliseAwb('abc'), null);
  assert.equal(F.normaliseAwb(''), null);
  assert.equal(F.normaliseAwb('AB<script>12345'), null);
});

test('24 h plan: delayed only after planned time and never once dispatched', () => {
  const f = { confirmedAt: T0, dispatchStage: 'print_slip' };
  assert.equal(F.dispatchTiming(f, plus(T0, 23)).delayed, false);
  const late = F.dispatchTiming(f, plus(T0, 26));
  assert.equal(late.delayed, true);
  assert.equal(Math.round(late.overdueMs / H), 2);
  assert.equal(F.dispatchTiming({ ...f, dispatchStage: 'dispatched', dispatchedAt: plus(T0, 30) }, plus(T0, 50)).onTime, false);
  assert.equal(F.dispatchTiming({ ...f, dispatchStage: 'dispatched', dispatchedAt: plus(T0, 20) }, plus(T0, 50)).onTime, true);
  assert.equal(F.dispatchTiming({ ...f, dispatchStage: 'dispatched', dispatchedAt: plus(T0, 30) }, plus(T0, 50)).delayed, false);
  assert.equal(F.dispatchTiming({}, T0).planned, null);
});

test('duration formatting', () => {
  assert.equal(F.fmtDuration(5 * 60000), '5m');
  assert.equal(F.fmtDuration(125 * 60000), '2h 05m');
  assert.equal(F.fmtDuration(50 * H), '2d 2h');
});

test('media sniffing trusts bytes, not names', () => {
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
  const png = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n'), Buffer.alloc(20)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
  const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]);
  const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(8)]);
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(30)]);
  assert.equal(F.sniffMedia(jpg), 'photo'); assert.equal(F.mimeOf(jpg), 'image/jpeg');
  assert.equal(F.sniffMedia(png), 'photo'); assert.equal(F.sniffMedia(webp), 'photo');
  assert.equal(F.sniffMedia(mp4), 'video');
  assert.equal(F.sniffMedia(heic), null);
  assert.equal(F.sniffMedia(exe), null);
  assert.equal(F.sniffMedia(Buffer.alloc(3)), null);
});

test('overlay: only touches orders the sheet still shows as pending', () => {
  const base = { orderId: 1, confirmed: 'Pending', paymentMode: 'COD', deliveryStatus: '', rto: '', dispatchYes: false, excluded: null, log: [] };
  const orders = [{ ...base }, { ...base, orderId: 2 }, { ...base, orderId: 3, confirmed: 'Yes', finalStatus: 'Confirmed' }, { ...base, orderId: 4 }].map((o) => ({ ...o, log: [] }));
  const flows = [
    { orderId: 1, confirmStatus: 'confirmed', decidedByName: 'Asha', decidedAt: T0 },
    { orderId: 2, confirmStatus: 'cancelled', decidedByName: 'Ravi', decidedAt: T0, cancelReason: 'duplicate_order' },
    { orderId: 3, confirmStatus: 'cancelled', decidedByName: 'Ravi', decidedAt: T0 },
    { orderId: 4, confirmStatus: 'partial_pay', decidedByName: 'Asha', decidedAt: T0, partial: { amount: 300 } },
  ];
  assert.equal(F.applyFlowOverlay(orders, flows), 3);
  assert.equal(orders[0].confirmed, 'Yes'); assert.equal(orders[0].finalStatus, 'Confirmed');
  assert.equal(orders[1].confirmed, 'Cancel'); assert.equal(orders[1].finalStatus, 'Cancelled');
  assert.equal(orders[2].confirmed, 'Yes'); // sheet already decided: left alone
  assert.equal(orders[3].paymentMode, 'Partial COD');
  assert.match(orders[1].log[0], /Duplicate order/);
  assert.match(orders[0].log[0], /Asha/);
});

test('overlay keeps a dispatched order In Transit', () => {
  const o = { orderId: 1, confirmed: 'Pending', dispatchYes: true, deliveryStatus: '', rto: '', excluded: null, log: [] };
  F.applyFlowOverlay([o], [{ orderId: 1, confirmStatus: 'confirmed', decidedByName: 'A', decidedAt: T0 }]);
  assert.equal(o.finalStatus, 'In Transit');
});

test('confirmation scorecard: per person, SLA within 2 h, average time', () => {
  const mk = (id, h, who, action = 'confirm') => ({ orderId: id, orderAt: T0, events: [{ at: plus(T0, h), byId: who, byName: who, action }] });
  const rows = F.confirmationScorecard([mk(1, 1, 'asha'), mk(2, 3, 'asha'), mk(3, 5, 'asha', 'cancel'), mk(4, 1, 'ravi', 'no_answer')]);
  const asha = rows.find((r) => r.id === 'asha');
  assert.equal(asha.decisions, 3);
  assert.equal(asha.slaPct.n, 1); assert.equal(asha.slaPct.d, 3);
  assert.equal(asha.within4Pct.n, 2);
  assert.equal(Math.round(asha.avgMs / H), 3);
  const ravi = rows.find((r) => r.id === 'ravi');
  assert.equal(ravi.noAnswer, 1); assert.equal(ravi.decisions, 0); assert.equal(ravi.slaPct.v, null);
});

test('packing scorecard and SLA summary', () => {
  const flows = [
    { orderId: 1, orderAt: T0, decidedAt: plus(T0, 1), confirmStatus: 'confirmed', confirmedAt: plus(T0, 1), packedAt: plus(T0, 10), packedById: 'p1', packedByName: 'Mina', proofs: 1, dispatchStage: 'dispatched', dispatchedAt: plus(T0, 12) },
    { orderId: 2, orderAt: T0, decidedAt: plus(T0, 5), confirmStatus: 'confirmed', confirmedAt: plus(T0, 5), packedAt: plus(T0, 40), packedById: 'p1', packedByName: 'Mina', proofs: 1, dispatchStage: 'dispatched', dispatchedAt: plus(T0, 41) },
    { orderId: 3, orderAt: T0, decidedAt: plus(T0, 2), confirmStatus: 'confirmed', confirmedAt: new Date(Date.now() - 30 * H), dispatchStage: 'print_slip' },
  ];
  const pk = F.packingScorecard(flows)[0];
  assert.equal(pk.packed, 2); assert.equal(pk.onTime, 1); assert.equal(pk.withProof, 2);
  const s = F.slaSummary(flows);
  assert.equal(s.confirm.timed, 3); assert.equal(s.confirm.within2h.n, 2); // 1 h and 2 h; 5 h is red
  assert.equal(s.dispatch.onTime.n, 1); assert.equal(s.dispatch.onTime.d, 2);
  assert.equal(s.dispatch.openDelayed, 1);
});

// ---------------- auth ----------------
test('passwords: scrypt hash verifies, wrong one fails, junk hash fails safely', () => {
  const h = A.hashPassword('correct horse');
  assert.ok(A.verifyPassword('correct horse', h));
  assert.ok(!A.verifyPassword('wrong', h));
  assert.ok(!A.verifyPassword('x', 'scrypt$00$00'));
  assert.ok(!A.verifyPassword('x', ''));
  assert.notEqual(A.hashPassword('same'), A.hashPassword('same')); // salted
});

test('tokens: signed, tamper-proof, expire', () => {
  const now = 1_700_000_000_000;
  const t = A.signToken({ uid: 'u1', v: 0 }, 's3cret', now);
  assert.equal(A.verifyToken(t, 's3cret', now + 1000).uid, 'u1');
  assert.equal(A.verifyToken(t, 'other', now + 1000), null);
  assert.equal(A.verifyToken(t, 's3cret', now + A.TOKEN_TTL_MS + 1), null);
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 'admin', v: 0, exp: now + 1e9 })).toString('base64url');
  assert.equal(A.verifyToken(`${forged}.${sig}`, 's3cret', now), null);
  assert.equal(A.verifyToken('garbage', 's3cret', now), null);
  assert.equal(A.verifyToken(`${body}.`, 's3cret', now), null);
});

test('sign-in brake locks after 5 wrong tries and clears on success', () => {
  const l = A.makeLimiter(5, 1000);
  for (let i = 0; i < 5; i++) { assert.ok(!l.blocked('a', 0)); l.fail('a', 0); }
  assert.ok(l.blocked('a', 10));
  assert.ok(!l.blocked('a', 2000)); // window passed
  l.fail('b', 0); l.clear('b'); assert.ok(!l.blocked('b', 0));
});

test('username and password rules', () => {
  assert.ok(A.USERNAME_RE.test(A.normaliseUsername('  Asha.K ')));
  assert.ok(!A.USERNAME_RE.test('a b'));
  assert.ok(A.passwordProblem('short'));
  assert.equal(A.passwordProblem('longenough'), null);
});
