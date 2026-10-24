// One order shape for every analytics page (Overview, Trends, Payment mode, Campaigns).
//
// Until the sheet cut-off date the numbers come from the Google Sheet (Order). From that date on they come from the dashboard itself:
// the Shopify order (date, value, payment), the team's Shopify desk record (confirmed / cancelled / dispatched) and the Shipway
// shipment (delivered / RTO / NDR). Both are turned into the same flat object, so every formula in metrics.js and campaigns.js
// works on either, and the rules for "confirmed", "dispatched", "delivered" and "RTO" are the ones the Order funnel already uses.
// Pure: no database, no network.
const { isCod, wasConfirmed } = require('./funnel');
const { parseYmd } = require('./istTime');

const DEFAULT_SHEET_UNTIL = '2026-10-21'; // last day (IST) whose numbers still come from the sheet; the dashboard takes over the day after

// "2026-10-21" -> the instant the dashboard takes over (start of 22 Oct, IST). Bad input falls back to the default.
function cutoverOf(sheetUntil) {
  const d = parseYmd(sheetUntil) || parseYmd(DEFAULT_SHEET_UNTIL);
  return new Date(d.getTime() + 24 * 3600 * 1000);
}

const hasPartial = (d) => !!(d && d.partial && d.partial.amount > 0);

// Prepaid = Shopify says the money is in. COD that paid part up front = Partial COD. Everything else = COD.
function paymentModeOf(shop, desk) {
  if (!isCod(shop)) return 'Prepaid';
  return hasPartial(desk) ? 'Partial COD' : 'COD';
}

// One dashboard order -> the same fields a cleaned sheet row has.
// desk: DeskOrder|null, shop: ShopifyOrder, ship: ShipwayShipment|null, hadNdr: true when the team opened an NDR case for it.
function fromDashboard({ shop, desk, ship, hadNdr }) {
  const s = shop || {};
  const group = ship && ship.found !== false ? ship.group : null;
  const dispatched = !!desk && desk.stage === 'dispatched';
  const confirmedNow = wasConfirmed(desk);
  const cancelled = !confirmedNow && ((!!desk && desk.stage === 'cancelled') || (!desk && !!s.cancelledAt));
  const confirmed = confirmedNow ? 'Yes' : cancelled ? 'Cancel' : 'Pending';
  // Delivered / RTO only count for parcels the team handed over, exactly like the Order funnel, so a % can never pass 100.
  const finalStatus = dispatched ? (group === 'delivered' ? 'Delivered' : group === 'rto' ? 'RTO' : 'In Transit')
    : confirmedNow ? 'Confirmed' : cancelled ? 'Cancelled' : 'Pending confirmation';
  return {
    orderId: s.orderId, orderDate: s.createdAt || null, amount: s.total == null ? null : s.total,
    paymentMode: paymentModeOf(s, desk), confirmed, dispatched, finalStatus,
    ndr: dispatched && (group === 'ndr' || !!hadNdr),
    src: 'dashboard',
  };
}

// Campaign and ad names that Meta never filled in arrive as the raw template, e.g. {{campaign.name}}.
const isTemplate = (v) => /\{\{[^}]*\}\}/.test(String(v || ''));

module.exports = { DEFAULT_SHEET_UNTIL, cutoverOf, paymentModeOf, fromDashboard, isTemplate };
