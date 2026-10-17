// Order analysis sheet: one styled Excel workbook that shows, for every order, everything that happened to it.
//   Summary        totals, stage split, cancel reasons, per-person work
//   Order Journey  one row per order: customer, calls, confirmation, cancel, packing slip, packed (AWB + photo), handover, Shipway, timings
//   Activity Log   one row per saved action (who, when, what, reason), grouped by order
// No database and no network in here: the service hands in plain objects, so this file is unit-testable.
// Phone, e-mail and street address are left out on purpose (the dashboard keeps them behind a Reveal button).
const ExcelJS = require('exceljs');
const D = require('./desk');
const DP = require('./dispatch');

const IST_MS = 330 * 60 * 1000;
const ist = (d) => { const t = d ? new Date(d).getTime() : NaN; return Number.isFinite(t) ? new Date(t + IST_MS) : null; }; // Excel has no time zones: shift so the cell SHOWS IST; a bad date becomes an empty cell, never NaN
const hrs = (a, b) => (a && b ? Math.round(((new Date(b) - new Date(a)) / 36e5) * 10) / 10 : null);
const ontime = (x) => (!x || !x.at ? '' : x.late ? 'Late' : 'On time');
const yes = (v) => (v ? 'Yes' : '');

const ACTION_LABEL = {
  enter_queue: 'Entered queue', dnp: 'Did not pick up', confirm: 'Confirmed', partial_paid: 'Partial payment', cancel: 'Cancelled', auto_cancel: 'Auto-cancelled',
  restore: 'Restored', dispatch: 'Handed over', slip_done: 'Packing slip done', packed: 'Order packed', shopify_cancel: 'Cancelled in Shopify', move_pending: 'Moved to Pending',
};
const actionName = (a) => ACTION_LABEL[a] || String(a || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// ------------------------------------------------------------------------------------------------ data -> rows
// inputs: shop (ShopifyOrder or null), desk (DeskOrder or null), ship (ShipwayShipment or null), dconf (dispatch settings), now
function journeyRow({ orderId, shop, desk, ship, dconf = DP.DEFAULT_DISPATCH_CONFIG, now = new Date() }) {
  const s = shop || {}; const c = s.customer || {}; const a = s.address || {}; const d = desk || { stage: 'none', log: [] };
  const log = d.log || [];
  const dq = d.dq || {}; const slip = dq.slip || {}; const packed = dq.packed || {}; const hand = dq.handover || {};
  const partial = d.partial && d.partial.amount > 0 ? d.partial : null;
  const cancel = d.cancel && d.cancel.reason ? d.cancel : null;
  const total = s.total == null ? null : s.total;
  const step = DP.stepOf(d); const due = step ? DP.dueAt(d, dconf) : null;
  const handedAt = hand.at || (d.dispatch && d.dispatch.at) || null;
  const payment = (s.paymentGateways || []).join(', ') || s.financialStatus || '';
  return {
    orderId: orderId || d.orderId || s.orderId,
    orderName: s.name || `#${orderId || d.orderId}`,
    placedAt: ist(d.orderAt || s.createdAt),
    customer: c.name || a.name || '', city: a.city || '', state: a.state || '', items: s.itemsSummary || '', total,
    payment, prepaid: /^paid$/i.test(s.financialStatus || ''), source: (s.marketing && (s.marketing.sourceGroup || s.marketing.utmSource)) || '',
    calls: log.filter((e) => e.action === 'dnp').length, whatsapp: log.filter((e) => e.action === 'dnp' && e.whatsappShared).length,
    confirmedAt: ist(d.confirmedAt), confirmedBy: d.confirmedBy || '', confirmedFu: d.confirmedAtFu || '',
    partialAmount: partial ? partial.amount : null, partialShot: partial ? yes(partial.screenshotId) : '',
    balance: total == null || d.stage === 'cancelled' ? null : D.collectAmount(total, s.financialStatus, partial),
    stage: d.stage, status: D.statusLabel(desk), stageLabel: D.STAGE_LABEL[d.stage] || 'Not in queue',
    cancelReason: cancel ? cancel.reason : '', cancelAt: cancel ? ist(cancel.at) : null, cancelBy: cancel ? (cancel.auto ? `${cancel.byName || 'System'} (auto)` : cancel.byName || '') : '',
    slipAt: ist(slip.at), slipBy: slip.byName || '', slipOn: ontime(slip),
    packedAt: ist(packed.at), packedBy: packed.byName || '', awb: packed.awb || (d.dispatch && d.dispatch.awb) || (ship && ship.awb) || '', courier: packed.courier || (d.dispatch && d.dispatch.courier) || (ship && ship.carrier) || '',
    packPhoto: yes(packed.photoId), packedOn: ontime(packed),
    handAt: ist(handedAt), handBy: hand.byName || (d.dispatch && d.dispatch.byName) || '', manifest: yes(hand.manifestId), handOn: ontime(hand),
    waitingAt: step ? DP.STEP_LABEL[step] : '', dueBy: ist(due), overdue: !!due && due.getTime() < new Date(now).getTime() ? 'Overdue' : '',
    shipStatus: ship ? ship.status || '' : '', shipCarrier: ship ? ship.carrier || '' : '', shipAt: ship ? ist(ship.statusAt) : null,
    hOrderConfirm: hrs(d.orderAt || s.createdAt, d.confirmedAt), hConfirmHand: hrs(d.confirmedAt, handedAt), hOrderHand: hrs(d.orderAt || s.createdAt, handedAt),
    story: log.filter((e) => e.action !== 'enter_queue' || log.length === 1).map((e) => `${fmtShort(e.at)} · ${e.by || 'System'} · ${e.label || actionName(e.action)}`).join('\n'),
    events: log.map((e) => ({
      orderName: s.name || `#${orderId || d.orderId}`, at: ist(e.at), by: e.by || 'System', stage: D.STAGE_LABEL[e.stage] || e.stage || '', fu: e.fu || '',
      action: actionName(e.action), label: e.label || '', whatsapp: e.action === 'dnp' ? (e.whatsappShared ? 'Yes' : 'No') : '', reason: e.reason || '', amount: e.amount == null ? null : e.amount,
    })),
  };
}
function fmtShort(d) {
  if (!d) return '';
  const x = ist(d); const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${p(x.getUTCDate())} ${M[x.getUTCMonth()]} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}`;
}

// ------------------------------------------------------------------------------------------------ numbers for the Summary tab
function summarise(rows) {
  const by = (f) => rows.reduce((m, r) => { const k = f(r); if (k) m[k] = (m[k] || 0) + 1; return m; }, {});
  const avg = (k) => { const v = rows.map((r) => r[k]).filter((x) => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
  const people = new Map();
  for (const r of rows) for (const e of r.events) {
    if (!e.by || e.by === 'System' || e.by === 'Shopify') continue;
    const p = people.get(e.by) || { name: e.by, calls: 0, confirmed: 0, partial: 0, cancelled: 0, slips: 0, packed: 0, handed: 0 };
    if (e.action === 'Did not pick up') p.calls++;
    else if (e.action === 'Confirmed') { p.confirmed++; p.calls++; } else if (e.action === 'Partial payment') { p.partial++; p.calls++; }
    else if (e.action === 'Cancelled') { p.cancelled++; p.calls++; } else if (e.action === 'Packing slip done') p.slips++;
    else if (e.action === 'Order packed') p.packed++; else if (e.action === 'Handed over') p.handed++;
    people.set(e.by, p);
  }
  const n = rows.length;
  const confirmed = rows.filter((r) => r.confirmedAt).length; const cancelled = rows.filter((r) => r.stage === 'cancelled').length;
  const handed = rows.filter((r) => r.handAt).length;
  return {
    n, value: rows.reduce((a, r) => a + (r.total || 0), 0), confirmed, cancelled, handed,
    open: rows.filter((r) => r.stage === 'confirm' || r.stage === 'pending').length, inDispatch: rows.filter((r) => r.stage === 'dispatch').length,
    overdue: rows.filter((r) => r.overdue).length, late: rows.filter((r) => [r.slipOn, r.packedOn, r.handOn].includes('Late')).length,
    avgConfirm: avg('hOrderConfirm'), avgConfirmHand: avg('hConfirmHand'), avgOrderHand: avg('hOrderHand'),
    stages: by((r) => r.stageLabel), reasons: by((r) => r.cancelReason), people: [...people.values()].sort((a, b) => b.calls + b.slips + b.packed + b.handed - (a.calls + a.slips + a.packed + a.handed)),
  };
}

// ------------------------------------------------------------------------------------------------ styling
const C = {
  navy: 'FF1F2A44', teal: 'FF0F766E', ink: 'FF1F2937', grey: 'FF6B7280', line: 'FFE5E7EB', zebra: 'FFF8FAFC', white: 'FFFFFFFF',
  group: { order: 'FF334155', confirm: 'FF0369A1', outcome: 'FF7C3AED', dispatch: 'FF0F766E', ship: 'FFB45309', timing: 'FF475569', story: 'FF1F2A44' },
  stage: { confirm: ['FFFEF3C7', 'FF92400E'], pending: ['FFFFEDD5', 'FF9A3412'], dispatch: ['FFDBEAFE', 'FF1E40AF'], dispatched: ['FFD1FAE5', 'FF065F46'], cancelled: ['FFFEE2E2', 'FF991B1B'], none: ['FFF3F4F6', 'FF4B5563'] },
  good: ['FFD1FAE5', 'FF065F46'], bad: ['FFFEE2E2', 'FF991B1B'],
};
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: C.line } };
const box = { top: thin, bottom: thin, left: thin, right: thin };
const DT = 'dd-mmm-yy hh:mm'; const INR = '"₹"#,##0.##';

// [header, key, width, group, numFmt?, align?]
const COLS = [
  ['Order', 'orderName', 10, 'order'], ['Placed (IST)', 'placedAt', 16, 'order', DT], ['Customer', 'customer', 20, 'order'], ['City', 'city', 14, 'order'], ['State', 'state', 14, 'order'],
  ['Items', 'items', 34, 'order'], ['Total', 'total', 11, 'order', INR], ['Payment', 'payment', 24, 'order'], ['Source', 'source', 14, 'order'],
  ['Current status', 'status', 24, 'outcome'], ['Cancel reason', 'cancelReason', 22, 'outcome'], ['Cancelled at (IST)', 'cancelAt', 16, 'outcome', DT], ['Cancelled by', 'cancelBy', 14, 'outcome'],
  ['Calls not picked up', 'calls', 10, 'confirm', '0', 'center'], ['WhatsApp shared', 'whatsapp', 10, 'confirm', '0', 'center'], ['Confirmed at (IST)', 'confirmedAt', 16, 'confirm', DT],
  ['Confirmed by', 'confirmedBy', 14, 'confirm'], ['Confirmed at call', 'confirmedFu', 10, 'confirm', null, 'center'], ['Partial paid', 'partialAmount', 11, 'confirm', INR], ['Screenshot', 'partialShot', 10, 'confirm', null, 'center'], ['Balance to collect', 'balance', 12, 'confirm', INR],
  ['Slip done (IST)', 'slipAt', 16, 'dispatch', DT], ['Slip by', 'slipBy', 12, 'dispatch'], ['Slip', 'slipOn', 9, 'dispatch', null, 'center'],
  ['Packed (IST)', 'packedAt', 16, 'dispatch', DT], ['Packed by', 'packedBy', 12, 'dispatch'], ['AWB', 'awb', 18, 'dispatch'], ['Courier', 'courier', 14, 'dispatch'], ['Package photo', 'packPhoto', 9, 'dispatch', null, 'center'], ['Packed', 'packedOn', 9, 'dispatch', null, 'center'],
  ['Handed over (IST)', 'handAt', 16, 'dispatch', DT], ['Handed over by', 'handBy', 13, 'dispatch'], ['Manifest photo', 'manifest', 9, 'dispatch', null, 'center'], ['Handover', 'handOn', 9, 'dispatch', null, 'center'],
  ['Waiting at step', 'waitingAt', 16, 'dispatch'], ['Step due (IST)', 'dueBy', 16, 'dispatch', DT], ['Overdue?', 'overdue', 9, 'dispatch', null, 'center'],
  ['Shipway status', 'shipStatus', 20, 'ship'], ['Last update (IST)', 'shipAt', 16, 'ship', DT],
  ['Order → confirmed (h)', 'hOrderConfirm', 11, 'timing', '0.0'], ['Confirmed → handed over (h)', 'hConfirmHand', 12, 'timing', '0.0'], ['Order → handed over (h)', 'hOrderHand', 11, 'timing', '0.0'],
  ['What happened (all saved responses)', 'story', 70, 'story'],
];
const GROUP_NAME = { order: 'ORDER', outcome: 'OUTCOME', confirm: 'CONFIRMATION', dispatch: 'DISPATCH QUEUE', ship: 'SHIPWAY', timing: 'TIMING', story: 'TIMELINE' };

// ------------------------------------------------------------------------------------------------ the workbook
async function buildWorkbook(rows, meta = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MySoul Order Analytics'; wb.created = new Date();
  const sum = summarise(rows);
  summarySheet(wb, sum, meta);
  journeySheet(wb, rows);
  logSheet(wb, rows);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function title(ws, text, sub, span) {
  ws.mergeCells(1, 1, 1, span); ws.mergeCells(2, 1, 2, span);
  Object.assign(ws.getCell(1, 1), { value: text, font: { name: 'Calibri', size: 18, bold: true, color: { argb: C.white } }, fill: fill(C.navy), alignment: { vertical: 'middle', indent: 1 } });
  Object.assign(ws.getCell(2, 1), { value: sub, font: { name: 'Calibri', size: 10, italic: true, color: { argb: C.white } }, fill: fill(C.teal), alignment: { vertical: 'middle', indent: 1 } });
  ws.getRow(1).height = 30; ws.getRow(2).height = 18;
}

function summarySheet(wb, s, meta) {
  const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }], properties: { tabColor: { argb: C.teal } } });
  ws.columns = [{ width: 3 }, { width: 42 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
  title(ws, meta.title || 'Order analysis', `${meta.scope || 'All orders'} · generated ${fmtShort(new Date())} IST · ${s.n} order${s.n === 1 ? '' : 's'}`, 9);
  // KPI tiles: label above, number below
  const tiles = [['Orders', s.n, '#,##0'], ['Order value', s.value, INR], ['Confirmed', s.confirmed, '#,##0'], ['Cancelled', s.cancelled, '#,##0'], ['Handed to courier', s.handed, '#,##0'], ['Still open', s.open + s.inDispatch, '#,##0'], ['Overdue now', s.overdue, '#,##0']];
  tiles.forEach(([l, v, f], i) => {
    const col = 2 + i;
    Object.assign(ws.getCell(4, col), { value: l, font: { size: 9, bold: true, color: { argb: C.grey } }, alignment: { horizontal: 'center', vertical: 'middle' }, fill: fill(C.zebra), border: { top: thin, left: thin, right: thin } });
    const bad = l === 'Overdue now' && v > 0;
    Object.assign(ws.getCell(5, col), { value: v, numFmt: f, font: { size: 18, bold: true, color: { argb: bad ? 'FF991B1B' : C.navy } }, alignment: { horizontal: 'center', vertical: 'middle' }, fill: fill(C.zebra), border: { bottom: thin, left: thin, right: thin } });
  });
  ws.getRow(4).height = 18; ws.getRow(5).height = 34;
  let r = 7;
  const head = (text) => { ws.mergeCells(r, 2, r, 5); Object.assign(ws.getCell(r, 2), { value: text, font: { bold: true, size: 11, color: { argb: C.white } }, fill: fill(C.navy), alignment: { indent: 1 } }); r++; };
  const kv = (k, v, f) => { Object.assign(ws.getCell(r, 2), { value: k, border: box }); ws.mergeCells(r, 3, r, 4); Object.assign(ws.getCell(r, 3), { value: v == null ? '—' : v, numFmt: f, alignment: { horizontal: 'right' }, border: box, font: { bold: true } }); r++; };

  head('Speed'); kv('Average: order → confirmed (hours)', s.avgConfirm, '0.0'); kv('Average: confirmed → handed over (hours)', s.avgConfirmHand, '0.0'); kv('Average: order → handed over (hours)', s.avgOrderHand, '0.0');
  kv('Orders with a late step', s.late, '0'); r++;
  head('Where orders are now');
  for (const [k, v] of Object.entries(s.stages).sort((a, b) => b[1] - a[1])) kv(k, v, '0');
  r++;
  if (Object.keys(s.reasons).length) { head('Why orders were cancelled'); for (const [k, v] of Object.entries(s.reasons).sort((a, b) => b[1] - a[1])) kv(k, v, '0'); r++; }
  if (s.people.length) {
    const h = ['Person', 'Calls', 'Confirmed', 'Partial', 'Cancelled', 'Slips', 'Packed', 'Handed over'];
    h.forEach((t, i) => Object.assign(ws.getCell(r, 2 + i), { value: t, font: { bold: true, color: { argb: C.white } }, fill: fill(C.navy), alignment: { horizontal: i ? 'center' : 'left', indent: i ? 0 : 1 } }));
    r++;
    for (const p of s.people) {
      [p.name, p.calls, p.confirmed, p.partial, p.cancelled, p.slips, p.packed, p.handed].forEach((v, i) => Object.assign(ws.getCell(r, 2 + i), { value: v, border: box, alignment: { horizontal: i ? 'center' : 'left' }, font: { bold: i === 0 } }));
      r++;
    }
  }
  ws.getCell(r + 1, 2).value = 'Times are IST. Phone, e-mail and street address are not included. Open the “Order Journey” tab for one row per order and “Activity Log” for every saved action.';
  ws.getCell(r + 1, 2).font = { italic: true, size: 9, color: { argb: C.grey } };
}

function journeySheet(wb, rows) {
  const ws = wb.addWorksheet('Order Journey', { properties: { tabColor: { argb: C.navy } }, views: [{ state: 'frozen', xSplit: 1, ySplit: 4, showGridLines: false }] });
  ws.columns = COLS.map((c) => ({ key: c[1], width: c[2] }));
  title(ws, 'Order journey: what happened to each order', 'One row per order · filter any column · the last column lists every saved response in order', COLS.length);
  // group band (row 3) and header (row 4)
  let start = 1;
  COLS.forEach((c, i) => {
    const last = i === COLS.length - 1 || COLS[i + 1][3] !== c[3];
    if (last) {
      if (i > start - 1) ws.mergeCells(3, start, 3, i + 1);
      Object.assign(ws.getCell(3, start), { value: GROUP_NAME[c[3]], font: { bold: true, size: 9, color: { argb: C.white } }, fill: fill(C.group[c[3]]), alignment: { horizontal: 'center', vertical: 'middle' }, border: box });
      start = i + 2;
    }
    Object.assign(ws.getCell(4, i + 1), { value: c[0], font: { bold: true, size: 10, color: { argb: C.white } }, fill: fill(C.group[c[3]]), alignment: { horizontal: 'center', vertical: 'middle', wrapText: true }, border: box });
  });
  ws.getRow(3).height = 16; ws.getRow(4).height = 44;
  rows.forEach((row, ri) => {
    const r = ws.getRow(5 + ri);
    COLS.forEach((c, i) => {
      const cell = r.getCell(i + 1);
      cell.value = row[c[1]] === '' ? null : row[c[1]];
      if (c[4]) cell.numFmt = c[4];
      cell.border = box; cell.font = { name: 'Calibri', size: 10 };
      cell.alignment = { vertical: 'top', horizontal: c[5] || (c[4] === INR || c[4] === '0.0' ? 'right' : 'left'), wrapText: c[1] === 'story' || c[1] === 'items' };
      if (ri % 2) cell.fill = fill(C.zebra);
      if (c[1] === 'orderName') cell.font = { bold: true, size: 10, color: { argb: C.navy } };
      if (['slipOn', 'packedOn', 'handOn'].includes(c[1]) && cell.value) Object.assign(cell, { fill: fill((cell.value === 'Late' ? C.bad : C.good)[0]), font: { size: 10, bold: true, color: { argb: (cell.value === 'Late' ? C.bad : C.good)[1] } } });
      if (c[1] === 'overdue' && cell.value) Object.assign(cell, { fill: fill(C.bad[0]), font: { size: 10, bold: true, color: { argb: C.bad[1] } } });
      if (c[1] === 'status') { const [bg, fg] = C.stage[row.stage] || C.stage.none; Object.assign(cell, { fill: fill(bg), font: { size: 10, bold: true, color: { argb: fg } } }); }
      if (c[1] === 'cancelReason' && cell.value) cell.font = { size: 10, color: { argb: C.bad[1] } };
    });
    const lines = Math.max(1, String(row.story || '').split('\n').length);
    r.height = Math.min(150, Math.max(18, lines * 13.5));
  });
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + Math.max(1, rows.length), column: COLS.length } };
}

function logSheet(wb, rows) {
  const ws = wb.addWorksheet('Activity Log', { properties: { tabColor: { argb: 'FF7C3AED' } }, views: [{ state: 'frozen', ySplit: 3, showGridLines: false }] });
  const L = [['Order', 'orderName', 10], ['Time (IST)', 'at', 17], ['Person', 'by', 16], ['Stage', 'stage', 16], ['Follow-up', 'fu', 10], ['Action', 'action', 20], ['What happened', 'label', 62], ['WhatsApp shared', 'whatsapp', 11], ['Reason', 'reason', 24], ['Amount', 'amount', 12]];
  ws.columns = L.map((c) => ({ key: c[1], width: c[2] }));
  title(ws, 'Activity log: every saved action', 'Oldest first inside each order · nothing here can be edited in the app', L.length);
  L.forEach((c, i) => Object.assign(ws.getCell(3, i + 1), { value: c[0], font: { bold: true, color: { argb: C.white } }, fill: fill(C.group.dispatch), alignment: { horizontal: 'center', vertical: 'middle', wrapText: true }, border: box }));
  ws.getRow(3).height = 28;
  let r = 4; let n = 0;
  for (const row of rows) {
    n++;
    for (const e of row.events) {
      L.forEach((c, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = e[c[1]] === '' ? null : e[c[1]];
        cell.border = box; cell.font = { size: 10, bold: c[1] === 'orderName' }; cell.alignment = { vertical: 'top', wrapText: c[1] === 'label' };
        if (c[1] === 'at') cell.numFmt = DT;
        if (c[1] === 'amount') cell.numFmt = INR;
        if (n % 2) cell.fill = fill(C.zebra);
      });
      const a = e.action;
      const tone = /Cancel/.test(a) ? C.stage.cancelled : /Confirmed|Handed|packed|slip|Partial/i.test(a) ? C.stage.dispatched : /Did not/.test(a) ? C.stage.confirm : null;
      if (tone) Object.assign(ws.getCell(r, 6), { fill: fill(tone[0]), font: { size: 10, bold: true, color: { argb: tone[1] } } });
      r++;
    }
  }
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: Math.max(4, r - 1), column: L.length } };
}

module.exports = { journeyRow, summarise, buildWorkbook, actionName, COLS };
