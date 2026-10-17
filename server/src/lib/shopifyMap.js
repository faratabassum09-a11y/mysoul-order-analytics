// Turns one Shopify GraphQL order node into the flat document we store. Pure: no network, no database.
const ATTRS_V = 2; // bump when the mapped fields change (2: fulfillment tracking numbers added): the next Shopify sync then reloads every order once
const money = (set) => {
  const v = set && set.shopMoney && set.shopMoney.amount;
  return v === undefined || v === null || v === '' ? null : Number(v);
};

// "#1300" -> 1300. Also copes with a store prefix/suffix such as "MS-1300".
function orderIdFromName(name) {
  const m = String(name || '').match(/(\d+)\s*\D*$/);
  return m ? Number(m[1]) : null;
}


// ---- Marketing: the "Additional details" block in the Shopify order (custom attributes) ----
// Meta ads put the campaign name in utm_campaign, the ad set name in utm_medium, the ad name in utm_content and an id in utm_term.
// IP address and the raw browser string are deliberately NOT stored: only the device type and in-app browser we derive from them.
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
const KNOWN_ATTRS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'landing_page_url', 'paymentmethod', 'additional_charge', 'user_agent', 'ipv4_address', 'ipv6_address', 'ip_address']);

function attrMap(list) {
  const m = {};
  for (const a of list || []) if (a && a.key) m[String(a.key).trim().toLowerCase()] = clean(a.value);
  return m;
}

function sourceGroup(src) {
  const s = clean(src).toLowerCase();
  if (!s) return '';
  if (/^(fb|facebook|ig|instagram|meta|an|audience_network)$/.test(s) || /facebook|instagram/.test(s)) return 'Meta';
  if (/google|gads|adwords|youtube|yt/.test(s)) return 'Google';
  if (/whatsapp|wa$/.test(s)) return 'WhatsApp';
  if (/email|klaviyo|newsletter|mailchimp/.test(s)) return 'Email';
  return s;
}

function deviceFromUserAgent(ua) {
  const u = clean(ua);
  if (!u) return { device: '', inApp: '' };
  const device = /iPhone|iPad|iPod/i.test(u) ? 'iOS' : /Android/i.test(u) ? 'Android' : /Windows|Macintosh|Linux|X11/i.test(u) ? 'Desktop' : 'Other';
  const inApp = /FBAN|FBAV|FB_IAB|FB4A/i.test(u) ? 'Facebook app' : /Instagram/i.test(u) ? 'Instagram app' : '';
  return { device, inApp };
}

function parseLanding(url) {
  const raw = clean(url);
  if (!raw) return { path: '', product: '', params: {} };
  let u;
  try { u = new URL(raw, 'https://x.invalid'); } catch (e) { return { path: '', product: '', params: {} }; }
  const params = {};
  u.searchParams.forEach((v, k) => { params[k.toLowerCase()] = v; });
  const m = u.pathname.match(/\/products\/([^/?#]+)/);
  return { path: u.pathname === '/' ? '/' : u.pathname, product: m ? decodeURIComponent(m[1]) : '', params };
}

// customAttributes [{key, value}] -> flat marketing document. UTM values missing from the attributes are read from the landing page address.
function normalizeMarketing(list) {
  const a = attrMap(list);
  const land = parseLanding(a.landing_page_url);
  const utm = (k) => a[k] || clean(land.params[k]);
  const { device, inApp } = deviceFromUserAgent(a.user_agent);
  const extra = (list || []).filter((x) => x && x.key && !KNOWN_ATTRS.has(String(x.key).trim().toLowerCase())).map((x) => ({ key: String(x.key), value: clean(x.value) }));
  const charge = a.additional_charge === undefined || a.additional_charge === '' ? null : Number(a.additional_charge);
  const out = {
    utmSource: utm('utm_source'), utmMedium: utm('utm_medium'), utmCampaign: utm('utm_campaign'), utmTerm: utm('utm_term'), utmContent: utm('utm_content'),
    sourceGroup: sourceGroup(utm('utm_source')),
    landingPath: land.path, landingProduct: land.product,
    checkoutPayment: a.paymentmethod || '',
    additionalCharge: Number.isFinite(charge) ? charge : null,
    device, inApp,
    extra,
  };
  out.hasUtm = !!(out.utmSource || out.utmMedium || out.utmCampaign || out.utmContent);
  return out;
}

// fulfillments [{ trackingInfo: [{ number, company, url }] }] -> flat, de-duplicated list. The first entry is what the Order packed form pre-fills.
function normalizeTracking(fulfillments) {
  const out = []; const seen = new Set();
  for (const f of fulfillments || []) {
    for (const t of (f && f.trackingInfo) || []) {
      const number = clean(t && t.number);
      if (!number || seen.has(number)) continue;
      seen.add(number);
      out.push({ number, company: clean(t.company), url: clean(t.url) });
    }
  }
  return out;
}

function normalizeOrder(n) {
  const orderId = orderIdFromName(n.name);
  if (orderId === null) return null;
  const items = ((n.lineItems && n.lineItems.nodes) || []).map((li) => ({
    title: li.title || '',
    variantTitle: li.variantTitle && li.variantTitle !== 'Default Title' ? li.variantTitle : '',
    sku: li.sku || '',
    quantity: li.currentQuantity === undefined || li.currentQuantity === null ? li.quantity : li.currentQuantity, // after edits/refunds
    orderedQuantity: li.quantity,
    price: money(li.originalUnitPriceSet),
  }));
  const ship = n.shippingAddress || {};
  const c = n.customer || {};
  const name = c.displayName || ship.name || null;
  return {
    orderId,
    shopifyId: n.id,
    name: n.name,
    createdAt: n.createdAt ? new Date(n.createdAt) : null,
    updatedAt: n.updatedAt ? new Date(n.updatedAt) : null,
    cancelledAt: n.cancelledAt ? new Date(n.cancelledAt) : null,
    test: !!n.test,
    financialStatus: n.displayFinancialStatus || '',
    fulfillmentStatus: n.displayFulfillmentStatus || '',
    paymentGateways: n.paymentGatewayNames || [],
    currency: n.currencyCode || '',
    subtotal: money(n.currentSubtotalPriceSet),
    shipping: money(n.totalShippingPriceSet),
    discounts: money(n.totalDiscountsSet),
    total: money(n.currentTotalPriceSet),
    note: n.note || '',
    tags: n.tags || [],
    customer: { name, email: c.email || n.email || null, phone: c.phone || ship.phone || n.phone || null },
    address: {
      name: ship.name || null, line1: ship.address1 || null, line2: ship.address2 || null, city: ship.city || null,
      state: ship.province || null, zip: ship.zip || null, country: ship.country || null, phone: ship.phone || null,
    },
    items,
    tracking: normalizeTracking(n.fulfillments),
    marketing: normalizeMarketing(n.customAttributes),
    attrsV: ATTRS_V,
    itemsSummary: items.filter((i) => i.quantity > 0).map((i) => `${i.title}${i.variantTitle ? ` (${i.variantTitle})` : ''} ×${i.quantity}`).join(', '),
  };
}

module.exports = { normalizeOrder, normalizeTracking, normalizeMarketing, orderIdFromName, money, ATTRS_V };
