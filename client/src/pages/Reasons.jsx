import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api.js';
import { useFilters } from '../filters.jsx';
import { FilterBar, Loading } from '../components.jsx';
import { MODES, int, pct } from '../format.js';

function Panel({ title, note, summary }) {
  return (
    <div className="card">
      <h2>{title} <span className="muted">({int(summary.total)})</span></h2>
      <p className="muted" style={{ marginTop: -6 }}>{note}</p>
      {summary.total === 0 && <div className="empty">None in this window.</div>}
      {summary.buckets.map((b) => (
        <div className="reason" key={b.bucket}>
          <div className="row">
            <span>{b.bucket}</span>
            <div className="bar"><i style={{ width: `${b.pct}%` }} /></div>
            <span><b>{int(b.count)}</b> <span className="muted">{pct(b.pct, 0)}</span></span>
          </div>
          {b.raw.length > 0 && (
            <details>
              <summary>Raw text ({b.raw.length === 12 ? '12+' : b.raw.length} distinct)</summary>
              <ul className="log">{b.raw.map((r) => <li key={r.text}>{r.text} <span className="muted">×{r.count}</span></li>)}</ul>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

export default function Reasons() {
  const f = useFilters();
  const [mode, setMode] = useState('');
  const { data, error, loading } = useApi('/reasons', { ...f.params, mode }, f.ready);
  return (
    <>
      <FilterBar range={data && data.range} />
      <div className="page">
        <div className="filters" style={{ justifyContent: 'space-between' }}>
          <div><h1>Reasons</h1><p className="lede" style={{ margin: 0 }}>Free text grouped by the keyword map in <Link to="/settings">Settings</Link>. Raw text stays visible under each group.</p></div>
          <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Payment mode">
            <option value="">All payment modes</option>{MODES.map((m) => <option key={m}>{m}</option>)}
          </select>
        </div>
        <Loading error={error} loading={loading || !f.ready}>
          {data && (
            <div className="two">
              <Panel title="Cancellation reasons" note="From NOTES, for orders marked Cancel." summary={data.cancel} />
              <Panel title="RTO reasons" note="From RTO REASON, for orders whose final status is RTO." summary={data.rto} />
            </div>
          )}
        </Loading>
      </div>
    </>
  );
}
