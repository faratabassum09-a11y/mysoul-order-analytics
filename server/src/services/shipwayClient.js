// Shipway API client. Credentials: the account email and the licence key (Shipway > Profile > Manage profile).
// No database in here, so it can be tested with a fake fetch.
const cfg = require('../config');

const TIMEOUT_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ShipwayError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.name = 'ShipwayError'; this.status = status; this.code = code; }
}

const isConfigured = () => !!(cfg.shipway.username && cfg.shipway.licenseKey);
let preferred = null; // 'number' | 'hash': the order-id format that last worked (for orderIdFormat = auto)

async function post(path, body) {
  if (!isConfigured()) throw new ShipwayError('Shipway is not set up yet. Add SHIPWAY_USERNAME and SHIPWAY_LICENSE_KEY on the server.', { status: 400, code: 'not_configured' });
  const { username, licenseKey, apiBase } = cfg.shipway;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(`${apiBase}/api/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${username}:${licenseKey}`).toString('base64')}` },
        body: JSON.stringify({ username, password: licenseKey, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) { lastErr = new ShipwayError(`Could not reach Shipway: ${e.message}`); await sleep(1000 * (attempt + 1)); continue; }
    if (res.status === 429 || res.status >= 500) { lastErr = new ShipwayError(`Shipway is busy (HTTP ${res.status})`, { status: res.status }); await sleep(2000 * (attempt + 1)); continue; }
    const data = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) throw new ShipwayError('Shipway rejected the login. Check SHIPWAY_USERNAME and SHIPWAY_LICENSE_KEY (the licence key, not the password).', { status: res.status, code: 'auth' });
    if (!data) throw new ShipwayError(`Shipway sent an unreadable reply (HTTP ${res.status})`, { status: res.status });
    return data;
  }
  throw lastErr || new ShipwayError('Shipway request failed');
}

const isAuthFailure = (d) => /invalid (email|user|username|password|licen)/i.test(String(d.msg || d.message || ''));
const authError = () => new ShipwayError('Shipway rejected the login. Check SHIPWAY_USERNAME and SHIPWAY_LICENSE_KEY (the licence key, not the password).', { status: 401, code: 'auth' });

async function authenticate() {
  const d = await post('authenticateUser', {});
  if (String(d.status).toLowerCase() !== 'success') throw authError();
  return { ok: true, userId: d.user_id };
}

const idsFor = (orderId) => {
  const fmt = cfg.shipway.orderIdFormat;
  const num = String(orderId); const hash = `#${orderId}`;
  if (fmt === 'number') return [num];
  if (fmt === 'hash') return [hash];
  return preferred === 'hash' ? [hash, num] : [num, hash];
};

// -> { found: true, id, response } | { found: false, message }. Throws ShipwayError for login, network and server problems.
async function getOrderShipmentDetails(orderId) {
  let message = '';
  for (const id of idsFor(orderId)) {
    const d = await post('getOrderShipmentDetails', { order_id: id });
    if (String(d.status).toLowerCase() === 'success' && d.response) {
      if (cfg.shipway.orderIdFormat === 'auto') preferred = id.startsWith('#') ? 'hash' : 'number';
      return { found: true, id, response: d.response };
    }
    if (isAuthFailure(d)) throw authError();
    message = String(d.msg || d.message || 'No shipment found');
  }
  return { found: false, message };
}

module.exports = { ShipwayError, isConfigured, post, authenticate, getOrderShipmentDetails, _reset: () => { preferred = null; } };
