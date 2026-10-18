import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../../api.js';
import { Loading } from '../../components.jsx';
import { useToast } from '../../deskUi.jsx';
import { useAutoRefresh } from '../../flowUi.js';
import { can, useStaff } from '../../staff.jsx';
import { Empty, OrderDrawer, QueueCard, UpdateStatusSheet, WhoFilter, Workload, notifyDesk, peopleFor, useAssign, useClock, useDebounced, useDeskConfig, useLabels, useTeam } from './shared.jsx';

// Confirm queue (FU1 | FU2 | FU3) and Pending orders (Day 1 | Day 2 | Day 3) as boards, laid out like the Dispatch queue:
// one column per follow-up with its own timing, count and (when switched on) its own team.
function CallBoard({ kind }) {
  const { user } = useStaff();
  const { L, fu } = useLabels();
  const actor = can(user, 'confirmation');
  const isAdmin = user.role === 'admin';
  const conf = useDeskConfig();
  const team = useTeam();
  const [q, setQ] = useState(''); const qd = useDebounced(q);
  const [who, setWho] = useState('');
  const { data, error, loading, reload } = useApi(`/desk/board/${kind}`, { q: qd, assignee: who });
  useAutoRefresh(reload, 20);
  useEffect(() => { const on = () => reload(); window.addEventListener('desk-refresh', on); return () => window.removeEventListener('desk-refresh', on); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { now, offset } = useClock(data && data.now);
  const [sheet, setSheet] = useState(null); const [open, setOpen] = useState(null);
  const [picked, setPicked] = useState([]); const [bulkTo, setBulkTo] = useState(''); const [busy, setBusy] = useState(false);
  const [toast, show] = useToast();
  const assign = useAssign({ reload, show });
  const people = peopleFor(team, kind);
  const counts = data && data.counts[kind];
  const names = kind === 'confirm' ? ['FU1', 'FU2', 'FU3'] : ['Day 1', 'Day 2', 'Day 3'];
  const hours = conf ? (kind === 'confirm' ? conf.confirmHours : conf.pendingHours) : null;
  const when = (i) => {
    if (!hours) return '';
    const h = hours[i]; const first = i === 0;
    if (kind === 'confirm' && first) return h === 0 ? 'Due when the order arrives' : `Due ${h} h after the order`;
    if (first) return h === 0 ? 'Due as soon as it moves here' : `Due ${h} h after it moved here`;
    return h === 0 ? 'Due right after a no-answer' : `Due ${h} h after a no-answer`;
  };
  const hint = (i) => (i < 2 ? `Call the customer, then press ${L('btnUpdate')}.` : kind === 'confirm' ? `A ${L('actDnp')} here moves the order to ${L('tabPending')}.` : `A ${L('actDnp')} here cancels the order automatically.`);
  const modeOf = (i) => (data && data.assign ? data.assign.modes[`${kind}${i + 1}`] : 'off');
  const anyAssign = data && Object.values(data.assign.modes).some((m) => m !== 'off');
  const all = useMemo(() => (data ? [1, 2, 3].flatMap((n) => data.columns[n]) : []), [data]);
  const dueNow = all.filter((o) => o.dueAt && new Date(o.dueAt).getTime() <= now + offset).length;
  const pick = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  useEffect(() => { setPicked((p) => p.filter((id) => all.some((o) => o.orderId === id))); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const applyBulk = async () => {
    setBusy(true);
    try {
      const r = await api.post('/desk/assign/bulk', { orderIds: picked, userId: bulkTo || null });
      notifyDesk(); show(r.failed.length ? `${r.done} updated, ${r.failed.length} could not be changed.` : `${r.done} order${r.done === 1 ? '' : 's'} updated.`, r.failed.length ? 'err' : 'ok');
      setPicked([]); reload();
    } catch (e) { show(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <section>
      <div className="dq-head">
        <p className="sd-hint">{kind === 'confirm' ? `New Shopify orders land in ${fu('FU1')}. ${L('actDnp')} moves an order to the next column; each column has its own timing.` : `Orders land here after three unanswered confirm calls. Each follow-up is counted in hours from the previous no-answer.`}</p>
        {isAdmin && <Link className="btn ghost" to="/shopify-desk/settings#followups">⚙ Follow-up settings</Link>}
      </div>
      <div className="filters">
        <input type="search" placeholder="Search order number, name or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <WhoFilter value={who} onChange={setWho} people={isAdmin ? people : []} show={!!anyAssign || !!who} />
        <span className="grow" />
        {data && <span className="muted">{data.shown} {data.shown === 1 ? 'order' : 'orders'}{dueNow ? ` · ${dueNow} due now` : ''}</span>}
      </div>
      {isAdmin && picked.length > 0 && (
        <div className="bulk-bar" role="region" aria-label="Assign selected orders">
          <b>{picked.length} selected</b>
          <select value={bulkTo} onChange={(e) => setBulkTo(e.target.value)} aria-label="Give to"><option value="">Take off their person</option>{people.map((p) => <option key={p.id} value={p.id}>Give to {p.name}</option>)}</select>
          <button className="btn good" disabled={busy} onClick={applyBulk}>{busy ? 'Saving…' : 'Apply'}</button>
          <button className="btn ghost" onClick={() => setPicked([])}>Clear</button>
        </div>
      )}
      <Loading error={error} loading={loading && !data}>
        {data && (
          <div className="dq-board">
            {names.map((canon, i) => {
              const items = data.columns[i + 1] || [];
              const mode = modeOf(i);
              const due = counts ? counts.dueFu[i] : 0;
              return (
                <div key={canon} className={`dq-col ${kind === 'confirm' ? `fu${i + 1}` : 'pend'}`}>
                  <div className="dq-colhead">
                    <div className="dq-title"><h2>{fu(canon)}</h2><span className={`sd-count ${due ? 'hot' : ''}`} title={due ? `${due} due now` : ''}>{counts ? counts.fu[i] : items.length}</span>
                      {isAdmin && <Link className="dq-gear" to="/shopify-desk/settings#followups" title={`${fu(canon)} settings`} aria-label={`${fu(canon)} settings`}>⚙</Link>}</div>
                    <span className="dq-when">{when(i)}</span>
                    <small>{hint(i)}</small>
                    {mode !== 'off' && <span className="dq-when asg">{mode === 'auto' ? 'Shared out automatically' : 'Assigned by an admin'}</span>}
                    {mode !== 'off' && isAdmin && <Workload items={items} />}
                  </div>
                  <div className="dq-cards">
                    {items.length === 0
                      ? <Empty title="Nothing here">{q || who ? 'No orders match this.' : i === 0 && kind === 'confirm' ? 'New Shopify orders appear here by themselves.' : 'Cards arrive here after a no-answer in the column before.'}</Empty>
                      : items.map((o) => <QueueCard key={o.orderId} o={o} now={now} offset={offset} canAct={actor} onUpdate={setSheet} onOpen={setOpen}
                          assign={mode !== 'off' ? { mode, isAdmin, me: user.id, people, onAssign: assign } : null}
                          picked={isAdmin && mode !== 'off' ? picked.includes(o.orderId) : null} onPick={isAdmin && mode !== 'off' ? pick : null} />)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Loading>
      {sheet && <UpdateStatusSheet order={sheet} conf={conf} now={now} offset={offset} show={show} onClose={() => setSheet(null)} onDone={() => { setSheet(null); reload(); }} />}
      {open && <OrderDrawer orderId={open} onClose={() => setOpen(null)} />}
      {toast}
    </section>
  );
}
export const ConfirmQueue = () => <CallBoard kind="confirm" />;
export const PendingQueue = () => <CallBoard kind="pending" />;
