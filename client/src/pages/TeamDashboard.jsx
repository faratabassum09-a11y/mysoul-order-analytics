import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApi } from '../api.js';
import { DeltaChip, Loading } from '../components.jsx';
import { ROLE_LABEL, duration, fmtTime, fmtWhen, useAutoRefresh } from '../flowUi.js';
import { inr, int, pct } from '../format.js';

// ---------------------------------------------------------------- filters: quick buttons + a date picker (this page keeps its own, so Overview's choice is not disturbed)
const PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['last_week', 'Last week'], ['this_month', 'This month']];
const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const KEY = 'teamPerfFilters';
const loadSaved = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };

function useTeamFilters() {
  const saved = loadSaved();
  const [window_, setWindow] = useState(PRESETS.some(([k]) => k === saved.window) || saved.window === 'custom' ? saved.window : 'today');
  const [from, setFrom] = useState(saved.from || '');
  const [to, setTo] = useState(saved.to || '');
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify({ window: window_, from, to })); } catch { /* private mode: fine */ } }, [window_, from, to]);
  const custom = window_ === 'custom';
  const ready = !custom || (!!from && !!to && from <= to);
  const params = useMemo(() => (custom ? { window: 'custom', from, to } : { window: window_ }), [custom, window_, from, to]);
  const pick = (k) => setWindow(k);
  const pickFrom = (v) => { setWindow('custom'); setFrom(v); if (!to || to < v) setTo(v); }; // choosing one date alone shows that single day
  const pickTo = (v) => { setWindow('custom'); setTo(v); if (!from || from > v) setFrom(v); };
  return { window: window_, from, to, ready, params, pick, pickFrom, pickTo };
}

function FilterBar({ f, range, updated, onRefresh, busy }) {
  const max = todayIst();
  return (
    <div className="topbar tp-bar">
      <div className="tp-presets" role="tablist" aria-label="Time period">
        {PRESETS.map(([k, l]) => <button key={k} role="tab" aria-selected={f.window === k} className={f.window === k ? 'on' : ''} onClick={() => f.pick(k)}>{l}</button>)}
      </div>
      <div className={`tp-dates ${f.window === 'custom' ? 'on' : ''}`}>
        <label>From <input type="date" max={max} value={f.from || (range ? range.start : '')} onChange={(e) => e.target.value && f.pickFrom(e.target.value)} /></label>
        <label>To <input type="date" max={max} value={f.to || (range ? range.end : '')} onChange={(e) => e.target.value && f.pickTo(e.target.value)} /></label>
      </div>
      <span className="range">
        {range && <><b>{range.start === range.end ? range.start : `${range.start} to ${range.end}`}</b> (IST){range.partial ? ' · in progress' : ''}</>}
      </span>
      <span className="grow" />
      <span className="tp-updated" title="This page refreshes itself every minute">{busy ? 'Updating…' : updated ? `Updated ${fmtTime(updated)}` : ''}</span>
      <button className="btn ghost" onClick={onRefresh}>Refresh</button>
    </div>
  );
}

// ---------------------------------------------------------------- small pieces
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
const HUES = ['#2a7f8e', '#6a55b3', '#c4661f', '#3b4a96', '#1c7c6c', '#a0507a', '#7a6a1f'];
const hueOf = (s) => HUES[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
const Avatar = ({ p }) => <span className="tp-av" style={{ background: hueOf(p.id) }} aria-hidden="true">{initials(p.name)}</span>;
const Role = ({ r }) => (r ? <span className={`tp-role ${r}`}>{r === 'confirmation' ? 'Confirmation' : r === 'packing' ? 'Packing' : 'Admin'}</span> : <span className="tp-role none">Former member</span>);
const ms = (v) => (v == null ? '—' : duration(v));

function Kpi({ label, value, sub, chip, tone, hint }) {
  return <div className={`sd-kpi tp-kpi ${tone || ''}`} title={hint}><div className="l"><span>{label}</span>{chip}</div><b>{value}</b><small>{sub || ' '}</small></div>;
}

function Spark({ values, color = '#1c7c6c', w = 96, h = 26 }) {
  const max = Math.max(1, ...values);
  if (!values.some(Boolean)) return <span className="muted" style={{ fontSize: 12 }}>no activity</span>;
  const step = values.length > 1 ? (w - 4) / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${(2 + i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(' ');
  return <svg width={w} height={h} role="img" aria-label="Activity over the period"><polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

const Delta = ({ cur, prev, up = 'good' }) => (prev == null ? null : <DeltaChip type="count" cur={cur} prev={prev} up={up} />);

// ---------------------------------------------------------------- one person, expanded
function PersonDetail({ p, trend, bucket }) {
  const data = trend.map((t, i) => ({ label: t.label, n: p.series[i] || 0 }));
  const cells = [
    ['Confirmed', p.confirmed], ['Partial paid', p.partial], ['Cancelled', p.cancelled], ['No answer', p.dnp],
    ['Packing slips', p.slip], ['Packed', p.packed], ['Handed to courier', p.handover], ['Late steps', p.late],
  ];
  return (
    <div className="tp-detail">
      <div className="tp-facts"><span>Tasks due <b>{p.tasks.due}</b></span><span>On time <b>{p.tasks.onTime}</b></span><span>Late <b>{p.tasks.late}</b></span><span>Missed <b>{p.tasks.missed}</b></span><span>Score <b>{p.tasks.score == null ? '—' : `${p.tasks.score}/100`}</b></span></div>
      <div className="tp-cells">{cells.map(([l, v]) => <div key={l}><b>{int(v)}</b><span>{l}</span></div>)}</div>
      <div className="tp-facts">
        <span>Order value won <b>{inr(p.valueWon)}</b></span>
        <span>Partial money received <b>{inr(p.collected)}</b></span>
        <span>Active on <b>{p.activeDays}</b> {p.activeDays === 1 ? 'day' : 'days'}</span>
        <span>First action <b>{p.firstAt ? fmtWhen(p.firstAt) : '—'}</b></span>
        <span>Last action <b>{p.lastAt ? fmtWhen(p.lastAt) : '—'}</b></span>
        <span>Holding now <b>{p.open.assigned}</b> open orders{p.open.overdue ? <> · <b className="bad-text">{p.open.overdue} overdue</b></> : ''}</span>
      </div>
      <div className="tp-minichart" aria-label={`Actions per ${bucket}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#e4e7e1" />
            <XAxis dataKey="label" fontSize={11} tickLine={false} axisLine={false} minTickGap={14} />
            <YAxis allowDecimals={false} fontSize={11} tickLine={false} axisLine={false} width={34} />
            <Tooltip cursor={{ fill: 'rgba(0,0,0,.04)' }} formatter={(v) => [v, 'Actions']} />
            <Bar dataKey="n" fill={hueOf(p.id)} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------- task scorecard: assigned, due, on time
const GRADE = { excellent: 'Excellent', good: 'Good', fair: 'Needs improvement', poor: 'Poor', none: 'No tasks due' };
const Grade = ({ g }) => <span className={`tp-grade ${g}`}>{GRADE[g] || GRADE.none}</span>;
function ScoreBar({ score, grade }) {
  return (
    <span className="tp-scorebar" title={score == null ? 'Nothing was due in this period' : `${score} out of 100`}>
      <span className="track"><i className={grade} style={{ width: `${score == null ? 0 : Math.max(score, 2)}%` }} /></span>
      <b>{score == null ? '—' : score}</b>
    </span>
  );
}

function Scorecard({ data, compareLabel }) {
  const tt = data.team.tasks; const tp = data.team.tasksPrev;
  const rows = data.people.filter((p) => p.tasks.due > 0 || p.tasks.assigned > 0 || p.tasks.toDo > 0 || (p.active && p.role !== 'admin'))
    .sort((a, b) => (b.tasks.score ?? -1) - (a.tasks.score ?? -1) || b.tasks.due - a.tasks.due || a.name.localeCompare(b.name));
  return (
    <>
      <h2 className="sd-h2">Task scorecard: are they doing their work on time?</h2>
      <p className="cap">Every follow-up call (FU1–FU3, Day 1–3) and every dispatch step (packing slip, packed, handover) has a deadline. A task counts here when its deadline falls in the period you picked.</p>
      <div className="sd-kpis tp-kpis">
        <Kpi label="Team score" value={tt.score == null ? '—' : `${tt.score}/100`} sub={<Grade g={tt.grade} />} tone={tt.grade === 'excellent' || tt.grade === 'good' ? 'good' : tt.grade === 'none' ? '' : 'bad'} chip={tp && tp.score != null && tt.score != null ? <DeltaChip type="count" cur={tt.score} prev={tp.score} up="good" /> : null} hint={`Done on time earns 1 point, done late half a point, not done 0. ${compareLabel}`} />
        <Kpi label="Tasks due" value={int(tt.due)} sub={`${int(tt.assigned)} assigned to people in this period`} tone="" chip={tp && <Delta cur={tt.due} prev={tp.due} />} hint="Tasks whose deadline fell in this period" />
        <Kpi label="Done on time" value={int(tt.onTime)} sub={tt.due ? `${pct(tt.onTimeRate.v, 0)} of tasks due` : 'Nothing was due'} tone="good" chip={tp && tp.due > 0 ? <DeltaChip type="pct" cur={tt.onTimeRate} prev={tp.onTimeRate} up="good" /> : null} hint="Finished before the task turned overdue (2 hours after its deadline for calls)" />
        <Kpi label="Done late" value={int(tt.late)} sub="finished after it turned overdue" tone="warn" hint="Completed, but after the deadline and grace time" />
        <Kpi label="Missed" value={int(tt.missed)} sub={tt.unassignedMissed ? `${int(tt.unassignedMissed)} held by nobody` : 'still not done and overdue'} tone={tt.missed ? 'bad' : 'good'} hint="Overdue and still open right now" />
        {tt.toDo > 0 && <Kpi label="Still to do" value={int(tt.toDo)} sub="due in this period, not overdue yet" tone="violet" />}
      </div>

      <div className="tablewrap"><table className="sd-table tp-score-table">
        <thead><tr><th>Person</th><th>Performance</th><th className="num">Assigned</th><th className="num">Due</th><th className="num">On time</th><th className="num">Late</th><th className="num">Missed</th><th className="num">To do</th><th className="num">Completed</th></tr></thead>
        <tbody>
          {rows.length === 0 ? <tr><td colSpan={9} className="muted">No tasks in this period.</td></tr> : rows.map((p) => (
            <tr key={p.id}>
              <td><span className="who"><Avatar p={p} /><span><b>{p.name}</b><Role r={p.role} /></span></span></td>
              <td><ScoreBar score={p.tasks.score} grade={p.tasks.grade} /><Grade g={p.tasks.grade} /></td>
              <td className="num">{int(p.tasks.assigned)}</td>
              <td className="num">{int(p.tasks.due)}</td>
              <td className="num good-text">{int(p.tasks.onTime)}</td>
              <td className={`num ${p.tasks.late ? 'warn-text' : ''}`}>{int(p.tasks.late)}</td>
              <td className={`num ${p.tasks.missed ? 'bad-text' : ''}`}>{int(p.tasks.missed)}</td>
              <td className="num">{int(p.tasks.toDo)}</td>
              <td className="num" title={p.tasks.due ? `${p.tasks.done} of ${p.tasks.due}` : ''}>{p.tasks.due ? pct(p.tasks.doneRate.v, 0) : '—'}</td>
            </tr>
          ))}
          {rows.length > 1 && <tr className="tp-total"><td><b>Team</b></td><td><ScoreBar score={tt.score} grade={tt.grade} /></td><td className="num">{int(tt.assigned)}</td><td className="num">{int(tt.due)}</td><td className="num">{int(tt.onTime)}</td><td className="num">{int(tt.late)}</td><td className="num">{int(tt.missed)}</td><td className="num">{int(tt.toDo)}</td><td className="num">{tt.due ? pct(tt.doneRate.v, 0) : '—'}</td></tr>}
        </tbody>
      </table></div>
      <details className="tp-how">
        <summary>How is the score worked out?</summary>
        <ul>
          <li><b>Due</b> = tasks whose deadline fell in the period. <b>Assigned</b> = orders handed to the person in the period (by auto-assign or an admin).</li>
          <li><b>On time</b> = finished before it turned overdue. For calls that is up to 2 hours after the follow-up was due; dispatch steps use the deadline set in Settings.</li>
          <li><b>Late</b> = finished, but after that. <b>Missed</b> = overdue and still not done. <b>To do</b> = due in the period but not overdue yet; it is not counted against anyone.</li>
          <li><b>Score</b> = (on time + half of late) ÷ tasks due × 100. A task done on time earns 1 point, done late half a point, missed none.</li>
          <li><b>Grades</b>: 90 and above Excellent, 75 to 89 Good, 50 to 74 Needs improvement, below 50 Poor.</li>
          <li>Tasks that are done belong to the person who did them. Tasks still open belong to the person they are assigned to; if nobody holds them they count against the team only.</li>
        </ul>
      </details>
    </>
  );
}

// ---------------------------------------------------------------- the page
export default function TeamDashboard() {
  const f = useTeamFilters();
  const { data, error, loading, reload } = useApi('/desk/team-performance', f.params, f.ready);
  const [open, setOpen] = useState(null);
  const [stamp, setStamp] = useState(null);
  useAutoRefresh(reload, 60);
  useEffect(() => { if (data) setStamp(data.now); }, [data]);

  const t = data && data.team; const pv = data && data.teamPrev;
  const maxTotal = data ? Math.max(1, ...data.people.map((p) => p.total)) : 1;
  const calls = data ? data.people.filter((p) => p.calls > 0 || p.role === 'confirmation') : [];
  const packers = data ? data.people.filter((p) => p.dispatchWork > 0 || p.role === 'packing') : [];
  const hourly = data ? data.hours.map((n, h) => ({ label: `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`, n })) : [];
  const compareLabel = data && data.range.prev ? `vs ${data.range.prev.start === data.range.prev.end ? data.range.prev.start : `${data.range.prev.start} to ${data.range.prev.end}`}` : '';

  return (
    <>
      <FilterBar f={f} range={data && data.range} updated={stamp} onRefresh={reload} busy={loading && !!data} />
      <div className="page tp-page">
        <h1>Team performance</h1>
        <p className="lede">How the team is doing: first, whether tasks are done on time, then the work volume. Every call, confirmation, packing slip, pack and courier handover, counted on the day it was done. Includes the <Link to="/shopify-desk">Shopify desk</Link> and the older sheet-based queues. Click a person to see their detail.</p>
        {!f.ready && <div className="banner">Pick both a “From” and a “To” date (the “To” date cannot be before “From”).</div>}
        <Loading error={error} loading={(loading && !data) || !f.ready}>
          {data && (
            <>
              {t.total === 0 && <div className="banner">No team activity in this period yet. Pick another day, or check back once the team starts working.</div>}

              <Scorecard data={data} compareLabel={compareLabel} />

              <h2 className="sd-h2">Work volume</h2>
              <div className="sd-kpis tp-kpis">
                <Kpi label="Total actions" value={int(t.total)} sub={`${int(t.calls)} calls · ${int(t.dispatchWork)} dispatch steps`} tone="" chip={pv && <Delta cur={t.total} prev={pv.total} />} hint={`All calls and dispatch steps by the team ${compareLabel}`} />
                <Kpi label="Orders won" value={int(t.wins)} sub={`${inr(t.valueWon)} order value${t.partial ? ` · ${int(t.partial)} partial` : ''}`} tone="good" chip={pv && <Delta cur={t.wins} prev={pv.wins} />} hint="Confirmed plus partial-paid orders" />
                <Kpi label="Win rate" value={pct(t.winRate.v)} sub={t.winRate.d ? `${int(t.winRate.n)} of ${int(t.winRate.d)} decisions` : 'No decisions yet'} tone="good" chip={pv && <DeltaChip type="pct" cur={t.winRate} prev={pv.winRate} up="good" />} hint="Of the orders a person finally decided (confirmed, partial or cancelled), the share that were won" />
                <Kpi label="Time to decide" value={ms(t.avgDecisionMs)} sub="Order placed to first decision" tone="warn" chip={pv && pv.avgDecisionMs != null && t.avgDecisionMs != null ? <DeltaChip type="count" cur={t.avgDecisionMs} prev={pv.avgDecisionMs} up="bad" /> : null} hint="Average, for orders decided in this period" />
                <Kpi label="Handed to courier" value={int(t.handover)} sub={`${int(t.packed)} packed · ${int(t.slip)} slips`} tone="violet" chip={pv && <Delta cur={t.handover} prev={pv.handover} />} />
                <Kpi label="Dispatch on time" value={pct(t.onTime.v, 0)} sub={t.onTime.d ? `${int(t.onTime.n)} of ${int(t.onTime.d)} steps · ${int(t.late)} late` : 'No timed steps yet'} tone={t.late ? 'bad' : 'good'} chip={pv && <DeltaChip type="pct" cur={t.onTime} prev={pv.onTime} up="good" />} hint="Packing slip, packed and handover steps finished before their deadline" />
                <Kpi label="Team active" value={`${t.active} of ${t.members}`} sub="members who did any work" hint="Active confirmation and packing team members who did at least one action" />
              </div>

              {(data.attention.length > 0 || data.idle.length > 0) && (
                <div className="tp-attn">
                  {data.attention.length > 0 && (
                    <div className="bad">
                      <b>Needs attention now</b>
                      <span>{data.attention.map((a) => `${a.name}: ${a.overdue} overdue of ${a.assigned} held`).join(' · ')}</span>
                    </div>
                  )}
                  {data.idle.length > 0 && t.total > 0 && (
                    <div>
                      <b>No activity in this period</b>
                      <span>{data.idle.map((a) => a.name).join(', ')}</span>
                    </div>
                  )}
                </div>
              )}

              {data.highlights.length > 0 && (
                <div className="tp-hl">
                  {data.highlights.map((h) => (
                    <div key={h.key} className="card">
                      <small>{h.title}</small>
                      <b>{h.name}</b>
                      <span>{h.valueKind === 'ms' ? `${ms(h.value)} on average` : h.value}</span>
                      {h.note && <em>{h.note}</em>}
                    </div>
                  ))}
                </div>
              )}

              <div className="two tp-charts">
                <div>
                  <h2 className="sd-h2" style={{ marginTop: 0 }}>Work done {data.bucket === 'hour' ? 'hour by hour' : 'day by day'}</h2>
                  <div className="card chart"><ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.trend} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="#e4e7e1" />
                      <XAxis dataKey="label" fontSize={11} tickLine={false} axisLine={false} minTickGap={14} />
                      <YAxis allowDecimals={false} fontSize={12} tickLine={false} axisLine={false} width={36} />
                      <Tooltip cursor={{ fill: 'rgba(0,0,0,.04)' }} />
                      <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="won" name="Orders won" stackId="a" fill="#1c7c6c" />
                      <Bar dataKey="dnp" name="No answer" stackId="a" fill="#c28a1d" />
                      <Bar dataKey="cancelled" name="Cancelled" stackId="a" fill="#b3261e" />
                      <Bar dataKey="dispatch" name="Dispatch steps" stackId="a" fill="#3b4a96" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer></div>
                </div>
                <div>
                  <h2 className="sd-h2" style={{ marginTop: 0 }}>When the team works</h2>
                  <div className="card chart"><ResponsiveContainer width="100%" height="100%">
                    <BarChart data={hourly} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="#e4e7e1" />
                      <XAxis dataKey="label" fontSize={11} tickLine={false} axisLine={false} interval={2} />
                      <YAxis allowDecimals={false} fontSize={12} tickLine={false} axisLine={false} width={36} />
                      <Tooltip cursor={{ fill: 'rgba(0,0,0,.04)' }} formatter={(v) => [v, 'Actions']} />
                      <Bar dataKey="n" name="Actions" fill="#2a7f8e" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer></div>
                </div>
              </div>

              <h2 className="sd-h2">Everyone, ranked by work done</h2>
              <p className="cap">{compareLabel ? `Arrows compare each person with ${compareLabel.replace('vs ', '')}. ` : ''}Win rate = orders won ÷ orders they finally decided. Times are in IST.</p>
              <div className="tp-board">
                {data.people.map((p, i) => (
                  <div key={p.id} className={`tp-row ${open === p.id ? 'open' : ''} ${p.total === 0 ? 'zero' : ''}`}>
                    <button className="tp-line" onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
                      <span className="rank">{p.total > 0 ? i + 1 : '–'}</span>
                      <span className="who"><Avatar p={p} /><span><b>{p.name}</b><Role r={p.role} /></span></span>
                      <span className="bar" title={`${p.total} actions`}>
                        <span className="track"><i style={{ width: `${(p.total / maxTotal) * 100}%`, background: hueOf(p.id) }} /></span>
                        <b>{int(p.total)}</b> <small>actions</small> <Delta cur={p.total} prev={data.teamPrev ? p.prev.total : null} />
                      </span>
                      <span className="m" title={p.winRate.d ? `${p.winRate.n} of ${p.winRate.d}` : ''}><b>{p.winRate.d ? pct(p.winRate.v, 0) : '—'}</b><small>win rate</small></span>
                      <span className="m"><b>{int(p.confirmed + p.partial)}</b><small>won</small></span>
                      <span className="m"><b>{int(p.handover)}</b><small>handed over</small></span>
                      <span className="m"><b>{ms(p.avgDecisionMs)}</b><small>to decide</small></span>
                      <span className="spark"><Spark values={p.series} color={hueOf(p.id)} /></span>
                      <span className="chev" aria-hidden="true">{open === p.id ? '▴' : '▾'}</span>
                    </button>
                    {open === p.id && <PersonDetail p={p} trend={data.trend} bucket={data.bucket} />}
                  </div>
                ))}
                {data.people.length === 0 && <div className="card muted">No team members yet. Add people under <Link to="/settings">Settings</Link>.</div>}
              </div>

              <div className="tp-tables">
                <div>
                  <h2 className="sd-h2" style={{ marginTop: 0 }}>Confirmation team</h2>
                  <p className="cap">The people who call customers and decide orders.</p>
                  <div className="tablewrap"><table className="sd-table">
                    <thead><tr><th>Person</th><th className="num">Calls</th><th className="num">Confirmed</th><th className="num">Partial</th><th className="num">Cancelled</th><th className="num">No answer</th><th className="num">Win rate</th><th className="num">Avg decide</th><th className="num">Value won</th></tr></thead>
                    <tbody>
                      {calls.length === 0 ? <tr><td colSpan={9} className="muted">No calls in this period.</td></tr> : calls.map((p) => (
                        <tr key={p.id}><td><b>{p.name}</b></td><td className="num">{int(p.calls)}</td><td className="num">{int(p.confirmed)}</td><td className="num">{int(p.partial)}</td><td className="num">{int(p.cancelled)}</td><td className="num">{int(p.dnp)}</td>
                          <td className="num" title={p.winRate.d ? `${p.winRate.n} of ${p.winRate.d}` : ''}>{p.winRate.d ? pct(p.winRate.v, 0) : '—'}</td><td className="num">{ms(p.avgDecisionMs)}</td><td className="num">{inr(p.valueWon)}</td></tr>
                      ))}
                      {calls.length > 1 && <tr className="tp-total"><td><b>Team</b></td><td className="num">{int(t.calls)}</td><td className="num">{int(t.confirmed)}</td><td className="num">{int(t.partial)}</td><td className="num">{int(t.cancelled)}</td><td className="num">{int(t.dnp)}</td><td className="num">{t.winRate.d ? pct(t.winRate.v, 0) : '—'}</td><td className="num">{ms(t.avgDecisionMs)}</td><td className="num">{inr(t.valueWon)}</td></tr>}
                    </tbody>
                  </table></div>
                </div>
                <div>
                  <h2 className="sd-h2" style={{ marginTop: 0 }}>Packing team</h2>
                  <p className="cap">Packing slip, then packed with photo, then handed to the courier.</p>
                  <div className="tablewrap"><table className="sd-table">
                    <thead><tr><th>Person</th><th className="num">Slips</th><th className="num">Packed</th><th className="num">Handed over</th><th className="num">On time</th><th className="num">Late</th></tr></thead>
                    <tbody>
                      {packers.length === 0 ? <tr><td colSpan={6} className="muted">No dispatch work in this period.</td></tr> : packers.map((p) => (
                        <tr key={p.id}><td><b>{p.name}</b></td><td className="num">{int(p.slip)}</td><td className="num">{int(p.packed)}</td><td className="num">{int(p.handover)}</td>
                          <td className="num" title={p.onTime.d ? `${p.onTime.n} of ${p.onTime.d}` : ''}>{p.onTime.d ? pct(p.onTime.v, 0) : '—'}</td><td className={`num ${p.late ? 'bad-text' : ''}`}>{int(p.late)}</td></tr>
                      ))}
                      {packers.length > 1 && <tr className="tp-total"><td><b>Team</b></td><td className="num">{int(t.slip)}</td><td className="num">{int(t.packed)}</td><td className="num">{int(t.handover)}</td><td className="num">{t.onTime.d ? pct(t.onTime.v, 0) : '—'}</td><td className="num">{int(t.late)}</td></tr>}
                    </tbody>
                  </table></div>
                </div>
              </div>

              <h2 className="sd-h2">Work waiting right now</h2>
              <p className="cap">Live: not limited to the period above. Orders still open and who is holding them.</p>
              <div className="tp-now">
                <div><b>{int(data.workload.open)}</b><span>open orders</span></div>
                <div className={data.workload.overdue ? 'bad' : ''}><b>{int(data.workload.overdue)}</b><span>overdue</span></div>
                <div className={data.workload.unassigned ? 'hot' : ''}><b>{int(data.workload.unassigned)}</b><span>held by nobody</span></div>
              </div>
              <div className="tablewrap" style={{ marginTop: 12 }}><table className="sd-table">
                <thead><tr><th>Person</th><th>Team</th><th className="num">To confirm</th><th className="num">Pending</th><th className="num">To dispatch</th><th className="num">Overdue</th></tr></thead>
                <tbody>
                  {data.people.filter((p) => p.open.assigned > 0).length === 0
                    ? <tr><td colSpan={6} className="muted">Nothing is assigned to anyone right now. Turn on assignment in the Shopify desk settings to share orders out.</td></tr>
                    : data.people.filter((p) => p.open.assigned > 0).sort((a, b) => b.open.overdue - a.open.overdue || b.open.assigned - a.open.assigned).map((p) => (
                      <tr key={p.id}><td><b>{p.name}</b></td><td>{ROLE_LABEL[p.role] || '—'}</td><td className="num">{int(p.open.confirm)}</td><td className="num">{int(p.open.pending)}</td><td className="num">{int(p.open.dispatch)}</td><td className={`num ${p.open.overdue ? 'bad-text' : ''}`}>{int(p.open.overdue)}</td></tr>
                    ))}
                </tbody>
              </table></div>
            </>
          )}
        </Loading>
      </div>
    </>
  );
}
