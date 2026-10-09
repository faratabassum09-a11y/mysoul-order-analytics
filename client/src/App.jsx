import React, { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, getKey, setKey, useApi } from './api.js';
import Overview from './pages/Overview.jsx';
import Trends from './pages/Trends.jsx';
import PaymentMode from './pages/PaymentMode.jsx';
import Reasons from './pages/Reasons.jsx';
import Orders from './pages/Orders.jsx';
import Issues from './pages/Issues.jsx';
import Settings from './pages/Settings.jsx';

const NAV = [
  ['/', 'Overview'], ['/trends', 'Trends'], ['/payment-mode', 'Payment mode'], ['/reasons', 'Reasons'],
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
  const { data } = useApi('/sync/status');
  const last = data && data.lastOk;
  return (
    <div className="sync-note">
      {last ? `Sheet data as of ${new Date(last.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}` : 'No sheet data loaded yet'}
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
