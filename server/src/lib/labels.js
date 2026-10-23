// Every name on the Shopify desk screens that an admin may rename (Settings, Names & labels).
// Pure data and validation: no database. Only the changed names are stored; anything left empty falls back to the default here,
// so adding a new label in the future is one line in this file and it shows up in Settings by itself.
const GROUPS = [
  { title: 'Page', items: [
    ['deskTitle', 'Shopify desk', 'Heading at the top of the desk'],
    ['deskSubtitle', 'Every order comes straight from Shopify. New orders enter the confirm queue at FU1.', 'Line under the heading'],
  ] },
  { title: 'Tabs', items: [
    ['tabOverview', 'Overview', ''], ['tabOrders', 'Shopify orders', ''], ['tabAnalysis', 'Order analysis', ''], ['tabFunnel', 'Order funnel', ''],
    ['tabConfirm', 'Confirm queue', ''], ['tabPending', 'Pending orders', ''], ['tabDispatch', 'Dispatch queue', ''],
    ['tabTransit', 'In-transit orders', ''], ['tabPartial', 'Partial paid', ''], ['tabCancelled', 'Cancelled orders', ''], ['tabSettings', 'Settings', ''],
  ] },
  { title: 'Confirm queue columns', items: [
    ['fu1', 'FU1', 'First call'], ['fu2', 'FU2', 'Second call'], ['fu3', 'FU3', 'Third call'],
  ] },
  { title: 'Pending orders columns', items: [
    ['day1', 'Day 1', 'First pending follow-up'], ['day2', 'Day 2', 'Second pending follow-up'], ['day3', 'Day 3', 'Third pending follow-up'],
  ] },
  { title: 'Dispatch queue columns', items: [
    ['stepSlip', 'Packing slip', ''], ['stepPacked', 'Order packed', ''], ['stepHandover', 'Order handover', ''],
  ] },
  { title: 'Buttons and outcomes', items: [
    ['btnCall', 'Call', 'Call button on a card'], ['btnUpdate', 'Update status', ''], ['btnDone', 'DONE', 'Button on a dispatch card'],
    ['actConfirm', 'Confirmed', ''], ['actDnp', 'DNP', 'Did not pick up'], ['actPartial', 'Partial paid', ''], ['actCancel', 'Cancelled', ''],
  ] },
  { title: 'Stage names', items: [
    ['stageConfirm', 'Confirm queue', ''], ['stagePending', 'Pending', ''], ['stageDispatch', 'To dispatch', ''],
    ['stageDispatched', 'Dispatched', ''], ['stageCancelled', 'Cancelled', ''], ['stageNone', 'Not in queue', ''],
  ] },
  { title: 'Payment tags', items: [
    ['payCod', 'COD', ''], ['payPrepaid', 'Prepaid', ''], ['payPartial', 'Partial paid', 'Tag on a partly paid order'],
  ] },
];

const DEFAULT_LABELS = Object.fromEntries(GROUPS.flatMap((g) => g.items.map(([k, v]) => [k, v])));
const LABEL_KEYS = Object.keys(DEFAULT_LABELS);
const MAX_LEN = 90;

// body: { key: 'new name' }. An empty value puts the original name back. Unknown keys are rejected, so a typo never silently does nothing.
function normaliseLabels(body, current = {}, fail = (m) => { throw new Error(m); }) {
  const next = { ...(current || {}) };
  for (const [k, raw] of Object.entries(body || {})) {
    if (!LABEL_KEYS.includes(k)) fail(`Unknown name “${k}”`);
    const v = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (v.length > MAX_LEN) fail(`“${DEFAULT_LABELS[k]}”: keep the name under ${MAX_LEN} characters`);
    if (!v || v === DEFAULT_LABELS[k]) delete next[k]; else next[k] = v;
  }
  for (const k of Object.keys(next)) if (!LABEL_KEYS.includes(k)) delete next[k];
  return next;
}

const labelOf = (labels, key) => (labels && labels[key]) || DEFAULT_LABELS[key] || key;
// 'FU1' / 'Day 2' (the fixed names the log and the Overview use) -> label key
const FU_KEY = { FU1: 'fu1', FU2: 'fu2', FU3: 'fu3', 'Day 1': 'day1', 'Day 2': 'day2', 'Day 3': 'day3' };
const fuName = (labels, fu) => (FU_KEY[fu] ? labelOf(labels, FU_KEY[fu]) : fu);

module.exports = { GROUPS, DEFAULT_LABELS, LABEL_KEYS, normaliseLabels, labelOf, fuName, FU_KEY };
