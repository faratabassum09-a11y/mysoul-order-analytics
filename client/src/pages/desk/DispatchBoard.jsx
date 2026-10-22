import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../../api.js';
import { Loading } from '../../components.jsx';
import { Sheet, useToast } from '../../deskUi.jsx';
import { duration, fmtWhen, useAutoRefresh } from '../../flowUi.js';
import { inr } from '../../format.js';
import { can, useStaff } from '../../staff.jsx';
import { AssigneeRow, Empty, MultiPhotoField, OrderDrawer, PayTag, WhoFilter, Workload, notifyDesk, peopleFor, useAssign, useClock, useDebounced, useLabels, useTeam } from './shared.jsx';

// The three columns of the Dispatch queue, left to right. "done" is the button label on the card.
const COLS = [
  { key: 'slip', label: 'stepSlip', hint: () => 'Print the slip and stick it on the box.' },
  { key: 'packed', label: 'stepPacked', hint: (L) => `Pack the box. ${L('btnDone')} asks for photos of the package. The AWB comes from Shipway.` },
  { key: 'handover', label: 'stepHandover', hint: (L) => `Courier collects. ${L('btnDone')} asks for photos of the manifest.` },
];
const hm = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const whenLabel = (conf) => (conf.dayOffset === 0 ? `Working day ${hm(conf.dueTime)}` : `${conf.dayOffset} working day${conf.dayOffset === 1 ? '' : 's'} later, ${hm(conf.dueTime)}`);

// "Due Mon 12:00 PM · in 2h 10m" / "Overdue 1h 05m"
function Due({ dueAt, now, offset }) {
  if (!dueAt) return null;
  const ms = new Date(dueAt).getTime() - (now + offset);
  const when = new Date(dueAt).toLocaleString('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  if (ms >= 0) return <span className="sd-due wait" title={`Due ${fmtWhen(dueAt)}`}>{when} · in {duration(ms)}</span>;
  return <span className="sd-due late" title={`Was due ${fmtWhen(dueAt)}`}>Overdue {duration(-ms)}</span>;
}

function Card({ o, col, title, now, offset, canAct, busy, picked, onPick, onDone, onOpen, assign }) {
  const { L } = useLabels();
  const late = o.dq.dueAt && new Date(o.dq.dueAt).getTime() < now + offset;
  const awb = col.key === 'packed' ? o.dq.suggestedAwb : col.key === 'handover' && o.dq.packed ? o.dq.packed.awb : '';
  const courier = col.key === 'packed' ? o.dq.suggestedCourier : col.key === 'handover' && o.dq.packed ? o.dq.packed.courier : '';
  return (
    <article className={`sd-card dispatch dq-card ${late ? 'late' : ''}`} aria-label={`${o.orderName}, ${title}`}>
      <header>
        <div className="sd-id">
          {col.key === 'handover' && canAct && <input type="checkbox" className="dq-pick" checked={picked} onChange={() => onPick(o.orderId)} aria-label={`Select ${o.orderName} for the manifest`} />}
          <button className="link" onClick={() => onOpen(o.orderId)}>{o.orderName}</button>
          <PayTag o={o} />{o.partial && <span className="sd-pay part">{L('payPartial')}</span>}
        </div>
        <Due dueAt={o.dq.dueAt} now={now} offset={offset} />
      </header>
      <div className="sd-who"><b>{o.name || 'No name'}</b>{o.city ? <span className="muted"> · {o.city}</span> : null}</div>
      <div className="sd-line"><span className="sd-amt">{inr(o.total)}</span><span className="sd-items" title={o.items}>{o.items || 'Items not loaded'}</span></div>
      {col.key !== 'slip' && (awb ? <div className="sd-foot"><span>AWB <b>{awb}</b>{courier ? ` · ${courier}` : ''}</span></div> : <div className="sd-foot warn"><span>AWB not in Shipway yet</span></div>)}
      {o.collect > 0 && <div className="sd-foot"><span className="sd-collect-tag">Collect {inr(o.collect)}</span></div>}
      {assign && <AssigneeRow o={o} {...assign} />}
      {canAct && <div className="sd-actions"><button className="btn good dq-done" disabled={busy} onClick={() => onDone(o, col.key)}>{L('btnDone')}</button></div>}
    </article>
  );
}

// ---------------------------------------------------------------- forms
// Order packed: the AWB and courier are read from Shipway and shown, not typed. No photos are needed.
function PackedSheet({ order: o, conf, show, onClose, onDone }) {
  const { L } = useLabels();
  const [live, setLive] = useState({ awb: o.dq.suggestedAwb || '', courier: o.dq.suggestedCourier || '', looking: true, allowManual: !!conf.allowManualAwb, shipwayConfigured: true });
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const look = async () => { // ask Shipway again right now: the label may have been made a minute ago
    setLive((x) => ({ ...x, looking: true }));
    try { const r = await api.get(`/desk/dispatch/${o.orderId}/awb`); setLive({ awb: r.awb || '', courier: r.courier || '', looking: false, allowManual: r.allowManual, shipwayConfigured: r.shipwayConfigured }); }
    catch { setLive((x) => ({ ...x, looking: false })); }
  };
  useEffect(() => { look(); }, [o.orderId]); // eslint-disable-line react-hooks/exhaustive-deps
  const awb = live.awb || (live.allowManual ? manual : '');
  const submit = async () => {
    setBusy(true);
    try {
      const fd = new FormData();
      if (!live.awb) fd.append('awb', manual); // only used when Shipway has none
      await api.upload(`/desk/dispatch/${o.orderId}/packed`, fd);
      notifyDesk(); show(`${o.orderName} packed. It is now in ${L('stepHandover')}.`); onDone();
    } catch (e) { show(e.message, 'err'); if (e.status === 409 && !/AWB/.test(e.message)) onDone(); } finally { setBusy(false); }
  };
  const ready = awb.replace(/\s/g, '').length >= 5;
  return (
    <Sheet title={`${L('stepPacked')} · ${o.orderName}`} onClose={onClose}>
      <p className="muted">{o.name || 'No name'} · {inr(o.total)}</p>
      <div className="awb-box">
        <div><span>AWB number</span><b>{live.awb || (live.looking ? 'Checking Shipway…' : '—')}</b></div>
        <div><span>Courier</span><b>{live.courier || (live.looking ? '' : '—')}</b></div>
        <small className="muted">{live.awb ? 'Filled from Shipway. Nothing to type.' : live.looking ? 'Asking Shipway for this order…' : !live.shipwayConfigured ? 'Shipway is not connected on the server.' : 'Shipway has no AWB for this order yet.'}</small>
        {!live.awb && !live.looking && <button className="btn ghost" onClick={look}>Fetch from Shipway again</button>}
      </div>
      {!live.awb && !live.looking && (live.allowManual
        ? <><label className="sheet-label" htmlFor="pk-awb">Type the AWB from the label (only because Shipway has none yet)</label><input id="pk-awb" type="text" autoCapitalize="characters" autoComplete="off" maxLength={40} value={manual} onChange={(e) => setManual(e.target.value)} placeholder="AWB number" /></>
        : <div className="banner">Wait for the shipment to be created in Shipway, then press “Fetch from Shipway again”.</div>)}
      <button className="btn big good" disabled={busy || !ready} onClick={submit}>{busy ? 'Saving…' : !awb.trim() ? 'Waiting for the AWB from Shipway' : `Save: ${L('stepPacked').toLowerCase()}`}</button>
    </Sheet>
  );
}

// Order handover: photos of the manifest. One manifest can cover several orders.
function HandoverSheet({ orders, conf, show, onClose, onDone }) {
  const { L } = useLabels();
  const [files, setFiles] = useState([]); const [busy, setBusy] = useState(false);
  const courier = useMemo(() => { const c = [...new Set(orders.map((o) => (o.dq.packed && o.dq.packed.courier) || '').filter(Boolean))]; return c.length === 1 ? c[0] : ''; }, [orders]);
  const need = conf.stages.handover.requirePhoto;
  const submit = async () => {
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('orderIds', JSON.stringify(orders.map((o) => o.orderId))); fd.append('courier', courier); files.forEach((f) => fd.append('manifests', f));
      const r = await api.upload('/desk/dispatch/handover', fd);
      notifyDesk();
      if (r.failed && r.failed.length) show(`${r.done.length} handed over. ${r.failed.length} could not be saved: ${r.failed.map((f) => `#${f.orderId}`).join(', ')}.`, 'err');
      else show(`${r.done.length === 1 ? orders[0].orderName : `${r.done.length} orders`} handed over. See ${L('tabTransit')}.`);
      onDone();
    } catch (e) { show(e.message, 'err'); if (e.status === 409) onDone(); } finally { setBusy(false); }
  };
  return (
    <Sheet title={orders.length === 1 ? `${L('stepHandover')} · ${orders[0].orderName}` : `${L('stepHandover')} · ${orders.length} orders`} onClose={onClose}>
      <ul className="dq-list">{orders.map((o) => <li key={o.orderId}><b>{o.orderName}</b><span>{o.dq.packed ? `AWB ${o.dq.packed.awb}` : ''}</span></li>)}</ul>
      <MultiPhotoField label="Photos of the manifest" files={files} setFiles={setFiles} required={need} />
      <p className="muted">After this the {orders.length === 1 ? 'order moves' : 'orders move'} to {L('tabTransit')}, where Shipway tracking is fetched.</p>
      <button className="btn big good" disabled={busy || (need && !files.length)} onClick={submit}>{busy ? 'Saving…' : need && !files.length ? 'Add a manifest photo to save' : 'Save: handed over'}</button>
    </Sheet>
  );
}

// ---------------------------------------------------------------- page
export default function DispatchBoard() {
  const { user } = useStaff();
  const { L } = useLabels();
  const actor = can(user, 'packing');
  const isAdmin = user.role === 'admin';
  const team = useTeam(); const people = peopleFor(team, 'dispatch');
  const [q, setQ] = useState(''); const qd = useDebounced(q);
  const [who, setWho] = useState('');
  const { data, error, loading, reload } = useApi('/desk/dispatch/board', { q: qd, assignee: who });
  useAutoRefresh(reload, 20);
  useEffect(() => { const on = () => reload(); window.addEventListener('desk-refresh', on); return () => window.removeEventListener('desk-refresh', on); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { now, offset } = useClock(data && data.now);
  const [toast, show] = useToast();
  const [open, setOpen] = useState(null);
  const assign = useAssign({ reload, show });
  const [packing, setPacking] = useState(null); const [handing, setHanding] = useState(null);
  const [picked, setPicked] = useState([]); const [busyId, setBusyId] = useState(null);
  const conf = data && data.config;
  const c = data && data.counts;
  const handover = data ? data.columns.handover : [];
  useEffect(() => { setPicked((p) => p.filter((id) => handover.some((o) => o.orderId === id))); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const done = async (o, key) => {
    if (key === 'packed') return setPacking(o);
    if (key === 'handover') return setHanding([o]);
    setBusyId(o.orderId);
    try { await api.post(`/desk/dispatch/${o.orderId}/slip`); notifyDesk(); show(`${o.orderName}: packing slip done. It is now in Order packed.`); reload(); }
    catch (e) { show(e.message, 'err'); if (e.status === 409) reload(); } finally { setBusyId(null); }
  };
  const finish = (setter) => () => { setter(null); setPicked([]); reload(); };

  return (
    <section>
      <div className="dq-head">
        <p className="sd-hint">Confirmed orders land in Packing slip. Press {L('btnDone')} on a card to move it to the next column; each column has its own deadline.</p>
        {user.role === 'admin' && <Link className="btn ghost" to="/shopify-desk/settings#dispatch">⚙ Dispatch settings</Link>}
      </div>
      <div className="filters"><input type="search" placeholder="Search order number, name or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /><span className="grow" />
        <WhoFilter value={who} onChange={setWho} people={isAdmin ? people : []} show={!!data && (Object.values(data.assign.modes).some((m) => m !== 'off') || !!who)} />
        {data && <span className="muted">{data.shown} {data.shown === 1 ? 'order' : 'orders'}{c && c.overdue ? ` · ${c.overdue} overdue` : ''}{data.collectTotal ? ` · ${inr(data.collectTotal)} to collect on delivery` : ''}</span>}</div>
      <Loading error={error} loading={loading && !data}>
        {data && (
          <div className="dq-board">
            {COLS.map((col) => {
              const items = data.columns[col.key];
              const st = conf.stages[col.key];
              return (
                <div key={col.key} className={`dq-col ${col.key}`}>
                  <div className="dq-colhead">
                    <div className="dq-title"><h2>{L(col.label)}</h2><span className={`sd-count ${c.overdueBy[col.key] ? 'hot' : ''}`} title={c.overdueBy[col.key] ? `${c.overdueBy[col.key]} overdue` : ''}>{items.length}</span>
                      {user.role === 'admin' && <Link className="dq-gear" to="/shopify-desk/settings#dispatch" title={`${L(col.label)} settings`} aria-label={`${L(col.label)} settings`}>⚙</Link>}</div>
                    <span className="dq-when">{whenLabel(st)}</span>
                    <small>{col.hint(L)}</small>
                    {data.assign.modes[col.key] !== 'off' && <span className="dq-when asg">{data.assign.modes[col.key] === 'auto' ? 'Shared out automatically' : 'Assigned by an admin'}</span>}
                    {data.assign.modes[col.key] !== 'off' && isAdmin && <Workload items={items} />}
                    {col.key === 'handover' && actor && items.length > 0 && (
                      <div className="dq-bulk">
                        <button className="btn ghost" onClick={() => setPicked(picked.length === items.length ? [] : items.map((o) => o.orderId))}>{picked.length === items.length ? 'Clear' : 'Select all'}</button>
                        <button className="btn good" disabled={!picked.length} onClick={() => setHanding(items.filter((o) => picked.includes(o.orderId)))}>Hand over selected ({picked.length})</button>
                      </div>
                    )}
                  </div>
                  <div className="dq-cards">
                    {items.length === 0
                      ? <Empty title="Nothing here">{col.key === 'slip' ? (q ? 'No orders match this search.' : 'Confirmed orders appear here the moment someone taps Confirmed.') : 'Cards arrive here when DONE is pressed in the column before.'}</Empty>
                      : items.map((o) => <Card key={o.orderId} o={o} col={col} title={L(col.label)} assign={data.assign.modes[col.key] !== 'off' ? { mode: data.assign.modes[col.key], isAdmin, me: user.id, people, onAssign: assign } : null} now={now} offset={offset} canAct={actor} busy={busyId === o.orderId} picked={picked.includes(o.orderId)} onPick={pick} onDone={done} onOpen={setOpen} />)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Loading>
      {packing && <PackedSheet order={packing} conf={conf} show={show} onClose={() => setPacking(null)} onDone={finish(setPacking)} />}
      {handing && <HandoverSheet orders={handing} conf={conf} show={show} onClose={() => setHanding(null)} onDone={finish(setHanding)} />}
      {open && <OrderDrawer orderId={open} onClose={() => setOpen(null)} />}
      {toast}
    </section>
  );
}
