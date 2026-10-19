import React, { useEffect, useMemo, useState } from 'react';
import { api, useApi } from '../../api.js';
import { Loading } from '../../components.jsx';
import { Sheet, useToast } from '../../deskUi.jsx';
import { fmtWhen, useAutoRefresh } from '../../flowUi.js';
import { inr, int } from '../../format.js';
import { can, useStaff } from '../../staff.jsx';
import { DueChip, Empty, LabelsProvider, OrderDrawer, PayTag, fmtPhone, notifyDesk, useClock, useDebounced, useLabels } from '../desk/shared.jsx';
import { ClosedList, CourierPage, History, NoteField, Stat } from './courierUi.jsx';

const CHOICES = [
  ['wants', 'Customer still wants it', 'Adds the order to FU2. It stays open until Shipway shows Delivered or RTO.', 'good'],
  ['not_wants', 'Customer does not want it', 'Return the parcel to origin (RTO).', 'bad'],
  ['dnp', 'Did not pick up', 'Try again at the next follow-up.', 'warn'],
];

function NdrSheet({ o, now, offset, onClose, onDone, show }) {
  const { fu } = useLabels();
  const [choice, setChoice] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const c = o.case;
  const notDue = c.dueAt && new Date(c.dueAt).getTime() > now + offset + 60000;
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/desk/ndr/${o.orderId}/submit`, { outcome: choice, note });
      notifyDesk(); show(choice === 'wants' ? `${o.orderName}: added to ${fu('FU2')}.` : choice === 'dnp' ? (c.step < 3 ? `${o.orderName}: no answer saved. Next: ${fu(`FU${c.step + 1}`)}.` : `${o.orderName}: no response after 3 follow-ups. Return it to origin.`) : `${o.orderName}: saved.`); onDone();
    } catch (e) { show(e.message, 'err'); if (e.status === 409) onDone(); } finally { setBusy(false); }
  };
  return (
    <Sheet title={`${fu(`FU${c.step}`)} · ${o.orderName}`} onClose={onClose}>
      <p className="muted">{o.name || 'No name'} · {inr(o.total)} · courier said: <b>{(c.ndr && c.ndr.reason) || 'Undelivered'}</b></p>
      {o.phone && <a className="btn sd-call" href={`tel:${o.phone}`}><span aria-hidden="true">☎</span> {fmtPhone(o.phone)}</a>}
      <p className="sd-q">What did the customer say?</p>
      <div className="sd-choices">
        {CHOICES.map(([k, label, hint, tone]) => {
          const off = k === 'dnp' && notDue;
          return <button key={k} className={`sd-choice ${tone} ${choice === k ? 'picked' : ''}`} disabled={off} aria-pressed={choice === k} onClick={() => setChoice(k)}><b>{label}</b><span>{off ? `Opens ${fmtWhen(c.dueAt)}` : k === 'dnp' && c.step === 3 ? 'This was the last follow-up: the parcel goes back to origin.' : hint}</span></button>;
        })}
      </div>
      <NoteField value={note} onChange={setNote} />
      <History log={c.log} />
      <button className="btn big" disabled={busy || !choice} onClick={save}>{choice ? 'Save' : 'Choose what the customer said'}</button>
    </Sheet>
  );
}

function NdrCard({ o, now, offset, canAct, onUpdate, onOpen }) {
  const c = o.case;
  const lastNote = [...(c.log || [])].reverse().find((e) => e.note);
  return (
    <article className={`sd-card ndr fu${c.step}`} aria-label={`${o.orderName}, NDR`}>
      <header>
        <div className="sd-id"><button className="link" onClick={() => onOpen(o.orderId)}>{o.orderName}</button><PayTag o={o} /></div>
        <DueChip o={{ dueAt: c.dueAt, stage: 'confirm' }} now={now} offset={offset} />
      </header>
      <div className="sd-who"><b>{o.name || 'No name'}</b>{o.city ? <span className="muted"> · {o.city}</span> : null}</div>
      <div className="sd-line"><span className="sd-amt">{inr(o.collect != null ? o.collect : o.total)}</span><span className="sd-items" title={o.items}>{o.items || 'Items not loaded'}</span></div>
      <div className="cs-reason" title="Latest status from Shipway">{(c.ndr && c.ndr.reason) || 'Undelivered'}</div>
      {o.shipway && o.shipway.status && o.shipway.status !== (c.ndr && c.ndr.reason) && <div className="cs-reason" title="Shipway status right now">Shipway now: <b>{o.shipway.status}</b></div>}
      {c.wants && <div className="cs-reason" title={`${c.wants.by}${c.wants.note ? `: ${c.wants.note}` : ''}`}>✓ Customer still wants it{c.wants.count > 1 ? ` (${c.wants.count}×)` : ''}</div>}
      <div className="sd-foot"><span>{c.courier || '—'}{c.awb ? ` · AWB ${c.awb}` : ''}</span></div>
      {lastNote && <p className="sd-note">“{lastNote.note}” <small className="muted">· {lastNote.by}</small></p>}
      <div className="sd-actions">
        {o.phone ? <a className="btn sd-call" href={`tel:${o.phone}`} aria-label={`Call ${fmtPhone(o.phone)}`}><span aria-hidden="true">☎</span> {fmtPhone(o.phone)}</a> : <span className="btn ghost" aria-disabled="true">No phone number</span>}
        {canAct && <button className="btn sd-update" onClick={() => onUpdate(o)}>Update status</button>}
      </div>
    </article>
  );
}

export default function NdrPage() { return <LabelsProvider><NdrInner /></LabelsProvider>; }

function NdrInner() {
  const { user } = useStaff();
  const { fu } = useLabels();
  const actor = can(user, 'confirmation');
  const [q, setQ] = useState(''); const qd = useDebounced(q);
  const { data, error, loading, reload } = useApi('/desk/ndr', { q: qd });
  useAutoRefresh(reload, 30);
  useEffect(() => { const on = () => reload(); window.addEventListener('desk-refresh', on); return () => window.removeEventListener('desk-refresh', on); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { now, offset } = useClock(data && data.now);
  const [sheet, setSheet] = useState(null); const [open, setOpen] = useState(null);
  const [toast, show] = useToast();
  const hours = data && data.config.ndrHours;
  const when = (i) => (!hours ? '' : i === 0 ? (hours[0] === 0 ? 'Due as soon as the courier reports it' : `Due ${hours[0]} h after the courier reports it`) : `Due ${hours[i]} h after a no-answer`);
  const hint = ['Ask the customer: do you still want this order?', 'Try again, same question.', 'Last try. A no-answer here sends the parcel back to origin.'];
  const names = useMemo(() => ['FU1', 'FU2', 'FU3'], []);
  return (
    <CourierPage title="Non-Delivery Report (NDR)" sub="Parcels the courier could not deliver, taken from Shipway. Call the customer in three follow-ups. If they still want it, the order goes to FU2. A case closes only when Shipway shows Delivered or RTO.">
      <div className="sd-stats">
        <Stat label="Open NDRs" value={data ? int(data.counts.open) : '–'} tone="warn" />
        <Stat label="Calls due now" value={data ? int(data.counts.due) : '–'} tone={data && data.counts.due ? 'bad' : ''} />
        <Stat label="Closed" value={data ? int(data.counts.resolved) : '–'} tone="good" />
      </div>
      <div className="filters"><input type="search" placeholder="Search order number, name, phone or AWB" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /><span className="grow" /><span className="muted">{data ? `${data.shown} open` : ''}</span></div>
      <Loading error={error} loading={loading && !data}>
        {data && (
          <>
            <div className="dq-board">
              {names.map((canon, i) => {
                const items = data.columns[i + 1] || [];
                return (
                  <div key={canon} className={`dq-col fu${i + 1}`}>
                    <div className="dq-colhead">
                      <div className="dq-title"><h2>{fu(canon)}</h2><span className="sd-count">{items.length}</span></div>
                      <span className="dq-when">{when(i)}</span><small>{hint[i]}</small>
                    </div>
                    <div className="dq-cards">
                      {items.length === 0 ? <Empty title="Nothing here">{q ? 'No orders match this.' : i === 0 ? 'When Shipway reports a parcel as undelivered, it appears here by itself.' : 'Cards arrive here after a no-answer in the column before.'}</Empty>
                        : items.map((o) => <NdrCard key={o.case.id} o={o} now={now} offset={offset} canAct={actor} onUpdate={setSheet} onOpen={setOpen} />)}
                    </div>
                  </div>
                );
              })}
            </div>
            <ClosedList items={data.resolved} onOpen={setOpen} />
          </>
        )}
      </Loading>
      {sheet && <NdrSheet o={sheet} now={now} offset={offset} show={show} onClose={() => setSheet(null)} onDone={() => { setSheet(null); reload(); }} />}
      {open && <OrderDrawer orderId={open} onClose={() => setOpen(null)} />}
      {toast}
    </CourierPage>
  );
}
