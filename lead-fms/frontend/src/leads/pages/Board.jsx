import React, { useEffect, useState } from "react";
import PageHeader from "../../components/PageHeader.jsx";
import PageLoader from "../../components/PageLoader.jsx";
import { usePolling } from "../../hooks/usePolling.js";
import { api } from "../../api.js";
import { useLeads } from "../LeadsContext.jsx";
import { Stats, Panel, Empty } from "../ui.jsx";

// Admin landing page: who is working on what today, escalations, and the nightly history.
export default function Board() {
  const { toast } = useLeads();
  const [d, setD] = useState(null), [h, setH] = useState([]);
  const load = () => { api.ldToday().then(setD).catch((e) => toast(e.message, "bad")); api.ldDaily(14).then(setH).catch(() => {}); };
  useEffect(load, []);
  usePolling(load, 60000);
  if (!d) return <PageLoader />;
  const T = (k, rows = d.rows) => rows.reduce((s, r) => s + r[k], 0);
  return (
    <div className="page">
      <PageHeader title="Daily Board" subtitle="Live per-caller work for today, escalations, and the saved daily history" />
      <Stats items={[["New leads today", d.newToday, "accent"], ["Unassigned", d.unassigned, d.unassigned ? "neutral" : ""], ["Tasks due today", T("due")], ["Done today", T("done"), "good"], ["Overdue", T("overdue"), T("overdue") ? "bad" : ""], ["Escalated", T("escalated"), T("escalated") ? "bad" : ""]]} />

      <div className="ld-grid2">
        <Panel title="Today — who is working on what">
          <div className="table-wrap ld-flush"><table className="table">
            <thead><tr><th>Caller</th><th>Leads</th><th>Due</th><th>Done today</th><th>Overdue</th><th>Callbacks</th><th>Progress</th></tr></thead>
            <tbody>
              {d.rows.sort((a, b) => b.overdue - a.overdue).map((r) => {
                const p = r.done + r.due ? Math.round((r.done / (r.done + r.due)) * 100) : 100;
                return (
                  <tr key={r.caller}>
                    <td><b>{r.caller}</b></td><td>{r.leads}</td><td>{r.due}</td><td>{r.done}</td>
                    <td className={r.overdue ? "ld-bad" : ""}>{r.overdue}</td><td>{r.callbacks}</td>
                    <td><div className="ld-track ld-track-sm"><i className="ld-fill-good" style={{ width: p + "%" }} /></div> <span className="ld-small">{p}%</span></td>
                  </tr>
                );
              })}
              {!d.rows.length && <tr><td colSpan={7} className="empty-state">No leads yet — import the intake sheet or add one.</td></tr>}
            </tbody>
          </table></div>
        </Panel>
        <Panel title="🚨 Escalations (overdue too long)">
          {d.escalations.length ? (
            <table className="table"><tbody>
              {d.escalations.map((e, i) => <tr key={i}><td><b>{e.name}</b><div className="ld-small">{e.phone}</div></td><td>{e.caller}</td><td>FU{e.step}</td><td><span className="ld-pill ld-pill-over">{e.hours}h late</span></td></tr>)}
            </tbody></table>
          ) : <Empty>Nothing escalated 👍</Empty>}
        </Panel>
      </div>

      <Panel title="🗂 Daily history" actions={<button type="button" className="ld-btn" onClick={async () => { await api.ldSnapshot(); load(); toast("Saved today's snapshot", "good"); }}>Save today now</button>}>
        <p className="ld-small" style={{ margin: "0 0 10px" }}>Saved automatically every night and kept forever.</p>
        {h.length ? (
          <div className="table-wrap ld-flush"><table className="table">
            <thead><tr><th>Date</th><th>New leads</th><th>Calls done</th><th>Overdue</th><th>Escalated</th></tr></thead>
            <tbody>{h.map((x) => <tr key={x.date}><td>{x.date}</td><td>{x.data.newToday}</td><td>{T("done", x.data.rows)}</td><td>{T("overdue", x.data.rows)}</td><td>{T("escalated", x.data.rows)}</td></tr>)}</tbody>
          </table></div>
        ) : <Empty>History starts after the first nightly save (or press “Save today now”).</Empty>}
      </Panel>
    </div>
  );
}
