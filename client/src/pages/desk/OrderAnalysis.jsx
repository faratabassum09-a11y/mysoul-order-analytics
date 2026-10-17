import React, { Fragment, useEffect, useState } from 'react';
import { api, useApi } from '../../api.js';
import { FilterBar, Loading } from '../../components.jsx';
import { useAutoRefresh } from '../../flowUi.js';
import { useFilters } from '../../filters.jsx';
import { inr, int } from '../../format.js';
import { Empty, StageTag, useDebounced } from './shared.jsx';

// The server shifts every time by +5:30, so formatting as UTC shows the IST wall clock.
const when = (s) => (s ? new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' }) : '');
const CHIPS = [['', 'All'], ['confirm', 'Confirm queue'], ['pending', 'Pending'], ['dispatch', 'To dispatch'], ['dispatched', 'Dispatched'], ['cancelled', 'Cancelled'], ['none', 'Not in queue']];
const Mark = ({ v }) => (v ? <span className={`oa-mark ${v === 'Late' ? 'late' : 'ok'}`}>{v}</span> : null);
const Dash = () => <span className="muted">—</span>;

// One step of the journey: who did it and when, or a dash while it has not happened.
function Step({ at, by, extra, mark }) {
  if (!at) return <Dash />;
  return <div className="oa-step"><b>{when(at)}</b><span className="muted">{by}</span>{extra}{mark && <Mark v={mark} />}</div>;
}

function Detail({ r }) {
  return (
    <div className="oa-detail">
      <div className="oa-tl">
        <h4>What happened</h4>
        {r.events.length === 0 ? <p className="muted">Nothing has been saved for this order yet.</p> : (
          <ol>{r.events.map((e, i) => (
            <li key={i} className={/Cancel/.test(e.action) ? 'bad' : /Confirmed|Handed|packed|slip|Partial/i.test(e.action) ? 'good' : /Did not/.test(e.action) ? 'warn' : ''}>
              <time>{when(e.at)}</time><b>{e.action}</b> <span className="muted">by {e.by}{e.fu ? ` · ${e.fu}` : ''}</span>
              <div>{e.label}{e.reason ? ` · ${e.reason}` : ''}{e.amount != null ? ` · ${inr(e.amount)}` : ''}</div>
            </li>))}
          </ol>
        )}
      </div>
      <dl className="kv oa-kv">
        <dt>Items</dt><dd>{r.items || '—'}</dd>
        <dt>Payment</dt><dd>{r.payment || '—'}{r.source ? ` · ${r.source}` : ''}</dd>
        <dt>Calls not picked up</dt><dd>{r.calls} (WhatsApp shared {r.whatsapp})</dd>
        {r.partialAmount != null && <><dt>Partial paid</dt><dd>{inr(r.partialAmount)}{r.partialShot ? ' · screenshot saved' : ''}</dd></>}
        {r.awb && <><dt>AWB</dt><dd>{r.awb}{r.courier ? ` · ${r.courier}` : ''}</dd></>}
        <dt>Package photo</dt><dd>{r.packPhoto || 'No'}</dd>
        <dt>Manifest photo</dt><dd>{r.manifest || 'No'}</dd>
        {r.cancelReason && <><dt>Cancelled</dt><dd>{r.cancelReason} · {r.cancelBy} · {when(r.cancelAt)}</dd></>}
      </dl>
    </div>
  );
}

// Every order and everything that happened to it, on one screen: calls, confirmation, packing slip, packed, handover, Shipway, timings.
export default function OrderAnalysis() {
  const f = useFilters();
  const [stage, setStage] = useState('');
  const [q, setQ] = useState(''); const qd = useDebounced(q);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const [dl, setDl] = useState('');
  useEffect(() => { setPage(1); setOpen(null); }, [stage, qd, f.window, f.from, f.to]);
  const params = { ...f.params, stage, q: qd };
  const { data, error, loading, reload } = useApi('/desk/analysis', { ...params, page, limit: 50 }, f.ready);
  useAutoRefresh(reload, 60);
  useEffect(() => { const on = () => reload(); window.addEventListener('desk-refresh', on); return () => window.removeEventListener('desk-refresh', on); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const exportXlsx = () => { setDl('busy'); api.download('/desk/analysis.xlsx', params, 'order-analysis.xlsx').then(() => setDl(''), (e) => setDl(e.message || 'Export failed')); };
  const s = data && data.summary;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  return (
    <>
      <FilterBar range={data && data.range} />
      <div className="sd-body">
        <div className="sd-stats">
          <div className="sd-stat"><span>Orders</span><b>{s ? int(s.n) : '–'}</b><small>{s ? inr(s.value) : ''}</small></div>
          <div className="sd-stat good"><span>Confirmed</span><b>{s ? int(s.confirmed) : '–'}</b><small>{s && s.avgConfirm != null ? `avg ${s.avgConfirm} h to confirm` : ''}</small></div>
          <div className="sd-stat bad"><span>Cancelled</span><b>{s ? int(s.cancelled) : '–'}</b></div>
          <div className="sd-stat violet"><span>Handed to courier</span><b>{s ? int(s.handed) : '–'}</b><small>{s && s.avgOrderHand != null ? `avg ${s.avgOrderHand} h order to handover` : ''}</small></div>
          <div className="sd-stat warn"><span>Overdue now</span><b>{s ? int(s.overdue) : '–'}</b><small>{s ? `${int(s.late)} with a late step` : ''}</small></div>
        </div>
        <div className="sd-chips" role="tablist" aria-label="Status">
          {CHIPS.map(([k, l]) => <button key={k} role="tab" aria-selected={stage === k} className={`${k} ${stage === k ? 'on' : ''}`} onClick={() => setStage(k)}>{l}{data && <b>{int(k === '' ? data.total : data.chips[k] || 0)}</b>}</button>)}
        </div>
        <div className="filters">
          <input type="search" placeholder="Search order number, name, phone or item" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" style={{ minWidth: 280 }} />
          <button className="btn ghost" onClick={exportXlsx} disabled={dl === 'busy' || !data || data.total === 0}>{dl === 'busy' ? 'Preparing…' : 'Export to Excel'}</button>{dl && dl !== 'busy' && <span className="muted"> {dl}</span>}
        </div>
        <Loading error={error} loading={(loading && !data) || !f.ready}>
          {data && (data.total === 0 ? <Empty title="No orders match">Clear the search or status filter, or widen the time window.</Empty> : (
            <>
              <div className="tablewrap"><table className="sd-table oa-table">
                <thead>
                  <tr className="oa-band"><th colSpan={3}>Order</th><th colSpan={2} className="c">Confirmation</th><th colSpan={3} className="d">Dispatch queue</th><th colSpan={2} className="s">Shipway</th><th className="t">Time</th></tr>
                  <tr><th>Order</th><th>Customer</th><th>Status</th><th>Calls</th><th>Confirmed</th><th>Packing slip</th><th>Packed</th><th>Handed over</th><th>Shipway</th><th>Courier / AWB</th><th className="num">Order → handover</th></tr>
                </thead>
                <tbody>{data.rows.map((r) => (
                  <Fragment key={r.orderId}>
                    <tr className={`click ${open === r.orderId ? 'open' : ''}`} onClick={() => setOpen(open === r.orderId ? null : r.orderId)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(open === r.orderId ? null : r.orderId)} aria-expanded={open === r.orderId}>
                      <td><b>{r.orderName}</b><div className="muted">{when(r.placedAt)}</div></td>
                      <td>{r.customer || '—'}<div className="muted">{[r.city, inr(r.total)].filter(Boolean).join(' · ')}</div></td>
                      <td><StageTag stage={r.stage}>{r.status}</StageTag>{r.cancelReason && <div className="muted clip" title={r.cancelReason}>{r.cancelReason}</div>}{r.overdue && <div><span className="oa-mark late">Overdue · {r.waitingAt}</span></div>}</td>
                      <td>{r.calls ? <span className="oa-calls">{r.calls}<span className="muted"> missed{r.whatsapp ? ` · ${r.whatsapp} WA` : ''}</span></span> : <Dash />}</td>
                      <td>{r.confirmedAt ? <Step at={r.confirmedAt} by={`${r.confirmedBy}${r.confirmedFu ? ` · ${r.confirmedFu}` : ''}`} /> : <Dash />}{r.partialAmount != null && <div className="muted">partial {inr(r.partialAmount)}</div>}</td>
                      <td><Step at={r.slipAt} by={r.slipBy} mark={r.slipOn} /></td>
                      <td><Step at={r.packedAt} by={r.packedBy} mark={r.packedOn} extra={r.packPhoto ? <span className="muted">photo ✓</span> : null} /></td>
                      <td><Step at={r.handAt} by={r.handBy} mark={r.handOn} extra={r.manifest ? <span className="muted">manifest ✓</span> : null} /></td>
                      <td>{r.shipStatus ? <><b>{r.shipStatus}</b><div className="muted">{when(r.shipAt)}</div></> : <Dash />}</td>
                      <td>{r.awb || r.courier ? <>{r.courier}<div className="muted">{r.awb}</div></> : <Dash />}</td>
                      <td className="num">{r.hOrderHand != null ? `${r.hOrderHand} h` : <Dash />}</td>
                    </tr>
                    {open === r.orderId && <tr className="oa-open"><td colSpan={11}><Detail r={r} /></td></tr>}
                  </Fragment>))}</tbody>
              </table></div>
              <div className="pager"><button className="btn ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {pages} · {int(data.total)} orders</span><button className="btn ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div>
            </>
          ))}
        </Loading>
      </div>
    </>
  );
}
