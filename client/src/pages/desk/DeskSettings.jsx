import React, { useEffect, useState } from 'react';
import { api, useApi } from '../../api.js';
import { useToast } from '../../deskUi.jsx';
import { DEFAULT_TEMPLATE_PREVIEW, notifyDesk, useLabels } from './shared.jsx';
import AssignSettings from './AssignSettings.jsx';

// Orders from before the start date that nobody has worked on: shown with a count and one button to clear them.
function StaleQueue() {
  const { data, reload } = useApi('/desk/stale-queue');
  const [busy, setBusy] = useState(false);
  const [toast, show] = useToast();
  if (!data) return null;
  const clear = async () => {
    if (!window.confirm(`Remove ${data.count} untouched orders placed before ${data.startFrom} from the queue? Orders anyone has called or updated are not touched. They stay visible under Shopify orders.`)) return;
    setBusy(true);
    try { const r = await api.post('/desk/stale-queue/clear'); notifyDesk(); reload(); show(`${r.removed} old orders removed from the queue.`); }
    catch (e) { show(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="sd-sum" style={{ marginTop: 12 }}>
      <b>{data.count}</b> untouched orders placed before <b>{data.startFrom}</b> (the saved start date) are still sitting in the queue.
      {data.count > 0 && <> <button type="button" className="btn ghost" disabled={busy} onClick={clear}>Remove them from the queue</button></>}
      <small style={{ display: 'block' }}>Save the start date first. Orders someone has already called or updated are never removed.</small>
    </div>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // 0 = Monday, as the server numbers them
const hm = (t) => { const [h, m] = String(t || '12:00').split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const DQ_STAGES = [
  ['slip', 'stepSlip', 'An order enters this step the moment it is confirmed. Press DONE after the slip is printed and stuck on the box.', false],
  ['packed', 'stepPacked', 'Counted from when the packing slip was marked done. DONE opens the form: the AWB and courier are filled from Shipway, and the person adds photos of the package.', true],
  ['handover', 'stepHandover', 'Counted from when the order was packed. DONE opens the form with the photos of the manifest; the order then moves to In-transit orders.', true],
];

// nameKey: this row's name can be changed right here (Settings is admin-only, on the screen and on the server).
const NameEdit = ({ k, def, names, setName }) => (
  <input type="text" className="sd-rename" maxLength={90} value={names[k] === undefined ? def : names[k]} placeholder={def} onChange={(e) => setName(k, e.target.value)} onBlur={(e) => { if (!e.target.value.trim()) setName(k, undefined); }} aria-label={`Name for ${def}`} title="Click to rename" />
);
const NumRow = ({ label, hint, value, onChange, unit, step = 'any', rename }) => (
  <div className="sd-set-row">
    <span>{rename ? <b className="sd-rowname"><NameEdit {...rename} /> <i>is due</i></b> : <b>{label}</b>}<small>{hint}</small></span>
    <span className="sd-num"><input type="number" min="0" step={step} value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label || 'Follow-up'} (${unit})`} /><em>{unit}</em></span>
  </div>
);

// One input per renameable name. Left empty (or equal to the original) it goes back to the original.
function NamesCard({ groups, defaults, names, setName, resetAll }) {
  return (
    <div className="sd-set-card" id="names">
      <h2>Names and labels</h2>
      <p className="cap">Rename anything you see on the desk: tabs, columns, buttons, outcomes. The new name appears everywhere straight after you save. Clear a box to get the original name back. Old history lines keep the words they were written with.</p>
      {groups.map((g) => (
        <div key={g.title} className="names-group">
          <h3>{g.title}</h3>
          <div className="names-grid">
            {g.items.map(([k, def, hint]) => (
              <label key={k} className="names-row"><span>{hint || def}<small>{names[k] && names[k] !== def ? `Original: ${def}` : ''}</small></span>
                <input type="text" maxLength={90} value={names[k] === undefined ? '' : names[k]} placeholder={defaults[k] || def} onChange={(e) => setName(k, e.target.value)} aria-label={`Name for ${def}`} /></label>
            ))}
          </div>
        </div>
      ))}
      <button type="button" className="btn ghost" onClick={resetAll}>Reset every name to the original</button>
    </div>
  );
}

export default function DeskSettings() {
  const { L } = useLabels();
  const { data, reload } = useApi('/desk/config');
  const shop = useApi('/shopify/status').data;
  const dqData = useApi('/desk/dispatch/config');
  const [dq, setDq] = useState(null);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, show] = useToast();
  useEffect(() => { if (data) setF({ names: { ...(data.labels || {}) }, confirmHours: data.confirmHours.map(String), pendingHours: data.pendingHours.map(String), reasons: data.cancelReasons.join('\n'), requireScreenshot: data.requireScreenshot, template: data.whatsappTemplate, startFrom: data.startFrom }); }, [data]);
  useEffect(() => {
    const d = dqData.data; if (!d) return;
    setDq({ allowManualAwb: d.allowManualAwb !== false, workingDays: d.workingDays, holidays: d.holidays.join('\n'), stages: Object.fromEntries(Object.entries(d.stages).map(([k, v]) => [k, { ...v, dayOffset: String(v.dayOffset) }])) });
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
      const labels = Object.fromEntries(Object.keys(data.labelDefaults).map((k) => [k, f.names[k] || '']));
      await api.put('/desk/config', { labels, confirmHours: f.confirmHours.map(Number), pendingHours: f.pendingHours.map(Number), cancelReasons: f.reasons.split('\n'), requireScreenshot: f.requireScreenshot, whatsappTemplate: f.template, startFrom: f.startFrom });
      await api.put('/desk/dispatch/config', {
        workingDays: dq.workingDays, holidays: dq.holidays.split(/[\s,]+/).filter(Boolean),
        allowManualAwb: dq.allowManualAwb,
        stages: Object.fromEntries(Object.entries(dq.stages).map(([k, v]) => [k, { dueTime: v.dueTime, dayOffset: Number(v.dayOffset), ...(k === 'slip' ? {} : { requirePhoto: !!v.requirePhoto }) }])),
      });
      notifyDesk(); window.dispatchEvent(new Event('desk-config-changed')); reload(); dqData.reload(); show('Settings saved. New timings apply to the next follow-up and to every order in the dispatch queue.');
    } catch (e) { show(e.message, 'err'); } finally { setBusy(false); }
  };
  const [h1, h2, h3] = f.confirmHours.map(Number); const [p1, p2, p3] = f.pendingHours.map(Number);
  const when = (h) => (h === 0 ? 'straight away' : `${h} h`);
  const setName = (k, v) => setF((x) => { const names = { ...x.names }; if (v === undefined) delete names[k]; else names[k] = v; return { ...x, names }; });
  const def = data.labelDefaults;
  const rn = (k) => ({ k, def: def[k], names: f.names, setName });
  const webhook = shop && shop.redirectUri ? shop.redirectUri.replace('/api/shopify/callback', '/api/webhook/shopify') : 'https://YOUR-SERVER/api/webhook/shopify';
  return (
    <div className="sd-body sd-settings">
      <nav className="sd-jump" aria-label="Jump to">
        <a href="#followups">Follow-ups</a><a href="#assign">Team assignment</a><a href="#names">Names and labels</a><a href="#dispatch">Dispatch</a>
      </nav>
      <div className="sd-set-card" id="followups">
        <h2 className="sd-rowname"><NameEdit {...rn('tabConfirm')} /> <i>follow-ups</i></h2>
        <p className="cap">Click a name (like FU1) to rename it, then press Save settings. Every new order starts at {L('fu1')}. Press {L('actDnp')} and it waits for the next follow-up. After {L('fu3')} it moves to {L('tabPending')}. All times are in hours.</p>
        <NumRow label={`${L('fu1')} is due`} rename={rn('fu1')} hint="After the order is placed. 0 means the moment it arrives." value={f.confirmHours[0]} onChange={(v) => setAt('confirmHours', 0, v)} unit="hours" />
        <NumRow label={`${L('fu2')} is due`} rename={rn('fu2')} hint={`After ${L('fu1')} was marked ${L('actDnp')}.`} value={f.confirmHours[1]} onChange={(v) => setAt('confirmHours', 1, v)} unit="hours" />
        <NumRow label={`${L('fu3')} is due`} rename={rn('fu3')} hint={`After ${L('fu2')} was marked ${L('actDnp')}.`} value={f.confirmHours[2]} onChange={(v) => setAt('confirmHours', 2, v)} unit="hours" />
        <p className="sd-sum">An order placed at 10:00 is called {when(h1)} after it arrives, again {when(h2)} after the first {L('actDnp')}, and a third time {when(h3)} after the second.</p>
      </div>
      <div className="sd-set-card">
        <h2 className="sd-rowname"><NameEdit {...rn('tabPending')} /> <i>follow-ups</i></h2>
        <p className="cap">Also in hours, and counted the same way as above: each follow-up is due this many hours after the one before it was marked {L('actDnp')}. For example 48, 24, 24 means the first call two days after the order moved here, then a day later, then a day later. A {L('actDnp')} on {L('day3')} cancels the order automatically and moves it to {L('tabCancelled')}.</p>
        <NumRow label={`${L('day1')} is due`} rename={rn('day1')} hint={`After it moved to ${L('tabPending')} (the last ${L('fu3')} ${L('actDnp')}).`} value={f.pendingHours[0]} onChange={(v) => setAt('pendingHours', 0, v)} unit="hours" />
        <NumRow label={`${L('day2')} is due`} rename={rn('day2')} hint={`After ${L('day1')} was marked ${L('actDnp')}.`} value={f.pendingHours[1]} onChange={(v) => setAt('pendingHours', 1, v)} unit="hours" />
        <NumRow label={`${L('day3')} is due`} rename={rn('day3')} hint={`After ${L('day2')} was marked ${L('actDnp')}.`} value={f.pendingHours[2]} onChange={(v) => setAt('pendingHours', 2, v)} unit="hours" />
        <p className="sd-sum">Auto-cancel happens after the last call gets no answer: about {(p1 || 0) + (p2 || 0) + (p3 || 0)} hours after the order moved to {L('tabPending')} if every call is answered on time with {L('actDnp')}.</p>
      </div>
      <AssignSettings />
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
        <StaleQueue />
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
            <h2>{L('tabDispatch')}: {L(title)}</h2>
            <p className="cap">{cap}</p>
            <label className="sd-set-row"><span><b>Due by</b><small>Time of day (IST) on the due working day.</small></span><input type="time" value={st.dueTime} onChange={(e) => setStage(k, 'dueTime', e.target.value)} /></label>
            <NumRow label="Working days allowed" hint="0 = the same working day (the next one if this time has already passed). 1 = the next working day." value={st.dayOffset} onChange={(v) => setStage(k, 'dayOffset', v)} unit="days" step="1" />
            {photo && <label className="sd-check"><input type="checkbox" checked={!!st.requirePhoto} onChange={(e) => setStage(k, 'requirePhoto', e.target.checked)} /> Require at least one {k === 'packed' ? 'photo of the package' : 'photo of the manifest'} before {L('btnDone')}</label>}
            {k === 'packed' && <label className="sd-check"><input type="checkbox" checked={dq.allowManualAwb} onChange={(e) => setDq((x) => ({ ...x, allowManualAwb: e.target.checked }))} /> If Shipway has no AWB for an order yet, let the person type it (otherwise they wait for Shipway)</label>}
            <p className="sd-sum">{n === 0 ? `Due by ${hm(st.dueTime)} on a working day: the same day if the step starts earlier than that, otherwise the next working day.` : `Due by ${hm(st.dueTime)}, ${n} working day${n === 1 ? '' : 's'} after the step starts.`}</p>
          </div>
        );
      })}
      <NamesCard groups={data.labelGroups} defaults={data.labelDefaults} names={f.names} setName={setName} resetAll={() => setF((x) => ({ ...x, names: {} }))} />
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
