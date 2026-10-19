// Courier problem cases: pure functions only (no database, no network), so every rule can be unit-tested.
//   NDR (non-delivery report): the courier could not deliver. Three follow-up calls (FU1 -> FU2 -> FU3) ask the customer if they still want the order.
//   Weight discrepancy: the courier charged for a heavier parcel. Three steps: Review order -> Submit request on Shipway -> Update final resolution.
//   RTO & returns: shipments coming back. Derived from the Shipway status; the team marks each one "received" once the parcel is physically back.
// The service (services/caseService.js) stores what these functions return.
const { parseYmd } = require('./istTime');

const HOUR = 3600 * 1000;
const MAX_NOTE = 500;
const NDR_OUTCOMES = ['wants', 'not_wants', 'dnp'];
const WEIGHT_STEPS = ['review', 'submit', 'final'];
const WEIGHT_STEP_LABEL = { review: 'Review order', submit: 'Submit request on Shipway', final: 'Update final resolution' };
const DUE_GRACE_MS = 60 * 1000;

const httpErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const cleanNote = (n) => String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);

// ------------------------------------------------------------------------------------------------ settings
// ndrHours: FU1 is due this many hours after the NDR was raised; FU2 this many hours after FU1 got no answer; FU3 after FU2's no-answer.
const DEFAULT_CASE_CONFIG = { ndrHours: [0, 4, 24] };
function normaliseCaseConfig(body = {}, current = DEFAULT_CASE_CONFIG) {
  const next = { ndrHours: [...((current && current.ndrHours) || DEFAULT_CASE_CONFIG.ndrHours)] };
  if (body.ndrHours !== undefined) {
    const v = body.ndrHours;
    if (!Array.isArray(v) || v.length !== 3) throw httpErr(400, 'NDR follow-up hours: enter three numbers');
    next.ndrHours = v.map((x, i) => {
      const n = Number(x);
      if (!Number.isFinite(n) || n < 0 || n > 720) throw httpErr(400, `NDR follow-up ${i + 1}: enter a number from 0 to 720`);
      return Math.round(n * 100) / 100;
    });
  }
  return next;
}

// ------------------------------------------------------------------------------------------------ NDR
// c: { status, step, dueAt }. Returns { set, entries } or throws a plain-language error.
function ndrAction(c, outcome, note, who = { id: 'system', name: 'System' }, config = DEFAULT_CASE_CONFIG, now = new Date()) {
  if (!NDR_OUTCOMES.includes(outcome)) throw httpErr(400, 'Choose what the customer said');
  if (c.status !== 'open') throw httpErr(409, `Order #${c.orderId} is already closed. Refresh to see its latest status.`);
  const n = cleanNote(note);
  const fu = `FU${c.step}`;
  const base = { at: now, by: who.name, byId: who.id, step: c.step, action: outcome, note: n };
  const tail = n ? ` · ${n}` : '';
  if (outcome === 'wants') {
    // The customer still wants it: the card goes to FU2 (whatever column it was in) and stays open until Shipway shows Delivered or RTO.
    const wants = { at: now, by: who.name, note: n, count: ((c.wants && c.wants.count) || 0) + 1 };
    return { set: { step: 2, dueAt: new Date(now.getTime() + config.ndrHours[1] * HOUR), wants }, entries: [{ ...base, label: `${fu}: customer still wants the order. Added to FU2 to follow up until it is delivered${tail}` }] };
  }
  if (outcome === 'not_wants') {
    return { set: { status: 'resolved', dueAt: null, resolution: { outcome: 'not_wants', at: now, by: who.name, note: n } }, entries: [{ ...base, label: `${fu}: customer does not want the order. Return it to origin (RTO)${tail}` }] };
  }
  // dnp
  if (c.dueAt && now.getTime() + DUE_GRACE_MS < new Date(c.dueAt).getTime()) {
    throw httpErr(409, `${fu} is not due yet. It opens at ${new Date(c.dueAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })}.`);
  }
  if (c.step < 3) {
    return { set: { step: c.step + 1, dueAt: new Date(now.getTime() + config.ndrHours[c.step] * HOUR) }, entries: [{ ...base, label: `${fu}: did not pick up${tail}` }] };
  }
  return { set: { status: 'resolved', dueAt: null, resolution: { outcome: 'no_response', at: now, by: who.name, note: n } }, entries: [{ ...base, label: `FU3: did not pick up. No response after 3 follow-ups: return it to origin (RTO)${tail}` }] };
}

// Only two Shipway results close an NDR case by themselves: Delivered or RTO. Any other status (out for delivery, in transit, ...) leaves it open,
// so the team keeps following it. shipment: { group, status }
function ndrAutoClose(c, shipment, now = new Date()) {
  if (c.status !== 'open' || !shipment || (shipment.group !== 'delivered' && shipment.group !== 'rto')) return null;
  const outcome = shipment.group;
  const text = outcome === 'delivered' ? 'Delivered' : 'Going back to origin (RTO)';
  return { set: { status: 'resolved', dueAt: null, resolution: { outcome, at: now, by: 'Shipway', note: '' } }, entries: [{ at: now, by: 'Shipway', byId: 'system', step: c.step, action: 'auto_close', note: '', label: `Closed by Shipway: ${text}` }] };
}

// Older versions closed a case as "Status changed" whenever Shipway moved off NDR. Put those right: Delivered / RTO get their real result, anything else is reopened.
function ndrReclassify(c, shipment, config = DEFAULT_CASE_CONFIG, now = new Date()) {
  if (c.status !== 'resolved' || !c.resolution || c.resolution.outcome !== 'moved' || !shipment || shipment.group === 'ndr') return null;
  if (shipment.group === 'delivered' || shipment.group === 'rto') return { set: { 'resolution.outcome': shipment.group }, entries: [] };
  const step = Math.min(3, Math.max(1, c.step || 1));
  return { set: { status: 'open', step, dueAt: new Date(now.getTime() + config.ndrHours[step - 1] * HOUR), resolution: { outcome: null, at: null, by: '', note: '' } }, entries: [{ at: now, by: 'System', byId: 'system', step, action: 'reopened', note: '', label: `Reopened: Shipway status “${shipment.status}” is not Delivered or RTO yet` }] };
}

// ------------------------------------------------------------------------------------------------ weight discrepancy
// c: { status, step } with step 1..3. input: { decision, note, ref, amount }
function weightAction(c, input = {}, who = { id: 'system', name: 'System' }, now = new Date()) {
  if (c.status !== 'open') throw httpErr(409, `Order #${c.orderId} is already closed. Refresh to see its latest status.`);
  const note = cleanNote(input.note);
  const tail = note ? ` · ${note}` : '';
  const base = { at: now, by: who.name, byId: who.id, step: c.step, note };
  const step = WEIGHT_STEPS[c.step - 1];
  if (step === 'review') {
    if (input.decision === 'accept') return { set: { status: 'resolved', resolution: { outcome: 'accepted', at: now, by: who.name, note, amount: 0 } }, entries: [{ ...base, action: 'accept', label: `Review: charge is correct, accepted${tail}` }] };
    if (input.decision === 'dispute') return { set: { step: 2 }, entries: [{ ...base, action: 'dispute', label: `Review: charge looks wrong, raise it with Shipway${tail}` }] };
    throw httpErr(400, 'Choose: the charge is correct, or raise it with Shipway');
  }
  if (step === 'submit') {
    const ref = String(input.ref == null ? '' : input.ref).trim().slice(0, 80);
    return { set: { step: 3, requestRef: ref, requestAt: now }, entries: [{ ...base, action: 'submitted', label: `Request submitted on Shipway${ref ? ` (ref ${ref})` : ''}${tail}` }] };
  }
  const d = input.decision;
  if (d === 'reversed') return { set: { status: 'resolved', resolution: { outcome: 'reversed', at: now, by: who.name, note, amount: Number(c.weight && c.weight.extraCharge) || 0 } }, entries: [{ ...base, action: 'reversed', label: `Final: charge fully reversed${tail}` }] };
  if (d === 'rejected') return { set: { status: 'resolved', resolution: { outcome: 'rejected', at: now, by: who.name, note, amount: 0 } }, entries: [{ ...base, action: 'rejected', label: `Final: Shipway rejected the request, the charge stays${tail}` }] };
  if (d === 'partial') {
    const amt = Number(input.amount);
    if (!Number.isFinite(amt) || amt <= 0) throw httpErr(400, 'Enter the amount Shipway credited back');
    return { set: { status: 'resolved', resolution: { outcome: 'partial', at: now, by: who.name, note, amount: Math.round(amt * 100) / 100 } }, entries: [{ ...base, action: 'partial', label: `Final: ₹${Math.round(amt * 100) / 100} credited back${tail}` }] };
  }
  throw httpErr(400, 'Choose the final result: reversed, partly credited or rejected');
}

// ------------------------------------------------------------------------------------------------ weight sheet parsing
const norm = (h) => String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
const FIELDS = {
  orderId: ['orderid', 'orderno', 'ordernumber', 'order', 'channelorderid', 'referenceno', 'referencenumber', 'orderref'],
  awb: ['awb', 'awbno', 'awbnumber', 'trackingnumber', 'trackingno', 'waybill', 'waybillnumber', 'lrnumber', 'airwaybill'],
  declared: ['declaredweight', 'enteredweight', 'sellerweight', 'weightdeclared', 'yourweight', 'orderweight', 'actualweight', 'weightbyseller', 'enteredwt', 'declaredwt'],
  charged: ['chargedweight', 'appliedweight', 'courierweight', 'revisedweight', 'weightcharged', 'finalweight', 'chargeableweight', 'weightbycourier', 'chargedwt'],
  diff: ['weightdifference', 'differenceweight', 'excessweight', 'diffweight', 'weightdiff', 'extraweight', 'weightdiscrepancy'],
  charge: ['extracharge', 'excesscharge', 'additionalcharge', 'additionalcharges', 'chargeamount', 'weightdiscrepancycharge', 'discrepancyamount', 'debitamount', 'amount', 'extraamount', 'penalty', 'excesschargeamount', 'chargedamount'],
  courier: ['courier', 'couriername', 'carrier', 'carriername', 'logistics', 'shippingpartner'],
  date: ['date', 'raisedon', 'raiseddate', 'discrepancydate', 'createdat', 'createddate', 'chargedon', 'weightdiscrepancydate'],
};
function numberOf(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}
// Weights written with a unit ("1.5 kg", "800 g") are converted on their own; plain numbers use the unit chosen on screen (kg or g).
function gramsOf(v, unit) {
  const n = numberOf(v);
  if (n == null) return null;
  const s = String(v).toLowerCase();
  if (typeof v === 'string' && /\d\s*kgs?\b/.test(s)) return Math.round(n * 1000);
  if (typeof v === 'string' && /\d\s*g(m|ms|rams?)?\b/.test(s)) return Math.round(n);
  return Math.round(unit === 'g' ? n : n * 1000);
}
function dateOf(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  const ymd = parseYmd(s.slice(0, 10)); if (ymd) return ymd;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (dmy) return parseYmd(`${dmy[3]}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
// rows: array of objects keyed by the sheet's own headers. Returns { rows, skipped: [{ line, why }], columns }.
function parseWeightRows(rows, { unit = 'kg' } = {}) {
  const out = []; const skipped = [];
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const col = {};
  for (const [field, names] of Object.entries(FIELDS)) {
    // the first header that matches wins, in the order of the alias list (most specific first)
    for (const name of names) { const h = headers.find((x) => norm(x) === name); if (h) { col[field] = h; break; } }
  }
  if (!col.orderId && !col.awb) return { rows: [], skipped: [], columns: col, error: 'The file needs an Order ID column or an AWB column.' };
  rows.forEach((r, i) => {
    const line = i + 2;
    const orderRaw = col.orderId ? String(r[col.orderId] == null ? '' : r[col.orderId]).replace(/^#/, '').trim() : '';
    const orderId = /^\d{1,9}$/.test(orderRaw) ? Number(orderRaw) : null;
    const awb = col.awb ? String(r[col.awb] == null ? '' : r[col.awb]).replace(/\s+/g, '').toUpperCase() : '';
    if (!orderId && !awb) { skipped.push({ line, why: 'No order number or AWB' }); return; }
    const declaredG = col.declared ? gramsOf(r[col.declared], unit) : null;
    const chargedG = col.charged ? gramsOf(r[col.charged], unit) : null;
    let diffG = col.diff ? gramsOf(r[col.diff], unit) : null;
    if (diffG == null && declaredG != null && chargedG != null) diffG = chargedG - declaredG;
    const extraCharge = col.charge ? numberOf(r[col.charge]) : null;
    out.push({ line, orderId, awb, declaredG, chargedG, diffG, extraCharge, courier: col.courier ? String(r[col.courier] || '').trim() : '', raisedAt: col.date ? dateOf(r[col.date]) : null });
  });
  return { rows: out, skipped, columns: col };
}

// Weight facts that came with a Shipway order lookup (no file involved). fields: { shipwayKey: value } for every weight-looking key Shipway sent.
// Returns { declaredG, chargedG, diffG, extraCharge } when Shipway reports a charged weight above the declared one, else null.
const SHIPMENT_DECLARED = [...FIELDS.declared, 'weight', 'packageweight', 'productweight', 'dispatchweight'];
function weightFromShipment(fields, { unit = 'g' } = {}) {
  if (!fields || typeof fields !== 'object') return null;
  const keys = Object.keys(fields);
  const pick = (names) => { for (const n of names) { const k = keys.find((x) => norm(x) === n); if (k && fields[k] !== '' && fields[k] != null) return fields[k]; } return null; };
  const declaredG = gramsOf(pick(SHIPMENT_DECLARED), unit);
  const chargedG = gramsOf(pick(FIELDS.charged), unit);
  const extraCharge = numberOf(pick(FIELDS.charge));
  let diffG = gramsOf(pick(FIELDS.diff), unit);
  if (diffG == null && declaredG != null && chargedG != null) diffG = chargedG - declaredG;
  if (diffG == null || diffG <= 0) return null;
  return { declaredG, chargedG, diffG, extraCharge };
}

// ------------------------------------------------------------------------------------------------ RTO
const RTO_CODES = new Set(['RTO', 'RTD']);
// When did this shipment start coming back? The first RTO status Shipway showed, else when the status last changed.
function rtoSince(ship) {
  const hit = (ship.history || []).find((h) => RTO_CODES.has(String(h.code || '').toUpperCase()));
  return (hit && hit.at) || ship.changedAt || ship.statusAt || ship.checkedAt || null;
}
// ship.statusCode RTD = Shipway says it reached the origin. The team's own "received" tick is what counts as physically back.
const rtoState = (ship, received) => (received ? 'received' : String(ship.statusCode || '').toUpperCase() === 'RTD' ? 'at_origin' : 'on_way');
// items: [{ since: Date, state }]. range: { start, end } | null (all time)
function rtoStats(items, range) {
  const total = items.length;
  const received = items.filter((x) => x.state === 'received').length;
  const inRange = range && range.start ? items.filter((x) => x.since && new Date(x.since) >= range.start && new Date(x.since) < range.end) : items;
  return { total, newInRange: inRange.length, received, pending: total - received, onWay: items.filter((x) => x.state === 'on_way').length, atOrigin: items.filter((x) => x.state === 'at_origin').length };
}

module.exports = {
  HOUR, MAX_NOTE, NDR_OUTCOMES, WEIGHT_STEPS, WEIGHT_STEP_LABEL, DEFAULT_CASE_CONFIG, httpErr, cleanNote, normaliseCaseConfig,
  ndrAction, ndrAutoClose, ndrReclassify, weightAction, weightFromShipment, parseWeightRows, gramsOf, numberOf, rtoSince, rtoState, rtoStats,
};
