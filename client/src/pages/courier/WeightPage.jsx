import React, { useEffect, useState } from 'react';
import { api, useApi } from '../../api.js';
import { Loading } from '../../components.jsx';
import { Sheet, useToast } from '../../deskUi.jsx';
import { grams, fmtWhen, useAutoRefresh } from '../../flowUi.js';
import { inr, int } from '../../format.js';
import { can, useStaff } from '../../staff.jsx';
import { Empty, OrderDrawer, PayTag, notifyDesk, useDebounced } from '../desk/shared.jsx';
import { ClosedList, CourierPage, History, NoteField, Stat } from './courierUi.jsx';

const STEPS = [
  ['Review order', 'Check the declared weight against the courier’s charge. Is the charge correct?'],
  ['Submit request on Shipway', 'Raise the dispute on Shipway with proof (photos, weight slip), then note the ticket number here.'],
  ['Update final resolution', 'Shipway has answered. Record what happened to the charge.'],
];
const kg = (g) => (g == null ? '—' : grams(g));
const signed = (g) => (g == null ? '—' : `${g > 0 ? '+' : ''}${grams(Math.abs(g)).replace(/^/, g < 0 ? '-' : '')}`);

function StepSheet({ o, onClose, onDone, show }) {
  const c = o.case;
  const [decision, setDecision] = useState(''); const [note, setNote] = useState(''); const [ref, setRef] = useState(''); const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.post(`/desk/weight/${c.id}/submit`, { decision, note, ref, amount }); notifyDesk(); show(`${o.orderName}: saved.`); onDone(); }
    catch (e) { show(e.message, 'err'); if (e.status === 409) onDone(); } finally { setBusy(false); }
  };
  const ready = c.step === 1 ? !!decision : c.step === 2 ? true : decision === 'partial' ? Number(amount) > 0 : !!decision;
  const choose = (k, label, hint, tone) => <button key={k} className={`sd-choice ${tone} ${decision === k ? 'picked' : ''}`} aria-pressed={decision === k} onClick={() => setDecision(k)}><b>{label}</b><span>{hint}</span></button>;
  return (
    <Sheet title={`${STEPS[c.step - 1][0]} · ${o.orderName}`} onClose={onClose}>
      <p className="muted">{c.courier || 'Courier'}{c.awb ? ` · AWB ${c.awb}` : ''} · declared {kg(c.weight.declaredG)} · charged {kg(c.weight.chargedG)} · extra charge {c.weight.extraCharge == null ? '—' : inr(c.weight.extraCharge)}</p>
      <p>{STEPS[c.step - 1][1]}</p>
      {c.step === 1 && <div className="sd-choices">{choose('dispute', 'Charge looks wrong', 'Go on to raise it with Shipway.', 'warn')}{choose('accept', 'Charge is correct', 'Accept it. The case closes.', '')}</div>}
      {c.step === 2 && <><label className="sheet-label" htmlFor="wref">Shipway ticket / request number (optional)</label><input id="wref" type="text" maxLength={80} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. the ticket number Shipway gives" /></>}
      {c.step === 3 && <div className="sd-choices">{choose('reversed', 'Fully reversed', `The whole ${c.weight.extraCharge == null ? '' : inr(c.weight.extraCharge)} comes back.`, 'good')}{choose('partial', 'Partly credited', 'Part of the charge comes back.', 'good')}{choose('rejected', 'Rejected', 'Shipway keeps the charge.', 'bad')}</div>}
      {c.step === 3 && decision === 'partial' && <><label className="sheet-label" htmlFor="wam">Amount credited back (₹)</label><input id="wam" type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /></>}
      <NoteField value={note} onChange={setNote} id="w-note" />
      <History log={c.log} />
      <button className="btn big" disabled={busy || !ready} onClick={save}>{c.step === 2 ? 'Request submitted' : 'Save'}</button>
    </Sheet>
  );
}

function AddSheet({ onClose, onDone, show }) {
  const [f, setF] = useState({ orderId: '', awb: '', declared: '', charged: '', extraCharge: '', unit: 'kg' }); const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    try { await api.post('/desk/weight', f); notifyDesk(); show(`#${f.orderId} added.`); onDone(); } catch (e) { show(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Sheet title="Add a weight discrepancy" onClose={onClose}>
      <label className="sheet-label" htmlFor="wa1">Order number</label><input id="wa1" type="text" inputMode="numeric" value={f.orderId} onChange={(e) => set('orderId', e.target.value)} autoFocus />
      <label className="sheet-label" htmlFor="wa2">AWB (optional)</label><input id="wa2" type="text" value={f.awb} onChange={(e) => set('awb', e.target.value)} />
      <div className="amount-row" style={{ marginTop: 10 }}><select value={f.unit} onChange={(e) => set('unit', e.target.value)} aria-label="Weight unit"><option value="kg">kg</option><option value="g">grams</option></select></div>
      <label className="sheet-label" htmlFor="wa3">Weight you declared</label><input id="wa3" type="text" inputMode="decimal" value={f.declared} onChange={(e) => set('declared', e.target.value)} />
      <label className="sheet-label" htmlFor="wa4">Weight the courier charged</label><input id="wa4" type="text" inputMode="decimal" value={f.charged} onChange={(e) => set('charged', e.target.value)} />
      <label className="sheet-label" htmlFor="wa5">Extra charge (₹)</label><input id="wa5" type="text" inputMode="decimal" value={f.extraCharge} onChange={(e) => set('extraCharge', e.target.value)} />
      <button className="btn big" disabled={busy || !f.orderId || !f.declared || !f.charged} onClick={save}>Add</button>
    </Sheet>
  );
}

function UploadBar({ onDone, show }) {
  const [unit, setUnit] = useState('kg'); const [busy, setBusy] = useState(false); const [res, setRes] = useState(null);
  const pick = async (e) => {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    const fd = new FormData(); fd.append('file', file); fd.append('unit', unit);
    setBusy(true); setRes(null);
    try { const r = await api.upload('/desk/weight/import', fd); setRes(r); notifyDesk(); show(`${r.added} added${r.duplicates ? `, ${r.duplicates} already there` : ''}${r.unmatched ? `, ${r.unmatched} not matched to an order` : ''}.`, r.added ? 'ok' : 'err'); onDone(); }
    catch (x) { show(x.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="cs-upload">
      <label className="btn" aria-disabled={busy}>{busy ? 'Reading the file…' : 'Upload Shipway report'}<input type="file" accept=".xlsx,.csv" hidden disabled={busy} onChange={pick} /></label>
      <label className="cs-unit">Plain weights in the file are in <select value={unit} onChange={(e) => setUnit(e.target.value)}><option value="kg">kg</option><option value="g">grams</option></select></label>
      {res && res.skipped.length > 0 && <small className="muted">{res.skipped.length} row{res.skipped.length === 1 ? '' : 's'} skipped (no order number or AWB).</small>}
    </div>
  );
}

function WCard({ o, canAct, onUpdate, onOpen }) {
  const c = o.case; const w = c.weight || {};
  const lastNote = [...(c.log || [])].reverse().find((e) => e.note);
  const age = Math.max(0, Math.floor((Date.now() - new Date(c.openedAt).getTime()) / 864e5));
  return (
    <article className="sd-card weight" aria-label={`${o.orderName}, weight discrepancy`}>
      <header>
        <div className="sd-id">{o.orderId ? <button className="link" onClick={() => onOpen(o.orderId)}>{o.orderName}</button> : <b>No order matched</b>}{o.orderId && <PayTag o={o} />}</div>
        <span className="muted">{age === 0 ? 'today' : `${age} d old`}</span>
      </header>
      {o.name && <div className="sd-who"><b>{o.name}</b>{o.city ? <span className="muted"> · {o.city}</span> : null}</div>}
      <div className="cs-weights"><div><span>Declared</span><b>{kg(w.declaredG)}</b></div><div><span>Charged</span><b>{kg(w.chargedG)}</b></div><div className="bad"><span>Extra</span><b>{w.extraCharge == null ? signed(w.diffG) : inr(w.extraCharge)}</b></div></div>
      <div className="sd-foot"><span>{c.courier || '—'}{c.awb ? ` · AWB ${c.awb}` : ''}{c.requestRef ? ` · ticket ${c.requestRef}` : ''}</span></div>
      {lastNote && <p className="sd-note">“{lastNote.note}” <small className="muted">· {lastNote.by}</small></p>}
      {canAct && <div className="sd-actions"><button className="btn sd-update" onClick={() => onUpdate(o)}>{c.step === 2 ? 'Request submitted' : c.step === 3 ? 'Update resolution' : 'Review'}</button></div>}
    </article>
  );
}

export default function WeightPage() {
  const { user } = useStaff();
  const actor = can(user, 'packing');
  const [q, setQ] = useState(''); const qd = useDebounced(q);
  const { data, error, loading, reload } = useApi('/desk/weight', { q: qd });
  useAutoRefresh(reload, 60);
  const [sheet, setSheet] = useState(null); const [adding, setAdding] = useState(false); const [open, setOpen] = useState(null);
  const [toast, show] = useToast();
  useEffect(() => { const on = () => reload(); window.addEventListener('desk-refresh', on); return () => window.removeEventListener('desk-refresh', on); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <CourierPage title="Weight Discrepancy Orders" sub="Orders where the courier charged for a heavier parcel than you declared, picked up from Shipway by itself. Work each one in three steps: review it, submit the request on Shipway, then record the final result."
      actions={actor ? <div className="cs-actions"><UploadBar onDone={reload} show={show} /><button className="btn ghost" onClick={() => setAdding(true)}>Add manually</button></div> : null}>
      <div className="sd-stats">
        <Stat label="Open cases" value={data ? int(data.counts.open) : '–'} tone="warn" sub={data ? `${data.counts.byStep.join(' · ')} in the three steps` : ''} />
        <Stat label="Extra charges under dispute" value={data ? inr(data.money.openCharges) : '–'} tone="bad" />
        <Stat label="Recovered from Shipway" value={data ? inr(data.money.recovered) : '–'} tone="good" />
        <Stat label="Rejected (charge stays)" value={data ? inr(data.money.rejected) : '–'} />
      </div>
      <div className="filters"><input type="search" placeholder="Search order number, name, phone or AWB" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /><span className="grow" /><span className="muted">{data ? `${data.shown} open` : ''}</span></div>
      <Loading error={error} loading={loading && !data}>
        {data && (
          <>
            <div className="dq-board">
              {STEPS.map(([title, hint], i) => {
                const items = data.columns[i + 1] || [];
                return (
                  <div key={title} className={`dq-col wd${i + 1}`}>
                    <div className="dq-colhead"><div className="dq-title"><h2>{title}</h2><span className="sd-count">{items.length}</span></div><small>{hint}</small></div>
                    <div className="dq-cards">
                      {items.length === 0 ? <Empty title="Nothing here">{q ? 'No orders match this.' : i === 0 ? 'When Shipway reports a charged weight above the declared one, the order appears here by itself.' : 'Cards arrive here from the step before.'}</Empty>
                        : items.map((o) => <WCard key={o.case.id} o={o} canAct={actor} onUpdate={setSheet} onOpen={setOpen} />)}
                    </div>
                  </div>
                );
              })}
            </div>
            <ClosedList items={data.resolved} onOpen={setOpen} extra={{ label: 'Credited back', get: (o) => inr(o.case.resolution.amount || 0) }} />
          </>
        )}
      </Loading>
      {sheet && <StepSheet o={sheet} show={show} onClose={() => setSheet(null)} onDone={() => { setSheet(null); reload(); }} />}
      {adding && <AddSheet show={show} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {open && <OrderDrawer orderId={open} onClose={() => setOpen(null)} />}
      {toast}
    </CourierPage>
  );
}
