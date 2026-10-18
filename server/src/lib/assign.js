// Who works which order: pure functions only (no database, no network), so every rule can be unit-tested.
// Every open order sits in exactly one "slot" (the column it is in on a board): FU1, FU2, FU3, Pending Day 1-3, Packing slip, Order packed, Order handover.
// Each slot has its own rule: off (everyone sees it), manual (an admin picks the person) or auto (shared out in a ratio).
// The service (services/deskService.js) stores what these functions return.
const DP = require('./dispatch');

const SLOTS = ['confirm1', 'confirm2', 'confirm3', 'pending1', 'pending2', 'pending3', 'slip', 'packed', 'handover'];
const MODES = ['off', 'manual', 'auto'];
const MAX_WEIGHT = 100;
const MAX_MEMBERS = 60;

const httpErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// The slot an order is in right now, or null when nobody has to work it (dispatched, cancelled, not in the queue).
function slotOf(doc) {
  if (!doc) return null;
  if (doc.stage === 'confirm' && doc.fuNo >= 1 && doc.fuNo <= 3) return `confirm${doc.fuNo}`;
  if (doc.stage === 'pending' && doc.fuNo >= 1 && doc.fuNo <= 3) return `pending${doc.fuNo}`;
  if (doc.stage === 'dispatch') return DP.stepOf(doc);
  return null;
}

// Confirmation people work the call queues, packing people the dispatch queue. Admins can be put on any slot.
const slotKind = (slot) => (/^(confirm|pending)/.test(slot) ? 'confirmation' : 'packing');
const roleFits = (slot, role) => role === 'admin' || role === slotKind(slot);

const emptySlot = () => ({ mode: 'off', members: [] });
const DEFAULT_ASSIGN = { visibility: 'all', keepSamePerson: false, slots: Object.fromEntries(SLOTS.map((k) => [k, emptySlot()])) };

// body: only what changed. team: [{ id, role, active }] when known, so a member that does not exist (or is the wrong role) is refused.
function normaliseAssignConfig(body = {}, current = DEFAULT_ASSIGN, team = null) {
  const cur = current || DEFAULT_ASSIGN;
  const next = {
    visibility: cur.visibility === 'own' ? 'own' : 'all',
    keepSamePerson: !!cur.keepSamePerson,
    slots: Object.fromEntries(SLOTS.map((k) => [k, { mode: (cur.slots && cur.slots[k] && cur.slots[k].mode) || 'off', members: ((cur.slots && cur.slots[k] && cur.slots[k].members) || []).map((m) => ({ ...m })) }])),
  };
  if (body.visibility !== undefined) {
    if (!['all', 'own'].includes(body.visibility)) throw httpErr(400, 'Choose whether team members see all orders or only their own');
    next.visibility = body.visibility;
  }
  if (body.keepSamePerson !== undefined) next.keepSamePerson = !!body.keepSamePerson;
  const byId = team ? new Map(team.map((t) => [String(t.id), t])) : null;
  for (const [slot, s] of Object.entries(body.slots || {})) {
    if (!SLOTS.includes(slot)) throw httpErr(400, `Unknown column “${slot}”`);
    const cur2 = next.slots[slot];
    if (s.mode !== undefined) {
      if (!MODES.includes(s.mode)) throw httpErr(400, 'Choose Off, Manual or Auto');
      cur2.mode = s.mode;
    }
    if (s.members !== undefined) {
      if (!Array.isArray(s.members) || s.members.length > MAX_MEMBERS) throw httpErr(400, `Keep a column's team under ${MAX_MEMBERS} people`);
      const seen = new Set();
      cur2.members = s.members.map((m) => {
        const id = String((m && m.id) || '');
        if (!id || seen.has(id)) throw httpErr(400, 'Each person can be added to a column once');
        seen.add(id);
        const weight = Number(m.weight === undefined ? 1 : m.weight);
        if (!Number.isInteger(weight) || weight < 1 || weight > MAX_WEIGHT) throw httpErr(400, `Share must be a whole number from 1 to ${MAX_WEIGHT}`);
        if (byId) {
          const t = byId.get(id);
          if (!t || t.active === false) throw httpErr(400, 'One of the people you picked is not an active team member');
          if (!roleFits(slot, t.role)) throw httpErr(400, `${t.name || 'That person'} cannot be put on this column (wrong team)`);
        }
        return { id, weight, on: m.on !== false };
      });
    }
    if (cur2.mode === 'auto' && !cur2.members.some((m) => m.on)) throw httpErr(400, 'Auto-assign needs at least one person switched on in the column. Add someone, or choose Manual or Off.');
  }
  return next;
}

// ------------------------------------------------------------------------------------------------ choosing a person
const live = (members) => (members || []).filter((m) => m.on !== false && m.weight > 0);

// Weighted least-loaded: the person whose workload is furthest below their share gets the next order.
// load: Map id -> orders that person already holds in this column. With shares 2 and 1 the first person ends up with twice as many.
// A new joiner starts at zero, so they receive the next orders until they have caught up with their share.
function pickAssignee(members, load = new Map()) {
  let best = null; let bestScore = Infinity;
  for (const m of live(members)) {
    const score = ((load.get(m.id) || 0) + 1) / m.weight;
    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && best && (m.weight > best.weight || (m.weight === best.weight && String(m.id) < String(best.id))))) { best = m; bestScore = score; }
  }
  return best ? best.id : null;
}

// Share the orders of one column out again so that everyone's count matches their share, moving as few orders as possible.
// orders: [{ orderId, assigneeId }] in the order they should be handed out. Returns Map orderId -> new assigneeId (only the ones that move).
function planRebalance(orders, members) {
  const pool = live(members);
  const out = new Map();
  if (!pool.length || !orders.length) return out;
  const total = orders.length; const W = pool.reduce((n, m) => n + m.weight, 0);
  const raw = pool.map((m) => ({ m, q: (total * m.weight) / W }));
  const quota = new Map(raw.map((r) => [r.m.id, Math.floor(r.q)]));
  let left = total - [...quota.values()].reduce((n, v) => n + v, 0);
  [...raw].sort((a, b) => (b.q - Math.floor(b.q)) - (a.q - Math.floor(a.q)) || b.m.weight - a.m.weight || String(a.m.id).localeCompare(String(b.m.id)))
    .forEach((r) => { if (left > 0) { quota.set(r.m.id, quota.get(r.m.id) + 1); left--; } });
  const mine = new Map(pool.map((m) => [m.id, []]));
  const free = [];
  for (const o of orders) { if (o.assigneeId && mine.has(o.assigneeId)) mine.get(o.assigneeId).push(o); else free.push(o); }
  for (const [id, list] of mine) { while (list.length > quota.get(id)) free.push(list.pop()); } // release the newest ones of anyone over their share
  free.sort((a, b) => orders.indexOf(a) - orders.indexOf(b));
  for (const o of free) {
    let pick = null; let gap = -Infinity;
    for (const m of pool) { const g = quota.get(m.id) - mine.get(m.id).length; if (g > gap || (g === gap && pick && m.weight > pick.weight)) { pick = m; gap = g; } }
    mine.get(pick.id).push(o);
    if (o.assigneeId !== pick.id) out.set(o.orderId, pick.id);
  }
  return out;
}

// What should happen to one order's assignee right now? Returns { assigneeId, reason } or null when it can stay as it is.
// doc.assignee: { id, slot } | undefined. slotConf: the rule for the order's slot. load: Map for the slot (excluding this order).
function decide(doc, slotConf, { keepSamePerson = false, load = new Map(), isActive = () => true } = {}) {
  const slot = slotOf(doc);
  const a = doc.assignee && doc.assignee.id ? doc.assignee : null;
  if (!slot) return a ? { assigneeId: null, reason: 'left_queue' } : null;
  const mode = (slotConf && slotConf.mode) || 'off';
  if (mode === 'off') return a ? { assigneeId: null, reason: 'rule_off' } : null;
  const inPool = (id) => live(slotConf.members).some((m) => m.id === id) && isActive(id);
  if (a && a.slot === slot) { // already holds it: keep unless they were switched off or taken out of an auto column
    if (mode === 'manual' || inPool(a.id)) return null;
    return mode === 'auto' ? { assigneeId: pickAssignee(live(slotConf.members).filter((m) => isActive(m.id)), load), reason: 'person_off' } : { assigneeId: null, reason: 'person_off' };
  }
  if (a && keepSamePerson && inPool(a.id)) return { assigneeId: a.id, reason: 'kept' };
  if (mode === 'auto') return { assigneeId: pickAssignee(live(slotConf.members).filter((m) => isActive(m.id)), load), reason: 'auto' };
  return a ? { assigneeId: null, reason: 'new_column' } : null; // manual: waits for an admin (or for someone to take it)
}

// Can this person act on / see this order? admins always. With "own only" a person sees the orders assigned to them plus the ones nobody holds yet.
function canWork(staff, doc, visibility) {
  if (!staff || staff.role === 'admin' || visibility !== 'own') return true;
  const id = doc && doc.assignee && doc.assignee.id;
  return !id || String(id) === String(staff.id);
}

module.exports = { SLOTS, MODES, MAX_WEIGHT, DEFAULT_ASSIGN, slotOf, slotKind, roleFits, normaliseAssignConfig, pickAssignee, planRebalance, decide, canWork, httpErr };
