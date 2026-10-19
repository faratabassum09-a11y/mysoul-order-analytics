// /api/desk/stale-queue : count and clear untouched orders from before the queue start date. Admin only.
// Kept in its own file so it does not touch the other desk routes.
const express = require('express');
const svc = require('../services/deskService');
const { staffFromReq } = require('./flow');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();
router.use(wrap(async (req, res, next) => {
  const u = await staffFromReq(req);
  if (!u) return res.status(401).json({ error: 'Sign in with your team login' });
  if (u.role !== 'admin' || u.mustChangePassword) return res.status(403).json({ error: 'Admins only' });
  next();
}));
router.get('/', wrap(async (req, res) => res.json(await svc.staleQueue())));
router.post('/clear', wrap(async (req, res) => res.json(await svc.staleQueue({ clear: true }))));
module.exports = router;
