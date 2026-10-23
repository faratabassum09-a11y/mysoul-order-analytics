import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { delay, fmt, hm, planLen, stepName, wa, waText } from "./leadUtils.js";

const when = (d) => new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).replace(/\bam\b/, "am").replace(/\bpm\b/, "pm");
const HOW = { auto: "automatic", sheet: "from the sheet", manual: "by an admin" };

// Side drawer opened by clicking a lead's name: where the lead stands, who has it (and how it got to them),
// and everything that ever happened — so a lead can be traced from the sheet to the last call.
export default function LeadDrawer({ lead: l, cfg, admin, callers, now, workshops, onClose, onUpdate, onCall }) {
  const [hist, setHist] = useState(null), [ws, setWs] = useState(l.workshop || "");
  useEffect(() => { const k = (e) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  // reload the story whenever a call is saved on this lead
  const sig = JSON.stringify([l.fus, l.d1Fus, l.d2Fus].map((a) => (a || []).map((f) => f.actual || "")));
  useEffect(() => { let live = true; api.ldHistory(l._id).then((h) => live && setHist(h)).catch(() => live && setHist({ trail: [], calls: [] })); return () => { live = false; }; }, [l._id, sig, l.assignedTo, l.workshop]);
  useEffect(() => setWs(l.workshop || ""), [l.workshop]);

  const fus = (l.fus || []).slice(0, planLen(cfg, "fus"));
  const cur = fus.findIndex((f) => !f.actual && !f.skipped);
  const stepState = (f, i) => (f.skipped ? "skip" : f.actual ? "done" : i === cur ? "cur" : "wait");
  const steps = [...fus.map((f, i) => ({ label: "FU" + (i + 1), s: stepState(f, i), tip: f.status || (f.skipped ? "Auto-closed" : f.planned ? "Planned " + fmt(f.planned) : "") })),
    { label: "Day 1", s: l.day1 ? "done" : "wait", tip: l.day1 ? "Attended" : "Not marked" }, { label: "Day 2", s: l.day2 ? "done" : "wait", tip: l.day2 ? "Attended" : "Not marked" }];
  // the next call to make: the first open step of the lead's own calls, else of the Day 1 / Day 2 calls
  const next = (() => {
    if (cur >= 0) return { set: "fus", i: cur, f: fus[cur] };
    for (const set of ["d1Fus", "d2Fus"]) { const a = (l[set] || []).slice(0, planLen(cfg, set)), i = a.findIndex((f) => !f.actual && !f.skipped); if (i >= 0) return { set, i, f: a[i] }; }
    return null;
  })();
  const stage = next ? `${next.set === "d1Fus" ? "Day 1 · " : next.set === "d2Fus" ? "Day 2 · " : ""}${stepName(next.i)}` : "All calls done";
  const state = next ? (new Date(next.f.planned) < now ? "over" : "wait") : "done";

  // one timeline: the lead's own trail + every call ever logged
  const items = [
    ...(hist?.trail || []).map((t) => ({ at: t.at, title: t.text, sub: t.by || "System", type: t.type })),
    ...(hist?.calls || []).map((c) => ({
      at: c.at, type: "call",
      title: `${c.stage && c.stage !== "Lead" ? c.stage + " · " : ""}FU${c.step} — ${c.status || "updated"}`,
      note: c.note, sub: `${c.caller || ""}${c.delayMs ? " · " + hm(c.delayMs) + " late" : " · on time"}`,
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
  if (hist && !items.some((x) => x.type === "entered") && l.ts) items.push({ at: l.ts, title: "Lead came in", sub: l.source === "manual" ? "Added by an admin" : "Google Sheet", type: "entered" });

  const row = (k, v) => v ? <div className="ld-dl-row"><span>{k}</span><b>{v}</b></div> : null;
  const owner = l.assignedTo || "Unassigned";
  return (
    <>
      <div className="ld-scrim" onClick={onClose} />
      <aside className="ld-drawer" role="dialog" aria-label={"History of " + l.name}>
        <div className="ld-dr-head">
          <div><h3>{l.name}</h3>
            <div className="ld-tags"><span className={"ld-pill ld-pill-" + state}>{stage}</span>{l.workshop && <span className="ld-ws">{l.workshop}</span>}</div></div>
          <button type="button" className="ld-btn" onClick={onClose}>Close</button>
        </div>

        <div className="ld-stepper" aria-label="Progress">
          {steps.map((s, i) => (
            <div key={i} className={"ld-step ld-step-" + s.s} title={s.tip}><i /><span>{s.label}</span></div>
          ))}
        </div>
        <p className="ld-small ld-dr-meta">Came in {l.ts ? when(l.ts) : "—"}{l.source === "manual" ? " · added manually" : " · Google Sheet"}</p>
        <div className="ld-assigned">
          <span className="ld-who-tag"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" /></svg>Assigned to <b>{owner}</b>{l.assignedBy && HOW[l.assignedBy] ? <em> ({HOW[l.assignedBy]})</em> : null}</span>
          {(l.d1Assigned || l.d2Assigned) && <span className="ld-small">{l.d1Assigned && `Day 1 calls: ${l.d1Assigned}`}{l.d1Assigned && l.d2Assigned ? " · " : ""}{l.d2Assigned && `Day 2 calls: ${l.d2Assigned}`}</span>}
          {admin && (
            <select className="ld-select" value={l.assignedTo || ""} onChange={(e) => onUpdate({ assignedTo: e.target.value })} aria-label="Assign to">
              <option value="">Unassigned</option>{callers.map((c) => <option key={c}>{c}</option>)}
            </select>
          )}
        </div>

        <div className="ld-actions" style={{ margin: "12px 0" }}>
          <a className="ld-btn ld-btn-solid" href={"tel:" + l.phone}>Call</a>
          <a className="ld-btn ld-btn-wa" href={wa(l.phone, waText(l, cfg))} target="_blank" rel="noreferrer">WhatsApp</a>
          {next && <button type="button" className="ld-btn" onClick={() => onCall(next.set, next.i + 1)}>Update status</button>}
        </div>

        <div className="ld-dr-sec">Lead</div>
        <div className="ld-dl">
          {row("Name", l.name)}{admin && row("Phone", l.phone)}{admin && row("Email", l.email)}
          {row("City", l.city)}{row("Profession", l.profession)}{row("Level", l.level)}{row("UTW date", l.utwDate)}
        </div>

        <div className="ld-dr-sec">Workshop</div>
        {admin ? (
          <div className="ld-actions">
            <input className="ld-input" style={{ maxWidth: 260 }} list="ld-ws-list" value={ws} onChange={(e) => setWs(e.target.value)} placeholder="Workshop name" />
            <datalist id="ld-ws-list">{workshops.map((w) => <option key={w.name} value={w.name} />)}</datalist>
            <button type="button" className="ld-btn" disabled={ws.trim() === (l.workshop || "")} onClick={() => onUpdate({ workshop: ws })}>Save</button>
          </div>
        ) : <div className="ld-dl">{row("Workshop", l.workshop) || <span className="ld-small">Not set</span>}</div>}

        <div className="ld-dr-sec">History</div>
        <div className="ld-timeline">
          {!hist && <div className="ld-small">Loading…</div>}
          {items.map((x, i) => (
            <div key={i} className={"ld-tl ld-tl-" + x.type}>
              <i />
              <div><b>{x.title}</b>{x.note && <div className="ld-tl-note">“{x.note}”</div>}<div className="ld-small">{x.sub} · {when(x.at)}</div></div>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
