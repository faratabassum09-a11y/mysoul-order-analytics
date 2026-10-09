import React, { useEffect, useState } from 'react';
import { api, useApi } from '../api.js';
import { useFilters } from '../filters.jsx';
import { FilterBar, Loading, StatusTag } from '../components.jsx';
import { MODES, inr, int } from '../format.js';

const STATUSES = ['Pending confirmation', 'Cancelled', 'Confirmed', 'In Transit', 'Delivered', 'RTO'];
const fmtDT = (s) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : 'Undated');

export function OrderDrawer({ sheetRow, onClose }) {
  const [reveal, setReveal] = useState(false);
  const { data, error, loading } = useApi(`/orders/${sheetRow}`, { reveal: reveal ? '1' : '' });
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Order detail">
        <div className="filters" style={{ justifyContent: 'space-between' }}>
          <h1>{data ? `Order #${data.orderId ?? '—'}` : 'Order'}</h1>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <Loading error={error} loading={loading && !data}>
          {data && (
            <>
              <p>{data.excluded ? <span className="tag RTO">Excluded: {data.excludedReason}</span> : <StatusTag s={data.finalStatus} />} {data.ndr && <span className="tag Pending">NDR</span>}</p>
              <dl className="kv">
                <dt>Order date</dt><dd>{fmtDT(data.orderDate)} {data.dateSource && <span className="muted">· from {data.dateSource}</span>}</dd>
                <dt>Name</dt><dd>{data.name || '—'}</dd>
                <dt>Amount</dt><dd>{inr(data.amount)}</dd>
                <dt>Payment mode</dt><dd>{data.paymentMode}</dd>
                <dt>Product</dt><dd>{data.product}</dd>
                <dt>Shopify link</dt><dd>{data.orderLink ? <a href={data.orderLink} target="_blank" rel="noreferrer">Open in Shopify admin</a> : '—'}</dd>
                <dt>Phone / email</dt>
                <dd>{reveal ? (data.phoneShown || data.emailShown || '—') : <button className="btn ghost" onClick={() => setReveal(true)}>Reveal</button>}</dd>
              </dl>
              {data.conflicts.length > 0 && <div className="banner warn"><b>Conflicts:</b> {data.conflicts.join('; ')}</div>}
              <h2>Original sheet row {data.sheetRow}</h2>
              <table><tbody>{data.raw.map((c) => <tr key={c.column}><td className="muted">{c.column} · {c.header}</td><td style={{ whiteSpace: 'normal' }}>{c.value || <span className="muted">(blank)</span>}</td></tr>)}</tbody></table>
              <h2 style={{ marginTop: 18 }}>Cleaning log</h2>
              {data.log.length ? <ul className="log">{data.log.map((l, i) => <li key={i}>{l}</li>)}</ul> : <p className="muted">No changes were needed.</p>}
            </>
          )}
        </Loading>
      </aside>
    </>
  );
}

export default function Orders() {
  const f = useFilters();
  const [status, setStatus] = useState('');
  const [mode, setMode] = useState('');
  const [ndr, setNdr] = useState('');
  const [q, setQ] = useState('');
  const [qNow, setQNow] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const [exporting, setExporting] = useState(false);
  useEffect(() => { const t = setTimeout(() => { setQNow(q); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => setPage(1), [status, mode, ndr, f.window, f.from, f.to]);
  const params = { ...f.params, status, mode, ndr, q: qNow };
  const { data, error, loading } = useApi('/orders', { ...params, page, limit: 50 }, f.ready);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  const exportCsv = async () => { setExporting(true); try { await api.download('/orders/export.csv', params, 'orders.csv'); } finally { setExporting(false); } };
  return (
    <>
      <FilterBar range={data && data.range} />
      <div className="page">
        <h1>Orders</h1>
        <p className="lede">Click an order to see the original sheet row and what the cleaning step changed.</p>
        <div className="filters">
          <input type="search" placeholder="Order ID or name" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">All statuses</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
          <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Payment mode"><option value="">All payment modes</option>{[...MODES, 'Unknown'].map((m) => <option key={m}>{m}</option>)}</select>
          <select value={ndr} onChange={(e) => setNdr(e.target.value)} aria-label="NDR"><option value="">NDR: any</option><option value="yes">NDR: yes</option><option value="no">NDR: no</option></select>
          <span className="grow" />
          <button className="btn ghost" onClick={exportCsv} disabled={exporting}>{exporting ? 'Exporting…' : 'Export CSV'}</button>
        </div>
        <Loading error={error} loading={(loading && !data) || !f.ready}>
          {data && (
            data.total === 0 ? <div className="empty">No orders match these filters.</div> : (
              <>
                <div className="tablewrap">
                  <table>
                    <thead><tr><th>Order</th><th>Date (IST)</th><th>Name</th><th className="num">Amount</th><th>Mode</th><th>Status</th><th>NDR</th><th>Product</th></tr></thead>
                    <tbody>
                      {data.rows.map((o) => (
                        <tr key={o.sheetRow} className="click" onClick={() => setOpen(o.sheetRow)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(o.sheetRow)}>
                          <td>#{o.orderId}</td><td>{fmtDT(o.orderDate)}</td><td>{o.name}</td><td className="num">{inr(o.amount)}</td>
                          <td>{o.paymentMode}</td><td><StatusTag s={o.finalStatus} /></td><td>{o.ndr ? 'Yes' : ''}</td><td>{o.product}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="pager">
                  <button className="btn ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                  <span>Page {page} of {pages} · {int(data.total)} orders</span>
                  <button className="btn ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
                </div>
              </>
            )
          )}
        </Loading>
      </div>
      {open != null && <OrderDrawer sheetRow={open} onClose={() => setOpen(null)} />}
    </>
  );
}
