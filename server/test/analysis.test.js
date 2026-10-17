const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const A = require('../src/lib/analysisSheet');

const ist = (s) => new Date(`${s}+05:30`);
const shop = (n, extra = {}) => ({ orderId: n, name: `#${n}`, createdAt: ist('2026-10-12T09:00:00'), total: 1499, financialStatus: 'pending', paymentGateways: ['Cash on Delivery (COD)'], customer: { name: 'Asha Rao', phone: '9999912345', email: 'a@x.in' }, address: { city: 'Pune', state: 'MH', line1: '12 Secret Street' }, itemsSummary: 'Soul Report x1', marketing: { sourceGroup: 'Meta Ads' }, ...extra });
const full = {
  orderId: 1501, stage: 'dispatched', orderAt: ist('2026-10-12T09:00:00'), confirmedAt: ist('2026-10-12T11:30:00'), confirmedBy: 'Ravi', confirmedAtFu: 'FU2',
  dispatch: { at: ist('2026-10-13T17:00:00'), byName: 'Imran', awb: 'AWB12345', courier: 'Delhivery' },
  dq: { step: 'done', slip: { at: ist('2026-10-12T11:50:00'), byName: 'Imran', late: false }, packed: { at: ist('2026-10-13T10:00:00'), byName: 'Imran', awb: 'AWB12345', courier: 'Delhivery', photoId: 'p1', late: true }, handover: { at: ist('2026-10-13T17:00:00'), byName: 'Imran', manifestId: 'm1', late: false } },
  log: [
    { at: ist('2026-10-12T09:00:00'), by: 'System', action: 'enter_queue', label: 'Order entered the confirm queue (FU1)', stage: 'confirm', fu: 'FU1' },
    { at: ist('2026-10-12T10:00:00'), by: 'Ravi', action: 'dnp', label: 'FU1: did not pick up · WhatsApp shared', whatsappShared: true, stage: 'confirm', fu: 'FU1' },
    { at: ist('2026-10-12T11:30:00'), by: 'Ravi', action: 'confirm', label: 'Confirmed', stage: 'confirm', fu: 'FU2' },
    { at: ist('2026-10-13T17:00:00'), by: 'Imran', action: 'dispatch', label: 'Handed over to courier', stage: 'dispatch' },
  ],
};
const cancelled = { orderId: 1502, stage: 'cancelled', orderAt: ist('2026-10-12T09:00:00'), cancel: { reason: 'Customer not interested', byName: 'Meera', at: ist('2026-10-12T12:00:00') }, log: [{ at: ist('2026-10-12T12:00:00'), by: 'Meera', action: 'cancel', label: 'Cancelled', stage: 'confirm', reason: 'Customer not interested' }] };

test('journey row follows one order from call to courier', () => {
  const r = A.journeyRow({ orderId: 1501, shop: shop(1501), desk: full, ship: { status: 'In Transit', awb: 'AWB12345', carrier: 'Delhivery', statusAt: ist('2026-10-14T08:00:00') } });
  assert.equal(r.calls, 1); assert.equal(r.whatsapp, 1);
  assert.equal(r.confirmedFu, 'FU2'); assert.equal(r.hOrderConfirm, 2.5); assert.equal(r.hConfirmHand, 29.5); assert.equal(r.hOrderHand, 32);
  assert.equal(r.packedOn, 'Late'); assert.equal(r.slipOn, 'On time'); assert.equal(r.packPhoto, 'Yes'); assert.equal(r.manifest, 'Yes');
  assert.equal(r.awb, 'AWB12345'); assert.equal(r.shipStatus, 'In Transit'); assert.equal(r.events.length, 4);
  assert.match(r.story, /Ravi · Confirmed/);
});

test('cancelled and not-in-queue orders still produce a row', () => {
  const c = A.journeyRow({ orderId: 1502, shop: shop(1502), desk: cancelled });
  assert.equal(c.cancelReason, 'Customer not interested'); assert.equal(c.stageLabel, 'Cancelled');
  const n = A.journeyRow({ orderId: 1503, shop: shop(1503), desk: null });
  assert.equal(n.stageLabel, 'Not in queue'); assert.equal(n.events.length, 0); assert.equal(n.awb, '');
});

test('a dispatch-queue order past its deadline is flagged overdue', () => {
  const d = { orderId: 1504, stage: 'dispatch', orderAt: ist('2026-10-12T09:00:00'), confirmedAt: ist('2026-10-12T10:00:00'), log: [] };
  const r = A.journeyRow({ orderId: 1504, shop: shop(1504), desk: d, now: ist('2026-10-14T10:00:00') });
  assert.equal(r.waitingAt, 'Packing slip'); assert.equal(r.overdue, 'Overdue');
});

test('workbook has three styled tabs and leaks no phone, email or street', async () => {
  const rows = [A.journeyRow({ orderId: 1501, shop: shop(1501), desk: full }), A.journeyRow({ orderId: 1502, shop: shop(1502), desk: cancelled })];
  const buf = await A.buildWorkbook(rows, { scope: 'test' });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Order Journey', 'Activity Log']);
  assert.equal(wb.getWorksheet('Order Journey').rowCount, 4 + 2);
  assert.equal(wb.getWorksheet('Activity Log').rowCount, 3 + 5);
  const all = JSON.stringify(wb.worksheets.map((w) => w.getSheetValues()));
  for (const bad of ['9999912345', 'a@x.in', 'Secret Street']) assert.ok(!all.includes(bad), bad);
});

test('empty list still builds', async () => { assert.ok((await A.buildWorkbook([], {})).length > 1000); });

test('an invalid date becomes an empty cell, never NaN', () => {
  const r = A.journeyRow({ orderId: 9, shop: { orderId: 9, createdAt: 'garbage', total: 100 }, desk: null });
  assert.equal(r.placedAt, null);
});
