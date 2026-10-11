import React, { useEffect, useState } from 'react';
import { api, useApi } from '../api.js';
import { useFilters } from '../filters.jsx';
import { FilterBar, Loading, StatusTag } from '../components.jsx';
import { MODES, inr, int } from '../format.js';

const STATUSES = ['Pending confirmation', 'Cancelled', 'Confirmed', 'In Transit', 'Delivered', 'RTO'];
const fmtDT = (s) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : 'Undated');

function ShopifySection({ s, reveal, onReveal }) {
  if (!s) return null;
  if (!s.found) {
    const text = s.reason === 'not_configured' ? 'Shopify is not connected yet. Connect it in Settings to see customer details and items here.'
      : s.reason === 'error' ? `Could not load this order from Shopify: ${s.error}`
      : 'Shopify has no data for this order yet. If the order is older than 60 days, Shopify only releases it once the app has the read_all_orders permission.';
    return <div className="banner" style={{ marginTop: 14 }}>{text}</div>;
  }
  const a = s.address || {}; const c = s.customer || {};
  const where = [a.city, a.state, a.country].filter(Boolean).join(', ');
  return (
    <>
      <h2 style={{ marginTop: 18 }}>Items ordered</h2>
      {s.items.length ? (
        <table>
          <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th></tr></thead>
          <tbody>
            {s.items.map((i, k) => (
              <tr key={k}>
                <td style={{ whiteSpace: 'normal' }}>{i.title}{i.variantTitle && <span className="muted"> · {i.variantTitle}</span>}{i.sku && <span className="muted"> · {i.sku}</span>}</td>
                <td className="num">{i.quantity}{i.orderedQuantity !== i.quantity && <span className="muted"> (ordered {i.orderedQuantity})</span>}</td>
                <td className="num">{i.price == null ? '—' : inr(i.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted">No items on this order.</p>}
      <dl className="kv" style={{ marginTop: 10 }}>
        {s.subtotal != null && <><dt>Subtotal</dt><dd>{inr(s.subtotal)}</dd></>}
        {s.discounts > 0 && <><dt>Discounts</dt><dd>−{inr(s.discounts)}</dd></>}
        {s.shipping != null && <><dt>Shipping</dt><dd>{inr(s.shipping)}</dd></>}
        {s.total != null && <><dt>Total (Shopify)</dt><dd><b>{inr(s.total)}</b></dd></>}
      </dl>
      <h2 style={{ marginTop: 18 }}>Customer (Shopify)</h2>
      <dl className="kv">
        <dt>Name</dt><dd>{c.name || '—'}</dd>
        <dt>Location</dt><dd>{where || '—'}</dd>
        {reveal ? (
          <>
            <dt>Phone</dt><dd>{c.phone || a.phone || '—'}</dd>
            <dt>Email</dt><dd>{c.email || '—'}</dd>
            <dt>Address</dt><dd style={{ whiteSpace: 'normal' }}>{[a.name, a.line1, a.line2, a.city, a.state, a.zip, a.country].filter(Boolean).join(', ') || '—'}</dd>
          </>
        ) : <><dt>Phone, email, address</dt><dd><button className="btn ghost" onClick={onReveal}>Reveal</button></dd></>}
        <dt>Payment</dt><dd>{[(s.paymentGateways || []).join(', '), s.financialStatus].filter(Boolean).join(' · ') || '—'}</dd>
        <dt>Fulfilment</dt><dd>{s.fulfillmentStatus || '—'}{s.cancelledAt && <span className="muted"> · cancelled {fmtDT(s.cancelledAt)}</span>}</dd>
        {s.note && <><dt>Customer note</dt><dd style={{ whiteSpace: 'normal' }}>{s.note}</dd></>}
        {s.tags && s.tags.length > 0 && <><dt>Tags</dt><dd>{s.tags.join(', ')}</dd></>}
      </dl>
    </>
  );
}

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
              <ShopifySection s={data.shopify} reveal={reveal} onReveal={() => setReveal(true)} />
              {data.conflicts.length > 0 && <div className="banner warn" style={{ marginTop: 14 }}><b>Conflicts:</b> {data.conflicts.join('; ')}</div>}
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
        <p className="lede">Click an order to see its items, customer details from Shopify, the original sheet row and what the cleaning step changed.</p>
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
                    <thead><tr><th>Order</th><th>Date (IST)</th><th>Name</th><th className="num">Amount</th><th>Mode</th><th>Status</th><th>NDR</th><th>City</th><th>Items</th></tr></thead>
                    <tbody>
                      {data.rows.map((o) => (
                        <tr key={o.sheetRow} className="click" onClick={() => setOpen(o.sheetRow)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(o.sheetRow)}>
                          <td>#{o.orderId}</td><td>{fmtDT(o.orderDate)}</td><td>{o.name}</td><td className="num">{inr(o.amount)}</td>
                          <td>{o.paymentMode}</td><td><StatusTag s={o.finalStatus} /></td><td>{o.ndr ? 'Yes' : ''}</td><td>{o.city || ''}</td><td title={o.items || o.product}>{o.items || o.product}</td>
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
