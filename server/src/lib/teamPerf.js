// Team performance rules: pure functions only (no database, no network), so every number can be unit-tested.
// The service (services/teamPerfService.js) loads the rows; this file turns them into what the Team performance page shows.
//
// What counts as one piece of work (an "action"), counted on the day it was DONE (not the order date):
//   calls     : dnp (call not answered), confirm, partial (partial paid), cancel (cancelled by a person)
//   dispatch  : slip (packing slip done), packed, handover (handed to the courier)
// System and Shopify actions (auto-cancel, assignment, "cancelled in Shopify") never count for anyone.
const { DAY, fmtDate, istParts } = require('./istTime');
const DP = require('./dispatch');

const HOUR = 3600 * 1000;
const CALL_KINDS = ['dnp', 'confirm', 'partial', 'cancel'];
const DISPATCH_KINDS = ['slip', 'packed', 'handover'];
const KINDS = [...CALL_KINDS, ...DISPATCH_KINDS];
const MAX_DAYS = 366;

// Shopify Desk log action -> kind
const DESK_ACTION = { dnp: 'dnp', confirm: 'confirm', partial_paid: 'partial', cancel: 'cancel', slip_done: 'slip', packed: 'packed' };
// Sheet-based Confirm queue / Dispatch desk (FlowEvent) action -> kind
const FLOW_ACTION = { no_answer: 'dnp', confirm: 'confirm', partial_pay: 'partial', cancel: 'cancel', slip_printed: 'slip', packed: 'packed', dispatched: 'handover' };

const isHuman = (name, id) => !!name && name !== 'System' && name !== 'Shopify' && id !== 'system';
const ratio = (n, d) => ({ n, d, v: d ? (n / d) * 100 : null });
const inRange = (t, r) => t >= r.start.getTime() && t < r.end.getTime();

// ------------------------------------------------------------------------------------------------ normalise
// Returns { events, decisions }.
//  events    : [{ at: ms, id, name, kind, orderId, late: true|false|null, amount }]
//  decisions : [{ at: ms, id, name, orderId, ms }]  (the first final decision on an order: how long after the order it came)
function fromDesk(docs) {
  const events = []; const decisions = [];
  for (const d of docs) {
    const dq = d.dq || {};
    let firstDecision = null;
    for (const e of d.log || []) {
      if (!isHuman(e.by, e.byId)) continue;
      const kind = DESK_ACTION[e.action];
      if (kind === 'slip' || kind === 'packed') continue; // dispatch steps are read from dq below (they carry the on-time flag)
      if (e.action === 'dispatch') { // the hand-over to the courier; orders from before the 3-step dispatch queue have no dq.handover
        if (dq.handover && dq.handover.at) continue;
        events.push({ at: new Date(e.at).getTime(), id: e.byId || null, name: e.by, kind: 'handover', orderId: d.orderId, late: null });
        continue;
      }
      if (!kind) continue;
      const at = new Date(e.at).getTime();
      events.push({ at, id: e.byId || null, name: e.by, kind, orderId: d.orderId, late: null, amount: e.amount });
      if ((kind === 'confirm' || kind === 'partial' || kind === 'cancel') && !firstDecision) firstDecision = { at, id: e.byId || null, name: e.by };
    }
    if (firstDecision && d.orderAt) decisions.push({ ...firstDecision, orderId: d.orderId, ms: Math.max(0, firstDecision.at - new Date(d.orderAt).getTime()) });
    for (const [step, kind] of [['slip', 'slip'], ['packed', 'packed'], ['handover', 'handover']]) {
      const s = dq[step];
      if (!s || !s.at || !isHuman(s.byName, s.byId)) continue;
      events.push({ at: new Date(s.at).getTime(), id: s.byId || null, name: s.byName, kind, orderId: d.orderId, late: typeof s.late === 'boolean' ? s.late : null });
    }
  }
  return { events, decisions };
}

function fromFlow(flowEvents, flowDecisions) {
  const events = [];
  for (const e of flowEvents || []) {
    const kind = FLOW_ACTION[e.action];
    if (!kind || !isHuman(e.byName, e.byId)) continue;
    events.push({ at: new Date(e.at).getTime(), id: e.byId || null, name: e.byName, kind, orderId: e.orderId, late: null, amount: e.meta && e.meta.amount });
  }
  const decisions = [];
  for (const f of flowDecisions || []) {
    if (!f.decidedAt || !f.orderAt || !isHuman(f.decidedByName, f.decidedById)) continue;
    decisions.push({ at: new Date(f.decidedAt).getTime(), id: f.decidedById || null, name: f.decidedByName, orderId: f.orderId, ms: Math.max(0, new Date(f.decidedAt).getTime() - new Date(f.orderAt).getTime()) });
  }
  return { events, decisions };
}

// ------------------------------------------------------------------------------------------------ people
// Everyone with a login is listed (so someone who did nothing shows up as zero), plus anyone who did work under a name we no longer have a login for.
function makeResolver(users) {
  const byId = new Map(users.map((u) => [String(u.id), u]));
  const byName = new Map(users.map((u) => [String(u.name).trim().toLowerCase(), u]));
  const extra = new Map();
  return (id, name) => {
    const u = (id && byId.get(String(id))) || byName.get(String(name || '').trim().toLowerCase());
    if (u) return u;
    const key = `n:${String(name || '').trim().toLowerCase()}`;
    if (!extra.has(key)) extra.set(key, { id: key, name: String(name || 'Unknown'), role: null, active: false, former: true });
    return extra.get(key);
  };
}

const emptyStats = () => ({
  dnp: 0, confirm: 0, partial: 0, cancel: 0, slip: 0, packed: 0, handover: 0,
  late: { slip: 0, packed: 0, handover: 0 }, timed: { slip: 0, packed: 0, handover: 0 },
  decisionMs: 0, decisionN: 0, valueWon: 0, collected: 0, days: new Set(), firstAt: null, lastAt: null, series: new Map(),
});

// bucketOf(ms) -> key used for the trend series
function tally(events, decisions, range, resolve, totals, bucketOf) {
  const by = new Map();
  const get = (id, name) => { const u = resolve(id, name); if (!by.has(u.id)) by.set(u.id, { user: u, s: emptyStats() }); return by.get(u.id).s; };
  for (const e of events) {
    if (!inRange(e.at, range)) continue;
    const s = get(e.id, e.name);
    s[e.kind]++;
    if (e.late !== null && e.late !== undefined && DISPATCH_KINDS.includes(e.kind)) { s.timed[e.kind]++; if (e.late) s.late[e.kind]++; }
    if ((e.kind === 'confirm' || e.kind === 'partial') && totals) s.valueWon += totals.get(e.orderId) || 0;
    if (e.kind === 'partial' && e.amount) s.collected += Number(e.amount) || 0;
    s.days.add(fmtDate(new Date(e.at)));
    s.firstAt = s.firstAt == null ? e.at : Math.min(s.firstAt, e.at);
    s.lastAt = s.lastAt == null ? e.at : Math.max(s.lastAt, e.at);
    const b = bucketOf(e.at);
    s.series.set(b, (s.series.get(b) || 0) + 1);
  }
  for (const x of decisions) {
    if (!inRange(x.at, range)) continue;
    const s = get(x.id, x.name);
    s.decisionMs += x.ms; s.decisionN++;
  }
  return by;
}

const callsOf = (s) => s.dnp + s.confirm + s.partial + s.cancel;
const dispatchOf = (s) => s.slip + s.packed + s.handover;
const totalOf = (s) => callsOf(s) + dispatchOf(s);

// ------------------------------------------------------------------------------------------------ window handling
function bucketPlan(range) {
  const days = Math.round((range.end.getTime() - range.start.getTime()) / DAY);
  if (days > MAX_DAYS) throw Object.assign(new Error(`Pick a range of at most ${MAX_DAYS} days`), { status: 400 });
  if (days <= 1) {
    return { bucket: 'hour', keys: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')), label: (k) => `${((Number(k) + 11) % 12) + 1}${Number(k) < 12 ? 'am' : 'pm'}`, of: (ms) => String(istParts(new Date(ms)).h).padStart(2, '0') };
  }
  const keys = [];
  for (let t = range.start.getTime(); t < range.end.getTime(); t += DAY) keys.push(fmtDate(new Date(t)));
  return { bucket: 'day', keys, label: (k) => k.slice(5), of: (ms) => fmtDate(new Date(ms)) };
}

// ------------------------------------------------------------------------------------------------ the whole report
// input: { range:{start,end}, prev:{start,end}|null, users, desk:{events,decisions}, flow:{events,decisions}, totals: Map(orderId -> total), open: [DeskOrder], dispatchConfig, now }
function build(input) {
  const { range, prev, users, totals = new Map(), open = [], dispatchConfig = DP.DEFAULT_DISPATCH_CONFIG, now = new Date() } = input;
  const events = [...input.desk.events, ...input.flow.events];
  const decisions = [...input.desk.decisions, ...input.flow.decisions];
  const plan = bucketPlan(range);
  const resolve = makeResolver(users);
  const cur = tally(events, decisions, range, resolve, totals, plan.of);
  const old = prev ? tally(events, decisions, prev, resolve, totals, () => '') : new Map();

  // live workload: who holds which open orders right now (not limited to the window)
  const work = new Map(); const ensureWork = (id) => { if (!work.has(id)) work.set(id, { confirm: 0, pending: 0, dispatch: 0, overdue: 0 }); return work.get(id); };
  let unassigned = 0; let openTotal = 0; let overdueTotal = 0;
  for (const d of open) {
    openTotal++;
    let late = false;
    if (d.stage === 'dispatch') { const due = DP.dueAt(d, dispatchConfig); late = !!due && due.getTime() < now.getTime(); }
    else if (d.dueAt) late = new Date(d.dueAt).getTime() + 2 * HOUR < now.getTime(); // same "overdue" line the Shopify desk uses
    if (late) overdueTotal++;
    const a = d.assignee && d.assignee.id;
    if (!a) { unassigned++; continue; }
    const w = ensureWork(String(a)); w[d.stage]++; if (late) w.overdue++;
  }

  const everyone = new Map();
  for (const u of users) everyone.set(u.id, { user: u });
  for (const [id, v] of [...cur, ...old]) if (!everyone.has(id)) everyone.set(id, { user: v.user });

  const people = [...everyone.values()].map(({ user }) => {
    const c = (cur.get(user.id) || { s: emptyStats() }).s;
    const p = (old.get(user.id) || { s: emptyStats() }).s;
    const decisionsN = c.confirm + c.partial + c.cancel;
    const timedTotal = c.timed.slip + c.timed.packed + c.timed.handover;
    const lateTotal = c.late.slip + c.late.packed + c.late.handover;
    const w = work.get(user.id) || { confirm: 0, pending: 0, dispatch: 0, overdue: 0 };
    return {
      id: user.id, name: user.name, role: user.role, active: user.active !== false, former: !!user.former,
      dnp: c.dnp, confirmed: c.confirm, partial: c.partial, cancelled: c.cancel, slip: c.slip, packed: c.packed, handover: c.handover,
      calls: callsOf(c), dispatchWork: dispatchOf(c), total: totalOf(c),
      decisions: decisionsN, winRate: ratio(c.confirm + c.partial, decisionsN),
      pickupRate: ratio(decisionsN, callsOf(c)), // calls that ended in a decision rather than "did not pick up"
      avgDecisionMs: c.decisionN ? c.decisionMs / c.decisionN : null, decisionN: c.decisionN,
      valueWon: Math.round(c.valueWon), collected: Math.round(c.collected),
      onTime: ratio(timedTotal - lateTotal, timedTotal), late: lateTotal,
      activeDays: c.days.size, firstAt: c.firstAt ? new Date(c.firstAt).toISOString() : null, lastAt: c.lastAt ? new Date(c.lastAt).toISOString() : null,
      series: plan.keys.map((k) => c.series.get(k) || 0),
      prev: { total: totalOf(p), wins: p.confirm + p.partial, calls: callsOf(p), dispatchWork: dispatchOf(p), handover: p.handover },
      open: { ...w, assigned: w.confirm + w.pending + w.dispatch },
    };
  }).filter((p) => p.active || p.total > 0 || p.prev.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  // ---- team totals (current and previous window)
  const sumOf = (rows, pick) => rows.reduce((n, r) => n + pick(r), 0);
  const teamFrom = (by) => {
    const rows = [...by.values()].map((v) => v.s);
    const confirmed = sumOf(rows, (s) => s.confirm + s.partial); const decisionsN = sumOf(rows, (s) => s.confirm + s.partial + s.cancel);
    const dn = sumOf(rows, (s) => s.decisionN);
    const timed = sumOf(rows, (s) => s.timed.slip + s.timed.packed + s.timed.handover); const late = sumOf(rows, (s) => s.late.slip + s.late.packed + s.late.handover);
    return {
      total: sumOf(rows, totalOf), calls: sumOf(rows, callsOf), dispatchWork: sumOf(rows, dispatchOf),
      dnp: sumOf(rows, (s) => s.dnp), confirmed: sumOf(rows, (s) => s.confirm), partial: sumOf(rows, (s) => s.partial), cancelled: sumOf(rows, (s) => s.cancel),
      slip: sumOf(rows, (s) => s.slip), packed: sumOf(rows, (s) => s.packed), handover: sumOf(rows, (s) => s.handover),
      wins: confirmed, decisions: decisionsN, winRate: ratio(confirmed, decisionsN),
      avgDecisionMs: dn ? sumOf(rows, (s) => s.decisionMs) / dn : null,
      valueWon: Math.round(sumOf(rows, (s) => s.valueWon)), collected: Math.round(sumOf(rows, (s) => s.collected)),
      onTime: ratio(timed - late, timed), late,
      active: rows.filter((s) => totalOf(s) > 0).length,
    };
  };
  const team = teamFrom(cur);
  const teamPrev = prev ? teamFrom(old) : null;
  team.members = people.filter((p) => p.active && p.role !== 'admin').length;

  // ---- trend: one point per hour (single day) or per day
  const trend = plan.keys.map((k) => ({ key: k, label: plan.label(k), won: 0, dnp: 0, cancelled: 0, dispatch: 0 }));
  const at = new Map(plan.keys.map((k, i) => [k, i]));
  const hours = Array.from({ length: 24 }, () => 0);
  for (const e of events) {
    if (!inRange(e.at, range)) continue;
    const row = trend[at.get(plan.of(e.at))];
    if (row) {
      if (e.kind === 'confirm' || e.kind === 'partial') row.won++;
      else if (e.kind === 'dnp') row.dnp++;
      else if (e.kind === 'cancel') row.cancelled++;
      else row.dispatch++;
    }
    hours[istParts(new Date(e.at)).h]++;
  }

  // ---- plain-language highlights (only when there is something to say)
  const doers = people.filter((p) => p.total > 0);
  const top = (list, pick, min = 1) => { const r = [...list].sort((a, b) => pick(b) - pick(a))[0]; return r && pick(r) >= min ? r : null; };
  const highlights = [];
  const closer = top(people, (p) => p.confirmed + p.partial);
  if (closer) highlights.push({ key: 'closer', title: 'Top closer', name: closer.name, value: `${closer.confirmed + closer.partial} orders won`, note: closer.valueWon ? `₹${closer.valueWon.toLocaleString('en-IN')} order value won` : null });
  const timed = people.filter((p) => p.decisionN >= 3 && p.avgDecisionMs != null).sort((a, b) => a.avgDecisionMs - b.avgDecisionMs)[0];
  if (timed) highlights.push({ key: 'fast', title: 'Fastest to decide', name: timed.name, value: timed.avgDecisionMs, valueKind: 'ms', note: `average over ${timed.decisionN} orders` });
  const packer = top(people, (p) => p.handover);
  if (packer) highlights.push({ key: 'packer', title: 'Most orders handed over', name: packer.name, value: `${packer.handover} handed to courier`, note: `${packer.packed} packed · ${packer.slip} slips` });
  const steady = top(people, (p) => p.activeDays, 2);
  if (steady && range.end.getTime() - range.start.getTime() > DAY) highlights.push({ key: 'steady', title: 'Most consistent', name: steady.name, value: `${steady.activeDays} active days`, note: null });
  const idle = people.filter((p) => p.active && p.role !== 'admin' && p.total === 0);
  const stuck = people.filter((p) => p.open.overdue > 0).sort((a, b) => b.open.overdue - a.open.overdue);

  return {
    bucket: plan.bucket, team, teamPrev, people, trend, hours,
    highlights, idle: idle.map((p) => ({ id: p.id, name: p.name, role: p.role })),
    attention: stuck.map((p) => ({ id: p.id, name: p.name, overdue: p.open.overdue, assigned: p.open.assigned })),
    workload: { open: openTotal, overdue: overdueTotal, unassigned },
    activeCount: doers.length,
  };
}

module.exports = { KINDS, CALL_KINDS, DISPATCH_KINDS, MAX_DAYS, fromDesk, fromFlow, build, bucketPlan, makeResolver, callsOf, dispatchOf, totalOf, ratio };
