// Shopify Admin GraphQL client. Auth: client-credentials grant (Dev Dashboard app installed on a store in the SAME organization).
// No database in here, so it can be tested with a fake fetch.
const cfg = require('../config');

const TIMEOUT_MS = 45000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ShopifyError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.name = 'ShopifyError'; this.status = status; this.code = code; }
}

const isConfigured = () => !!(cfg.shopify.shop && cfg.shopify.clientId && cfg.shopify.clientSecret);
const base = () => `https://${cfg.shopify.shop}.myshopify.com`;

let tok = { token: null, expiresAt: 0, scope: '' };
let provider = null; // async (force) => { token, scope } | null : tokens obtained through the install link (see shopifyAuth.js)
let lastScope = '';
const setTokenProvider = (fn) => { provider = fn; };

// A token from the install-link flow wins; otherwise fall back to the automatic client-credentials login.
async function getToken(force = false) {
  if (provider) {
    const r = await provider(force);
    if (r && r.token) { lastScope = r.scope || ''; return r.token; }
  }
  return clientCredentialsToken(force);
}

async function clientCredentialsToken(force = false) {
  if (!isConfigured()) throw new ShopifyError('Shopify is not set up yet. Add SHOPIFY_SHOP, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET on the server.', { status: 400 });
  if (!force && tok.token && Date.now() < tok.expiresAt - 60000) return tok.token;
  let res;
  try {
    res = await fetch(`${base()}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.shopify.clientId, client_secret: cfg.shopify.clientSecret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) { throw new ShopifyError(`Could not reach Shopify: ${e.message}`); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const text = JSON.stringify(body);
    let msg;
    if (/shop_not_permitted/.test(text)) msg = 'Shopify refused the automatic login (shop_not_permitted): the app and the store are not in the same organization in the Dev Dashboard. Link the store with the install link instead: Settings, Shopify, Connect Shopify.';
    else if (res.status === 404) msg = `Shopify store "${cfg.shopify.shop}" was not found. Check SHOPIFY_SHOP (the part before .myshopify.com).`;
    else if (res.status === 400 || res.status === 401 || /invalid_client|invalid_request/.test(text)) msg = 'Shopify rejected the Client ID or Client secret, or the app is not installed on the store yet.';
    else msg = `Shopify token request failed (HTTP ${res.status}).`;
    throw new ShopifyError(msg, { status: res.status, code: body.error });
  }
  tok = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 86399) * 1000, scope: body.scope || '' };
  lastScope = tok.scope;
  return tok.token;
}

const scopes = () => lastScope.split(',').map((s) => s.trim()).filter(Boolean);

function explain(errors) {
  const msg = errors.map((e) => e.message).join('; ');
  if (/access denied|not approved|protected customer|required access/i.test(msg)) {
    return `${msg} (In the Dev Dashboard: the app version needs the read_orders and read_customers scopes, must be released, and the app must be installed on the store.)`;
  }
  return msg;
}

let nextOkAt = 0; // when the cost bucket has refilled enough for another query
let force401 = false; // after a 401, ask for a fresh token (refresh) instead of reusing the stored one

async function graphql(query, variables = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = nextOkAt - Date.now();
    if (wait > 0) await sleep(wait);
    let res;
    try {
      res = await fetch(`${base()}/admin/api/${cfg.shopify.apiVersion}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken(force401) },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (e instanceof ShopifyError) throw e; // token problems will not fix themselves
      lastErr = new ShopifyError(`Could not reach Shopify: ${e.message}`);
      await sleep(1500 * (attempt + 1));
      continue;
    }
    force401 = false;
    if (res.status === 401) { tok.token = null; force401 = true; lastErr = new ShopifyError('Shopify rejected the access token (HTTP 401)', { status: 401 }); continue; } // next loop asks for a fresh one
    if (res.status === 429 || res.status >= 500) {
      lastErr = new ShopifyError(`Shopify is busy (HTTP ${res.status})`, { status: res.status });
      await sleep((Number(res.headers.get('retry-after')) || 2 * (attempt + 1)) * 1000);
      continue;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) throw new ShopifyError(`Shopify request failed (HTTP ${res.status})`, { status: res.status });
    const cost = body.extensions && body.extensions.cost;
    if (cost && cost.throttleStatus) { // pause if the next query of this size would not fit in the bucket
      const need = cost.requestedQueryCost || cost.actualQueryCost || 0;
      const { currentlyAvailable, restoreRate } = cost.throttleStatus;
      if (currentlyAvailable < need) nextOkAt = Date.now() + Math.ceil(((need - currentlyAvailable) / (restoreRate || 50)) * 1000);
    }
    if (body.errors && body.errors.length) {
      if (body.errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED')) { lastErr = new ShopifyError('Shopify rate limit'); await sleep(2000 * (attempt + 1)); continue; }
      throw new ShopifyError(explain(body.errors), { code: body.errors[0].extensions && body.errors[0].extensions.code });
    }
    return body.data;
  }
  throw lastErr || new ShopifyError('Shopify request failed');
}

// Keep the page small: Shopify rejects queries whose estimated cost is over 1000 points.
const ORDER_FIELDS = `
  id name createdAt updatedAt cancelledAt test note tags currencyCode
  displayFinancialStatus displayFulfillmentStatus paymentGatewayNames
  email phone
  customer { displayName email phone }
  shippingAddress { name address1 address2 city province zip country phone }
  currentSubtotalPriceSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  totalDiscountsSet { shopMoney { amount } }
  currentTotalPriceSet { shopMoney { amount } }
  lineItems(first: 25) { nodes { title variantTitle sku quantity currentQuantity originalUnitPriceSet { shopMoney { amount } } } }
`;
const LIST_QUERY = `query Orders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys!, $reverse: Boolean!) {
  orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ORDER_FIELDS} }
  }
}`;

// Walks every page of a search. onPage gets each page's nodes.
async function pullOrders({ query = null, sortKey = 'UPDATED_AT', reverse = false, pageSize = 20, maxPages = 2000, onPage }) {
  let after = null; let pages = 0; let total = 0;
  while (pages < maxPages) {
    const data = await graphql(LIST_QUERY, { first: pageSize, after, query, sortKey, reverse });
    const { nodes, pageInfo } = data.orders;
    if (nodes.length) { await onPage(nodes); total += nodes.length; }
    pages += 1;
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return total;
}

async function fetchByNumber(orderId) {
  const data = await graphql(LIST_QUERY, { first: 1, after: null, query: `name:#${orderId}`, sortKey: 'CREATED_AT', reverse: true });
  return data.orders.nodes[0] || null;
}

async function latestOrder() {
  const data = await graphql(LIST_QUERY, { first: 1, after: null, query: null, sortKey: 'CREATED_AT', reverse: true });
  return data.orders.nodes[0] || null;
}

async function ping() {
  const data = await graphql('{ shop { name myshopifyDomain currencyCode } }');
  return { shop: data.shop, scopes: scopes() };
}

module.exports = { ShopifyError, isConfigured, getToken, setTokenProvider, graphql, pullOrders, fetchByNumber, latestOrder, ping, scopes, _reset: () => { tok = { token: null, expiresAt: 0, scope: '' }; nextOkAt = 0; force401 = false; lastScope = ''; provider = null; } };
