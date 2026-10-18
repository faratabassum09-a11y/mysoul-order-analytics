// /api/desk : Shopify Desk (orders, FU queue, pending, dispatch, partial paid, cancelled, overview, settings).
// Every caller must be signed in with their own team login. Admins can do everything; the confirmation team works the
// queues; the packing team marks dispatches. Settings and the Overview are admin-only.
const express = require('express');
const multer = require('multer');
const svc = require('../services/deskService');
const D = require('../lib/desk');
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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 10 } });
const uploadErr = (next) => (e) => {
  if (!e) return next();
  next(httpErr(400, e.code === 'LIMIT_FILE_SIZE' ? 'A photo is too large (max 8 MB each).' : e.code === 'LIMIT_UNEXPECTED_FILE' || e.code === 'LIMIT_FILE_COUNT' ? 'Add at most 10 photos.' : 'The upload failed. Try again.'));
};
const takeFile = (field) => (req, res, next) => upload.single(field)(req, res, uploadErr(next));
// Several photos in one field (the older single-file field name keeps working). Puts them in req.photos.
const takeFiles = (field, legacy) => (req, res, next) => upload.fields([{ name: field, maxCount: 10 }, { name: legacy, maxCount: 10 }])(req, res, uploadErr((e) => {
  if (e) return next(e);
  req.photos = [...((req.files && req.files[field]) || []), ...((req.files && req.files[legacy]) || [])];
  next();
}));
const orderIdOf = (req) => { const n = Number(req.params.orderId); if (!Number.isInteger(n) || n <= 0) throw httpErr(400, 'Bad order number'); return n; };
const who = (req) => ({ id: req.staff.id, name: req.staff.name, role: req.staff.role });

router.get('/counts', wrap(async (req, res) => res.json(await svc.counts())));
// Everyone signed in reads the settings (the screens need the names, hours and cancel reasons). Names come with their defaults so Settings can show what "reset" returns.
router.get('/config', wrap(async (req, res) => res.json({ ...(await svc.getConfig()), labelDefaults: D.DEFAULT_LABELS, labelGroups: D.LABEL_GROUPS })));
router.put('/config', adminOnly, wrap(async (req, res) => res.json({ ...(await svc.saveConfig(req.body || {})), labelDefaults: D.DEFAULT_LABELS, labelGroups: D.LABEL_GROUPS })));
router.get('/overview', adminOnly, wrap(async (req, res) => res.json(await svc.overview(req.query))));
router.post('/refresh', wrap(async (req, res) => res.json(await svc.refresh())));

router.get('/analysis', wrap(async (req, res) => res.json(await svc.analysisData(req.query))));
router.get('/analysis.xlsx', wrap(async (req, res) => {
  const { buffer, count } = await svc.analysisSheet(req.query);
  const one = Number(req.query.orderId);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${Number.isInteger(one) && one > 0 ? `order-${one}` : 'order-analysis'}.xlsx"`,
    'Content-Length': buffer.length, 'X-Row-Count': String(count), 'Cache-Control': 'no-store',
  });
  res.send(buffer);
}));
router.get('/orders', wrap(async (req, res) => res.json(await svc.ordersList(req.query))));
router.get('/orders/:orderId', wrap(async (req, res) => res.json(await svc.orderDetail(orderIdOf(req)))));
router.get('/queue/:key', wrap(async (req, res) => res.json(await svc.queue(req.params.key, req.query))));
// Confirm queue and Pending orders as boards: one column per follow-up, like the Dispatch queue
router.get('/board/:kind', need('confirmation'), wrap(async (req, res) => res.json(await svc.callBoard(req.params.kind, { ...req.query, viewer: req.staff }))));

// ---------------------------------------------------------------- Who works which order
router.get('/team', wrap(async (req, res) => res.json({ team: await svc.team() })));
router.get('/assign/config', adminOnly, wrap(async (req, res) => res.json(await svc.assignOverview())));
router.put('/assign/config', adminOnly, wrap(async (req, res) => res.json(await svc.saveAssignConfig(req.body || {}))));
router.post('/assign/rebalance', adminOnly, wrap(async (req, res) => res.json(await svc.rebalance(req.staff, (req.body && req.body.slot) || null))));
router.post('/assign/bulk', adminOnly, wrap(async (req, res) => res.json(await svc.assignBulk(req.staff, req.body && req.body.orderIds, (req.body && req.body.userId) || null))));
router.post('/orders/:orderId/assign', need('confirmation', 'packing'), wrap(async (req, res) => res.json(await svc.assignManual(who(req), orderIdOf(req), (req.body && req.body.userId) || null))));

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
router.get('/dispatch/board', need('packing'), wrap(async (req, res) => res.json(await svc.dispatchBoard({ ...req.query, viewer: req.staff }))));
router.get('/dispatch/:orderId/awb', need('packing'), wrap(async (req, res) => res.json(await svc.liveAwb(orderIdOf(req)))));
router.post('/dispatch/:orderId/slip', need('packing'), wrap(async (req, res) => res.json(await svc.dispatchSlip(who(req), orderIdOf(req)))));
router.post('/dispatch/:orderId/packed', need('packing'), takeFiles('photos', 'photo'), wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await svc.dispatchPacked(who(req), orderIdOf(req), { awb: b.awb, courier: b.courier, files: req.photos }));
}));
router.post('/dispatch/handover', need('packing'), takeFiles('manifests', 'manifest'), wrap(async (req, res) => {
  const b = req.body || {};
  let ids = [];
  try { ids = JSON.parse(b.orderIds); } catch (e) { ids = String(b.orderIds || '').split(','); } // the app sends JSON; a comma list also works
  res.json(await svc.dispatchHandover(who(req), Array.isArray(ids) ? ids : [], { courier: b.courier, files: req.photos }));
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
