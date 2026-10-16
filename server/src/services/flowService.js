// Confirm Queue + Dispatch Desk rules. Every state change here: (1) is checked against the current state so two people
// cannot both act on one order, (2) is stamped with the person, the time and the previous status, (3) is appended to FlowEvent.
const crypto = require('crypto');
const cfg = require('../config');
const { Order, ShopifyOrder, ShipwayShipment, OrderFlow, FlowEvent, FlowProof, Setting } = require('../models');
const F = require('../lib/flow');
const { parseYmd, fmtDate, DAY } = require('../lib/istTime');
const { finalStatus } = require('../lib/clean');

const httpErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const SYSTEM = { id: 'system', name: 'System', role: 'system' };

// ---------------- settings ----------------
const DEFAULT_CONFIG = { afterThree: 'cancel', startFrom: null, partialLinkUrl: '' };
async function getConfig() {
  const s = await Setting.findOne({ key: 'flow.config' }).lean();
  return { ...DEFAULT_CONFIG, ...((s && s.value) || {}) };
}
async function saveConfig(body = {}) {
  const cur = await getConfig();
  const next = { ...cur };
  if (body.afterThree !== undefined) {
    if (!['cancel', 'escalate'].includes(body.afterThree)) throw httpErr(400, 'After three no-answers must be "cancel" or "escalate"');
    next.afterThree = body.afterThree;
  }
  if (body.startFrom !== undefined) {
    if (body.startFrom && !parseYmd(body.startFrom)) throw httpErr(400, 'Start date must look like 2026-10-01');
    next.startFrom = body.startFrom || null;
  }
  if (body.partialLinkUrl !== undefined) {
    const u = String(body.partialLinkUrl || '').trim();
    if (u && !/^https:\/\/\S+$/i.test(u)) throw httpErr(400, 'The payment link must start with https://');
    next.partialLinkUrl = u;
  }
  await Setting.findOneAndUpdate({ key: 'flow.config' }, { key: 'flow.config', value: next }, { upsert: true });
  return next;
}
const queueStart = (conf, now) => (conf.startFrom ? parseYmd(conf.startFrom) : new Date(now.getTime() - 7 * DAY));

// ---------------- helpers ----------------
async function logEvent(who, orderId, e) {
  return FlowEvent.create({ orderId, at: e.at || new Date(), byId: who.id, byName: who.name, role: who.role, stage: e.stage, action: e.action, previous: e.previous || null, next: e.next || null, label: e.label, reasonKey: e.reasonKey || null, meta: e.meta || null });
}

async function loadOrder(orderId) {
  const o = await Order.findOne({ orderId, excluded: null }).lean();
  if (!o) throw httpErr(404, `Order #${orderId} was not found`);
  return o;
}

// Make sure the order has a flow record. Safe if two people open it at the same moment.
async function ensureFlow(order) {
  const set = { $setOnInsert: { orderId: order.orderId, orderAt: order.orderDate || null, confirmStatus: 'pending' } };
  try { return await OrderFlow.findOneAndUpdate({ orderId: order.orderId }, set, { upsert: true, new: true }).lean(); }
  catch (e) { if (e && e.code === 11000) return OrderFlow.findOne({ orderId: order.orderId }).lean(); throw e; }
}

// Compare-and-set: the update only applies if the record is still in the state this person saw.
async function guarded(orderId, expect, update) {
  const doc = await OrderFlow.findOneAndUpdate({ orderId, ...expect }, update, { new: true }).lean();
  if (!doc) throw httpErr(409, 'Someone else just updated this order. Refresh to see its latest status.');
  return doc;
}

const lastTen = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
async function phoneOf(order) {
  if (lastTen(order.phone)) return lastTen(order.phone);
  const s = await ShopifyOrder.findOne({ orderId: order.orderId }).select('customer.phone address.phone').lean();
  return s ? lastTen(s.customer && s.customer.phone) || lastTen(s.address && s.address.phone) : null;
}

// ---------------- Confirm Queue ----------------
async function confirmQueue(now = new Date()) {
  const conf = await getConfig();
  const start = queueStart(conf, now);
  const orders = await Order.find({ excluded: null, confirmed: 'Pending', orderId: { $ne: null }, orderDate: { $gte: start } })
    .select('orderId orderDate name amount paymentMode product').sort({ orderDate: 1 }).limit(500).lean();
  const ids = orders.map((o) => o.orderId);
  const [flows, shop] = await Promise.all([
    OrderFlow.find({ orderId: { $in: ids } }).lean(),
    ShopifyOrder.find({ orderId: { $in: ids } }).select('orderId itemsSummary address.city').lean(),
  ]);
  const fBy = new Map(flows.map((f) => [f.orderId, f]));
  const sBy = new Map(shop.map((s) => [s.orderId, s]));
  const items = [];
  for (const o of orders) {
    const f = fBy.get(o.orderId);
    if (f && ['confirmed', 'partial_pay', 'cancelled'].includes(f.confirmStatus)) continue; // decided here; the sheet copy catches up on its next sync
    const s = sBy.get(o.orderId);
    const attempts = (f && f.noAnswerAttempts) || 0;
    const nextAt = f && f.lastAttemptAt && attempts < F.MAX_ATTEMPTS ? new Date(new Date(f.lastAttemptAt).getTime() + F.MIN_ATTEMPT_GAP_MIN * 60000) : null;
    items.push({
      orderId: o.orderId, orderAt: o.orderDate, name: o.name, amount: o.amount, paymentMode: o.paymentMode,
      items: (s && s.itemsSummary) || o.product, city: s && s.address && s.address.city,
      band: F.slaBand(now.getTime() - new Date(o.orderDate).getTime()),
      attempts, lastAttemptAt: (f && f.lastAttemptAt) || null, nextAttemptAt: nextAt && nextAt > now ? nextAt : null,
      escalated: !!(f && f.escalated), partialLinkSentAt: (f && f.partialLinkSentAt) || null,
    });
  }
  const count = (b) => items.filter((i) => i.band === b).length;
  return {
    now, since: fmtDate(start), afterThree: conf.afterThree, partialLinkReady: !!conf.partialLinkUrl,
    counts: { total: items.length, green: count('green'), amber: count('amber'), red: count('red'), escalated: items.filter((i) => i.escalated).length },
    items,
    cancelReasons: F.CANCEL_REASONS, maxAttempts: F.MAX_ATTEMPTS,
  };
}

// The one entry point for the four one-tap actions.
async function confirmAction(user, orderId, action, body = {}, now = new Date()) {
  if (!F.CONFIRM_ACTIONS.includes(action)) throw httpErr(400, 'Unknown action');
  const order = await loadOrder(orderId);
  if (order.confirmed !== 'Pending') throw httpErr(409, `Order #${orderId} is already ${order.confirmed === 'Yes' ? 'confirmed' : 'cancelled'}. Refresh the queue.`);
  const flow = await ensureFlow(order);
  if (!F.canConfirmAct(flow)) throw httpErr(409, `Order #${orderId} is already ${flow.confirmStatus.replace('_', ' ')}.`);
  const prev = flow.confirmStatus || 'pending';
  const expect = { confirmStatus: { $in: ['pending', 'no_answer'] }, noAnswerAttempts: flow.noAnswerAttempts ? flow.noAnswerAttempts : { $in: [0, null] } };
  const decide = (status, extra = {}) => ({ $set: { confirmStatus: status, decidedAt: now, decidedById: user.id, decidedByName: user.name, escalated: false, orderAt: order.orderDate || flow.orderAt, ...extra } });
  let doc, ev;

  if (action === 'confirm') {
    doc = await guarded(orderId, expect, decide('confirmed', { confirmedAt: now, dispatchStage: 'print_slip' }));
    ev = { stage: 'confirm', action, previous: prev, next: 'confirmed', label: 'Confirmed' };
  } else if (action === 'partial_pay') {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw httpErr(400, 'Enter how much the customer paid');
    if (order.amount != null && amount > order.amount) throw httpErr(400, `Paid amount cannot be more than the order amount (Rs ${order.amount})`);
    doc = await guarded(orderId, expect, decide('partial_pay', { confirmedAt: now, dispatchStage: 'print_slip', partial: { amount, at: now, byId: user.id, byName: user.name } }));
    ev = { stage: 'confirm', action, previous: prev, next: 'partial_pay', label: `Converted to partial pay: Rs ${amount} paid`, meta: { amount, orderAmount: order.amount, previousMode: order.paymentMode } };
  } else if (action === 'cancel') {
    const reasonKey = String(body.reason || '');
    if (!F.CANCEL_REASON_KEYS.includes(reasonKey)) throw httpErr(400, 'Pick a cancellation reason');
    doc = await guarded(orderId, expect, decide('cancelled', { cancelReason: reasonKey }));
    ev = { stage: 'confirm', action, previous: prev, next: 'cancelled', reasonKey, label: `Cancelled: ${F.cancelReasonLabel(reasonKey)}` };
  } else { // no_answer
    if ((flow.noAnswerAttempts || 0) >= F.MAX_ATTEMPTS) throw httpErr(409, 'Three attempts are already logged. Confirm or cancel this order.');
    if (flow.lastAttemptAt && now - new Date(flow.lastAttemptAt) < F.MIN_ATTEMPT_GAP_MIN * 60000) {
      const wait = Math.ceil((F.MIN_ATTEMPT_GAP_MIN * 60000 - (now - new Date(flow.lastAttemptAt))) / 60000);
      throw httpErr(409, `Try the customer again in ${wait} min before logging another attempt.`);
    }
    const step = F.nextNoAnswer(flow.noAnswerAttempts, (await getConfig()).afterThree);
    if (step.outcome === 'cancel') {
      doc = await guarded(orderId, expect, decide('cancelled', { noAnswerAttempts: step.attempts, lastAttemptAt: now, cancelReason: 'no_answer_x3', decidedById: SYSTEM.id, decidedByName: SYSTEM.name }));
    } else {
      doc = await guarded(orderId, expect, { $set: { confirmStatus: 'no_answer', noAnswerAttempts: step.attempts, lastAttemptAt: now, escalated: step.outcome === 'escalate', orderAt: order.orderDate || flow.orderAt } });
    }
    ev = { stage: 'confirm', action: 'no_answer', previous: prev, next: 'no_answer', label: step.label, meta: { attempt: step.attempts, outcome: step.outcome } };
    await logEvent(user, orderId, { ...ev, at: now });
    if (step.outcome === 'cancel') await logEvent(SYSTEM, orderId, { stage: 'confirm', action: 'auto_cancel', previous: 'no_answer', next: 'cancelled', reasonKey: 'no_answer_x3', label: 'Auto-cancelled after 3 unanswered attempts', at: new Date(now.getTime() + 1) });
    if (step.outcome === 'escalate') await logEvent(SYSTEM, orderId, { stage: 'confirm', action: 'escalate', previous: 'no_answer', next: 'no_answer', label: 'Escalated to a lead after 3 unanswered attempts', at: new Date(now.getTime() + 1) });
    await overlayOrder(doc, order);
    return summary(doc, step.outcome);
  }
  await logEvent(user, orderId, { ...ev, at: now });
  await overlayOrder(doc, order);
  return summary(doc);
}
const summary = (f, outcome) => ({ orderId: f.orderId, confirmStatus: f.confirmStatus, noAnswerAttempts: f.noAnswerAttempts, escalated: !!f.escalated, dispatchStage: f.dispatchStage, outcome: outcome || null });

// Reflect the decision in the Order copy immediately (so Overview numbers move now, not at the next sync).
// The sheet sync applies the same overlay (see lib/flow.js applyFlowOverlay), so the two never disagree.
async function overlayOrder(flow, order) {
  const patches = F.overlayPatch(order, flow);
  if (!patches) return;
  const { set, log } = patches;
  await Order.updateMany({ orderId: flow.orderId, excluded: null, confirmed: 'Pending' }, { $set: set, $push: { log } });
}

// ---------------- Call / WhatsApp / partial payment link ----------------
async function contact(user, orderId, channel, body = {}, now = new Date()) {
  const order = await loadOrder(orderId);
  const phone = await phoneOf(order);
  if (!phone) throw httpErr(404, 'This order has no phone number in the sheet or in Shopify.');
  const first = String(order.name || '').trim().split(/\s+/)[0] || 'there';
  const wa = (text) => `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`;
  const flow = await ensureFlow(order);
  if (channel === 'call') {
    await logEvent(user, orderId, { stage: 'contact', action: 'call', previous: flow.confirmStatus, next: flow.confirmStatus, label: 'Called the customer', at: now });
    return { url: `tel:+91${phone}` };
  }
  if (channel === 'whatsapp') {
    await logEvent(user, orderId, { stage: 'contact', action: 'whatsapp', previous: flow.confirmStatus, next: flow.confirmStatus, label: 'Opened WhatsApp chat', at: now });
    return { url: wa(`Hi ${first}, this is MySoul about your order #${orderId}. Is now a good time to confirm your delivery details?`) };
  }
  if (channel === 'partial_link') {
    const conf = await getConfig();
    if (!conf.partialLinkUrl) throw httpErr(400, 'No payment link is set up yet. Ask an admin to add it under Settings, Team.');
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw httpErr(400, 'Enter the amount to ask for');
    if (order.amount != null && amount > order.amount) throw httpErr(400, `Amount cannot be more than the order amount (Rs ${order.amount})`);
    const link = conf.partialLinkUrl.replace(/\{orderId\}/g, orderId).replace(/\{amount\}/g, amount).replace(/\{amountPaise\}/g, Math.round(amount * 100)).replace(/\{phone\}/g, phone);
    await OrderFlow.updateOne({ orderId }, { $set: { partialLinkSentAt: now } });
    await logEvent(user, orderId, { stage: 'contact', action: 'partial_link', previous: flow.confirmStatus, next: flow.confirmStatus, label: `Sent partial payment link for Rs ${amount}`, meta: { amount }, at: now });
    return { url: wa(`Hi ${first}, to confirm your MySoul order #${orderId} please pay Rs ${amount} here: ${link}`) };
  }
  throw httpErr(400, 'Unknown contact channel');
}

// ---------------- Dispatch Desk ----------------
async function joinOrders(flows) {
  const ids = flows.map((f) => f.orderId);
  const [orders, shop, ship, proofs] = await Promise.all([
    Order.find({ orderId: { $in: ids }, excluded: null }).select('orderId name amount paymentMode product orderDate').lean(),
    ShopifyOrder.find({ orderId: { $in: ids } }).select('orderId itemsSummary address.city address.zip').lean(),
    ShipwayShipment.find({ orderId: { $in: ids }, found: true }).select('orderId awb carrier').lean(),
    FlowProof.find({ orderId: { $in: ids } }).select('orderId kind at size').sort({ at: 1 }).lean(),
  ]);
  const oBy = new Map(orders.map((o) => [o.orderId, o]));
  const sBy = new Map(shop.map((s) => [s.orderId, s]));
  const wBy = new Map(ship.map((s) => [s.orderId, s]));
  const pBy = new Map();
  for (const p of proofs) (pBy.get(p.orderId) || pBy.set(p.orderId, []).get(p.orderId)).push({ id: String(p._id), kind: p.kind, at: p.at });
  return flows.map((f) => {
    const o = oBy.get(f.orderId) || {}; const s = sBy.get(f.orderId); const w = wBy.get(f.orderId);
    return { ...f, name: o.name, amount: o.amount, paymentMode: f.partial ? 'Partial COD' : o.paymentMode, items: (s && s.itemsSummary) || o.product, city: s && s.address && s.address.city, shipwayAwb: w && w.awb, carrier: w && w.carrier, proofList: pBy.get(f.orderId) || [] };
  });
}

const decorate = (f, now) => { const t = F.dispatchTiming(f, now); return { ...f, planned: t.planned, delayed: t.delayed, overdueMs: t.overdueMs, onTime: t.onTime }; };

async function dispatchDesk(section, { days = 3 } = {}, now = new Date()) {
  const open = { confirmStatus: { $in: ['confirmed', 'partial_pay'] }, dispatchStage: { $in: ['print_slip', 'ready_for_pickup'] } };
  const cutoff = new Date(now.getTime() - F.PLANNED_HOURS * F.HOUR);
  const [c1, c2, c3, delayedCount] = await Promise.all([
    OrderFlow.countDocuments({ confirmStatus: { $in: ['confirmed', 'partial_pay'] }, dispatchStage: 'print_slip' }),
    OrderFlow.countDocuments({ confirmStatus: { $in: ['confirmed', 'partial_pay'] }, dispatchStage: 'ready_for_pickup' }),
    OrderFlow.countDocuments({ dispatchStage: 'dispatched', dispatchedAt: { $gte: new Date(now.getTime() - days * DAY) } }),
    OrderFlow.countDocuments({ ...open, confirmedAt: { $lt: cutoff } }),
  ]);
  let query, sort;
  if (section === 'delayed') { query = { ...open, confirmedAt: { $lt: cutoff } }; sort = { confirmedAt: 1 }; }
  else if (section === 'dispatched') { query = { dispatchStage: 'dispatched', dispatchedAt: { $gte: new Date(now.getTime() - days * DAY) } }; sort = { dispatchedAt: -1 }; }
  else if (['print_slip', 'ready_for_pickup'].includes(section)) { query = { confirmStatus: { $in: ['confirmed', 'partial_pay'] }, dispatchStage: section }; sort = { confirmedAt: 1 }; }
  else throw httpErr(400, 'Unknown section');
  const flows = await OrderFlow.find(query).sort(sort).limit(300).lean();
  const rows = (await joinOrders(flows)).map((f) => decorate(f, now));
  return {
    now, section, plannedHours: F.PLANNED_HOURS, delayReasons: F.DELAY_REASONS,
    counts: { print_slip: c1, ready_for_pickup: c2, dispatched: c3, delayed: delayedCount },
    items: rows.map(publicDispatchItem),
  };
}
const publicDispatchItem = (f) => ({
  orderId: f.orderId, name: f.name, amount: f.amount, paymentMode: f.paymentMode, items: f.items, city: f.city,
  confirmedAt: f.confirmedAt, planned: f.planned, delayed: f.delayed, overdueMs: f.overdueMs, onTime: f.onTime,
  dispatchStage: f.dispatchStage, slipPrintedAt: f.slipPrintedAt, slipPrintedByName: f.slipPrintedByName,
  awb: f.awb, shipwayAwb: f.shipwayAwb, carrier: f.carrier, weightG: f.weightG, partial: f.partial ? { amount: f.partial.amount } : null,
  packedAt: f.packedAt, packedByName: f.packedByName, readyAt: f.readyAt, dispatchedAt: f.dispatchedAt, dispatchedByName: f.dispatchedByName,
  delayReason: f.delayReason, proofs: f.proofList,
});

async function requireStage(orderId, stage) {
  const f = await OrderFlow.findOne({ orderId }).lean();
  if (!f || !['confirmed', 'partial_pay'].includes(f.confirmStatus)) throw httpErr(409, `Order #${orderId} has not been confirmed in the Confirm Queue yet.`);
  if (f.dispatchStage !== stage) throw httpErr(409, `Order #${orderId} is already at "${F.DISPATCH_LABEL[f.dispatchStage] || f.dispatchStage}". Refresh the desk.`);
  return f;
}

async function markSlipPrinted(user, orderId, now = new Date()) {
  await requireStage(orderId, 'print_slip');
  const doc = await guarded(orderId, { dispatchStage: 'print_slip', slipPrintedAt: null }, { $set: { slipPrintedAt: now, slipPrintedById: user.id, slipPrintedByName: user.name } });
  await logEvent(user, orderId, { stage: 'dispatch', action: 'slip_printed', previous: 'print_slip', next: 'print_slip', label: 'Slip printed', at: now });
  return { orderId, slipPrintedAt: doc.slipPrintedAt };
}

// "Packed" needs the AWB, the real weight AND a photo. All three are checked here, in one request, so the rule cannot be bypassed from the app.
async function pack(user, orderId, { awb, weight, unit, file }, now = new Date()) {
  const flow = await requireStage(orderId, 'print_slip');
  if (!flow.slipPrintedAt) throw httpErr(409, 'Print the slip first, then pack the order.');
  const awbN = F.normaliseAwb(awb);
  if (!awbN) throw httpErr(400, 'Scan or type the AWB (8 to 24 letters and digits).');
  const weightG = F.parseWeightGrams(weight, unit === 'kg' ? 'kg' : 'g');
  if (!weightG) throw httpErr(400, `Enter the weight from the scale (between ${F.WEIGHT_MIN_G} g and ${F.WEIGHT_MAX_G / 1000} kg).`);
  if (!file || !file.buffer || !file.buffer.length) throw httpErr(400, 'No photo, no Packed. Add a photo of the sealed box on the scale.');
  const kind = F.sniffMedia(file.buffer);
  if (kind !== 'photo') throw httpErr(400, 'That file is not a photo. Take a photo of the sealed box on the scale.');
  const sw = await ShipwayShipment.findOne({ orderId, found: true }).select('awb').lean();
  if (sw && sw.awb && F.normaliseAwb(sw.awb) && F.normaliseAwb(sw.awb) !== awbN) throw httpErr(422, `This AWB does not match the one Shipway holds for order #${orderId} (${sw.awb}). Check the slip on the box.`);
  const clash = await OrderFlow.findOne({ awb: awbN, orderId: { $ne: orderId } }).select('orderId').lean();
  if (clash) throw httpErr(409, `AWB ${awbN} is already used on order #${clash.orderId}.`);

  const proof = await FlowProof.create({ orderId, kind: 'photo', mime: F.mimeOf(file.buffer), size: file.buffer.length, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), data: file.buffer, awb: awbN, weightG, byId: user.id, byName: user.name, at: now });
  let doc;
  try {
    doc = await guarded(orderId, { dispatchStage: 'print_slip' }, {
      $set: { awb: awbN, weightG, packedAt: now, packedById: user.id, packedByName: user.name, readyAt: now, dispatchStage: 'ready_for_pickup' }, $inc: { proofs: 1 },
    });
  } catch (e) {
    await FlowProof.deleteOne({ _id: proof._id }).catch(() => {}); // do not keep a photo for a pack that did not happen
    if (e && e.code === 11000) throw httpErr(409, `AWB ${awbN} is already used on another order.`);
    throw e;
  }
  await logEvent(user, orderId, { stage: 'dispatch', action: 'packed', previous: 'print_slip', next: 'ready_for_pickup', label: `Packed: AWB ${awbN}, ${weightG} g, photo attached`, meta: { awb: awbN, weightG, proofId: String(proof._id), sizeBytes: proof.size }, at: now });
  return { orderId, dispatchStage: doc.dispatchStage, awb: awbN, weightG, proofId: String(proof._id) };
}

async function markDispatched(user, orderId, now = new Date()) {
  const f = await requireStage(orderId, 'ready_for_pickup');
  if (!f.proofs || f.proofs < 1) throw httpErr(409, 'This order has no proof photo, so it cannot be dispatched.'); // belt and braces
  const doc = await guarded(orderId, { dispatchStage: 'ready_for_pickup' }, { $set: { dispatchStage: 'dispatched', dispatchedAt: now, dispatchedById: user.id, dispatchedByName: user.name } });
  const t = F.dispatchTiming(doc, now);
  await logEvent(user, orderId, { stage: 'dispatch', action: 'dispatched', previous: 'ready_for_pickup', next: 'dispatched', label: t.onTime === false ? 'Dispatched (after the 24 h plan)' : 'Dispatched (within the 24 h plan)', meta: { onTime: t.onTime, awb: doc.awb }, at: now });
  return { orderId, dispatchStage: 'dispatched', onTime: t.onTime };
}

async function setDelayReason(user, orderId, reasonKey, now = new Date()) {
  if (!F.DELAY_REASON_KEYS.includes(reasonKey)) throw httpErr(400, 'Pick a delay reason');
  const f = await OrderFlow.findOne({ orderId }).lean();
  if (!f || !['print_slip', 'ready_for_pickup'].includes(f.dispatchStage)) throw httpErr(409, 'Only orders that are still waiting can carry a delay reason.');
  await OrderFlow.updateOne({ orderId }, { $set: { delayReason: reasonKey } });
  await logEvent(user, orderId, { stage: 'dispatch', action: 'delay_reason', previous: f.delayReason || null, next: reasonKey, reasonKey, label: `Delay reason: ${(F.DELAY_REASONS.find((r) => r[0] === reasonKey) || [])[1]}`, at: now });
  return { orderId, delayReason: reasonKey };
}

// Extra proof for an order that is already packed (a second photo now; video once it is switched on).
async function addProof(user, orderId, file, now = new Date()) {
  const f = await OrderFlow.findOne({ orderId }).lean();
  if (!f || !f.packedAt) throw httpErr(409, 'Pack the order first. Extra proof can be added after that.');
  const kind = F.sniffMedia(file && file.buffer);
  if (!kind) throw httpErr(400, 'That file is not a photo or video we can store.');
  if (kind === 'video' && !cfg.flow.videoEnabled) throw httpErr(400, 'Video upload is not switched on yet.');
  const proof = await FlowProof.create({ orderId, kind, mime: F.mimeOf(file.buffer), size: file.buffer.length, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), data: file.buffer, awb: f.awb, weightG: f.weightG, byId: user.id, byName: user.name, at: now });
  await OrderFlow.updateOne({ orderId }, { $inc: { proofs: 1 } });
  await logEvent(user, orderId, { stage: 'dispatch', action: 'proof_added', previous: f.dispatchStage, next: f.dispatchStage, label: `Added ${kind}`, meta: { proofId: String(proof._id) }, at: now });
  return { orderId, proofId: String(proof._id) };
}

// ---------------- Timeline + proof gallery for one order ----------------
async function timeline(orderId) {
  const [flow, events, proofs] = await Promise.all([
    OrderFlow.findOne({ orderId }).lean(),
    FlowEvent.find({ orderId }).sort({ at: 1, _id: 1 }).lean(),
    FlowProof.find({ orderId }).select('kind mime size at awb weightG byName sha256').sort({ at: 1 }).lean(),
  ]);
  return {
    orderId, tracked: !!flow,
    flow: flow ? { confirmStatus: flow.confirmStatus, dispatchStage: flow.dispatchStage, attempts: flow.noAnswerAttempts, escalated: !!flow.escalated, cancelReason: flow.cancelReason ? F.cancelReasonLabel(flow.cancelReason) : null, partial: flow.partial || null, confirmedAt: flow.confirmedAt, planned: F.plannedFor(flow.confirmedAt), awb: flow.awb, weightG: flow.weightG, delayReason: flow.delayReason } : null,
    events: events.map((e) => ({ at: e.at, by: e.byName, role: e.role, stage: e.stage, action: e.action, previous: e.previous, next: e.next, label: e.label, meta: e.meta })),
    proofs: proofs.map((p) => ({ id: String(p._id), kind: p.kind, size: p.size, at: p.at, awb: p.awb, weightG: p.weightG, by: p.byName, sha: p.sha256 && p.sha256.slice(0, 10) })),
  };
}
async function proofFile(id) {
  if (!/^[a-f0-9]{24}$/i.test(String(id))) throw httpErr(404, 'Proof not found');
  const p = await FlowProof.findById(id).lean();
  if (!p) throw httpErr(404, 'Proof not found');
  return p;
}

// ---------------- Overview feed: SLA %, scorecards, open work ----------------
async function overview(range, now = new Date()) {
  const q = range && range.start ? { orderAt: { $gte: range.start, $lt: range.end } } : {};
  const flows = await OrderFlow.find(q).lean();
  const ids = flows.map((f) => f.orderId);
  const events = ids.length ? await FlowEvent.find({ orderId: { $in: ids }, action: { $in: ['confirm', 'partial_pay', 'cancel', 'no_answer'] }, byId: { $ne: 'system' } }).select('orderId at byId byName action').lean() : [];
  const evBy = new Map();
  for (const e of events) (evBy.get(e.orderId) || evBy.set(e.orderId, []).get(e.orderId)).push(e);
  const withEv = flows.map((f) => ({ ...f, events: evBy.get(f.orderId) || [] }));
  const proofsDispatched = flows.filter((f) => f.dispatchStage === 'dispatched');
  const open = await dispatchDesk('print_slip', {}, now); // counts only
  const queue = await confirmQueue(now);
  return {
    sla: F.slaSummary(withEv),
    confirmation: F.confirmationScorecard(withEv),
    packing: F.packingScorecard(withEv, now),
    proofCoverage: F.pctOf(proofsDispatched.filter((f) => f.proofs > 0).length, proofsDispatched.length),
    tracked: flows.length,
    openWork: { queue: queue.counts, desk: open.counts },
  };
}

module.exports = {
  httpErr, SYSTEM, getConfig, saveConfig, confirmQueue, confirmAction, contact, dispatchDesk, markSlipPrinted, pack, markDispatched, setDelayReason,
  addProof, timeline, proofFile, overview, ensureFlow,
};
