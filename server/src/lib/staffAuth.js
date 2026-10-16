// Per-person logins without extra packages: scrypt password hashes and HMAC-signed session tokens.
const crypto = require('crypto');

const ROLES = ['admin', 'confirmation', 'packing'];
const TOKEN_TTL_MS = 12 * 3600 * 1000; // one shift; people sign in again next day

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const want = Buffer.from(keyHex, 'hex');
  const got = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), want.length);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const b64 = (b) => Buffer.from(b).toString('base64url');
function signToken(payload, secret, now = Date.now(), ttl = TOKEN_TTL_MS) {
  const body = b64(JSON.stringify({ ...payload, exp: now + ttl }));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token, secret, now = Date.now()) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp && p.exp > now ? p : null;
  } catch { return null; }
}

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const normaliseUsername = (u) => String(u || '').trim().toLowerCase();
const passwordProblem = (p) => (String(p || '').length < 8 ? 'Password must be at least 8 characters' : null);

// Brute-force brake: 5 wrong passwords per username+ip in 10 minutes locks that pair for the rest of the window.
function makeLimiter(max = 5, windowMs = 10 * 60 * 1000) {
  const hits = new Map();
  return {
    blocked(key, now = Date.now()) { const h = (hits.get(key) || []).filter((t) => now - t < windowMs); hits.set(key, h); return h.length >= max; },
    fail(key, now = Date.now()) { const h = (hits.get(key) || []).filter((t) => now - t < windowMs); h.push(now); hits.set(key, h); },
    clear(key) { hits.delete(key); },
  };
}

module.exports = { ROLES, TOKEN_TTL_MS, hashPassword, verifyPassword, signToken, verifyToken, USERNAME_RE, normaliseUsername, passwordProblem, makeLimiter };
