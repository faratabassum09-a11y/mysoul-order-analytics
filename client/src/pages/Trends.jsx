import React, { useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApi } from '../api.js';
import { useFilters } from '../filters.jsx';
import { FilterBar, Loading } from '../components.jsx';
import { MODES, MODE_COLORS, int } from '../format.js';

const METRICS = [
  { key: 'orders', title: 'Orders', pct: false },
  { key: 'confirmation', title: 'Confirmation %', pct: true },
  { key: 'ndr', title: 'NDR %', pct: true },
  { key: 'rto', title: 'RTO %', pct: true },
];
const GRANS = [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']];

function label(key, gran) {
  const d = new Date(`${key}T00:00:00`);
  if (gran === 'monthly') return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
  const s = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return gran === 'weekly' ? `Wk ${s}` : s;
}

function TrendChart({ metric, points, gran, showAll }) {
  const lines = showAll ? ['All', ...MODES] : MODES;
  const rows = points.map((p) => {
    const row = { key: p.key, label: label(p.key, gran) };
    lines.forEach((m) => {
      row[m] = p[m][metric.key];
      if (metric.pct) row[`_${m}`] = `${int(p[m][`${metric.key}N`])} of ${int(p[m][`${metric.key}D`])}`;
    });
    return row;
  });
  return (
    <div className="card">
      <h2>{metric.title}</h2>
      <div className="chart">
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="#eceee9" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={18} />
            <YAxis tick={{ fontSize: 11 }} unit={metric.pct ? '%' : ''} domain={metric.pct ? [0, 100] : [0, 'auto']} allowDecimals={false} />
            <Tooltip
              formatter={(v, name, item) => [v == null ? '–' : metric.pct ? `${v.toFixed(1)}% (${item.payload[`_${name}`]})` : v, name]}
              labelFormatter={(l, items) => (items[0] ? items[0].payload.key : l)}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {lines.map((m) => (
              <Line key={m} type="monotone" dataKey={m} stroke={MODE_COLORS[m]} strokeWidth={m === 'All' ? 1.5 : 2} strokeDasharray={m === 'All' ? '4 3' : undefined} dot={rows.length < 25} connectNulls={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function Trends() {
  const f = useFilters();
  const { data, error, loading } = useApi('/trends', { ...f.params, granularity: f.gran }, f.ready);
  const [showAll, setShowAll] = useState(false);
  return (
    <>
      <FilterBar range={data && data.range} />
      <div className="page">
        <div className="filters" style={{ justifyContent: 'space-between' }}>
          <div><h1>Trends</h1><p className="lede" style={{ margin: 0 }}>One line per payment mode. Gaps mean no orders or no closed shipments in that period.</p></div>
          <div className="filters">
            <label className="muted"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all orders line</label>
            <div className="seg">{GRANS.map(([k, l]) => <button key={k} className={f.gran === k ? 'on' : ''} onClick={() => f.setGran(k)}>{l}</button>)}</div>
          </div>
        </div>
        <Loading error={error} loading={loading || !f.ready}>
          {data && data.points.length === 0 && <div className="empty">No dated orders in this window.</div>}
          {data && data.points.length > 0 && (
            <>
              <div className="banner">Recent buckets look better than they are: orders from the last few days are mostly still in transit, so RTO % there rests on very few closed shipments. Hover a point to see the count behind it.</div>
              <div className="two">{METRICS.map((m) => <TrendChart key={m.key} metric={m} points={data.points} gran={data.gran} showAll={showAll} />)}</div>
            </>
          )}
        </Loading>
      </div>
    </>
  );
}
