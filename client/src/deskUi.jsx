import React, { useCallback, useEffect, useRef, useState } from 'react';
import { proofUrl, useApi } from './api.js';
import { fmtWhen, grams } from './flowUi.js';

// ---------- bottom sheet (full width on phones, centred card on desktop) ----------
export function Sheet({ title, onClose, children }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <>
      <div className="sheet-bg" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-head"><h2>{title}</h2><button className="btn ghost" onClick={onClose}>Close</button></div>
        {children}
      </div>
    </>
  );
}

// ---------- toast ----------
export function useToast() {
  const [t, setT] = useState(null);
  const timer = useRef(null);
  const show = useCallback((text, kind = 'ok') => {
    setT({ text, kind, id: Date.now() });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setT(null), kind === 'err' ? 6000 : 3500);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const node = t ? <div className={`toast ${t.kind}`} role="status" aria-live="polite" key={t.id}>{t.text}</div> : null;
  return [node, show];
}

// ---------- proof photos ----------
export function ProofThumb({ id, kind = 'photo', onOpen }) {
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    proofUrl(id).then((u) => live && setSrc(u), () => live && setErr(true));
    return () => { live = false; };
  }, [id]);
  return (
    <button className="thumb" onClick={() => onOpen && onOpen(id)} aria-label={kind === 'video' ? 'Open proof video' : 'Open proof photo'}>
      {src && kind !== 'video' ? <img src={src} alt="Sealed box on the scale" loading="lazy" /> : <span className="muted">{err ? 'Could not load' : kind === 'video' ? '▶ Video' : '…'}</span>}
    </button>
  );
}

export function Lightbox({ items, startId, onClose }) {
  const [i, setI] = useState(Math.max(0, items.findIndex((p) => p.id === startId)));
  const cur = items[i];
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let live = true; setSrc(null);
    proofUrl(cur.id).then((u) => live && setSrc(u), () => {});
    return () => { live = false; };
  }, [cur.id]);
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((n) => Math.min(items.length - 1, n + 1));
      if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [items.length, onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Proof">
      <div className="lb-top">
        <span>{i + 1} of {items.length}{cur.by ? ` · ${cur.by}` : ''}{cur.at ? ` · ${fmtWhen(cur.at)}` : ''}</span>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
      <div className="lb-body">
        {!src ? <span className="muted">Loading…</span> : cur.kind === 'video' ? <video src={src} controls playsInline /> : <img src={src} alt="Sealed box on the scale" />}
      </div>
      <div className="lb-bottom">
        {cur.awb && <span>AWB {cur.awb}</span>}{cur.weightG != null && <span>Weight {grams(cur.weightG)}</span>}
        {items.length > 1 && <span className="lb-nav"><button className="btn ghost" disabled={i === 0} onClick={() => setI(i - 1)}>Previous</button><button className="btn ghost" disabled={i === items.length - 1} onClick={() => setI(i + 1)}>Next</button></span>}
      </div>
    </div>
  );
}

// ---------- barcode scanner (phone camera). Falls back to typing or a USB/Bluetooth scanner, which types into the field like a keyboard ----------
export function AwbScanner({ onResult, onClose }) {
  const video = useRef(null);
  const [msg, setMsg] = useState('Point the camera at the barcode on the slip.');
  useEffect(() => {
    let stream; let timer; let stopped = false;
    if (!('BarcodeDetector' in window)) { setMsg('Camera scanning is not available in this browser. Type the AWB, or use a barcode scanner on the field.'); return undefined; }
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.current.srcObject = stream; await video.current.play();
        const det = new window.BarcodeDetector({ formats: ['code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'itf', 'codabar', 'qr_code'] });
        const tick = async () => {
          if (stopped) return;
          try { const found = await det.detect(video.current); if (found.length && found[0].rawValue) { onResult(found[0].rawValue); return; } } catch { /* keep trying */ }
          timer = setTimeout(tick, 250);
        };
        tick();
      } catch { setMsg('The camera is blocked. Allow camera access for this site, or type the AWB.'); }
    })();
    return () => { stopped = true; clearTimeout(timer); if (stream) stream.getTracks().forEach((t) => t.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Scan AWB">
      <div className="lb-top"><span>Scan AWB</span><button className="btn ghost" onClick={onClose}>Close</button></div>
      <div className="lb-body"><video ref={video} playsInline muted /></div>
      <div className="lb-bottom"><span>{msg}</span></div>
    </div>
  );
}

// ---------- timeline + proof gallery for one order (used in the Orders drawer) ----------
const DOT = { confirm: 'good', partial_pay: 'good', packed: 'good', dispatched: 'good', ready: 'good', cancel: 'bad', auto_cancel: 'bad', no_answer: 'warn', escalate: 'warn', delay_reason: 'warn' };
const STAGE = { confirm: 'Confirm Queue', dispatch: 'Dispatch Desk', contact: 'Contact' };
const STATUS_TEXT = { pending: 'Pending', no_answer: 'No answer', confirmed: 'Confirmed', partial_pay: 'Partial pay', cancelled: 'Cancelled', print_slip: 'Print slip', ready_for_pickup: 'Ready for pickup', dispatched: 'Dispatched' };

export function FlowSection({ orderId }) {
  const { data, error, loading } = useApi(`/flow/orders/${orderId}/timeline`);
  const [open, setOpen] = useState(null);
  if (loading && !data) return null;
  if (error) return <p className="muted">Team activity could not be loaded: {error}</p>;
  if (!data) return null;
  if (!data.tracked) return (
    <>
      <h2 style={{ marginTop: 18 }}>Team activity</h2>
      <p className="muted">No one has handled this order in the Confirm Queue or Dispatch Desk yet.</p>
    </>
  );
  const f = data.flow;
  return (
    <>
      <h2 style={{ marginTop: 18 }}>Team activity</h2>
      <dl className="kv">
        <dt>Confirmation</dt><dd>{STATUS_TEXT[f.confirmStatus] || f.confirmStatus}{f.attempts > 0 && f.confirmStatus === 'no_answer' ? ` · attempt ${f.attempts} of 3` : ''}{f.escalated ? ' · escalated' : ''}{f.cancelReason ? ` · ${f.cancelReason}` : ''}</dd>
        {f.partial && <><dt>Partial payment</dt><dd>₹{f.partial.amount} paid by {f.partial.byName}</dd></>}
        {f.dispatchStage && <><dt>Dispatch stage</dt><dd>{STATUS_TEXT[f.dispatchStage]}</dd></>}
        {f.planned && <><dt>Planned by</dt><dd>{fmtWhen(f.planned)} <span className="muted">(24 h after confirmation)</span></dd></>}
        {f.awb && <><dt>AWB</dt><dd>{f.awb}</dd></>}
        {f.weightG != null && <><dt>Weight on scale</dt><dd>{grams(f.weightG)}</dd></>}
      </dl>
      <ol className="timeline">
        {data.events.map((e, i) => (
          <li key={i} className={DOT[e.action] || ''}>
            <div className="tl-main"><b>{e.label}</b></div>
            <div className="tl-sub">{e.by} · {fmtWhen(e.at)} · {STAGE[e.stage] || e.stage}
              {e.previous && e.next && e.previous !== e.next && <> · {STATUS_TEXT[e.previous] || e.previous} → {STATUS_TEXT[e.next] || e.next}</>}
            </div>
          </li>
        ))}
      </ol>
      <h2 style={{ marginTop: 18 }}>Proof gallery</h2>
      {data.proofs.length === 0 ? <p className="muted">No proof photos yet. They are added when the order is packed.</p> : (
        <div className="gallery">
          {data.proofs.map((p) => (
            <figure key={p.id}>
              <ProofThumb id={p.id} kind={p.kind} onOpen={setOpen} />
              <figcaption>{p.by} · {fmtWhen(p.at)}{p.weightG != null ? ` · ${grams(p.weightG)}` : ''}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {open && <Lightbox items={data.proofs} startId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
