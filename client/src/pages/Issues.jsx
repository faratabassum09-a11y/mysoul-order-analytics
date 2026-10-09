import React, { useState } from 'react';
import { useApi } from '../api.js';
import { Loading } from '../components.jsx';
import { OrderDrawer } from './Orders.jsx';
import { inr } from '../format.js';

const META = {
  undated: ['Undated orders', 'No date in column A, OrdersMaster or the Shopify CSV. They count in All time only. Upload a Shopify orders CSV in Settings to backfill.'],
  conflicts: ['Conflicting statuses', 'For example Cancel but dispatched, or RTO marked while Delivery Status says Delivered. Fix the status columns in the sheet.'],
  duplicates: ['Duplicates', 'Same order ID on several rows. The row with the most filled status columns is kept, the rest are listed here.'],
  tests: ['Test orders', 'Amount below Rs 100, name containing "test", or notes equal to "test". Check the rule is not catching real orders.'],
  missingId: ['Missing order IDs', 'Rows with no usable order ID. They stay out of every metric.'],
  unknownPayment: ['Unknown payment mode', 'COD/Prepaid column is blank or not COD, Partial COD or Prepaid.'],
  missingAmount: ['Missing amount', 'Amount column is blank, so the order adds nothing to order value.'],
};

export default function Issues() {
  const { data, error, loading } = useApi('/issues');
  const [sel, setSel] = useState('undated');
  const [open, setOpen] = useState(null);
  const cur = data && data.issues.find((i) => i.key === sel);
  return (
    <div className="page">
      <h1>Data issues</h1>
      <p className="lede">Fix these in the source sheet and the next sync picks them up. The app never edits the sheet.</p>
      <Loading error={error} loading={loading}>
        {data && (
          <>
            <div className="grid">
              {data.issues.map((i) => (
                <button key={i.key} className={`issue-card ${sel === i.key ? 'on' : ''} ${i.count ? '' : 'zero'}`} onClick={() => setSel(i.key)}>
                  <div className="n">{i.count}</div><div>{META[i.key][0]}</div>
                </button>
              ))}
            </div>
            {cur && (
              <div className="section">
                <h2>{META[cur.key][0]}</h2>
                <p className="muted">{META[cur.key][1]}</p>
                {cur.count === 0 ? <div className="empty">Nothing to fix here.</div> : (
                  <div className="tablewrap">
                    <table>
                      <thead><tr><th>Sheet row</th><th>Order</th><th>Name</th><th className="num">Amount</th><th>Detail</th></tr></thead>
                      <tbody>
                        {cur.rows.map((o) => (
                          <tr key={o.sheetRow} className="click" onClick={() => setOpen(o.sheetRow)}>
                            <td>{o.sheetRow}</td><td>{o.orderId ? `#${o.orderId}` : '—'}</td><td>{o.name}</td><td className="num">{inr(o.amount)}</td>
                            <td style={{ whiteSpace: 'normal' }}>{o.excludedReason || (o.conflicts && o.conflicts.join('; ')) || (cur.key === 'unknownPayment' ? 'Payment column not recognised' : '')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {cur.count > cur.rows.length && <p className="muted">Showing the first {cur.rows.length} of {cur.count}.</p>}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </Loading>
      {open != null && <OrderDrawer sheetRow={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
