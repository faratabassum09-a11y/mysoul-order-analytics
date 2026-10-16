import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getStaffToken, setStaffToken } from './api.js';

// Who is signed in on this device. Each person has their own login; every action in the desks is stamped with it.
const Ctx = createContext(null);

export function StaffProvider({ children }) {
  const [state, setState] = useState({ user: null, loading: !!getStaffToken() });

  useEffect(() => {
    if (!getStaffToken()) return undefined;
    let live = true;
    api.get('/staff/me').then(
      (r) => live && setState({ user: r.user || null, loading: false }),
      () => { if (live) { setStaffToken(''); setState({ user: null, loading: false }); } }
    );
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const out = () => { setStaffToken(''); setState({ user: null, loading: false }); };
    window.addEventListener('staff-expired', out);
    return () => window.removeEventListener('staff-expired', out);
  }, []);

  const login = useCallback(async (username, password) => {
    const r = await api.post('/staff/login', { username, password }, { quiet401: true });
    setStaffToken(r.token);
    setState({ user: r.user, loading: false });
    return r.user;
  }, []);
  const logout = useCallback(() => { setStaffToken(''); setState({ user: null, loading: false }); }, []);
  const changePassword = useCallback(async (current, next) => {
    const r = await api.post('/staff/password', { current, next });
    setStaffToken(r.token);
    setState({ user: r.user, loading: false });
  }, []);

  const value = useMemo(() => ({ ...state, login, logout, changePassword }), [state, login, logout, changePassword]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useStaff = () => useContext(Ctx);

// What this device may do. The server enforces the same rules; this only decides which buttons to show.
export const can = (user, what) => !!user && (user.role === 'admin' || user.role === what);
