// Shipway API client. Credentials: the account email and the licence key (Shipway > Profile > Manage profile).
// Two Shipway APIs exist:
//   new  (default, https://app.shipway.com): Basic auth header, GET /api/getorders?orderid=...
//   old  (https://shipway.in, set SHIPWAY_API_BASE to use it): POST /api/getOrderShipmentDetails with username/password in the body
// No database in here, so it can be tested with a fake fetch.
const cfg = require('../config');

const TIMEOUT_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());

class ShipwayError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.name = 'ShipwayError'; this.status = status; this.code = code; }
}

const isConfigured = () => !!(cfg.shipway.username && cfg.shipway.licenseKey);
const isLegacy = () => { try { return new URL(cfg.shipway.apiBase).hostname.endsWith('shipway.in'); } catch { return false; } };
let preferred = null; // 'number' | 'hash': the order-id format that last worked (for orderIdFormat = auto)

// One HTTP call with retries. method GET: query goes in the URL. method POST: body goes as JSON (old API also gets username/password).
async function call(method, path, { query, body } = {}) {
  if (!isConfigured()) throw new ShipwayError('Shipway is not set up yet. Add SHIPWAY_USERNAME and SHIPWAY_LICENSE_KEY on the server.', { status: 400, code: 'not_configured' });
  const { username, licenseKey, apiBase } = cfg.shipway;
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  const url = `${apiBase}/api/${path}${qs}`;
  const headers = { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${username}:${licenseKey}`).toString('base64')}` };
  const opts = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (method === 'POST') { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify({ username, password: licenseKey, ...body }); }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try { res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) }); } catch (e) { lastErr = new ShipwayError(`Could not reach Shipway: ${e.message}`); await sleep(1000 * (attempt + 1)); continue; }
    if (res.status === 429 || res.status >= 500) { lastErr = new ShipwayError(`Shipway is busy (HTTP ${res.status})`, { status: res.status }); await sleep(2000 * (attempt + 1)); continue; }
    let raw = ''; let data = null;
    if (typeof res.text === 'function') { raw = await res.text().catch(() => ''); try { data = JSON.parse(raw); } catch { data = null; } }
    else data = await res.json().catch(() => null);
    const detail = (data && (data.msg || data.message || data.error)) || raw.replace(/\s+/g, ' ').slice(0, 160);
    if (res.status === 401 || res.status === 403) throw new ShipwayError(`Shipway rejected the login (HTTP ${res.status} from ${apiBase}). Shipway said: ${typeof detail === 'string' ? detail : JSON.stringify(detail) || 'nothing'}. Check SHIPWAY_USERNAME and SHIPWAY_LICENSE_KEY (the licence key, not the password).`, { status: res.status, code: 'auth' });
    if (!data) throw new ShipwayError(`Shipway sent an unreadable reply (HTTP ${res.status} from ${apiBase}): ${detail || 'empty'}`, { status: res.status });
    return data;
  }
  throw lastErr || new ShipwayError('Shipway request failed');
}
const post = (path, body) => call('POST', path, { body });

const isAuthFailure = (d) => /invalid (email|user|username|password|licen)/i.test(String(d.msg || d.message || ''));
const authError = (d) => new ShipwayError(`Shipway rejected the login${d ? ` (Shipway said: ${String(d.msg || d.message || d.status || 'no message')})` : ''}. Check SHIPWAY_USERNAME and SHIPWAY_LICENSE_KEY (the licence key, not the password).`, { status: 401, code: 'auth' });

async function authenticate() {
  if (!isLegacy()) {
    // The new API has no separate login call: a lookup that answers (instead of HTTP 401) proves the credentials.
    await call('GET', 'getorders', { query: { orderid: 'connection-test' } });
    return { ok: true };
  }
  const d = await post('authenticateUser', {});
  if (String(d.status).toLowerCase() !== 'success') throw authError(d);
  return { ok: true, userId: d.user_id };
}

const idsFor = (orderId) => {
  const fmt = cfg.shipway.orderIdFormat;
  const num = String(orderId); const hash = `#${orderId}`;
  if (fmt === 'number') return [num];
  if (fmt === 'hash') return [hash];
  return preferred === 'hash' ? [hash, num] : [num, hash];
};
const remember = (id) => { if (cfg.shipway.orderIdFormat === 'auto') preferred = id.startsWith('#') ? 'hash' : 'number'; };

// New API order -> the shape shipwayMap.normalizeShipment expects. null = in Shipway but not dispatched yet (no AWB).
function fromGetOrders(x) {
  const awb = clean(x.tracking_number);
  if (!awb) return null;
  const scans = (Array.isArray(x.shipment_status_scan) ? x.shipment_status_scan : []).filter((s) => s && s.datetime);
  scans.sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));
  const last = scans[scans.length - 1];
  const raw = clean(x.shipment_status);
  const code = /^[A-Za-z]{2,6}$/.test(raw) ? raw.toUpperCase() : '';
  const text = clean(x.shipment_status_name) || (last && clean(last.status)) || (!code && raw && raw !== '0' ? raw : '');
  return {
    current_status_code: code, current_status: text, carrier: clean(x.name) || clean(x.carrier_title), awbno: awb,
    from: clean(x.pickup_address && x.pickup_address.city), to: clean(x.s_city), pickup_date: '', time: last ? clean(last.datetime) : '',
  };
}

// -> { found: true, id, response } | { found: false, message }. Throws ShipwayError for login, network and server problems.
async function getOrderShipmentDetails(orderId) {
  let message = '';
  if (!isLegacy()) {
    for (const id of idsFor(orderId)) {
      const d = await call('GET', 'getorders', { query: { orderid: id } });
      const list = Array.isArray(d.message) ? d.message : [];
      const hit = list.find((x) => clean(x.order_id) === id); // never trust the filter: only accept the exact order
      if (!hit) { message = typeof d.message === 'string' && d.message ? d.message : (clean(d.error) || 'Order not found in Shipway'); continue; }
      remember(id);
      const response = fromGetOrders(hit);
      if (response) return { found: true, id, response };
      return { found: false, message: 'In Shipway, but not dispatched yet (no tracking number)' };
    }
    return { found: false, message };
  }
  for (const id of idsFor(orderId)) {
    const d = await post('getOrderShipmentDetails', { order_id: id });
    if (String(d.status).toLowerCase() === 'success' && d.response) { remember(id); return { found: true, id, response: d.response }; }
    if (isAuthFailure(d)) throw authError(d);
    message = String(d.msg || d.message || 'No shipment found');
  }
  return { found: false, message };
}

module.exports = { ShipwayError, isConfigured, isLegacy, post, authenticate, getOrderShipmentDetails, _reset: () => { preferred = null; } };
