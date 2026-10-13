const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

process.env.SHOPIFY_SHOP = 'https://My-Store.myshopify.com/admin';
process.env.SHOPIFY_CLIENT_ID = 'cid';
process.env.SHOPIFY_CLIENT_SECRET = 'secret';
process.env.SHOPIFY_API_VERSION = '2026-04';

// dotenv is not needed here
const orig = Module._load;
Module._load = function (req, ...r) { return req === 'dotenv' ? { config() {} } : orig.call(this, req, ...r); };

const { normalizeOrder, orderIdFromName } = require('../src/lib/shopifyMap');
const cfg = require('../src/config');
const client = require('../src/services/shopifyClient');

const node = (n, extra = {}) => ({
  id: `gid://shopify/Order/${n}`, name: `#${n}`, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:05:00Z', cancelledAt: null, test: false,
  note: 'call before delivery', tags: ['cod'], currencyCode: 'INR', displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED',
  paymentGatewayNames: ['Cash on Delivery (COD)'], email: null, phone: null,
  customer: { displayName: 'Asha Rao', email: 'asha@example.com', phone: '+919876543210' },
  shippingAddress: { name: 'Asha Rao', address1: '12 MG Road', address2: '', city: 'Hyderabad', province: 'Telangana', zip: '500001', country: 'India', phone: null },
  currentSubtotalPriceSet: { shopMoney: { amount: '1798.00' } }, totalShippingPriceSet: { shopMoney: { amount: '0.00' } },
  totalDiscountsSet: { shopMoney: { amount: '100.00' } }, currentTotalPriceSet: { shopMoney: { amount: '1698.00' } },
  lineItems: { nodes: [
    { title: 'Face Serum', variantTitle: '30 ml', sku: 'FS30', quantity: 2, currentQuantity: 2, originalUnitPriceSet: { shopMoney: { amount: '899.00' } } },
    { title: 'Hair Oil', variantTitle: 'Default Title', sku: '', quantity: 1, currentQuantity: 0, originalUnitPriceSet: { shopMoney: { amount: '499.00' } } },
  ] },
  ...extra,
});

test('config accepts a pasted store address', () => { assert.equal(cfg.shopify.shop, 'my-store'); });

test('order number comes from the name', () => {
  assert.equal(orderIdFromName('#1300'), 1300);
  assert.equal(orderIdFromName('MS-1300'), 1300);
  assert.equal(orderIdFromName('draft'), null);
});

test('normalizeOrder maps customer, address, items and totals', () => {
  const d = normalizeOrder(node(1300));
  assert.equal(d.orderId, 1300);
  assert.equal(d.customer.name, 'Asha Rao');
  assert.equal(d.customer.email, 'asha@example.com');
  assert.equal(d.address.city, 'Hyderabad');
  assert.equal(d.items[0].variantTitle, '30 ml');
  assert.equal(d.items[1].variantTitle, ''); // "Default Title" is noise
  assert.equal(d.items[1].quantity, 0); // removed after the order
  assert.equal(d.itemsSummary, 'Face Serum (30 ml) ×2'); // removed items are left out
  assert.equal(d.total, 1698);
  assert.equal(d.discounts, 100);
  assert.equal(normalizeOrder({ name: 'draft' }), null);
});

// ---- fake Shopify ----
function fakeShopify(handler) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts, calls);
  };
  return calls;
}
const json = (body, status = 200, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => body });

test('token: client-credentials request, cached, sent as header', async () => {
  client._reset();
  const calls = fakeShopify((url) => {
    if (url.endsWith('/admin/oauth/access_token')) return json({ access_token: 'tkn', scope: 'read_orders,read_customers', expires_in: 86399 });
    return json({ data: { shop: { name: 'Shop', myshopifyDomain: 'my-store.myshopify.com' } } });
  });
  await client.ping(); await client.ping();
  const tokenCalls = calls.filter((c) => c.url.endsWith('/admin/oauth/access_token'));
  assert.equal(tokenCalls.length, 1, 'token is cached');
  assert.match(tokenCalls[0].url, /^https:\/\/my-store\.myshopify\.com\//);
  assert.match(String(tokenCalls[0].opts.body), /grant_type=client_credentials/);
  const gql = calls.find((c) => c.url.includes('/graphql.json'));
  assert.match(gql.url, /\/admin\/api\/2026-04\/graphql\.json$/);
  assert.equal(gql.opts.headers['X-Shopify-Access-Token'], 'tkn');
  assert.deepEqual(client.scopes(), ['read_orders', 'read_customers']);
});

test('token: shop_not_permitted gets a plain explanation', async () => {
  client._reset();
  fakeShopify(() => json({ error: 'shop_not_permitted', error_description: 'Oauth error shop_not_permitted' }, 400));
  await assert.rejects(client.ping(), /same organization/);
});

test('paging walks every page and reports each page', async () => {
  client._reset();
  fakeShopify((url, opts) => {
    if (url.endsWith('/access_token')) return json({ access_token: 't', scope: '', expires_in: 86399 });
    const v = JSON.parse(opts.body).variables;
    const page = v.after ? 2 : 1;
    return json({ data: { orders: { pageInfo: { hasNextPage: page === 1, endCursor: 'c1' }, nodes: page === 1 ? [node(1), node(2)] : [node(3)] } } });
  });
  const seen = [];
  const total = await client.pullOrders({ onPage: async (nodes) => seen.push(nodes.map((n) => n.name)) });
  assert.equal(total, 3);
  assert.deepEqual(seen, [['#1', '#2'], ['#3']]);
});

test('a throttled query is retried, an access error is explained', async () => {
  client._reset();
  let n = 0;
  fakeShopify((url) => {
    if (url.endsWith('/access_token')) return json({ access_token: 't', scope: '', expires_in: 86399 });
    n += 1;
    if (n === 1) return json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] });
    return json({ data: { orders: { pageInfo: { hasNextPage: false }, nodes: [node(9)] } } });
  });
  const o = await client.fetchByNumber(9);
  assert.equal(o.name, '#9');
  assert.equal(n, 2);

  client._reset();
  fakeShopify((url) => (url.endsWith('/access_token')
    ? json({ access_token: 't', scope: '', expires_in: 86399 })
    : json({ errors: [{ message: 'This app is not approved to access the Customer object.' }] })));
  await assert.rejects(client.fetchByNumber(9), /read_customers/);
});

test('a 401 forces a fresh token and retries once', async () => {
  client._reset();
  let tokens = 0; let gqls = 0;
  fakeShopify((url) => {
    if (url.endsWith('/access_token')) { tokens += 1; return json({ access_token: `t${tokens}`, scope: '', expires_in: 86399 }); }
    gqls += 1;
    return gqls === 1 ? json({}, 401) : json({ data: { shop: { name: 'S' } } });
  });
  await client.ping();
  assert.equal(tokens, 2);
});

// ---- marketing (Shopify "Additional details" = order custom attributes) ----
const { normalizeMarketing } = require('../src/lib/shopifyMap');
const { computeCampaigns, NONE } = require('../src/lib/campaigns');

const attrs1874 = [
  { key: 'additional_charge', value: '0.0' },
  { key: 'user_agent', value: 'Mozilla/5.0 (Linux; Android 10; vivo 1804 Build/QP1A.190711.020) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/153.0.8010.38 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/580.0.0.51.74;IABMV/1;]' },
  { key: 'utm_source', value: 'fb' },
  { key: 'utm_medium', value: 'Aquarius-Kumbh | Offer | AI2.5L+(Ex) | INT-Astro | 01/10' },
  { key: 'utm_campaign', value: 'Aquarius-Kumbh | Bracelet | ABO | 26/09' },
  { key: 'utm_term', value: '23859660124540798' },
  { key: 'utm_content', value: 'Aquarius_V2_Offer - Thank you jitna pyar | 01/30' },
  { key: 'ipv4_address', value: '157.35.15.4' },
  { key: 'paymentMethod', value: 'COD' },
  { key: 'landing_page_url', value: 'https://shopmysoul.com/products/aquarius-zodiac-bracelet-amethyst-lapis-lazuli-12?_pos=1&utm_source=fb' },
];

test('marketing: order #1874 attributes map to campaign, ad set, ad, device', () => {
  const m = normalizeMarketing(attrs1874);
  assert.equal(m.utmCampaign, 'Aquarius-Kumbh | Bracelet | ABO | 26/09');
  assert.equal(m.utmMedium, 'Aquarius-Kumbh | Offer | AI2.5L+(Ex) | INT-Astro | 01/10');
  assert.equal(m.utmContent, 'Aquarius_V2_Offer - Thank you jitna pyar | 01/30');
  assert.equal(m.sourceGroup, 'Meta');
  assert.equal(m.device, 'Android');
  assert.equal(m.inApp, 'Facebook app');
  assert.equal(m.landingProduct, 'aquarius-zodiac-bracelet-amethyst-lapis-lazuli-12');
  assert.equal(m.checkoutPayment, 'COD');
  assert.equal(m.additionalCharge, 0);
  assert.equal(m.hasUtm, true);
  assert.deepEqual(m.extra, []);
  assert.ok(!JSON.stringify(m).includes('157.35.15.4'), 'IP address is not stored');
  assert.ok(!JSON.stringify(m).includes('vivo'), 'raw browser string is not stored');
});

test('marketing: UTM falls back to the landing page address, and missing data is harmless', () => {
  const m = normalizeMarketing([{ key: 'landing_page_url', value: 'https://x.com/products/p?utm_source=google&utm_campaign=Brand' }, { key: 'gift', value: 'yes' }]);
  assert.equal(m.utmCampaign, 'Brand'); assert.equal(m.sourceGroup, 'Google'); assert.deepEqual(m.extra, [{ key: 'gift', value: 'yes' }]);
  const none = normalizeMarketing(undefined);
  assert.equal(none.hasUtm, false); assert.equal(none.utmCampaign, '');
  assert.equal(normalizeOrder(node(5, { customAttributes: attrs1874 })).marketing.utmSource, 'fb');
  assert.equal(normalizeOrder(node(6)).marketing.hasUtm, false);
});

test('campaigns: groups sheet outcomes by UTM, unattributed kept apart, parent campaign shown for ad sets', () => {
  const o = (orderId, p) => ({ orderId, amount: 1000, paymentMode: 'COD', confirmed: 'Yes', dispatched: true, finalStatus: 'Delivered', ndr: false, ...p });
  const orders = [o(1), o(2, { finalStatus: 'RTO' }), o(3, { paymentMode: 'Prepaid' }), o(4, { confirmed: 'Cancel', finalStatus: 'Cancelled', dispatched: false }), o(5)];
  const mk = new Map([
    [1, normalizeMarketing(attrs1874)], [2, normalizeMarketing(attrs1874)], [3, normalizeMarketing([{ key: 'utm_campaign', value: 'Leo | Bracelet' }])],
    [4, normalizeMarketing([])],
  ]);
  const r = computeCampaigns(orders, mk, 'campaign');
  assert.equal(r.total, 5); assert.equal(r.withUtm, 3); assert.equal(r.matched, 4);
  const a = r.rows.find((x) => x.key.startsWith('Aquarius'));
  assert.equal(a.orders, 2); assert.equal(a.delivered, 1); assert.equal(a.rtoCount, 1); assert.equal(a.rto.v, 50); assert.equal(a.netRevenue, 1000);
  assert.equal(r.rows[r.rows.length - 1].key, NONE); assert.equal(r.rows[r.rows.length - 1].orders, 2); // #4 has no UTM, #5 has no Shopify match
  const t = computeCampaigns(orders, mk, 'theme');
  assert.ok(t.rows.find((x) => x.key === 'Aquarius-Kumbh') && t.rows.find((x) => x.key === 'Leo'));
  assert.equal(computeCampaigns(orders, mk, 'adset').rows[0].campaign, 'Aquarius-Kumbh | Bracelet | ABO | 26/09');
});
