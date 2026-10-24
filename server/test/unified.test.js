const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/lib/unified');
const { computeMetrics } = require('../src/lib/metrics');
const { computeCampaigns } = require('../src/lib/campaigns');
const FN = require('../src/lib/funnel');

const cod = { orderId: 1, total: 800, createdAt: new Date('2026-10-23T05:00:00Z'), financialStatus: 'PENDING', paymentGateways: ['Cash on Delivery (COD)'] };
const paid = { ...cod, orderId: 2, financialStatus: 'PAID', paymentGateways: ['Razorpay'] };
const one = (shop, desk, ship, hadNdr) => U.fromDashboard({ shop, desk, ship, hadNdr });

test('sheet cut-off: the dashboard takes over the day after the last sheet day (IST)', () => {
  assert.equal(U.cutoverOf('2026-10-21').toISOString(), '2026-10-21T18:30:00.000Z'); // 22 Oct 00:00 IST
  assert.equal(U.cutoverOf('garbage').toISOString(), '2026-10-21T18:30:00.000Z');
});

test('payment mode: paid = Prepaid, COD with money up front = Partial COD, the rest COD', () => {
  assert.equal(one(paid, { stage: 'dispatch' }).paymentMode, 'Prepaid');
  assert.equal(one(cod, { stage: 'dispatch', partial: { amount: 200 } }).paymentMode, 'Partial COD');
  assert.equal(one(cod, { stage: 'confirm' }).paymentMode, 'COD');
  assert.equal(one(cod, null).paymentMode, 'COD');
});

test('statuses follow the Order funnel rules', () => {
  assert.equal(one(cod, null).confirmed, 'Pending');
  assert.equal(one(cod, { stage: 'confirm' }).confirmed, 'Pending');
  assert.equal(one(cod, { stage: 'dispatch' }).confirmed, 'Yes');
  assert.equal(one(cod, { stage: 'cancelled', cancel: { fromStage: 'confirm' } }).confirmed, 'Cancel');
  assert.equal(one(cod, { stage: 'cancelled', cancel: { fromStage: 'dispatch' } }).confirmed, 'Yes'); // cancelled after confirming still counts as confirmed, like the funnel
  assert.equal(one({ ...cod, cancelledAt: new Date() }, null).confirmed, 'Cancel');
  const d = { stage: 'dispatched' };
  assert.equal(one(cod, d, { found: true, group: 'delivered' }).finalStatus, 'Delivered');
  assert.equal(one(cod, d, { found: true, group: 'rto' }).finalStatus, 'RTO');
  assert.equal(one(cod, d, { found: true, group: 'transit' }).finalStatus, 'In Transit');
  assert.equal(one(cod, d, null).finalStatus, 'In Transit');
  assert.equal(one(cod, { stage: 'dispatch' }, { found: true, group: 'delivered' }).finalStatus, 'Confirmed'); // not handed over by the team: Shipway status ignored
});

test('NDR only for handed-over parcels', () => {
  assert.equal(one(cod, { stage: 'dispatched' }, { found: true, group: 'ndr' }).ndr, true);
  assert.equal(one(cod, { stage: 'dispatched' }, { found: true, group: 'delivered' }, true).ndr, true); // had an NDR case, then delivered
  assert.equal(one(cod, { stage: 'confirm' }, { found: true, group: 'ndr' }).ndr, false);
});

test('Payment mode / Overview numbers equal the Order funnel numbers for the same orders', () => {
  const rows = [
    { shop: cod, desk: { stage: 'dispatched' }, ship: { found: true, group: 'delivered' } },
    { shop: { ...cod, orderId: 3 }, desk: { stage: 'dispatched', partial: { amount: 100 } }, ship: { found: true, group: 'rto' } },
    { shop: paid, desk: { stage: 'dispatched' }, ship: { found: true, group: 'transit' } },
    { shop: { ...cod, orderId: 4 }, desk: { stage: 'dispatch' }, ship: null },
    { shop: { ...cod, orderId: 5 }, desk: { stage: 'cancelled', cancel: { fromStage: 'confirm' } }, ship: null },
    { shop: { ...cod, orderId: 6 }, desk: { stage: 'confirm' }, ship: null },
    { shop: { ...cod, orderId: 7 }, desk: null, ship: null },
  ];
  const f = FN.funnelStats(rows);
  const m = computeMetrics(rows.map(U.fromDashboard)).All;
  assert.equal(m.total, f.orders); assert.equal(m.confirmedYes, f.confirmed); assert.equal(m.dispatched, f.dispatched);
  assert.equal(m.delivered, f.delivered); assert.equal(m.rtoCount, f.rto); assert.equal(m.inTransit, f.inTransit);
  assert.equal(m.confirmedOfAll.v, f.confirmedPct.v);
  assert.equal(m.netRevenue, 800); // only the delivered order's value
  const modes = computeMetrics(rows.map(U.fromDashboard));
  assert.equal(modes.COD.total + modes['Partial COD'].total + modes.Prepaid.total, 7);
  assert.equal(modes['Partial COD'].total, 1);
});

test('campaigns: counts come from the dashboard status, and an unfilled {{template}} gets its own row', () => {
  const rows = [
    { shop: cod, desk: { stage: 'dispatched' }, ship: { found: true, group: 'delivered' } },
    { shop: { ...cod, orderId: 3 }, desk: { stage: 'confirm' }, ship: null },
    { shop: { ...cod, orderId: 4 }, desk: { stage: 'confirm' }, ship: null },
  ].map(U.fromDashboard);
  const mk = new Map([[1, { hasUtm: true, utmCampaign: 'Scaling | 08/10' }], [3, { hasUtm: true, utmCampaign: 'Scaling | 08/10' }], [4, { hasUtm: true, utmCampaign: '{{campaign.name}}' }]]);
  const r = computeCampaigns(rows, mk, 'campaign');
  const sc = r.rows.find((x) => x.key === 'Scaling | 08/10');
  assert.equal(sc.orders, 2); assert.equal(sc.confirmedYes, 1); assert.equal(sc.delivered, 1); assert.equal(sc.netRevenue, 800);
  assert.equal(sc.confirmedOfAll.v, 50);
  const t = r.rows.find((x) => x.unattributed);
  assert.equal(t.key, '(ad name not filled in by Meta)'); assert.equal(t.orders, 1);
  assert.equal(r.rows.some((x) => x.key.includes('{{')), false);
});
