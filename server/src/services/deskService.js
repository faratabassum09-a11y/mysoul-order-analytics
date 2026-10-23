// Shopify Desk: reads orders from Shopify only, keeps one DeskOrder per order, and applies the rules in lib/desk.js.
// Every change is checked against the state the person saw (rev), stamped with who did it, and appended to the order's log.
const crypto = require('crypto');
const { DeskOrder, DeskShot, DispatchProof, ShopifyOrder, ShipwayShipment, Setting, StaffUser } = require('../models');
const D = require('../lib/desk');
const FN = require('../lib/funnel');
const DP = require('../lib/dispatch');
const AS = require('../lib/assign');
const F = require('../lib/flow');
const { resolveWindow } = require('../lib/windows');
const { parseYmd, fmtDate } = require('../lib/istTime');
const { rolesOf, isAdmin } = require('../lib/staffAuth');

const httpErr = D.httpErr;
const ACTIVE = ['confirm', 'pending', 'dispatch'];

// ---------------------------------------------------------------- settings
// The queue starts from the day the desk was first opened, so the last 60 days of old orders do not flood it. Admins can move the date back.
async function getConfig() {
  const s = await Setting.findOne({ key: 'desk.config' }).lean();
  const cur = { ...D.DEFAULT_CONFIG, ...D.migrateConfig((s && s.value) || {}) }; // settings saved before pending follow-ups moved to hours are converted on read
  if (!cur.startFrom) {
    cur.startFrom = fmtDate(new Date());
    await Setting.findOneAndUpdate({ key: 'desk.config' }, { key: 'desk.config', value: cur }, { upsert: true });
  }
  return cur;
}
async function saveConfig(body) {
  const next = D.normaliseConfig(body || {}, await getConfig());
  await Setting.findOneAndUpdate({ key: 'desk.config' }, { key: 'desk.config', value: next }, { upsert: true });
  ingest().catch(() => {}); // a new start date may bring older orders in
  return next;
}

// ---------------------------------------------------------------- bringing Shopify orders into the queue
async function ingest(now = new Date()) {
  const conf = await getConfig();
  const start = parseYmd(conf.startFrom);
  const orders = await ShopifyOrder.find({ createdAt: { $gte: start }, test: { $ne: true } }).select('orderId createdAt cancelledAt').lean();
  if (!orders.length) return { added: 0, cancelled: 0 };
  const have = await DeskOrder.find({ orderId: { $in: orders.map((o) => o.orderId) } }).select('orderId stage restoredAt').lean();
  const restored = new Set(have.filter((d) => d.restoredAt).map((d) => d.orderId)); // an admin restored these on purpose: leave them be
  const stageOf = new Map(have.map((d) => [d.orderId, d.stage]));
  const fresh = orders.filter((o) => !stageOf.has(o.orderId)).map((o) => D.initialState(o, conf, now));
  if (fresh.length) {
    try { await DeskOrder.insertMany(fresh, { ordered: false }); } catch (e) { if (e.code !== 11000 && !e.writeErrors) throw e; } // two syncs at once: the duplicate is simply skipped
  }
  // Orders cancelled inside Shopify while the team was still working them
  let cancelled = 0;
  for (const o of orders.filter((x) => x.cancelledAt && !restored.has(x.orderId) && ACTIVE.includes(stageOf.get(x.orderId)))) {
    const r = await DeskOrder.updateOne({ orderId: o.orderId, stage: { $in: ACTIVE } }, {
      $set: { stage: 'cancelled', dueAt: null, cancel: { reason: 'Cancelled in Shopify', note: '', at: new Date(o.cancelledAt), byName: 'Shopify', auto: true, fromStage: stageOf.get(o.orderId) } },
      $push: { log: { at: now, by: 'Shopify', action: 'shopify_cancel', stage: stageOf.get(o.orderId), fu: '', label: 'Order was cancelled in Shopify' } },
      $inc: { rev: 1 },
    });
    cancelled += r.modifiedCount || 0;
  }
  if (fresh.length) await autoAssign().catch((e) => console.warn('[desk] auto-assign failed:', e.message)); // new orders get their FU1 person at once
  return { added: fresh.length, cancelled };
}
// Orders from before the start date that nobody has touched (see lib/staleQueue.js). preview = just count them.
async function staleQueue({ clear = false } = {}) {
  const SQ = require('../lib/staleQueue');
  const conf = await getConfig();
  const start = parseYmd(conf.startFrom);
  const filter = SQ.staleFilter(start);
  const count = await DeskOrder.countDocuments(filter);
  if (!clear) return { startFrom: conf.startFrom, count, removed: 0 };
  const r = await DeskOrder.deleteMany(filter);
  return { startFrom: conf.startFrom, count, removed: r.deletedCount || 0 };
}
let lastIngest = 0;
async function ingestIfStale(maxAgeMs = 15000) {
  if (Date.now() - lastIngest < maxAgeMs) return;
  lastIngest = Date.now();
  try { await ingest(); } catch (e) { console.warn('[desk] ingest failed:', e.message); }
}

// ---------------------------------------------------------------- actions
// assign: after the change, give the order (now in its next column) to the right person. The handover loop turns it off and does one pass for the whole batch.
async function applyTransition(doc, t, { assign = true } = {}) {
  const upd = await DeskOrder.findOneAndUpdate({ orderId: doc.orderId, rev: doc.rev || 0 }, { $set: t.set, $push: { log: { $each: t.entries } }, $inc: { rev: 1 } }, { new: true }).lean();
  if (!upd) throw httpErr(409, 'Someone else just updated this order. Refresh to see its latest status.');
  if (assign) await autoAssign({ orderIds: [doc.orderId] }).catch((e) => console.warn('[desk] auto-assign failed:', e.message));
  return upd;
}
// With "team members see only their own orders" switched on, an order held by someone else can only be worked by them (or an admin).
async function assertCanWork(user, doc) {
  if (!user || isAdmin(user) || !doc.assignee || !doc.assignee.id) return;
  const cfg = await getAssignConfig();
  if (!AS.canWork(user, doc, cfg.visibility)) throw httpErr(403, `Order #${doc.orderId} is assigned to ${doc.assignee.name || 'someone else'}. Ask an admin to reassign it.`);
}
async function loadForAction(orderId, user = null) {
  const doc = await DeskOrder.findOne({ orderId }).lean();
  if (!doc) throw httpErr(404, `Order #${orderId} is not in the Shopify Desk`);
  await assertCanWork(user, doc);
  const so = await ShopifyOrder.findOne({ orderId }).select('total').lean();
  return { doc, total: so ? so.total : null };
}

async function act(user, orderId, action, input = {}) {
  if (action === 'partial_paid') throw httpErr(400, 'Use the partial payment form');
  const { doc, total } = await loadForAction(orderId, user);
  const t = D.transition(doc, action, input, await getConfig(), user, { total, orderId });
  return brief(await applyTransition(doc, t));
}

async function savePartial(user, orderId, { amount, notes, file }) {
  const { doc, total } = await loadForAction(orderId, user);
  const conf = await getConfig();
  let kind = null;
  if (file) {
    kind = F.sniffMedia(file.buffer);
    if (kind !== 'photo') throw httpErr(400, 'The screenshot must be a photo (JPG, PNG or WebP).');
  }
  const input = { amount, notes, screenshotId: file ? 'pending' : null };
  D.transition(doc, 'partial_paid', input, conf, user, { total, orderId }); // dry run: every rule is checked before anything is stored
  let shot = null;
  if (file) shot = await DeskShot.create({ orderId, mime: F.mimeOf(file.buffer), size: file.buffer.length, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), data: file.buffer, byName: user.name });
  try {
    const t = D.transition(doc, 'partial_paid', { ...input, screenshotId: shot ? String(shot._id) : null }, conf, user, { total, orderId });
    return brief(await applyTransition(doc, t));
  } catch (e) {
    if (shot) await DeskShot.deleteOne({ _id: shot._id }).catch(() => {});
    throw e;
  }
}
const brief = (d) => ({ orderId: d.orderId, stage: d.stage, fuNo: d.fuNo, status: D.statusLabel(d), dueAt: d.dueAt || null });

async function shotFile(id) {
  if (!/^[0-9a-f]{24}$/i.test(String(id))) throw httpErr(404, 'Screenshot not found');
  const s = await DeskShot.findById(id).lean();
  if (!s) throw httpErr(404, 'Screenshot not found');
  return s;
}

// ---------------------------------------------------------------- cards
const SHOP_FIELDS = 'orderId name createdAt cancelledAt financialStatus fulfillmentStatus paymentGateways currency subtotal shipping discounts total note tags customer address items itemsSummary marketing';
const addressLine = (a = {}) => [a.line1, a.line2, a.city, a.state, a.zip].filter(Boolean).join(', ');
const paymentLabel = (s) => (s && ((s.paymentGateways || []).join(', ') || s.financialStatus)) || '';

function cardOf(desk, shop, conf, ship) {
  const s = shop || {};
  const c = s.customer || {};
  const a = s.address || {};
  const rawPhone = c.phone || a.phone || null;
  const total = s.total == null ? null : s.total;
  const collect = D.collectAmount(total, s.financialStatus, desk.partial);
  const itemsShort = String(s.itemsSummary || '').slice(0, 90);
  const text = D.renderTemplate(conf.whatsappTemplate, { name: D.firstName(c.name || a.name), order: s.name || `#${desk.orderId}`, items: itemsShort, amount: total == null ? '' : Math.round(total), balance: collect == null ? '' : Math.round(collect) });
  const last = (desk.log || []).filter((e) => e.action !== 'enter_queue' && e.action !== 'assign').slice(-1)[0];
  const asg = desk.assignee && desk.assignee.id ? desk.assignee : null;
  return {
    orderId: desk.orderId, orderName: s.name || `#${desk.orderId}`, orderAt: desk.orderAt, stage: desk.stage, fuNo: desk.fuNo, fu: D.fuLabel(desk), fuShown: D.fuName(conf.labels, D.fuLabel(desk)), status: D.statusLabel(desk, conf.labels),
    assignee: asg ? { id: asg.id, name: asg.name, auto: !!asg.auto, at: asg.at || null } : null,
    dueAt: desk.dueAt || null, pendingSince: desk.pendingSince || null, dnpCount: desk.dnpCount || 0, lastDnpAt: desk.lastDnpAt || null, lastAction: last ? { label: last.label, by: last.by, at: last.at } : null,
    name: c.name || a.name || null, phone: D.dialNumber(rawPhone), wa: D.waLink(rawPhone, text), email: c.email || null,
    city: a.city || null, state: a.state || null, address: addressLine(a),
    items: s.itemsSummary || '', itemsList: s.items || [], total, collect, payment: paymentLabel(s), financialStatus: s.financialStatus || '',
    source: s.marketing && (s.marketing.sourceGroup || s.marketing.utmSource) || '', campaign: s.marketing && s.marketing.utmCampaign || '',
    partial: desk.partial && desk.partial.amount ? desk.partial : null, cancel: desk.cancel && desk.cancel.reason ? desk.cancel : null,
    dispatch: desk.dispatch && desk.dispatch.at ? desk.dispatch : null, confirmedAt: desk.confirmedAt || null, confirmedAtFu: desk.confirmedAtFu || '',
    shipway: ship ? { status: ship.status, group: ship.group, carrier: ship.carrier, awb: ship.awb } : null,
    dq: desk.dq && desk.dq.step ? { step: desk.dq.step, slip: desk.dq.slip || null, packed: desk.dq.packed || null, handover: desk.dq.handover || null, hold: desk.dq.hold && desk.dq.hold.at ? desk.dq.hold : null } : null,
    refundDue: !!(desk.stage === 'cancelled' && desk.partial && desk.partial.amount),
  };
}

async function withShop(desks, { ship = false } = {}) {
  const conf = await getConfig();
  const ids = desks.map((d) => d.orderId);
  const [shops, ships] = await Promise.all([
    ShopifyOrder.find({ orderId: { $in: ids } }).select(SHOP_FIELDS).lean(),
    ship ? ShipwayShipment.find({ orderId: { $in: ids }, found: true }).select('orderId status group carrier awb').lean() : [],
  ]);
  const sBy = new Map(shops.map((s) => [s.orderId, s]));
  const hBy = new Map(ships.map((s) => [s.orderId, s]));
  return desks.map((d) => cardOf(d, sBy.get(d.orderId), conf, hBy.get(d.orderId)));
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Search by order number, customer name, phone, email or item. Returns null when there is nothing to search for.
async function searchIds(q) {
  const t = String(q || '').trim().replace(/^#/, '');
  if (!t) return null;
  const or = [];
  if (/^\d{1,9}$/.test(t)) or.push({ orderId: Number(t) });
  const digits = t.replace(/\D/g, '');
  if (digits.length >= 4) or.push({ 'customer.phone': new RegExp(esc(digits.slice(-10)) + '$') }, { 'address.phone': new RegExp(esc(digits.slice(-10)) + '$') });
  const rx = new RegExp(esc(t), 'i');
  or.push({ 'customer.name': rx }, { 'address.name': rx }, { 'customer.email': rx }, { itemsSummary: rx });
  return (await ShopifyOrder.find({ $or: or }).select('orderId').limit(2000).lean()).map((o) => o.orderId);
}

// ---------------------------------------------------------------- queue tabs
const SORT = { confirm: { dueAt: 1 }, pending: { dueAt: 1 }, todo: { confirmedAt: 1 }, done: { 'dispatch.at': -1 }, cancelled: { 'cancel.at': -1 }, partial: { 'partial.at': -1 } };

async function counts(now = new Date()) {
  await ingestIfStale();
  const [agg, dueAgg] = await Promise.all([
    DeskOrder.aggregate([{ $group: { _id: { stage: '$stage', fuNo: '$fuNo' }, n: { $sum: 1 } } }]),
    DeskOrder.aggregate([{ $match: { stage: { $in: ['confirm', 'pending'] }, dueAt: { $lte: now } } }, { $group: { _id: { stage: '$stage', fuNo: '$fuNo' }, n: { $sum: 1 } } }]),
  ]);
  const dueBy = new Map(dueAgg.map((r) => [`${r._id.stage}:${r._id.fuNo}`, r.n]));
  const out = { confirm: { total: 0, due: 0, fu: [0, 0, 0], dueFu: [0, 0, 0] }, pending: { total: 0, due: 0, fu: [0, 0, 0], dueFu: [0, 0, 0] }, dispatch: 0, dispatched: 0, cancelled: 0, partial: 0, now };
  for (const r of agg) {
    const { stage, fuNo } = r._id;
    if (stage === 'confirm' || stage === 'pending') {
      const o = out[stage]; const due = dueBy.get(`${stage}:${fuNo}`) || 0; o.total += r.n; o.due += due;
      if (fuNo >= 1 && fuNo <= 3) { o.fu[fuNo - 1] += r.n; o.dueFu[fuNo - 1] += due; }
    } else out[stage] = (out[stage] || 0) + r.n;
  }
  out.partial = await DeskOrder.countDocuments({ 'partial.amount': { $gt: 0 } });
  const [inQueue, dconf] = await Promise.all([DeskOrder.find({ stage: 'dispatch' }).select('orderId dq confirmedAt orderAt').lean(), getDispatchConfig()]);
  out.dispatchSteps = DP.stepCounts(inQueue, dconf, now); // { slip, packed, handover, overdue, overdueBy }
  return out;
}

// key: confirm | pending | dispatch | cancelled | partial. opts: fu (1-3), section (todo|done, dispatch only), q, page, limit
async function queue(key, opts = {}) {
  await ingestIfStale();
  const now = new Date();
  const filter = {}; let sort;
  if (key === 'confirm' || key === 'pending') {
    filter.stage = key; sort = SORT[key];
    const fu = Number(opts.fu); if (fu >= 1 && fu <= 3) filter.fuNo = fu;
  } else if (key === 'dispatch') {
    const done = opts.section === 'done';
    filter.stage = done ? 'dispatched' : 'dispatch'; sort = done ? SORT.done : SORT.todo;
  } else if (key === 'cancelled') { filter.stage = 'cancelled'; sort = SORT.cancelled; }
  else if (key === 'partial') { filter['partial.amount'] = { $gt: 0 }; sort = SORT.partial; }
  else throw httpErr(404, 'Unknown list');
  const ids = await searchIds(opts.q);
  if (ids) filter.orderId = { $in: ids };
  const limit = Math.min(200, Math.max(1, parseInt(opts.limit) || 100));
  const page = Math.max(1, parseInt(opts.page) || 1);
  const [total, desks] = await Promise.all([DeskOrder.countDocuments(filter), DeskOrder.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean()]);
  const [items, c] = await Promise.all([withShop(desks, { ship: key === 'dispatch' || key === 'partial' }), counts(now)]);
  let sums = null;
  if (key === 'cancelled' || key === 'partial') { // totals across the whole list, not just this page
    const all = await DeskOrder.find(filter).select('orderId partial cancel').lean();
    const shops = await ShopifyOrder.find({ orderId: { $in: all.map((d) => d.orderId) } }).select('orderId total').lean();
    const tBy = new Map(shops.map((s) => [s.orderId, s.total || 0]));
    sums = key === 'cancelled'
      ? { orders: all.length, value: D.rupees(all.reduce((n, d) => n + (tBy.get(d.orderId) || 0), 0)), auto: all.filter((d) => d.cancel && d.cancel.auto).length, refundDue: D.rupees(all.reduce((n, d) => n + ((d.partial && d.partial.amount) || 0), 0)) }
      : { orders: all.length, collected: D.rupees(all.filter((d) => d.cancel == null || !d.cancel.reason).reduce((n, d) => n + ((d.partial && d.partial.amount) || 0), 0)), balance: D.rupees(all.filter((d) => d.cancel == null || !d.cancel.reason).reduce((n, d) => n + ((d.partial && d.partial.balance) || 0), 0)) };
  }
  return { now, total, page, limit, items, counts: c, sums };
}


// ---------------------------------------------------------------- who works which order (see lib/assign.js)
async function getAssignConfig() {
  const s = await Setting.findOne({ key: 'desk.assign' }).lean();
  return AS.normaliseAssignConfig({}, (s && s.value) || AS.DEFAULT_ASSIGN);
}
const activeTeam = async () => (await StaffUser.find({ active: true }).select('name role roles').sort({ role: 1, name: 1 }).lean()).map((u) => ({ id: String(u._id), name: u.name, role: u.role, roles: rolesOf(u), active: true }));
// Anyone signed in may see the names (the card's "assigned to" and the filter); only admins change them.
async function team() { return (await activeTeam()).map(({ id, name, role, roles }) => ({ id, name, role, roles })); }

// What a board needs to know about assignment: is it on for these columns, and who can an admin pick.
const assignBrief = (cfg, slots) => ({ visibility: cfg.visibility, modes: Object.fromEntries(slots.map((k) => [k, cfg.slots[k].mode])) });

// Narrow a list to one person's orders. admin: any person, "me", or "none" (unassigned). With "own only" on, a team member only ever gets their own plus the unassigned ones.
function assigneeFilter(opts, cfg) {
  const v = opts.viewer; const want = String(opts.assignee || ''); const f = {};
  if (v && !isAdmin(v) && cfg.visibility === 'own') {
    if (want === 'none') f['assignee.id'] = null; else if (want === 'me') f['assignee.id'] = v.id; else f.$or = [{ 'assignee.id': v.id }, { 'assignee.id': null }];
    return f;
  }
  if (want === 'none') f['assignee.id'] = null; else if (want === 'me' && v) f['assignee.id'] = v.id; else if (want) f['assignee.id'] = want;
  return f;
}

// Orders open for work, oldest due first, so the longest-waiting order is handed out first.
const urgency = (d) => new Date(d.dueAt || (d.dq && d.dq.stepAt) || d.confirmedAt || d.orderAt || 0).getTime();
const loadsOf = (docs) => {
  const loads = {};
  for (const d of docs) { const slot = AS.slotOf(d); const a = d.assignee; if (slot && a && a.id && a.slot === slot) { (loads[slot] = loads[slot] || new Map()).set(a.id, ((loads[slot].get(a.id)) || 0) + 1); } }
  return loads;
};

// Gives every open order its person, following each column's rule. Safe to run any time: orders that are fine are not touched, and an order someone
// just worked on (its rev moved) is simply picked up on the next run. One run at a time.
let assignChain = Promise.resolve();
function autoAssign(opts = {}) { const run = assignChain.then(() => doAutoAssign(opts)); assignChain = run.catch(() => {}); return run; }
async function doAutoAssign({ orderIds = null } = {}) {
  const [cfg, users] = await Promise.all([getAssignConfig(), StaffUser.find({ active: true }).select('name').lean()]);
  if (AS.SLOTS.every((k) => cfg.slots[k].mode === 'off') && !(await DeskOrder.exists({ stage: { $in: ACTIVE }, 'assignee.id': { $ne: null } }))) return { assigned: 0 };
  const nameOf = new Map(users.map((u) => [String(u._id), u.name]));
  const all = await DeskOrder.find({ stage: { $in: ACTIVE } }).select('orderId stage fuNo dq assignee confirmedAt dueAt orderAt rev').lean();
  const loads = loadsOf(all);
  const want = orderIds ? new Set(orderIds) : null;
  const targets = all.filter((d) => !want || want.has(d.orderId)).sort((x, y) => urgency(x) - urgency(y));
  const now = new Date(); const ops = []; let assigned = 0;
  for (const d of targets) {
    const slot = AS.slotOf(d); if (!slot) continue;
    const r = AS.decide(d, cfg.slots[slot], { keepSamePerson: cfg.keepSamePerson, load: loads[slot] || new Map(), isActive: (id) => nameOf.has(String(id)) });
    if (!r) continue;
    const filter = { orderId: d.orderId, rev: d.rev || 0 };
    if (!r.assigneeId) { ops.push({ updateOne: { filter, update: { $unset: { assignee: '' } } } }); continue; }
    const same = d.assignee && d.assignee.id === r.assigneeId;
    const name = nameOf.get(String(r.assigneeId)) || '';
    const set = { assignee: { id: r.assigneeId, name, slot, at: same ? d.assignee.at || now : now, by: 'auto', auto: true } };
    const update = { $set: set };
    if (!same) { update.$push = { log: { at: now, by: 'System', byId: 'system', action: 'assign', stage: d.stage, fu: '', label: `Assigned to ${name} (auto)` } }; assigned++; }
    ops.push({ updateOne: { filter, update } });
    (loads[slot] = loads[slot] || new Map()).set(r.assigneeId, ((loads[slot].get(r.assigneeId)) || 0) + 1);
  }
  if (ops.length) await DeskOrder.bulkWrite(ops, { ordered: false });
  return { assigned };
}

async function assignOverview() {
  const [config, people, docs] = await Promise.all([getAssignConfig(), team(), DeskOrder.find({ stage: { $in: ACTIVE } }).select('orderId stage fuNo dq assignee').lean()]);
  const load = Object.fromEntries(AS.SLOTS.map((k) => [k, { none: 0 }]));
  for (const d of docs) { const slot = AS.slotOf(d); if (!slot) continue; const a = d.assignee && d.assignee.id && d.assignee.slot === slot ? d.assignee.id : null; if (a) load[slot][a] = (load[slot][a] || 0) + 1; else load[slot].none++; }
  return { config, team: people, load, slots: AS.SLOTS };
}
async function saveAssignConfig(body = {}) {
  const next = AS.normaliseAssignConfig(body, await getAssignConfig(), await activeTeam());
  await Setting.findOneAndUpdate({ key: 'desk.assign' }, { key: 'desk.assign', value: next }, { upsert: true });
  await autoAssign();
  return assignOverview();
}

// An admin gives an order to a person (or takes it back: userId empty). A team member may only take an order nobody holds yet ("me").
async function assignManual(user, orderId, userId) {
  const { doc } = await loadForAction(orderId);
  const slot = AS.slotOf(doc);
  if (!slot) throw httpErr(409, `Order #${orderId} is no longer waiting for anyone. Refresh to see its latest status.`);
  if ((await getAssignConfig()).slots[slot].mode === 'off') throw httpErr(409, 'Assigning is switched off for this column. An admin can turn on Manual or Auto in Settings, Team assignment.');
  const target = userId === 'me' ? user.id : (userId || null);
  if (!isAdmin(user)) {
    if (String(target) !== String(user.id)) throw httpErr(403, 'Only an admin can give an order to someone else.');
    if (doc.assignee && doc.assignee.id && doc.assignee.id !== user.id) throw httpErr(409, `Order #${orderId} was just taken by ${doc.assignee.name}.`);
    if (!AS.roleFits(slot, user)) throw httpErr(403, 'Your role cannot work this column.');
  }
  const filter = { orderId, rev: doc.rev || 0 };
  const now = new Date();
  let upd;
  if (!target) {
    upd = await DeskOrder.findOneAndUpdate(filter, { $unset: { assignee: '' }, $push: { log: { at: now, by: user.name, byId: user.id, action: 'assign', stage: doc.stage, fu: '', label: 'Taken off the person it was assigned to' } } }, { new: true }).lean();
  } else {
    const u = await StaffUser.findById(target).select('name role roles active').lean();
    if (!u || !u.active) throw httpErr(400, 'That person is not an active team member.');
    if (!AS.roleFits(slot, u)) throw httpErr(400, `${u.name} is in a different team and cannot work this column.`);
    const self = String(target) === String(user.id);
    upd = await DeskOrder.findOneAndUpdate(filter, { $set: { assignee: { id: String(u._id), name: u.name, slot, at: now, by: user.name, auto: false } }, $push: { log: { at: now, by: user.name, byId: user.id, action: 'assign', stage: doc.stage, fu: '', label: self && !isAdmin(user) ? `${u.name} took this order` : `Assigned to ${u.name} by ${user.name}` } } }, { new: true }).lean();
  }
  if (!upd) throw httpErr(409, 'Someone else just updated this order. Refresh to see its latest status.');
  return { orderId, assignee: upd.assignee && upd.assignee.id ? { id: upd.assignee.id, name: upd.assignee.name, auto: false } : null };
}
async function assignBulk(user, orderIds, userId) {
  const ids = [...new Set((orderIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 300);
  if (!ids.length) throw httpErr(400, 'Pick at least one order');
  let done = 0; const failed = [];
  for (const id of ids) { try { await assignManual(user, id, userId); done++; } catch (e) { failed.push({ orderId: id, error: e.message }); } }
  return { done, failed };
}

// "Share out again": every open order of an Auto column is redistributed to match the shares, moving as few orders as possible.
// slot omitted = every Auto column. Useful right after adding people, when the old ones still hold everything.
async function rebalance(user, slot = null) {
  const [cfg, users] = await Promise.all([getAssignConfig(), StaffUser.find({ active: true }).select('name').lean()]);
  const nameOf = new Map(users.map((u) => [String(u._id), u.name]));
  const slots = slot ? [slot] : AS.SLOTS.filter((k) => cfg.slots[k].mode === 'auto');
  if (slot && !AS.SLOTS.includes(slot)) throw httpErr(400, 'Unknown column');
  if (slot && cfg.slots[slot].mode !== 'auto') throw httpErr(400, 'Share out again only works on a column set to Auto.');
  await autoAssign(); // first make sure every order has someone
  const all = await DeskOrder.find({ stage: { $in: ACTIVE } }).select('orderId stage fuNo dq assignee confirmedAt dueAt orderAt rev').lean();
  const now = new Date(); const ops = []; let moved = 0;
  for (const k of slots) {
    const docs = all.filter((d) => AS.slotOf(d) === k).sort((x, y) => urgency(x) - urgency(y));
    const members = cfg.slots[k].members.filter((m) => nameOf.has(String(m.id)));
    const plan = AS.planRebalance(docs.map((d) => ({ orderId: d.orderId, assigneeId: d.assignee && d.assignee.slot === k ? d.assignee.id : null })), members);
    for (const d of docs) {
      const to = plan.get(d.orderId); if (!to) continue;
      const name = nameOf.get(String(to));
      ops.push({ updateOne: { filter: { orderId: d.orderId, rev: d.rev || 0 }, update: { $set: { assignee: { id: to, name, slot: k, at: now, by: user.name, auto: true } }, $push: { log: { at: now, by: user.name, byId: user.id, action: 'assign', stage: d.stage, fu: '', label: `Re-shared to ${name} by ${user.name}` } } } } });
      moved++;
    }
  }
  if (ops.length) await DeskOrder.bulkWrite(ops, { ordered: false });
  return { moved, overview: await assignOverview() };
}

// The Confirm queue and the Pending orders boards: one column per follow-up, like the Dispatch queue.
async function callBoard(kind, opts = {}) {
  if (kind !== 'confirm' && kind !== 'pending') throw httpErr(404, 'Unknown board');
  await ingestIfStale();
  const now = new Date();
  const acfg = await getAssignConfig();
  const filter = { stage: kind, ...assigneeFilter(opts, acfg) };
  const ids = await searchIds(opts.q);
  if (ids) filter.orderId = { $in: ids };
  const desks = await DeskOrder.find(filter).sort({ dueAt: 1 }).limit(1000).lean();
  const [cards, c] = await Promise.all([withShop(desks), counts(now)]);
  const columns = { 1: [], 2: [], 3: [] };
  for (const card of cards) if (columns[card.fuNo]) columns[card.fuNo].push(card);
  return { now, kind, counts: c, columns, shown: cards.length, assign: assignBrief(acfg, [1, 2, 3].map((n) => `${kind}${n}`)) };
}

// ---------------------------------------------------------------- Dispatch queue: packing slip -> order packed -> order handover -> in-transit
async function getDispatchConfig() {
  const s = await Setting.findOne({ key: 'desk.dispatch' }).lean();
  return DP.normaliseDispatchConfig((s && s.value) || {}, DP.DEFAULT_DISPATCH_CONFIG);
}
async function saveDispatchConfig(body) {
  const next = DP.normaliseDispatchConfig(body || {}, await getDispatchConfig());
  await Setting.findOneAndUpdate({ key: 'desk.dispatch' }, { key: 'desk.dispatch', value: next }, { upsert: true });
  return next;
}

// The AWB and the courier come from Shipway, not from typing. Asking Shipway again right now matters: the label may have been made a minute ago.
// If Shipway cannot be reached the last saved answer is used.
async function liveAwb(orderId, { refresh = true } = {}) {
  const client = require('./shipwayClient');
  if (refresh && client.isConfigured()) {
    try { await require('./shipwaySync').refreshOne(orderId); } catch (e) { /* Shipway busy or offline: fall back to what is saved */ }
  }
  const ship = await ShipwayShipment.findOne({ orderId, found: true }).select('awb carrier').lean();
  const dconf = await getDispatchConfig();
  if (ship && ship.awb) return { awb: ship.awb, courier: ship.carrier || '', source: 'Shipway', shipwayConfigured: client.isConfigured(), allowManual: dconf.allowManualAwb };
  return { awb: '', courier: '', source: null, shipwayConfigured: client.isConfigured(), allowManual: dconf.allowManualAwb };
}

async function dispatchBoard(opts = {}) {
  await ingestIfStale();
  const now = new Date();
  const [dconf, acfg] = await Promise.all([getDispatchConfig(), getAssignConfig()]);
  const filter = { stage: 'dispatch', ...assigneeFilter(opts, acfg) };
  const ids = await searchIds(opts.q);
  if (ids) filter.orderId = { $in: ids };
  const desks = await DeskOrder.find(filter).sort({ confirmedAt: 1 }).limit(500).lean();
  const [cards, all] = await Promise.all([
    withShop(desks, { ship: true }),
    DeskOrder.find({ stage: 'dispatch' }).select('orderId dq confirmedAt orderAt').lean(),
  ]);
  const columns = { slip: [], packed: [], handover: [] }; const hold = [];
  cards.forEach((c, i) => {
    const d = desks[i]; const step = DP.stepOf(d); const due = DP.dueAt(d, dconf);
    (DP.isHeld(d) ? hold : columns[step]).push({
      ...c,
      dq: {
        step, stepAt: DP.stepStart(d), dueAt: due, overdue: !!due && due.getTime() < now.getTime(),
        slip: (d.dq && d.dq.slip) || null, packed: (d.dq && d.dq.packed) || null,
        hold: DP.isHeld(d) ? d.dq.hold : null,
        suggestedAwb: (c.shipway && c.shipway.awb) || '', // from Shipway
        suggestedCourier: (c.shipway && c.shipway.carrier) || '',
      },
    });
  });
  for (const k of DP.STEPS) columns[k].sort((a, b) => new Date(a.dq.dueAt || 0) - new Date(b.dq.dueAt || 0));
  hold.sort((a, b) => new Date(a.dq.hold.at) - new Date(b.dq.hold.at)); // longest on hold first
  const collect = cards.reduce((n, c) => n + (c.collect || 0), 0);
  return { now, config: dconf, cancelReasons: (await getConfig()).cancelReasons, columns, hold, counts: DP.stepCounts(all, dconf, now), collectTotal: D.rupees(collect), shown: cards.length, assign: assignBrief(acfg, ['slip', 'packed', 'handover']) };
}

async function dispatchSlip(user, orderId) {
  const { doc } = await loadForAction(orderId, user);
  const t = DP.slipDone(doc, await getDispatchConfig(), user);
  return brief(await applyTransition(doc, t));
}

// Hold, resume and cancel from the Dispatch queue (packing team and admins). Hold and cancel both need a note.
async function dispatchHold(user, orderId, { note }) {
  const { doc } = await loadForAction(orderId, user);
  return brief(await applyTransition(doc, DP.holdOrder(doc, { note }, user), { assign: false }));
}
async function dispatchResume(user, orderId, { note } = {}) {
  const { doc } = await loadForAction(orderId, user);
  return brief(await applyTransition(doc, DP.resumeOrder(doc, { note }, user)));
}
async function dispatchCancel(user, orderId, { reason, note }) {
  const { doc, total } = await loadForAction(orderId, user);
  if (doc.stage !== 'dispatch') throw httpErr(409, `Order #${orderId} is no longer in the dispatch queue. Refresh to see its latest status.`);
  const clean = DP.cleanNote(note, { label: 'note saying why the order is cancelled' });
  const t = D.transition(doc, 'cancel', { reason, note: clean }, await getConfig(), user, { total, orderId });
  t.set['dq.hold'] = null; // a cancelled order is not "on hold" any more
  return brief(await applyTransition(doc, t, { assign: false }));
}

const PHOTO_ERR = 'Every file must be a photo (JPG, PNG or WebP).';
async function storeProof(kind, file, user, extra) {
  return DispatchProof.create({ kind, ...extra, mime: F.mimeOf(file.buffer), size: file.buffer.length, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), data: file.buffer, byName: user.name });
}
const checkPhotos = (files) => {
  if (files.length > DP.MAX_PHOTOS) throw httpErr(400, `Add at most ${DP.MAX_PHOTOS} photos.`);
  if (files.some((f) => F.sniffMedia(f.buffer) !== 'photo')) throw httpErr(400, PHOTO_ERR);
};
const dropProofs = (proofs) => (proofs.length ? DispatchProof.deleteMany({ _id: { $in: proofs.map((x) => x._id) } }).catch(() => {}) : null);

// The person only adds the photos. AWB and courier are taken from Shipway here on the server, so a typed or pasted value cannot differ from the label.
// Only when Shipway has no AWB for the order yet (and Settings allows it) is the typed AWB used.
async function dispatchPacked(user, orderId, { awb, courier, files = [] }) {
  const { doc } = await loadForAction(orderId, user);
  const dconf = await getDispatchConfig();
  checkPhotos(files);
  const live = await liveAwb(orderId);
  let useAwb = live.awb; let useCourier = live.courier;
  if (!useAwb) {
    if (!dconf.allowManualAwb) throw httpErr(409, 'Shipway has no AWB for this order yet. Create the shipment in Shipway, then press Fetch again.');
    useAwb = awb; useCourier = courier || '';
  }
  const input = { awb: useAwb, courier: useCourier, photoIds: files.map((_, i) => `pending${i}`) };
  DP.packedDone(doc, input, dconf, user); // dry run: every rule is checked before anything is stored
  const clean = DP.cleanAwb(useAwb);
  const clash = await DeskOrder.findOne({ orderId: { $ne: orderId }, 'dq.packed.awb': clean }).select('orderId').lean();
  if (clash) throw httpErr(409, `AWB ${clean} is already on order #${clash.orderId}. Check the shipment in Shipway.`);
  const proofs = [];
  try {
    for (const f of files) proofs.push(await storeProof('package', f, user, { orderId }));
    const t = DP.packedDone(doc, { ...input, photoIds: proofs.map((x) => String(x._id)) }, dconf, user);
    return brief(await applyTransition(doc, t));
  } catch (e) { await dropProofs(proofs); throw e; }
}

// One manifest (one or more photos of it) can cover a whole courier pickup: orderIds is every order on it. All are checked first, then saved.
async function dispatchHandover(user, orderIds, { courier, files = [] }) {
  const ids = [...new Set((orderIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw httpErr(400, 'Pick at least one order');
  if (ids.length > DP.MAX_HANDOVER_BATCH) throw httpErr(400, `Hand over at most ${DP.MAX_HANDOVER_BATCH} orders on one manifest`);
  const dconf = await getDispatchConfig();
  checkPhotos(files);
  const docs = await DeskOrder.find({ orderId: { $in: ids } }).lean();
  const by = new Map(docs.map((d) => [d.orderId, d]));
  const dry = files.map((_, i) => `pending${i}`);
  const problems = [];
  for (const id of ids) {
    const d = by.get(id);
    if (!d) { problems.push(`#${id}: not in the Shopify Desk`); continue; }
    try { await assertCanWork(user, d); DP.handoverDone(d, { courier, manifestIds: dry }, dconf, user); } catch (e) { problems.push(`#${id}: ${e.message}`); }
  }
  if (problems.length) throw httpErr(409, `Nothing was saved. ${problems.join(' ')}`);
  const proofs = [];
  for (const f of files) proofs.push(await storeProof('manifest', f, user, { orderIds: ids }));
  const manifestIds = proofs.map((x) => String(x._id));
  const done = []; const failed = [];
  for (const id of ids) {
    try {
      const t = DP.handoverDone(by.get(id), { courier, manifestIds }, dconf, user);
      done.push(brief(await applyTransition(by.get(id), t, { assign: false })));
    } catch (e) { failed.push({ orderId: id, error: e.message }); }
  }
  if (!done.length) await dropProofs(proofs);
  return { done, failed };
}

async function proofFile(id) {
  if (!/^[0-9a-f]{24}$/i.test(String(id))) throw httpErr(404, 'Photo not found');
  const p = await DispatchProof.findById(id).lean();
  if (!p) throw httpErr(404, 'Photo not found');
  return p;
}

// ---------------------------------------------------------------- In-transit orders (handed over, tracked through Shipway)
const TRANSIT_GROUPS = ['transit', 'ndr', 'rto', 'delivered', 'other'];
async function transitList(opts = {}) {
  await ingestIfStale();
  const filter = { stage: 'dispatched' };
  const ids = await searchIds(opts.q);
  if (ids) filter.orderId = { $in: ids };
  const desks = await DeskOrder.find(filter).sort({ 'dispatch.at': -1 }).limit(3000).lean();
  const orderIds = desks.map((d) => d.orderId);
  const [shops, ships, conf] = await Promise.all([
    ShopifyOrder.find({ orderId: { $in: orderIds } }).select(SHOP_FIELDS).lean(),
    ShipwayShipment.find({ orderId: { $in: orderIds }, found: true }).select('orderId status statusCode group final carrier awb statusAt checkedAt').lean(),
    getConfig(),
  ]);
  const sBy = new Map(shops.map((x) => [x.orderId, x])); const hBy = new Map(ships.map((x) => [x.orderId, x]));
  const now = Date.now();
  const rows = desks.map((d) => {
    const h = hBy.get(d.orderId); const c = cardOf(d, sBy.get(d.orderId), conf, h);
    const at = d.dispatch && d.dispatch.at;
    return {
      orderId: c.orderId, orderName: c.orderName, name: c.name, phone: c.phone, city: c.city, state: c.state, total: c.total, collect: c.collect, payment: c.payment, items: c.items,
      handedOverAt: at || null, handedOverBy: d.dispatch && d.dispatch.byName, awb: (h && h.awb) || (d.dispatch && d.dispatch.awb) || '', courier: (h && h.carrier) || (d.dispatch && d.dispatch.courier) || '',
      manifestId: (d.dq && d.dq.handover && d.dq.handover.manifestId) || null, manifestIds: (d.dq && d.dq.handover && d.dq.handover.manifestIds) || [], packagePhotoId: (d.dq && d.dq.packed && d.dq.packed.photoId) || null,
      shipway: h ? { status: h.status, code: h.statusCode, group: h.group || 'other', final: !!h.final, statusAt: h.statusAt, checkedAt: h.checkedAt } : null,
      days: at ? Math.max(0, Math.floor((now - new Date(at).getTime()) / 864e5)) : null,
    };
  });
  const counts = { all: rows.length, none: 0 }; TRANSIT_GROUPS.forEach((g) => { counts[g] = 0; });
  for (const r of rows) { if (!r.shipway) counts.none++; else counts[TRANSIT_GROUPS.includes(r.shipway.group) ? r.shipway.group : 'other']++; }
  const g = String(opts.group || '');
  const shown = !g ? rows : g === 'none' ? rows.filter((r) => !r.shipway) : rows.filter((r) => r.shipway && (TRANSIT_GROUPS.includes(r.shipway.group) ? r.shipway.group : 'other') === g);
  const limit = Math.min(200, Math.max(1, parseInt(opts.limit) || 50));
  const page = Math.max(1, parseInt(opts.page) || 1);
  const client = require('./shipwayClient');
  return { now: new Date(), total: shown.length, page, limit, items: shown.slice((page - 1) * limit, page * limit), counts, shipwayConfigured: client.isConfigured() };
}

// Ask Shipway about handed-over orders whose status can still change. ids = specific orders (the button); otherwise the oldest-checked ones (the timer).
let transitBusy = false;
async function refreshTransit({ ids = null, limit = 60, minAgeMin = 0 } = {}) {
  const client = require('./shipwayClient');
  if (!client.isConfigured()) throw httpErr(400, 'Shipway is not connected yet. Add the Shipway login in the server settings.');
  if (transitBusy) throw httpErr(409, 'Shipway status is already being fetched. Try again in a moment.');
  transitBusy = true;
  try {
    const shipSync = require('./shipwaySync');
    let want = ids && ids.length ? ids.map(Number).filter(Number.isInteger) : (await DeskOrder.find({ stage: 'dispatched' }).sort({ 'dispatch.at': -1 }).limit(3000).select('orderId').lean()).map((d) => d.orderId);
    const have = await ShipwayShipment.find({ orderId: { $in: want } }).select('orderId final checkedAt').lean();
    const hBy = new Map(have.map((h) => [h.orderId, h]));
    want = want.filter((id) => { const h = hBy.get(id); return !h || (!h.final && Date.now() - new Date(h.checkedAt || 0).getTime() >= minAgeMin * 60000); });
    want.sort((a, b) => new Date((hBy.get(a) || {}).checkedAt || 0) - new Date((hBy.get(b) || {}).checkedAt || 0)); // never-checked first, then the stalest
    const queue = want.slice(0, Math.min(limit, 200));
    let checked = 0; let changed = 0; let failed = 0; let authErr = null;
    const worker = async () => {
      while (queue.length && !authErr) {
        const id = queue.shift();
        try { const r = await shipSync.refreshOne(id); checked++; if (r.error) failed++; else if (r.changed) changed++; } catch (e) { authErr = e; }
        await new Promise((r) => setTimeout(r, 120));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (authErr) throw httpErr(502, authErr.message || 'Shipway refused the login');
    return { checked, changed, failed, remaining: Math.max(0, want.length - checked) };
  } finally { transitBusy = false; }
}

// ---------------------------------------------------------------- all Shopify orders
async function ordersList(q = {}) {
  await ingestIfStale();
  const dconf = await getConfig();
  const w = resolveWindow(q.window || 'this_month', new Date(), { from: q.from, to: q.to });
  const base = { test: { $ne: true } };
  if (w.start) base.createdAt = { $gte: w.start, $lt: w.end };
  const ids = await searchIds(q.q);
  if (ids) base.orderId = { $in: ids };
  const all = await ShopifyOrder.find(base).select('orderId total createdAt').sort({ createdAt: -1 }).limit(50000).lean();
  const desks = await DeskOrder.find({ orderId: { $in: all.map((o) => o.orderId) } }).select('orderId stage fuNo partial.amount').lean();
  const dBy = new Map(desks.map((d) => [d.orderId, d]));
  const keyOf = (o) => { const d = dBy.get(o.orderId); return !d ? 'none' : d.stage === 'confirm' ? `confirm${d.fuNo}` : d.stage === 'pending' ? `pending${d.fuNo}` : d.stage; };
  const stageCounts = {};
  for (const o of all) { const d = dBy.get(o.orderId); const k = d ? d.stage : 'none'; stageCounts[k] = (stageCounts[k] || 0) + 1; }
  const want = String(q.stage || '');
  const rows = all.filter((o) => { if (!want) return true; const k = keyOf(o); return k === want || (want === 'partial' ? !!(dBy.get(o.orderId) && dBy.get(o.orderId).partial && dBy.get(o.orderId).partial.amount) : k.replace(/\d$/, '') === want); });
  const limit = Math.min(200, Math.max(1, parseInt(q.limit) || 50));
  const page = Math.max(1, parseInt(q.page) || 1);
  const slice = rows.slice((page - 1) * limit, page * limit);
  const [shops, deskFull] = await Promise.all([
    ShopifyOrder.find({ orderId: { $in: slice.map((o) => o.orderId) } }).select(SHOP_FIELDS).lean(),
    DeskOrder.find({ orderId: { $in: slice.map((o) => o.orderId) } }).lean(),
  ]);
  const sBy = new Map(shops.map((s) => [s.orderId, s])); const fBy = new Map(deskFull.map((d) => [d.orderId, d]));
  const out = slice.map((o) => {
    const s = sBy.get(o.orderId) || {}; const d = fBy.get(o.orderId) || null;
    return {
      orderId: o.orderId, orderName: s.name || `#${o.orderId}`, createdAt: s.createdAt, name: (s.customer && s.customer.name) || (s.address && s.address.name) || null,
      phone: D.dialNumber((s.customer && s.customer.phone) || (s.address && s.address.phone)), city: s.address && s.address.city, items: s.itemsSummary || '',
      total: s.total, payment: paymentLabel(s), financialStatus: s.financialStatus, stage: d ? d.stage : 'none', fu: d ? D.fuLabel(d) : '', fuShown: d ? D.fuName(dconf.labels, D.fuLabel(d)) : '', status: D.statusLabel(d, dconf.labels),
      partialAmount: d && d.partial ? d.partial.amount : null, collect: D.collectAmount(s.total, s.financialStatus, d && d.partial), cancelReason: d && d.cancel ? d.cancel.reason : null,
      source: s.marketing && (s.marketing.sourceGroup || s.marketing.utmSource) || '',
    };
  });
  const value = all.reduce((n, o) => n + (o.total || 0), 0);
  return {
    range: { key: w.key, label: w.label, partial: w.partial, start: w.start ? fmtDate(w.start) : null, end: w.end ? fmtDate(new Date(w.end - 1)) : null },
    total: rows.length, page, limit, rows: out, stageCounts, summary: { orders: all.length, value: D.rupees(value), avg: all.length ? D.rupees(value / all.length) : null },
  };
}

async function orderDetail(orderId) {
  await ingestIfStale();
  const [shop, desk, ship, conf] = await Promise.all([
    ShopifyOrder.findOne({ orderId }).lean(), DeskOrder.findOne({ orderId }).lean(), ShipwayShipment.findOne({ orderId, found: true }).lean(), getConfig(),
  ]);
  if (!shop && !desk) throw httpErr(404, `Order #${orderId} was not found`);
  const card = cardOf(desk || { orderId, stage: 'none', fuNo: 0, log: [] }, shop, conf, ship);
  if (!desk) card.status = D.statusLabel(null, conf.labels);
  return {
    card, inQueue: !!desk,
    shopify: shop ? { ...shop, _id: undefined } : null,
    log: desk ? desk.log : [],
    shipway: ship ? { status: ship.status, carrier: ship.carrier, awb: ship.awb, statusAt: ship.statusAt, checkedAt: ship.checkedAt } : null,
    queueStart: conf.startFrom,
  };
}

// ---------------------------------------------------------------- order analysis: what happened to each order, all at once (on screen and as Excel)
// q: { orderId } for one order, or the same window / stage / q filters as the Orders list. Capped at 5000 orders.
// Times in the rows are shifted by +5:30 so that formatting them as UTC shows IST (Excel has no time zones).
const STAGE_NAME_FOR_SCOPE = (k) => ({ confirm: 'Confirm queue', pending: 'Pending', dispatch: 'To dispatch', dispatched: 'Dispatched', cancelled: 'Cancelled', partial: 'Partial paid', none: 'Not in queue' }[k] || k);
async function analysisRows(q = {}) {
  await ingestIfStale();
  const A = require('../lib/analysisSheet');
  const one = Number(q.orderId);
  const w = resolveWindow(q.window || 'this_month', new Date(), { from: q.from, to: q.to });
  const base = { test: { $ne: true } };
  let scope = `Order #${one}`;
  if (Number.isInteger(one) && one > 0) base.orderId = one;
  else {
    if (w.start) base.createdAt = { $gte: w.start, $lt: w.end };
    const ids = await searchIds(q.q);
    if (ids) base.orderId = { $in: ids };
    scope = `${w.label || 'All time'}${q.stage ? ` · ${STAGE_NAME_FOR_SCOPE(q.stage)}` : ''}${q.q ? ` · search “${String(q.q).slice(0, 40)}”` : ''}`;
  }
  const shops = await ShopifyOrder.find(base).select(SHOP_FIELDS).sort({ createdAt: -1 }).limit(5000).lean();
  const ids = shops.map((x) => x.orderId);
  const [desks, ships, dconf] = await Promise.all([
    DeskOrder.find({ orderId: { $in: ids } }).lean(),
    ShipwayShipment.find({ orderId: { $in: ids }, found: true }).select('orderId status carrier awb statusAt').lean(),
    getDispatchConfig(),
  ]);
  const dBy = new Map(desks.map((d) => [d.orderId, d])); const hBy = new Map(ships.map((h) => [h.orderId, h]));
  const now = new Date();
  let rows = shops.map((x) => A.journeyRow({ orderId: x.orderId, shop: x, desk: dBy.get(x.orderId), ship: hBy.get(x.orderId), dconf, now }));
  const want = String(q.stage || '');
  if (want && !Number.isInteger(one)) rows = rows.filter((r) => r.stage === want || (want === 'partial' && r.partialAmount > 0));
  if (Number.isInteger(one) && one > 0 && !rows.length) throw httpErr(404, `Order #${one} was not found`);
  return { rows, scope, w: { key: w.key, label: w.label, start: w.start ? fmtDate(w.start) : null, end: w.end ? fmtDate(new Date(w.end - 1)) : null }, one };
}

async function analysisSheet(q = {}) {
  const A = require('../lib/analysisSheet');
  const { rows, scope, one } = await analysisRows(q);
  return { buffer: await A.buildWorkbook(rows, { title: Number.isInteger(one) && one > 0 ? `Order #${one}: what happened` : 'Order analysis', scope }), count: rows.length };
}

async function analysisData(q = {}) {
  const A = require('../lib/analysisSheet');
  const { rows, scope, w } = await analysisRows(q);
  const limit = Math.min(200, Math.max(1, parseInt(q.limit) || 50));
  const page = Math.max(1, parseInt(q.page) || 1);
  const sum = A.summarise(rows);
  const chips = {}; for (const r of rows) chips[r.stage] = (chips[r.stage] || 0) + 1;
  return { scope, range: w, total: rows.length, page, limit, summary: sum, chips, rows: rows.slice((page - 1) * limit, page * limit) };
}

// ---------------------------------------------------------------- Overview
// Orders placed in a window, each with its desk record and Shipway shipment. Shared by the Overview and the Order funnel tab.
async function loadWindow(w) {
  const base = { test: { $ne: true } };
  if (w.start) base.createdAt = { $gte: w.start, $lt: w.end };
  const shops = await ShopifyOrder.find(base).select('orderId total createdAt financialStatus paymentGateways').limit(50000).lean();
  const ids = shops.map((s) => s.orderId);
  const [desks, ships] = await Promise.all([
    DeskOrder.find({ orderId: { $in: ids } }).lean(),
    ShipwayShipment.find({ orderId: { $in: ids }, found: true }).select('orderId group found').lean(),
  ]);
  const dBy = new Map(desks.map((d) => [d.orderId, d]));
  const hBy = new Map(ships.map((h) => [h.orderId, h]));
  return shops.map((s) => ({ desk: dBy.get(s.orderId) || null, shop: s, ship: hBy.get(s.orderId) || null, total: s.total, createdAt: s.createdAt }));
}

async function statsFor(w, now) {
  const rows = await loadWindow(w);
  return { stats: D.overviewStats(rows, now), funnel: FN.funnelStats(rows), rows };
}

async function overview(q = {}) {
  await ingestIfStale();
  const now = new Date();
  const w = resolveWindow(q.window || 'this_month', now, { from: q.from, to: q.to });
  const cur = await statsFor(w, now);
  const prevAll = w.prev ? await statsFor({ start: w.prev.start, end: w.prev.end }, now) : null;
  const prev = prevAll && prevAll.stats;
  const days = new Map();
  for (const r of cur.rows) {
    if (!r.createdAt) continue;
    const k = fmtDate(new Date(r.createdAt));
    if (!days.has(k)) days.set(k, { date: k, orders: 0, value: 0, confirmed: 0, cancelled: 0, open: 0 });
    const e = days.get(k); e.orders++; e.value += r.total || 0;
    const st = r.desk && r.desk.stage;
    if (st === 'dispatch' || st === 'dispatched') e.confirmed++; else if (st === 'cancelled') e.cancelled++; else e.open++;
  }
  const slim = (s) => (s ? { totalOrders: s.totalOrders, confirmRate: s.confirmRate, cancelRate: s.cancelRate, value: s.money.all, pendingRate: s.pendingRate } : null);
  return {
    range: { key: w.key, label: w.label, partial: w.partial, start: w.start ? fmtDate(w.start) : null, end: w.end ? fmtDate(new Date(w.end - 1)) : null },
    stats: cur.stats, prev: slim(prev), funnel: cur.funnel, prevFunnel: prevAll && prevAll.funnel, daily: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((d) => ({ ...d, value: D.rupees(d.value) })),
  };
}

// ---------------------------------------------------------------- Order funnel tab: totals, a count per day, and the same counts added up over time
async function funnel(q = {}) {
  await ingestIfStale();
  const now = new Date();
  const w = resolveWindow(q.window || 'this_month', now, { from: q.from, to: q.to });
  const rows = await loadWindow(w);
  const prevRows = w.prev ? await loadWindow({ start: w.prev.start, end: w.prev.end }) : null;
  const end = w.end && w.end > now ? new Date(Math.min(w.end.getTime(), require('../lib/istTime').startOfDay(now).getTime() + 864e5)) : w.end; // a running period stops at today
  return {
    range: { key: w.key, label: w.label, partial: w.partial, start: w.start ? fmtDate(w.start) : null, end: w.start ? fmtDate(new Date((w.end || now).getTime() - 1)) : null },
    stats: FN.funnelStats(rows), prev: prevRows ? FN.funnelStats(prevRows) : null,
    ...FN.funnelDaily(rows, w.start, end),
  };
}

// ---------------------------------------------------------------- refresh now
async function refresh() {
  const shopify = require('./shopifySync');
  const client = require('./shopifyClient');
  if (!client.isConfigured()) throw httpErr(400, 'Shopify is not connected yet. Connect it in Settings first.');
  let pulled = null;
  try { pulled = await shopify.run({}); } catch (e) { if (e.status !== 409) throw e; } // 409 = a sync is already running; use what it has so far
  lastIngest = Date.now();
  const r = await ingest();
  await autoAssign().catch(() => {});
  return { pulled: pulled ? pulled.saved : null, ...r };
}

function start() {
  setTimeout(() => ingestIfStale(0), 15000);
  setInterval(() => ingestIfStale(0), 60 * 1000);
  const every = require('../config').shipway.syncIntervalMin; // the same rhythm as the Shipway sync (0 = only by button)
  if (every > 0 && require('./shipwayClient').isConfigured()) {
    const tick = () => refreshTransit({ limit: 80, minAgeMin: Math.min(30, every) }).catch((e) => { if (e.status !== 409) console.warn('[desk] in-transit refresh failed:', e.message); });
    setTimeout(tick, 45000);
    setInterval(tick, every * 60 * 1000);
  }
}

module.exports = { staleQueue, getAssignConfig, saveAssignConfig, assignOverview, autoAssign, assignManual, assignBulk, rebalance, team, callBoard, analysisData, analysisSheet, getConfig, saveConfig, getDispatchConfig, saveDispatchConfig, liveAwb, dispatchBoard, dispatchHold, dispatchResume, dispatchCancel, dispatchSlip, dispatchPacked, dispatchHandover, proofFile, transitList, refreshTransit, ingest, ingestIfStale, act, savePartial, shotFile, counts, queue, ordersList, orderDetail, overview, funnel, refresh, start, cardOf };
