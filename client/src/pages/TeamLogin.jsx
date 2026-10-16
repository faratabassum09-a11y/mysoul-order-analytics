import React, { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useStaff } from '../staff.jsx';

export const homeFor = (u) => (!u ? '/team' : u.role === 'packing' ? '/dispatch-desk' : u.role === 'confirmation' ? '/confirm-queue' : '/');

export default function TeamLogin() {
  const { user, login } = useStaff();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // Signed in with a password someone else set: show the change-password screen right here on /team.
  if (user && user.mustChangePassword) return <ChangePassword />;
  if (user) return <Navigate to={homeFor(user)} replace />;
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr('');
    try { const u = await login(username, password); if (!u.mustChangePassword) nav(homeFor(u), { replace: true }); } // if a change is required, the render above swaps in ChangePassword
    catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <div className="login team-login">
      <form className="card" onSubmit={submit}>
        <h1>MySoul team</h1>
        <p className="muted" style={{ margin: 0 }}>Sign in with your own login. Everything you do is saved under your name.</p>
        <label className="sheet-label" htmlFor="u">Username</label>
        <input id="u" type="text" autoCapitalize="none" autoCorrect="off" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <label className="sheet-label" htmlFor="p">Password</label>
        <input id="p" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <div className="banner err" role="alert">{err}</div>}
        <button className="btn big" type="submit" disabled={busy || !username || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

// Shown before anything else when a person is using a password somebody else set for them.
export function ChangePassword() {
  const { user, changePassword, logout } = useStaff();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = again && next !== again;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await changePassword(cur, next); } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <div className="login team-login">
      <form className="card" onSubmit={submit}>
        <h1>Set your own password</h1>
        <p className="muted" style={{ margin: 0 }}>Hi {user.name}. The password you were given was set by someone else. Choose one only you know (at least 8 characters).</p>
        <label className="sheet-label" htmlFor="c">Password you were given</label>
        <input id="c" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} autoFocus />
        <label className="sheet-label" htmlFor="n">New password</label>
        <input id="n" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <label className="sheet-label" htmlFor="a">New password again</label>
        <input id="a" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        {mismatch && <div className="banner err">The two new passwords do not match.</div>}
        {err && <div className="banner err" role="alert">{err}</div>}
        <button className="btn big" type="submit" disabled={busy || !cur || next.length < 8 || next !== again}>{busy ? 'Saving…' : 'Save password'}</button>
        <button className="btn ghost" type="button" onClick={logout}>Sign out</button>
      </form>
    </div>
  );
}
