import React, { useEffect, useState } from 'react';
import { api, useApi } from '../../api.js';
import { Loading } from '../../components.jsx';
import { Sheet, useToast } from '../../deskUi.jsx';
import { fmtWhen, useAutoRefresh } from '../../flowUi.js';
import { inr, int } from '../../format.js';
import { can, useStaff } from '../../staff.jsx';
import { Empty, OrderDrawer, fmtPhone, notifyDesk, useDebounced, usePager } from '../desk/shared.jsx';
import { CourierPage, NoteField, Stat } from './courierUi.jsx';

const PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['last_week', 'Last week'], ['this_month', 'This month'], ['all_time', 'All time']];
const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const KEY = 'rtoFilters';
const saved = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
const PAGE = 100;
const STATE = { on_way: ['On the way back', 'warn'], at_origin: ['Reached origin, not checked in', 'violet'], received: ['Received', 'good'] };

function ReceiveSheet({ o, onClose, onDone, show }) {
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const undo = o.state === 'received';
  const save = async () => {
    setBusy(true);
    try { await api.post(`/desk/rto/${o.orderId}/received`, { received: !undo, note }); notifyDesk(); show(undo ? `${o.orderName}: received tick removed.` : `${o.orderName} marked as received back.`); onDone(); }
    catch (e) { show(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Sheet title={`${undo ? 'Undo received' : 'Mark received'} · ${o.orderName}`} onClose={onClose}>
      <p className="muted">{o.name || 'No name'} · AWB {o.awb || '—'} · Shipway: {o.shipStatus}</p>
      <p>{undo ? 'Remove the “received” tick? The order goes back to Pending.' : 'Tick this once the returned parcel is physically in your hands.'}</p>
      <NoteField value={note} onChange={setNote} id="rto-note" />
      <button className={`btn big ${undo ? '' : 'good'}`} disabled={busy} onClick={save}>{undo ? 'Remove the tick' : 'Yes, received'}</button>
    </Sheet>
  );
}

export default function RtoPage() {
  const { user } = useStaff();
  const actor = can(user, 'packing');
  const s0 = saved();
  const [win, setWin] = useState(PRESETS.some(([k]) => k === s0.win) || s0.win === 'custom' ? s0.win : 'this_week');
  const [from, setFrom] = useState(s0.from || ''); const [to, setTo] = useState(s0.to || '');
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify({ win, from, to })); } catch { /* fine */ } }, [win, from, to]);
  const custom = win === 'custom'; const ready = !custom || (from && to && from <= to);
  const [show_, setShow] = useState('new');
  const [q, setQ] = useState(''); const qd = useDebounced(q);
  const pager = usePager(0, PAGE, [win, from, to, show_, qd]);
  const params = { window: win, ...(custom ? { from, to } : {}), show: show_, q: qd, page: pager.page, limit: PAGE };
  const { data, error, loading, reload } = useApi('/desk/rto', params, ready);
  useAutoRefresh(reload, 60);
  useEffect(() => { const on = () => reload(); window.addEventListener('desk-refresh', on); return () => window.removeEventListener('desk-refresh', on); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [sheet, setSheet] = useState(null); const [open, setOpen] = useState(null);
  const [toast, show] = useToast();
  const st = data && data.stats;
  const max = todayIst();
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  const periodText = data ? (data.range.start ? (data.range.start === data.range.end ? data.range.start : `${data.range.start} to ${data.range.end}`) : 'all time') : '';
  const CHIPS = [['new', 'New in this period', st && st.newInRange], ['pending', 'Pending (all time)', st && st.pending], ['received', 'Received (all time)', st && st.received], ['all', 'All RTO', st && st.total]];
  return (
    <CourierPage title="RTO & Returns" sub="Parcels coming back to you, taken from Shipway. Tick each one as received once it is physically back, so you always know what is still out there.">
      <div className="topbar tp-bar" style={{ position: 'static', margin: '0 0 12px', padding: 0, background: 'none', border: 0 }}>
        <div className="tp-presets" role="tablist" aria-label="Time period">
          {PRESETS.map(([k, l]) => <button key={k} role="tab" aria-selected={win === k} className={win === k ? 'on' : ''} onClick={() => setWin(k)}>{l}</button>)}
        </div>
        <div className={`tp-dates ${custom ? 'on' : ''}`}>
          <label>From <input type="date" max={max} value={from || (data && data.range.start) || ''} onChange={(e) => { if (!e.target.value) return; setWin('custom'); setFrom(e.target.value); if (!to || to < e.target.value) setTo(e.target.value); }} /></label>
          <label>To <input type="date" max={max} value={to || (data && data.range.end) || ''} onChange={(e) => { if (!e.target.value) return; setWin('custom'); setTo(e.target.value); if (!from || from > e.target.value) setFrom(e.target.value); }} /></label>
        </div>
      </div>
      <div className="sd-stats">
        <Stat label="Total RTO" value={st ? int(st.total) : '–'} sub="All time, from Shipway" tone="" />
        <Stat label="New RTO added" value={st ? int(st.newInRange) : '–'} sub={periodText ? `Started in ${periodText}` : ''} tone="warn" />
        <Stat label="RTO received" value={st ? int(st.received) : '–'} sub={st ? `${int(st.receivedInRange)} received in this period` : ''} tone="good" />
        <Stat label="RTO pending" value={st ? int(st.pending) : '–'} sub={st ? `${int(st.onWay)} on the way · ${int(st.atOrigin)} at origin, not checked in · ${inr(st.pendingValue)} of orders` : ''} tone={st && st.pending ? 'bad' : ''} />
      </div>
      {!ready && <div className="banner">Pick both a “From” and a “To” date.</div>}
      <div className="sd-chips" role="tablist" aria-label="Show">
        {CHIPS.map(([k, l, n]) => <button key={k} role="tab" aria-selected={show_ === k} className={show_ === k ? 'on' : ''} onClick={() => setShow(k)}>{l}<b>{n == null ? '–' : n}</b></button>)}
      </div>
      <div className="filters"><input type="search" placeholder="Search order number, name, phone or AWB" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /></div>
      <Loading error={error} loading={(loading && !data) || !ready}>
        {data && (data.items.length === 0
          ? <Empty title="No RTO orders here">{q || show_ !== 'new' ? 'Try another filter or search.' : 'No parcel started coming back in this period.'}</Empty>
          : (
            <>
              <div className="tablewrap"><table className="sd-table">
                <thead><tr><th>Order</th><th>Customer</th><th>AWB / courier</th><th>Shipway status</th><th>RTO since</th><th className="num">Order value</th><th>Received back?</th></tr></thead>
                <tbody>{data.items.map((o) => {
                  const [label, tone] = STATE[o.state];
                  return (
                    <tr key={o.orderId} className="click" onClick={() => setOpen(o.orderId)}>
                      <td><b>{o.orderName}</b></td>
                      <td>{o.name || '—'}<div className="muted">{[fmtPhone(o.phone), o.city].filter(Boolean).join(' · ')}</div></td>
                      <td>{o.awb || '—'}<div className="muted">{o.courier}</div></td>
                      <td><span className={`cs-tag ${tone}`}>{label}</span><div className="muted">{o.shipStatus}</div></td>
                      <td>{o.since ? fmtWhen(o.since) : '—'}<div className="muted">{o.days == null ? '' : o.days === 0 ? 'today' : `${o.days} day${o.days === 1 ? '' : 's'} ago`}</div></td>
                      <td className="num">{o.total == null ? '—' : inr(o.total)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {o.state === 'received'
                          ? <div>✓ {o.received.by}<div className="muted">{fmtWhen(o.received.at)}{o.received.note ? ` · ${o.received.note}` : ''}</div>{actor && <button className="link" onClick={() => setSheet(o)}>Undo</button>}</div>
                          : actor ? <button className="btn good" onClick={() => setSheet(o)}>Mark received</button> : <span className="muted">Not yet</span>}
                      </td>
                    </tr>);
                })}</tbody>
              </table></div>
              {data.total > PAGE && <div className="pager"><button className="btn ghost" disabled={pager.page <= 1} onClick={() => pager.setPage(pager.page - 1)}>Previous</button><span>Page {pager.page} of {pages}</span><button className="btn ghost" disabled={pager.page >= pages} onClick={() => pager.setPage(pager.page + 1)}>Next</button></div>}
            </>
          ))}
      </Loading>
      {sheet && <ReceiveSheet o={sheet} show={show} onClose={() => setSheet(null)} onDone={() => { setSheet(null); reload(); }} />}
      {open && <OrderDrawer orderId={open} onClose={() => setOpen(null)} />}
      {toast}
    </CourierPage>
  );
}
