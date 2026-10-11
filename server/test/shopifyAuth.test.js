const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const Module = require('module');

process.env.SHOPIFY_SHOP = 'my-store';
process.env.SHOPIFY_CLIENT_ID = 'cid';
process.env.SHOPIFY_CLIENT_SECRET = 'sekret';
process.env.PUBLIC_URL = 'https://dash.example.com/';

// in-memory stand-in for the Setting collection
const rows = new Map();
const Setting = {
  findOne: ({ key }) => ({ lean: async () => (rows.has(key) ? { key, value: structuredClone(rows.get(key)) } : null) }),
  findOneAndUpdate: async ({ key }, doc) => { rows.set(key, structuredClone(doc.value)); },
  deleteOne: async ({ key }) => { rows.delete(key); },
};
const orig = Module._load;
Module._load = function (req, ...r) {
  if (req === 'dotenv') return { config() {} };
  if (req === '../models') return { Setting };
  return orig.call(this, req, ...r);
};

const client = require('../src/services/shopifyClient');
const auth = require('../src/services/shopifyAuth');

const sign = (q) => {
  const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&');
  return { ...q, hmac: crypto.createHmac('sha256', 'sekret').update(msg).digest('hex') };
};
const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
const reset = () => { rows.clear(); client._reset(); client.setTokenProvider(auth.provide); };

test('signature check accepts Shopify’s signature and rejects tampering', () => {
  const q = sign({ code: 'abc', shop: 'my-store.myshopify.com', state: 's1', timestamp: '1760000000' });
  assert.equal(auth.hmacOk(q, 'sekret'), true);
  assert.equal(auth.hmacOk({ ...q, code: 'other' }, 'sekret'), false);
  assert.equal(auth.hmacOk({ ...q, hmac: undefined }, 'sekret'), false);
});

test('approval address carries client id, scopes, redirect URL and a fresh state', async () => {
  reset();
  const { url, redirectUri } = await auth.beginUrl();
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://my-store.myshopify.com/admin/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('scope'), 'read_orders,read_customers');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://dash.example.com/api/shopify/callback');
  assert.equal(redirectUri, 'https://dash.example.com/api/shopify/callback');
  assert.equal(rows.get('shopify.oauthStates').length, 1);
  assert.equal(rows.get('shopify.oauthStates')[0].state, u.searchParams.get('state'));
});

test('callback: bad signature, other store, unknown state are all refused', async () => {
  reset();
  const { url } = await auth.beginUrl();
  const state = new URL(url).searchParams.get('state');
  const good = { code: 'c', shop: 'my-store.myshopify.com', state, timestamp: '1' };
  await assert.rejects(auth.handleCallback({ ...sign(good), code: 'tampered' }), /signature/);
  await assert.rejects(auth.handleCallback(sign({ ...good, shop: 'evil.myshopify.com' })), /different store/);
  await assert.rejects(auth.handleCallback(sign({ ...good, state: 'nope' })), /expired or was already used/);
  assert.equal(rows.has('shopify.auth'), false);
});

test('callback: exchanges the code, checks scopes, stores tokens, state is single use', async () => {
  reset();
  const { url } = await auth.beginUrl();
  const state = new URL(url).searchParams.get('state');
  let sent;
  global.fetch = async (u, o) => { sent = { u: String(u), body: String(o.body) }; return json({ access_token: 'at1', refresh_token: 'rt1', scope: 'read_orders,read_customers', expires_in: 3600, refresh_token_expires_in: 7776000 }); };
  const r = await auth.handleCallback(sign({ code: 'thecode', shop: 'my-store.myshopify.com', state, timestamp: '1' }));
  assert.equal(r.shop, 'my-store.myshopify.com');
  assert.equal(sent.u, 'https://my-store.myshopify.com/admin/oauth/access_token');
  assert.match(sent.body, /code=thecode/);
  assert.match(sent.body, /expiring=1/);
  const saved = rows.get('shopify.auth');
  assert.equal(saved.accessToken, 'at1');
  assert.equal(saved.refreshToken, 'rt1');
  assert.ok(saved.expiresAt);
  assert.equal((await auth.info()).mode, 'install-link');
  await assert.rejects(auth.handleCallback(sign({ code: 'thecode', shop: 'my-store.myshopify.com', state, timestamp: '1' })), /already used/);
});

test('callback: a missing permission is reported and nothing is stored', async () => {
  reset();
  const { url } = await auth.beginUrl();
  const state = new URL(url).searchParams.get('state');
  global.fetch = async () => json({ access_token: 'at', scope: 'read_orders' });
  await assert.rejects(auth.handleCallback(sign({ code: 'c', shop: 'my-store.myshopify.com', state, timestamp: '1' })), /read_customers/);
  assert.equal(rows.has('shopify.auth'), false);
});

test('an expired token is refreshed once, even for parallel calls, and both new tokens are kept', async () => {
  reset();
  rows.set('shopify.auth', { shop: 'my-store.myshopify.com', accessToken: 'old', refreshToken: 'rt-old', expiresAt: new Date(Date.now() - 1000), scope: 'read_orders,read_customers', installedAt: new Date('2026-10-10') });
  let refreshes = 0; let body;
  global.fetch = async (u, o) => { refreshes += 1; body = String(o.body); return json({ access_token: 'new', refresh_token: 'rt-new', scope: 'read_orders,read_customers', expires_in: 3600 }); };
  const [a, b] = await Promise.all([auth.provide(), auth.provide()]);
  assert.equal(a.token, 'new'); assert.equal(b.token, 'new');
  assert.equal(refreshes, 1);
  assert.match(body, /grant_type=refresh_token/); assert.match(body, /refresh_token=rt-old/);
  assert.equal(rows.get('shopify.auth').refreshToken, 'rt-new');
  assert.equal(rows.get('shopify.auth').installedAt instanceof Date || typeof rows.get('shopify.auth').installedAt === 'object', true);
});

test('a refused refresh asks the owner to reconnect instead of looping', async () => {
  reset();
  rows.set('shopify.auth', { shop: 'my-store.myshopify.com', accessToken: 'old', refreshToken: 'rt', expiresAt: new Date(Date.now() - 1000), scope: 'read_orders,read_customers' });
  global.fetch = async () => json({ error: 'invalid' }, 401);
  await assert.rejects(auth.provide(), /Connect Shopify/);
  assert.equal(rows.get('shopify.auth').needsReauth, true);
  await assert.rejects(auth.provide(), /Connect Shopify/); // no further calls to Shopify
});

test('the API client uses the stored token and forces a refresh after a 401', async () => {
  reset();
  rows.set('shopify.auth', { shop: 'my-store.myshopify.com', accessToken: 'tok1', refreshToken: 'rt1', expiresAt: new Date(Date.now() + 3600e3), scope: 'read_orders,read_customers' });
  const seen = [];
  global.fetch = async (u, o) => {
    if (String(u).endsWith('/access_token')) return json({ access_token: 'tok2', refresh_token: 'rt2', scope: 'read_orders,read_customers', expires_in: 3600 });
    seen.push(o.headers['X-Shopify-Access-Token']);
    return seen.length === 1 ? json({}, 401) : json({ data: { shop: { name: 'S' } } });
  };
  const r = await client.ping();
  assert.deepEqual(seen, ['tok1', 'tok2']);
  assert.deepEqual(r.scopes, ['read_orders', 'read_customers']);
});

test('without a linked store the client falls back to the automatic login', async () => {
  reset();
  let tokenCalls = 0;
  global.fetch = async (u) => {
    if (String(u).endsWith('/access_token')) { tokenCalls += 1; return json({ access_token: 'cc', scope: 'read_orders', expires_in: 86399 }); }
    return json({ data: { shop: { name: 'S' } } });
  };
  await client.ping();
  assert.equal(tokenCalls, 1);
});
