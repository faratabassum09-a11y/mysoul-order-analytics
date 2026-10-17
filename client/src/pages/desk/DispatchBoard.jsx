import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../../api.js';
import { Loading } from '../../components.jsx';
import { Sheet, useToast } from '../../deskUi.jsx';
import { compressPhoto, duration, fmtWhen, useAutoRefresh } from '../../flowUi.js';
import { inr } from '../../format.js';
import { can, useStaff } from '../../staff.jsx';
import { CopyButton, Empty, Lightbox, OrderDrawer, PayTag, ProofImg, addressBlock, fmtPhone, notifyDesk, useClock, useDebounced } from './shared.jsx';

// The three columns of the Dispatch queue, left to right. "done" is the button label on the card.
const COLS = [
  { key: 'slip', title: 'Packing slip', hint: 'Print the slip and stick it on the box.' },
  { key: 'packed', title: 'Order packed', hint: 'Pack the box. DONE asks for the AWB and a photo of the package.' },
  { key: 'handover', title: 'Order handover', hint: 'Courier collects. DONE asks for a photo of the manifest.' },
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

function Card({ o, col, now, offset, canAct, busy, picked, onPick, onDone, onOpen }) {
  const late = o.dq.dueAt && new Date(o.dq.dueAt).getTime() < now + offset;
  return (
    <article className={`sd-card dispatch dq-card ${late ? 'late' : ''}`} aria-label={`${o.orderName}, ${col.title}`}>
      <header>
        <div className="sd-id">
          {col.key === 'handover' && canAct && <input type="checkbox" className="dq-pick" checked={picked} onChange={() => onPick(o.orderId)} aria-label={`Select ${o.orderName} for the manifest`} />}
          <button className="link" onClick={() => onOpen(o.orderId)}>{o.orderName}</button>
          <PayTag o={o} />{o.partial && <span className="sd-pay part">Partial paid</span>}
        </div>
        <Due dueAt={o.dq.dueAt} now={now} offset={offset} />
      </header>
      <div className="sd-who"><b>{o.name || 'No name'}</b>{o.city ? <span className="muted"> · {o.city}{o.state ? `, ${o.state}` : ''}</span> : null}</div>
      <div className="sd-line"><span className="sd-amt">{inr(o.total)}</span><span className="sd-items" title={o.items}>{o.items || 'Items not loaded'}</span></div>
      {col.key === 'slip' && <div className="sd-addr">{o.address || 'No address'}</div>}
      <div className={`sd-collect ${o.collect > 0 ? 'cod' : 'paid'}`}>{o.collect > 0 ? <>Collect <b>{inr(o.collect)}</b> on delivery</> : 'Fully paid: nothing to collect'}</div>
      {col.key === 'handover' && o.dq.packed && (
        <div className="sd-foot"><span>AWB <b>{o.dq.packed.awb}</b>{o.dq.packed.courier ? ` · ${o.dq.packed.courier}` : ''}</span><span>Packed {fmtWhen(o.dq.packed.at)} by {o.dq.packed.byName}</span></div>
      )}
      {col.key === 'handover' && o.dq.packed && o.dq.packed.photoId && <ProofImg id={o.dq.packed.photoId} alt="Photo of the package" onOpen={(src, t) => onOpen(null, { src, title: t })} />}
      {col.key === 'packed' && o.dq.slip && <div className="sd-foot"><span>Slip done {fmtWhen(o.dq.slip.at)} by {o.dq.slip.byName}</span></div>}
      <div className="sd-actions">
        {col.key === 'slip' && <CopyButton text={addressBlock(o)} label="Copy address" />}
        {canAct && <button className="btn good dq-done" disabled={busy} onClick={() => onDone(o, col.key)}>DONE</button>}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- forms
function PhotoField({ id, label, file, setFile, required }) {
  const [preview, setPreview] = useState(null); const [err, setErr] = useState('');
  useEffect(() => () => preview && URL.revokeObjectURL(preview), [preview]);
  const pick = async (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    setErr('');
    try { const c = await compressPhoto(f); setFile(c); setPreview(URL.createObjectURL(c)); } catch (x) { setErr(x.message); setFile(null); }
  };
  return (
    <>
      <label className="sheet-label" htmlFor={id}>{label}{required ? '' : ' (optional)'}</label>
      <input id={id} type="file" accept="image/*" capture="environment" onChange={pick} />
      {preview && <div className="photo-pick"><img src={preview} alt={label} /></div>}
      {err && <div className="banner err">{err}</div>}
    </>
  );
}

// Order packed -> form: AWB (filled from Shopify, editable) + photo of the package
function PackedSheet({ order: o, conf, show, onClose, onDone }) {
  const [awb, setAwb] = useState(o.dq.suggestedAwb || '');
  const [courier, setCourier] = useState(o.dq.suggestedCourier || '');
  const [source, setSource] = useState(o.dq.suggestedAwb ? (o.shipway && o.shipway.awb === o.dq.suggestedAwb ? 'Shipway' : 'Shopify') : null);
  const [looking, setLooking] = useState(true);
  const [file, setFile] = useState(null); const [busy, setBusy] = useState(false);
  const need = conf.stages.packed.requirePhoto;
  useEffect(() => { // ask Shopify again right now: the label may have been made a minute ago
    let live = true;
    api.get(`/desk/dispatch/${o.orderId}/awb`).then((r) => { if (!live || !r.awb) return; setAwb((cur) => cur || r.awb); setCourier((cur) => cur || r.courier || ''); setSource((cur) => cur || r.source); }, () => {}).finally(() => live && setLooking(false));
    return () => { live = false; };
  }, [o.orderId]);
  const submit = async () => {
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('awb', awb); fd.append('courier', courier); if (file) fd.append('photo', file);
      await api.upload(`/desk/dispatch/${o.orderId}/packed`, fd);
      notifyDesk(); show(`${o.orderName} packed. It is now in Order handover.`); onDone();
    } catch (e) { show(e.message, 'err'); if (e.status === 409 && !/AWB/.test(e.message)) onDone(); } finally { setBusy(false); }
  };
  const ready = awb.replace(/\s/g, '').length >= 5 && (!need || file);
  return (
    <Sheet title={`Order packed · ${o.orderName}`} onClose={onClose}>
      <p className="muted">{o.name || 'No name'} · {inr(o.total)}</p>
      <label className="sheet-label" htmlFor="pk-awb">AWB number</label>
      <input id="pk-awb" type="text" autoCapitalize="characters" autoComplete="off" maxLength={40} value={awb} onChange={(e) => setAwb(e.target.value)} placeholder={looking ? 'Looking in Shopify…' : 'Scan or type the AWB'} />
      <small className="muted">{awb && source ? `Filled from ${source}. Check it against the label.` : looking ? 'Looking for the AWB in Shopify…' : 'Shopify has no AWB for this order yet. Type it from the label.'}</small>
      <label className="sheet-label" htmlFor="pk-co">Courier (optional)</label>
      <input id="pk-co" type="text" maxLength={60} value={courier} onChange={(e) => setCourier(e.target.value)} />
      <PhotoField id="pk-photo" label="Photo of the package" file={file} setFile={setFile} required={need} />
      <button className="btn big good" disabled={busy || !ready} onClick={submit}>{busy ? 'Saving…' : !awb.trim() ? 'Enter the AWB to save' : need && !file ? 'Take the package photo to save' : 'Save: order packed'}</button>
    </Sheet>
  );
}

// Order handover -> form: photo of the manifest. One manifest can cover several orders.
function HandoverSheet({ orders, conf, show, onClose, onDone }) {
  const [file, setFile] = useState(null); const [busy, setBusy] = useState(false);
  const courier = useMemo(() => { const c = [...new Set(orders.map((o) => (o.dq.packed && o.dq.packed.courier) || '').filter(Boolean))]; return c.length === 1 ? c[0] : ''; }, [orders]);
  const need = conf.stages.handover.requirePhoto;
  const submit = async () => {
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('orderIds', JSON.stringify(orders.map((o) => o.orderId))); fd.append('courier', courier); if (file) fd.append('manifest', file);
      const r = await api.upload('/desk/dispatch/handover', fd);
      notifyDesk();
      if (r.failed && r.failed.length) show(`${r.done.length} handed over. ${r.failed.length} could not be saved: ${r.failed.map((f) => `#${f.orderId}`).join(', ')}.`, 'err');
      else show(`${r.done.length === 1 ? orders[0].orderName : `${r.done.length} orders`} handed over. See In-transit orders.`);
      onDone();
    } catch (e) { show(e.message, 'err'); if (e.status === 409) onDone(); } finally { setBusy(false); }
  };
  return (
    <Sheet title={orders.length === 1 ? `Order handover · ${orders[0].orderName}` : `Order handover · ${orders.length} orders`} onClose={onClose}>
      <ul className="dq-list">{orders.map((o) => <li key={o.orderId}><b>{o.orderName}</b><span>{o.dq.packed ? `AWB ${o.dq.packed.awb}` : ''}</span></li>)}</ul>
      <PhotoField id="ho-photo" label="Photo of the manifest" file={file} setFile={setFile} required={need} />
      <p className="muted">After this the {orders.length === 1 ? 'order moves' : 'orders move'} to In-transit orders, where Shipway tracking is fetched.</p>
      <button className="btn big good" disabled={busy || (need && !file)} onClick={submit}>{busy ? 'Saving…' : need && !file ? 'Upload the manifest photo to save' : 'Save: handed over'}</button>
    </Sheet>
  );
}

// ---------------------------------------------------------------- page
export default function DispatchBoard() {
  const { user } = useStaff();
  const actor = can(user, 'packing');
  const [q, setQ] = useState(''); const qd = useDebounced(q);
  const { data, error, loading, reload } = useApi('/desk/dispatch/board', { q: qd });
  useAutoRefresh(reload, 20);
  useEffect(() => { const on = () => reload(); window.addEventListener('desk-refresh', on); return () => window.removeEventListener('desk-refresh', on); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { now, offset } = useClock(data && data.now);
  const [toast, show] = useToast();
  const [open, setOpen] = useState(null); const [look, setLook] = useState(null);
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
  const open_ = (id, proof) => (proof ? setLook(proof) : setOpen(id));
  const finish = (setter) => () => { setter(null); setPicked([]); reload(); };

  return (
    <section>
      <div className="dq-head">
        <p className="sd-hint">Confirmed orders land in Packing slip. Press DONE on a card to move it to the next column; each column has its own deadline.</p>
        {user.role === 'admin' && <Link className="btn ghost" to="/shopify-desk/settings#dispatch">⚙ Dispatch settings</Link>}
      </div>
      <div className="filters"><input type="search" placeholder="Search order number, name or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /><span className="grow" />
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
                    <div className="dq-title"><h2>{col.title}</h2><span className={`sd-count ${c.overdueBy[col.key] ? 'hot' : ''}`} title={c.overdueBy[col.key] ? `${c.overdueBy[col.key]} overdue` : ''}>{items.length}</span>
                      {user.role === 'admin' && <Link className="dq-gear" to="/shopify-desk/settings#dispatch" title={`${col.title} settings`} aria-label={`${col.title} settings`}>⚙</Link>}</div>
                    <span className="dq-when">{whenLabel(st)}</span>
                    <small>{col.hint}</small>
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
                      : items.map((o) => <Card key={o.orderId} o={o} col={col} now={now} offset={offset} canAct={actor} busy={busyId === o.orderId} picked={picked.includes(o.orderId)} onPick={pick} onDone={done} onOpen={open_} />)}
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
      {look && <Lightbox src={look.src} title={look.title} onClose={() => setLook(null)} />}
      {toast}
    </section>
  );
}
