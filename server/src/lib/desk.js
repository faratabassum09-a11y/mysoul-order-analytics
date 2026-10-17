// Shopify Desk rules: pure functions only (no database, no network), so every rule can be unit-tested.
// An order moves: confirm (FU1 -> FU2 -> FU3) -> pending (Day 1 -> Day 2 -> Day 3) -> auto-cancelled, or at any point
// to dispatch (confirmed / partial paid) or cancelled. The service (services/deskService.js) applies what this returns.
const { parseYmd } = require('./istTime');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const STAGES = ['confirm', 'pending', 'dispatch', 'dispatched', 'cancelled'];
const ACTIONS = ['dnp', 'confirm', 'cancel', 'partial_paid', 'dispatch', 'restore'];
const MAX_FU = 3;
const DUE_GRACE_MS = 60 * 1000; // a "No answer" tapped a few seconds before the timer hits zero is fine

const DEFAULT_CANCEL_REASONS = [
  'Customer not interested', 'Ordered by mistake', 'Wrong number / fake order', 'Duplicate order', 'Price / COD charges',
  'Address not serviceable', 'Found cheaper elsewhere', 'Delivery too slow', 'Other',
];
const DEFAULT_TEMPLATE = 'Hello {name}, this is MySoulSchool. We tried calling you about your order {order} ({items}) worth ₹{amount}. Please reply here to confirm your order, or tell us a good time to call. Thank you!';

const httpErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// ------------------------------------------------------------------------------------------------ settings
// confirmHours: FU1 is due this many hours after the order was placed; FU2 this many hours after FU1 was answered "DNP"; FU3 after FU2's DNP.
// pendingDays:  after FU3 is DNP the order moves to Pending; Day 1/2/3 follow-ups are due this many days after it moved there.
const DEFAULT_CONFIG = {
  startFrom: null, confirmHours: [0, 2, 4], pendingDays: [1, 2, 3],
  cancelReasons: DEFAULT_CANCEL_REASONS, requireScreenshot: true, whatsappTemplate: DEFAULT_TEMPLATE,
};

function normaliseConfig(body = {}, current = DEFAULT_CONFIG) {
  const next = { ...DEFAULT_CONFIG, ...current };
  const nums = (v, label, { min, max, ascending = false }) => {
    if (!Array.isArray(v) || v.length !== MAX_FU) throw httpErr(400, `${label}: enter three numbers`);
    const out = v.map(Number);
    out.forEach((n, i) => { if (!Number.isFinite(n) || n < min || n > max) throw httpErr(400, `${label} ${i + 1}: enter a number from ${min} to ${max}`); });
    if (ascending && !(out[0] < out[1] && out[1] < out[2])) throw httpErr(400, `${label}: each follow-up must come on a later day than the one before`);
    return out.map((n) => Math.round(n * 100) / 100);
  };
  if (body.confirmHours !== undefined) next.confirmHours = nums(body.confirmHours, 'Confirm follow-up hours', { min: 0, max: 720 });
  if (body.pendingDays !== undefined) next.pendingDays = nums(body.pendingDays, 'Pending follow-up days', { min: 0.04, max: 60, ascending: true });
  if (body.cancelReasons !== undefined) {
    const list = [...new Set((Array.isArray(body.cancelReasons) ? body.cancelReasons : []).map((s) => String(s).trim()).filter(Boolean))];
    if (!list.length || list.length > 30) throw httpErr(400, 'Keep between 1 and 30 cancellation reasons');
    if (list.some((s) => s.length > 60)) throw httpErr(400, 'A cancellation reason can be at most 60 characters');
    next.cancelReasons = list;
  }
  if (body.requireScreenshot !== undefined) next.requireScreenshot = !!body.requireScreenshot;
  if (body.whatsappTemplate !== undefined) {
    const t = String(body.whatsappTemplate).trim();
    if (!t || t.length > 1000) throw httpErr(400, 'The WhatsApp message must be between 1 and 1000 characters');
    next.whatsappTemplate = t;
  }
  if (body.startFrom !== undefined) {
    if (!parseYmd(body.startFrom)) throw httpErr(400, 'Start date must look like 2026-10-16');
    next.startFrom = body.startFrom;
  }
  return next;
}

// ------------------------------------------------------------------------------------------------ phone and WhatsApp
// Indian mobile numbers arrive as "+91 98765 43210", "09876543210", "9876543210" ...: keep the last 10 digits.
function tenDigits(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}
const dialNumber = (raw) => { const t = tenDigits(raw); return t ? `+91${t}` : null; };
function renderTemplate(tpl, v) {
  return String(tpl || '').replace(/\{(name|order|items|amount|balance)\}/g, (_, k) => (v[k] === undefined || v[k] === null ? '' : String(v[k])));
}
function waLink(raw, text) {
  const t = tenDigits(raw);
  return t ? `https://wa.me/91${t}?text=${encodeURIComponent(text || '')}` : null;
}
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';

// ------------------------------------------------------------------------------------------------ money
const rupees = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);
// What the courier still has to collect: nothing for a paid order, otherwise the total minus any partial payment.
function collectAmount(total, financialStatus, partial) {
  if (total == null) return null;
  if (/^paid$/i.test(financialStatus || '')) return 0;
  return rupees(Math.max(0, total - ((partial && partial.amount) || 0)));
}

// ------------------------------------------------------------------------------------------------ labels
const hasPartial = (d) => !!(d && d.partial && d.partial.amount > 0); // Mongoose returns {} for an unset nested object: test the amount, not the object
const fuLabel = (d) => (d.stage === 'confirm' ? `FU${d.fuNo}` : d.stage === 'pending' ? `Day ${d.fuNo}` : '');
const STAGE_LABEL = { confirm: 'Confirm queue', pending: 'Pending', dispatch: 'Dispatch queue', dispatched: 'Dispatched', cancelled: 'Cancelled' };
function statusLabel(d) {
  if (!d) return 'Not in queue';
  if (d.stage === 'confirm') return `Confirm · FU${d.fuNo}`;
  if (d.stage === 'pending') return `Pending · Day ${d.fuNo}`;
  if (d.stage === 'dispatch') return hasPartial(d) ? 'Partial paid · to dispatch' : 'Confirmed · to dispatch';
  if (d.stage === 'dispatched') return hasPartial(d) ? 'Partial paid · dispatched' : 'Dispatched';
  return 'Cancelled';
}

// ------------------------------------------------------------------------------------------------ first state of a new order
function initialState(order, config, now = new Date()) {
  const orderAt = order.createdAt ? new Date(order.createdAt) : now;
  if (order.cancelledAt) {
    return {
      orderId: order.orderId, orderAt, stage: 'cancelled', fuNo: 0, dueAt: null,
      cancel: { reason: 'Cancelled in Shopify', note: '', at: new Date(order.cancelledAt), byName: 'Shopify', auto: true, fromStage: 'confirm' },
      log: [{ at: now, by: 'Shopify', action: 'shopify_cancel', stage: 'confirm', fu: '', label: 'Order was cancelled in Shopify' }],
    };
  }
  return {
    orderId: order.orderId, orderAt, stage: 'confirm', fuNo: 1, dueAt: new Date(orderAt.getTime() + config.confirmHours[0] * HOUR),
    log: [{ at: now, by: 'System', action: 'enter_queue', stage: 'confirm', fu: 'FU1', label: 'Order entered the confirm queue (FU1)' }],
  };
}

// ------------------------------------------------------------------------------------------------ transitions
const isActive = (d) => d.stage === 'confirm' || d.stage === 'pending';

// Returns { set, entries } for one person's action, or throws an error with a plain-language message.
// doc: the current desk record. order: { total, orderId }. input: what the form sent. who: { id, name }.
function transition(doc, action, input = {}, config = DEFAULT_CONFIG, who = { id: 'system', name: 'System' }, order = {}, now = new Date()) {
  if (!ACTIONS.includes(action)) throw httpErr(400, 'Unknown action');
  const fu = fuLabel(doc);
  const base = { at: now, by: who.name, byId: who.id, stage: doc.stage, fu };
  const wrong = () => httpErr(409, `Order #${doc.orderId} is already ${STAGE_LABEL[doc.stage].toLowerCase()}. Refresh to see its latest status.`);

  if (action === 'dnp') {
    if (!isActive(doc)) throw wrong();
    const shared = input.whatsappShared;
    if (shared !== true && shared !== false && shared !== 'yes' && shared !== 'no') throw httpErr(400, 'Say whether the WhatsApp message was shared: Yes or No');
    const wa = shared === true || shared === 'yes';
    if (doc.dueAt && now.getTime() + DUE_GRACE_MS < new Date(doc.dueAt).getTime()) throw httpErr(409, `${fu} is not due yet. It opens at ${new Date(doc.dueAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })}.`);
    const entry = { ...base, action: 'dnp', whatsappShared: wa, label: `${fu}: did not pick up · WhatsApp ${wa ? 'shared' : 'not shared'}` };
    const bumped = { lastDnpAt: now, dnpCount: (doc.dnpCount || 0) + 1 };
    if (doc.stage === 'confirm' && doc.fuNo < MAX_FU) {
      const dueAt = new Date(now.getTime() + config.confirmHours[doc.fuNo] * HOUR); // FU2 uses confirmHours[1], FU3 uses [2]
      return { set: { ...bumped, fuNo: doc.fuNo + 1, dueAt }, entries: [entry] };
    }
    if (doc.stage === 'confirm') { // third DNP: out of the confirm queue
      const dueAt = new Date(now.getTime() + config.pendingDays[0] * DAY);
      return { set: { ...bumped, stage: 'pending', fuNo: 1, pendingSince: now, dueAt }, entries: [entry, { at: new Date(now.getTime() + 1), by: 'System', stage: 'pending', fu: 'Day 1', action: 'to_pending', label: 'No answer on FU1, FU2 and FU3: moved to Pending orders' }] };
    }
    if (doc.fuNo < MAX_FU) {
      const dueAt = new Date(new Date(doc.pendingSince || now).getTime() + config.pendingDays[doc.fuNo] * DAY);
      return { set: { ...bumped, fuNo: doc.fuNo + 1, dueAt }, entries: [entry] };
    }
    const reason = 'No response after 6 follow-ups (DNP)'; // pending Day 3 was also DNP: auto-cancel
    return {
      set: { ...bumped, stage: 'cancelled', dueAt: null, cancel: { reason, note: 'Auto-cancelled by the system after the Day 3 follow-up got no answer', at: now, byName: 'System', auto: true, fromStage: 'pending' } },
      entries: [entry, { at: new Date(now.getTime() + 1), by: 'System', stage: 'cancelled', fu: '', action: 'auto_cancel', label: `Auto-cancelled: ${reason}` }],
    };
  }

  if (action === 'confirm') {
    if (!isActive(doc)) throw wrong();
    return { set: { stage: 'dispatch', fuNo: 0, dueAt: null, confirmedAt: now, confirmedAtFu: fu, confirmedBy: who.name }, entries: [{ ...base, action: 'confirm', label: `Confirmed on ${fu}` }] };
  }

  if (action === 'partial_paid') {
    if (!isActive(doc)) throw wrong();
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw httpErr(400, 'Enter how much the customer has paid');
    if (order.total != null && amount >= order.total) throw httpErr(400, `That is the whole order amount (₹${order.total}). Use Confirmed instead of Partial paid.`);
    const notes = String(input.notes || '').trim().slice(0, 500);
    if (config.requireScreenshot && !input.screenshotId) throw httpErr(400, 'Attach the payment screenshot');
    const partial = { amount: rupees(amount), balance: order.total != null ? rupees(order.total - amount) : null, notes, screenshotId: input.screenshotId || null, at: now, byName: who.name, fromFu: fu };
    return {
      set: { stage: 'dispatch', fuNo: 0, dueAt: null, confirmedAt: now, confirmedAtFu: fu, confirmedBy: who.name, partial },
      entries: [{ ...base, action: 'partial_paid', amount: partial.amount, label: `Partial paid on ${fu}: ₹${partial.amount} received${partial.balance != null ? `, ₹${partial.balance} to collect` : ''}${notes ? ` · ${notes}` : ''}` }],
    };
  }

  if (action === 'cancel') {
    if (!(isActive(doc) || doc.stage === 'dispatch')) throw wrong();
    const reason = String(input.reason || '').trim();
    if (reason.length < 2) throw httpErr(400, 'Enter the reason for cancelling this order');
    if (reason.length > 120) throw httpErr(400, 'Keep the cancellation reason under 120 characters');
    const note = String(input.note || '').trim().slice(0, 500);
    return {
      set: { stage: 'cancelled', fuNo: 0, dueAt: null, cancel: { reason, note, at: now, byName: who.name, auto: false, fromStage: doc.stage } },
      entries: [{ ...base, action: 'cancel', reason, label: `Cancelled: ${reason}${note ? ` · ${note}` : ''}` }],
    };
  }

  if (action === 'dispatch') {
    if (doc.stage !== 'dispatch') throw wrong();
    const awb = String(input.awb || '').trim().slice(0, 60);
    const courier = String(input.courier || '').trim().slice(0, 60);
    const note = String(input.note || '').trim().slice(0, 300);
    return {
      set: { stage: 'dispatched', dispatch: { at: now, byName: who.name, awb, courier, note } },
      entries: [{ ...base, action: 'dispatch', label: `Dispatched${courier ? ` via ${courier}` : ''}${awb ? ` · AWB ${awb}` : ''}` }],
    };
  }

  // restore (admin only; the route enforces that): undo a cancellation and start the confirm queue again at FU1
  if (doc.stage !== 'cancelled') throw wrong();
  return {
    set: { stage: 'confirm', fuNo: 1, dueAt: now, cancel: null, partial: null, pendingSince: null, restoredAt: now },
    entries: [{ ...base, action: 'restore', stage: 'cancelled', label: 'Restored to the confirm queue (FU1)' }],
  };
}

// ------------------------------------------------------------------------------------------------ analytics
// rows: [{ desk, total }] for orders placed in the window. Returns every number the Overview tab shows.
function overviewStats(rows, now = new Date()) {
  const stageCount = { none: 0, confirm: 0, pending: 0, dispatch: 0, dispatched: 0, cancelled: 0 };
  const money = { all: 0, confirmed: 0, cancelled: 0, open: 0, collected: 0, balance: 0 };
  const byFu = {}; const ensure = (k) => (byFu[k] = byFu[k] || { fu: k, confirmed: 0, partial: 0, cancelled: 0, dnp: 0, whatsappYes: 0, whatsappNo: 0 });
  ['FU1', 'FU2', 'FU3', 'Day 1', 'Day 2', 'Day 3'].forEach(ensure);
  const reasons = new Map(); const agents = new Map(); let autoCancelled = 0; let manualCancelled = 0;
  let decided = 0; let decideMs = 0; let dueNow = 0; let overdue = 0; let confirmedNow = 0; let totalOrders = 0; let partialCount = 0;
  const agent = (n) => { if (!agents.has(n)) agents.set(n, { name: n, calls: 0, confirmed: 0, partial: 0, cancelled: 0, dnp: 0, dispatched: 0 }); return agents.get(n); };
  for (const { desk: d, total } of rows) {
    totalOrders++;
    const t = total || 0; money.all += t;
    if (!d) { stageCount.none++; continue; }
    stageCount[d.stage] = (stageCount[d.stage] || 0) + 1;
    if (d.stage === 'cancelled') { money.cancelled += t; const c = d.cancel || {}; if (c.auto) autoCancelled++; else manualCancelled++; const r = c.reason || 'No reason'; reasons.set(r, (reasons.get(r) || { reason: r, count: 0, value: 0 })); reasons.get(r).count++; reasons.get(r).value += t; }
    else if (d.stage === 'dispatch' || d.stage === 'dispatched') { money.confirmed += t; confirmedNow++; }
    else money.open += t;
    if (hasPartial(d)) { partialCount++; money.collected += d.partial.amount || 0; if (d.stage !== 'cancelled') money.balance += d.partial.balance || 0; }
    if (isActive(d) && d.dueAt) { const ms = new Date(d.dueAt).getTime() - now.getTime(); if (ms <= 0) { dueNow++; if (ms < -2 * HOUR) overdue++; } }
    let firstDecision = null;
    for (const e of d.log || []) {
      const slot = e.fu && byFu[e.fu];
      if (e.action === 'dnp' && slot) { slot.dnp++; if (e.whatsappShared) slot.whatsappYes++; else slot.whatsappNo++; }
      if (slot && e.action === 'confirm') slot.confirmed++;
      if (slot && e.action === 'partial_paid') slot.partial++;
      if (slot && e.action === 'cancel') slot.cancelled++;
      if (['confirm', 'partial_paid', 'cancel'].includes(e.action) && !firstDecision) firstDecision = e;
      if (e.by && e.by !== 'System' && e.by !== 'Shopify') {
        const a = agent(e.by);
        if (e.action === 'dnp') { a.dnp++; a.calls++; }
        else if (e.action === 'confirm') { a.confirmed++; a.calls++; }
        else if (e.action === 'partial_paid') { a.partial++; a.calls++; }
        else if (e.action === 'cancel') { a.cancelled++; a.calls++; }
        else if (e.action === 'dispatch') a.dispatched++;
      }
    }
    if (firstDecision && d.orderAt) { decided++; decideMs += Math.max(0, new Date(firstDecision.at).getTime() - new Date(d.orderAt).getTime()); }
  }
  const pct = (n, dn) => (dn ? (n / dn) * 100 : null);
  const handled = stageCount.dispatch + stageCount.dispatched + stageCount.cancelled; // orders with a final decision
  return {
    totalOrders, stageCount, money: Object.fromEntries(Object.entries(money).map(([k, v]) => [k, rupees(v)])),
    confirmRate: pct(stageCount.dispatch + stageCount.dispatched, totalOrders), cancelRate: pct(stageCount.cancelled, totalOrders),
    pendingRate: pct(stageCount.pending, totalOrders), partialCount,
    handled, autoCancelled, manualCancelled, dueNow, overdue,
    avgDecisionHours: decided ? decideMs / decided / HOUR : null,
    byFu: Object.values(byFu),
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count).map((r) => ({ ...r, value: rupees(r.value) })),
    agents: [...agents.values()].sort((a, b) => b.calls - a.calls),
    confirmedNow,
  };
}

module.exports = {
  HOUR, DAY, STAGES, ACTIONS, MAX_FU, DEFAULT_CONFIG, DEFAULT_CANCEL_REASONS, DEFAULT_TEMPLATE, STAGE_LABEL,
  httpErr, normaliseConfig, tenDigits, dialNumber, renderTemplate, waLink, firstName, rupees, collectAmount,
  fuLabel, hasPartial, statusLabel, initialState, transition, isActive, overviewStats,
};
