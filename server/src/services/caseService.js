// Courier problem cases: NDR follow-ups, RTO & returns, weight discrepancy. Read the rules in lib/cases.js.
// NDR and RTO fill themselves from the Shipway status the app already fetches (ShipwayShipment). Weight discrepancy comes from an uploaded Shipway report or a manual entry.
const { ShipCase, ShipwayShipment, ShopifyOrder, DeskOrder, Setting } = require('../models');
const C = require('../lib/cases');
const { resolveWindow } = require('../lib/windows');
const { fmtDate, parseYmd } = require('../lib/istTime');
const desk = require('./deskService');

const httpErr = C.httpErr;
const SHOP_FIELDS = 'orderId name createdAt financialStatus paymentGateways total customer address items itemsSummary';
const day = 86400000;

// ---------------------------------------------------------------- settings
async function getConfig() {
  const s = await Setting.findOne({ key: 'cases.config' }).lean();
  const cur = { ...C.DEFAULT_CASE_CONFIG, ...((s && s.value) || {}) };
  if (!cur.ndrStartFrom) { // like the Shopify desk: old NDRs do not flood the queue on day one. Admins can move the date back.
    cur.ndrStartFrom = fmtDate(new Date(Date.now() - 14 * day));
    await Setting.findOneAndUpdate({ key: 'cases.config' }, { key: 'cases.config', value: cur }, { upsert: true });
  }
  return cur;
}
async function saveConfig(body = {}) {
  const cur = await getConfig();
  const next = { ...C.normaliseCaseConfig(body, cur), ndrStartFrom: cur.ndrStartFrom };
  if (body.ndrStartFrom !== undefined) {
    if (!parseYmd(body.ndrStartFrom)) throw httpErr(400, 'Start date must look like 2026-10-16');
    next.ndrStartFrom = body.ndrStartFrom;
  }
  await Setting.findOneAndUpdate({ key: 'cases.config' }, { key: 'cases.config', value: next }, { upsert: true });
  lastSync = 0; // a new start date or timing applies at once
  return next;
}

// ---------------------------------------------------------------- cards
async function shopMap(ids) {
  const [shops, ships] = await Promise.all([
    ShopifyOrder.find({ orderId: { $in: ids } }).select(SHOP_FIELDS).lean(),
    ShipwayShipment.find({ orderId: { $in: ids }, found: true }).select('orderId status statusCode group carrier awb statusAt checkedAt changedAt history').lean(),
  ]);
  return { shop: new Map(shops.map((s) => [s.orderId, s])), ship: new Map(ships.map((s) => [s.orderId, s])) };
}
// The customer part of a card (name, phone, address, items, amount) reuses the Shopify desk card.
function person(orderId, maps, conf) {
  const c = desk.cardOf({ orderId, stage: 'dispatched', log: [] }, maps.shop.get(orderId), conf, maps.ship.get(orderId));
  return { orderId, orderName: c.orderName, name: c.name, phone: c.phone, wa: c.wa, city: c.city, state: c.state, address: c.address, items: c.items, total: c.total, collect: c.collect, payment: c.payment, financialStatus: c.financialStatus, orderAt: c.orderAt };
}
const caseOut = (c) => ({
  id: String(c._id), type: c.type, orderId: c.orderId, status: c.status, step: c.step, dueAt: c.dueAt || null, openedAt: c.openedAt, source: c.source,
  awb: c.awb || '', courier: c.courier || '', ndr: c.ndr || null, weight: c.weight || null, requestRef: c.requestRef || '', requestAt: c.requestAt || null,
  resolution: c.resolution && c.resolution.outcome ? c.resolution : null, received: c.received && c.received.at ? c.received : null,
  log: (c.log || []).slice(-8),
});

// ---------------------------------------------------------------- NDR
let lastSync = 0; let syncing = null;
async function syncNdr(now = new Date()) {
  const conf = await getConfig();
  const start = parseYmd(conf.ndrStartFrom);
  const ships = await ShipwayShipment.find({ found: true, group: 'ndr' }).select('orderId status statusCode group carrier awb statusAt changedAt checkedAt').lean();
  const wanted = ships.filter((s) => { const at = new Date(s.changedAt || s.statusAt || s.checkedAt || 0); return at >= start; });
  const ids = wanted.map((s) => s.orderId);
  const known = new Set((await ShopifyOrder.find({ orderId: { $in: ids } }).select('orderId').lean()).map((s) => s.orderId)); // a case needs the customer's details
  const have = await ShipCase.find({ type: 'ndr', orderId: { $in: ids } }).select('orderId status resolution openedAt').lean();
  const latest = new Map();
  for (const c of have) { const p = latest.get(c.orderId); if (!p || new Date(c.openedAt) > new Date(p.openedAt)) latest.set(c.orderId, c); }
  const fresh = [];
  for (const s of wanted) {
    if (!known.has(s.orderId)) continue;
    const prev = latest.get(s.orderId);
    const raised = new Date(s.changedAt || s.statusAt || s.checkedAt || now);
    if (prev && (prev.status === 'open' || !prev.resolution || !prev.resolution.at || raised <= new Date(prev.resolution.at))) continue; // already worked, or still the same NDR
    fresh.push({
      type: 'ndr', orderId: s.orderId, status: 'open', step: 1, dueAt: new Date(raised.getTime() + conf.ndrHours[0] * C.HOUR), openedAt: raised, source: 'shipway', awb: s.awb || '', courier: s.carrier || '',
      ndr: { reason: s.status, statusCode: s.statusCode, raisedAt: raised },
      log: [{ at: now, by: 'Shipway', byId: 'system', step: 1, action: 'opened', label: `Courier could not deliver: ${s.status}`, note: '' }],
    });
  }
  if (fresh.length) await ShipCase.insertMany(fresh, { ordered: false }).catch((e) => { if (!e.writeErrors && e.code !== 11000) throw e; });
  // a shipment that is no longer undelivered closes its own case
  const open = await ShipCase.find({ type: 'ndr', status: 'open' }).lean();
  if (open.length) {
    const cur = new Map((await ShipwayShipment.find({ orderId: { $in: open.map((c) => c.orderId) }, found: true }).select('orderId group status').lean()).map((s) => [s.orderId, s]));
    for (const c of open) {
      const t = C.ndrAutoClose(c, cur.get(c.orderId), now);
      if (t) await ShipCase.updateOne({ _id: c._id, rev: c.rev || 0, status: 'open' }, { $set: t.set, $push: { log: { $each: t.entries } }, $inc: { rev: 1 } });
    }
  }
  return { added: fresh.length };
}
async function syncIfStale(ms = 30000) {
  if (syncing) return syncing;
  if (Date.now() - lastSync < ms) return null;
  lastSync = Date.now();
  syncing = syncNdr().catch((e) => console.warn('[cases] NDR sync failed:', e.message)).finally(() => { syncing = null; });
  return syncing;
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function searchOrderIds(q) {
  const t = String(q || '').trim().replace(/^#/, '');
  if (!t) return null;
  const or = [];
  if (/^\d{1,9}$/.test(t)) or.push({ orderId: Number(t) });
  const digits = t.replace(/\D/g, '');
  if (digits.length >= 4) or.push({ 'customer.phone': new RegExp(`${esc(digits.slice(-10))}$`) }, { 'address.phone': new RegExp(`${esc(digits.slice(-10))}$`) });
  const rx = new RegExp(esc(t), 'i');
  or.push({ 'customer.name': rx }, { 'address.name': rx });
  const hits = (await ShopifyOrder.find({ $or: or }).select('orderId').limit(2000).lean()).map((o) => o.orderId);
  const byAwb = (await ShipwayShipment.find({ awb: rx }).select('orderId').limit(200).lean()).map((s) => s.orderId);
  return [...new Set([...hits, ...byAwb])];
}

async function ndrBoard(q = {}) {
  await syncIfStale();
  const now = new Date();
  const conf = await getConfig();
  const dconf = await desk.getConfig();
  const ids = await searchOrderIds(q.q);
  const f = ids ? { orderId: { $in: ids } } : {};
  const [open, done, openCount, dueCount, doneCount] = await Promise.all([
    ShipCase.find({ type: 'ndr', status: 'open', ...f }).sort({ dueAt: 1 }).limit(1000).lean(),
    ShipCase.find({ type: 'ndr', status: 'resolved', ...f }).sort({ 'resolution.at': -1 }).limit(60).lean(),
    ShipCase.countDocuments({ type: 'ndr', status: 'open' }),
    ShipCase.countDocuments({ type: 'ndr', status: 'open', dueAt: { $lte: now } }),
    ShipCase.countDocuments({ type: 'ndr', status: 'resolved' }),
  ]);
  const maps = await shopMap([...new Set([...open, ...done].map((c) => c.orderId))]);
  const card = (c) => ({ ...person(c.orderId, maps, dconf), shipway: maps.ship.get(c.orderId) ? { status: maps.ship.get(c.orderId).status, carrier: maps.ship.get(c.orderId).carrier, awb: maps.ship.get(c.orderId).awb } : null, case: caseOut(c) });
  const columns = { 1: [], 2: [], 3: [] };
  for (const c of open) if (columns[c.step]) columns[c.step].push(card(c));
  return { now, config: conf, counts: { open: openCount, due: dueCount, resolved: doneCount }, columns, resolved: done.map(card), shown: open.length };
}

async function ndrSubmit(user, orderId, { outcome, note }) {
  const c = await ShipCase.findOne({ type: 'ndr', orderId, status: 'open' }).lean();
  if (!c) throw httpErr(404, `Order #${orderId} has no open NDR. Refresh to see its latest status.`);
  const t = C.ndrAction(c, outcome, note, user, await getConfig());
  const upd = await ShipCase.findOneAndUpdate({ _id: c._id, rev: c.rev || 0 }, { $set: t.set, $push: { log: { $each: t.entries } }, $inc: { rev: 1 } }, { new: true }).lean();
  if (!upd) throw httpErr(409, 'Someone else just updated this order. Refresh to see its latest status.');
  return caseOut(upd);
}

// ---------------------------------------------------------------- RTO & returns
async function rtoList(q = {}) {
  const now = new Date();
  const key = q.window || 'this_week';
  const w = key === 'all_time' ? { key, label: 'All time', start: null, end: null } : resolveWindow(key, now, { from: q.from, to: q.to });
  const ships = await ShipwayShipment.find({ found: true, group: 'rto' }).select('orderId status statusCode group carrier awb statusAt checkedAt changedAt history').lean();
  const ids = ships.map((s) => s.orderId);
  const [ticks, shops] = await Promise.all([
    ShipCase.find({ type: 'rto', orderId: { $in: ids }, 'received.at': { $ne: null } }).select('orderId received').lean(),
    ShopifyOrder.find({ orderId: { $in: ids } }).select(SHOP_FIELDS).lean(),
  ]);
  const dconf = await desk.getConfig();
  const maps = { shop: new Map(shops.map((s) => [s.orderId, s])), ship: new Map() };
  const tBy = new Map(ticks.map((t) => [t.orderId, t.received]));
  const search = await searchOrderIds(q.q);
  const sset = search ? new Set(search) : null;
  const all = ships.map((s) => {
    const rec = tBy.get(s.orderId) || null;
    const since = C.rtoSince(s);
    const p = person(s.orderId, maps, dconf);
    return { ...p, awb: s.awb || '', courier: s.carrier || '', shipStatus: s.status, statusCode: s.statusCode, since, days: since ? Math.max(0, Math.floor((now - new Date(since)) / day)) : null, state: C.rtoState(s, !!rec), received: rec ? { at: rec.at, by: rec.by, note: rec.note } : null };
  });
  const stats = C.rtoStats(all, w.start ? { start: w.start, end: w.end } : null);
  const show = ['new', 'pending', 'received', 'all'].includes(q.show) ? q.show : 'new';
  const inRange = (x) => !w.start || (x.since && new Date(x.since) >= w.start && new Date(x.since) < w.end);
  let rows = all.filter((x) => (show === 'new' ? inRange(x) : show === 'pending' ? x.state !== 'received' : show === 'received' ? x.state === 'received' : true));
  if (sset) rows = rows.filter((x) => sset.has(x.orderId));
  if (q.state && ['on_way', 'at_origin'].includes(q.state)) rows = rows.filter((x) => x.state === q.state);
  rows.sort((a, b) => new Date(b.since || 0) - new Date(a.since || 0));
  const limit = Math.min(300, Math.max(1, parseInt(q.limit) || 100));
  const page = Math.max(1, parseInt(q.page) || 1);
  const value = (list) => Math.round(list.reduce((n, x) => n + (x.total || 0), 0));
  return {
    now, range: { key: w.key, label: w.label, start: w.start ? fmtDate(w.start) : null, end: w.end ? fmtDate(new Date(w.end - 1)) : null },
    stats: { ...stats, pendingValue: value(all.filter((x) => x.state !== 'received')), receivedInRange: all.filter((x) => x.state === 'received' && x.received && inRange({ since: x.received.at })).length },
    total: rows.length, page, limit, items: rows.slice((page - 1) * limit, page * limit),
  };
}

async function rtoMark(user, orderId, { received, note }) {
  const ship = await ShipwayShipment.findOne({ orderId, found: true, group: 'rto' }).select('awb carrier').lean();
  if (!ship) throw httpErr(404, `Order #${orderId} is not an RTO in Shipway.`);
  const now = new Date(); const n = C.cleanNote(note);
  const entry = { at: now, by: user.name, byId: user.id, step: 1, action: received ? 'received' : 'unreceived', label: received ? `Marked received back${n ? ` · ${n}` : ''}` : `Received tick removed${n ? ` · ${n}` : ''}`, note: n };
  await ShipCase.findOneAndUpdate({ type: 'rto', orderId }, {
    $set: { received: received ? { at: now, by: user.name, byId: user.id, note: n } : { at: null, by: '', byId: '', note: n }, awb: ship.awb || '', courier: ship.carrier || '' },
    $setOnInsert: { type: 'rto', orderId, status: 'open', source: 'shipway', openedAt: now },
    $push: { log: entry }, $inc: { rev: 1 },
  }, { upsert: true });
  return { orderId, received: !!received };
}

// ---------------------------------------------------------------- weight discrepancy
async function resolveOrders(rows) {
  const awbs = [...new Set(rows.filter((r) => !r.orderId && r.awb).map((r) => r.awb))];
  const map = new Map();
  if (awbs.length) {
    const [a, b, c] = await Promise.all([
      ShipwayShipment.find({ awb: { $in: awbs } }).select('orderId awb').lean(),
      DeskOrder.find({ 'dq.packed.awb': { $in: awbs } }).select('orderId dq.packed.awb').lean(),
      ShopifyOrder.find({ 'tracking.number': { $in: awbs } }).select('orderId tracking').lean(),
    ]);
    for (const s of a) map.set(String(s.awb).toUpperCase(), s.orderId);
    for (const d of b) map.set(String(d.dq.packed.awb).toUpperCase(), d.orderId);
    for (const o of c) for (const t of o.tracking || []) map.set(String(t.number).toUpperCase(), o.orderId);
  }
  return map;
}
const newWeight = (r, orderId, source, batch, now) => ({
  type: 'weight', orderId: orderId || null, status: 'open', step: 1, openedAt: r.raisedAt || now, source, awb: r.awb || '', courier: r.courier || '',
  weight: { declaredG: r.declaredG, chargedG: r.chargedG, diffG: r.diffG, extraCharge: r.extraCharge, raisedAt: r.raisedAt || null, batch },
  log: [{ at: now, by: source === 'upload' ? 'Shipway report' : 'Manual', byId: 'system', step: 1, action: 'opened', label: `Weight discrepancy ${r.diffG != null ? `${r.diffG > 0 ? '+' : ''}${r.diffG} g` : ''}${r.extraCharge != null ? ` · extra charge ₹${r.extraCharge}` : ''}`.trim(), note: '' }],
});
const sameNumbers = (c, r) => c.weight && c.weight.chargedG === r.chargedG && c.weight.extraCharge === r.extraCharge && c.weight.declaredG === r.declaredG;

// A Shipway report as a CSV or an Excel file -> array of objects keyed by the header row.
async function readSheetFile(file) {
  if (!file || !file.buffer || !file.buffer.length) throw httpErr(400, 'Choose the Shipway weight discrepancy file first.');
  const name = String(file.originalname || '').toLowerCase();
  let grid;
  if (/\.xlsx$/.test(name)) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(file.buffer); } catch (e) { throw httpErr(400, 'That Excel file could not be read. Save it as .xlsx or .csv and try again.'); }
    const ws = wb.worksheets[0];
    if (!ws) throw httpErr(400, 'The Excel file has no sheet.');
    grid = [];
    ws.eachRow({ includeEmpty: false }, (row) => grid.push(row.values.slice(1).map((v) => (v && typeof v === 'object' && v.result !== undefined ? v.result : v && typeof v === 'object' && v.text !== undefined ? v.text : v))));
  } else if (/\.csv$/.test(name) || /text|csv/.test(file.mimetype || '')) {
    const { parseCsv } = require('./sources');
    try { grid = parseCsv(file.buffer.toString('utf8')); } catch (e) { throw httpErr(400, 'That CSV file could not be read.'); }
  } else throw httpErr(400, 'Upload the report as .xlsx or .csv.');
  grid = grid.filter((r) => r.some((v) => v !== null && v !== undefined && String(v).trim() !== ''));
  if (grid.length < 2) throw httpErr(400, 'The file has no rows under the header.');
  const head = grid[0].map((h) => String(h == null ? '' : h).trim());
  return grid.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h || `col${i}`, r[i]])));
}

// parsed: result of C.parseWeightRows
async function weightImport(user, parsed, fileName) {
  if (parsed.error) throw httpErr(400, parsed.error);
  const now = new Date();
  const batch = `${fileName || 'upload'} · ${now.toISOString()}`;
  const byAwb = await resolveOrders(parsed.rows);
  const existing = await ShipCase.find({ type: 'weight' }).select('orderId awb weight status').lean();
  const fresh = []; const duplicates = []; const unmatched = [];
  for (const r of parsed.rows) {
    const orderId = r.orderId || byAwb.get(r.awb) || null;
    if (!orderId) unmatched.push({ line: r.line, awb: r.awb });
    const dup = existing.some((c) => (orderId ? c.orderId === orderId : c.awb === r.awb) && sameNumbers(c, r)) || fresh.some((c) => (orderId ? c.orderId === orderId : c.awb === r.awb) && sameNumbers(c, r));
    if (dup) { duplicates.push(r.line); continue; }
    fresh.push(newWeight(r, orderId, 'upload', batch, now));
  }
  if (fresh.length) await ShipCase.insertMany(fresh);
  return { added: fresh.length, duplicates: duplicates.length, unmatched: unmatched.length, skipped: parsed.skipped, columns: parsed.columns, by: user.name };
}

async function weightAdd(user, b) {
  const orderId = Number(String(b.orderId || '').replace(/^#/, ''));
  if (!Number.isInteger(orderId) || orderId <= 0) throw httpErr(400, 'Enter the order number');
  const unit = b.unit === 'g' ? 'g' : 'kg';
  const r = { orderId, awb: String(b.awb || '').trim().toUpperCase(), declaredG: C.gramsOf(b.declared, unit), chargedG: C.gramsOf(b.charged, unit), extraCharge: C.numberOf(b.extraCharge), courier: String(b.courier || '').trim(), raisedAt: null };
  if (r.declaredG == null || r.chargedG == null) throw httpErr(400, 'Enter both the weight you declared and the weight the courier charged');
  r.diffG = r.chargedG - r.declaredG;
  const open = await ShipCase.findOne({ type: 'weight', orderId, status: 'open' }).lean();
  if (open) throw httpErr(409, `Order #${orderId} already has an open weight discrepancy.`);
  const doc = await ShipCase.create(newWeight(r, orderId, 'manual', 'manual', new Date()));
  return caseOut(doc.toObject());
}

async function weightBoard(q = {}) {
  const dconf = await desk.getConfig();
  const ids = await searchOrderIds(q.q);
  const f = ids ? { orderId: { $in: ids } } : {};
  const [open, done, resolvedCount] = await Promise.all([
    ShipCase.find({ type: 'weight', status: 'open', ...f }).sort({ openedAt: 1 }).limit(1000).lean(),
    ShipCase.find({ type: 'weight', status: 'resolved', ...f }).sort({ 'resolution.at': -1 }).limit(100).lean(),
    ShipCase.countDocuments({ type: 'weight', status: 'resolved' }),
  ]);
  const maps = await shopMap([...new Set([...open, ...done].map((c) => c.orderId).filter(Boolean))]);
  const card = (c) => ({ ...(c.orderId ? person(c.orderId, maps, dconf) : { orderId: null, orderName: 'Unmatched', name: null, phone: null, items: '', total: null }), case: caseOut(c) });
  const columns = { 1: [], 2: [], 3: [] };
  for (const c of open) if (columns[c.step]) columns[c.step].push(card(c));
  const sum = (list, pick) => Math.round(list.reduce((n, c) => n + (pick(c) || 0), 0) * 100) / 100;
  return {
    now: new Date(), columns, resolved: done.map(card), shown: open.length,
    counts: { open: open.length, resolved: resolvedCount, byStep: [1, 2, 3].map((n) => columns[n].length) },
    money: { openCharges: sum(open, (c) => c.weight && c.weight.extraCharge), recovered: sum(done, (c) => c.resolution && c.resolution.amount), rejected: sum(done.filter((c) => c.resolution && c.resolution.outcome === 'rejected'), (c) => c.weight && c.weight.extraCharge) },
  };
}

async function weightSubmit(user, id, input) {
  if (!/^[0-9a-f]{24}$/i.test(String(id))) throw httpErr(404, 'Case not found');
  const c = await ShipCase.findOne({ _id: id, type: 'weight' }).lean();
  if (!c) throw httpErr(404, 'Case not found');
  const t = C.weightAction(c, input, user);
  const upd = await ShipCase.findOneAndUpdate({ _id: c._id, rev: c.rev || 0 }, { $set: t.set, $push: { log: { $each: t.entries } }, $inc: { rev: 1 } }, { new: true }).lean();
  if (!upd) throw httpErr(409, 'Someone else just updated this case. Refresh to see its latest status.');
  return caseOut(upd);
}

// ---------------------------------------------------------------- numbers for the sidebar
async function counts() {
  await syncIfStale(60000);
  const now = new Date();
  const [ndrOpen, ndrDue, weightOpen, rtoShips, rtoRecv] = await Promise.all([
    ShipCase.countDocuments({ type: 'ndr', status: 'open' }),
    ShipCase.countDocuments({ type: 'ndr', status: 'open', dueAt: { $lte: now } }),
    ShipCase.countDocuments({ type: 'weight', status: 'open' }),
    ShipwayShipment.countDocuments({ found: true, group: 'rto' }),
    ShipCase.countDocuments({ type: 'rto', 'received.at': { $ne: null } }),
  ]);
  return { ndr: { open: ndrOpen, due: ndrDue }, weight: { open: weightOpen }, rto: { pending: Math.max(0, rtoShips - rtoRecv) } };
}

function start() {
  setTimeout(() => syncIfStale(0), 25000);
  setInterval(() => syncIfStale(0), 2 * 60 * 1000);
}

module.exports = { readSheetFile, getConfig, saveConfig, syncNdr, ndrBoard, ndrSubmit, rtoList, rtoMark, weightImport, weightAdd, weightBoard, weightSubmit, counts, start };
