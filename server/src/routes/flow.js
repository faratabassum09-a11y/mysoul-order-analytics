const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const cfg = require('../config');
const { StaffUser, Setting } = require('../models');
const A = require('../lib/staffAuth');
const svc = require('../services/flowService');
const { resolveWindow } = require('../lib/windows');
const { fmtDate } = require('../lib/istTime');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpErr = svc.httpErr;

// ---------- session secret: from the environment, else generated once and kept in the database ----------
let secretCache = cfg.flow.tokenSecret || null;
async function secret() {
  if (secretCache) return secretCache;
  const s = await Setting.findOneAndUpdate({ key: 'staff.secret' }, { $setOnInsert: { key: 'staff.secret', value: crypto.randomBytes(48).toString('hex') } }, { upsert: true, new: true }).lean();
  secretCache = s.value;
  return secretCache;
}

const publicUser = (u) => ({ id: String(u._id), username: u.username, name: u.name, role: u.role, active: u.active, mustChangePassword: !!u.mustChangePassword, lastLoginAt: u.lastLoginAt });

// Who is calling? A signed-in person (token) is checked against the database on every request, so switching someone off works at once.
async function staffFromReq(req) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (!m) return null;
  const p = A.verifyToken(m[1], await secret());
  if (!p) return null;
  const u = await StaffUser.findById(p.uid).lean();
  if (!u || !u.active || (u.tokenVersion || 0) !== p.v) return null;
  return { id: String(u._id), name: u.name, role: u.role, username: u.username, mustChangePassword: !!u.mustChangePassword };
}
const keyOk = (req) => !cfg.accessPassword || req.get('x-access-key') === cfg.accessPassword; // the existing shared dashboard key (read-only here)

// Any caller we can name: a staff member, or the dashboard key (read only).
const auth = wrap(async (req, res, next) => {
  req.staff = await staffFromReq(req);
  req.manager = !req.staff && keyOk(req) && !!(req.get('x-access-key') || !cfg.accessPassword);
  if (req.staff || req.manager) return next();
  res.status(401).json({ error: 'Sign in with your team login' });
});
const need = (...roles) => (req, res, next) => {
  if (!req.staff) return res.status(403).json({ error: 'Sign in with your own team login to act on orders. The dashboard key can only view.' });
  if (req.staff.mustChangePassword) return res.status(403).json({ error: 'Set your own password first.', code: 'change_password' });
  if (req.staff.role === 'admin' || roles.includes(req.staff.role)) return next();
  res.status(403).json({ error: 'Your role cannot do this.' });
};
const dashboardOnly = (req, res, next) => (req.manager || (req.staff && req.staff.role === 'admin') ? next() : res.status(403).json({ error: 'Admins only' }));

const orderIdOf = (req) => { const n = Number(req.params.orderId); if (!Number.isInteger(n) || n <= 0) throw httpErr(400, 'Bad order number'); return n; };

// =====================================================================================================
// /api/staff : sign in, who am I, change password, and (admin) manage the team
// =====================================================================================================
const staff = express.Router();
const limiter = A.makeLimiter(5, 10 * 60 * 1000);

staff.post('/login', wrap(async (req, res) => {
  const username = A.normaliseUsername(req.body && req.body.username);
  const key = `${username}|${req.ip}`;
  if (limiter.blocked(key)) throw httpErr(429, 'Too many wrong attempts. Wait 10 minutes and try again.');
  const u = await StaffUser.findOne({ username }).lean();
  // Same work and same message whether the username exists or not
  const ok = A.verifyPassword(req.body && req.body.password, u ? u.passwordHash : 'scrypt$00$00');
  if (!u || !u.active || !ok) { limiter.fail(key); throw httpErr(401, 'Wrong username or password.'); }
  limiter.clear(key);
  await StaffUser.updateOne({ _id: u._id }, { $set: { lastLoginAt: new Date() } });
  res.json({ token: A.signToken({ uid: String(u._id), v: u.tokenVersion || 0 }, await secret()), user: publicUser(u) });
}));

staff.get('/me', auth, (req, res) => (req.staff ? res.json({ user: req.staff }) : res.json({ user: null, manager: true })));

staff.post('/password', auth, wrap(async (req, res) => {
  if (!req.staff) throw httpErr(403, 'Sign in with your team login');
  const { current, next } = req.body || {};
  const u = await StaffUser.findById(req.staff.id);
  if (!A.verifyPassword(current, u.passwordHash)) throw httpErr(400, 'Your current password is not right.');
  const bad = A.passwordProblem(next);
  if (bad) throw httpErr(400, bad);
  if (current === next) throw httpErr(400, 'Choose a different password from the old one.');
  u.passwordHash = A.hashPassword(next); u.mustChangePassword = false; u.tokenVersion = (u.tokenVersion || 0) + 1;
  await u.save();
  res.json({ token: A.signToken({ uid: String(u._id), v: u.tokenVersion }, await secret()), user: publicUser(u) }); // other devices are signed out
}));

// Admin gate for team management. The first admin can be made with the dashboard key, or (only when no dashboard key is set and no admin exists yet) openly.
const manageAuth = wrap(async (req, res, next) => {
  req.staff = await staffFromReq(req);
  if (req.staff && req.staff.role === 'admin') return next();
  const haveAdmin = (await StaffUser.countDocuments({ role: 'admin', active: true })) > 0;
  if (cfg.accessPassword && req.get('x-access-key') === cfg.accessPassword) return next();
  if (!cfg.accessPassword && !haveAdmin) return next();
  res.status(403).json({ error: 'Only an admin can manage the team.' });
});

staff.get('/users', manageAuth, wrap(async (req, res) => {
  res.json({ users: (await StaffUser.find().sort({ role: 1, name: 1 }).lean()).map(publicUser), roles: A.ROLES });
}));

staff.post('/users', manageAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const username = A.normaliseUsername(b.username);
  if (!A.USERNAME_RE.test(username)) throw httpErr(400, 'Username: 3 to 32 letters, digits, dot, dash or underscore.');
  if (!A.ROLES.includes(b.role)) throw httpErr(400, 'Pick a role');
  const name = String(b.name || '').trim();
  if (!name) throw httpErr(400, 'Enter the person\'s name');
  const bad = A.passwordProblem(b.password);
  if (bad) throw httpErr(400, bad);
  if (await StaffUser.exists({ username })) throw httpErr(409, 'That username is taken.');
  const u = await StaffUser.create({ username, name, role: b.role, passwordHash: A.hashPassword(b.password), mustChangePassword: true, createdBy: req.staff ? req.staff.username : 'dashboard key' });
  res.status(201).json({ user: publicUser(u) });
}));

const lastAdminGuard = async (target, change) => {
  if (target.role !== 'admin' || !target.active) return;
  const losing = (change.role && change.role !== 'admin') || change.active === false;
  if (losing && (await StaffUser.countDocuments({ role: 'admin', active: true, _id: { $ne: target._id } })) === 0) throw httpErr(400, 'There must be at least one active admin.');
};
staff.patch('/users/:id', manageAuth, wrap(async (req, res) => {
  const u = await StaffUser.findById(req.params.id);
  if (!u) throw httpErr(404, 'Person not found');
  const b = req.body || {};
  const change = {};
  if (b.name !== undefined) { const n = String(b.name).trim(); if (!n) throw httpErr(400, 'Name cannot be empty'); change.name = n; }
  if (b.role !== undefined) { if (!A.ROLES.includes(b.role)) throw httpErr(400, 'Pick a role'); change.role = b.role; }
  if (b.active !== undefined) change.active = !!b.active;
  await lastAdminGuard(u, change);
  Object.assign(u, change);
  if (change.active === false || change.role) u.tokenVersion = (u.tokenVersion || 0) + 1; // sign them out
  await u.save();
  res.json({ user: publicUser(u) });
}));
staff.post('/users/:id/password', manageAuth, wrap(async (req, res) => {
  const u = await StaffUser.findById(req.params.id);
  if (!u) throw httpErr(404, 'Person not found');
  const bad = A.passwordProblem(req.body && req.body.password);
  if (bad) throw httpErr(400, bad);
  u.passwordHash = A.hashPassword(req.body.password); u.mustChangePassword = true; u.tokenVersion = (u.tokenVersion || 0) + 1;
  await u.save();
  res.json({ user: publicUser(u) });
}));

// =====================================================================================================
// /api/flow : Confirm Queue, Dispatch Desk, timeline, proofs, Overview feed
// =====================================================================================================
const flow = express.Router();
flow.use(auth);
const MAX_MEDIA = cfg.flow.videoEnabled ? 12 * 1024 * 1024 : 8 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MEDIA, files: 1 } });
const takeFile = (field) => (req, res, next) => upload.single(field)(req, res, (e) => {
  if (!e) return next();
  next(httpErr(400, e.code === 'LIMIT_FILE_SIZE' ? `The file is too large (max ${Math.round(MAX_MEDIA / 1048576)} MB). Take the photo again at normal size.` : 'The upload failed. Try again.'));
});

flow.get('/confirm-queue', wrap(async (req, res) => res.json(await svc.confirmQueue())));
flow.post('/orders/:orderId/confirm-action', need('confirmation'), wrap(async (req, res) => {
  res.json(await svc.confirmAction(req.staff, orderIdOf(req), String(req.body.action || ''), req.body));
}));
flow.post('/orders/:orderId/contact', need('confirmation'), wrap(async (req, res) => {
  res.json(await svc.contact(req.staff, orderIdOf(req), String(req.body.channel || ''), req.body));
}));

flow.get('/dispatch', wrap(async (req, res) => {
  const days = Math.min(30, Math.max(1, parseInt(req.query.days) || 3));
  res.json(await svc.dispatchDesk(String(req.query.section || 'print_slip'), { days }));
}));
flow.post('/orders/:orderId/slip', need('packing'), wrap(async (req, res) => res.json(await svc.markSlipPrinted(req.staff, orderIdOf(req)))));
flow.post('/orders/:orderId/pack', need('packing'), takeFile('photo'), wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await svc.pack(req.staff, orderIdOf(req), { awb: b.awb, weight: b.weight, unit: b.unit, file: req.file }));
}));
flow.post('/orders/:orderId/dispatch', need('packing'), wrap(async (req, res) => res.json(await svc.markDispatched(req.staff, orderIdOf(req)))));
flow.post('/orders/:orderId/delay-reason', need('packing'), wrap(async (req, res) => res.json(await svc.setDelayReason(req.staff, orderIdOf(req), String(req.body.reason || '')))));
flow.post('/orders/:orderId/proofs', need('packing'), takeFile('file'), wrap(async (req, res) => res.json(await svc.addProof(req.staff, orderIdOf(req), req.file))));

flow.get('/orders/:orderId/timeline', wrap(async (req, res) => res.json(await svc.timeline(orderIdOf(req)))));
flow.get('/proofs/:id', wrap(async (req, res) => {
  const p = await svc.proofFile(req.params.id);
  res.set({ 'Content-Type': p.mime, 'Content-Length': p.data.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
  res.send(p.data);
}));

// Overview feed
flow.get('/overview', dashboardOnly, wrap(async (req, res) => {
  const w = resolveWindow(req.query.window || 'this_month', new Date(), { from: req.query.from, to: req.query.to });
  const out = await svc.overview(w);
  res.json({ ...out, range: { key: w.key, label: w.label, start: w.start ? fmtDate(w.start) : null, end: w.end ? fmtDate(new Date(w.end - 1)) : null } });
}));

flow.get('/config', dashboardOnly, wrap(async (req, res) => res.json(await svc.getConfig())));
flow.put('/config', dashboardOnly, wrap(async (req, res) => res.json(await svc.saveConfig(req.body || {}))));

module.exports = { staff, flow, staffFromReq };
