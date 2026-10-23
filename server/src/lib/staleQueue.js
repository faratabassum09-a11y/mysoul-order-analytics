// Orders that entered the confirm / pending queue from before the "Queue starts from" date and that nobody has worked on.
// Changing the start date never removes orders already in the queue, so this is how an admin clears them. Orders a person has
// acted on (a call, a DNP, a cancel ...) are NEVER touched, and neither is anything past the confirm / pending stages.
const HUMAN_ACTIONS = ['dnp', 'confirm', 'partial_paid', 'cancel', 'restore', 'dispatch', 'slip_done', 'packed', 'hold', 'resume'];
const staleFilter = (start) => ({
  stage: { $in: ['confirm', 'pending'] },
  orderAt: { $lt: start },
  log: { $not: { $elemMatch: { action: { $in: HUMAN_ACTIONS } } } },
  $or: [{ dq: null }, { dq: { $exists: false } }, { 'dq.step': { $exists: false } }],
});
// the same rule on one document, used by the tests and as a double check before deleting
const isStale = (d, start) => !!d && ['confirm', 'pending'].includes(d.stage) && !!d.orderAt && new Date(d.orderAt) < start
  && !(d.log || []).some((e) => HUMAN_ACTIONS.includes(e.action)) && !(d.dq && d.dq.step);
module.exports = { HUMAN_ACTIONS, staleFilter, isStale };
