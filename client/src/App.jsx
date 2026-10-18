import React, { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, useApi } from './api.js';
import { ROLE_LABEL } from './flowUi.js';
import { useStaff } from './staff.jsx';
import ShopifyDesk, { deskHome } from './pages/desk/ShopifyDesk.jsx';
import ConfirmQueue from './pages/ConfirmQueue.jsx';
import DispatchDesk from './pages/DispatchDesk.jsx';
import TeamLogin, { ChangePassword, homeFor } from './pages/TeamLogin.jsx';
import Overview from './pages/Overview.jsx';
import TeamDashboard from './pages/TeamDashboard.jsx';
import Trends from './pages/Trends.jsx';
import PaymentMode from './pages/PaymentMode.jsx';
import Campaigns from './pages/Campaigns.jsx';
import Reasons from './pages/Reasons.jsx';
import Orders from './pages/Orders.jsx';
import Issues from './pages/Issues.jsx';
import Settings from './pages/Settings.jsx';

// Third item 'sub' = an indented entry that lives under the item above it.
const NAV = [
  ['/', 'Overview'], ['/shopify-desk', 'Shopify desk'], ['/team-performance', 'Team performance'], ['/trends', 'Trends'], ['/payment-mode', 'Payment mode'], ['/campaigns', 'Campaigns'], ['/reasons', 'Reasons'],
  ['/orders', 'Orders'], ['/confirm-queue', 'Confirm queue', 'sub'], ['/dispatch-desk', 'Dispatch desk', 'sub'],
  ['/issues', 'Data issues'], ['/settings', 'Settings'],
];

// Small live counts next to the two desks: what is waiting, and what is overdue.
function useBadges() {
  const [b, setB] = useState(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const [q, d, s] = await Promise.all([api.get('/flow/confirm-queue'), api.get('/flow/dispatch', { section: 'print_slip' }), api.get('/desk/counts').catch(() => null)]);
        if (live) setB({ queue: q.counts, desk: d.counts, shop: s });
      } catch (e) { /* not signed in or offline: no badges */ }
    };
    load();
    const t = setInterval(load, 60000);
    window.addEventListener('desk-changed', load);
    return () => { live = false; clearInterval(t); window.removeEventListener('desk-changed', load); };
  }, []);
  return b;
}
function Badge({ to, badges }) {
  if (!badges) return null;
  if (to === '/shopify-desk' && badges.shop) {
    const due = badges.shop.confirm.due + badges.shop.pending.due;
    const open = badges.shop.confirm.total + badges.shop.pending.total;
    if (open > 0) return <span className={`nav-badge ${due > 0 ? 'bad' : ''}`} title={`${due} calls due now`}>{due > 0 ? due : open}</span>;
  }
  if (to === '/confirm-queue' && badges.queue.total > 0) return <span className={`nav-badge ${badges.queue.red > 0 ? 'bad' : ''}`} title={`${badges.queue.red} overdue`}>{badges.queue.total}</span>;
  if (to === '/dispatch-desk') {
    if (badges.desk.delayed > 0) return <span className="nav-badge bad" title="Delayed orders">{badges.desk.delayed}</span>;
    if (badges.desk.print_slip + badges.desk.ready_for_pickup > 0) return <span className="nav-badge">{badges.desk.print_slip + badges.desk.ready_for_pickup}</span>;
  }
  return null;
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

// Packing and confirmation team members get a stripped-down, phone-first screen: their desk, nothing else.
function StaffShell({ user }) {
  const { logout } = useStaff();
  return (
    <div className="staff-shell">
      <header className="staff-top">
        <div><b>MySoul</b><small>{user.name} · {ROLE_LABEL[user.role]}</small></div>
        <button className="btn ghost" onClick={logout}>Sign out</button>
      </header>
      <main>
        <Routes>
          <Route path="/confirm-queue" element={<ConfirmQueue />} />
          <Route path="/dispatch-desk" element={<DispatchDesk />} />
          <Route path="/shopify-desk/*" element={<ShopifyDesk />} />
          <Route path="*" element={<Navigate to={homeFor(user)} replace />} />
        </Routes>
      </main>
      <nav className="staff-tabs" aria-label="Desks">
        <NavLink to="/confirm-queue" className={({ isActive }) => (isActive ? 'active' : '')}>Confirm queue</NavLink>
        <NavLink to="/dispatch-desk" className={({ isActive }) => (isActive ? 'active' : '')}>Dispatch desk</NavLink>
        <NavLink to={deskHome(user)} className={({ isActive }) => (isActive ? 'active' : '')}>Shopify desk</NavLink>
      </nav>
    </div>
  );
}

function Dashboard({ user }) {
  const { logout } = useStaff();
  const badges = useBadges();
  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">MySoul Orders<small>Sheet analytics</small></div>
        {NAV.map(([to, label, kind]) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `${kind === 'sub' ? 'sub ' : ''}${isActive ? 'active' : ''}`}>
            {label}<Badge to={to} badges={badges} />
          </NavLink>
        ))}
        <div className="spacer" />
        <SyncNote />
        <div className="sync-note">
          Signed in as <b>{user.name}</b> · <a href="#out" onClick={(e) => { e.preventDefault(); logout(); }}>Sign out</a>
        </div>
      </nav>
      <div className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/team-performance" element={<TeamDashboard />} />
          <Route path="/trends" element={<Trends />} />
          <Route path="/payment-mode" element={<PaymentMode />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/reasons" element={<Reasons />} />
          <Route path="/shopify-desk/*" element={<ShopifyDesk />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/confirm-queue" element={<ConfirmQueue />} />
          <Route path="/dispatch-desk" element={<DispatchDesk />} />
          <Route path="/issues" element={<Issues />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}

function Gate() {
  const { user, loading } = useStaff();
  if (loading) return <div className="empty">Loading…</div>;
  if (!user) return <Navigate to="/team" replace />;
  if (user.mustChangePassword) return <ChangePassword />;
  if (user.role !== 'admin') return <StaffShell user={user} />;
  return <Dashboard user={user} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/team" element={<TeamLogin />} />
      <Route path="*" element={<Gate />} />
    </Routes>
  );
}
