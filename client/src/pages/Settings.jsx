import React, { useEffect, useState } from 'react';
import { api, useApi } from '../api.js';
import { Loading } from '../components.jsx';
import { DeskSettingsCard, TeamCard } from './TeamAdmin.jsx';

const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : '—');

function SummaryLine({ s }) {
  if (!s) return null;
  return (
    <p className="muted">
      {s.sheetRows} sheet rows · {s.valid} valid · {s.tests} test · {s.duplicates} duplicate · {s.missingId} without ID · {s.undated} undated ·
      dates from sheet {s.dateSources.sheet}, OrdersMaster {s.dateSources.ordersmaster}, Shopify CSV {s.dateSources.shopifyCsv}
    </p>
  );
}

function SyncCard() {
  const { data, error, loading, reload } = useApi('/sync/status');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [files, setFiles] = useState({});
  const run = async (name, fn) => {
    setBusy(name); setMsg(null);
    try { const r = await fn(); setMsg({ ok: true, text: name === 'shopify' ? `Imported ${r.imported} order dates and re-cleaned.` : 'Done.', warnings: r.warnings }); reload(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(''); }
  };
  const form = (fields) => { const fd = new FormData(); Object.entries(fields).forEach(([k, v]) => v && fd.append(k, v)); return fd; };
  return (
    <div className="card">
      <h2>Sheet sync</h2>
      <Loading error={error} loading={loading}>
        {data && (
          <>
            <p className="muted">
              {data.config.sheetConfigured ? <>Sheet connected</> : <>No sheet connected yet</>} · {data.config.autoSyncMin ? `backup check every ${data.config.autoSyncMin} min` : 'backup check off'} · last check {when(data.lastCheck && data.lastCheck.at)}{data.lastCheck && data.lastCheck.changed === false ? ' (no new data)' : ''} · data last updated {when(data.lastOk && data.lastOk.at)}
            </p>
            {data.config.autoSyncMin > 0 && data.config.autoSyncMin <= 1 && !data.lastWebhook
              ? <div className="banner"><b>Fast sync is ON.</b> The server checks the sheet every minute, so new orders appear within about a minute. No access to the sheet is needed.</div>
              : !data.config.cronEnabled
              ? <div className="banner err"><b>Instant sync is OFF.</b> New orders arrive only on the {data.config.autoSyncMin}-minute backup check. To switch it on: set CRON_SECRET on the server, then add the Apps Script to the sheet (README, "Instant sync").</div>
              : !data.lastWebhook
                ? <div className="banner err"><b>Instant sync is waiting for the sheet.</b> The server is ready, but the sheet has not sent a signal yet. Add the Apps Script to the sheet and run <code>setup</code> (README, "Instant sync").</div>
                : <div className="banner"><b>Instant sync is ON.</b> Last signal from the sheet: {when(data.lastWebhook.at)}. The {data.config.autoSyncMin}-minute check is only a backup.</div>}
            {data.last && !data.last.ok && <div className="banner err">Last attempt failed: {data.last.error}</div>}
            <SummaryLine s={data.lastOk && data.lastOk.summary} />
            <div className="filters">
              <button className="btn" disabled={!!busy} onClick={() => run('sync', () => api.post('/sync'))}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>
              <button className="btn ghost" disabled={!!busy} onClick={() => run('reclean', () => api.post('/sync/reclean'))}>Re-run cleaning</button>
            </div>
            {msg && <div className={`banner ${msg.ok ? '' : 'err'}`}>{msg.text}{msg.warnings && msg.warnings.length > 0 && <ul className="log">{msg.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}</div>}
          </>
        )}
      </Loading>
      <h2 style={{ marginTop: 18 }}>Upload CSV exports</h2>
      <p className="muted">Use when the sheet cannot be fetched automatically. In Google Sheets: File, Download, CSV (current sheet).</p>
      <div className="field"><label>Order Sheet CSV</label><input type="file" accept=".csv" onChange={(e) => setFiles({ ...files, orderSheet: e.target.files[0] })} /></div>
      <div className="field"><label>OrdersMaster CSV (optional)</label><input type="file" accept=".csv" onChange={(e) => setFiles({ ...files, ordersMaster: e.target.files[0] })} /></div>
      <button className="btn ghost" disabled={!!busy || (!files.orderSheet && !files.ordersMaster)} onClick={() => run('upload', () => api.upload('/sync/upload', form(files)))}>Upload and clean</button>
      <h2 style={{ marginTop: 18 }}>Backfill dates from Shopify</h2>
      <p className="muted">Not needed once Shopify is connected above: the API fills missing dates by itself, for the orders Shopify releases to the app (the last 60 days, or all with the read_all_orders permission). For older orders: Shopify Admin, Orders, Export CSV, then upload it here.</p>
      <div className="field"><input type="file" accept=".csv" onChange={(e) => setFiles({ ...files, shopify: e.target.files[0] })} /></div>
      <button className="btn ghost" disabled={!!busy || !files.shopify} onClick={() => run('shopify', () => api.upload('/sync/shopify-csv', form({ file: files.shopify })))}>Import dates</button>
    </div>
  );
}

function ShopifyCard() {
  const { data, error, loading, reload } = useApi('/shopify/status');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [result, setResult] = useState(null);
  const running = !!(data && data.running);
  useEffect(() => { if (!running) return undefined; const t = setInterval(reload, 4000); return () => clearInterval(t); }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async (full) => {
    setBusy('sync'); setMsg(null);
    try {
      await api.post(`/shopify/sync${full ? '?full=1' : ''}`);
      setMsg({ ok: true, text: full ? 'Loading every order Shopify allows. This can take several minutes. You can leave this page.' : 'Checking Shopify for new and changed orders…' });
      reload();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };
  const connect = async () => {
    setBusy('connect'); setMsg(null);
    try { const r = await api.post('/shopify/connect'); window.location.href = r.url; } // Shopify asks the store owner to approve, then returns here
    catch (e) { setMsg({ ok: false, text: e.message }); setBusy(''); }
  };
  const disconnect = async () => {
    if (!window.confirm('Disconnect Shopify? Customer details already loaded stay, but no new ones will arrive until you connect again.')) return;
    setBusy('disconnect'); setMsg(null);
    try { await api.post('/shopify/disconnect'); reload(); } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };
  const test = async () => {
    setBusy('test'); setMsg(null); setResult(null);
    try { setResult(await api.post('/shopify/test')); } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };
  return (
    <div className="card">
      <h2>Shopify (customer details and items)</h2>
      <Loading error={error} loading={loading}>
        {data && !data.configured && (
          <div className="banner err">
            <b>Not connected yet.</b> On the server, add <code>SHOPIFY_SHOP</code> (the part before .myshopify.com), <code>SHOPIFY_CLIENT_ID</code> and <code>SHOPIFY_CLIENT_SECRET</code> from your app in the Shopify Dev Dashboard, then redeploy. After that, a Connect Shopify button appears here. Steps are in the README, section "Shopify".
          </div>
        )}
        {data && data.configured && (
          <>
            <p className="muted">
              Store {data.shop}.myshopify.com · API {data.apiVersion} · {data.orders} orders loaded · {data.intervalMin ? `pulls changes every ${data.intervalMin} min and after every sheet change` : 'pulls changes after every sheet change'}
              {data.last && <> · last run {when(data.last.at)}{data.last.ok ? ` (${data.last.mode}, ${data.last.saved} orders)` : ''}</>}
            </p>
            {data.auth && data.auth.mode === 'none' && (
              <div className="banner err">
                <b>The store is not linked yet.</b> Press <b>Connect Shopify</b>, then approve the app as the store owner. Before that, make sure this exact address is listed under <b>Redirect URLs</b> in your app version in the Shopify Dev Dashboard (released), and that the store owner has opened the app's install link once:
                <div style={{ margin: '6px 0' }}><code>{data.redirectUri}</code></div>
              </div>
            )}
            {data.auth && data.auth.needsReauth && <div className="banner err"><b>The Shopify connection has expired.</b> Press Connect Shopify to link the store again.</div>}
            {data.auth && data.auth.mode === 'install-link' && !data.auth.needsReauth && <p className="muted">Linked with the store owner's approval{data.auth.installedAt ? ` on ${when(data.auth.installedAt)}` : ''} · permissions: {data.auth.scope || '—'}</p>}
            {running && <div className="banner">Loading from Shopify… {data.progress} orders so far ({data.mode}).</div>}
            {data.last && !data.last.ok && <div className="banner err">Last Shopify run failed: {data.last.error}</div>}
            <div className="filters">
              <button className={data.auth && data.auth.mode === 'none' ? 'btn' : 'btn ghost'} disabled={!!busy || running} onClick={connect}>{busy === 'connect' ? 'Opening Shopify…' : data.auth && data.auth.mode === 'install-link' ? 'Reconnect Shopify' : 'Connect Shopify'}</button>
              <button className="btn ghost" disabled={!!busy || running} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
              <button className="btn ghost" disabled={!!busy || running} onClick={() => start(false)}>Sync now</button>
              <button className="btn ghost" disabled={!!busy || running} onClick={() => start(true)}>Load all orders</button>
              {data.auth && data.auth.mode === 'install-link' && <button className="btn ghost" disabled={!!busy || running} onClick={disconnect}>Disconnect</button>}
            </div>
            {result && (
              <div className={`banner ${result.ok ? '' : 'err'}`}>
                <b>{result.ok ? 'Connected.' : 'Connected, but something needs fixing.'}</b> Shop: {result.shop && result.shop.name}. Permissions: {result.scopes.join(', ') || 'none'}.
                {result.sample && <> Newest order {result.sample.name}: {result.sample.items} items, customer name {result.sample.hasCustomerName ? 'yes' : 'no'}, email {result.sample.hasEmail ? 'yes' : 'no'}, address {result.sample.hasAddress ? 'yes' : 'no'}.</>}
                {!result.allOrdersScope && <> Without the read_all_orders permission, Shopify only returns orders from the last 60 days.</>}
                {result.problems.length > 0 && <ul className="log">{result.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
              </div>
            )}
          </>
        )}
        {msg && <div className={`banner ${msg.ok ? '' : 'err'}`}>{msg.text}</div>}
      </Loading>
    </div>
  );
}

function ShipwayCard() {
  const { data, error, loading, reload } = useApi('/shipway/status');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [result, setResult] = useState(null);
  const running = !!(data && data.running);
  useEffect(() => { if (!running) return undefined; const t = setInterval(reload, 4000); return () => clearInterval(t); }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async (all) => {
    setBusy('sync'); setMsg(null);
    try {
      await api.post(`/shipway/sync${all ? '?all=1' : ''}`);
      setMsg({ ok: true, text: all ? 'Checking every order in Shipway. This can take several minutes. You can leave this page.' : 'Checking Shipway for orders that can still change…' });
      reload();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };
  const test = async () => {
    setBusy('test'); setMsg(null); setResult(null);
    try { setResult(await api.post('/shipway/test')); } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };
  const groupName = (k) => ((data && data.groups.find((g) => g[0] === k)) || [k, k])[1];
  return (
    <div className="card">
      <h2>Shipway (dispatch and tracking status)</h2>
      <Loading error={error} loading={loading}>
        {data && !data.configured && (
          <div className="banner err">
            <b>Not connected yet.</b> On the server, add <code>SHIPWAY_USERNAME</code> (your Shipway login email) and <code>SHIPWAY_LICENSE_KEY</code> (Shipway, Profile, Manage profile; this is not the password), then redeploy.
          </div>
        )}
        {data && data.configured && (
          <>
            <p className="muted">
              Account {data.username} · {data.tracked} orders tracked{Object.keys(data.byGroup).length > 0 && <> ({Object.entries(data.byGroup).map(([k, n]) => `${n} ${groupName(k).toLowerCase()}`).join(', ')})</>} · {data.intervalMin ? `refreshes every ${data.intervalMin} min` : 'refreshes by button only'}
              {data.last && <> · last run {when(data.last.at)}{data.last.ok ? ` (${data.last.checked} checked, ${data.last.changed} changed, ${data.last.missing} not in Shipway)` : ''}</>}
            </p>
            {running && <div className="banner">Checking Shipway… {data.progress} of {data.total} orders.</div>}
            {data.last && !data.last.ok && <div className="banner err">Last Shipway run failed: {data.last.error}</div>}
            <div className="filters">
              <button className="btn ghost" disabled={!!busy || running} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
              <button className="btn ghost" disabled={!!busy || running} onClick={() => start(false)}>Sync now</button>
              <button className="btn ghost" disabled={!!busy || running} onClick={() => start(true)}>Check all orders</button>
            </div>
            {result && (
              <div className={`banner ${result.ok ? '' : 'err'}`}>
                <b>{result.ok ? 'Connected.' : 'Login works, but something needs fixing.'}</b>
                {result.sample && <> Order #{result.sample.orderId} found as "{result.sample.shipwayOrderId}": {result.sample.status}{result.sample.carrier ? `, ${result.sample.carrier}` : ''}{result.sample.awb ? `, AWB ${result.sample.awb}` : ''}.</>}
                {result.problems.length > 0 && <ul className="log">{result.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
              </div>
            )}
          </>
        )}
        {msg && <div className={`banner ${msg.ok ? '' : 'err'}`}>{msg.text}</div>}
      </Loading>
    </div>
  );
}

function SheetCard({ onChanged }) {
  const { data, error, loading, reload } = useApi('/settings/sheet');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (data) setForm({ link: data.link, orderTab: data.orderTab, masterTab: data.masterTab, masterGid: data.masterGid || '' }); }, [data]);
  const set = (k, v) => setForm({ ...form, [k]: v });
  const save = async (andSync) => {
    setBusy(true); setMsg(null);
    try {
      await api.put('/settings/sheet', form);
      if (andSync) {
        try { const r = await api.post('/sync'); setMsg({ ok: true, text: `Connected. Loaded ${r.summary.sheetRows} sheet rows (${r.summary.valid} valid, ${r.summary.undated} undated).`, warnings: r.warnings }); }
        catch (e) { setMsg({ ok: false, text: `Link saved, but the sync failed: ${e.message}` }); }
      } else setMsg({ ok: true, text: 'Saved.' });
      reload(); onChanged();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };
  return (
    <div className="card">
      <h2>Connect Google Sheet</h2>
      <Loading error={error} loading={loading || !form}>
        {form && (
          <>
            <p className="muted">Open the <b>Order Sheet</b> tab in Google Sheets and copy the link from the address bar. The sheet must be shared as <b>Anyone with the link → Viewer</b>. The app only reads it and never edits it.</p>
            <div className="field"><label>Google Sheet link</label><input type="text" value={form.link} placeholder="https://docs.google.com/spreadsheets/d/…/edit?gid=…" onChange={(e) => set('link', e.target.value)} /></div>
            <details style={{ marginBottom: 12 }}>
              <summary className="muted" style={{ cursor: 'pointer' }}>Advanced: tab names</summary>
              <div className="field" style={{ marginTop: 8 }}><label>OrdersMaster tab name</label><input type="text" value={form.masterTab} onChange={(e) => set('masterTab', e.target.value)} /></div>
              <div className="field"><label>OrdersMaster tab ID (gid, optional)</label><input type="text" value={form.masterGid} placeholder="number after gid= on that tab" onChange={(e) => set('masterGid', e.target.value)} /></div>
              <div className="field"><label>Order Sheet tab name (used only when the link has no gid)</label><input type="text" value={form.orderTab} onChange={(e) => set('orderTab', e.target.value)} /></div>
            </details>
            <div className="filters">
              <button className="btn" disabled={busy || !form.link.trim()} onClick={() => save(true)}>{busy ? 'Connecting…' : 'Save and sync'}</button>
              <button className="btn ghost" disabled={busy} onClick={() => save(false)}>Save only</button>
            </div>
            {data.fromEnv && <p className="muted">Currently using the sheet set on the server. Saving here overrides it.</p>}
            {msg && <div className={`banner ${msg.ok ? '' : 'err'}`}>{msg.text}{msg.warnings && msg.warnings.length > 0 && <ul className="log">{msg.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}</div>}
          </>
        )}
      </Loading>
    </div>
  );
}

function ReasonMap() {
  const { data, error, loading } = useApi('/settings/reasons');
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { if (data) setRows(data.map.map((r) => ({ bucket: r.bucket, keywords: r.keywords.join(', ') }))); }, [data]);
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async () => {
    try {
      await api.put('/settings/reasons', { map: rows.map((r) => ({ bucket: r.bucket, keywords: r.keywords.split(',').map((x) => x.trim()).filter(Boolean) })) });
      setMsg('Saved. Reasons screens use the new map straight away.');
    } catch (e) { setMsg(e.message); }
  };
  return (
    <div className="card">
      <h2>Reason buckets</h2>
      <p className="muted">The first bucket with a matching keyword wins, so order matters. Text with no match lands in Other.</p>
      <Loading error={error} loading={loading || !rows}>
        {rows && (
          <>
            {rows.map((r, i) => (
              <div className="bucket" key={i}>
                <input type="text" value={r.bucket} placeholder="Bucket name" onChange={(e) => set(i, 'bucket', e.target.value)} />
                <input type="text" value={r.keywords} placeholder="keywords, separated by commas" onChange={(e) => set(i, 'keywords', e.target.value)} />
                <span className="filters" style={{ margin: 0 }}>
                  <button className="btn ghost" disabled={i === 0} onClick={() => { const c = [...rows]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; setRows(c); }} aria-label="Move up">↑</button>
                  <button className="btn ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove bucket">Remove</button>
                </span>
              </div>
            ))}
            <div className="filters">
              <button className="btn ghost" onClick={() => setRows([...rows, { bucket: '', keywords: '' }])}>Add bucket</button>
              <button className="btn" onClick={save}>Save buckets</button>
              <button className="btn ghost" onClick={() => setRows(data.defaults.map((r) => ({ bucket: r.bucket, keywords: r.keywords.join(', ') })))}>Reset to defaults</button>
            </div>
            {msg && <div className="banner">{msg}</div>}
          </>
        )}
      </Loading>
    </div>
  );
}

export default function Settings() {
  const [v, setV] = useState(0);
  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="lede">Sync the sheet, connect Shopify and Shipway, backfill missing dates and maintain the reason buckets.</p>
      <div className="two">
        <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
          <SheetCard onChanged={() => setV((n) => n + 1)} />
          <ShopifyCard />
          <ShipwayCard />
          <SyncCard key={v} />
        </div>
        <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
          <TeamCard />
          <DeskSettingsCard />
          <ReasonMap />
        </div>
      </div>
    </div>
  );
}
