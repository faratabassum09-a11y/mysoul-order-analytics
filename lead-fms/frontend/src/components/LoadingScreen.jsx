import React, { useEffect, useState } from "react";
import LeadsLogo from "./LeadsLogo.jsx";
import OfflineScreen from "./OfflineScreen.jsx";
import { useNetwork } from "../context/NetworkContext.jsx";

// Full-screen branded loader — used while the session is being verified and
// while an app Lead FMS is opening.
//  • tinted per app so switching apps feels intentional
//  • cycles friendly status lines instead of a bare "Loading…"
//  • `slow` (server cold-start) switches to an honest progress view with an
//    elapsed timer, so "is it broken?" becomes "oh, it's waking up"
//  • if the connection drops while loading, it swaps itself for the
//    OfflineScreen — one component covers every full-screen wait.

const APPS = {
  leads: { Mark: LeadsLogo, name: "Lead FMS", cls: "ls-leads" },
};

const STEPS = ["Getting things ready", "Checking your session", "Loading your workspace", "Almost there"];
const WAKE_STEPS = [
  [0, "Waking up the server"],
  [8, "Starting services"],
  [18, "Connecting to the database"],
  [32, "Nearly there"],
  [55, "Taking longer than usual"],
];

const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function useSeconds(active) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!active) { setSecs(0); return; }
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return secs;
}

export default function LoadingScreen({ app = "leads", message, slow = false }) {
  const { online } = useNetwork();
  const cfg = APPS[app] || APPS.leads;
  const secs = useSeconds(slow);
  const [i, setI] = useState(0);

  useEffect(() => {
    if (message || slow) return;
    const id = setInterval(() => setI((n) => (n + 1) % STEPS.length), 2200);
    return () => clearInterval(id);
  }, [message, slow]);

  if (!online) return <OfflineScreen />;

  const wake = [...WAKE_STEPS].reverse().find(([t]) => secs >= t)?.[1] || WAKE_STEPS[0][1];
  const text = slow ? wake : message || STEPS[i];
  // Eases toward ~94% over about a minute and never claims to be finished.
  const pct = Math.min(94, (1 - Math.exp(-secs / 18)) * 100);
  const { Mark } = cfg;

  return (
    <div className={"ls " + cfg.cls} role="status" aria-live="polite" aria-busy="true">
      <div className="ls-aurora" aria-hidden="true"><i /><i /><i /></div>

      <div className="ls-stage">
        <svg className="ls-ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle className="ls-ring-track" cx="60" cy="60" r="54" />
          <circle className="ls-ring-arc ls-arc-a" cx="60" cy="60" r="54" />
          <circle className="ls-ring-arc ls-arc-b" cx="60" cy="60" r="45" />
        </svg>
        <span className="ls-halo" aria-hidden="true" />
        <Mark size={60} className="ls-logo" />
      </div>

      <div className="ls-brand">MySoulSchool · {cfg.name}</div>
      <div className="ls-status" key={text}>{text}<span className="ls-ellipsis" aria-hidden="true"><b>.</b><b>.</b><b>.</b></span></div>

      <div className={"ls-bar" + (slow ? " ls-bar-det" : "")} aria-hidden="true">
        <span style={slow ? { width: pct + "%" } : undefined} />
      </div>

      {slow && (
        <div className="ls-slow">
          <div className="ls-slow-top">
            <span className="ls-zzz" aria-hidden="true">z<b>z</b><b>z</b></span>
            <span className="ls-slow-title">The server was napping</span>
            <span className="ls-time">{fmt(secs)}</span>
          </div>
          <p>
            The first load after a quiet spell can take up to a minute on a free-tier server.
            After that, everything is quick.
          </p>
          {secs >= 60 && (
            <button type="button" className="ls-btn" onClick={() => window.location.reload()}>
              Still stuck? Reload
            </button>
          )}
        </div>
      )}
    </div>
  );
}
