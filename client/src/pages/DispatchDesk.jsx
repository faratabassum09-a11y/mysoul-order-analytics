import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../api.js';
import { Loading } from '../components.jsx';
import { AwbScanner, Lightbox, ProofThumb, Sheet, useToast } from '../deskUi.jsx';
import { compressPhoto, duration, fmtTime, fmtWhen, grams, useAutoRefresh, useNow, useServerOffset } from '../flowUi.js';
import { inr } from '../format.js';
import { can, useStaff } from '../staff.jsx';

const SECTIONS = [['print_slip', 'Print slip'], ['ready_for_pickup', 'Ready for pickup'], ['dispatched', 'Dispatched']];
const STAGE_LABEL = { print_slip: 'Print slip', ready_for_pickup: 'Ready for pickup', dispatched: 'Dispatched' };
const normAwb = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

// ---------- Pack: AWB + weight + photo. All three, or no "Packed". ----------
function PackSheet({ order, videoSoon = true, onDone, onClose }) {
  const [awb, setAwb] = useState('');
  const [weight, setWeight] = useState('');
  const [unit, setUnit] = useState('g');
  const [photo, setPhoto] = useState(null);
  const [preview, setPreview] = useState('');
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef(null);
  useEffect(() => () => preview && URL.revokeObjectURL(preview), [preview]);

  const awbOk = /^[A-Z0-9-]{8,24}$/.test(normAwb(awb));
  const wNum = Number(String(weight).replace(/,/g, ''));
  const weightOk = Number.isFinite(wNum) && wNum > 0 && (unit === 'kg' ? wNum * 1000 : wNum) >= 20 && (unit === 'kg' ? wNum * 1000 : wNum) <= 50000;
  const ready = awbOk && weightOk && !!photo && !busy;

  const pick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setErr(''); setBusy('Preparing photo…');
    try {
      const small = await compressPhoto(file);
      setPhoto(small); setPreview(URL.createObjectURL(small));
    } catch (ex) { setErr(ex.message); } finally { setBusy(''); }
  };
  const submit = async () => {
    if (!ready) return;
    setErr(''); setBusy('Uploading…');
    try {
      const fd = new FormData();
      fd.append('awb', normAwb(awb)); fd.append('weight', String(weight)); fd.append('unit', unit); fd.append('photo', photo);
      await api.upload(`/flow/orders/${order.orderId}/pack`, fd);
      onDone();
    } catch (ex) { setErr(ex.message); setBusy(''); }
  };

  return (
    <Sheet title={`Pack order #${order.orderId}`} onClose={busy ? () => {} : onClose}>
      <p className="muted">{order.name} · {order.items || 'Items not loaded'}</p>

      <label className="sheet-label" htmlFor="awb">AWB on the slip</label>
      <div className="scan-row">
        <input id="awb" type="text" autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck="false" value={awb}
          onChange={(e) => setAwb(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} placeholder="Scan or type" />
        <button className="btn ghost" onClick={() => setScan(true)}>Scan</button>
      </div>

      <label className="sheet-label" htmlFor="wt">Weight on the scale</label>
      <div className="scan-row">
        <input id="wt" type="text" inputMode="decimal" autoComplete="off" value={weight} onChange={(e) => setWeight(e.target.value.replace(/[^\d.,]/g, ''))} placeholder={unit === 'kg' ? 'e.g. 0.45' : 'e.g. 450'} />
        <div className="seg" role="radiogroup" aria-label="Weight unit">
          {['g', 'kg'].map((u) => <button key={u} role="radio" aria-checked={unit === u} className={unit === u ? 'on' : ''} onClick={() => setUnit(u)}>{u}</button>)}
        </div>
      </div>

      <label className="sheet-label">Photo of the sealed box on the scale</label>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
      {preview ? (
        <div className="photo-pick">
          <img src={preview} alt="Preview of the sealed box on the scale" />
          <button className="btn ghost" onClick={() => fileRef.current.click()}>Retake photo</button>
        </div>
      ) : <button className="btn big ghost" onClick={() => fileRef.current.click()}>Take photo</button>}
      {videoSoon && <p className="cap">Video proof is coming later.</p>}

      <ul className="checks" aria-label="What is still missing">
        <li className={awbOk ? 'ok' : ''}>AWB {awbOk ? 'added' : 'needed'}</li>
        <li className={weightOk ? 'ok' : ''}>Weight {weightOk ? 'added' : 'needed'}</li>
        <li className={photo ? 'ok' : ''}>Photo {photo ? 'added' : 'needed: no photo, no Packed'}</li>
      </ul>
      {err && <div className="banner err">{err}</div>}
      <button className="btn big good" disabled={!ready} onClick={submit}>{busy || 'Mark as packed'}</button>
      {scan && <AwbScanner onClose={() => setScan(false)} onResult={(v) => { setAwb(v); setScan(false); }} />}
    </Sheet>
  );
}

// ---------- planned-time chip ----------
function PlanChip({ o, now, offset }) {
  if (o.dispatchStage === 'dispatched') {
    return <span className={`chip ${o.onTime === false ? 'bad' : 'good'}`}>{o.onTime === false ? 'Dispatched late' : 'Dispatched on time'}</span>;
  }
  const left = new Date(o.planned).getTime() - (now + offset);
  return left > 0
    ? <span className="chip" title={`Planned for ${fmtWhen(o.planned)}`}>Due {fmtTime(o.planned)} · {duration(left)} left</span>
    : <span className="chip bad" title={`Was planned for ${fmtWhen(o.planned)}`}>Delayed {duration(-left)}</span>;
}

function DeskCard({ o, now, offset, actor, busy, delayReasons, showStage, onSlip, onPack, onDispatch, onReason, onOpenProof }) {
  const delayed = o.dispatchStage !== 'dispatched' && new Date(o.planned).getTime() < now + offset;
  return (
    <article className={`dcard ${delayed ? 'late' : ''}`} id={`o${o.orderId}`}>
      <header>
        <div>
          <div className="q-id">#{o.orderId} <span className="muted">· {o.paymentMode}{o.partial ? ` · ${inr(o.partial.amount)} paid` : ''}</span></div>
          <div className="q-name">{o.name || 'No name'}{o.city ? <span className="muted"> · {o.city}</span> : null}</div>
        </div>
        <PlanChip o={o} now={now} offset={offset} />
      </header>
      <div className="q-meta"><span className="q-amt">{inr(o.amount)}</span><span className="q-items" title={o.items}>{o.items || 'Items not loaded'}</span></div>
      <div className="q-flags">
        {showStage && <span className="chip">{STAGE_LABEL[o.dispatchStage]}</span>}
        <span className="muted">Confirmed {fmtWhen(o.confirmedAt)}</span>
        {o.awb && <span className="chip mono">AWB {o.awb}</span>}
        {o.weightG != null && <span className="chip">{grams(o.weightG)}</span>}
      </div>

      {o.proofs && o.proofs.length > 0 && (
        <div className="proof-row">{o.proofs.map((p) => <ProofThumb key={p.id} id={p.id} kind={p.kind} onOpen={() => onOpenProof(o, p.id)} />)}</div>
      )}
      {o.dispatchStage === 'ready_for_pickup' && <p className="cap">Packed by {o.packedByName} at {fmtWhen(o.packedAt)}.</p>}
      {o.dispatchStage === 'dispatched' && <p className="cap">Dispatched by {o.dispatchedByName} at {fmtWhen(o.dispatchedAt)}.</p>}
      {o.dispatchStage === 'print_slip' && o.slipPrintedAt && <p className="cap">Slip printed by {o.slipPrintedByName} at {fmtWhen(o.slipPrintedAt)}.</p>}

      {actor && delayed && delayReasons && (
        <select className="reason-select" aria-label="Why is this delayed?" value={o.delayReason || ''} disabled={busy} onChange={(e) => e.target.value && onReason(o, e.target.value)}>
          <option value="">Why is it delayed?</option>
          {delayReasons.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      )}
      {actor && o.dispatchStage === 'print_slip' && (
        <div className="acts one">
          {!o.slipPrintedAt
            ? <button className="btn big" disabled={busy} onClick={() => onSlip(o)}>Slip printed</button>
            : <button className="btn big good" disabled={busy} onClick={() => onPack(o)}>Scan, weigh and pack</button>}
        </div>
      )}
      {actor && o.dispatchStage === 'ready_for_pickup' && (
        <div className="acts one"><button className="btn big good" disabled={busy} onClick={() => onDispatch(o)}>Mark dispatched</button></div>
      )}
    </article>
  );
}

export default function DispatchDesk() {
  const { user } = useStaff();
  const actor = can(user, 'packing');
  const [section, setSection] = useState('print_slip');
  const [days, setDays] = useState(3);
  const [q, setQ] = useState('');
  const [scan, setScan] = useState(false);
  const [packing, setPacking] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, show] = useToast();
  const { data, error, loading, reload } = useApi('/flow/dispatch', { section, days });
  useAutoRefresh(reload, 30);
  const offset = useServerOffset(data && data.now);
  const now = useNow(1000);
  const [counts, setCounts] = useState(null);
  useEffect(() => { if (data) setCounts(data.counts); }, [data]);

  const current = data && data.section === section ? data : null; // never show the previous tab's list under a new tab
  const items = useMemo(() => {
    if (!current) return [];
    const t = normAwb(q).replace(/^#/, '');
    if (!t) return current.items;
    return current.items.filter((o) => String(o.orderId) === t || normAwb(o.awb).includes(t) || String(o.name || '').toUpperCase().includes(t));
  }, [current, q]);

  const run = async (fn) => { setBusy(true); try { await fn(); } catch (e) { show(e.message, 'err'); } finally { setBusy(false); reload(); } };
  const slip = (o) => run(async () => { await api.post(`/flow/orders/${o.orderId}/slip`, {}); show(`#${o.orderId}: slip printed. Next, scan, weigh and pack.`); });
  const dispatch = (o) => run(async () => { const r = await api.post(`/flow/orders/${o.orderId}/dispatch`, {}); show(`#${o.orderId} dispatched${r.onTime === false ? ' (after the 24 h plan)' : ''}.`); });
  const reason = (o, k) => run(async () => { await api.post(`/flow/orders/${o.orderId}/delay-reason`, { reason: k }); show(`#${o.orderId}: delay reason saved.`); });
  const openProof = (o, id) => setLightbox({ items: o.proofs.map((p) => ({ ...p, awb: o.awb, weightG: o.weightG, by: o.packedByName })), id });

  const delayedN = counts ? counts.delayed : 0;
  const inDelayed = section === 'delayed';

  return (
    <div className="page desk">
      <h1>Dispatch desk</h1>
      <p className="lede">Orders arrive here once they are confirmed. Each section is planned for 24 hours after confirmation.</p>

      {user == null && <div className="banner">You are viewing as the dashboard. To act on orders, sign in with your own login on the <Link to="/team">team sign-in page</Link>.</div>}

      {delayedN > 0 && !inDelayed && (
        <button className="delayed-btn" onClick={() => setSection('delayed')}>
          <b>{delayedN}</b> delayed {delayedN === 1 ? 'order' : 'orders'}: check now
        </button>
      )}

      {inDelayed ? (
        <div className="delayed-head">
          <button className="btn ghost" onClick={() => setSection('print_slip')}>Back to the desk</button>
          <span><b>Delayed orders</b> · confirmed over 24 hours ago and not yet dispatched, oldest first</span>
        </div>
      ) : (
        <div className="tabs" role="tablist" aria-label="Dispatch sections">
          {SECTIONS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={section === k} className={section === k ? 'on' : ''} onClick={() => setSection(k)}>
              {l}<b>{counts ? counts[k] : '–'}</b>
            </button>
          ))}
        </div>
      )}

      <div className="desk-tools">
        <div className="scan-row">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find by AWB, order number or name" aria-label="Find an order" />
          <button className="btn ghost" onClick={() => setScan(true)}>Scan</button>
        </div>
        {section === 'dispatched' && (
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Dispatched in the last">
            <option value={1}>Last 24 hours</option><option value={3}>Last 3 days</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option>
          </select>
        )}
      </div>

      <Loading error={error} loading={!current && loading}>
        {current && (items.length === 0 ? (
          <div className="empty">
            {q ? 'No order matches that search.'
              : inDelayed ? 'Nothing is delayed. Every confirmed order is within its 24 hour plan.'
              : section === 'print_slip' ? 'No orders waiting for a slip. Orders appear here after they are confirmed in the Confirm queue.'
              : section === 'ready_for_pickup' ? 'No packed orders waiting for pickup.'
              : 'Nothing dispatched in this period.'}
          </div>
        ) : (
          <div className="qlist">
            {items.map((o) => (
              <DeskCard key={o.orderId} o={o} now={now} offset={offset} actor={actor} busy={busy} showStage={inDelayed}
                delayReasons={current.delayReasons} onSlip={slip} onPack={setPacking} onDispatch={dispatch} onReason={reason} onOpenProof={openProof} />
            ))}
          </div>
        ))}
      </Loading>

      {packing && <PackSheet order={packing} onClose={() => setPacking(null)} onDone={() => { show(`#${packing.orderId} packed. Moved to Ready for pickup.`); setPacking(null); reload(); }} />}
      {scan && <AwbScanner onClose={() => setScan(false)} onResult={(v) => { setQ(v); setScan(false); }} />}
      {lightbox && <Lightbox items={lightbox.items} startId={lightbox.id} onClose={() => setLightbox(null)} />}
      {toast}
    </div>
  );
}
