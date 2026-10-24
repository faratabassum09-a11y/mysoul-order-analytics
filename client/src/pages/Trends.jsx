import React, { useMemo, useState } from 'react';
import { Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApi } from '../api.js';
import { Funnel, Loading, ModeTabs, SourceNote } from '../components.jsx';
import { KPIS, MODES, MODE_COLORS, delta, fmtValue, inr, int, pct } from '../format.js';

const VIEWS = {
  daily: { label: 'Daily', span: 'Last 30 days', unit: 'day', units: 'days' },
  weekly: { label: 'Weekly', span: 'Last 12 weeks', unit: 'week', units: 'weeks' },
  monthly: { label: 'Monthly', span: 'Last 12 months', unit: 'month', units: 'months' },
};
const SUM = ['total', 'value', 'pending', 'confirmedYes', 'cancelled', 'dispatched', 'delivered', 'rtoCount', 'inTransit', 'netRevenue'];
const RATIOS = ['confirmation', 'cancellation', 'dispatch', 'ndr', 'ndrToRto', 'deliveredRate', 'rto'];
const C = { good: '#1c7c6c', bad: '#b3261e', warn: '#b7791f', blue: '#3b4a96', ink: '#1c2431', grey: '#a3abb7' };

const fmtShort = (ymd, opts) => new Date(`${ymd}T00:00:00`).toLocaleDateString('en-IN', opts);
function labels(p, gran) {
  if (gran === 'monthly') return { label: fmtShort(p.key, { month: 'short', year: '2-digit' }), range: fmtShort(p.key, { month: 'long', year: 'numeric' }) };
  if (gran === 'weekly') return { label: fmtShort(p.key, { day: 'numeric', month: 'short' }), range: `Week ${fmtShort(p.key, { day: 'numeric', month: 'short' })} – ${fmtShort(p.end, { day: 'numeric', month: 'short' })}` };
  return { label: fmtShort(p.key, { day: 'numeric', month: 'short' }), range: fmtShort(p.key, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) };
}

// Sum count fields and add up numerators / denominators, so a combined period gets a true rate rather than an average of rates.
function aggregate(blocks) {
  const o = {};
  SUM.forEach((k) => { o[k] = blocks.reduce((a, b) => a + (b[k] || 0), 0); });
  RATIOS.forEach((k) => {
    const n = blocks.reduce((a, b) => a + b[k].n, 0), d = blocks.reduce((a, b) => a + b[k].d, 0);
    o[k] = { v: d > 0 ? (n / d) * 100 : null, n, d };
  });
  o.aov = o.total ? o.value / o.total : null;
  o.closed = o.delivered + o.rtoCount; o.shipments = o.closed + o.inTransit;
  return o;
}

function toRow(p, mode, gran) {
  const b = p[mode];
  const r = { key: p.key, partial: p.partial, ...labels(p, gran) };
  SUM.forEach((k) => { r[k] = b[k]; });
  r.aov = b.aov; r.inTransit = b.inTransit;
  RATIOS.forEach((k) => { r[k] = b[k].v; r[`${k}_nd`] = `${int(b[k].n)} of ${int(b[k].d)}`; });
  r.awaiting = Math.max(0, b.total - b.delivered - b.rtoCount - b.inTransit - b.cancelled - b.pending);
  MODES.forEach((m) => { r[`o_${m}`] = p[m].total; r[`rto_${m}`] = p[m].rto.v; r[`rto_${m}_nd`] = `${int(p[m].rto.n)} of ${int(p[m].rto.d)}`; });
  return r;
}

const FMT = { int, pct: (v) => pct(v), inr };
function Tip({ active, payload, series }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  return (
    <div className="tip">
      <b>{row.range}{row.partial ? ' · so far' : ''}</b>
      {payload.map((p) => {
        const s = series.find((x) => x.key === p.dataKey) || {};
        const nd = row[`${p.dataKey}_nd`];
        return (
          <div key={p.dataKey}>
            <span><i className="dot" style={{ background: s.color }} />{s.name}</span>
            <b>{p.value == null ? '–' : (FMT[s.fmt] || int)(p.value)}{nd ? <span className="muted"> ({nd})</span> : null}</b>
          </div>
        );
      })}
    </div>
  );
}

// kind: bar | line | area. stack groups bars. right puts a series on the second axis.
function ChartCard({ title, note, rows, series, yFmt = 'int', pctAxis, rightFmt, wide }) {
  const hasRight = series.some((s) => s.right);
  const tickFmt = (f) => (v) => (f === 'pct' ? `${v}%` : f === 'inr' ? (v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : v >= 1000 ? `₹${Math.round(v / 1000)}k` : `₹${v}`) : v);
  return (
    <div className={`card${wide ? ' wide' : ''}`}>
      <h2>{title}</h2>
      {note && <p className="cap">{note}</p>}
      <div className="chart">
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 6, right: hasRight ? 4 : 12, bottom: 0, left: -6 }}>
            <CartesianGrid stroke="#eceee9" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={14} />
            <YAxis yAxisId="l" tick={{ fontSize: 11 }} tickFormatter={tickFmt(yFmt)} domain={pctAxis ? [0, 100] : [0, 'auto']} allowDecimals={false} />
            {hasRight && <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11 }} tickFormatter={tickFmt(rightFmt)} domain={[0, 'auto']} />}
            <Tooltip content={<Tip series={series} />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {series.map((s) => {
              const common = { key: s.key, dataKey: s.key, name: s.name, yAxisId: s.right ? 'r' : 'l', isAnimationActive: false };
              if (s.kind === 'bar') return <Bar {...common} fill={s.color} stackId={s.stack} radius={s.stack ? 0 : [3, 3, 0, 0]} />;
              if (s.kind === 'area') return <Area {...common} type="monotone" stroke={s.color} fill={s.color} fillOpacity={0.14} strokeWidth={2} />;
              return <Line {...common} type="monotone" stroke={s.color} strokeWidth={2} dot={rows.length < 16} connectNulls={false} strokeDasharray={s.dashed ? '4 3' : undefined} />;
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Spark({ rows, kpi, color }) {
  const data = rows.map((r, i) => ({ i, v: kpi.type === 'pct' ? r[kpi.key] : kpi.get(r.__b) }));
  return (
    <div className="spark">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 3, right: 2, bottom: 3, left: 2 }}>
          <YAxis hide domain={['auto', 'auto']} />
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function Pulse({ kpi, all, recent, earlier, rows, span }) {
  const cur = kpi.get(all);
  const d = earlier ? delta(kpi.type, kpi.get(recent), kpi.get(earlier)) : null;
  const cls = d && d.diff !== 0 && kpi.up ? ((d.diff > 0) === (kpi.up === 'good') ? 'good' : 'bad') : '';
  const color = cls === 'bad' ? C.bad : cls === 'good' ? C.good : C.ink;
  return (
    <div className="card kpi" title={kpi.hint}>
      <div className="label"><span>{kpi.label}</span>
        {d ? <span className={`chip ${cls}`} title={`Latest ${span} vs the ${span} before it (completed periods only)`}>{d.diff === 0 ? 'no change' : `${d.diff > 0 ? '▲' : '▼'} ${d.text}`}</span> : <span className="chip">–</span>}
      </div>
      <div className="big">{fmtValue(kpi.type, cur)}</div>
      <div className="sub">{kpi.type === 'pct' ? (cur && cur.d != null ? `${int(cur.n)} of ${int(cur.d)}` : '') : (kpi.sub ? kpi.sub(all) : '')}</div>
      <Spark rows={rows} kpi={kpi} color={color} />
    </div>
  );
}

function insightsFor({ recent, earlier, rows, view }) {
  const out = [];
  if (earlier) {
    KPIS.forEach((k) => {
      if (!k.up) return;
      const d = delta(k.type, k.get(recent), k.get(earlier));
      if (!d || d.diff === 0) return;
      const size = k.type === 'pct' ? Math.abs(d.diff) : Math.abs(d.diff);
      if (size < (k.type === 'pct' ? 2 : 10)) return;
      const good = (d.diff > 0) === (k.up === 'good');
      const a = fmtValue(k.type, k.get(earlier)), b = fmtValue(k.type, k.get(recent));
      out.push({ good, size: k.type === 'pct' ? size * 3 : size, text: `${k.label} ${d.diff > 0 ? 'rose' : 'fell'} ${d.text} (${a} → ${b})` });
    });
  }
  const done = rows.filter((r) => !r.partial && r.total > 0);
  if (done.length > 1) {
    const hi = done.reduce((a, r) => (r.total > a.total ? r : a)), lo = done.reduce((a, r) => (r.total < a.total ? r : a));
    out.push({ neutral: true, size: 0, text: `Busiest ${view.unit}: ${hi.range} with ${int(hi.total)} orders · quietest: ${lo.range} with ${int(lo.total)}` });
  }
  return out.sort((a, b) => b.size - a.size);
}

function BucketTable({ rows, view }) {
  const cols = [
    ['Orders', 'total', int], ['Value', 'value', inr], ['Avg order', 'aov', inr], ['Pending', 'pending', int],
    ['Confirm %', 'confirmation', pct], ['Cancel %', 'cancellation', pct], ['Dispatch %', 'dispatch', pct], ['NDR %', 'ndr', pct],
    ['Delivered %', 'deliveredRate', pct], ['RTO %', 'rto', pct], ['In transit', 'inTransit', int], ['Net revenue', 'netRevenue', inr],
  ];
  return (
    <div className="tablewrap">
      <table>
        <thead><tr><th>{view.unit[0].toUpperCase() + view.unit.slice(1)}</th>{cols.map(([h]) => <th key={h} className="num">{h}</th>)}</tr></thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <tr key={r.key}>
              <td>{r.range}{r.partial && <span className="chip" style={{ marginLeft: 8 }}>in progress</span>}</td>
              {cols.map(([h, k, f]) => <td key={h} className="num" title={r[`${k}_nd`] || ''}>{r.total === 0 && k !== 'total' ? <span className="muted">–</span> : f(r[k])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Trends() {
  const [gran, setGran] = useState('daily');
  const [mode, setMode] = useState('All');
  const view = VIEWS[gran];
  const { data, error, loading } = useApi('/trends/overview', { granularity: gran });

  const m = useMemo(() => {
    if (!data || !data.points.length) return null;
    const rows = data.points.map((p) => ({ ...toRow(p, mode, gran), __b: p[mode] }));
    const blocks = data.points.map((p) => p[mode]);
    const done = data.points.filter((p) => !p.partial);
    const h = Math.floor(done.length / 2);
    const recent = h ? aggregate(done.slice(done.length - h).map((p) => p[mode])) : null;
    const earlier = h ? aggregate(done.slice(done.length - 2 * h, done.length - h).map((p) => p[mode])) : null;
    const spanTxt = `${h} ${h === 1 ? view.unit : view.units}`;
    return { rows, all: aggregate(blocks), recent, earlier, h, spanTxt, insights: insightsFor({ recent, earlier, rows, view }) };
  }, [data, mode, gran]); // eslint-disable-line react-hooks/exhaustive-deps

  const empty = data && (!m || m.all.total === 0);
  return (
    <>
      <div className="topbar">
        <div className="seg" role="tablist" aria-label="Trend period">
          {Object.entries(VIEWS).map(([k, v]) => <button key={k} className={gran === k ? 'on' : ''} onClick={() => setGran(k)}>{v.label}<small> · {v.span.replace('Last ', '')}</small></button>)}
        </div>
        <ModeTabs value={mode} onChange={setMode} />
        <span className="range">{data ? <><b>{view.span}</b> from {fmtShort(data.start, { day: 'numeric', month: 'short', year: 'numeric' })} (IST)</> : ''}</span>
      </div>
      <div className="page">
        <h1>Trends</h1>
        <p className="lede">The Overview numbers, broken out {gran === 'daily' ? 'day by day' : gran === 'weekly' ? 'week by week (Mon–Sun)' : 'month by month'}. Pick a payment mode above to see only that mode. Every number is counted by order date; hover any chart point or percentage to see the count behind it.</p>
        <Loading error={error} loading={loading}>
          {data && <SourceNote source={data.source} range={{ start: data.start, end: null }} />}
          {empty && <div className="banner">No dated orders in this period yet.</div>}
          {m && !empty && (
            <>
              {m.h >= 1 && (
                <div className="card pulse">
                  <h2>What's changed</h2>
                  <p className="cap">Latest {m.spanTxt} compared with the {m.spanTxt} before it (finished periods only; the {view.unit} in progress is left out of this comparison).</p>
                  {m.insights.length === 0 ? <p className="muted">No big moves. The business is steady across these two stretches.</p> : (
                    <ul className="insights">
                      {m.insights.slice(0, 7).map((i, n) => <li key={n} className={i.neutral ? '' : i.good ? 'good' : 'bad'}><i>{i.neutral ? '•' : i.good ? '▲' : '▼'}</i>{i.text}</li>)}
                    </ul>
                  )}
                </div>
              )}
              {m.all.shipments > 0 && m.all.closed < m.all.shipments * 0.6 && (
                <div className="banner warn" style={{ marginTop: 14 }}>Only {int(m.all.closed)} of {int(m.all.shipments)} shipments here have closed. Recent RTO % and Delivered % rest on few closed orders and will move as parcels land.</div>
              )}

              <h2 className="sect">Summary for the whole {view.span.toLowerCase()}</h2>
              <div className="grid">
                {KPIS.map((k) => <Pulse key={k.key} kpi={k} all={m.all} recent={m.recent} earlier={m.earlier} rows={m.rows} span={m.spanTxt} />)}
              </div>

              <h2 className="sect">Volume and revenue</h2>
              <div className="two">
                <ChartCard title="Orders and order value" note="Bars: orders. Line: rupee value of those orders (right axis)." rows={m.rows} rightFmt="inr"
                  series={[{ key: 'total', name: 'Orders', color: C.blue, kind: 'bar', fmt: 'int' }, { key: 'value', name: 'Order value', color: C.warn, kind: 'line', right: true, fmt: 'inr' }]} />
                <ChartCard title="Order value vs net delivered revenue" note="The gap is money not yet delivered: cancelled, RTO or still on the way." rows={m.rows} yFmt="inr"
                  series={[{ key: 'value', name: 'Order value', color: C.grey, kind: 'area', fmt: 'inr' }, { key: 'netRevenue', name: 'Net delivered revenue', color: C.good, kind: 'area', fmt: 'inr' }]} />
                <ChartCard title="Average order value" rows={m.rows} yFmt="inr" series={[{ key: 'aov', name: 'Avg order', color: C.ink, kind: 'line', fmt: 'inr' }]} />
                <ChartCard title="Orders by payment mode" note="Always shows all three modes, whatever mode is picked above." rows={m.rows}
                  series={MODES.map((x) => ({ key: `o_${x}`, name: x, color: MODE_COLORS[x], kind: 'bar', stack: 'm', fmt: 'int' }))} />
              </div>

              <h2 className="sect">Where orders end up</h2>
              <div className="two">
                <ChartCard title="Order outcomes" note="Every order sits in exactly one stack segment." rows={m.rows}
                  series={[
                    { key: 'delivered', name: 'Delivered', color: C.good, kind: 'bar', stack: 'o', fmt: 'int' },
                    { key: 'inTransit', name: 'In transit', color: C.blue, kind: 'bar', stack: 'o', fmt: 'int' },
                    { key: 'awaiting', name: 'Confirmed, not shipped', color: C.warn, kind: 'bar', stack: 'o', fmt: 'int' },
                    { key: 'pending', name: 'Awaiting confirmation', color: C.grey, kind: 'bar', stack: 'o', fmt: 'int' },
                    { key: 'rtoCount', name: 'RTO', color: C.bad, kind: 'bar', stack: 'o', fmt: 'int' },
                    { key: 'cancelled', name: 'Cancelled', color: '#e08a84', kind: 'bar', stack: 'o', fmt: 'int' },
                  ]} />
                <div className="card">
                  <h2>Order funnel for this period</h2>
                  <p className="cap">All {int(m.all.total)} orders in the {view.span.toLowerCase()}.</p>
                  <Funnel block={m.all} />
                </div>
              </div>

              <h2 className="sect">Confirmation, dispatch and delivery rates</h2>
              <div className="two">
                <ChartCard title="Confirmation, cancellation and dispatch" rows={m.rows} yFmt="pct" pctAxis
                  series={[{ key: 'confirmation', name: 'Confirmation %', color: C.good, kind: 'line', fmt: 'pct' }, { key: 'cancellation', name: 'Cancellation %', color: C.bad, kind: 'line', fmt: 'pct' }, { key: 'dispatch', name: 'Dispatch %', color: C.blue, kind: 'line', fmt: 'pct' }]} />
                <ChartCard title="Delivery health" note="Recent points rest on few closed shipments; hover to see the count." rows={m.rows} yFmt="pct" pctAxis
                  series={[{ key: 'deliveredRate', name: 'Delivered %', color: C.good, kind: 'line', fmt: 'pct' }, { key: 'rto', name: 'RTO %', color: C.bad, kind: 'line', fmt: 'pct' }, { key: 'ndr', name: 'NDR %', color: C.warn, kind: 'line', fmt: 'pct' }, { key: 'ndrToRto', name: 'NDR to RTO %', color: '#6a55b3', kind: 'line', dashed: true, fmt: 'pct' }]} />
                <ChartCard title="RTO % by payment mode" note="Which payment mode is leaking the most parcels. Always shows all three." rows={m.rows} yFmt="pct" pctAxis wide
                  series={MODES.map((x) => ({ key: `rto_${x}`, name: x, color: MODE_COLORS[x], kind: 'line', fmt: 'pct' }))} />
              </div>

              <h2 className="sect">Every {view.unit}, in numbers</h2>
              <BucketTable rows={m.rows} view={view} />
            </>
          )}
        </Loading>
      </div>
    </>
  );
}
