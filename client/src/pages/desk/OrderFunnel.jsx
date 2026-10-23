import React, { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApi } from '../../api.js';
import { DeltaChip, Loading } from '../../components.jsx';
import { useAutoRefresh } from '../../flowUi.js';
import { int, pct } from '../../format.js';
import { Empty } from './shared.jsx';
import { FUNNEL_TILES } from './DeskOverview.jsx';

// The six ranges the team asked for, then a date selector for anything else.
const RANGES = [['last_week', 'Last week'], ['this_month', 'This month'], ['last_month', 'Last month'], ['last_quarter', 'Last quarter'], ['last_6_months', 'Last 6 months'], ['this_year', 'This year'], ['custom', 'Pick dates']];
// [key, name, colour]
const CATS = [['orders', 'New orders', '#1c2431'], ['cod', 'COD orders', '#c4661f'], ['confirmed', 'Confirmed', '#1c7c6c'], ['partial', 'Partial paid', '#6a55b3'], ['dispatched', 'Dispatched', '#3b4a96'], ['delivered', 'Delivered', '#2a7f8e'], ['rto', 'RTO', '#b3261e']];
const saved = () => { try { return JSON.parse(localStorage.getItem('funnelRange')) || {}; } catch { return {}; } };
const day = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLong = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function Tile({ label, value, sub, tone, chip }) {
  return <div className={`sd-kpi ${tone || ''}`}><div className="l"><span>{label}</span>{chip}</div><b>{value}</b>{sub && <small>{sub}</small>}</div>;
}

// Order funnel: how the orders of a period moved from new -> confirmed -> partial paid -> dispatched -> delivered / RTO.
export default function OrderFunnel() {
  const init = saved();
  const [range, setRange] = useState(init.range || 'this_month');
  const [from, setFrom] = useState(init.from || ''); const [to, setTo] = useState(init.to || '');
  const [view, setView] = useState('daily'); // daily | total
  const [shown, setShown] = useState(() => new Set(['orders', 'confirmed', 'dispatched', 'delivered', 'rto']));
  useEffect(() => { try { localStorage.setItem('funnelRange', JSON.stringify({ range, from, to })); } catch (e) { /* private window: the choice just is not remembered */ } }, [range, from, to]);
  const ready = range !== 'custom' || (from && to && from <= to);
  const params = range === 'custom' ? { window: range, from, to } : { window: range };
  const { data, error, loading, reload } = useApi('/desk/funnel', params, ready);
  useAutoRefresh(reload, 120);
  const s = data && data.stats; const p = data && data.prev;
  const rows = data ? (view === 'daily' ? data.daily : data.running) : [];
  const toggle = (k) => setShown((cur) => { const n = new Set(cur); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const tableRows = useMemo(() => (data ? [...data.daily].reverse() : []), [data]);
  return (
    <>
      <div className="topbar">
        <div className="sd-chips" role="tablist" aria-label="Date range" style={{ margin: 0 }}>
          {RANGES.map(([k, l]) => <button key={k} role="tab" aria-selected={range === k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{l}</button>)}
        </div>
        {range === 'custom' && (
          <>
            <input type="date" aria-label="From" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            <span className="muted">to</span>
            <input type="date" aria-label="To" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </>
        )}
        <span className="range">{data && data.range.start ? <><b>{data.range.start}</b> to <b>{data.range.end}</b> (IST)</> : ''}{data && data.range.partial ? ' · period still in progress' : ''}</span>
      </div>
      <div className="sd-body">
        {!ready && <Empty title="Pick both dates">Choose a start and an end date to see the funnel for that period.</Empty>}
        {ready && (
          <Loading error={error} loading={loading && !data}>
            {data && (
              <>
                <h2 className="sd-h2" style={{ marginTop: 0 }}>Total count</h2>
                <p className="cap">Orders placed in this period, and where they stand now. The arrows compare with the period before it.</p>
                <div className="sd-kpis fn-counts">
                  {CATS.map(([k, l, c]) => <Tile key={k} label={l} value={int(s[k])} sub={k === 'orders' ? `Confirmed ratio ${s.confirmedRatio == null ? '—' : s.confirmedRatio.toFixed(2)}` : k === 'cod' ? 'Not paid online' : ''} chip={p && <DeltaChip type="count" cur={s[k]} prev={p[k]} up={k === 'rto' ? 'bad' : 'good'} />} />)}
                </div>

                <h2 className="sd-h2">Rates</h2>
                <div className="sd-kpis fn-rates">
                  {FUNNEL_TILES.map(([key, label, tone, up, of]) => <Tile key={key} label={label} value={pct(s[key].v)} sub={of(s)} tone={tone} chip={p && <DeltaChip type="pct" cur={s[key]} prev={p[key]} up={up} />} />)}
                </div>

                <h2 className="sd-h2">{view === 'daily' ? 'New orders added each day, by category' : 'Total over time'}</h2>
                <div className="fn-bar">
                  <div className="sd-chips" role="tablist" aria-label="View" style={{ margin: 0 }}>
                    <button role="tab" aria-selected={view === 'daily'} className={view === 'daily' ? 'on' : ''} onClick={() => setView('daily')}>Daily count</button>
                    <button role="tab" aria-selected={view === 'total'} className={view === 'total' ? 'on' : ''} onClick={() => setView('total')}>Total over time</button>
                  </div>
                  <div className="fn-legend">
                    {CATS.map(([k, l, c]) => <label key={k}><input type="checkbox" checked={shown.has(k)} onChange={() => toggle(k)} /><i style={{ background: c }} />{l}</label>)}
                  </div>
                </div>
                <p className="cap">{view === 'daily' ? 'Each point is the orders placed that day, split by what has happened to them since.' : 'Each point adds up everything from the start of the period to that day.'}</p>
                {rows.length === 0 ? <Empty title="No orders in this period">Pick another range.</Empty> : (
                  <div className="card chart"><ResponsiveContainer width="100%" height="100%">
                    <LineChart data={rows} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="#e4e7e1" />
                      <XAxis dataKey="date" tickFormatter={day} fontSize={12} tickLine={false} axisLine={false} minTickGap={24} />
                      <YAxis allowDecimals={false} fontSize={12} tickLine={false} axisLine={false} width={40} />
                      <Tooltip labelFormatter={dayLong} />
                      <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                      {CATS.filter(([k]) => shown.has(k)).map(([k, l, c]) => <Line key={k} type="monotone" dataKey={k} name={l} stroke={c} strokeWidth={2} dot={rows.length <= 45} activeDot={{ r: 4 }} />)}
                    </LineChart>
                  </ResponsiveContainer></div>
                )}

                <h2 className="sd-h2">Count per day</h2>
                <div className="tablewrap fn-table"><table className="sd-table">
                  <thead><tr><th>Date</th>{CATS.map(([k, l]) => <th key={k} className="num">{l}</th>)}<th className="num">Confirmed %</th></tr></thead>
                  <tbody>
                    <tr className="fn-total"><td><b>Total</b></td>{CATS.map(([k]) => <td key={k} className="num"><b>{int(s[k])}</b></td>)}<td className="num"><b>{pct(s.confirmedPct.v)}</b></td></tr>
                    {tableRows.map((d) => (
                      <tr key={d.date} className={d.orders ? '' : 'muted'}><td>{dayLong(d.date)}</td>{CATS.map(([k]) => <td key={k} className="num">{int(d[k])}</td>)}<td className="num">{d.orders ? pct((d.confirmed / d.orders) * 100, 0) : '—'}</td></tr>
                    ))}
                  </tbody>
                </table></div>
              </>
            )}
          </Loading>
        )}
      </div>
    </>
  );
}
