// Ad performance: sheet outcomes (confirmed, RTO, delivered) grouped by the Shopify UTM fields. Pure: no database.
const { computeBlock } = require('./metrics');
const { isTemplate } = require('./unified');

const NONE = '(no UTM data)';
const TEMPLATE = '(ad name not filled in by Meta)'; // utm value is still the raw {{campaign.name}} placeholder
const BY = {
  campaign: (m) => m.utmCampaign,
  adset: (m) => m.utmMedium,
  ad: (m) => m.utmContent,
  source: (m) => m.sourceGroup || m.utmSource,
  // First part of the campaign name, e.g. "Aquarius-Kumbh | Bracelet | ABO | 26/09" -> "Aquarius-Kumbh"
  theme: (m) => String(m.utmCampaign || '').split('|')[0].trim(),
  landing: (m) => m.landingProduct,
  device: (m) => [m.device, m.inApp].filter(Boolean).join(' · '),
};

const leanBlock = (b) => ({
  orders: b.total, value: b.value, aov: b.aov, netRevenue: b.netRevenue,
  confirmation: b.confirmation, cancellation: b.cancellation, confirmedOfAll: b.confirmedOfAll, cancelledOfAll: b.cancelledOfAll,
  confirmedYes: b.confirmedYes, cancelled: b.cancelled, dispatched: b.dispatched, rto: b.rto, deliveredRate: b.deliveredRate, ndr: b.ndr,
  delivered: b.delivered, rtoCount: b.rtoCount, inTransit: b.inTransit, pending: b.pending, closed: b.closed, shipments: b.shipments,
});

// orders: valid sheet orders. marketingById: Map(orderId -> marketing doc from Shopify).
function computeCampaigns(orders, marketingById, by = 'campaign') {
  const key = BY[by] || BY.campaign;
  const groups = new Map();
  let matched = 0; let withUtm = 0;
  for (const o of orders) {
    const m = o.orderId != null ? marketingById.get(o.orderId) : null;
    if (m) matched++;
    if (m && m.hasUtm) withUtm++;
    let k = (m && key(m)) || NONE;
    if (isTemplate(k)) k = TEMPLATE;
    if (!groups.has(k)) groups.set(k, { key: k, orders: [], campaigns: new Map(), cod: 0, prepaid: 0 });
    const g = groups.get(k);
    g.orders.push(o);
    if (o.paymentMode === 'COD') g.cod++; else if (o.paymentMode === 'Prepaid') g.prepaid++;
    if (m && m.utmCampaign && !isTemplate(m.utmCampaign)) g.campaigns.set(m.utmCampaign, (g.campaigns.get(m.utmCampaign) || 0) + 1);
  }
  const total = orders.length;
  const rows = [...groups.values()].map((g) => {
    const top = [...g.campaigns.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      key: g.key, unattributed: g.key === NONE || g.key === TEMPLATE,
      campaign: by === 'adset' || by === 'ad' ? (top ? top[0] : '') : undefined, // parent campaign, to tell look-alike names apart
      share: total ? (g.orders.length / total) * 100 : null,
      codShare: g.orders.length ? (g.cod / g.orders.length) * 100 : null,
      cod: g.cod, prepaid: g.prepaid,
      ...leanBlock(computeBlock(g.orders)),
    };
  }).sort((a, b) => (a.unattributed - b.unattributed) || b.orders - a.orders);
  return {
    by, total, matched, withUtm,
    coverage: total ? (withUtm / total) * 100 : null,
    totals: leanBlock(computeBlock(orders)),
    rows,
  };
}

// Why is the table empty? One answer, in order of what to fix first.
function diagnose({ total, matched, withUtm, shopifyOrders, marketingLoaded }) {
  if (!total || withUtm > 0) return null;
  if (!shopifyOrders) return 'no_shopify_orders'; // Shopify not connected, or nothing pulled yet
  if (!marketingLoaded) return 'not_reloaded'; // orders were saved before the UTM fields existed
  if (!matched) return 'no_match'; // Shopify has orders, but none of this window's
  return 'no_utm_on_orders'; // orders matched, Shopify sent no UTM attributes
}

module.exports = { computeCampaigns, diagnose, NONE, TEMPLATE, BY };
