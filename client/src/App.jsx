import React, { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, getKey, setKey, useApi } from './api.js';
import Overview from './pages/Overview.jsx';
import Trends from './pages/Trends.jsx';
import PaymentMode from './pages/PaymentMode.jsx';
import Campaigns from './pages/Campaigns.jsx';
import Reasons from './pages/Reasons.jsx';
import Orders from './pages/Orders.jsx';
import Issues from './pages/Issues.jsx';
import Settings from './pages/Settings.jsx';

const NAV = [
  ['/', 'Overview'], ['/trends', 'Trends'], ['/payment-mode', 'Payment mode'], ['/campaigns', 'Campaigns'], ['/reasons', 'Reasons'],
  ['/orders', 'Orders'], ['/issues', 'Data issues'], ['/settings', 'Settings'],
];

function Login({ onDone }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    setKey(pw);
    try { await api.get('/sync/status'); onDone(); } catch (e) { setErr('That access key did not work.'); }
  };
  return (
    <div className="login">
      <div className="card">
        <h1>MySoul Orders</h1>
        <input type="password" placeholder="Access key" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} autoFocus />
        {err && <div className="banner err">{err}</div>}
        <button className="btn" onClick={submit}>Open dashboard</button>
      </div>
    </div>
  );
}

function SyncNote() {
  const { data, reload } = useApi('/sync/status');
  useEffect(() => { const t = setInterval(reload, 60000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Every 10 s ask whether new data arrived; if so, tell every open screen to refresh itself.
  useEffect(() => {
    let seen = null;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const s = await api.get('/sync/status');
        const at = s.lastOk && s.lastOk.at;
        if (seen && at && at !== seen) window.dispatchEvent(new Event('data-updated'));
        if (at) seen = at;
      } catch (e) { /* offline or locked: try again next tick */ }
    };
    poll();
    const t = setInterval(poll, 10000);
    return () => clearInterval(t);
  }, []);
  const check = data && data.lastCheck;
  if (!check) return <div className="sync-note">No sheet data loaded yet</div>;
  const mins = Math.max(0, Math.round((Date.now() - new Date(check.at).getTime()) / 60000));
  const every = (data.config && data.config.autoSyncMin) || 15;
  const behind = mins > Math.max(45, every * 3);
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  return (
    <div className="sync-note" style={behind ? { color: '#b42318' } : undefined}>
      {behind ? `Sync is behind: last check ${ago}` : `Sheet checked ${ago}`}
      {data.last && !data.last.ok && <div>Last attempt failed. See Settings.</div>}
    </div>
  );
}

export default function App() {
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    const on = () => setLocked(true);
    window.addEventListener('auth-required', on);
    return () => window.removeEventListener('auth-required', on);
  }, []);
  if (locked) return <Login onDone={() => { setLocked(false); window.location.reload(); }} />;
  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">MySoul Orders<small>Sheet analytics</small></div>
        {NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>)}
        <div className="spacer" />
        <SyncNote />
      </nav>
      <div className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/trends" element={<Trends />} />
          <Route path="/payment-mode" element={<PaymentMode />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/reasons" element={<Reasons />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/issues" element={<Issues />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}
