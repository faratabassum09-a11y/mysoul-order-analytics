// Dispatch queue rules: pure functions only (no database, no network), so every rule can be unit-tested.
// A confirmed order (DeskOrder.stage === 'dispatch') walks three steps, each with its own deadline:
//   slip      Packing slip done      -> due by <time> on a working day
//   packed    Order packed           -> form: AWB (filled from Shopify) + photo of the package
//   handover  Order handed to courier -> form: photo of the manifest; the order then leaves the queue (stage 'dispatched' = In-transit orders)
// The service (services/deskService.js) stores what these functions return.
const { istParts, istToDate, startOfDay, fmtDate, parseYmd, DAY } = require('./istTime');

const STEPS = ['slip', 'packed', 'handover'];
const STEP_LABEL = { slip: 'Packing slip', packed: 'Order packed', handover: 'Order handover' };
const MAX_HANDOVER_BATCH = 50;
const MAX_PHOTOS = 10; // photos per package, and per manifest

const httpErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// ------------------------------------------------------------------------------------------------ settings
// workingDays: 0 = Monday ... 6 = Sunday (same numbering as istParts().dow). holidays: 'YYYY-MM-DD' (IST).
// dayOffset: working days after the day the step starts. 0 = the same working day, unless the cut-off time has already passed: then the next working day.
// allowManualAwb: the AWB and courier come from Shipway by themselves. When Shipway has none for an order yet, true lets the person type the AWB so the box is not stuck;
// false makes them wait for Shipway.
const DEFAULT_DISPATCH_CONFIG = {
  workingDays: [0, 1, 2, 3, 4, 5],
  holidays: [],
  allowManualAwb: true,
  stages: {
    slip: { dueTime: '12:00', dayOffset: 0 },
    packed: { dueTime: '12:00', dayOffset: 0, requirePhoto: false },
    handover: { dueTime: '18:00', dayOffset: 0, requirePhoto: true },
  },
};

const TIME_RX = /^([01]\d|2[0-3]):([0-5]\d)$/;

function normaliseDispatchConfig(body = {}, current = DEFAULT_DISPATCH_CONFIG) {
  const base = { ...DEFAULT_DISPATCH_CONFIG, ...current, stages: { ...DEFAULT_DISPATCH_CONFIG.stages } };
  for (const k of STEPS) base.stages[k] = { ...DEFAULT_DISPATCH_CONFIG.stages[k], ...((current && current.stages && current.stages[k]) || {}) };
  const next = { workingDays: [...base.workingDays], holidays: [...base.holidays], allowManualAwb: base.allowManualAwb !== false, stages: base.stages };
  if (body.allowManualAwb !== undefined) next.allowManualAwb = !!body.allowManualAwb;

  if (body.workingDays !== undefined) {
    const days = [...new Set((Array.isArray(body.workingDays) ? body.workingDays : []).map(Number))];
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw httpErr(400, 'Choose at least one working day');
    next.workingDays = days.sort((a, b) => a - b);
  }
  if (body.holidays !== undefined) {
    const list = [...new Set((Array.isArray(body.holidays) ? body.holidays : []).map((s) => String(s).trim()).filter(Boolean))];
    const bad = list.find((s) => !parseYmd(s));
    if (bad) throw httpErr(400, `Holiday “${bad}” must look like 2026-11-08`);
    if (list.length > 200) throw httpErr(400, 'Keep the holiday list under 200 dates');
    next.holidays = list.sort();
  }
  if (body.stages !== undefined) {
    for (const k of STEPS) {
      const s = body.stages && body.stages[k];
      if (!s) continue;
      const cur = { ...next.stages[k] };
      if (s.dueTime !== undefined) {
        if (!TIME_RX.test(String(s.dueTime))) throw httpErr(400, `${STEP_LABEL[k]}: time must look like 12:00 (24-hour)`);
        cur.dueTime = String(s.dueTime);
      }
      if (s.dayOffset !== undefined) {
        const n = Number(s.dayOffset);
        if (!Number.isInteger(n) || n < 0 || n > 10) throw httpErr(400, `${STEP_LABEL[k]}: days must be a whole number from 0 to 10`);
        cur.dayOffset = n;
      }
      if (s.requirePhoto !== undefined && k !== 'slip') cur.requirePhoto = !!s.requirePhoto;
      next.stages[k] = cur;
    }
  }
  return next;
}

// ------------------------------------------------------------------------------------------------ working days and deadlines
const isWorkingDay = (date, conf) => conf.workingDays.includes(istParts(date).dow) && !conf.holidays.includes(fmtDate(date));

function nextWorkingDay(dayStart, conf) { // dayStart: IST midnight. Returns the first working day AFTER it.
  let d = new Date(dayStart.getTime() + DAY);
  for (let i = 0; i < 400 && !isWorkingDay(d, conf); i++) d = new Date(d.getTime() + DAY);
  return d;
}

// When is a step due, given when it started? Pure and deterministic: used for the card timer and for the on-time record.
function dueFor(startAt, stageConf, conf) {
  const start = new Date(startAt);
  const [hh, mm] = stageConf.dueTime.split(':').map(Number);
  const p = istParts(start);
  let day = startOfDay(start);
  let late = false;
  if (!isWorkingDay(day, conf)) {
    day = nextWorkingDay(day, conf); // a slip confirmed on Sunday is planned for Monday's cut-off, not for an already-past Sunday
  } else {
    late = p.h * 60 + p.mi >= hh * 60 + mm;
  }
  let remaining = stageConf.dayOffset === 0 && late ? 1 : stageConf.dayOffset;
  while (remaining > 0) { day = nextWorkingDay(day, conf); remaining--; }
  const dp = istParts(day);
  return istToDate(dp.y, dp.m, dp.d, hh, mm);
}

// ------------------------------------------------------------------------------------------------ where an order is
// Orders confirmed before this feature existed have no dq record: they simply start at the packing slip step.
const stepOf = (doc) => (doc && doc.stage === 'dispatch' ? (doc.dq && doc.dq.step) || 'slip' : null);
const stepStart = (doc) => (doc.dq && doc.dq.stepAt) || doc.confirmedAt || doc.orderAt || null;
// An order can be put on hold at any step. It keeps its step, but the deadline clock is paused (no due time, never overdue) until someone resumes it.
const isHeld = (doc) => !!(doc && doc.stage === 'dispatch' && doc.dq && doc.dq.hold && doc.dq.hold.at);
function dueAt(doc, conf) {
  if (isHeld(doc)) return null;
  const step = stepOf(doc); const from = step && stepStart(doc);
  return step && from ? dueFor(from, conf.stages[step], conf) : null;
}

const wrongStep = (doc, want) => {
  const at = stepOf(doc);
  if (isHeld(doc)) return httpErr(409, `Order #${doc.orderId} is on hold. Resume it first.`);
  return httpErr(409, at
    ? `Order #${doc.orderId} is at “${STEP_LABEL[at]}”, not “${STEP_LABEL[want]}”. Refresh to see its latest step.`
    : `Order #${doc.orderId} is no longer in the dispatch queue. Refresh to see its latest status.`);
};

// ------------------------------------------------------------------------------------------------ transitions
// Each returns { set, entries } like lib/desk.js transition(), or throws an error with a plain-language message.
const base = (doc, who, now) => ({ at: now, by: who.name, byId: who.id, stage: 'dispatch', fu: '' });
const timing = (doc, conf, now) => { const due = dueAt(doc, conf); return { dueAt: due, late: !!due && now.getTime() > due.getTime() }; };

function slipDone(doc, conf, who = { id: 'system', name: 'System' }, now = new Date()) {
  if (stepOf(doc) !== 'slip' || isHeld(doc)) throw wrongStep(doc, 'slip');
  const t = timing(doc, conf, now);
  const dq = { ...(doc.dq || {}), step: 'packed', stepAt: now, slip: { at: now, byName: who.name, byId: who.id, ...t } };
  return { set: { dq }, entries: [{ ...base(doc, who, now), action: 'slip_done', label: `Packing slip done${t.late ? ' (late)' : ''}` }] };
}

// "Letters, digits and - _ /" only, 5 to 40 long. Upper-cased so the same AWB typed twice always matches.
function cleanAwb(raw) {
  const s = String(raw || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9\-_/]{5,40}$/.test(s)) throw httpErr(400, 'Enter the AWB number: letters and numbers, 5 to 40 characters');
  return s;
}

// One photo (photoId / manifestId) or several (photoIds / manifestIds): the first one is kept in photoId / manifestId too, so older screens still find it.
const idsOf = (many, one) => [...new Set((Array.isArray(many) && many.length ? many : one ? [one] : []).map(String).filter(Boolean))];

// input: { awb, courier, photoIds } (photoId still works for one photo)
function packedDone(doc, input = {}, conf, who = { id: 'system', name: 'System' }, now = new Date()) {
  if (stepOf(doc) !== 'packed' || isHeld(doc)) throw wrongStep(doc, 'packed');
  const awb = cleanAwb(input.awb);
  const photoIds = idsOf(input.photoIds, input.photoId);
  if (photoIds.length > MAX_PHOTOS) throw httpErr(400, `Add at most ${MAX_PHOTOS} photos`);
  // Order packed needs only the AWB: no package photo is required (photos are still accepted if sent).
  const courier = String(input.courier || '').trim().slice(0, 60);
  const t = timing(doc, conf, now);
  const dq = { ...(doc.dq || {}), step: 'handover', stepAt: now, packed: { at: now, byName: who.name, byId: who.id, awb, courier, photoId: photoIds[0] || null, photoIds, ...t } };
  return { set: { dq }, entries: [{ ...base(doc, who, now), action: 'packed', label: `Order packed · AWB ${awb}${t.late ? ' (late)' : ''}` }] };
}

// input: { manifestIds, courier } (manifestId still works for one photo). The order leaves the queue and becomes an In-transit order.
function handoverDone(doc, input = {}, conf, who = { id: 'system', name: 'System' }, now = new Date()) {
  if (stepOf(doc) !== 'handover' || isHeld(doc)) throw wrongStep(doc, 'handover');
  const manifestIds = idsOf(input.manifestIds, input.manifestId);
  if (manifestIds.length > MAX_PHOTOS) throw httpErr(400, `Add at most ${MAX_PHOTOS} photos`);
  if (conf.stages.handover.requirePhoto && !manifestIds.length) throw httpErr(400, 'Add at least one photo of the manifest first');
  const packed = (doc.dq && doc.dq.packed) || {};
  const courier = String(input.courier || packed.courier || '').trim().slice(0, 60);
  const t = timing(doc, conf, now);
  const dq = { ...(doc.dq || {}), step: 'done', stepAt: now, handover: { at: now, byName: who.name, byId: who.id, manifestId: manifestIds[0] || null, manifestIds, ...t } };
  return {
    set: { stage: 'dispatched', dq, dispatch: { at: now, byName: who.name, awb: packed.awb || '', courier, note: '' } },
    // action "dispatch" on purpose: the Overview's per-person "dispatched" count reads it
    entries: [{ ...base(doc, who, now), action: 'dispatch', label: `Handed over to courier${courier ? ` (${courier})` : ''}${packed.awb ? ` · AWB ${packed.awb}` : ''}${t.late ? ' (late)' : ''}` }],
  };
}

// ------------------------------------------------------------------------------------------------ hold and cancel
// Both need a note, so the next person can see why. Hold: { note }. Resume: { note } optional. Cancel goes through lib/desk.js transition('cancel'); cancelWithNote adds the "note is required" rule.
const MAX_NOTE = 300;
function cleanNote(raw, { required = true, label = 'note' } = {}) {
  const n = String(raw || '').trim().replace(/\s+/g, ' ');
  if (required && n.length < 3) throw httpErr(400, `Write a short ${label} first (at least 3 characters)`);
  if (n.length > MAX_NOTE) throw httpErr(400, `Keep the ${label} under ${MAX_NOTE} characters`);
  return n;
}

function holdOrder(doc, input = {}, who = { id: 'system', name: 'System' }, now = new Date()) {
  if (!stepOf(doc)) throw wrongStep(doc, 'slip');
  if (isHeld(doc)) throw httpErr(409, `Order #${doc.orderId} is already on hold.`);
  const note = cleanNote(input.note, { label: 'note saying why the order is on hold' });
  const step = stepOf(doc);
  const dq = { ...(doc.dq || {}), step, hold: { at: now, byName: who.name, byId: who.id, note, step } };
  return { set: { dq }, entries: [{ ...base(doc, who, now), action: 'hold', label: `Put on hold at “${STEP_LABEL[step]}” · ${note}` }] };
}

// The deadline restarts from the moment of resuming, so the time spent on hold never counts against the packing team.
function resumeOrder(doc, input = {}, who = { id: 'system', name: 'System' }, now = new Date()) {
  if (!isHeld(doc)) throw httpErr(409, `Order #${doc.orderId} is not on hold. Refresh to see its latest status.`);
  const note = cleanNote(input.note, { required: false, label: 'note' });
  const step = stepOf(doc);
  const dq = { ...(doc.dq || {}), step, stepAt: now, hold: null };
  return { set: { dq }, entries: [{ ...base(doc, who, now), action: 'resume', label: `Resumed at “${STEP_LABEL[step]}”${note ? ` · ${note}` : ''}` }] };
}

// ------------------------------------------------------------------------------------------------ numbers for the tab bar and the board
// docs: DeskOrder rows in stage 'dispatch'. Returns { slip, packed, handover, overdue, overdueBy: {slip, packed, handover} }
function stepCounts(docs, conf, now = new Date()) {
  const out = { slip: 0, packed: 0, handover: 0, hold: 0, overdue: 0, overdueBy: { slip: 0, packed: 0, handover: 0 } };
  for (const d of docs) {
    const step = stepOf(d); if (!step) continue;
    if (isHeld(d)) { out.hold++; continue; } // on hold: not in a column, never overdue
    out[step]++;
    const due = dueAt(d, conf);
    if (due && due.getTime() < now.getTime()) { out.overdue++; out.overdueBy[step]++; }
  }
  return out;
}

// "12:00" -> "12:00 PM"
const timeLabel = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

module.exports = {
  STEPS, STEP_LABEL, MAX_HANDOVER_BATCH, MAX_PHOTOS, DEFAULT_DISPATCH_CONFIG, httpErr, idsOf,
  normaliseDispatchConfig, isWorkingDay, nextWorkingDay, dueFor, stepOf, stepStart, dueAt,
  slipDone, packedDone, handoverDone, holdOrder, resumeOrder, cleanNote, isHeld, cleanAwb, stepCounts, timeLabel,
};
