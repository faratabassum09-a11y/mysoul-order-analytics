import React from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApi } from '../api.js';
import { useFilters } from '../filters.jsx';
import { FilterBar, Loading } from '../components.jsx';
import { MODES, MODE_COLORS, inr, int, pct, ratioTitle } from '../format.js';

const ROWS = [
  ['Orders', (b) => int(b.total)],
  ['Share of orders', (b) => pct(b.mixCount && b.mixCount.v), (b) => ratioTitle(b.mixCount)],
  ['Share of order value', (b) => pct(b.mixValue && b.mixValue.v), (b) => ratioTitle(b.mixValue)],
  ['Confirmation', (b) => pct(b.confirmation.v), (b) => ratioTitle(b.confirmation)],
  ['Cancellation', (b) => pct(b.cancellation.v), (b) => ratioTitle(b.cancellation)],
  ['NDR', (b) => pct(b.ndr.v), (b) => ratioTitle(b.ndr)],
  ['RTO (closed shipments)', (b) => pct(b.rto.v), (b) => ratioTitle(b.rto)],
  ['Shipments closed', (b) => `${int(b.closed)} of ${int(b.shipments)}`],
  ['Net delivered revenue', (b) => inr(b.netRevenue)],
];

function gap(a, b, key) {
  const x = a[key].v, y = b[key].v;
  return x == null || y == null ? null : x - y;
}

export default function PaymentMode() {
  const f = useFilters();
  const { data, error, loading } = useApi('/metrics', f.params, f.ready);
  const cur = data && data.current;
  const chart = cur && ['Confirmation', 'RTO'].map((name) => {
    const k = name === 'RTO' ? 'rto' : 'confirmation';
    const row = { name: `${name} %` };
    MODES.forEach((m) => { row[m] = cur[m] && cur[m][k].v != null ? Number(cur[m][k].v.toFixed(1)) : null; });
    return row;
  });
  const cg = cur && gap(cur.COD, cur.Prepaid, 'confirmation');
  const rg = cur && gap(cur.COD, cur.Prepaid, 'rto');
  return (
    <>
      <FilterBar range={data && data.range} undated={data && data.undated} />
      <div className="page">
        <h1>Payment mode</h1>
        <p className="lede">COD, Partial COD and Prepaid side by side for the selected window.</p>
        <Loading error={error} loading={loading || !f.ready}>
          {cur && (
            <>
              {(cg != null || rg != null) && (
                <div className="banner">
                  {cg != null && <>Confirmation is <b>{Math.abs(cg).toFixed(1)} pp {cg >= 0 ? 'higher' : 'lower'}</b> on COD than on Prepaid. </>}
                  {rg != null && <>RTO is <b>{Math.abs(rg).toFixed(1)} pp {rg >= 0 ? 'higher' : 'lower'}</b> on COD than on Prepaid (closed shipments only).</>}
                </div>
              )}
              <div className="tablewrap">
                <table>
                  <thead><tr><th>Metric</th>{MODES.map((m) => <th className="num" key={m}><i className="dot" style={{ background: MODE_COLORS[m] }} />{m}</th>)}<th className="num">All</th></tr></thead>
                  <tbody>
                    {ROWS.map(([label, fn, title]) => (
                      <tr key={label}>
                        <td>{label}</td>
                        {[...MODES, 'All'].map((m) => <td className="num" key={m} title={cur[m] && title ? title(cur[m]) : ''}>{cur[m] ? fn(cur[m]) : '–'}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="section card">
                <h2>Confirmation and RTO by mode</h2>
                <div className="chart">
                  <ResponsiveContainer>
                    <BarChart data={chart} margin={{ top: 6, right: 12, bottom: 0, left: -8 }}>
                      <CartesianGrid stroke="#eceee9" vertical={false} />
                      <XAxis dataKey="name" /><YAxis unit="%" domain={[0, 100]} /><Tooltip formatter={(v) => (v == null ? '–' : `${v}%`)} /><Legend />
                      {MODES.map((m) => <Bar key={m} dataKey={m} fill={MODE_COLORS[m]} radius={[4, 4, 0, 0]} />)}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          )}
        </Loading>
      </div>
    </>
  );
}
