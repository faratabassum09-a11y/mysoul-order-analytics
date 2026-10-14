// Shipway reply -> the flat document we store. Pure: no network, no database.
// Codes come from the Shipway docs ("Order Shipment Details"). Unknown codes keep Shipway's own wording.
const CODES = {
  // forward
  PKP: ['Picked up', 'transit'], INT: ['In transit', 'transit'], OOD: ['Out for delivery', 'transit'], SCH: ['Shipment booked', 'other'],
  NFI: ['Status pending', 'other'], NFIDS: ['Status pending', 'other'], ONH: ['On hold', 'other'], PKF: ['Pickup failed', 'other'],
  SMD: ['Delivery delayed', 'transit'], DEL: ['Delivered', 'delivered'],
  UND: ['Undelivered', 'ndr'], CNA: ['Consignee unavailable', 'ndr'], CRTA: ['Customer refused', 'ndr'],
  RTO: ['RTO in transit', 'rto'], RTD: ['RTO delivered', 'rto'],
  CAN: ['Cancelled', 'cancelled'], LOST: ['Lost', 'lost'],
  // reverse shipments
  RCAN: ['Reverse cancelled', 'reverse'], RCLO: ['Reverse closed', 'reverse'], RDEL: ['Reverse delivered', 'reverse'], RINT: ['Reverse in transit', 'reverse'],
  ROOP: ['Reverse out for pickup', 'reverse'], RPKP: ['Reverse picked up', 'reverse'], RPSH: ['Reverse pickup scheduled', 'reverse'], RSMD: ['Reverse delayed', 'reverse'],
  RSCH: ['Reverse scheduled', 'reverse'], PCAN: ['Pickup cancelled', 'reverse'], ROTH: ['Reverse other', 'reverse'], RPF: ['Reverse pickup failed', 'reverse'],
  ROOD: ['Reverse out for delivery', 'reverse'], RUND: ['Reverse undelivered', 'reverse'], RPEX: ['Reverse pickup exception', 'reverse'],
};
const FINAL = new Set(['DEL', 'RTD', 'CAN', 'LOST', 'RDEL', 'RCAN', 'RCLO']);
const GROUPS = [
  ['delivered', 'Delivered'], ['transit', 'In transit'], ['ndr', 'Undelivered / NDR'], ['rto', 'RTO'], ['cancelled', 'Cancelled'], ['lost', 'Lost'], ['reverse', 'Reverse'], ['other', 'Other'],
];
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());

function parseWhen(v) {
  const s = clean(v);
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(' ', 'T') + '+05:30' : s); // Shipway times are India time
  return Number.isNaN(d.getTime()) ? null : d;
}

// r = the "response" object of getOrderShipmentDetails
function normalizeShipment(r, shipwayOrderId = '') {
  const x = Array.isArray(r) ? r[0] || {} : r || {};
  const code = clean(x.current_status_code).toUpperCase();
  const known = CODES[code];
  const text = clean(x.current_status);
  return {
    found: true,
    shipwayOrderId,
    statusCode: code,
    status: text || (known && known[0]) || code || 'Unknown',
    group: known ? known[1] : (code || text ? 'other' : 'other'),
    final: FINAL.has(code),
    carrier: clean(x.carrier), awb: clean(x.awbno || x.awb), from: clean(x.from), to: clean(x.to),
    pickupDate: clean(x.pickup_date), statusTime: clean(x.time), statusAt: parseWhen(x.time),
  };
}

// Which orders to ask Shipway about this round. Pure, so the rules can be tested.
// orders: [{ orderId, orderDate }]; docs: Map(orderId -> ShipwayShipment). Newest orders first.
function pickCandidates(orders, docs, now = new Date(), o = {}) {
  const ACTIVE = (o.activeMin || 30) * 60000; // still moving: look again after this long
  const MISSING = (o.missingMin || 180) * 60000; // not in Shipway yet: look again after this long (only for fresh orders)
  const FAILED = (o.failedMin || 15) * 60000; // a failed lookup: retry sooner
  const MAX_AGE = (o.missingDays || 30) * 86400000;
  const limit = o.limit || 300;
  const due = [];
  for (const ord of orders) {
    if (ord.orderId == null) continue;
    const d = docs.get(ord.orderId);
    const age = ord.orderDate ? now - new Date(ord.orderDate) : 0;
    let rank = null; // lower = sooner
    if (!d) rank = 0;
    else if (d.error) { if (now - d.checkedAt >= FAILED) rank = 1; }
    else if (d.found && !d.final) { if (now - d.checkedAt >= ACTIVE) rank = 2; }
    else if (!d.found) { if (age <= MAX_AGE && now - d.checkedAt >= MISSING) rank = 3; }
    if (rank !== null) due.push({ orderId: ord.orderId, rank, at: d ? +new Date(d.checkedAt) : 0 });
  }
  due.sort((a, b) => a.rank - b.rank || a.at - b.at);
  return due.slice(0, limit).map((x) => x.orderId);
}

module.exports = { normalizeShipment, pickCandidates, parseWhen, CODES, GROUPS, FINAL };
