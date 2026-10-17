// Shopify Desk: reads orders from Shopify only, keeps one DeskOrder per order, and applies the rules in lib/desk.js.
// Every change is checked against the state the person saw (rev), stamped with who did it, and appended to the order's log.
const crypto = require('crypto');
const { DeskOrder, DeskShot, DispatchProof, ShopifyOrder, ShipwayShipment, Setting } = require('../models');
const D = require('../lib/desk');
const DP = require('../lib/dispatch');
const F = require('../lib/flow');
const { resolveWindow } = require('../lib/windows');
const { parseYmd, fmtDate } = require('../lib/istTime');

const httpErr = D.httpErr;
const ACTIVE = ['confirm', 'pending', 'dispatch'];

// ---------------------------------------------------------------- settings
// The queue starts from the day the desk was first opened, so the last 60 days of old orders do not flood it. Admins can move the date back.
async function getConfig() {
  const s = await Setting.findOne({ key: 'desk.config' }).lean();
  const cur = { ...D.DEFAULT_CONFIG, ...((s && s.value) || {}) };
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
  return { added: fresh.length, cancelled };
}
let lastIngest = 0;
async function ingestIfStale(maxAgeMs = 15000) {
  if (Date.now() - lastIngest < maxAgeMs) return;
  lastIngest = Date.now();
  try { await ingest(); } catch (e) { console.warn('[desk] ingest failed:', e.message); }
}

// ---------------------------------------------------------------- actions
async function applyTransition(doc, t) {
  const upd = await DeskOrder.findOneAndUpdate({ orderId: doc.orderId, rev: doc.rev || 0 }, { $set: t.set, $push: { log: { $each: t.entries } }, $inc: { rev: 1 } }, { new: true }).lean();
  if (!upd) throw httpErr(409, 'Someone else just updated this order. Refresh to see its latest status.');
  return upd;
}
async function loadForAction(orderId) {
  const doc = await DeskOrder.findOne({ orderId }).lean();
  if (!doc) throw httpErr(404, `Order #${orderId} is not in the Shopify Desk`);
  const so = await ShopifyOrder.findOne({ orderId }).select('total').lean();
  return { doc, total: so ? so.total : null };
}

async function act(user, orderId, action, input = {}) {
  if (action === 'partial_paid') throw httpErr(400, 'Use the partial payment form');
  const { doc, total } = await loadForAction(orderId);
  const t = D.transition(doc, action, input, await getConfig(), user, { total, orderId });
  return brief(await applyTransition(doc, t));
}

async function savePartial(user, orderId, { amount, notes, file }) {
  const { doc, total } = await loadForAction(orderId);
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
  const last = (desk.log || []).filter((e) => e.action !== 'enter_queue').slice(-1)[0];
  return {
    orderId: desk.orderId, orderName: s.name || `#${desk.orderId}`, orderAt: desk.orderAt, stage: desk.stage, fuNo: desk.fuNo, fu: D.fuLabel(desk), status: D.statusLabel(desk),
    dueAt: desk.dueAt || null, pendingSince: desk.pendingSince || null, dnpCount: desk.dnpCount || 0, lastDnpAt: desk.lastDnpAt || null, lastAction: last ? { label: last.label, by: last.by, at: last.at } : null,
    name: c.name || a.name || null, phone: D.dialNumber(rawPhone), wa: D.waLink(rawPhone, text), email: c.email || null,
    city: a.city || null, state: a.state || null, address: addressLine(a),
    items: s.itemsSummary || '', itemsList: s.items || [], total, collect, payment: paymentLabel(s), financialStatus: s.financialStatus || '',
    source: s.marketing && (s.marketing.sourceGroup || s.marketing.utmSource) || '', campaign: s.marketing && s.marketing.utmCampaign || '',
    partial: desk.partial && desk.partial.amount ? desk.partial : null, cancel: desk.cancel && desk.cancel.reason ? desk.cancel : null,
    dispatch: desk.dispatch && desk.dispatch.at ? desk.dispatch : null, confirmedAt: desk.confirmedAt || null, confirmedAtFu: desk.confirmedAtFu || '',
    shipway: ship ? { status: ship.status, group: ship.group, carrier: ship.carrier, awb: ship.awb } : null,
    dq: desk.dq && desk.dq.step ? { step: desk.dq.step, slip: desk.dq.slip || null, packed: desk.dq.packed || null, handover: desk.dq.handover || null } : null,
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

// Reads one order's tracking number(s) straight from Shopify (the packing person may open the form seconds after the label was made).
async function liveAwb(orderId) {
  const have = await ShopifyOrder.findOne({ orderId }).select('tracking').lean();
  let tracking = (have && have.tracking) || [];
  const client = require('./shopifyClient');
  if (client.isConfigured()) {
    try {
      const node = await client.fetchByNumber(orderId);
      const doc = node && require('../lib/shopifyMap').normalizeOrder(node);
      if (doc && doc.orderId === orderId) {
        tracking = doc.tracking || [];
        await ShopifyOrder.updateOne({ orderId }, { $set: { tracking } });
      }
    } catch (e) { /* Shopify busy or offline: fall back to what is saved */ }
  }
  const ship = await ShipwayShipment.findOne({ orderId, found: true }).select('awb carrier').lean();
  const t = tracking[0];
  if (t && t.number) return { awb: t.number, courier: t.company || (ship && ship.carrier) || '', source: 'Shopify' };
  if (ship && ship.awb) return { awb: ship.awb, courier: ship.carrier || '', source: 'Shipway' };
  return { awb: '', courier: '', source: null };
}

async function dispatchBoard(opts = {}) {
  await ingestIfStale();
  const now = new Date();
  const dconf = await getDispatchConfig();
  const filter = { stage: 'dispatch' };
  const ids = await searchIds(opts.q);
  if (ids) filter.orderId = { $in: ids };
  const desks = await DeskOrder.find(filter).sort({ confirmedAt: 1 }).limit(500).lean();
  const orderIds = desks.map((d) => d.orderId);
  const [cards, trk, all] = await Promise.all([
    withShop(desks, { ship: true }),
    ShopifyOrder.find({ orderId: { $in: orderIds } }).select('orderId tracking').lean(),
    DeskOrder.find({ stage: 'dispatch' }).select('orderId dq confirmedAt orderAt').lean(),
  ]);
  const tBy = new Map(trk.map((x) => [x.orderId, x.tracking || []]));
  const columns = { slip: [], packed: [], handover: [] };
  cards.forEach((c, i) => {
    const d = desks[i]; const step = DP.stepOf(d); const due = DP.dueAt(d, dconf);
    const t = (tBy.get(c.orderId) || [])[0];
    columns[step].push({
      ...c,
      dq: {
        step, stepAt: DP.stepStart(d), dueAt: due, overdue: !!due && due.getTime() < now.getTime(),
        slip: (d.dq && d.dq.slip) || null, packed: (d.dq && d.dq.packed) || null,
        suggestedAwb: (t && t.number) || (c.shipway && c.shipway.awb) || '',
        suggestedCourier: (t && t.company) || (c.shipway && c.shipway.carrier) || '',
      },
    });
  });
  for (const k of DP.STEPS) columns[k].sort((a, b) => new Date(a.dq.dueAt || 0) - new Date(b.dq.dueAt || 0));
  const collect = cards.reduce((n, c) => n + (c.collect || 0), 0);
  return { now, config: dconf, columns, counts: DP.stepCounts(all, dconf, now), collectTotal: D.rupees(collect), shown: cards.length };
}

async function dispatchSlip(user, orderId) {
  const { doc } = await loadForAction(orderId);
  const t = DP.slipDone(doc, await getDispatchConfig(), user);
  return brief(await applyTransition(doc, t));
}

const PHOTO_ERR = 'The file must be a photo (JPG, PNG or WebP).';
async function storeProof(kind, file, user, extra) {
  return DispatchProof.create({ kind, ...extra, mime: F.mimeOf(file.buffer), size: file.buffer.length, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), data: file.buffer, byName: user.name });
}

async function dispatchPacked(user, orderId, { awb, courier, file }) {
  const { doc } = await loadForAction(orderId);
  const dconf = await getDispatchConfig();
  if (file && F.sniffMedia(file.buffer) !== 'photo') throw httpErr(400, PHOTO_ERR);
  const input = { awb, courier, photoId: file ? 'pending' : null };
  DP.packedDone(doc, input, dconf, user); // dry run: every rule is checked before anything is stored
  const clean = DP.cleanAwb(awb);
  const clash = await DeskOrder.findOne({ orderId: { $ne: orderId }, 'dq.packed.awb': clean }).select('orderId').lean();
  if (clash) throw httpErr(409, `AWB ${clean} is already on order #${clash.orderId}. Check the number on the label.`);
  const proof = file ? await storeProof('package', file, user, { orderId }) : null;
  try {
    const t = DP.packedDone(doc, { awb, courier, photoId: proof ? String(proof._id) : null }, dconf, user);
    return brief(await applyTransition(doc, t));
  } catch (e) {
    if (proof) await DispatchProof.deleteOne({ _id: proof._id }).catch(() => {});
    throw e;
  }
}

// One manifest photo can cover a whole courier pickup: orderIds is every order on it. All are checked first, then saved.
async function dispatchHandover(user, orderIds, { courier, file }) {
  const ids = [...new Set((orderIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw httpErr(400, 'Pick at least one order');
  if (ids.length > DP.MAX_HANDOVER_BATCH) throw httpErr(400, `Hand over at most ${DP.MAX_HANDOVER_BATCH} orders on one manifest`);
  const dconf = await getDispatchConfig();
  if (file && F.sniffMedia(file.buffer) !== 'photo') throw httpErr(400, PHOTO_ERR);
  const docs = await DeskOrder.find({ orderId: { $in: ids } }).lean();
  const by = new Map(docs.map((d) => [d.orderId, d]));
  const problems = [];
  for (const id of ids) {
    const d = by.get(id);
    if (!d) { problems.push(`#${id}: not in the Shopify Desk`); continue; }
    try { DP.handoverDone(d, { courier, manifestId: file ? 'pending' : null }, dconf, user); } catch (e) { problems.push(`#${id}: ${e.message}`); }
  }
  if (problems.length) throw httpErr(409, `Nothing was saved. ${problems.join(' ')}`);
  const proof = file ? await storeProof('manifest', file, user, { orderIds: ids }) : null;
  const done = []; const failed = [];
  for (const id of ids) {
    try {
      const t = DP.handoverDone(by.get(id), { courier, manifestId: proof ? String(proof._id) : null }, dconf, user);
      done.push(brief(await applyTransition(by.get(id), t)));
    } catch (e) { failed.push({ orderId: id, error: e.message }); }
  }
  if (!done.length && proof) await DispatchProof.deleteOne({ _id: proof._id }).catch(() => {});
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
      manifestId: (d.dq && d.dq.handover && d.dq.handover.manifestId) || null, packagePhotoId: (d.dq && d.dq.packed && d.dq.packed.photoId) || null,
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
      total: s.total, payment: paymentLabel(s), financialStatus: s.financialStatus, stage: d ? d.stage : 'none', fu: d ? D.fuLabel(d) : '', status: D.statusLabel(d),
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
  if (!desk) card.status = 'Not in queue';
  return {
    card, inQueue: !!desk,
    shopify: shop ? { ...shop, _id: undefined } : null,
    log: desk ? desk.log : [],
    shipway: ship ? { status: ship.status, carrier: ship.carrier, awb: ship.awb, statusAt: ship.statusAt, checkedAt: ship.checkedAt } : null,
    queueStart: conf.startFrom,
  };
}

// ---------------------------------------------------------------- Overview
async function statsFor(w, now) {
  const base = { test: { $ne: true } };
  if (w.start) base.createdAt = { $gte: w.start, $lt: w.end };
  const shops = await ShopifyOrder.find(base).select('orderId total createdAt').limit(50000).lean();
  const desks = await DeskOrder.find({ orderId: { $in: shops.map((s) => s.orderId) } }).lean();
  const dBy = new Map(desks.map((d) => [d.orderId, d]));
  const rows = shops.map((s) => ({ desk: dBy.get(s.orderId) || null, total: s.total, createdAt: s.createdAt }));
  return { stats: D.overviewStats(rows, now), rows };
}

async function overview(q = {}) {
  await ingestIfStale();
  const now = new Date();
  const w = resolveWindow(q.window || 'this_month', now, { from: q.from, to: q.to });
  const cur = await statsFor(w, now);
  const prev = w.prev ? (await statsFor({ start: w.prev.start, end: w.prev.end }, now)).stats : null;
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
    stats: cur.stats, prev: slim(prev), daily: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((d) => ({ ...d, value: D.rupees(d.value) })),
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

module.exports = { getConfig, saveConfig, getDispatchConfig, saveDispatchConfig, liveAwb, dispatchBoard, dispatchSlip, dispatchPacked, dispatchHandover, proofFile, transitList, refreshTransit, ingest, ingestIfStale, act, savePartial, shotFile, counts, queue, ordersList, orderDetail, overview, refresh, start, cardOf };
