import React, { useEffect, useState } from 'react';
import { api, useApi } from '../api.js';
import { Loading } from '../components.jsx';

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
              Source: <b>{data.config.source}</b>{data.config.sheetConfigured ? '' : ' (SHEET_ID not set)'} · auto-sync {data.config.autoSyncMin ? `every ${data.config.autoSyncMin} min` : 'off'} · last successful sync {when(data.lastOk && data.lastOk.at)}
            </p>
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
      <p className="muted">One-time Shopify Admin, Orders, Export CSV. Fills dates for orders that have none (such as #1023 to #1202). This is a file upload, not the Step 2 API.</p>
      <div className="field"><input type="file" accept=".csv" onChange={(e) => setFiles({ ...files, shopify: e.target.files[0] })} /></div>
      <button className="btn ghost" disabled={!!busy || !files.shopify} onClick={() => run('shopify', () => api.upload('/sync/shopify-csv', form({ file: files.shopify })))}>Import dates</button>
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
  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="lede">Sync the sheet, backfill missing dates and maintain the reason buckets.</p>
      <div className="two"><SyncCard /><ReasonMap /></div>
    </div>
  );
}
