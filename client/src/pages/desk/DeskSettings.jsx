import React, { useEffect, useState } from 'react';
import { api, useApi } from '../../api.js';
import { useToast } from '../../deskUi.jsx';
import { DEFAULT_TEMPLATE_PREVIEW, notifyDesk } from './shared.jsx';

const NumRow = ({ label, hint, value, onChange, unit, step = 'any' }) => (
  <label className="sd-set-row">
    <span><b>{label}</b><small>{hint}</small></span>
    <span className="sd-num"><input type="number" min="0" step={step} value={value} onChange={(e) => onChange(e.target.value)} /><em>{unit}</em></span>
  </label>
);

export default function DeskSettings() {
  const { data, reload } = useApi('/desk/config');
  const shop = useApi('/shopify/status').data;
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, show] = useToast();
  useEffect(() => { if (data) setF({ confirmHours: data.confirmHours.map(String), pendingDays: data.pendingDays.map(String), reasons: data.cancelReasons.join('\n'), requireScreenshot: data.requireScreenshot, template: data.whatsappTemplate, startFrom: data.startFrom }); }, [data]);
  if (!f) return <div className="empty">Loading…</div>;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setAt = (k, i, v) => setF((x) => ({ ...x, [k]: x[k].map((y, j) => (j === i ? v : y)) }));
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/desk/config', { confirmHours: f.confirmHours.map(Number), pendingDays: f.pendingDays.map(Number), cancelReasons: f.reasons.split('\n'), requireScreenshot: f.requireScreenshot, whatsappTemplate: f.template, startFrom: f.startFrom });
      notifyDesk(); reload(); show('Settings saved. New timings apply to the next follow-up of every order.');
    } catch (e) { show(e.message, 'err'); } finally { setBusy(false); }
  };
  const [h1, h2, h3] = f.confirmHours.map(Number); const [d1, d2, d3] = f.pendingDays.map(Number);
  const when = (h) => (h === 0 ? 'straight away' : `${h} h`);
  const webhook = shop && shop.redirectUri ? shop.redirectUri.replace('/api/shopify/callback', '/api/webhook/shopify') : 'https://YOUR-SERVER/api/webhook/shopify';
  return (
    <div className="sd-body sd-settings">
      <div className="sd-set-card">
        <h2>Confirm queue follow-ups</h2>
        <p className="cap">Every new order starts at FU1. Press DNP and it waits for the next follow-up. After FU3 it moves to Pending orders.</p>
        <NumRow label="FU1 is due" hint="After the order is placed. 0 means the moment it arrives." value={f.confirmHours[0]} onChange={(v) => setAt('confirmHours', 0, v)} unit="hours" />
        <NumRow label="FU2 is due" hint="After FU1 was marked DNP." value={f.confirmHours[1]} onChange={(v) => setAt('confirmHours', 1, v)} unit="hours" />
        <NumRow label="FU3 is due" hint="After FU2 was marked DNP." value={f.confirmHours[2]} onChange={(v) => setAt('confirmHours', 2, v)} unit="hours" />
        <p className="sd-sum">An order placed at 10:00 is called {when(h1)} after it arrives, again {when(h2)} after the first DNP, and a third time {when(h3)} after the second DNP.</p>
      </div>
      <div className="sd-set-card">
        <h2>Pending orders follow-ups</h2>
        <p className="cap">Counted from the day the order moved to Pending. A DNP on Day 3 cancels the order automatically and moves it to Cancelled orders.</p>
        <NumRow label="Day 1 follow-up" hint="Days after it moved to Pending." value={f.pendingDays[0]} onChange={(v) => setAt('pendingDays', 0, v)} unit="days" />
        <NumRow label="Day 2 follow-up" hint="Must be later than Day 1." value={f.pendingDays[1]} onChange={(v) => setAt('pendingDays', 1, v)} unit="days" />
        <NumRow label="Day 3 follow-up" hint="Must be later than Day 2." value={f.pendingDays[2]} onChange={(v) => setAt('pendingDays', 2, v)} unit="days" />
        <p className="sd-sum">Auto-cancel happens {d3 || 3} days after the order moved to Pending, if the Day 1, Day 2 and Day 3 calls all went unanswered (day {d1 || 1}, {d2 || 2}, {d3 || 3}).</p>
      </div>
      <div className="sd-set-card">
        <h2>Cancellation reasons</h2>
        <p className="cap">One per line. These are the quick choices when someone cancels an order. “Other” always lets them type their own.</p>
        <textarea className="sd-text" rows={9} value={f.reasons} onChange={(e) => set('reasons', e.target.value)} aria-label="Cancellation reasons" />
      </div>
      <div className="sd-set-card">
        <h2>WhatsApp message and partial payments</h2>
        <p className="cap">Sent when someone presses “Open WhatsApp”. Placeholders: {'{name}'} {'{order}'} {'{items}'} {'{amount}'} {'{balance}'}.</p>
        <textarea className="sd-text" rows={5} value={f.template} onChange={(e) => set('template', e.target.value)} aria-label="WhatsApp message" />
        <p className="sd-preview">{DEFAULT_TEMPLATE_PREVIEW(f.template)}</p>
        <label className="sd-check"><input type="checkbox" checked={f.requireScreenshot} onChange={(e) => set('requireScreenshot', e.target.checked)} /> Require a payment screenshot for Partial paid</label>
      </div>
      <div className="sd-set-card">
        <h2>Which orders enter the queue</h2>
        <p className="cap">Only Shopify orders placed on or after this date are put into the confirm queue. Older orders still show in Shopify orders. Move the date back to bring older orders in; they start at FU1.</p>
        <label className="sd-set-row"><span><b>Queue starts from</b><small>Date in IST</small></span><input type="date" value={f.startFrom} onChange={(e) => set('startFrom', e.target.value)} /></label>
      </div>
      <div className="sd-set-card">
        <h2>Live from Shopify</h2>
        <p className="cap">The server pulls new and changed orders every {shop && shop.intervalMin ? shop.intervalMin : 2} minutes. For instant arrival, add webhooks in Shopify (Dev Dashboard, your app, Webhooks) for <b>orders/create</b> and <b>orders/updated</b> pointing to:</p>
        <code className="sd-code">{webhook}</code>
        <p className="cap">{shop ? (shop.configured ? `Connected to ${shop.shop}. ${shop.orders} orders stored.` : 'Shopify is not connected yet. Connect it in the main Settings page.') : ''}</p>
      </div>
      <div className="sd-savebar"><button className="btn big" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button></div>
      {toast}
    </div>
  );
}
