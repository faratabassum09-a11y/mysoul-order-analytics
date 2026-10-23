// One-time import of the data from the three Google-Sheet PDFs + the team logins.
//
//   npm run seed              load team + all leads (skips leads if already imported)
//   npm run seed -- --reset   delete the previously imported leads/history and load them again
//   npm run seed -- --dry     only read the files and print counts (no database needed)
//
// Safe to run more than once: existing logins are never changed, and leads that were not created by
// this import (e.g. from your live intake sheet) are never touched. Logins keep the passwords they
// had before (bcrypt hashes are carried over). Login = the person's email.
import "dotenv/config";
import fs from "fs";
import mongoose from "mongoose";
import User from "./models/User.js";
import { Lead, LeadActivity } from "./models/Lead.js";

const here = (f) => new URL("./data/" + f, import.meta.url);
const load = (f) => JSON.parse(fs.readFileSync(here(f), "utf8"));
const reset = process.argv.includes("--reset"), dry = process.argv.includes("--dry");
const D = (s) => (s ? new Date(s) : undefined);
const SETS = [["fus", "Lead", ""], ["d1Fus", "Day 1", "d1Assigned"], ["d2Fus", "Day 2", "d2Assigned"]];

const rows = load("leads.json"), people = load("users.json"), now = new Date();

// ---- build documents (pure, no database) ----
const leadDocs = [], actDocs = [];
for (const r of rows) {
  const doc = { ...r, ts: D(r.ts), createdAt: now, updatedAt: now };
  for (const [set, stage, who] of SETS) {
    doc[set] = (r[set] || []).map((f) => ({ ...f, planned: D(f.planned), actual: D(f.actual) }));
    doc[set].forEach((f, i) => {
      if (!f.actual || !f.status) return;
      actDocs.push({ key: r.key, name: r.name, caller: (who && r[who]) || r.assignedTo || "", step: i + 1, status: f.status, note: "", at: f.actual,
        delayMs: f.planned ? Math.max(0, f.actual - f.planned) : 0, stage, by: "sheet-import" });
    });
  }
  leadDocs.push(doc);
}
const count = (fn) => rows.filter(fn).length;
console.log(`Files: ${people.length} people, ${leadDocs.length} leads (${count((l) => l.day1)} Day 1 attendees, ${count((l) => l.day2)} Day 2 attendees), ${actDocs.length} call-history entries`);
if (dry) process.exit(0);

// ---- load into MongoDB ----
await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/lead_fms", { serverSelectionTimeoutMS: 10_000 });
const chunks = (a, n = 500) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

let added = 0, kept = 0;
for (const p of people) {
  const email = (p.email || p.username).toLowerCase().trim();
  if (await User.findOne({ email })) { kept++; continue; }
  await User.create({ name: p.fullName || p.name || email, email, passwordHash: p.hash, role: p.role === "admin" ? "admin" : "caller", leadName: p.name });
  added++;
}
console.log(`People: ${added} added, ${kept} already existed (left unchanged)`);

const leads = Lead.collection, acts = LeadActivity.collection;
const already = await leads.countDocuments({ source: "sheet-import" });
if (already && !reset) {
  console.log(`Leads: ${already} imported leads already in the database - nothing changed. Use "npm run seed -- --reset" to import them again.`);
} else {
  if (reset) { await leads.deleteMany({ source: "sheet-import" }); await acts.deleteMany({ by: "sheet-import" }); }
  let ok = 0, skipped = 0;
  for (const c of chunks(leadDocs)) {
    try { ok += (await leads.insertMany(c, { ordered: false })).insertedCount; }
    catch (e) { ok += e.result?.insertedCount ?? 0; skipped += c.length - (e.result?.insertedCount ?? 0); } // phone already used by a live lead
  }
  for (const c of chunks(actDocs)) await acts.insertMany(c);
  console.log(`Leads: ${ok} imported${skipped ? `, ${skipped} skipped (phone already in your live data)` : ""}; ${actDocs.length} call-history entries added`);
}
await mongoose.disconnect();
console.log("Done.");
