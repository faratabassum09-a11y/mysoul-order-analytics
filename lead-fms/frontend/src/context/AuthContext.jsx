import React, { createContext, useContext, useEffect, useState } from "react";
import { api, setAuthToken, setUnauthorizedHandler } from "../api.js";

const AuthContext = createContext(null);

// The last known user is kept in localStorage so a returning visitor sees the app immediately
// (from the token + this cached profile) instead of a blank "Loading…" screen while /auth/me
// round-trips — which on a free-tier server that has gone to sleep can take most of a minute.
// The token is still verified in the background; if it's rejected the 401 handler signs them out.
function readCachedUser() {
  try {
    if (!localStorage.getItem("authToken")) return null;
    return JSON.parse(localStorage.getItem("authUser") || "null");
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const cachedUser = readCachedUser();
  const [user, setUser] = useState(cachedUser);
  const [loading, setLoading] = useState(!cachedUser);
  // True once the very first /auth/me is taking noticeably longer than a warm request should —
  // almost always a free-tier backend spinning back up after going idle (30-50s).
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("authToken");
    if (!stored) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let retryTimer;
    const slowTimer = setTimeout(() => setSlow(true), 3500);
    const finish = () => {
      clearTimeout(slowTimer);
      setLoading(false);
    };
    const attempt = () => {
      api
        .me()
        .then((res) => {
          if (cancelled) return;
          setUser(res.user);
          localStorage.setItem("authUser", JSON.stringify(res.user));
          finish();
        })
        .catch((err) => {
          if (cancelled) return;
          // No connection is NOT the same as "not signed in" — keep trying instead of dumping the
          // person on the Login page.
          if (err?.network && !cachedUser) {
            retryTimer = setTimeout(attempt, 4000);
            return;
          }
          finish();
        });
    };
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      clearTimeout(retryTimer);
    };
  }, []);

  // Any API call anywhere that comes back 401 (expired or invalid session) signs the user out.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      localStorage.removeItem("authUser");
      setUser(null);
    });
  }, []);

  const login = async (email, password) => {
    const res = await api.login(email, password);
    setAuthToken(res.token);
    localStorage.setItem("authUser", JSON.stringify(res.user));
    setUser(res.user);
    return res.user;
  };

  const logout = () => {
    setAuthToken(null);
    localStorage.removeItem("authUser");
    setUser(null);
  };

  // Lets the Account page reflect a saved name immediately without re-fetching /me.
  const updateProfile = (patch) =>
    setUser((u) => {
      if (!u) return u;
      const next = { ...u, ...patch };
      localStorage.setItem("authUser", JSON.stringify(next));
      return next;
    });

  const isAdmin = user?.role === "admin";
  return (
    <AuthContext.Provider value={{ user, loading, slow, login, logout, updateProfile, isAdmin, isLeadAdmin: isAdmin, leadName: user?.leadName || user?.name || "" }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
