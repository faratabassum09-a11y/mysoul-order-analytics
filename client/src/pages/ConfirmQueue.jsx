import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../api.js';
import { Loading } from '../components.jsx';
import { Sheet, useToast } from '../deskUi.jsx';
import { BAND_TEXT, clock, duration, fmtTime, slaBand, useAutoRefresh, useNow, useServerOffset } from '../flowUi.js';
import { inr } from '../format.js';
import { can, useStaff } from '../staff.jsx';

const FILTERS = [['all', 'All'], ['red', 'Overdue'], ['amber', 'Getting late'], ['green', 'On track'], ['escalated', 'Escalated']];

function openLink(url) {
  // Phones deep-link straight into the dialler / WhatsApp. On a desktop, keep the queue open in this tab.
  if (url.startsWith('tel:') || window.matchMedia('(pointer: coarse)').matches) window.location.href = url;
  else window.open(url, '_blank', 'noopener');
}

const quick = (amount, p) => Math.max(1, Math.round((amount * p) / 10) * 10);

function AmountSheet({ title, order, cta, hint, onSubmit, onClose }) {
  const [v, setV] = useState('');
  const n = Number(v);
  const ok = Number.isFinite(n) && n > 0 && (order.amount == null || n <= order.amount);
  return (
    <Sheet title={title} onClose={onClose}>
      <p className="muted">Order #{order.orderId} · {order.name} · total {inr(order.amount)}</p>
      <label className="sheet-label" htmlFor="amt">{hint}</label>
      <div className="amount-row"><span>₹</span><input id="amt" type="text" inputMode="decimal" autoFocus autoComplete="off" value={v} onChange={(e) => setV(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>
      {order.amount > 0 && (
        <div className="chips">
          {[0.25, 0.5, 0.75].map((p) => <button key={p} className="btn ghost" onClick={() => setV(String(quick(order.amount, p)))}>{inr(quick(order.amount, p))}</button>)}
        </div>
      )}
      {v && !ok && <div className="banner err">Enter an amount between ₹1 and {inr(order.amount)}.</div>}
      <button className="btn big" disabled={!ok} onClick={() => onSubmit(n)}>{cta}</button>
    </Sheet>
  );
}

function CancelSheet({ order, reasons, onSubmit, onClose }) {
  const [r, setR] = useState('');
  return (
    <Sheet title={`Cancel order #${order.orderId}`} onClose={onClose}>
      <p className="muted">A reason is required. Pick the closest one.</p>
      <div className="reasons" role="radiogroup" aria-label="Cancellation reason">
        {reasons.map(([k, label]) => (
          <button key={k} role="radio" aria-checked={r === k} className={`reason-opt ${r === k ? 'on' : ''}`} onClick={() => setR(k)}>{label}</button>
        ))}
      </div>
      <button className="btn big danger" disabled={!r} onClick={() => onSubmit(r)}>Cancel this order</button>
    </Sheet>
  );
}

function QueueCard({ o, now, offset, actor, ready, busy, onAct, onSheet, onReach }) {
  const age = now + offset - new Date(o.orderAt).getTime();
  const band = slaBand(age);
  const retryIn = o.nextAttemptAt ? new Date(o.nextAttemptAt).getTime() - (now + offset) : 0;
  const locked = o.attempts >= 3 || retryIn > 0;
  return (
    <article className={`qcard ${band}`} aria-label={`Order ${o.orderId}, ${BAND_TEXT[band]}`}>
      <header>
        <div>
          <div className="q-id">#{o.orderId} <span className="muted">· {o.paymentMode}</span></div>
          <div className="q-name">{o.name || 'No name'}{o.city ? <span className="muted"> · {o.city}</span> : null}</div>
        </div>
        <div className="timer" title={`Ordered ${fmtTime(o.orderAt)}`}>
          <b>{clock(age)}</b>
          <small>{BAND_TEXT[band]}</small>
        </div>
      </header>
      <div className="q-meta">
        <span className="q-amt">{inr(o.amount)}</span>
        <span className="q-items" title={o.items}>{o.items || 'Items not loaded'}</span>
      </div>
      <div className="q-flags">
        {o.attempts > 0 && (
          <span className="attempts" title={`${o.attempts} of 3 no-answer attempts`}>
            {[0, 1, 2].map((i) => <i key={i} className={i < o.attempts ? 'on' : ''} />)} No answer {o.attempts}/3
          </span>
        )}
        {o.escalated && <span className="chip bad">Escalated: needs a decision</span>}
        {o.partialLinkSentAt && <span className="chip">Payment link sent {fmtTime(o.partialLinkSentAt)}</span>}
      </div>
      {actor && (
        <>
          <div className="reach">
            <button className="btn ghost" onClick={() => onReach(o, 'call')}>Call</button>
            <button className="btn ghost" onClick={() => onReach(o, 'whatsapp')}>WhatsApp</button>
            <button className="btn ghost" onClick={() => (ready ? onSheet({ type: 'link', order: o }) : onReach(o, 'partial_link'))}>Payment link</button>
          </div>
          <div className="acts">
            <button className="btn big good" disabled={busy} onClick={() => onAct(o, 'confirm')}>Confirmed</button>
            <button className="btn big" disabled={busy} onClick={() => onSheet({ type: 'partial', order: o })}>Partial pay</button>
            <button className="btn big ghost" disabled={busy || locked} onClick={() => onAct(o, 'no_answer')}>
              {o.attempts >= 3 ? 'No answer (3 of 3 done)' : retryIn > 0 ? `No answer · retry in ${duration(retryIn)}` : `No answer${o.attempts ? ` · attempt ${o.attempts + 1}` : ''}`}
            </button>
            <button className="btn big ghost danger-text" disabled={busy} onClick={() => onSheet({ type: 'cancel', order: o })}>Cancel</button>
          </div>
        </>
      )}
    </article>
  );
}

export default function ConfirmQueue() {
  const { user } = useStaff();
  const actor = can(user, 'confirmation');
  const { data, error, loading, reload } = useApi('/flow/confirm-queue');
  useAutoRefresh(reload, 20);
  const offset = useServerOffset(data && data.now);
  const now = useNow(1000);
  const [filter, setFilter] = useState('all');
  const [sheet, setSheet] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, show] = useToast();

  const items = useMemo(() => (data ? data.items : []), [data]);
  const withBand = useMemo(() => items.map((o) => ({ o, band: slaBand(now + offset - new Date(o.orderAt).getTime()) })), [items, now, offset]);
  const counts = useMemo(() => ({
    all: withBand.length, red: withBand.filter((x) => x.band === 'red').length, amber: withBand.filter((x) => x.band === 'amber').length,
    green: withBand.filter((x) => x.band === 'green').length, escalated: withBand.filter((x) => x.o.escalated).length,
  }), [withBand]);
  const shown = withBand.filter((x) => filter === 'all' || (filter === 'escalated' ? x.o.escalated : x.band === filter));

  const run = async (fn) => { setBusy(true); try { await fn(); } catch (e) { show(e.message, 'err'); } finally { setBusy(false); reload(); } };
  const act = (o, action, extra = {}) => run(async () => {
    const r = await api.post(`/flow/orders/${o.orderId}/confirm-action`, { action, ...extra });
    setSheet(null);
    const text = action === 'confirm' ? `#${o.orderId} confirmed. It is now in the Dispatch Desk.`
      : action === 'partial_pay' ? `#${o.orderId} converted to partial pay (${inr(extra.amount)} paid). It is now in the Dispatch Desk.`
      : action === 'cancel' ? `#${o.orderId} cancelled.`
      : r.outcome === 'cancel' ? `#${o.orderId}: third attempt. The order was auto-cancelled.`
      : r.outcome === 'escalate' ? `#${o.orderId}: third attempt. Escalated for a decision.`
      : `#${o.orderId}: no answer logged (attempt ${r.noAnswerAttempts} of 3).`;
    show(text);
  });
  const reach = (o, channel, amount) => run(async () => {
    const r = await api.post(`/flow/orders/${o.orderId}/contact`, { channel, amount });
    setSheet(null);
    openLink(r.url);
  });

  return (
    <div className="page desk">
      <h1>Confirm queue</h1>
      <p className="lede">Oldest order first. The timer runs from the moment the order was placed: green under 2 hours, amber 2 to 4, red after 4.</p>

      {!actor && user == null && <div className="banner">You are viewing as the dashboard. To act on orders, sign in with your own login on the <Link to="/team">team sign-in page</Link>. Every action is saved under a person&apos;s name.</div>}

      <Loading error={error} loading={(loading && !data)}>
        {data && (
          <>
            <div className="sla-strip" role="tablist" aria-label="Filter by SLA">
              {FILTERS.map(([k, l]) => (
                <button key={k} role="tab" aria-selected={filter === k} className={`sla-tile ${k} ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>
                  <b>{counts[k]}</b><span>{l}</span>
                </button>
              ))}
            </div>
            <p className="cap">Showing orders placed since {data.since}. After three unanswered attempts an order is {data.afterThree === 'escalate' ? 'escalated to a lead' : 'cancelled automatically'}.</p>
            {shown.length === 0 ? (
              <div className="empty">{items.length === 0 ? 'The queue is clear. New orders appear here as soon as they reach the sheet.' : 'No orders in this view.'}</div>
            ) : (
              <div className="qlist">
                {shown.map(({ o }) => (
                  <QueueCard key={o.orderId} o={o} now={now} offset={offset} actor={actor} ready={data.partialLinkReady} busy={busy}
                    onAct={act} onSheet={setSheet} onReach={reach} />
                ))}
              </div>
            )}
          </>
        )}
      </Loading>

      {sheet && sheet.type === 'partial' && (
        <AmountSheet title={`Partial pay · #${sheet.order.orderId}`} order={sheet.order} hint="How much has the customer paid?" cta="Save partial payment"
          onClose={() => setSheet(null)} onSubmit={(amount) => act(sheet.order, 'partial_pay', { amount })} />
      )}
      {sheet && sheet.type === 'link' && (
        <AmountSheet title={`Payment link · #${sheet.order.orderId}`} order={sheet.order} hint="How much should the customer pay now?" cta="Open WhatsApp with the link"
          onClose={() => setSheet(null)} onSubmit={(amount) => reach(sheet.order, 'partial_link', amount)} />
      )}
      {sheet && sheet.type === 'cancel' && (
        <CancelSheet order={sheet.order} reasons={data.cancelReasons} onClose={() => setSheet(null)} onSubmit={(reason) => act(sheet.order, 'cancel', { reason })} />
      )}
      {toast}
    </div>
  );
}
