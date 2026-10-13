const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

process.env.SHIPWAY_USERNAME = 'ops@example.com';
process.env.SHIPWAY_LICENSE_KEY = 'LIC123';
process.env.SHIPWAY_ORDER_ID_FORMAT = 'auto';
const orig = Module._load;
Module._load = function (req, ...r) { return req === 'dotenv' ? { config() {} } : orig.call(this, req, ...r); };

const { normalizeShipment, pickCandidates } = require('../src/lib/shipwayMap');
const client = require('../src/services/shipwayClient');

const reply = (over = {}) => ({ current_status: 'Delivered', current_status_code: 'DEL', carrier: 'Delhivery', from: 'Hyderabad', to: 'Pune', customer_name: 'A B', pickup_date: '2026-10-09', time: '2026-10-12 16:30:00', awbno: '123456', ...over });

test('shipway: status codes map to a group and a final flag; unknown codes keep Shipway wording', () => {
  const d = normalizeShipment(reply(), '1874');
  assert.equal(d.group, 'delivered'); assert.equal(d.final, true); assert.equal(d.carrier, 'Delhivery'); assert.equal(d.awb, '123456'); assert.equal(d.shipwayOrderId, '1874');
  assert.equal(d.statusAt.toISOString(), '2026-10-12T11:00:00.000Z'); // 16:30 IST
  assert.ok(!('customer_name' in d) && !JSON.stringify(d).includes('A B'), 'customer name is not stored');
  assert.deepEqual(['UND', 'CNA', 'CRTA'].map((c) => normalizeShipment(reply({ current_status_code: c })).group), ['ndr', 'ndr', 'ndr']);
  assert.equal(normalizeShipment(reply({ current_status_code: 'RTO' })).final, false);
  assert.equal(normalizeShipment(reply({ current_status_code: 'RTD' })).final, true);
  const odd = normalizeShipment(reply({ current_status_code: 'XYZ', current_status: 'Held at hub' }));
  assert.equal(odd.group, 'other'); assert.equal(odd.status, 'Held at hub'); assert.equal(odd.final, false);
  assert.equal(normalizeShipment(reply({ time: 'garbage' })).statusAt, null);
});

test('shipway: which orders get looked up', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  const mins = (m) => new Date(now - m * 60000);
  const orders = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ orderId: n, orderDate: mins(60) }));
  orders[6].orderDate = new Date('2026-08-01T00:00:00Z'); // 7: old, never found
  const docs = new Map([
    [2, { found: true, final: true, checkedAt: mins(500) }], // delivered: never again
    [3, { found: true, final: false, checkedAt: mins(45) }], // moving, stale: yes
    [4, { found: true, final: false, checkedAt: mins(5) }], // moving, fresh: no
    [5, { found: false, checkedAt: mins(200) }], // missing, retry window passed: yes
    [6, { found: false, checkedAt: mins(20) }], // missing, too soon: no
    [7, { found: false, checkedAt: mins(500) }], // missing and older than 30 days: stop asking
  ]);
  assert.deepEqual(pickCandidates(orders, docs, now), [1, 3, 5]); // never-checked first
  assert.deepEqual(pickCandidates(orders, docs, now, { limit: 1 }), [1]);
  assert.deepEqual(pickCandidates([{ orderId: null }], new Map(), now), []);
  assert.deepEqual(pickCandidates([{ orderId: 8, orderDate: mins(10) }], new Map([[8, { found: false, error: 'busy', checkedAt: mins(20) }]]), now), [8]); // failed lookups retry soon
});

function fake(handler) {
  const calls = [];
  global.fetch = async (url, opts = {}) => { const body = JSON.parse(opts.body); calls.push({ url: String(url), opts, body }); return handler(body, String(url)); };
  return calls;
}
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('shipway client: login, credentials and the order-id format fallback', async () => {
  client._reset();
  let calls = fake(() => json({ status: 'Success', user_id: 7 }));
  assert.deepEqual(await client.authenticate(), { ok: true, userId: 7 });
  assert.match(calls[0].url, /\/api\/authenticateUser$/);
  assert.equal(calls[0].body.username, 'ops@example.com'); assert.equal(calls[0].body.password, 'LIC123');
  assert.equal(calls[0].opts.headers.Authorization, `Basic ${Buffer.from('ops@example.com:LIC123').toString('base64')}`);

  // Shipway holds the order as "#1874": plain number fails, hash works, and the next lookup goes straight to the hash
  calls = fake((b) => (b.order_id === '#1874' ? json({ status: 'Success', response: reply() }) : json({ status: 'Failed', msg: 'Order not found' })));
  const r = await client.getOrderShipmentDetails(1874);
  assert.equal(r.found, true); assert.equal(r.id, '#1874'); assert.deepEqual(calls.map((c) => c.body.order_id), ['1874', '#1874']);
  calls = fake(() => json({ status: 'Success', response: reply() }));
  await client.getOrderShipmentDetails(1875);
  assert.equal(calls[0].body.order_id, '#1875');
});

test('shipway client: not found is not an error, a bad login is', async () => {
  client._reset();
  fake(() => json({ status: 'Failed', msg: 'No shipment found' }));
  const r = await client.getOrderShipmentDetails(9);
  assert.equal(r.found, false); assert.match(r.message, /No shipment/);
  // Shipway answers a wrong licence key with HTTP 200 and a message
  fake(() => json({ status: 'Failed', msg: 'Invalid Email address or Password' }));
  await assert.rejects(client.getOrderShipmentDetails(9), /licence key/);
  await assert.rejects(client.authenticate(), /licence key/);
  fake(() => json({}, 401));
  await assert.rejects(client.getOrderShipmentDetails(9), (e) => e.code === 'auth');
});

// ---- refreshOne against an in-memory stand-in for the database ----
test('shipway sync: saves status, records changes, never wipes a known status on an empty lookup', async () => {
  const store = new Map();
  const model = {
    findOne: (q) => ({ lean: async () => (store.has(q.orderId) ? JSON.parse(JSON.stringify(store.get(q.orderId)), (k, v) => (k === 'at' || k === 'checkedAt' ? new Date(v) : v)) : null) }),
    updateOne: async (q, u) => {
      const cur = store.get(q.orderId) || { ...(u.$setOnInsert || {}) };
      store.set(q.orderId, { ...cur, ...(u.$set || {}) });
    },
  };
  const prevLoad = Module._load;
  Module._load = function (req, ...r) { return /\/models$/.test(req) ? { ShipwayShipment: model, Order: {}, Setting: {} } : prevLoad.call(this, req, ...r); };
  delete require.cache[require.resolve('../src/services/shipwaySync')];
  const sync = require('../src/services/shipwaySync');
  Module._load = prevLoad;

  client._reset();
  let code = 'INT';
  fake(() => json({ status: 'Success', response: reply({ current_status_code: code, current_status: code === 'INT' ? 'In Transit' : 'Delivered' }) }));
  let r = await sync.refreshOne(1874);
  assert.equal(r.found, true); assert.equal(r.changed, true);
  assert.equal(store.get(1874).history.length, 1); assert.equal(store.get(1874).group, 'transit'); assert.equal(store.get(1874).final, false);
  r = await sync.refreshOne(1874); // nothing new
  assert.equal(r.changed, false); assert.equal(store.get(1874).history.length, 1);
  code = 'DEL';
  r = await sync.refreshOne(1874);
  assert.equal(r.changed, true); assert.deepEqual(store.get(1874).history.map((h) => h.code), ['INT', 'DEL']); assert.equal(store.get(1874).final, true);

  fake(() => json({ status: 'Failed', msg: 'No shipment found' })); // a later empty answer must not erase the status
  r = await sync.refreshOne(1874);
  assert.equal(r.kept, true); assert.equal(store.get(1874).status, 'Delivered'); assert.equal(store.get(1874).found, true);
  r = await sync.refreshOne(2000); // never in Shipway
  assert.equal(r.found, false); assert.equal(store.get(2000).found, false);

  fake(() => json({ status: 'Failed', msg: 'Invalid Email address or Password' })); // login problem stops the run
  await assert.rejects(sync.refreshOne(1), (e) => e.code === 'auth');
  fake(() => json({}, 503)); // server trouble is recorded on the order, not thrown
  client._reset();
  r = await sync.refreshOne(3000);
  assert.match(r.error, /busy/); assert.match(store.get(3000).error, /busy/);
});
