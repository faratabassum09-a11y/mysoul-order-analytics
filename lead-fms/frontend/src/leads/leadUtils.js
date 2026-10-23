// Shared helpers for the Lead FMS app (formatting, follow-up state, task lists, CSV).

export const fmt = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

// "3h 20m" / "2d 4h"
export const hm = (ms) => {
  const h = Math.floor(ms / 36e5);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${Math.floor((ms % 36e5) / 6e4)}m`;
};

// how late a follow-up is (still running if not done yet)
export const delay = (f, now) => {
  if (f.skipped) return "";
  const ms = (f.actual ? new Date(f.actual) : now) - new Date(f.planned);
  return ms > 0 ? hm(ms) : "";
};

// skip = auto-closed, done, over = overdue, wait = upcoming
export const state = (f, now) => (f.skipped ? "skip" : f.actual ? "done" : new Date(f.planned) < now ? "over" : "wait");
export const LBL = { skip: "Auto-closed", done: "Done", over: "Overdue", wait: "Upcoming" };

// the three follow-up tracks every lead can have
export const SETS = [["fus", "FU"], ["d1Fus", "D1·FU"], ["d2Fus", "D2·FU"]];

// who owns a follow-up: Day 1 / Day 2 can have their own caller, otherwise the lead's caller
export const stageWho = (l, set) =>
  ((set === "d1Fus" ? l.d1Assigned : set === "d2Fus" ? l.d2Assigned : "") || l.assignedTo || "").toLowerCase();

// every follow-up that is actionable right now (not done, not closed, previous one done)
// (steps beyond what Settings declares — e.g. an old FU4 — are never actionable)
export const planLen = (cfg, set) => (set === "fus" ? cfg?.plan : cfg?.attPlan)?.length ?? Infinity;
export const tasksOf = (leads, who, cfg) =>
  leads
    .flatMap((l) => SETS.flatMap(([set, lb]) => (l[set] || []).slice(0, planLen(cfg, set)).map((f, i) => ({ l, f, i, set, lb }))))
    .filter((t) => t.f.planned && !t.f.actual && !t.f.skipped && (t.i === 0 || t.l[t.set][t.i - 1].actual) && (!who || stageWho(t.l, t.set) === who.toLowerCase()));

// the person a follow-up belongs to, as they are spelled on the lead ("Unassigned" when nobody has it yet)
export const ownerOf = (l, set) => (set === "d1Fus" ? l.d1Assigned : set === "d2Fus" ? l.d2Assigned : "") || l.assignedTo || "Unassigned";
// "just now" / "5 min ago" / "2 h ago"
export const ago = (d, now = new Date()) => {
  if (!d) return "";
  const m = Math.max(0, Math.round((now - new Date(d)) / 6e4));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : fmt(d);
};
export const NO_WS = "__none"; // the "no workshop" filter

// whole calendar days between a planned time and today (1 = yesterday) — "how long has this been waiting"
export const daysAgo = (planned, today = new Date()) => {
  const a = new Date(today), p = new Date(planned);
  a.setHours(0, 0, 0, 0); p.setHours(0, 0, 0, 0);
  return Math.round((a - p) / 864e5);
};
// Delayed Follow-ups are triaged by how long they have waited; Today Follow-ups by "due now" vs "later today"
export const DELAY_BUCKETS = [["1", "Yesterday", (d) => d <= 1], ["2-3", "2–3 days", (d) => d >= 2 && d <= 3], ["4-7", "4–7 days", (d) => d >= 4 && d <= 7], ["8+", "Over a week", (d) => d >= 8]];
export const TODAY_BUCKETS = [["now", "Due now"], ["later", "Later today"]];
export const bucketOf = (t, now, delayed) => (delayed ? (DELAY_BUCKETS.find(([, , fn]) => fn(daysAgo(t.f.planned, now))) || DELAY_BUCKETS[3])[0] : new Date(t.f.planned) <= now ? "now" : "later");
export const shortDate = (d) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export const wa = (p, t = "") => "https://wa.me/" + (p.length === 10 ? "91" + p : p) + (t ? "?text=" + encodeURIComponent(t) : "");
export const waText = (l, cfg) => (cfg?.waTemplate || "").replace("{name}", l.name || "").replace("{caller}", l.assignedTo || "");

export const pc = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
export const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };
// "Today Follow-ups": planned for today (any follow-up step). Planned before today -> "Delayed Follow-ups".
export const isDueToday = (t) => {
  const a = new Date(); a.setHours(0, 0, 0, 0);
  return new Date(t.f.planned) >= a;
};

// Follow-up steps are configured in Settings (up to 10). These helpers keep every page in step with that plan.
export const MAX_FU = 10;
const ORD = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];
export const stepName = (i) => (ORD[i] || `Call ${i + 1}`) + " call";
// how many FU columns to show: exactly what Settings declares (add one there -> a new column appears everywhere)
export const fuCount = (cfg, leads = [], set = "fus", plan = set === "fus" ? cfg?.plan : cfg?.attPlan) =>
  Math.min(MAX_FU, plan?.length || 0);
// FU1 / FU2 / ... columns for the lead-qualification calls; Day 1 / Day 2 attendee calls get their own block
export const fuCols = (cfg, leads) => Array.from({ length: fuCount(cfg, leads) }, (_, i) => ["fus", i, "FU" + (i + 1), stepName(i)]);
export const ATT_COLS = [["d1Fus", "Day 1 attendees"], ["d2Fus", "Day 2 attendees"]];

export function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
