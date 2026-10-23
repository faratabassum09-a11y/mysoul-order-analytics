import React, { useEffect, useState } from "react";
import PageHeader from "../../components/PageHeader.jsx";
import PageLoader from "../../components/PageLoader.jsx";
import { api } from "../../api.js";
import { useLeads } from "../LeadsContext.jsx";
import { downloadCsv, pc } from "../leadUtils.js";
import { Stats, Bar, Panel, Empty } from "../ui.jsx";

const lab = (k) => new Date(k + "-01").toLocaleDateString("en-IN", { month: "short", year: "2-digit" });

// Business status over time: this month / 3 / 6 / 12 months / all time.
export default function Reports() {
  const { admin, toast } = useLeads();
  const [m, setM] = useState(6), [r, setR] = useState(null);
  useEffect(() => { setR(null); api.ldReports(m).then(setR).catch((e) => toast(e.message, "bad")); }, [m]);
  const S = (k) => (r ? r.months.reduce((s, x) => s + x[k], 0) : 0);
  const mx = r ? Math.max(1, ...r.months.map((x) => x.leads)) : 1;
  const tot = r ? Object.values(r.outcomes).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className="page">
      <PageHeader title={admin ? "Reports" : "My Reports"} subtitle="Every lead, call and note is stored permanently — look back as far as you like"
        meta={r && <button type="button" className="ld-btn" onClick={() => downloadCsv("lead-report.csv", [["Month", "Leads", "Contacted", "Connected", "Day1", "Day2", "Calls"], ...r.months.map((x) => [x.month, x.leads, x.contacted, x.connected, x.day1, x.day2, x.calls]), [], ["Workshop", "Leads", "Contacted", "Connected", "Day1", "Day2", "Calls"], ...(r.workshops || []).map((x) => [x.workshop, x.leads, x.contacted, x.connected, x.day1, x.day2, x.calls])])}>⬇ Export CSV</button>} />
      <div className="range-pills" role="tablist" aria-label="Report period">
        {[[1, "This month"], [3, "Last 3 months"], [6, "Last 6 months"], [12, "Last 12 months"], [0, "All time"]].map(([v, t]) => (
          <button key={v} type="button" role="tab" aria-selected={m === v} className={"range-pill" + (m === v ? " range-pill-active" : "")} onClick={() => setM(v)}>{t}</button>
        ))}
      </div>
      {!r ? <PageLoader /> : (
        <>
          <Stats items={[["Leads", S("leads"), "accent"], ["Calls logged", S("calls")], ["Connected", S("connected"), "good"], ["Connect rate", pc(S("connected"), S("leads"))], ["Day 1 attended", S("day1")], ["Day 2 attended", S("day2")]]} />
          <div className="ld-grid2">
            <Panel title="Month by month — leads vs connected">
              {r.months.length ? (
                <>
                  <div className="ld-trend">
                    {r.months.map((x) => (
                      <div key={x.month}><b>{x.leads}</b>
                        <span className="ld-mb"><i style={{ height: 8 + (x.leads / mx) * 90 }} /><i className="ld-fill-good" style={{ height: 8 + (x.connected / mx) * 90 }} /></span>
                        <small>{lab(x.month)}</small></div>
                    ))}
                  </div>
                  <div className="ld-legend"><span><i className="ld-dot" /> leads</span><span><i className="ld-dot ld-dot-good" /> connected</span></div>
                </>
              ) : <Empty>No leads in this period.</Empty>}
            </Panel>
            <Panel title="Call outcomes">
              {Object.entries(r.outcomes).sort((a, b) => b[1] - a[1]).map(([k, v]) => <Bar key={k} label={k} v={v} max={tot} tone="good" extra={` (${pc(v, tot)})`} />)}
              {!tot && <Empty>No calls logged in this period.</Empty>}
            </Panel>
          </div>
          <Panel title="Monthly status">
            <div className="table-wrap ld-flush"><table className="table">
              <thead><tr><th>Month</th><th>Leads</th><th>Contacted</th><th>Connected</th><th>Connect %</th><th>Day 1</th><th>Day 2</th><th>Calls</th></tr></thead>
              <tbody>{r.months.map((x) => <tr key={x.month}><td><b>{lab(x.month)}</b></td><td>{x.leads}</td><td>{x.contacted}</td><td>{x.connected}</td><td>{pc(x.connected, x.leads)}</td><td>{x.day1}</td><td>{x.day2}</td><td>{x.calls}</td></tr>)}</tbody>
            </table></div>
          </Panel>
          {r.workshops?.some((x) => x.workshop !== "No workshop") && (
            <Panel title="By workshop">
              <div className="table-wrap ld-flush"><table className="table">
                <thead><tr><th>Workshop</th><th>Leads</th><th>Calls</th><th>Contacted</th><th>Connected</th><th>Connect %</th><th>Day 1</th><th>Day 2</th></tr></thead>
                <tbody>{r.workshops.map((x) => <tr key={x.workshop}><td><b>{x.workshop}</b></td><td>{x.leads}</td><td>{x.calls}</td><td>{x.contacted}</td><td>{x.connected}</td><td>{pc(x.connected, x.leads)}</td><td>{x.day1}</td><td>{x.day2}</td></tr>)}</tbody>
              </table></div>
            </Panel>
          )}
          <Panel title="By caller">
            <div className="table-wrap ld-flush"><table className="table">
              <thead><tr><th>Caller</th><th>Leads</th><th>Calls</th><th>Connected</th><th>Connect %</th><th>Day 1</th><th>Day 2</th></tr></thead>
              <tbody>{r.callers.map((x) => <tr key={x.caller}><td><b>{x.caller}</b></td><td>{x.leads}</td><td>{x.calls}</td><td>{x.connected}</td><td>{pc(x.connected, x.leads)}</td><td>{x.day1}</td><td>{x.day2}</td></tr>)}</tbody>
            </table></div>
          </Panel>
        </>
      )}
    </div>
  );
}
