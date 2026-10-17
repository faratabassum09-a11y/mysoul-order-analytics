import React from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApi } from '../../api.js';
import { DeltaChip, FilterBar, Loading } from '../../components.jsx';
import { useAutoRefresh } from '../../flowUi.js';
import { useFilters } from '../../filters.jsx';
import { inr, int, pct } from '../../format.js';

const STAGES = [['confirm', 'In confirm queue', '#2a7f8e'], ['pending', 'In pending', '#6a55b3'], ['dispatch', 'To dispatch', '#1c7c6c'], ['dispatched', 'Dispatched', '#3b4a96'], ['cancelled', 'Cancelled', '#b3261e'], ['none', 'Not in queue', '#a9b0ba']];
const hrs = (h) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`);

function Kpi({ label, value, sub, chip, tone }) {
  return <div className={`sd-kpi ${tone || ''}`}><div className="l"><span>{label}</span>{chip}</div><b>{value}</b>{sub && <small>{sub}</small>}</div>;
}

export default function DeskOverview() {
  const f = useFilters();
  const { data, error, loading, reload } = useApi('/desk/overview', f.params, f.ready);
  useAutoRefresh(reload, 60);
  const s = data && data.stats; const p = data && data.prev;
  const total = s ? s.totalOrders : 0;
  return (
    <>
      <FilterBar range={data && data.range} />
      <div className="sd-body">
        <Loading error={error} loading={(loading && !data) || !f.ready}>
          {data && (
            <>
              <div className="sd-now">
                <div className={s.dueNow ? 'hot' : ''}><b>{int(s.dueNow)}</b><span>calls due now</span></div>
                <div className={s.overdue ? 'bad' : ''}><b>{int(s.overdue)}</b><span>overdue by more than 2 h</span></div>
                <div><b>{int(s.stageCount.confirm)}</b><span>in confirm queue</span></div>
                <div><b>{int(s.stageCount.pending)}</b><span>in pending</span></div>
                <div><b>{int(s.stageCount.dispatch)}</b><span>waiting to dispatch</span></div>
              </div>

              <div className="sd-kpis">
                <Kpi label="Orders" value={int(s.totalOrders)} sub={`Value ${inr(s.money.all)}`} chip={p && <DeltaChip type="count" cur={s.totalOrders} prev={p.totalOrders} up="good" />} />
                <Kpi label="Confirmed" value={pct(s.confirmRate)} sub={`${int(s.stageCount.dispatch + s.stageCount.dispatched)} of ${int(total)} · ${inr(s.money.confirmed)}`} tone="good" chip={p && <DeltaChip type="pct" cur={{ v: s.confirmRate }} prev={{ v: p.confirmRate }} up="good" />} />
                <Kpi label="Cancelled" value={pct(s.cancelRate)} sub={`${int(s.stageCount.cancelled)} orders · ${inr(s.money.cancelled)} lost`} tone="bad" chip={p && <DeltaChip type="pct" cur={{ v: s.cancelRate }} prev={{ v: p.cancelRate }} up="bad" />} />
                <Kpi label="Still open" value={int(s.stageCount.confirm + s.stageCount.pending)} sub={`${inr(s.money.open)} waiting on a call`} tone="warn" />
                <Kpi label="Time to first decision" value={hrs(s.avgDecisionHours)} sub="From order placed to confirmed, partial or cancelled" />
                <Kpi label="Partial payments" value={int(s.partialCount)} sub={`${inr(s.money.collected)} received · ${inr(s.money.balance)} to collect`} tone="violet" />
              </div>

              <h2 className="sd-h2">Where every order is now</h2>
              <div className="sd-stack" role="img" aria-label="Orders by status">
                {STAGES.map(([k, l, c]) => (s.stageCount[k] ? <i key={k} style={{ width: `${(s.stageCount[k] / Math.max(1, total)) * 100}%`, background: c }} title={`${l}: ${s.stageCount[k]}`} /> : null))}
              </div>
              <div className="sd-legend">{STAGES.map(([k, l, c]) => <span key={k}><i style={{ background: c }} />{l} <b>{int(s.stageCount[k])}</b></span>)}</div>

              <h2 className="sd-h2">Orders per day</h2>
              <div className="card chart"><ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.daily} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#e4e7e1" />
                  <XAxis dataKey="date" tickFormatter={(d) => d.slice(5)} fontSize={12} tickLine={false} axisLine={false} minTickGap={16} />
                  <YAxis allowDecimals={false} fontSize={12} tickLine={false} axisLine={false} width={36} />
                  <Tooltip cursor={{ fill: 'rgba(0,0,0,.04)' }} formatter={(v, n) => [v, n]} labelFormatter={(d) => d} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="confirmed" name="Confirmed" stackId="a" fill="#1c7c6c" />
                  <Bar dataKey="open" name="Open" stackId="a" fill="#c28a1d" />
                  <Bar dataKey="cancelled" name="Cancelled" stackId="a" fill="#b3261e" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer></div>

              <h2 className="sd-h2">How each follow-up performs</h2>
              <p className="cap">What happened on each call attempt. The first calls win most orders; the later ones show how much effort the stubborn orders take.</p>
              <div className="tablewrap"><table className="sd-table">
                <thead><tr><th>Follow-up</th><th className="num">Confirmed</th><th className="num">Partial paid</th><th className="num">Cancelled</th><th className="num">Did not pick up</th><th className="num">WhatsApp shared</th></tr></thead>
                <tbody>{s.byFu.map((r) => {
                  const dn = r.whatsappYes + r.whatsappNo;
                  return <tr key={r.fu}><td><b>{r.fu}</b></td><td className="num">{int(r.confirmed)}</td><td className="num">{int(r.partial)}</td><td className="num">{int(r.cancelled)}</td><td className="num">{int(r.dnp)}</td><td className="num">{dn ? `${int(r.whatsappYes)} of ${int(dn)} (${Math.round((r.whatsappYes / dn) * 100)}%)` : '—'}</td></tr>;
                })}</tbody>
              </table></div>

              <div className="two" style={{ marginTop: 22 }}>
                <div>
                  <h2 className="sd-h2" style={{ marginTop: 0 }}>Why orders get cancelled</h2>
                  <div className="card">
                    {s.reasons.length === 0 ? <p className="muted" style={{ margin: 0 }}>No cancellations in this window.</p> : s.reasons.map((r) => (
                      <div key={r.reason} className="sd-reason"><div className="top"><span>{r.reason}</span><b>{r.count}<small> · {inr(r.value)}</small></b></div><div className="bar"><i style={{ width: `${(r.count / s.reasons[0].count) * 100}%` }} /></div></div>
                    ))}
                    {s.reasons.length > 0 && <p className="cap" style={{ margin: '10px 0 0' }}>{int(s.autoCancelled)} auto-cancelled · {int(s.manualCancelled)} cancelled by the team</p>}
                  </div>
                </div>
                <div>
                  <h2 className="sd-h2" style={{ marginTop: 0 }}>Team activity</h2>
                  <div className="tablewrap"><table className="sd-table">
                    <thead><tr><th>Person</th><th className="num">Calls logged</th><th className="num">Confirmed</th><th className="num">DNP</th><th className="num">Cancelled</th><th className="num">Dispatched</th></tr></thead>
                    <tbody>{s.agents.length === 0 ? <tr><td colSpan={6} className="muted">No team actions in this window yet.</td></tr> : s.agents.map((a) => <tr key={a.name}><td><b>{a.name}</b></td><td className="num">{int(a.calls)}</td><td className="num">{int(a.confirmed + a.partial)}</td><td className="num">{int(a.dnp)}</td><td className="num">{int(a.cancelled)}</td><td className="num">{int(a.dispatched)}</td></tr>)}</tbody>
                  </table></div>
                </div>
              </div>
            </>
          )}
        </Loading>
      </div>
    </>
  );
}
