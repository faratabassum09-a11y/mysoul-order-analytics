import React, { useEffect, useState } from 'react';
import { api, useApi } from '../../api.js';
import { FilterBar, Loading } from '../../components.jsx';
import { useAutoRefresh } from '../../flowUi.js';
import { useFilters } from '../../filters.jsx';
import { inr, int } from '../../format.js';
import { fmtPhone, Empty, OrderDrawer, PayTag, StageTag, useDebounced } from './shared.jsx';

const FILTERS = [['', 'All'], ['confirm', 'Confirm queue'], ['pending', 'Pending'], ['dispatch', 'To dispatch'], ['dispatched', 'Dispatched'], ['partial', 'Partial paid'], ['cancelled', 'Cancelled'], ['none', 'Not in queue']];
const fmtDT = (s) => (s ? new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '—');

// Every order Shopify has, with the desk status next to it. Click one to see everything about it.
export default function DeskOrders() {
  const f = useFilters();
  const [stage, setStage] = useState('');
  const [q, setQ] = useState(''); const qd = useDebounced(q);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [stage, qd, f.window, f.from, f.to]);
  const [open, setOpen] = useState(null);
  const { data, error, loading, reload } = useApi('/desk/orders', { ...f.params, stage, q: qd, page, limit: 50 }, f.ready);
  useAutoRefresh(reload, 30);
  useEffect(() => { const on = () => reload(); window.addEventListener('desk-refresh', on); return () => window.removeEventListener('desk-refresh', on); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [dl, setDl] = useState(''); // '' | 'busy' | error text
  const download = () => { setDl('busy'); api.download('/desk/analysis.xlsx', { ...f.params, stage, q: qd }, 'order-analysis.xlsx').then(() => setDl(''), (e) => setDl(e.message || 'Download failed')); };
  const sc = (data && data.stageCounts) || {};
  const countFor = (k) => (k === '' ? data && data.summary.orders : k === 'partial' ? null : sc[k] || 0);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  return (
    <>
      <FilterBar range={data && data.range} />
      <div className="sd-body">
        <div className="sd-stats">
          <div className="sd-stat"><span>Orders</span><b>{data ? int(data.summary.orders) : '–'}</b></div>
          <div className="sd-stat"><span>Order value</span><b>{data ? inr(data.summary.value) : '–'}</b></div>
          <div className="sd-stat"><span>Average order</span><b>{data ? inr(data.summary.avg) : '–'}</b></div>
          <div className="sd-stat warn"><span>Waiting for a call</span><b>{data ? int((sc.confirm || 0) + (sc.pending || 0)) : '–'}</b></div>
        </div>
        <div className="sd-chips" role="tablist" aria-label="Status">
          {FILTERS.map(([k, l]) => <button key={k} role="tab" aria-selected={stage === k} className={`${k} ${stage === k ? 'on' : ''}`} onClick={() => setStage(k)}>{l}{countFor(k) != null && <b>{int(countFor(k))}</b>}</button>)}
        </div>
        <div className="filters"><input type="search" placeholder="Search order number, name, phone, email or item" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" style={{ minWidth: 280 }} />  <button className="btn" onClick={download} disabled={dl === 'busy' || !data || data.total === 0} title="Excel file: one row per order with every call, confirmation, packing step and Shipway status, plus the full activity log">{dl === 'busy' ? 'Preparing…' : 'Download analysis sheet'}</button>{dl && dl !== 'busy' && <span className="muted"> {dl}</span>}
        </div>
        <Loading error={error} loading={(loading && !data) || !f.ready}>
          {data && (data.total === 0 ? <Empty title="No orders match">{q || stage ? 'Clear the search or status filter, or widen the time window.' : 'No Shopify orders in this time window. Try a longer window, or press Refresh from Shopify.'}</Empty> : (
            <>
              <div className="tablewrap"><table className="sd-table">
                <thead><tr><th>Order</th><th>Placed (IST)</th><th>Customer</th><th>Items</th><th className="num">Total</th><th>Payment</th><th>Status</th><th>Source</th></tr></thead>
                <tbody>{data.rows.map((o) => (
                  <tr key={o.orderId} className="click" onClick={() => setOpen(o.orderId)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(o.orderId)}>
                    <td><b>{o.orderName}</b></td><td>{fmtDT(o.createdAt)}</td>
                    <td>{o.name || '—'}<div className="muted">{[o.phone && fmtPhone(o.phone), o.city].filter(Boolean).join(' · ')}</div></td>
                    <td className="clip" title={o.items}>{o.items}</td><td className="num">{inr(o.total)}</td>
                    <td><PayTag o={o} />{o.partialAmount ? <div className="muted">paid {inr(o.partialAmount)}</div> : null}</td>
                    <td><StageTag stage={o.stage}>{o.status}</StageTag>{o.cancelReason && <div className="muted clip" title={o.cancelReason}>{o.cancelReason}</div>}</td>
                    <td>{o.source || <span className="muted">—</span>}</td>
                  </tr>))}</tbody>
              </table></div>
              <div className="pager"><button className="btn ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {pages} · {int(data.total)} orders</span><button className="btn ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div>
            </>
          ))}
        </Loading>
      </div>
      {open && <OrderDrawer orderId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
