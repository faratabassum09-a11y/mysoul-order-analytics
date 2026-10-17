// /api/desk : Shopify Desk (orders, FU queue, pending, dispatch, partial paid, cancelled, overview, settings).
// Every caller must be signed in with their own team login. Admins can do everything; the confirmation team works the
// queues; the packing team marks dispatches. Settings and the Overview are admin-only.
const express = require('express');
const multer = require('multer');
const svc = require('../services/deskService');
const { staffFromReq } = require('./flow');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpErr = (status, message) => Object.assign(new Error(message), { status });

const router = express.Router();
router.use(wrap(async (req, res, next) => {
  req.staff = await staffFromReq(req);
  if (!req.staff) return res.status(401).json({ error: 'Sign in with your team login' });
  if (req.staff.mustChangePassword) return res.status(403).json({ error: 'Set your own password first.', code: 'change_password' });
  next();
}));
const need = (...roles) => (req, res, next) => (req.staff.role === 'admin' || roles.includes(req.staff.role) ? next() : res.status(403).json({ error: 'Your role cannot do this.' }));
const adminOnly = (req, res, next) => (req.staff.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const takeFile = (field) => (req, res, next) => upload.single(field)(req, res, (e) => {
  if (!e) return next();
  next(httpErr(400, e.code === 'LIMIT_FILE_SIZE' ? 'The photo is too large (max 8 MB).' : 'The upload failed. Try again.'));
});
const orderIdOf = (req) => { const n = Number(req.params.orderId); if (!Number.isInteger(n) || n <= 0) throw httpErr(400, 'Bad order number'); return n; };
const who = (req) => ({ id: req.staff.id, name: req.staff.name, role: req.staff.role });

router.get('/counts', wrap(async (req, res) => res.json(await svc.counts())));
router.get('/config', wrap(async (req, res) => res.json(await svc.getConfig())));
router.put('/config', adminOnly, wrap(async (req, res) => res.json(await svc.saveConfig(req.body || {}))));
router.get('/overview', adminOnly, wrap(async (req, res) => res.json(await svc.overview(req.query))));
router.post('/refresh', wrap(async (req, res) => res.json(await svc.refresh())));

router.get('/orders', wrap(async (req, res) => res.json(await svc.ordersList(req.query))));
router.get('/orders/:orderId', wrap(async (req, res) => res.json(await svc.orderDetail(orderIdOf(req)))));
router.get('/queue/:key', wrap(async (req, res) => res.json(await svc.queue(req.params.key, req.query))));

// One endpoint for the one-tap actions. "restore" (undo a cancellation) is admin-only; "dispatch" belongs to the packing team.
router.post('/orders/:orderId/action', wrap(async (req, res) => {
  const action = String((req.body && req.body.action) || '');
  const b = req.body || {};
  if (action === 'restore') { if (req.staff.role !== 'admin') throw httpErr(403, 'Only an admin can restore a cancelled order.'); }
  else if (action === 'dispatch') { if (!['admin', 'packing'].includes(req.staff.role)) throw httpErr(403, 'Your role cannot do this.'); }
  else if (!['admin', 'confirmation'].includes(req.staff.role)) throw httpErr(403, 'Your role cannot do this.');
  res.json(await svc.act(who(req), orderIdOf(req), action, b));
}));
router.post('/orders/:orderId/partial', need('confirmation'), takeFile('screenshot'), wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await svc.savePartial(who(req), orderIdOf(req), { amount: b.amount, notes: b.notes, file: req.file }));
}));

// ---------------------------------------------------------------- Dispatch queue (packing team + admin): packing slip -> order packed -> order handover
router.get('/dispatch/config', wrap(async (req, res) => res.json(await svc.getDispatchConfig())));
router.put('/dispatch/config', adminOnly, wrap(async (req, res) => res.json(await svc.saveDispatchConfig(req.body || {}))));
router.get('/dispatch/board', need('packing'), wrap(async (req, res) => res.json(await svc.dispatchBoard(req.query))));
router.get('/dispatch/:orderId/awb', need('packing'), wrap(async (req, res) => res.json(await svc.liveAwb(orderIdOf(req)))));
router.post('/dispatch/:orderId/slip', need('packing'), wrap(async (req, res) => res.json(await svc.dispatchSlip(who(req), orderIdOf(req)))));
router.post('/dispatch/:orderId/packed', need('packing'), takeFile('photo'), wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await svc.dispatchPacked(who(req), orderIdOf(req), { awb: b.awb, courier: b.courier, file: req.file }));
}));
router.post('/dispatch/handover', need('packing'), takeFile('manifest'), wrap(async (req, res) => {
  const b = req.body || {};
  let ids = [];
  try { ids = JSON.parse(b.orderIds); } catch (e) { ids = String(b.orderIds || '').split(','); } // the app sends JSON; a comma list also works
  res.json(await svc.dispatchHandover(who(req), Array.isArray(ids) ? ids : [], { courier: b.courier, file: req.file }));
}));
router.get('/proofs/:id', wrap(async (req, res) => {
  const p = await svc.proofFile(req.params.id);
  const buf = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data.buffer || p.data);
  res.set({ 'Content-Type': p.mime, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
  res.send(buf);
}));

// In-transit orders: handed over, tracked through Shipway
router.get('/transit', wrap(async (req, res) => res.json(await svc.transitList(req.query))));
router.post('/transit/refresh', wrap(async (req, res) => res.json(await svc.refreshTransit({ ids: Array.isArray(req.body && req.body.orderIds) ? req.body.orderIds : null, limit: 60 }))));

router.get('/shots/:id', wrap(async (req, res) => {
  const s = await svc.shotFile(req.params.id);
  const buf = Buffer.isBuffer(s.data) ? s.data : Buffer.from(s.data.buffer || s.data); // the driver may hand back a BSON Binary instead of a Buffer
  s.data = buf;
  res.set({ 'Content-Type': s.mime, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
  res.send(buf);
}));

module.exports = router;
