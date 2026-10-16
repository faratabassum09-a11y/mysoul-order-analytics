// Pure workflow rules for the Confirm Queue and Dispatch Desk. No DB, no network, fully tested.
const { finalStatus } = require('./clean');
const { fmtDateTime } = require('./istTime');
const HOUR = 3600 * 1000;

// ---- Confirm Queue SLA: green under 2 h, amber 2-4 h, red after 4 h (measured from the order time) ----
const SLA_GREEN_H = 2;
const SLA_AMBER_H = 4;
function slaBand(ageMs) {
  const h = ageMs / HOUR;
  if (h < SLA_GREEN_H) return 'green';
  if (h <= SLA_AMBER_H) return 'amber';
  return 'red';
}

// ---- Statuses ----
// confirm stage:  pending -> confirmed | partial_pay | cancelled ; no_answer keeps the order in the queue
// dispatch stage: print_slip -> ready_for_pickup -> dispatched   (an order enters print_slip when confirmed)
const CONFIRM_STATUS = { PENDING: 'pending', CONFIRMED: 'confirmed', PARTIAL: 'partial_pay', CANCELLED: 'cancelled', NO_ANSWER: 'no_answer' };
const DISPATCH_STAGES = ['print_slip', 'ready_for_pickup', 'dispatched'];
const DISPATCH_LABEL = { print_slip: 'Print slip', ready_for_pickup: 'Ready for pickup', dispatched: 'Dispatched' };
const PLANNED_HOURS = 24; // every dispatch section is planned for 24 h after confirmation

// ---- No Answer ladder (same as the FMS): attempt 1, 2, 3, then the configured outcome ----
const MAX_ATTEMPTS = 3;
// A person may not log the next attempt immediately: gap in minutes between attempts (stops three taps in a row).
const MIN_ATTEMPT_GAP_MIN = 30;
function nextNoAnswer(attempts, afterThree = 'cancel') {
  const n = (attempts || 0) + 1;
  if (n < MAX_ATTEMPTS) return { attempts: n, outcome: 'retry', label: `No answer, attempt ${n} of ${MAX_ATTEMPTS}` };
  return afterThree === 'escalate'
    ? { attempts: n, outcome: 'escalate', label: `No answer, attempt ${n} of ${MAX_ATTEMPTS}: escalated` }
    : { attempts: n, outcome: 'cancel', label: `No answer, attempt ${n} of ${MAX_ATTEMPTS}: auto-cancelled` };
}

// ---- Fixed choices: there is no free typing anywhere in the flow ----
const CANCEL_REASONS = [
  ['customer_changed_mind', 'Customer changed mind'],
  ['ordered_by_mistake', 'Ordered by mistake'],
  ['duplicate_order', 'Duplicate order'],
  ['wrong_address_or_pincode', 'Wrong address / pincode'],
  ['not_serviceable', 'Pincode not serviceable'],
  ['price_or_shipping_issue', 'Price / shipping charge issue'],
  ['found_cheaper_elsewhere', 'Found cheaper elsewhere'],
  ['delivery_too_slow', 'Delivery time too long'],
  ['wont_pay_partial', 'Will not pay advance'],
  ['fake_or_test', 'Fake / test order'],
  ['out_of_stock', 'Out of stock'],
  ['no_answer_x3', 'No answer after 3 attempts'],
];
const CANCEL_REASON_KEYS = CANCEL_REASONS.map((r) => r[0]);
const cancelReasonLabel = (k) => (CANCEL_REASONS.find((r) => r[0] === k) || [k, k])[1];

// Why a packed order is held / a delay is explained (optional dropdown on the Delayed list)
const DELAY_REASONS = [
  ['awaiting_stock', 'Waiting for stock'],
  ['awaiting_partial_payment', 'Waiting for partial payment'],
  ['address_clarification', 'Address needs clarification'],
  ['courier_not_available', 'Courier not available'],
  ['packing_backlog', 'Packing backlog'],
  ['other_ops', 'Other (ops)'],
];
const DELAY_REASON_KEYS = DELAY_REASONS.map((r) => r[0]);

// Weight sanity: grams. Packing enters the real weight of the sealed box on the scale.
const WEIGHT_MIN_G = 20;
const WEIGHT_MAX_G = 50000;
function parseWeightGrams(v, unit = 'g') {
  const n = Number(String(v == null ? '' : v).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const g = unit === 'kg' ? n * 1000 : n;
  const r = Math.round(g);
  return r >= WEIGHT_MIN_G && r <= WEIGHT_MAX_G ? r : null;
}

// AWB: courier AWBs are 8-20 letters/digits. Scanners add stray whitespace/newlines, so normalise first.
function normaliseAwb(v) {
  const s = String(v == null ? '' : v).replace(/[\s\u0000-\u001f]/g, '').toUpperCase();
  return /^[A-Z0-9-]{8,24}$/.test(s) ? s : null;
}

// ---- Planned times ----
const plannedFor = (confirmedAt) => (confirmedAt ? new Date(new Date(confirmedAt).getTime() + PLANNED_HOURS * HOUR) : null);

// An order is "delayed" in a dispatch section when its planned time has passed and it has not moved on.
// Dispatched orders are never delayed. dispatchedAt <= planned counts as on time.
function dispatchTiming(flow, now = new Date()) {
  if (!flow || !flow.confirmedAt) return { planned: null, delayed: false, overdueMs: 0, onTime: null };
  const planned = plannedFor(flow.confirmedAt);
  if (flow.dispatchStage === 'dispatched') {
    const at = flow.dispatchedAt ? new Date(flow.dispatchedAt) : null;
    return { planned, delayed: false, overdueMs: 0, onTime: at ? at <= planned : null };
  }
  const overdueMs = Math.max(0, now.getTime() - planned.getTime());
  return { planned, delayed: overdueMs > 0, overdueMs, onTime: null };
}

const fmtDuration = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};

// ---- Allowed transitions (the server refuses anything else) ----
const CONFIRM_ACTIONS = ['confirm', 'partial_pay', 'cancel', 'no_answer'];
function canConfirmAct(flow) {
  // Only an order still waiting for a decision can be acted on from the queue
  return !flow || flow.confirmStatus === 'pending' || flow.confirmStatus === 'no_answer' || flow.confirmStatus == null;
}
const NEXT_STAGE = { print_slip: 'ready_for_pickup', ready_for_pickup: 'dispatched' };

// ---- Scorecard maths (per person) ----
// events: [{ at, byId, byName, action, previous, next, meta }]; flows: [{ orderId, orderAt, confirmedAt, confirmedById, packedAt, packedById, dispatchedAt, ... }]
function pctOf(n, d) { return { v: d > 0 ? (n / d) * 100 : null, n, d }; }

function confirmationScorecard(flows) {
  const by = new Map();
  const get = (id, name) => by.get(id) || by.set(id, { id, name, actions: 0, confirmed: 0, partial: 0, cancelled: 0, noAnswer: 0, within2h: 0, within4h: 0, timed: 0, totalMs: 0 }).get(id);
  for (const f of flows) {
    for (const e of f.events || []) {
      if (!['confirm', 'partial_pay', 'cancel', 'no_answer'].includes(e.action)) continue;
      const p = get(e.byId, e.byName);
      p.actions++;
      if (e.action === 'confirm') p.confirmed++;
      else if (e.action === 'partial_pay') p.partial++;
      else if (e.action === 'cancel') p.cancelled++;
      else p.noAnswer++;
      if (['confirm', 'partial_pay', 'cancel'].includes(e.action) && f.orderAt) { // a decision: time from order to decision
        const ms = new Date(e.at).getTime() - new Date(f.orderAt).getTime();
        if (ms >= 0) { p.timed++; p.totalMs += ms; if (ms <= SLA_GREEN_H * HOUR) p.within2h++; if (ms <= SLA_AMBER_H * HOUR) p.within4h++; }
      }
    }
  }
  return [...by.values()].map((p) => ({
    ...p, decisions: p.confirmed + p.partial + p.cancelled,
    slaPct: pctOf(p.within2h, p.timed), within4Pct: pctOf(p.within4h, p.timed),
    avgMs: p.timed ? p.totalMs / p.timed : null,
  })).sort((a, b) => b.actions - a.actions);
}

function packingScorecard(flows, now = new Date()) {
  const by = new Map();
  const get = (id, name) => by.get(id) || by.set(id, { id, name, packed: 0, onTime: 0, timed: 0, withProof: 0 }).get(id);
  for (const f of flows) {
    if (!f.packedById || !f.packedAt) continue;
    const p = get(f.packedById, f.packedByName);
    p.packed++;
    if ((f.proofs || 0) > 0) p.withProof++;
    if (f.confirmedAt) { p.timed++; if (new Date(f.packedAt) <= plannedFor(f.confirmedAt)) p.onTime++; }
  }
  return [...by.values()].map((p) => ({ ...p, onTimePct: pctOf(p.onTime, p.timed) })).sort((a, b) => b.packed - a.packed);
}

// Overall SLA: share of decisions made within 2 h (green) and within 4 h, plus 24 h packing plan adherence.
function slaSummary(flows) {
  let timed = 0, g = 0, a = 0, dispTimed = 0, dispOnTime = 0, openDelayed = 0, confirmedOpen = 0;
  const now = new Date();
  for (const f of flows) {
    if (f.decidedAt && f.orderAt) {
      const ms = new Date(f.decidedAt).getTime() - new Date(f.orderAt).getTime();
      if (ms >= 0) { timed++; if (ms <= SLA_GREEN_H * HOUR) g++; if (ms <= SLA_AMBER_H * HOUR) a++; }
    }
    if (f.confirmedAt && f.confirmStatus !== 'cancelled') {
      const t = dispatchTiming(f, now);
      if (f.dispatchStage === 'dispatched') { dispTimed++; if (t.onTime) dispOnTime++; }
      else { confirmedOpen++; if (t.delayed) openDelayed++; }
    }
  }
  return { confirm: { timed, within2h: pctOf(g, timed), within4h: pctOf(a, timed) }, dispatch: { onTime: pctOf(dispOnTime, dispTimed), openDelayed, confirmedOpen } };
}


// ---- Proof files: trust the bytes, not the file name or the browser's claim ----
function sniffMedia(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'photo'; // JPEG
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'photo';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'photo';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && !/^(heic|heix|mif1|avif)/.test(buf.toString('latin1', 8, 12))) return 'video'; // MP4 / MOV
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video'; // WebM
  return null;
}
function mimeOf(buf) {
  if (buf[0] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF') return 'image/webp';
  if (buf[0] === 0x1a) return 'video/webm';
  return 'video/mp4';
}

// ---- Overlay: what the team decided in the Confirm Queue is shown on the Order copy ----
// The Google Sheet is never written to, so without this the sheet would still say "blank" for orders the team already handled.
// Applied right after an action AND on every sheet sync (the sync rewrites Order rows). Only ever touches orders the sheet still shows as pending.
function overlayPatch(order, flow) {
  if (!flow || order.confirmed !== 'Pending') return null;
  const who = `${flow.decidedByName || 'team'} on ${flow.decidedAt ? fmtDateTime(flow.decidedAt) : 'an earlier date'}`;
  if (flow.confirmStatus === 'confirmed' || flow.confirmStatus === 'partial_pay') {
    const set = { confirmed: 'Yes' };
    if (flow.confirmStatus === 'partial_pay') set.paymentMode = 'Partial COD';
    set.finalStatus = finalStatus({ ...order, ...set });
    return { set, log: `Confirm Queue: ${flow.confirmStatus === 'partial_pay' ? `converted to partial pay (Rs ${flow.partial && flow.partial.amount} paid)` : 'confirmed'} by ${who}` };
  }
  if (flow.confirmStatus === 'cancelled') {
    const set = { confirmed: 'Cancel' };
    set.finalStatus = finalStatus({ ...order, ...set });
    return { set, log: `Confirm Queue: cancelled by ${who}${flow.cancelReason ? ` (${cancelReasonLabel(flow.cancelReason)})` : ''}` };
  }
  return null;
}
function applyFlowOverlay(orders, flows) {
  const by = new Map(flows.map((f) => [f.orderId, f]));
  let n = 0;
  for (const o of orders) {
    if (o.excluded || o.orderId == null) continue;
    const patch = overlayPatch(o, by.get(o.orderId));
    if (!patch) continue;
    Object.assign(o, patch.set); o.log.push(patch.log); n++;
  }
  return n;
}

module.exports = {
  pctOf, sniffMedia, mimeOf, overlayPatch, applyFlowOverlay, WEIGHT_MIN_G, WEIGHT_MAX_G,
  HOUR, SLA_GREEN_H, SLA_AMBER_H, slaBand, CONFIRM_STATUS, DISPATCH_STAGES, DISPATCH_LABEL, PLANNED_HOURS, NEXT_STAGE,
  MAX_ATTEMPTS, MIN_ATTEMPT_GAP_MIN, nextNoAnswer, CANCEL_REASONS, CANCEL_REASON_KEYS, cancelReasonLabel, DELAY_REASONS, DELAY_REASON_KEYS,
  parseWeightGrams, normaliseAwb, plannedFor, dispatchTiming, fmtDuration, CONFIRM_ACTIONS, canConfirmAct,
  confirmationScorecard, packingScorecard, slaSummary,
};
