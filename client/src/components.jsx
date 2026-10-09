import React from 'react';
import { WINDOWS, useFilters } from './filters.jsx';
import { KPIS, MODES, MODE_COLORS, delta, fmtValue, ratioTitle, int, pct, inr } from './format.js';

export function Loading({ error, loading, children }) {
  if (error) return <div className="banner err">{error}</div>;
  if (loading) return <div className="empty">Loading…</div>;
  return children;
}

export function FilterBar({ range, undated }) {
  const f = useFilters();
  return (
    <div className="topbar">
      <select aria-label="Time window" value={f.window} onChange={(e) => f.setWindow(e.target.value)}>
        {WINDOWS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {f.window === 'custom' && (
        <>
          <input type="date" aria-label="From" value={f.from} onChange={(e) => f.setFrom(e.target.value)} />
          <span className="muted">to</span>
          <input type="date" aria-label="To" value={f.to} onChange={(e) => f.setTo(e.target.value)} />
        </>
      )}
      <span className="range">
        {range ? (range.start ? <><b>{range.start}</b> to <b>{range.end}</b> (IST)</> : <b>All orders</b>) : ''}
        {range && range.partial ? ' · period still in progress' : ''}
      </span>
      <span className="grow" />
      {undated > 0 && <span className="chip" title="Undated orders count in All time, but not in dated windows">{int(undated)} undated orders left out of dated windows</span>}
    </div>
  );
}

export function DeltaChip({ type, cur, prev, up }) {
  const d = delta(type, cur, prev);
  if (!d) return <span className="chip" title="No previous window to compare">–</span>;
  if (d.diff === 0) return <span className="chip">no change</span>;
  const arrow = d.diff > 0 ? '▲' : '▼';
  const cls = up ? ((d.diff > 0) === (up === 'good') ? 'good' : 'bad') : '';
  return <span className={`chip ${cls}`} title="Change vs the previous equal-length window">{arrow} {d.text}</span>;
}

export function KpiCard({ kpi, current, previous }) {
  const all = current.All;
  const val = kpi.get(all);
  const prevVal = previous ? kpi.get(previous.All) : null;
  return (
    <div className="card kpi" title={kpi.hint}>
      <div className="label"><span>{kpi.label}</span><DeltaChip type={kpi.type} cur={val} prev={prevVal} up={kpi.up} /></div>
      <div className="big" title={kpi.type === 'pct' ? ratioTitle(val) : ''}>{fmtValue(kpi.type, val)}</div>
      <div className="sub">{kpi.type === 'pct' ? (kpi.sub ? kpi.sub(all) : ratioTitle(val)) : (kpi.sub ? kpi.sub(all) : '')}</div>
      <div className="split">
        {MODES.map((m) => {
          const b = current[m];
          const v = b ? kpi.get(b) : null;
          return (
            <div key={m} title={kpi.type === 'pct' && v ? ratioTitle(v) : ''}>
              <span><i className="dot" style={{ background: MODE_COLORS[m] }} />{m}</span>
              <b>{b ? fmtValue(kpi.type, v) : '–'}</b>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MixCard({ current }) {
  return (
    <div className="card kpi" title="Share of total orders and of order value by payment mode">
      <div className="label"><span>Payment mix</span></div>
      <div className="split" style={{ borderTop: 0, marginTop: 8 }}>
        {MODES.map((m) => {
          const b = current[m];
          return (
            <div key={m} title={b ? `${ratioTitle(b.mixCount)} orders · ${inr(b.value)} of ${inr(current.All.value)}` : ''}>
              <span><i className="dot" style={{ background: MODE_COLORS[m] }} />{m}</span>
              <b>{b ? `${pct(b.mixCount.v, 0)} · ${pct(b.mixValue.v, 0)} value` : '–'}</b>
            </div>
          );
        })}
        {current.Unknown && <div><span className="muted">Unknown mode</span><b>{int(current.Unknown.total)} orders</b></div>}
      </div>
    </div>
  );
}

export function Funnel({ block }) {
  const stages = [
    ['Orders', block.total], ['Confirmed', block.confirmedYes], ['Dispatched', block.dispatched], ['Delivered', block.delivered],
  ];
  const max = Math.max(block.total, 1);
  return (
    <>
      <div className="funnel">
        {stages.map(([label, n], i) => (
          <div className="stage" key={label}>
            <span>{label}</span>
            <div className="bar"><i style={{ width: `${(n / max) * 100}%` }} /></div>
            <span className="val">{int(n)} <span className="muted">{i ? `· ${pct((n / max) * 100, 0)} of orders` : ''}</span></span>
          </div>
        ))}
      </div>
      <div className="drops">
        <span className="drop bad">Dropped: Cancelled<b>{int(block.cancelled)}</b></span>
        <span className="drop bad">Dropped: RTO<b>{int(block.rtoCount)}</b></span>
        <span className="drop">Awaiting confirmation<b>{int(block.pending)}</b></span>
        <span className="drop">In transit<b>{int(block.inTransit)}</b></span>
      </div>
    </>
  );
}

export function ModeTabs({ value, onChange, withAll = true }) {
  const opts = withAll ? ['All', ...MODES] : MODES;
  return (
    <div className="seg" role="tablist">
      {opts.map((m) => <button key={m} className={value === m ? 'on' : ''} onClick={() => onChange(m)}>{m}</button>)}
    </div>
  );
}

export const statusClass = (s) => (s || '').split(' ')[0];
export const StatusTag = ({ s }) => <span className={`tag ${statusClass(s)}`}>{s}</span>;
