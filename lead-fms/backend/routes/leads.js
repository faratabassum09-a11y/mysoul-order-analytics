import express from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import { Lead, LeadActivity, LeadSnapshot } from "../models/Lead.js";
import { hashPassword } from "../utils/auth.js";
import { clearAuthCache } from "../middleware/auth.js";
import * as S from "../utils/leadService.js";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const router = express.Router();
// Mounted in server.js behind requireAuth. Two levels: an ADMIN runs everything; a CALLER only
// reads their own leads / activity / reports and updates follow-ups on leads that are theirs.

router.use((req, _res, next) => { req.lu = { ...req.user, leadAdmin: req.user.role === "admin" }; next(); });
const adminOnly = (req, res, next) => (req.lu.leadAdmin ? next() : res.status(403).json({ error: "Admins only" }));
const wrap = (f) => (req, res) =>
  f(req, res).catch((e) => res.status(e.status || 400).json({ error: e.code === 11000 ? "A lead with this phone number already exists" : e.message }));
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const loadLead = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw fail("Lead not found", 404);
  const l = await Lead.findById(id);
  if (!l) throw fail("Lead not found", 404);
  return l;
};

// ---------- settings ----------
router.get("/config", wrap(async (req, res) => {
  const c = await S.getCfg();
  res.json(req.lu.leadAdmin ? { ...c, lastSync: await S.lastSync() } : { statuses: c.statuses, plan: c.plan, attPlan: c.attPlan, waTemplate: c.waTemplate });
}));
router.put("/config", adminOnly, wrap(async (req, res) => {
  const b = req.body || {}, applyToExisting = b.applyToExisting !== false;
  delete b.lastSync; delete b.applyToExisting;
  const prev = await S.getCfg(), next = { ...prev, ...b };
  next.plan = S.cleanPlan(next.plan, "Lead follow-ups");
  next.attPlan = S.cleanPlan(next.attPlan, "Attendee follow-ups");
  next.assign = S.cleanAssign(next.assign);
  delete next.autoAssign; // replaced by "Automatic assignment"
  next.sheetUrl = String(next.sheetUrl || "").trim();
  if (next.sheetUrl && !/^https:\/\/script\.google(usercontent)?\.com\//.test(next.sheetUrl)) throw fail("The Google Script link should start with https://script.google.com/…");
  if (!Array.isArray(next.statuses) || !next.statuses.length) throw fail("Add at least one call status");
  await S.setCfg(next);
  // a follow-up was ADDED or REMOVED -> every existing lead follows the new plan (and so to Today / Delayed / Attendee Follow-ups)
  const changed = next.plan.length !== prev.plan.length || next.attPlan.length !== prev.attPlan.length;
  const added = changed && applyToExisting ? await S.addStepsToExistingLeads(await S.getCfg()) : null;
  res.json({ ...(await S.getCfg()), ...(added ? { addedToLeads: added.leads, addedSteps: added.steps, removedSteps: added.removed } : {}) });
}));

// the chooser card on the Hub
router.get("/stats", wrap(async (req, res) => res.json(await S.stats(req.lu))));

// live race: calls done vs left today, per caller — visible to every signed-in person
router.get("/progress", wrap(async (_req, res) => res.json(await S.progress())));
// "Share out again" in Settings -> Automatic assignment
router.post("/assign/reshare", adminOnly, wrap(async (req, res) => res.json(await S.reshare(String(req.body?.queue || "")))));

// ---------- intake sheet ----------
router.post("/sync", adminOnly, wrap(async (req, res) => { const r = await S.syncIntake({ name: req.user.name, email: req.user.email }); S.pushSoon(); res.json(r); }));
// the import history shown in Settings: when, who, how many leads
router.get("/import-log", adminOnly, wrap(async (_req, res) => res.json(await S.importLog(100))));
// the Google Apps Script to paste into the sheet (Extensions -> Apps Script), with this site's secret key filled in
router.get("/sheet-script", adminOnly, wrap(async (_req, res) => {
  const c = await S.getCfg();
  if (!c.sheetToken) throw fail("Generate the secret key first, save settings, then copy the script");
  const code = (await readFile(new URL("../sheet/Code.gs", import.meta.url), "utf8")).replace("__SECRET_KEY__", c.sheetToken);
  res.json({ code });
}));
router.post("/sheet-key", adminOnly, wrap(async (_req, res) => res.json({ token: randomBytes(18).toString("hex") })));
// "Test connection": read the sheet and say what was found, without importing anything
router.post("/sheet-test", adminOnly, wrap(async (req, res) => {
  const cfg = { ...(await S.getCfg()), ...(req.body || {}) };
  const rows = await S.readSheetRows(cfg), hi = rows.findIndex((r) => r.some((c) => /phone/i.test(String(c))));
  if (hi < 0) throw fail("Connected, but no header row with “Lead Phone” was found in the first tab");
  const H = rows[hi].map((h) => String(h).trim()), need = ["Timestamp", "Lead Name", "Lead Email", "Lead Phone", "UTW Date", "Assigned To", "Workshop"];
  const missing = need.filter((n) => !H.some((h) => h.toLowerCase().includes(n.toLowerCase().replace("lead ", ""))));
  res.json({ ok: true, leadsInSheet: rows.slice(hi + 1).filter((r) => String(r.find((_, i) => /phone/i.test(H[i] || "")) ?? "").trim()).length, headers: H.filter(Boolean), missing });
}));

// ---------- leads ----------
router.get("/leads", wrap(async (req, res) => res.json(await Lead.find(S.mineFilter(req.lu)).select("-trail").sort({ ts: -1 }).lean())));

// one lead's whole story: how it came in, who it was assigned to, every call ever made
router.get("/leads/:id/history", wrap(async (req, res) => {
  const l = await loadLead(req.params.id);
  if (!S.ownsLead(req.lu, l)) throw fail("Not your lead", 403);
  const calls = await LeadActivity.find({ key: l.key }).sort({ at: -1 }).limit(200).lean();
  res.json({ trail: l.trail || [], calls: calls.map((c) => ({ at: c.at, stage: c.stage, step: c.step, status: c.status, note: c.note, caller: c.caller, delayMs: c.delayMs })) });
}));

router.post("/leads", adminOnly, wrap(async (req, res) => {
  const c = await S.getCfg(), b = req.body || {}, phone = String(b.phone || "").replace(/\D/g, "");
  if (!phone || !b.name?.trim()) throw fail("Name and phone are required");
  const ts = new Date(), A = await S.assigner("new", c), owner = b.assignedTo || A.pick();
  const story = [{ at: ts, type: "entered", text: "Lead added by " + req.user.name, by: req.user.name }];
  if (owner) story.push({ at: ts, type: "assign", text: `Assigned to ${owner} (${b.assignedTo ? "by " + req.user.name : "automatic"})`, by: b.assignedTo ? req.user.name : "System" });
  const lead = await Lead.create({ key: phone, phone, name: b.name.trim(), email: b.email, city: b.city, profession: b.profession, level: b.level, workshop: S.cleanWorkshop(b.workshop), ts, assignedTo: owner, assignedBy: owner ? (b.assignedTo ? "manual" : "auto") : undefined, assignedAt: owner ? ts : undefined, locked: !!b.assignedTo, source: "manual", fus: S.planFor(ts, c), trail: story });
  await A.save();
  res.json(S.plain(lead));
}));

router.post("/leads/bulk-assign", adminOnly, wrap(async (req, res) => {
  const ids = (req.body?.ids || []).filter((i) => mongoose.isValidObjectId(i));
  if (!ids.length) throw fail("Select at least one lead");
  const to = String(req.body.assignedTo || "");
  await Lead.updateMany({ _id: { $in: ids } }, { $set: { assignedTo: to, locked: true, assignedBy: "manual", assignedAt: new Date() }, $push: { trail: S.trailOp("assign", to ? `Assigned to ${to} (by ${req.user.name})` : `Unassigned (by ${req.user.name})`, req.user.name) } });
  res.json({ ok: 1, count: ids.length });
}));

// attendance (everyone, on their own leads) + assignment (admin)
router.patch("/leads/:id", wrap(async (req, res) => {
  const l = await loadLead(req.params.id);
  if (!S.ownsLead(req.lu, l)) throw fail("Not your lead", 403);
  const b = req.body || {}, cfg = await S.getCfg();
  for (const d of [1, 2]) if ("day" + d in b) {
    const was = !!l["day" + d];
    l["day" + d] = !!b["day" + d];
    if (b["day" + d] && !l["d" + d + "Fus"].length) l["d" + d + "Fus"] = S.attFus(cfg);
    if (b["day" + d] && !was) { S.trail(l, "attendance", `Marked present on Day ${d}`, req.user.name); S.autoAssignDay(l, d, await S.assigner("d" + d, cfg)); }
    if (!b["day" + d] && was) S.trail(l, "attendance", `Day ${d} attendance removed`, req.user.name);
  }
  if (b.assignedTo !== undefined && req.lu.leadAdmin) {
    const to = String(b.assignedTo || "");
    if (to !== (l.assignedTo || "")) S.trail(l, "assign", to ? (l.assignedTo ? `Reassigned from ${l.assignedTo} to ${to}` : `Assigned to ${to}`) + ` (by ${req.user.name})` : `Unassigned (by ${req.user.name})`, req.user.name);
    l.assignedTo = to; l.locked = true; l.assignedBy = "manual"; l.assignedAt = new Date();
  }
  if (b.workshop !== undefined && req.lu.leadAdmin) {
    const w = S.cleanWorkshop(b.workshop);
    if (w !== (l.workshop || "")) { S.trail(l, "workshop", w ? `Workshop set to ${w} (by ${req.user.name})` : `Workshop cleared (by ${req.user.name})`, req.user.name); l.workshop = w; }
  }
  await l.save();
  S.bustProgress();
  res.json(S.plain(l));
}));

// update one follow-up: status, note, callback time (+ the automations)
router.patch("/leads/:id/fu/:n", wrap(async (req, res) => {
  const l = await loadLead(req.params.id);
  if (!S.ownsLead(req.lu, l)) throw fail("Not your lead", 403);
  const b = req.body || {}, set = ["d1Fus", "d2Fus"].includes(b.set) ? b.set : "fus", arr = l[set], n = +req.params.n, f = arr[n - 1];
  if (!f) throw fail("No such follow-up");
  const cfg = await S.getCfg();
  if (b.status && !cfg.statuses.includes(b.status)) throw fail("Unknown status");
  // Level / Profession / City captured by the caller -> saved on the lead and written back to the Google Sheet
  let detailsChanged = false;
  for (const k of ["level", "profession", "city"]) {
    if (typeof b[k] !== "string") continue;
    const v = b[k].trim().slice(0, 80);
    if (v !== (l[k] || "")) { l[k] = v; detailsChanged = true; }
  }
  if (detailsChanged) { l.sheetDirty = true; S.trail(l, "details", `Details updated: ${["level", "profession", "city"].map((k) => l[k] && `${k[0].toUpperCase() + k.slice(1)} ${l[k]}`).filter(Boolean).join(" · ")}`, req.user.name); }
  f.status = b.status || undefined;
  f.note = b.note || "";
  f.callbackAt = b.callbackAt ? new Date(b.callbackAt) : undefined;
  f.actual = b.status ? new Date() : undefined;
  const later = arr.slice(n), nx = arr[n];
  if (cfg.closeStatuses.includes(f.status)) later.forEach((x) => { if (!x.actual) x.skipped = true; }); // AUTO-CLOSE
  else {
    later.forEach((x) => { x.skipped = false; });
    if (cfg.retryStatuses.includes(f.status) && nx && !nx.actual) { // AUTO-RETRY
      const d = S.adj(new Date(Date.now() + cfg.retryHours * 36e5), cfg);
      if (d < nx.planned) nx.planned = d;
    }
  }
  l.markModified(set);
  await l.save();
  if (b.status) await S.logAct(l, n, f, req.user.email, set);
  S.bustProgress();
  res.json(S.plain(l));
  if (detailsChanged) S.pushSoon(); // write to the Google Sheet in the background — never slows the caller down
}));

// paste phone numbers and/or emails -> mark Day 1 / Day 2 attendees (+ their follow-ups)
router.post("/attendance", adminOnly, wrap(async (req, res) => {
  const d = +req.body?.day === 2 ? 2 : 1, cfg = await S.getCfg(), missing = [];
  const entries = [...(req.body?.entries || []), ...(req.body?.phones || [])].map((x) => String(x).trim()).filter(Boolean);
  let marked = 0;
  const seen = new Set(), A = await S.assigner("d" + d, cfg);
  for (const e of entries) {
    const n = e.replace(/\D/g, "").slice(-10);
    // an email is matched on the email; anything else on the phone number
    const l = S.isEmail(e) ? await S.byEmail(e) : n.length >= 10 ? await S.byPhone(n) : null;
    if (!l) { missing.push(e); continue; }
    if (seen.has(String(l._id))) continue; // the same person pasted by phone and by email
    seen.add(String(l._id));
    if (!l["day" + d]) S.trail(l, "attendance", `Marked present on Day ${d}`, req.user.name);
    l["day" + d] = true;
    if (!l["d" + d + "Fus"].length) l["d" + d + "Fus"] = S.attFus(cfg);
    S.autoAssignDay(l, d, A);
    await l.save();
    marked++;
  }
  await A.save();
  res.json({ marked, missing });
}));

// ---------- history ----------
router.get("/activity", wrap(async (req, res) =>
  res.json(await LeadActivity.find(req.lu.leadAdmin ? {} : { caller: S.nameRe(req.lu) }).sort({ at: -1 }).limit(500).lean())));

// ---------- admin: daily board, nightly history, reports ----------
router.get("/today", adminOnly, wrap(async (_req, res) => res.json(await S.board())));
router.post("/snapshot", adminOnly, wrap(async (_req, res) => { await S.snapshot(); res.json({ ok: 1 }); }));
router.get("/daily", adminOnly, wrap(async (req, res) =>
  res.json(await LeadSnapshot.find().sort({ date: -1 }).limit(Math.min(+req.query.days || 30, 366)).lean())));
router.get("/reports", wrap(async (req, res) => res.json(await S.reports(req.lu, +req.query.months || 0))));

// ---------- team (admin) ----------
const teamRow = (u) => ({
  _id: u._id, name: u.name, email: u.email, active: u.active !== false, role: u.role, leadName: S.leadCallerName(u),
});
const otherActiveAdmins = (id) => User.countDocuments({ _id: { $ne: id }, role: "admin", active: { $ne: false } });

router.get("/team", adminOnly, wrap(async (_req, res) => {
  res.json((await User.find().select("-passwordHash").sort({ name: 1 }).lean()).map(teamRow));
}));
// caller names that leads are assigned to but that nobody can sign in as yet
router.get("/team/missing", adminOnly, wrap(async (_req, res) => {
  const have = new Set((await User.find({ active: { $ne: false } }).lean()).map((u) => S.leadCallerName(u).toLowerCase()));
  const rows = await Lead.aggregate([{ $project: { n: ["$assignedTo", "$d1Assigned", "$d2Assigned"] } }, { $unwind: "$n" }, { $match: { n: { $nin: [null, ""] } } }, { $group: { _id: "$n", leads: { $sum: 1 } } }]);
  const by = new Map();
  for (const r of rows) { const k = String(r._id).trim().toLowerCase(); if (!k || have.has(k)) continue; const x = by.get(k) || { name: String(r._id).trim(), leads: 0 }; x.leads += r.leads; by.set(k, x); }
  res.json([...by.values()].sort((a, b) => b.leads - a.leads));
}));
router.get("/callers", adminOnly, wrap(async (_req, res) => res.json(await S.callerNames()))); // for the assign dropdowns

router.post("/team", adminOnly, wrap(async (req, res) => {
  const b = req.body || {}, email = String(b.email || "").toLowerCase().trim(), name = String(b.name || "").trim();
  if (!email || !name || !b.password) throw fail("Name, email and password are required");
  if (String(b.password).length < 8) throw fail("Password must be at least 8 characters");
  if (await User.findOne({ email })) throw fail("That email already has an account");
  const u = await User.create({
    name, email, passwordHash: await hashPassword(b.password),
    role: b.role === "admin" ? "admin" : "caller", leadName: String(b.leadName || "").trim(),
  });
  clearAuthCache();
  res.status(201).json(teamRow(u));
}));

router.put("/team/:id", adminOnly, wrap(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) throw fail("Person not found", 404);
  const b = req.body || {}, set = {};
  if (b.name !== undefined) { if (!String(b.name).trim()) throw fail("Name can't be empty"); set.name = String(b.name).trim(); }
  if (b.leadName !== undefined) set.leadName = String(b.leadName).trim();
  if (b.role !== undefined) set.role = b.role === "admin" ? "admin" : "caller";
  if (b.active !== undefined) set.active = !!b.active;
  if (u.role === "admin" && (set.role === "caller" || set.active === false) && !(await otherActiveAdmins(u._id)))
    throw fail("Can't remove the last active admin");
  if (b.password) {
    if (String(b.password).length < 8) throw fail("Password must be at least 8 characters");
    set.passwordHash = await hashPassword(b.password);
  }
  const out = await User.findByIdAndUpdate(u._id, set, { new: true }).select("-passwordHash").lean();
  clearAuthCache();
  res.json(teamRow(out));
}));

router.delete("/team/:id", adminOnly, wrap(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) throw fail("Person not found", 404);
  if (String(u._id) === String(req.user._id)) throw fail("You can't delete your own account");
  if (u.role === "admin" && !(await otherActiveAdmins(u._id))) throw fail("Can't delete the last admin");
  await User.findByIdAndDelete(u._id);
  clearAuthCache();
  res.json({ ok: 1 });
}));

export default router;
