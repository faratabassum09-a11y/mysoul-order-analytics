// Order funnel: how many of the orders placed in a window were confirmed, paid partly, dispatched, delivered or returned (RTO).
// Pure functions only (no database, no network). The service hands in plain objects, so every rule is unit-tested.
//
// Every order is counted once, on the day it was PLACED, so a percentage always compares the same group of orders:
//   Confirmed ratio   = all new orders / confirmed orders         (e.g. 2.5 means one order in 2.5 gets confirmed)
//   Confirmed %       = confirmed orders / all new orders
//   COD to Partial %  = COD orders that paid part up front / all COD orders
//   Dispatched %      = orders handed to the courier / confirmed orders
//   Delivered %       = delivered shipments / dispatched orders
//   RTO %             = shipments returned to origin / dispatched orders
const { fmtDate, startOfDay, DAY } = require('./istTime');

const KEYS = ['orders', 'cod', 'confirmed', 'partial', 'dispatched', 'delivered', 'rto'];
const MAX_DAYS = 800;

// Prepaid = Shopify says the money is in. Anything else is treated as cash on delivery, and so is any order whose payment method says COD
// (Shopify marks a COD order "paid" after delivery, but it was still a COD order when it was placed).
function isCod(shop) {
  const s = shop || {};
  const fs = String(s.financialStatus || '').toUpperCase();
  if ((s.paymentGateways || []).some((g) => /\bcod\b|cash on delivery|cash\s*\/\s*cod/i.test(String(g)))) return true;
  return !['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(fs);
}

// An order is "confirmed" once the team confirmed it (or took a partial payment), even if it was cancelled afterwards, before dispatch.
const wasConfirmed = (d) => !!d && (d.stage === 'dispatch' || d.stage === 'dispatched' || (d.stage === 'cancelled' && !!d.cancel && d.cancel.fromStage === 'dispatch'));
const hasPartial = (d) => !!(d && d.partial && d.partial.amount > 0);

// One order -> yes/no for every funnel step. desk: DeskOrder or null, shop: ShopifyOrder or null, ship: ShipwayShipment or null.
function flagsOf({ desk, shop, ship }) {
  const dispatched = !!desk && desk.stage === 'dispatched';
  const group = ship && ship.found !== false ? ship.group : null;
  const cod = isCod(shop);
  return {
    orders: true, cod,
    confirmed: wasConfirmed(desk),
    partial: cod && hasPartial(desk),
    dispatched,
    delivered: dispatched && group === 'delivered', // delivered / RTO only count for orders we handed over, so a % can never pass 100
    rto: dispatched && group === 'rto',
  };
}

const rate = (n, d) => ({ v: d > 0 ? (n / d) * 100 : null, n, d });
const zero = () => Object.fromEntries(KEYS.map((k) => [k, 0]));

// rows: [{ desk, shop, ship }]. Returns the counts and every ratio the Overview and the Order funnel tab show.
function funnelStats(rows) {
  const c = zero();
  for (const r of rows) { const f = flagsOf(r); for (const k of KEYS) if (f[k]) c[k]++; }
  return {
    ...c,
    inTransit: c.dispatched - c.delivered - c.rto, // handed over, no final answer from the courier yet
    confirmedRatio: c.confirmed > 0 ? c.orders / c.confirmed : null, // all new orders / confirmed orders
    confirmedPct: rate(c.confirmed, c.orders),
    partialPct: rate(c.partial, c.cod),
    dispatchedPct: rate(c.dispatched, c.confirmed),
    rtoPct: rate(c.rto, c.dispatched),
    deliveredPct: rate(c.delivered, c.dispatched),
  };
}

// One row per calendar day (IST) from start to end (end is exclusive; open ends use the first and last order). Quiet days stay in, as zeros.
// rows: [{ desk, shop, ship, createdAt }]. Returns { daily, running }: counts per day, and the same counts added up day after day.
function funnelDaily(rows, start, end) {
  const dated = rows.filter((r) => r.createdAt && !Number.isNaN(new Date(r.createdAt).getTime()));
  let first = start; let last = end ? new Date(end.getTime() - DAY) : null;
  if (!first && dated.length) first = new Date(Math.min(...dated.map((r) => new Date(r.createdAt).getTime())));
  if (!last && dated.length) last = new Date(Math.max(...dated.map((r) => new Date(r.createdAt).getTime())));
  if (!first || !last || last < first) return { daily: [], running: [] };
  const byDay = new Map();
  for (let t = startOfDay(first), n = 0; t <= last && n < MAX_DAYS; t = new Date(t.getTime() + DAY), n++) byDay.set(fmtDate(t), { date: fmtDate(t), ...zero() });
  for (const r of dated) {
    const e = byDay.get(fmtDate(new Date(r.createdAt)));
    if (!e) continue;
    const f = flagsOf(r);
    for (const k of KEYS) if (f[k]) e[k]++;
  }
  const daily = [...byDay.values()];
  const sum = zero();
  const running = daily.map((d) => { for (const k of KEYS) sum[k] += d[k]; return { date: d.date, ...sum }; });
  return { daily, running };
}

module.exports = { KEYS, isCod, wasConfirmed, flagsOf, funnelStats, funnelDaily };
