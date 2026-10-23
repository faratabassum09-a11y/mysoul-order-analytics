import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { API_BASE } from "../api.js";

// One place that knows whether the app can actually talk to the world.
//
//   status "online"      everything reachable
//   status "offline"     the device has no working internet
//   status "server-down" internet is fine but OUR backend isn't answering
//                        (usually a free-tier server waking up)
//
// navigator.onLine alone lies (Wi-Fi with no internet reports `true`), so
// whenever an API call fails — or the browser fires offline/online — we run
// a real probe: ping /api/health, and if that fails ping a couple of public
// endpoints to tell "no internet" from "server down". While not online we
// re-probe every few seconds and recover automatically.

const NetworkContext = createContext(null);
const RETRY_SECS = 5;
const HEALTH_URL = `${API_BASE}/health`;
const INTERNET_BEACONS = [
  "https://www.gstatic.com/generate_204",
  "https://www.cloudflare.com/cdn-cgi/trace",
];

async function timedFetch(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal, cache: "no-store" });
  } finally {
    clearTimeout(t);
  }
}

async function probe() {
  try {
    const r = await timedFetch(HEALTH_URL, {}, 8000);
    if (r.ok) return "online";
  } catch { /* fall through */ }
  const beacons = await Promise.all(
    INTERNET_BEACONS.map((u) =>
      timedFetch(u, { mode: "no-cors" }, 5000).then(() => true, () => false)
    )
  );
  return beacons.some(Boolean) ? "server-down" : "offline";
}

export function NetworkProvider({ children }) {
  const [status, setStatus] = useState(() => (navigator.onLine === false ? "offline" : "online"));
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState(null);
  const [retryIn, setRetryIn] = useState(0);
  const [justReconnected, setJustReconnected] = useState(false);

  const statusRef = useRef(status);
  const inflight = useRef(null);
  const lastRun = useRef(0);
  const left = useRef(RETRY_SECS);
  const reconnectTimer = useRef();

  const apply = useCallback((next) => {
    const prev = statusRef.current;
    statusRef.current = next;
    setStatus(next);
    if (prev !== "online" && next === "online") {
      setJustReconnected(true);
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(() => setJustReconnected(false), 3200);
    }
  }, []);

  const check = useCallback(() => {
    if (inflight.current) return inflight.current;
    setChecking(true);
    left.current = RETRY_SECS;
    inflight.current = probe()
      .then((next) => {
        lastRun.current = Date.now();
        setLastChecked(Date.now());
        apply(next);
        return next;
      })
      .finally(() => {
        inflight.current = null;
        setChecking(false);
      });
    return inflight.current;
  }, [apply]);

  useEffect(() => {
    const onOffline = () => apply("offline");
    const onOnline = () => check();
    const onApiFail = () => {
      // Already known-bad => the retry loop is handling it. Otherwise
      // verify, but not more than once every 3 seconds.
      if (statusRef.current === "online" && Date.now() - lastRun.current > 3000) check();
    };
    const onVisible = () => {
      if (!document.hidden && statusRef.current !== "online") check();
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    window.addEventListener("app:network-error", onApiFail);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("app:network-error", onApiFail);
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(reconnectTimer.current);
    };
  }, [apply, check]);

  // Auto-retry countdown while we're not online.
  useEffect(() => {
    if (status === "online") {
      setRetryIn(0);
      return;
    }
    left.current = RETRY_SECS;
    setRetryIn(RETRY_SECS);
    const id = setInterval(() => {
      if (inflight.current) return;
      left.current -= 1;
      if (left.current <= 0) {
        left.current = RETRY_SECS;
        check();
      }
      setRetryIn(left.current);
    }, 1000);
    return () => clearInterval(id);
  }, [status, check]);

  return (
    <NetworkContext.Provider
      value={{ status, online: status === "online", checking, retryIn, lastChecked, justReconnected, recheck: check }}
    >
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork() {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error("useNetwork must be used within a NetworkProvider");
  return ctx;
}
