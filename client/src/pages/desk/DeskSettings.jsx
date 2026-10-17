import React, { useEffect, useState } from 'react';
import { api, useApi } from '../../api.js';
import { useToast } from '../../deskUi.jsx';
import { DEFAULT_TEMPLATE_PREVIEW, notifyDesk } from './shared.jsx';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // 0 = Monday, as the server numbers them
const hm = (t) => { const [h, m] = String(t || '12:00').split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const DQ_STAGES = [
  ['slip', 'Packing slip', 'An order enters this step the moment it is confirmed. Press DONE after the slip is printed and stuck on the box.', false],
  ['packed', 'Order packed', 'Counted from when the packing slip was marked done. DONE opens the form: AWB (filled from Shopify) and a photo of the package.', true],
  ['handover', 'Order handover', 'Counted from when the order was packed. DONE opens the form with the photo of the manifest; the order then moves to In-transit orders.', true],
];

const NumRow = ({ label, hint, value, onChange, unit, step = 'any' }) => (
  <label className="sd-set-row">
    <span><b>{label}</b><small>{hint}</small></span>
    <span className="sd-num"><input type="number" min="0" step={step} value={value} onChange={(e) => onChange(e.target.value)} /><em>{unit}</em></span>
  </label>
);

export default function DeskSettings() {
  const { data, reload } = useApi('/desk/config');
  const shop = useApi('/shopify/status').data;
  const dqData = useApi('/desk/dispatch/config');
  const [dq, setDq] = useState(null);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, show] = useToast();
  useEffect(() => { if (data) setF({ confirmHours: data.confirmHours.map(String), pendingDays: data.pendingDays.map(String), reasons: data.cancelReasons.join('\n'), requireScreenshot: data.requireScreenshot, template: data.whatsappTemplate, startFrom: data.startFrom }); }, [data]);
  useEffect(() => {
    const d = dqData.data; if (!d) return;
    setDq({ workingDays: d.workingDays, holidays: d.holidays.join('\n'), stages: Object.fromEntries(Object.entries(d.stages).map(([k, v]) => [k, { ...v, dayOffset: String(v.dayOffset) }])) });
  }, [dqData.data]);
  useEffect(() => { if (dq && window.location.hash === '#dispatch') document.getElementById('dispatch')?.scrollIntoView({ block: 'start' }); }, [!!dq]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!f || !dq) return <div className="empty">Loading…</div>;
  const setStage = (k, key, v) => setDq((x) => ({ ...x, stages: { ...x.stages, [k]: { ...x.stages[k], [key]: v } } }));
  const toggleDay = (i) => setDq((x) => ({ ...x, workingDays: x.workingDays.includes(i) ? x.workingDays.filter((d) => d !== i) : [...x.workingDays, i].sort() }));
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setAt = (k, i, v) => setF((x) => ({ ...x, [k]: x[k].map((y, j) => (j === i ? v : y)) }));
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/desk/config', { confirmHours: f.confirmHours.map(Number), pendingDays: f.pendingDays.map(Number), cancelReasons: f.reasons.split('\n'), requireScreenshot: f.requireScreenshot, whatsappTemplate: f.template, startFrom: f.startFrom });
      await api.put('/desk/dispatch/config', {
        workingDays: dq.workingDays, holidays: dq.holidays.split(/[\s,]+/).filter(Boolean),
        stages: Object.fromEntries(Object.entries(dq.stages).map(([k, v]) => [k, { dueTime: v.dueTime, dayOffset: Number(v.dayOffset), ...(k === 'slip' ? {} : { requirePhoto: !!v.requirePhoto }) }])),
      });
      notifyDesk(); reload(); dqData.reload(); show('Settings saved. New timings apply to the next follow-up and to every order in the dispatch queue.');
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
      <div className="sd-set-card" id="dispatch">
        <h2>Dispatch queue: working days</h2>
        <p className="cap">Deadlines below are counted in working days. A step that starts on a day off is planned for the next working day.</p>
        <div className="sd-chips" role="group" aria-label="Working days" style={{ margin: 0 }}>
          {DAYS.map((d, i) => <button key={d} type="button" aria-pressed={dq.workingDays.includes(i)} className={dq.workingDays.includes(i) ? 'on' : ''} onClick={() => toggleDay(i)}>{d}</button>)}
        </div>
        <label className="sheet-label" htmlFor="dq-hol">Holidays (one date per line, like 2026-11-08)</label>
        <textarea id="dq-hol" className="sd-text" rows={3} value={dq.holidays} onChange={(e) => setDq((x) => ({ ...x, holidays: e.target.value }))} placeholder="2026-11-08" />
      </div>
      {DQ_STAGES.map(([k, title, cap, photo]) => {
        const st = dq.stages[k]; const n = Number(st.dayOffset);
        return (
          <div className="sd-set-card" key={k}>
            <h2>Dispatch queue: {title}</h2>
            <p className="cap">{cap}</p>
            <label className="sd-set-row"><span><b>Due by</b><small>Time of day (IST) on the due working day.</small></span><input type="time" value={st.dueTime} onChange={(e) => setStage(k, 'dueTime', e.target.value)} /></label>
            <NumRow label="Working days allowed" hint="0 = the same working day (the next one if this time has already passed). 1 = the next working day." value={st.dayOffset} onChange={(v) => setStage(k, 'dayOffset', v)} unit="days" step="1" />
            {photo && <label className="sd-check"><input type="checkbox" checked={!!st.requirePhoto} onChange={(e) => setStage(k, 'requirePhoto', e.target.checked)} /> Require a {k === 'packed' ? 'photo of the package' : 'photo of the manifest'} before DONE</label>}
            <p className="sd-sum">{n === 0 ? `Due by ${hm(st.dueTime)} on a working day: the same day if the step starts earlier than that, otherwise the next working day.` : `Due by ${hm(st.dueTime)}, ${n} working day${n === 1 ? '' : 's'} after the step starts.`}</p>
          </div>
        );
      })}
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
