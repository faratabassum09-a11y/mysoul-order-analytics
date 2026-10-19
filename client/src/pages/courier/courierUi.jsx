import React from 'react';
import { fmtWhen } from '../../flowUi.js';

// Page frame shared by the three courier-problem screens (same look as the Shopify desk).
export function CourierPage({ title, sub, actions, children }) {
  return (
    <div className="sd">
      <div className="sd-top">
        <div><h1>{title}</h1><p className="sd-sub">{sub}</p></div>
        {actions}
      </div>
      {children}
    </div>
  );
}

export const Stat = ({ label, value, tone, sub }) => <div className={`sd-stat ${tone || ''}`}><span>{label}</span><b>{value}</b>{sub && <small>{sub}</small>}</div>;

export const NOTE_PLACEHOLDER = 'What did the customer say? Anything the next person should know';
export function NoteField({ value, onChange, id = 'case-note' }) {
  return (
    <>
      <label className="sheet-label" htmlFor={id}>Notes (optional)</label>
      <textarea id={id} className="sd-text" rows={3} maxLength={500} value={value} onChange={(e) => onChange(e.target.value)} placeholder={NOTE_PLACEHOLDER} />
    </>
  );
}

// What was done so far, newest last: who, when, what they typed.
export function History({ log }) {
  const rows = (log || []).filter((e) => e.action !== 'opened');
  if (!rows.length) return null;
  return (
    <div className="cs-history">
      <b>History</b>
      {rows.map((e, i) => <p key={i}><span>{fmtWhen(e.at)} · {e.by}</span>{e.label}</p>)}
    </div>
  );
}

export const OUTCOME = {
  wants: ['Still wants it', 'good'], not_wants: ['Does not want it', 'bad'], no_response: ['No response', 'bad'], delivered: ['Delivered', 'good'], rto: ['Going back (RTO)', 'warn'], moved: ['Status changed', ''],
  accepted: ['Charge accepted', ''], reversed: ['Fully reversed', 'good'], partial: ['Partly credited', 'good'], rejected: ['Rejected', 'bad'],
};
export const OutcomeTag = ({ o }) => { const [t, tone] = OUTCOME[o] || [o, '']; return <span className={`cs-tag ${tone}`}>{t}</span>; };

// Closed cases, newest first.
export function ClosedList({ items, onOpen, extra }) {
  if (!items.length) return null;
  return (
    <details className="cs-closed">
      <summary>Recently closed <b>{items.length}</b></summary>
      <div className="tablewrap"><table className="sd-table">
        <thead><tr><th>Order</th><th>Customer</th><th>Result</th><th>Closed</th><th>By</th><th>Notes</th>{extra && <th className="num">{extra.label}</th>}</tr></thead>
        <tbody>{items.map((o) => (
          <tr key={o.case.id} className={o.orderId ? 'click' : ''} onClick={() => o.orderId && onOpen && onOpen(o.orderId)}>
            <td><b>{o.orderName}</b></td><td>{o.name || '—'}</td><td><OutcomeTag o={o.case.resolution.outcome} /></td>
            <td>{fmtWhen(o.case.resolution.at)}</td><td>{o.case.resolution.by}</td><td className="wrap">{o.case.resolution.note || <span className="muted">—</span>}</td>
            {extra && <td className="num">{extra.get(o)}</td>}
          </tr>))}</tbody>
      </table></div>
    </details>
  );
}
