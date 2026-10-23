import React, { useEffect, useState } from "react";
import PageHeader from "../../components/PageHeader.jsx";
import TableSkeleton from "../../components/TableSkeleton.jsx";
import { usePolling } from "../../hooks/usePolling.js";
import { api } from "../../api.js";
import { useLeads } from "../LeadsContext.jsx";
import { fmt, hm } from "../leadUtils.js";

// Every status update ever logged (latest 500 shown).
export default function Activity() {
  const { admin } = useLeads();
  const [r, setR] = useState(null);
  const load = () => api.ldActivity().then(setR).catch(() => setR((p) => p || []));
  useEffect(() => { load(); }, []);
  usePolling(load, 30000);
  return (
    <div className="page">
      <PageHeader title="Activity" subtitle="Every status update appears here with who made it and how late it was" meta={r && <span className="chip"><strong>{r.length}</strong> latest</span>} />
      <div className="table-wrap">
        <table className="table">
          <thead><tr>{["Time", "Lead", ...(admin ? ["Phone"] : []), "Caller", "Follow-up", "Status", "Note", "Delay"].map((x) => <th key={x}>{x}</th>)}</tr></thead>
          <tbody>
            {!r && <TableSkeleton columns={admin ? 8 : 7} rows={8} />}
            {r?.map((x) => (
              <tr key={x._id}>
                <td>{fmt(x.at)}</td><td><b>{x.name}</b></td>{admin && <td>{x.key}</td>}<td>{x.caller}</td>
                <td>{x.stage && x.stage !== "Lead" ? x.stage + " · " : ""}FU{x.step}</td>
                <td><span className="ld-pill ld-pill-done">{x.status}</span></td><td>{x.note}</td>
                <td className={x.delayMs ? "ld-bad" : ""}>{x.delayMs ? hm(x.delayMs) : "On time"}</td>
              </tr>
            ))}
            {r && !r.length && <tr><td colSpan={admin ? 8 : 7} className="empty-state">No activity yet — every status update appears here.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
