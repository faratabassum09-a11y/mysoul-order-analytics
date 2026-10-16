import React from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api.js';
import { useFilters } from '../filters.jsx';
import { duration } from '../flowUi.js';
import { int, pct } from '../format.js';

const ratio = (r) => (r && r.d ? `${int(r.n)} of ${int(r.d)}` : 'No data yet');

function Tile({ label, value, sub, tone, hint }) {
  return (
    <div className="card kpi" title={hint}>
      <div className="label"><span>{label}</span></div>
      <div className={`big ${tone || ''}`}>{value}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

// Fed by what the team does in the Confirm queue and Dispatch desk. Nothing to enter here.
export default function TeamPerformance() {
  const f = useFilters();
  const { data, error } = useApi('/flow/overview', f.params, f.ready);
  if (error || !data) return null;
  const { sla, confirmation, packing, proofCoverage, openWork } = data;
  const good = (r) => (r && r.v != null ? (r.v >= 90 ? 'good-text' : r.v >= 70 ? '' : 'bad-text') : '');
  return (
    <div className="section">
      <h2 className="sect" style={{ marginTop: 0 }}>Team performance</h2>
      <p className="cap">Counted by order date, from what the team did in the <Link to="/confirm-queue">Confirm queue</Link> and <Link to="/dispatch-desk">Dispatch desk</Link>. Orders handled only in the sheet are not included.</p>
      {data.tracked === 0 ? (
        <div className="card muted">No team activity in this window yet. This fills in by itself as the team confirms and packs orders.</div>
      ) : (
        <>
          <div className="grid">
            <Tile label="Confirmed within 2 hours" value={pct(sla.confirm.within2h.v)} sub={ratio(sla.confirm.within2h)} tone={good(sla.confirm.within2h)} hint="Share of decided orders (confirmed, partial pay or cancelled) where the decision came within 2 hours of the order" />
            <Tile label="Decided within 4 hours" value={pct(sla.confirm.within4h.v)} sub={ratio(sla.confirm.within4h)} tone={good(sla.confirm.within4h)} hint="Same, with the 4 hour limit" />
            <Tile label="Dispatched within the 24 h plan" value={pct(sla.dispatch.onTime.v)} sub={ratio(sla.dispatch.onTime)} tone={good(sla.dispatch.onTime)} hint="Dispatched within 24 hours of confirmation" />
            <Tile label="Dispatched with proof photo" value={pct(proofCoverage.v)} sub={ratio(proofCoverage)} tone={good(proofCoverage)} hint="Packed orders always carry a photo; this should stay at 100%" />
            <Tile label="Open right now" value={`${int(openWork.queue.total)} to confirm`} sub={`${int(openWork.queue.red)} overdue · ${int(openWork.desk.delayed)} delayed in dispatch`} tone={openWork.queue.red || openWork.desk.delayed ? 'bad-text' : ''} hint="Live counts, not limited to the window" />
          </div>
          <div className="two" style={{ marginTop: 14 }}>
            <div>
              <h2>Confirmation team</h2>
              {confirmation.length === 0 ? <div className="card muted">No confirmations yet.</div> : (
                <div className="tablewrap"><table>
                  <thead><tr><th>Person</th><th className="num">Decisions</th><th className="num">Confirmed</th><th className="num">Partial</th><th className="num">Cancelled</th><th className="num">No answer</th><th className="num">Within 2 h</th><th className="num">Avg time</th></tr></thead>
                  <tbody>{confirmation.map((p) => (
                    <tr key={p.id}><td><b>{p.name}</b></td><td className="num">{int(p.decisions)}</td><td className="num">{int(p.confirmed)}</td><td className="num">{int(p.partial)}</td><td className="num">{int(p.cancelled)}</td><td className="num">{int(p.noAnswer)}</td>
                      <td className="num" title={ratio(p.slaPct)}>{pct(p.slaPct.v, 0)}</td><td className="num">{p.avgMs == null ? '—' : duration(p.avgMs)}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
            </div>
            <div>
              <h2>Packing team</h2>
              {packing.length === 0 ? <div className="card muted">No packed orders yet.</div> : (
                <div className="tablewrap"><table>
                  <thead><tr><th>Person</th><th className="num">Packed</th><th className="num">Within 24 h</th><th className="num">With photo</th></tr></thead>
                  <tbody>{packing.map((p) => (
                    <tr key={p.id}><td><b>{p.name}</b></td><td className="num">{int(p.packed)}</td><td className="num" title={ratio(p.onTimePct)}>{pct(p.onTimePct.v, 0)}</td><td className="num">{int(p.withProof)} of {int(p.packed)}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
