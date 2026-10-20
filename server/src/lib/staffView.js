// What a confirmation or packing login may see on the Overview. Pure functions, so every rule is unit-tested.
// Admins see everything through /api/metrics; team members get a cut-down copy from /api/desk/my-overview.
// Money (order value, average order, net revenue, value mix) is admin-only. Each team sees only the rates its own work moves.
const { rolesOf } = require('./staffAuth');
const ROLE_KPIS = {
  confirmation: ['total', 'pending', 'confirmation', 'cancellation', 'ndr', 'ndrToRto'],
  packing: ['total', 'dispatch', 'deliveredRate', 'rto', 'inTransit'],
};
const MONEY_KEYS = ['value', 'aov', 'netRevenue', 'mixValue'];

const stripBlock = (b) => { if (!b || typeof b !== 'object') return b; const o = { ...b }; for (const k of MONEY_KEYS) delete o[k]; return o; };
const stripMetrics = (m) => (m ? Object.fromEntries(Object.entries(m).map(([mode, b]) => [mode, stripBlock(b)])) : m);

// metrics: the { range, current, previous, undated } object the Overview uses.
// role: one role, a list of roles, or a person ({ role, roles }). Someone on both teams sees the rates of both, in the order of the first team's list.
function forRole(metrics, role) {
  const held = rolesOf(role && typeof role === 'object' && !Array.isArray(role) ? role : { roles: Array.isArray(role) ? role : [role] });
  const kpis = [...new Set(held.flatMap((r) => ROLE_KPIS[r] || []))];
  if (!kpis.length) return null; // admin is not served here; an unknown role sees nothing
  return { ...metrics, current: stripMetrics(metrics.current), previous: stripMetrics(metrics.previous), kpis };
}

module.exports = { ROLE_KPIS, MONEY_KEYS, stripMetrics, forRole };
