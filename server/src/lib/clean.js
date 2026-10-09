// Pure cleaning pipeline: raw sheet rows in, cleaned order records out. No DB, no network.
const { istParts, istToDate } = require('./istTime');

// Order Sheet columns A..O, by position (column A has no header in the source).
const COL = { date: 0, id: 1, name: 2, phone: 3, amount: 4, items: 5, link: 6, pay: 7, confirmed: 8, dispatch: 9, delivery: 10, ndr: 11, rto: 12, notes: 13, rtoReason: 14 };
const RAW_HEADERS = ['Order date-time', 'Order ID', 'Name', 'Phone', 'Amount', 'Items', 'Order Link', 'COD/Prepaid', 'Order Confirmed', 'Dispatch Status', 'Delivery Status', 'NDR', 'RTO', 'NOTES', 'RTO REASON'];
const NCOLS = 15;
const TEST_AMOUNT_BELOW = 100;

const str = (v) => (v == null ? '' : String(v)).replace(/\u00a0/g, ' ').trim();
const isUrl = (s) => /^https?:\/\//i.test(s);

// "DD/MM HH:MM", "DD/MM/YYYY HH:MM[:SS]", "YYYY-MM-DD[ T]HH:MM[:SS][ +05:30]". Wall-clock values are IST.
function parseDateTime(input, now, { inferYear = false } = {}) {
  const s = str(input);
  if (!s) return null;
  let m = /^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(s);
  if (m) {
    const day = +m[1], mon = +m[2] - 1;
    let year = m[3] ? +m[3] : null;
    if (year != null && year < 100) year += 2000;
    let h = m[4] ? +m[4] : 0;
    const mi = m[5] ? +m[5] : 0, sec = m[6] ? +m[6] : 0;
    if (m[7]) { const pm = /p/i.test(m[7]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    if (year == null) {
      if (!inferYear) return null;
      year = istParts(now).y;
      let d = istToDate(year, mon, day, h, mi, sec);
      if (d.getTime() > now.getTime() + 36e5) { year -= 1; d = istToDate(year, mon, day, h, mi, sec); } // would land in the future
      return validate(d, year, mon, day) ? d : null;
    }
    const d = istToDate(year, mon, day, h, mi, sec);
    return validate(d, year, mon, day) ? d : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]+(\d{2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (m) {
    const tz = m[7];
    if (tz) {
      const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}${tz === 'Z' ? 'Z' : tz.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`;
      const d = new Date(iso);
      return isNaN(d) ? null : d;
    }
    const d = istToDate(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return validate(d, +m[1], +m[2] - 1, +m[3]) ? d : null;
  }
  return null;
}
function validate(d, y, mon, day) {
  const p = istParts(d);
  return p.y === y && p.m === mon && p.d === day;
}

function parseOrderId(v) {
  const s = str(v).replace(/^#/, '').trim();
  return /^\d+$/.test(s) ? parseInt(s, 10) : null;
}
function parseAmount(v) {
  const s = str(v).replace(/[₹,]|rs\.?|inr/gi, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function normPayment(v) {
  const s = str(v).toLowerCase();
  if (!s) return 'Unknown';
  if (s.includes('partial')) return 'Partial COD';
  if (s.includes('prepaid') || s.includes('pre-paid') || s.includes('pre paid')) return 'Prepaid';
  if (s.includes('cod') || s.includes('cash')) return 'COD';
  return 'Unknown';
}
function normDelivery(v) {
  const s = str(v).toLowerCase().replace(/\s+/g, ' ');
  if (!s) return '';
  if (s.startsWith('deliver')) return 'Delivered';
  if (/^in ?-?transit/.test(s)) return 'In Transit';
  if (/^dispatch ?-? ?today/.test(s)) return 'Ready to Ship';
  return str(v);
}
const yes = (v) => /^y(es)?$/i.test(str(v));
function normConfirmed(v) {
  const s = str(v).toLowerCase();
  if (yes(s)) return 'Yes';
  if (s.startsWith('cancel')) return 'Cancel';
  return 'Pending';
}
function parsePhoneEmail(v) {
  const s = str(v);
  if (!s || /^\(?blank\)?$/i.test(s)) return { phone: null, email: null };
  if (s.includes('@')) return { phone: null, email: s.toLowerCase() };
  const digits = s.replace(/\D/g, '');
  return { phone: digits.length >= 10 ? digits.slice(-10) : null, email: null };
}

function finalStatus(o) {
  if (o.rto === 'Yes') return 'RTO';
  if (o.deliveryStatus === 'Delivered') return 'Delivered';
  if (o.deliveryStatus === 'In Transit' || o.dispatchYes) return 'In Transit';
  if (o.confirmed === 'Yes') return 'Confirmed';
  if (o.confirmed === 'Cancel') return 'Cancelled';
  return 'Pending confirmation';
}

const filledStatusCount = (raw) => [COL.pay, COL.confirmed, COL.dispatch, COL.delivery, COL.ndr, COL.rto].filter((i) => str(raw[i])).length;
const filledTotal = (raw) => raw.filter((c) => str(c)).length;

/**
 * @param {Array<Array<string>>} orderRows  Order Sheet rows incl. header row 1
 * @param {Object} opts { masterDates: Map<id,{date,pincode,tags}>, shopifyDates: Map<id,Date>, now }
 */
function cleanOrders(orderRows, { masterDates = new Map(), shopifyDates = new Map(), now = new Date() } = {}) {
  const warnings = [];
  const rows = [];
  orderRows.forEach((r, idx) => {
    const raw = Array.from({ length: NCOLS }, (_, i) => str((r || [])[i]));
    if (idx === 0 && /order\s*id/i.test(raw[COL.id])) return; // header row
    if (!raw.some(Boolean)) return;
    rows.push({ sheetRow: idx + 1, raw });
  });

  const recs = rows.map(({ sheetRow, raw }) => {
    const log = [];
    const idRaw = raw[COL.id];
    const orderId = parseOrderId(idRaw);
    if (orderId == null) log.push(idRaw ? `Order ID "${idRaw}" is not numeric` : 'Order ID is empty');
    else if (idRaw !== `#${orderId}` && idRaw !== String(orderId)) log.push(`Order ID "${idRaw}" normalised to ${orderId}`);

    const amount = parseAmount(raw[COL.amount]);
    if (raw[COL.amount] && amount == null) log.push(`Amount "${raw[COL.amount]}" is not a number`);

    let product = raw[COL.items];
    let orderLink = raw[COL.link];
    if (isUrl(product)) {
      if (!orderLink) orderLink = product;
      log.push('Items held a URL: moved to Order Link, product set to Unknown');
      product = 'Unknown';
    }
    if (!product) product = 'Unknown';

    const { phone, email } = parsePhoneEmail(raw[COL.phone]);
    if (email) log.push('Phone column held an email: moved to email field');

    const paymentMode = normPayment(raw[COL.pay]);
    const deliveryStatus = normDelivery(raw[COL.delivery]);
    if (str(raw[COL.delivery]) && deliveryStatus !== str(raw[COL.delivery])) log.push(`Delivery status "${raw[COL.delivery]}" mapped to ${deliveryStatus}`);
    const rtoRaw = str(raw[COL.rto]);
    const rto = yes(rtoRaw) ? 'Yes' : /^no?$/i.test(rtoRaw) ? 'No' : '';
    const o = {
      sheetRow, orderId, raw,
      name: raw[COL.name], phone, email, amount, product, orderLink: orderLink || null,
      paymentMode, confirmed: normConfirmed(raw[COL.confirmed]), dispatchYes: yes(raw[COL.dispatch]),
      deliveryStatus, ndr: yes(raw[COL.ndr]), rto,
      notes: raw[COL.notes], rtoReason: raw[COL.rtoReason],
      excluded: null, excludedReason: null, duplicateOf: null,
      orderDate: null, dateSource: null, conflicts: [], log,
    };
    if (paymentMode === 'Unknown' && raw[COL.pay]) log.push(`Payment mode "${raw[COL.pay]}" not recognised`);
    o.finalStatus = finalStatus(o);
    o.dispatched = o.dispatchYes || ['In Transit', 'Delivered', 'RTO'].includes(o.finalStatus);
    return o;
  });

  // --- Missing IDs
  for (const o of recs) if (o.orderId == null) { o.excluded = 'noid'; o.excludedReason = 'No usable order ID'; }

  // --- Duplicates: keep the row with most filled status columns (then most filled cells, then the later row)
  const byId = new Map();
  for (const o of recs) if (o.orderId != null) (byId.get(o.orderId) || byId.set(o.orderId, []).get(o.orderId)).push(o);
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    const keep = [...group].sort((a, b) =>
      filledStatusCount(b.raw) - filledStatusCount(a.raw) || filledTotal(b.raw) - filledTotal(a.raw) || b.sheetRow - a.sheetRow)[0];
    keep.log.push(`Order #${id} appears ${group.length} times (rows ${group.map((g) => g.sheetRow).join(', ')}): this row kept`);
    // A kept row with no date in column A may borrow it from a duplicate.
    keep._dupRows = group.filter((g) => g !== keep);
    for (const g of group) if (g !== keep) {
      g.excluded = 'duplicate'; g.excludedReason = `Duplicate of row ${keep.sheetRow}`; g.duplicateOf = keep.sheetRow;
      g.log.push(`Flagged duplicate of row ${keep.sheetRow}`);
    }
  }

  // --- Test orders (only on kept rows)
  for (const o of recs) {
    if (o.excluded) continue;
    const why = [];
    if (o.amount != null && o.amount < TEST_AMOUNT_BELOW) why.push(`amount Rs ${o.amount} < ${TEST_AMOUNT_BELOW}`);
    if (/\btest/i.test(o.name)) why.push('name contains "test"');
    if (o.notes.toLowerCase() === 'test') why.push('notes = "test"');
    if (why.length) { o.excluded = 'test'; o.excludedReason = why.join('; '); o.log.push(`Flagged test order: ${o.excludedReason}`); }
  }

  // --- Order date: sheet col A (year inferred) > OrdersMaster > Shopify CSV
  let fromSheet = 0, fromMaster = 0, fromShopify = 0;
  for (const o of recs) {
    if (o.orderId == null) continue;
    let d = parseDateTime(o.raw[COL.date], now, { inferYear: true });
    let src = d ? 'sheet' : null;
    if (!d && o._dupRows) {
      for (const dup of o._dupRows) {
        d = parseDateTime(dup.raw[COL.date], now, { inferYear: true });
        if (d) { src = 'sheet'; o.log.push(`Date taken from duplicate row ${dup.sheetRow}`); break; }
      }
    }
    if (!d && masterDates.has(o.orderId)) { d = masterDates.get(o.orderId).date; src = d ? 'ordersmaster' : null; }
    if (!d && shopifyDates.has(o.orderId)) { d = shopifyDates.get(o.orderId); src = d ? 'shopify-csv' : null; }
    if (d) {
      o.orderDate = d; o.dateSource = src;
      if (src === 'sheet' && !/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}/.test(o.raw[COL.date])) o.log.push(`Year added to "${o.raw[COL.date]}" (${istParts(d).y})`);
      else if (src !== 'sheet') o.log.push(`Date from ${src}`);
      if (src === 'sheet') fromSheet++; else if (src === 'ordersmaster') fromMaster++; else fromShopify++;
    } else if (!o.excluded) o.log.push('No order date found: undated');
    const mm = masterDates.get(o.orderId);
    if (mm) { o.pincode = mm.pincode || null; o.masterTags = mm.tags || null; }
  }

  // --- Conflicts
  for (const o of recs) {
    if (o.confirmed === 'Cancel' && (o.dispatchYes || ['Delivered', 'In Transit', 'RTO'].includes(o.deliveryStatus))) o.conflicts.push('Cancelled but dispatched');
    if (o.rto === 'Yes' && o.deliveryStatus === 'Delivered') o.conflicts.push('RTO = Yes but Delivery Status = Delivered (counted as RTO)');
    if (o.ndr && !o.dispatched) o.conflicts.push('NDR = Yes but not dispatched');
    if (o.dispatchYes && o.confirmed === 'Pending') o.conflicts.push('Dispatched but confirmation blank');
    if (o.conflicts.length) o.log.push(...o.conflicts.map((c) => `Conflict: ${c}`));
    delete o._dupRows;
  }

  const valid = recs.filter((o) => !o.excluded);
  const summary = {
    sheetRows: recs.length,
    valid: valid.length,
    missingId: recs.filter((o) => o.excluded === 'noid').length,
    duplicates: recs.filter((o) => o.excluded === 'duplicate').length,
    tests: recs.filter((o) => o.excluded === 'test').length,
    undated: valid.filter((o) => !o.orderDate).length,
    conflicts: recs.filter((o) => !o.excluded && o.conflicts.length).length,
    dateSources: { sheet: fromSheet, ordersmaster: fromMaster, shopifyCsv: fromShopify },
  };
  return { orders: recs, summary, warnings };
}

/** OrdersMaster tab → Map(orderId → {date, pincode, tags}). Columns found by header name. */
function parseOrdersMaster(rows, now = new Date()) {
  const warnings = [];
  const map = new Map();
  if (!rows || !rows.length) return { map, warnings };
  const hdr = rows[0].map((h) => str(h).toLowerCase());
  const find = (...res) => hdr.findIndex((h) => res.some((re) => re.test(h)));
  const idIdx = find(/^order\s*(id|no|number|name)?$/, /order.*(id|number|name)/, /^name$/, /^id$/);
  const tsIdx = find(/timestamp/, /created/, /^date/, /order.*date/);
  const pinIdx = find(/pin ?code|zip|postal/);
  const tagIdx = find(/tags?/);
  if (idIdx < 0 || tsIdx < 0) {
    warnings.push(`OrdersMaster: could not find order ID / timestamp columns in header [${rows[0].join(' | ')}]; tab ignored.`);
    return { map, warnings };
  }
  for (const r of rows.slice(1)) {
    const id = parseOrderId(r[idIdx]);
    if (id == null) continue;
    const date = parseDateTime(r[tsIdx], now);
    const prev = map.get(id);
    // duplicates: keep the earliest timestamp (the order creation)
    if (!prev || (date && (!prev.date || date < prev.date))) {
      map.set(id, { date, pincode: pinIdx >= 0 ? str(r[pinIdx]) : prev && prev.pincode, tags: tagIdx >= 0 ? str(r[tagIdx]) : prev && prev.tags });
    }
  }
  return { map, warnings };
}

/** Shopify orders CSV rows (header + data) → Map(orderId → Date). Uses "Name" and "Created at". */
function parseShopifyExport(rows, now = new Date()) {
  const map = new Map();
  if (!rows || !rows.length) return map;
  const hdr = rows[0].map((h) => str(h).toLowerCase());
  const idIdx = hdr.findIndex((h) => h === 'name' || h === 'order' || h === 'order name');
  const tsIdx = hdr.findIndex((h) => h === 'created at' || h === 'created_at');
  if (idIdx < 0 || tsIdx < 0) throw Object.assign(new Error('Shopify export needs "Name" and "Created at" columns'), { status: 400 });
  for (const r of rows.slice(1)) {
    const id = parseOrderId(r[idIdx]);
    const d = parseDateTime(r[tsIdx], now);
    if (id != null && d && !map.has(id)) map.set(id, d);
  }
  return map;
}

module.exports = { cleanOrders, parseOrdersMaster, parseShopifyExport, parseDateTime, normPayment, normDelivery, finalStatus, COL, RAW_HEADERS, NCOLS };
