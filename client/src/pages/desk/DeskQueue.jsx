import React, { useEffect, useMemo, useState } from 'react';
import { useApi } from '../../api.js';
import { Loading } from '../../components.jsx';
import { useToast } from '../../deskUi.jsx';
import { useAutoRefresh } from '../../flowUi.js';
import { can, useStaff } from '../../staff.jsx';
import { Empty, OrderDrawer, QueueCard, UpdateStatusSheet, useClock, useDebounced, useDeskConfig } from './shared.jsx';

// One screen for both call queues. confirm: FU1 / FU2 / FU3. pending: Day 1 / Day 2 / Day 3.
function CallQueue({ kind }) {
  const { user } = useStaff();
  const actor = can(user, 'confirmation');
  const conf = useDeskConfig();
  const [fu, setFu] = useState('');
  const [q, setQ] = useState('');
  const qd = useDebounced(q);
  const { data, error, loading, reload } = useApi(`/desk/queue/${kind}`, { fu, q: qd, limit: 200 });
  useAutoRefresh(reload, 20);
  useEffect(() => { const on = () => reload(); window.addEventListener('desk-refresh', on); return () => window.removeEventListener('desk-refresh', on); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { now, offset } = useClock(data && data.now);
  const [sheet, setSheet] = useState(null);
  const [open, setOpen] = useState(null);
  const [toast, show] = useToast();
  const c = data && data.counts[kind];
  const label = (i) => (kind === 'confirm' ? `FU${i}` : `Day ${i}`);
  const hint = kind === 'confirm'
    ? (conf ? `FU1 opens ${conf.confirmHours[0] === 0 ? 'the moment the order arrives' : `${conf.confirmHours[0]} h after the order`}; FU2 ${conf.confirmHours[1]} h and FU3 ${conf.confirmHours[2]} h after the previous no-answer. After FU3 the order moves to Pending.` : '')
    : (conf ? `Day ${1} / ${2} / ${3} follow-ups open ${conf.pendingDays.join(' / ')} days after the order moved here. A no-answer on Day 3 cancels the order automatically.` : '');
  const items = useMemo(() => (data ? data.items : []), [data]);
  const dueNow = items.filter((o) => o.dueAt && new Date(o.dueAt).getTime() <= now + offset).length;
  return (
    <section>
      <p className="sd-hint">{hint}</p>
      <div className="sd-tiles" role="tablist" aria-label="Follow-up">
        <button role="tab" aria-selected={fu === ''} className={`sd-tile all ${fu === '' ? 'on' : ''}`} onClick={() => setFu('')}><b>{c ? c.total : '–'}</b><span>All</span><small>{c ? `${c.due} due now` : ''}</small></button>
        {[1, 2, 3].map((i) => (
          <button key={i} role="tab" aria-selected={fu === String(i)} className={`sd-tile ${kind === 'confirm' ? `fu${i}` : 'pend'} ${fu === String(i) ? 'on' : ''}`} onClick={() => setFu(String(i))}>
            <b>{c ? c.fu[i - 1] : '–'}</b><span>{label(i)}</span><small>{c ? `${c.dueFu[i - 1]} due now` : ''}</small>
          </button>
        ))}
      </div>
      <div className="filters"><input type="search" placeholder="Search order number, name or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /><span className="grow" />{data && <span className="muted">{items.length} shown{dueNow ? ` · ${dueNow} due now` : ''}</span>}</div>
      <Loading error={error} loading={loading && !data}>
        {data && (items.length === 0
          ? <Empty title={q ? 'No orders match this search' : kind === 'confirm' ? 'The confirm queue is clear' : 'No pending orders'}>{q ? 'Try the order number or the last digits of the phone.' : kind === 'confirm' ? 'New Shopify orders appear here by themselves as FU1.' : 'Orders land here after three unanswered confirm calls.'}</Empty>
          : <div className="sd-grid">{items.map((o) => <QueueCard key={o.orderId} o={o} now={now} offset={offset} canAct={actor} onUpdate={setSheet} onOpen={setOpen} />)}</div>)}
      </Loading>
      {sheet && <UpdateStatusSheet order={sheet} conf={conf} now={now} offset={offset} show={show} onClose={() => setSheet(null)} onDone={() => { setSheet(null); reload(); }} />}
      {open && <OrderDrawer orderId={open} onClose={() => setOpen(null)} />}
      {toast}
    </section>
  );
}
export const ConfirmQueue = () => <CallQueue kind="confirm" />;
export const PendingQueue = () => <CallQueue kind="pending" />;
