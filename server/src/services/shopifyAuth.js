// Linking the store with Shopify's OAuth "authorization code" flow, for stores that are NOT in your Dev Dashboard organization
// (the automatic client-credentials login only works inside your own organization).
//   1. The store owner installs the app with the custom-distribution install link (Dev Dashboard).
//   2. In Settings, "Connect Shopify" sends the owner to Shopify to approve; Shopify returns to /api/shopify/callback with a code.
//   3. We exchange the code for an access token (+ refresh token) and keep it in the database; it is renewed automatically.
const crypto = require('crypto');
const cfg = require('../config');
const { Setting } = require('../models');
const client = require('./shopifyClient');

const AUTH_KEY = 'shopify.auth';
const STATE_KEY = 'shopify.oauthStates';
const STATE_TTL_MS = 10 * 60 * 1000;
const SHOP_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const shopHost = () => `${cfg.shopify.shop}.myshopify.com`;
const get = async (k) => { const s = await Setting.findOne({ key: k }).lean(); return s ? s.value : null; };
const put = (k, value) => Setting.findOneAndUpdate({ key: k }, { key: k, value }, { upsert: true });

function baseUrl(req) {
  if (cfg.publicUrl) return cfg.publicUrl.replace(/\/+$/, '');
  const proto = String((req && (req.get('x-forwarded-proto') || req.protocol)) || 'https').split(',')[0];
  return `${proto}://${req && req.get('host')}`;
}
// Must be listed, exactly, under "Redirect URLs" in the app version in the Dev Dashboard.
const redirectUri = (req) => `${baseUrl(req)}/api/shopify/callback`;

// Shopify signs the callback: HMAC-SHA256 over the other query parameters, sorted, using the client secret.
function hmacOk(query, secret) {
  const { hmac, ...rest } = query;
  if (!hmac || !secret) return false;
  const message = Object.keys(rest).sort().map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`).join('&');
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(message).digest('hex'));
  const got = Buffer.from(String(hmac));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

async function tokenRequest(params) {
  let res;
  try {
    res = await fetch(`https://${shopHost()}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: cfg.shopify.clientId, client_secret: cfg.shopify.clientSecret, ...params }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) { throw httpErr(502, `Could not reach Shopify: ${e.message}`); }
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

const addSeconds = (s) => (Number(s) > 0 ? new Date(Date.now() + Number(s) * 1000) : null);
const fromTokenResponse = (body, prev = {}) => ({
  shop: shopHost(),
  accessToken: body.access_token,
  refreshToken: body.refresh_token || null,
  expiresAt: addSeconds(body.expires_in),
  refreshExpiresAt: addSeconds(body.refresh_token_expires_in),
  scope: body.scope || prev.scope || '',
  installedAt: prev.installedAt || new Date(),
  needsReauth: false,
});

// Step 2: the address the owner is sent to. The random state value stops forged callbacks.
async function beginUrl(req) {
  if (!client.isConfigured()) throw httpErr(400, 'Shopify is not set up yet. Add SHOPIFY_SHOP, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET on the server.');
  const state = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const states = ((await get(STATE_KEY)) || []).filter((s) => now - s.at < STATE_TTL_MS).slice(-9);
  states.push({ state, at: now });
  await put(STATE_KEY, states);
  const q = new URLSearchParams({ client_id: cfg.shopify.clientId, scope: cfg.shopify.scopes, redirect_uri: redirectUri(req), state });
  return { url: `https://${shopHost()}/admin/oauth/authorize?${q}`, redirectUri: redirectUri(req) };
}

// Step 3: Shopify sent the owner back with ?code=&hmac=&shop=&state=&timestamp=
async function handleCallback(query) {
  if (!client.isConfigured()) throw httpErr(400, 'Shopify is not set up on the server.');
  if (!hmacOk(query, cfg.shopify.clientSecret)) throw httpErr(403, 'The answer from Shopify could not be verified (bad signature).');
  const { code, shop, state } = query;
  if (typeof shop !== 'string' || !SHOP_RE.test(shop) || shop !== shopHost()) throw httpErr(403, `This link is for a different store (${shop}). This dashboard is set up for ${shopHost()}.`);
  const now = Date.now();
  const states = (await get(STATE_KEY)) || [];
  if (!states.some((s) => s.state === state && now - s.at < STATE_TTL_MS)) throw httpErr(403, 'This connection attempt expired or was already used. Go back and press "Connect Shopify" again.');
  await put(STATE_KEY, states.filter((s) => s.state !== state)); // single use
  if (!code) throw httpErr(400, 'Shopify did not send an authorization code.');

  const { res, body } = await tokenRequest(cfg.shopify.expiringTokens ? { code, expiring: '1' } : { code });
  if (!res.ok || !body.access_token) throw httpErr(502, `Shopify would not give an access token (HTTP ${res.status}${body.error_description ? `: ${body.error_description}` : ''}).`);

  // The owner can untick permissions on the approval screen, so check what was really granted.
  const granted = String(body.scope || '').split(',').map((s) => s.trim()).filter(Boolean);
  const has = (s) => granted.includes(s) || granted.includes(`write_${s.slice(5)}`);
  const missing = ['read_orders', 'read_customers'].filter((s) => !has(s));
  if (missing.length) throw httpErr(403, `Shopify did not grant: ${missing.join(', ')}. Make sure the released app version includes them, then connect again.`);

  await put(AUTH_KEY, fromTokenResponse(body));
  return { shop, scope: body.scope };
}

// ---- keeping the token fresh ----
let refreshing = null;
function refresh(a) {
  if (refreshing) return refreshing; // two calls at once must not both spend the same refresh token
  refreshing = (async () => {
    const { res, body } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refreshToken });
    if (res.status === 401) {
      await put(AUTH_KEY, { ...a, needsReauth: true });
      throw new client.ShopifyError('The Shopify connection has expired or was removed. Press "Connect Shopify" in Settings to reconnect.', { status: 400 });
    }
    if (!res.ok || !body.access_token) throw new client.ShopifyError(`Shopify token refresh failed (HTTP ${res.status}).`, { status: res.status >= 500 ? 502 : 400 });
    const next = fromTokenResponse(body, a); // new access AND refresh token: keep both
    await put(AUTH_KEY, next);
    return next;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// Plugged into the client: returns { token, scope }, or null when the store was never linked this way.
async function provide(force = false) {
  let a = await get(AUTH_KEY);
  if (!a || !a.accessToken || a.shop !== shopHost()) return null;
  if (a.needsReauth) throw new client.ShopifyError('The Shopify connection has expired or was removed. Press "Connect Shopify" in Settings to reconnect.', { status: 400 });
  const exp = a.expiresAt ? new Date(a.expiresAt).getTime() : null;
  const stale = exp !== null && Date.now() >= exp - 60000;
  if (a.refreshToken && (stale || force)) a = await refresh(a);
  return { token: a.accessToken, scope: a.scope };
}
client.setTokenProvider(provide);

async function info() {
  const a = await get(AUTH_KEY);
  if (!a || !a.accessToken || a.shop !== shopHost()) return { mode: 'none' };
  return { mode: 'install-link', installedAt: a.installedAt, scope: a.scope, expiresAt: a.expiresAt, needsReauth: !!a.needsReauth };
}
const disconnect = () => Setting.deleteOne({ key: AUTH_KEY });

module.exports = { beginUrl, handleCallback, info, disconnect, redirectUri, hmacOk, provide };
