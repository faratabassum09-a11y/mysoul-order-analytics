import React, { useEffect, useMemo, useState } from 'react';
import { api, useApi } from '../../api.js';
import { Loading } from '../../components.jsx';
import { Sheet, useToast } from '../../deskUi.jsx';
import { useAutoRefresh, fmtWhen } from '../../flowUi.js';
import { inr } from '../../format.js';
import { useStaff } from '../../staff.jsx';
import { fmtPhone, Empty, Lightbox, OrderDrawer, ShotImg, StageTag, notifyDesk, useDebounced, usePager } from './shared.jsx';

const useRefreshEvent = (reload) => useEffect(() => { const on = () => reload(); window.addEventListener('desk-refresh', on); return () => window.removeEventListener('desk-refresh', on); }, []); // eslint-disable-line react-hooks/exhaustive-deps
const Search = ({ q, setQ }) => <input type="search" placeholder="Search order number, name or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />;
const Stat = ({ label, value, tone, sub }) => <div className={`sd-stat ${tone || ''}`}><span>{label}</span><b>{value}</b>{sub && <small>{sub}</small>}</div>;

// ---------------------------------------------------------------- Partial paid
export function PartialPaid() {
  const [q, setQ] = useState(''); const qd = useDebounced(q);
  const { data, error, loading, reload } = useApi('/desk/queue/partial', { q: qd, limit: 200 });
  useAutoRefresh(reload, 30); useRefreshEvent(reload);
  const [open, setOpen] = useState(null); const [shot, setShot] = useState(null);
  const s = data && data.sums;
  return (
    <section>
      <p className="sd-hint">Orders where the customer paid part of the amount up front. They also sit in the Dispatch queue with the balance to collect.</p>
      <div className="sd-stats">
        <Stat label="Partial paid orders" value={s ? s.orders : '–'} tone="violet" />
        <Stat label="Received so far" value={s ? inr(s.collected) : '–'} tone="good" sub="Excludes cancelled orders" />
        <Stat label="Balance still to collect" value={s ? inr(s.balance) : '–'} tone="warn" sub="Courier collects on delivery" />
      </div>
      <div className="filters"><Search q={q} setQ={setQ} /></div>
      <Loading error={error} loading={loading && !data}>
        {data && (data.items.length === 0 ? <Empty title="No partial payments yet">When someone taps Update status, then Partial paid, the amount and screenshot are kept here.</Empty> : (
          <div className="sd-grid">
            {data.items.map((o) => (
              <article key={o.orderId} className={`sd-card partial ${o.stage === 'cancelled' ? 'cancelled' : ''}`}>
                <header><div className="sd-id"><button className="link" onClick={() => setOpen(o.orderId)}>{o.orderName}</button><StageTag stage={o.stage}>{o.stage === 'cancelled' ? 'Cancelled' : o.stage === 'dispatched' ? 'Dispatched' : 'To dispatch'}</StageTag></div><span className="muted">{fmtWhen(o.partial.at)}</span></header>
                <div className="sd-who"><b>{o.name || 'No name'}</b><span className="muted"> · {fmtPhone(o.phone)}</span></div>
                <div className="sd-money"><div><span>Order total</span><b>{inr(o.total)}</b></div><div><span>Paid</span><b className="good-text">{inr(o.partial.amount)}</b></div><div><span>Balance</span><b>{inr(o.partial.balance)}</b></div></div>
                {o.partial.notes && <p className="sd-note">“{o.partial.notes}”</p>}
                {o.refundDue && <div className="banner err" style={{ margin: 0 }}>Order cancelled after payment: refund {inr(o.partial.amount)}.</div>}
                <div className="sd-foot"><span>Taken by {o.partial.byName}{o.partial.fromFu ? ` on ${o.partial.fromFu}` : ''}</span></div>
                {o.partial.screenshotId && <ShotImg id={o.partial.screenshotId} onOpen={setShot} />}
              </article>
            ))}
          </div>
        ))}
      </Loading>
      {open && <OrderDrawer orderId={open} onClose={() => setOpen(null)} />}
      {shot && <Lightbox src={shot} onClose={() => setShot(null)} />}
    </section>
  );
}

// ---------------------------------------------------------------- Cancelled orders
export function CancelledOrders() {
  const { user } = useStaff();
  const [q, setQ] = useState(''); const qd = useDebounced(q);
  const [reason, setReason] = useState('');
  const { data, error, loading, reload } = useApi('/desk/queue/cancelled', { q: qd, limit: 200 });
  useAutoRefresh(reload, 30); useRefreshEvent(reload);
  const [open, setOpen] = useState(null); const [ask, setAsk] = useState(null); const [toast, show] = useToast();
  const items = data ? data.items : [];
  const reasons = useMemo(() => { const m = new Map(); items.forEach((o) => m.set(o.cancel.reason, (m.get(o.cancel.reason) || 0) + 1)); return [...m.entries()].sort((a, b) => b[1] - a[1]); }, [items]);
  const shown = reason ? items.filter((o) => o.cancel.reason === reason) : items;
  const pager = usePager(shown.length, 50, [reason, qd]);
  const page = shown.slice((pager.page - 1) * 50, pager.page * 50);
  const s = data && data.sums;
  const restore = async () => {
    try { await api.post(`/desk/orders/${ask.orderId}/action`, { action: 'restore' }); notifyDesk(); show(`${ask.orderName} is back in the confirm queue.`); setAsk(null); reload(); }
    catch (e) { show(e.message, 'err'); setAsk(null); reload(); }
  };
  return (
    <section>
      <p className="sd-hint">Every cancelled order with its full amount and reason. Orders that got no answer after six follow-ups are cancelled automatically.</p>
      <div className="sd-stats">
        <Stat label="Cancelled orders" value={s ? s.orders : '–'} tone="bad" />
        <Stat label="Order value lost" value={s ? inr(s.value) : '–'} tone="bad" />
        <Stat label="Auto-cancelled (no answer)" value={s ? s.auto : '–'} tone="warn" sub={s && s.orders ? `${Math.round((s.auto / s.orders) * 100)}% of cancellations` : ''} />
        <Stat label="Refunds due" value={s ? inr(s.refundDue) : '–'} tone={s && s.refundDue ? 'bad' : ''} sub="Partial payments on cancelled orders" />
      </div>
      <div className="filters"><Search q={q} setQ={setQ} />
        <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason"><option value="">All reasons</option>{reasons.map(([r, n]) => <option key={r} value={r}>{r} ({n})</option>)}</select></div>
      <Loading error={error} loading={loading && !data}>
        {data && (shown.length === 0 ? <Empty title="No cancelled orders">{q || reason ? 'Nothing matches these filters.' : 'Cancelled orders and their reasons will be listed here.'}</Empty> : (
          <>
            <div className="tablewrap"><table className="sd-table">
              <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th className="num">Total</th><th>Reason</th><th>Cancelled by</th><th>When</th><th>From</th>{user.role === 'admin' && <th />}</tr></thead>
              <tbody>{page.map((o) => (
                <tr key={o.orderId} className="click" onClick={() => setOpen(o.orderId)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(o.orderId)}>
                  <td><b>{o.orderName}</b></td><td>{o.name}<div className="muted">{fmtPhone(o.phone)}</div></td><td className="clip" title={o.items}>{o.items}</td><td className="num">{inr(o.total)}{o.refundDue && <div className="bad-text">refund {inr(o.partial.amount)}</div>}</td>
                  <td className="wrap">{o.cancel.reason}{o.cancel.note && <div className="muted">{o.cancel.note}</div>}</td>
                  <td>{o.cancel.auto ? <span className="chip">{o.cancel.byName}</span> : o.cancel.byName}</td><td>{fmtWhen(o.cancel.at)}</td><td>{o.cancel.fromStage === 'pending' ? 'Pending' : o.cancel.fromStage === 'dispatch' ? 'Dispatch queue' : 'Confirm queue'}</td>
                  {user.role === 'admin' && <td><button className="btn ghost" onClick={(e) => { e.stopPropagation(); setAsk(o); }}>Restore</button></td>}
                </tr>))}</tbody>
            </table></div>
            {pager.node}
          </>
        ))}
      </Loading>
      {ask && <Sheet title={`Restore ${ask.orderName}?`} onClose={() => setAsk(null)}><p>The order goes back to the confirm queue at FU1 and the follow-up count starts again. Its history is kept.</p><button className="btn big" onClick={restore}>Restore to confirm queue</button></Sheet>}
      {open && <OrderDrawer orderId={open} onClose={() => setOpen(null)} />}
      {toast}
    </section>
  );
}
