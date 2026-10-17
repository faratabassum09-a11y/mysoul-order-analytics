// Shopify signs every webhook with the app's client secret: base64(HMAC-SHA256(secret, raw body)) in X-Shopify-Hmac-Sha256.
const crypto = require('crypto');
function verifyShopifyHmac(rawBody, header, secret) {
  if (!secret || !header || !Buffer.isBuffer(rawBody)) return false;
  const want = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let got;
  try { got = Buffer.from(String(header), 'base64'); } catch { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
module.exports = { verifyShopifyHmac };
