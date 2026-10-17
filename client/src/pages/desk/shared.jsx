import React, { useCallback, useEffect, useState } from 'react';
import { api, deskProofUrl, deskShotUrl, useApi } from '../../api.js';
import { Sheet } from '../../deskUi.jsx';
import { compressPhoto, duration, fmtWhen, useNow, useServerOffset } from '../../flowUi.js';
import { inr } from '../../format.js';

export const notifyDesk = () => window.dispatchEvent(new Event('desk-changed'));

// Live counts for the tab bar and the sidebar badge. Refreshes every 30 s and right after any action.
export function useDeskCounts() {
  const [counts, setCounts] = useState(null);
  const load = useCallback(() => api.get('/desk/counts').then(setCounts, () => {}), []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 30000);
    window.addEventListener('desk-changed', load);
    return () => { clearInterval(t); window.removeEventListener('desk-changed', load); };
  }, [load]);
  return counts;
}

export const useDeskConfig = () => useApi('/desk/config').data;

// ---------------------------------------------------------------- small pieces
export const STAGE_NAME = { confirm: 'Confirm queue', pending: 'Pending', dispatch: 'To dispatch', dispatched: 'Dispatched', cancelled: 'Cancelled', none: 'Not in queue' };
export function StageTag({ stage, children }) { return <span className={`sd-tag ${stage}`}>{children || STAGE_NAME[stage] || stage}</span>; }
export const PayTag = ({ o }) => {
  const paid = /^paid$/i.test(o.financialStatus || '');
  return <span className={`sd-pay ${paid ? 'paid' : 'cod'}`}>{paid ? 'Prepaid' : 'COD'}</span>;
};

// The six calls an order can get, as a ladder: FU1 FU2 FU3, then Day 1 Day 2 Day 3 in Pending. A cancelled-by-silence order ends past the last rung.
const RUNGS = ['FU1', 'FU2', 'FU3', 'Day 1', 'Day 2', 'Day 3'];
export function Ladder({ stage, fuNo, dnpCount = 0 }) {
  const at = stage === 'confirm' ? fuNo - 1 : stage === 'pending' ? 2 + fuNo : -1;
  return (
    <ol className="sd-ladder" aria-label={at >= 0 ? `Follow-up ${RUNGS[at]} of 6. ${dnpCount} unanswered so far.` : 'Follow-up progress'}>
      {RUNGS.map((r, i) => (
        <li key={r} className={`${i < at ? 'done' : i === at ? 'now' : ''} ${i >= 3 ? 'day' : ''} ${i === 3 ? 'gap' : ''}`}><i />{r}</li>
      ))}
    </ol>
  );
}

// "Due in 1h 20m" / "Due now" / "Overdue 3h 05m". Overdue starts 2 h after due for FU calls, 6 h for pending days.
export function DueChip({ o, now, offset }) {
  if (!o.dueAt) return null;
  const ms = new Date(o.dueAt).getTime() - (now + offset);
  const late = o.stage === 'pending' ? 6 : 2;
  if (ms > 0) return <span className="sd-due wait" title={`Opens ${fmtWhen(o.dueAt)}`}>Due in {duration(ms)}</span>;
  if (-ms > late * 3600 * 1000) return <span className="sd-due late" title={`Was due ${fmtWhen(o.dueAt)}`}>Overdue {duration(-ms)}</span>;
  return <span className="sd-due now" title={`Was due ${fmtWhen(o.dueAt)}`}>Due now</span>;
}

export function useClock(serverNow) { return { now: useNow(1000), offset: useServerOffset(serverNow) }; }

// +919876543210 -> +91 98765 43210
export const fmtPhone = (p) => (p && /^\+91\d{10}$/.test(p) ? `+91 ${p.slice(3, 8)} ${p.slice(8)}` : p || '');
export const nice = (t) => String(t || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function Money({ v }) { return v == null ? '—' : inr(v); }

export function Empty({ title, children }) {
  return <div className="sd-empty"><b>{title}</b>{children && <p>{children}</p>}</div>;
}

export function ShotImg({ id, alt = 'Payment screenshot', onOpen }) {
  const [src, setSrc] = useState(null); const [err, setErr] = useState(false);
  useEffect(() => { let live = true; deskShotUrl(id).then((u) => live && setSrc(u), () => live && setErr(true)); return () => { live = false; }; }, [id]);
  if (err) return <span className="muted">Screenshot could not be loaded</span>;
  if (!src) return <span className="muted">Loading screenshot…</span>;
  return <button className="sd-shot" onClick={() => onOpen ? onOpen(src) : window.open(src, '_blank', 'noopener')} aria-label="Open payment screenshot"><img src={src} alt={alt} loading="lazy" /></button>;
}
// A dispatch queue photo (package or manifest). Tap to enlarge.
export function ProofImg({ id, alt = 'Photo', onOpen }) {
  const [src, setSrc] = useState(null); const [err, setErr] = useState(false);
  useEffect(() => { let live = true; deskProofUrl(id).then((u) => live && setSrc(u), () => live && setErr(true)); return () => { live = false; }; }, [id]);
  if (err) return <span className="muted">Photo could not be loaded</span>;
  if (!src) return <span className="muted">Loading photo…</span>;
  return <button className="sd-shot" onClick={() => onOpen ? onOpen(src, alt) : window.open(src, '_blank', 'noopener')} aria-label={`Open ${alt.toLowerCase()}`}><img src={src} alt={alt} loading="lazy" /></button>;
}
export function Lightbox({ src, onClose, title = 'Payment screenshot' }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return <div className="lightbox" role="dialog" aria-modal="true" aria-label={title}><div className="lb-top"><span>{title}</span><button className="btn ghost" onClick={onClose}>Close</button></div><div className="lb-body"><img src={src} alt={title} /></div><div className="lb-bottom" /></div>;
}

export function CopyButton({ text, label = 'Copy', done = 'Copied' }) {
  const [ok, setOk] = useState(false);
  return <button className="btn ghost" onClick={async () => { try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1600); } catch { window.prompt('Copy this:', text); } }}>{ok ? done : label}</button>;
}

export const addressBlock = (o) => [o.name, o.phone, o.address].filter(Boolean).join('\n');

// What happens to the order if the person logs "did not pick up" now. Mirrors lib/desk.js so the form can say it before the tap.
export function dnpOutcome(o, conf) {
  if (!conf) return null;
  const day = (ms) => new Date(ms).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  if (o.stage === 'confirm' && o.fuNo < 3) { const h = conf.confirmHours[o.fuNo]; return { text: `Stays in the confirm queue as FU${o.fuNo + 1}, due ${h === 0 ? 'straight away' : `in ${h} h`}.`, tone: '' }; }
  if (o.stage === 'confirm') return { text: `Moves to Pending orders. Day 1 follow-up is due ${day(Date.now() + conf.pendingDays[0] * 864e5)}.`, tone: 'warn' };
  if (o.fuNo < 3) return { text: `Stays in Pending as Day ${o.fuNo + 1}, due ${day(new Date(o.pendingSince || Date.now()).getTime() + conf.pendingDays[o.fuNo] * 864e5)}.`, tone: '' };
  return { text: 'This was the last follow-up. The order will be cancelled automatically and move to Cancelled orders.', tone: 'bad' };
}

// ---------------------------------------------------------------- update-status sheet: choose an outcome, fill its form, save
const CHOICES = [
  ['confirm', 'Confirmed', 'Customer confirmed. Moves to the dispatch queue.', 'good'],
  ['dnp', 'DNP', 'Did not pick up. Log the WhatsApp message.', 'warn'],
  ['partial_paid', 'Partial paid', 'Customer paid part of the amount. Moves to dispatch.', 'violet'],
  ['cancel', 'Cancelled', 'Customer cancelled or cannot be reached. A reason is required.', 'bad'],
];

export function UpdateStatusSheet({ order: o, conf, now, offset, onClose, onDone, show, start = null }) {
  const [choice, setChoice] = useState(start);
  const [busy, setBusy] = useState(false);
  const notDue = o.dueAt && new Date(o.dueAt).getTime() > now + offset + 60000;
  const run = async (fn, okText) => {
    setBusy(true);
    try { const r = await fn(); notifyDesk(); show(okText(r)); onDone(); }
    catch (e) { show(e.message, 'err'); if (e.status === 409) onDone(); } finally { setBusy(false); }
  };
  const post = (body) => api.post(`/desk/orders/${o.orderId}/action`, body);
  return (
    <Sheet title={`Update status · ${o.orderName}`} onClose={onClose}>
      <p className="muted">{o.name || 'No name'} · {o.stage === 'confirm' ? `FU${o.fuNo}` : `Pending Day ${o.fuNo}`} · {inr(o.total)}</p>
      {!choice && (
        <div className="sd-choices">
          {CHOICES.map(([k, label, hint, tone]) => {
            const off = k === 'dnp' && notDue;
            return (
              <button key={k} className={`sd-choice ${tone}`} disabled={off} onClick={() => setChoice(k)}>
                <b>{label}</b><span>{off ? `Opens ${fmtWhen(o.dueAt)}` : hint}</span>
              </button>
            );
          })}
        </div>
      )}
      {choice === 'confirm' && (
        <>
          <p>Confirm {o.orderName} for {inr(o.total)}? It moves to the dispatch queue.</p>
          <button className="btn big good" disabled={busy} onClick={() => run(() => post({ action: 'confirm' }), () => `${o.orderName} confirmed. It is now in the Dispatch queue.`)}>Yes, confirmed</button>
        </>
      )}
      {choice === 'dnp' && <DnpForm o={o} conf={conf} busy={busy} onSave={(wa) => run(() => post({ action: 'dnp', whatsappShared: wa }), (r) => r.stage === 'pending' && o.stage === 'confirm' ? `${o.orderName}: no answer on FU3. Moved to Pending orders.` : r.stage === 'cancelled' ? `${o.orderName}: last follow-up got no answer. Auto-cancelled.` : `${o.orderName}: DNP saved. Next: ${r.stage === 'pending' ? `Day ${r.fuNo}` : `FU${r.fuNo}`}.`)} />}
      {choice === 'cancel' && <CancelForm o={o} conf={conf} busy={busy} onSave={(reason, note) => run(() => post({ action: 'cancel', reason, note }), () => `${o.orderName} cancelled.`)} />}
      {choice === 'partial_paid' && <PartialForm o={o} conf={conf} busy={busy} onSave={(fd) => run(() => api.upload(`/desk/orders/${o.orderId}/partial`, fd), () => `${o.orderName} marked partial paid. It is now in the Dispatch queue.`)} />}
      {choice && !start && <button className="btn ghost" disabled={busy} onClick={() => setChoice(null)}>Back</button>}
    </Sheet>
  );
}

function DnpForm({ o, conf, busy, onSave }) {
  const [wa, setWa] = useState(null);
  const out = dnpOutcome(o, conf);
  return (
    <>
      <p className="sd-q" id="wa-q">Did you share the WhatsApp message?</p>
      {o.wa ? <a className="btn ghost" href={o.wa} target="_blank" rel="noopener noreferrer">Open WhatsApp with the message</a> : <div className="banner">This order has no valid phone number, so WhatsApp cannot open.</div>}
      <div className="sd-yn" role="radiogroup" aria-labelledby="wa-q">
        <button role="radio" aria-checked={wa === true} className={wa === true ? 'on yes' : ''} onClick={() => setWa(true)}>Yes, shared</button>
        <button role="radio" aria-checked={wa === false} className={wa === false ? 'on no' : ''} onClick={() => setWa(false)}>No, not shared</button>
      </div>
      {out && <div className={`sd-next ${out.tone}`}><b>What happens next</b>{out.text}</div>}
      <button className="btn big" disabled={busy || wa === null} onClick={() => onSave(wa)}>{wa === null ? 'Choose Yes or No to save' : 'Save DNP'}</button>
    </>
  );
}

function CancelForm({ o, conf, busy, onSave }) {
  const reasons = (conf && conf.cancelReasons) || [];
  const [pick, setPick] = useState('');
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const other = pick === 'Other';
  const reason = other ? typed.trim() : pick;
  return (
    <>
      <p className="sd-q">Why is {o.orderName} being cancelled?</p>
      <div className="reasons" role="radiogroup" aria-label="Cancellation reason">
        {reasons.map((r) => <button key={r} role="radio" aria-checked={pick === r} className={`reason-opt ${pick === r ? 'on' : ''}`} onClick={() => setPick(r)}>{r}</button>)}
        {!reasons.includes('Other') && <button role="radio" aria-checked={other} className={`reason-opt ${other ? 'on' : ''}`} onClick={() => setPick('Other')}>Other</button>}
      </div>
      {other && <input type="text" placeholder="Type the reason" value={typed} maxLength={120} onChange={(e) => setTyped(e.target.value)} autoFocus />}
      <label className="sheet-label" htmlFor="cn">Note (optional)</label>
      <textarea id="cn" className="sd-text" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the next person should know" />
      <button className="btn big danger" disabled={busy || reason.length < 2} onClick={() => onSave(reason, note)}>Cancel this order</button>
    </>
  );
}

function PartialForm({ o, conf, busy, onSave }) {
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const need = !conf || conf.requireScreenshot;
  const n = Number(amount);
  const total = o.total;
  const okAmt = Number.isFinite(n) && n > 0 && (total == null || n < total);
  useEffect(() => () => preview && URL.revokeObjectURL(preview), [preview]);
  const pick = async (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    setErr('');
    try { const c = await compressPhoto(f); setFile(c); setPreview(URL.createObjectURL(c)); } catch (x) { setErr(x.message); }
  };
  const submit = () => { const fd = new FormData(); fd.append('amount', String(n)); fd.append('notes', notes); if (file) fd.append('screenshot', file); onSave(fd); };
  const q = (p) => Math.max(1, Math.round((total * p) / 10) * 10);
  return (
    <>
      <label className="sheet-label" htmlFor="pa">Amount paid by the customer ({total != null ? `order total ${inr(total)}` : 'order total unknown'})</label>
      <div className="amount-row"><span>₹</span><input id="pa" type="text" inputMode="decimal" autoComplete="off" autoFocus value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>
      {total > 0 && <div className="chips">{[0.25, 0.5, 0.75].map((p) => <button key={p} className="btn ghost" onClick={() => setAmount(String(q(p)))}>{inr(q(p))}</button>)}</div>}
      {amount && !okAmt && <div className="banner err">Enter an amount above ₹0 and below {inr(total)}. If the customer paid everything, use Confirmed.</div>}
      {okAmt && total != null && <div className="sd-next"><b>Balance to collect on delivery</b>{inr(total - n)}</div>}
      <label className="sheet-label" htmlFor="ps">Payment screenshot{need ? '' : ' (optional)'}</label>
      <input id="ps" type="file" accept="image/*" onChange={pick} />
      {preview && <div className="photo-pick"><img src={preview} alt="Screenshot to upload" /></div>}
      {err && <div className="banner err">{err}</div>}
      <label className="sheet-label" htmlFor="pn">Notes (optional)</label>
      <textarea id="pn" className="sd-text" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="UPI reference, who paid, when the balance will be paid…" />
      <button className="btn big" disabled={busy || !okAmt || (need && !file)} onClick={submit}>{need && !file ? 'Attach the screenshot to save' : 'Save partial payment'}</button>
    </>
  );
}

// ---------------------------------------------------------------- the card in Confirm queue and Pending
export function QueueCard({ o, now, offset, canAct, onUpdate, onOpen }) {
  const late = o.dueAt && new Date(o.dueAt).getTime() < now + offset - (o.stage === 'pending' ? 6 : 2) * 3600e3;
  const ready = o.dueAt && new Date(o.dueAt).getTime() <= now + offset;
  return (
    <article className={`sd-card ${o.stage} fu${o.fuNo} ${late ? "late" : ready ? "ready" : ""}`} aria-label={`${o.orderName}, ${o.status}`}>
      <header>
        <div className="sd-id">
          <button className="link" onClick={() => onOpen(o.orderId)}>{o.orderName}</button>
          <PayTag o={o} />
        </div>
        <DueChip o={o} now={now} offset={offset} />
      </header>
      <div className="sd-who"><b>{o.name || 'No name'}</b>{o.city ? <span className="muted"> · {o.city}{o.state ? `, ${o.state}` : ''}</span> : null}</div>
      <Ladder stage={o.stage} fuNo={o.fuNo} dnpCount={o.dnpCount} />
      <div className="sd-line"><span className="sd-amt">{inr(o.total)}</span><span className="sd-items" title={o.items}>{o.items || 'Items not loaded'}</span></div>
      {(o.lastAction || o.source) && (
        <div className="sd-foot">
          {o.lastAction && <span title={fmtWhen(o.lastAction.at)}>Last: {o.lastAction.label} · {o.lastAction.by}</span>}
          {o.source && <span className="chip">{o.source}</span>}
        </div>
      )}
      <div className="sd-actions">
        {o.phone ? <a className="btn sd-call" href={`tel:${o.phone}`}><span aria-hidden="true">☎</span> Call {fmtPhone(o.phone)}</a> : <span className="btn ghost" aria-disabled="true">No phone number</span>}
        {canAct && <button className="btn sd-update" onClick={() => onUpdate(o)}>Update status</button>}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- order drawer: everything about one order
const D = (s) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : '—');
export function OrderDrawer({ orderId, onClose }) {
  const { data, error, loading } = useApi(`/desk/orders/${orderId}`);
  const [shot, setShot] = useState(null);
  const [proof, setProof] = useState(null); // { src, title }
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const c = data && data.card; const s = data && data.shopify;
  const m = (s && s.marketing) || {};
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <aside className="drawer sd-drawer" role="dialog" aria-modal="true" aria-label={`Order ${orderId}`}>
        <div className="sheet-head"><h2>{c ? c.orderName : `#${orderId}`}</h2><span><button className="btn" onClick={() => api.download('/desk/analysis.xlsx', { orderId }, `order-${orderId}.xlsx`).catch(() => {})} title="Excel sheet of everything that happened to this order">Download sheet</button> <button className="btn ghost" onClick={onClose}>Close</button></span></div>
        {error && <div className="banner err">{error}</div>}
        {loading && !data && <div className="empty">Loading…</div>}
        {data && (
          <>
            <div className="sd-dhead"><StageTag stage={data.inQueue ? c.stage : 'none'}>{c.status}</StageTag>{c.stage === 'confirm' || c.stage === 'pending' ? <Ladder stage={c.stage} fuNo={c.fuNo} dnpCount={c.dnpCount} /> : null}</div>
            <p className="muted" style={{ margin: '4px 0 0' }}>Placed {D(c.orderAt || (s && s.createdAt))} (IST){c.payment ? ` · ${c.payment}` : ''}</p>
            {!data.inQueue && <div className="banner" style={{ marginTop: 10 }}>This order is older than the queue start date ({data.queueStart}), so it is not in the confirm queue. An admin can move the start date back in Settings.</div>}

            <h2 className="sd-h">Customer</h2>
            <dl className="kv">
              <dt>Name</dt><dd>{c.name || '—'}</dd>
              <dt>Phone</dt><dd>{c.phone ? <><a href={`tel:${c.phone}`}>{fmtPhone(c.phone)}</a>{c.wa && <> · <a href={c.wa} target="_blank" rel="noopener noreferrer">WhatsApp</a></>}</> : '—'}</dd>
              <dt>Email</dt><dd>{c.email || '—'}</dd>
              <dt>Address</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{c.address || '—'}{s && s.address && s.address.country ? `, ${s.address.country}` : ''}</dd>
            </dl>
            {c.address && <CopyButton text={addressBlock(c)} label="Copy address" />}

            <h2 className="sd-h">Items</h2>
            {c.itemsList.length ? (
              <table><thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th></tr></thead>
                <tbody>{c.itemsList.map((i, k) => <tr key={k}><td style={{ whiteSpace: 'normal' }}>{i.title}{i.variantTitle && <span className="muted"> · {i.variantTitle}</span>}{i.sku && <span className="muted"> · {i.sku}</span>}</td><td className="num">{i.quantity}</td><td className="num">{inr(i.price)}</td></tr>)}</tbody></table>
            ) : <p className="muted">No items loaded yet.</p>}

            <h2 className="sd-h">Payment</h2>
            {s && (
              <dl className="kv">
                <dt>Subtotal</dt><dd>{inr(s.subtotal)}</dd><dt>Shipping</dt><dd>{inr(s.shipping)}</dd><dt>Discounts</dt><dd>{s.discounts ? `− ${inr(s.discounts)}` : '—'}</dd>
                <dt>Order total</dt><dd><b>{inr(s.total)}</b></dd>
                <dt>Method</dt><dd>{(s.paymentGateways || []).join(', ') || '—'}</dd>
                <dt>Shopify status</dt><dd>{nice(s.financialStatus) || '—'} · {nice(s.fulfillmentStatus) || 'Unfulfilled'}</dd>
                <dt>To collect</dt><dd><b>{inr(c.collect)}</b></dd>
              </dl>
            )}
            {c.partial && (
              <div className="sd-box violet">
                <b>Partial payment · {inr(c.partial.amount)} received</b>
                <span>Balance {inr(c.partial.balance)} · taken by {c.partial.byName} on {c.partial.fromFu} · {D(c.partial.at)}</span>
                {c.partial.notes && <span>“{c.partial.notes}”</span>}
                {c.partial.screenshotId && <ShotImg id={c.partial.screenshotId} onOpen={setShot} />}
              </div>
            )}
            {c.cancel && <div className="sd-box bad"><b>Cancelled: {c.cancel.reason}</b><span>{c.cancel.auto ? 'Automatically' : `By ${c.cancel.byName}`} · {D(c.cancel.at)}{c.cancel.fromStage ? ` · from ${STAGE_NAME[c.cancel.fromStage] || c.cancel.fromStage}` : ''}</span>{c.cancel.note && <span>“{c.cancel.note}”</span>}{c.refundDue && <span><b>Refund due:</b> {inr(c.partial.amount)} was received before the cancellation.</span>}</div>}
            {c.dispatch && <div className="sd-box good"><b>Dispatched {D(c.dispatch.at)}</b><span>By {c.dispatch.byName}{c.dispatch.courier ? ` · ${c.dispatch.courier}` : ''}{c.dispatch.awb ? ` · AWB ${c.dispatch.awb}` : ''}</span>{c.dispatch.note && <span>“{c.dispatch.note}”</span>}</div>}
            {c.dq && (c.dq.slip || c.dq.packed || c.dq.handover) && (
              <div className="sd-box">
                <b>Dispatch queue</b>
                {c.dq.slip && <span>Packing slip done · {c.dq.slip.byName} · {D(c.dq.slip.at)}{c.dq.slip.late ? ' · late' : ''}</span>}
                {c.dq.packed && <span>Packed · {c.dq.packed.byName} · {D(c.dq.packed.at)} · AWB {c.dq.packed.awb}{c.dq.packed.late ? ' · late' : ''}</span>}
                {c.dq.packed && c.dq.packed.photoId && <ProofImg id={c.dq.packed.photoId} alt="Photo of the package" onOpen={(src, title) => setProof({ src, title })} />}
                {c.dq.handover && <span>Handed over · {c.dq.handover.byName} · {D(c.dq.handover.at)}{c.dq.handover.late ? ' · late' : ''}</span>}
                {c.dq.handover && c.dq.handover.manifestId && <ProofImg id={c.dq.handover.manifestId} alt="Photo of the manifest" onOpen={(src, title) => setProof({ src, title })} />}
              </div>
            )}
            {data.shipway && <p className="muted">Shipway: <b>{data.shipway.status}</b>{data.shipway.carrier ? ` · ${data.shipway.carrier}` : ''}{data.shipway.awb ? ` · AWB ${data.shipway.awb}` : ''}</p>}

            {(m.hasUtm || m.landingPath) && (
              <>
                <h2 className="sd-h">Where it came from</h2>
                <dl className="kv">
                  <dt>Source</dt><dd>{m.utmSource || '—'}{m.sourceGroup && m.sourceGroup !== m.utmSource ? ` · ${m.sourceGroup}` : ''}</dd>
                  <dt>Campaign</dt><dd style={{ whiteSpace: 'normal' }}>{m.utmCampaign || '—'}</dd>
                  <dt>Ad set</dt><dd style={{ whiteSpace: 'normal' }}>{m.utmMedium || '—'}</dd>
                  <dt>Ad</dt><dd style={{ whiteSpace: 'normal' }}>{m.utmContent || '—'}</dd>
                  {m.landingPath && <><dt>Landing page</dt><dd>{m.landingPath}</dd></>}
                  {m.device && <><dt>Device</dt><dd>{[m.device, m.inApp].filter(Boolean).join(' · ')}</dd></>}
                </dl>
              </>
            )}
            {s && (s.note || (s.tags || []).length > 0) && (
              <dl className="kv">{s.note && <><dt>Order note</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{s.note}</dd></>}{(s.tags || []).length > 0 && <><dt>Tags</dt><dd>{s.tags.join(', ')}</dd></>}</dl>
            )}

            <h2 className="sd-h">History</h2>
            {data.log.length === 0 ? <p className="muted">No follow-ups yet.</p> : (
              <ol className="timeline">
                {[...data.log].reverse().map((e, i) => (
                  <li key={i} className={['confirm', 'partial_paid', 'dispatch'].includes(e.action) ? 'good' : ['cancel', 'auto_cancel', 'shopify_cancel'].includes(e.action) ? 'bad' : ['dnp', 'to_pending'].includes(e.action) ? 'warn' : ''}>
                    <div className="tl-main"><b>{e.label}</b></div>
                    <div className="tl-sub">{e.by} · {fmtWhen(e.at)}</div>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
        {shot && <Lightbox src={shot} onClose={() => setShot(null)} />}
        {proof && <Lightbox src={proof.src} title={proof.title} onClose={() => setProof(null)} />}
      </aside>
    </>
  );
}

// Search box that waits for a pause in typing.
export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function usePager(total, limit, deps) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), deps); // eslint-disable-line react-hooks/exhaustive-deps
  const pages = Math.max(1, Math.ceil(total / limit));
  const node = total > limit ? (
    <div className="pager"><button className="btn ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {pages}</span><button className="btn ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div>
  ) : null;
  return { page, node, setPage };
}

// Settings page: show what the WhatsApp message will look like.
export const DEFAULT_TEMPLATE_PREVIEW = (t) => String(t || '').replace(/\{name\}/g, 'Asha').replace(/\{order\}/g, '#1500').replace(/\{items\}/g, 'Soul Journal ×1').replace(/\{amount\}/g, '999').replace(/\{balance\}/g, '999');
