// Team performance: loads what the team did (Shopify Desk history, plus the older sheet-based Confirm queue / Dispatch desk)
// and hands it to lib/teamPerf.js. Read-only: nothing here changes an order.
const { DeskOrder, FlowEvent, OrderFlow, ShopifyOrder, StaffUser } = require('../models');
const { resolveWindow } = require('../lib/windows');
const { fmtDate } = require('../lib/istTime');
const T = require('../lib/teamPerf');
const desk = require('./deskService');
const { rolesOf } = require('../lib/staffAuth');

// viewer: the signed-in non-admin ({ id, name, role }); null for an admin, who sees everyone.
async function report(q = {}, now = new Date(), viewer = null) {
  const key = q.window || 'today';
  if (key === 'all_time') throw Object.assign(new Error('Pick a day, a week or a date range (up to a year).'), { status: 400 });
  const w = resolveWindow(key, now, { from: q.from, to: q.to });
  T.bucketPlan(w); // rejects a range longer than a year before any query runs
  const from = w.prev ? w.prev.start : w.start;
  const span = { $gte: from, $lt: w.end };
  const sinceFrom = { $gte: from }; // work that was due in the period may have been done after it ended

  const [users, deskDocs, flowEvents, flowDecisions, open, dispatchConfig, deskConfig] = await Promise.all([
    StaffUser.find().select('name role roles active').lean(),
    DeskOrder.find({ $or: [{ 'log.at': sinceFrom }, { 'dq.slip.at': sinceFrom }, { 'dq.packed.at': sinceFrom }, { 'dq.handover.at': sinceFrom }] }).select('orderId orderAt log dq').lean(),
    FlowEvent.find({ at: span, stage: { $in: ['confirm', 'dispatch'] } }).select('orderId at byId byName action meta').lean(),
    OrderFlow.find({ decidedAt: span }).select('orderId orderAt decidedAt decidedById decidedByName').lean(),
    DeskOrder.find({ stage: { $in: ['confirm', 'pending', 'dispatch'] } }).select('orderId stage dueAt dq confirmedAt orderAt assignee').lean(),
    desk.getDispatchConfig(),
    desk.getConfig(),
  ]);

  const fromDesk = T.fromDesk(deskDocs, deskConfig);
  const ids = [...new Set(fromDesk.events.filter((e) => e.kind === 'confirm' || e.kind === 'partial').map((e) => e.orderId))];
  const totals = new Map();
  if (ids.length) for (const s of await ShopifyOrder.find({ orderId: { $in: ids } }).select('orderId total').lean()) totals.set(s.orderId, s.total || 0);

  const out = T.build({
    range: w, prev: w.prev,
    users: users.map((u) => ({ id: String(u._id), name: u.name, role: u.role, roles: rolesOf(u), active: u.active !== false })),
    desk: fromDesk, flow: T.fromFlow(flowEvents, flowDecisions), totals, open, dispatchConfig, now, viewer,
  });
  return {
    ...out,
    now,
    range: {
      key: w.key, label: w.label, partial: w.partial, start: fmtDate(w.start), end: fmtDate(new Date(w.end - 1)),
      prev: w.prev ? { start: fmtDate(w.prev.start), end: fmtDate(new Date(w.prev.end - 1)) } : null,
    },
  };
}

module.exports = { report };
