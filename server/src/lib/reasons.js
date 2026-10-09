const DEFAULT_REASON_MAP = [
  { bucket: 'Not reachable', keywords: ['dnp', 'switch off', 'switched off', 'not reachable', 'not picking', 'no answer', 'unreachable', 'not responding', 'call not', 'busy', 'phone off', 'not connected'] },
  { bucket: 'Not interested', keywords: ['not interested', 'not required', "don't want", 'dont want', 'no need', 'changed mind', 'change of mind', 'not needed', 'refused', 'refuse'] },
  { bucket: 'Courier did not attempt', keywords: ['not attempted', 'no attempt', 'did not attempt', "didn't attempt", 'courier', 'no delivery attempt', 'undelivered'] },
  { bucket: 'Address issue', keywords: ['address', 'pincode', 'pin code', 'wrong number', 'incomplete', 'not serviceable', 'out of area'] },
  { bucket: 'Ordered elsewhere', keywords: ['ordered elsewhere', 'ordered from', 'bought', 'purchased', 'amazon', 'flipkart', 'other site', 'another site', 'elsewhere'] },
  { bucket: 'Duplicate order', keywords: ['duplicate', 'double order', 'ordered twice', 'repeat order'] },
  { bucket: 'Price / payment', keywords: ['price', 'expensive', 'costly', 'payment', 'cod charge', 'no money'] },
];

// First bucket whose keyword appears in the text wins (order in the settings table is priority order).
function bucketize(text, map) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return 'No reason recorded';
  for (const { bucket, keywords } of map) {
    if ((keywords || []).some((k) => k && t.includes(String(k).toLowerCase().trim()))) return bucket;
  }
  return 'Other';
}

function summarize(orders, getText, map, topRaw = 12) {
  const buckets = new Map();
  for (const o of orders) {
    const raw = String(getText(o) || '').trim();
    const b = bucketize(raw, map);
    if (!buckets.has(b)) buckets.set(b, { bucket: b, count: 0, raw: new Map() });
    const e = buckets.get(b);
    e.count++;
    if (raw) e.raw.set(raw, (e.raw.get(raw) || 0) + 1);
  }
  const total = orders.length;
  const list = [...buckets.values()].sort((a, b) => b.count - a.count).map((e) => ({
    bucket: e.bucket, count: e.count, pct: total ? (e.count / total) * 100 : 0,
    raw: [...e.raw.entries()].sort((a, b) => b[1] - a[1]).slice(0, topRaw).map(([text, count]) => ({ text, count })),
  }));
  return { total, buckets: list };
}

module.exports = { DEFAULT_REASON_MAP, bucketize, summarize };
