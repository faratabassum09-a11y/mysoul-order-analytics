import React, { useEffect } from "react";
import { useNetwork } from "../context/NetworkContext.jsx";

// Full-screen "no connection" page. Two flavours:
//   • offline      — the device has no working internet
//   • server-down  — internet is fine, our backend isn't answering
// It re-checks every few seconds by itself (see NetworkContext) and the
// app resumes the moment the connection is back — no refresh needed.

function WifiArt() {
  return (
    <svg viewBox="0 0 160 120" className="off-svg" aria-hidden="true">
      <circle className="off-ripple" cx="80" cy="90" r="18" />
      <circle className="off-ripple off-ripple-2" cx="80" cy="90" r="18" />
      <g className="off-arcs" fill="none" strokeLinecap="round" strokeWidth="7">
        <path className="off-arc off-arc-3" d="M43.2 53.2A52 52 0 0 1 116.8 53.2" />
        <path className="off-arc off-arc-2" d="M54.5 64.5A36 36 0 0 1 105.5 64.5" />
        <path className="off-arc off-arc-1" d="M65.9 75.9A20 20 0 0 1 94.1 75.9" />
      </g>
      <circle className="off-wdot" cx="80" cy="90" r="5" />
      <line className="off-slash-under" x1="53" y1="41" x2="107" y2="99" />
      <line className="off-slash" x1="53" y1="41" x2="107" y2="99" />
    </svg>
  );
}

function ServerArt() {
  return (
    <svg viewBox="0 0 160 120" className="off-svg" aria-hidden="true">
      {[0, 1, 2].map((r) => (
        <g key={r} transform={`translate(34 ${22 + r * 30})`}>
          <rect className="off-rack" width="92" height="24" rx="7" />
          <rect className="off-rack-line" x="12" y="10" width="38" height="4" rx="2" />
          <circle className={r === 1 ? "off-led off-led-bad" : "off-led"} cx="76" cy="12" r="3.6" />
        </g>
      ))}
      <g className="off-zzz" fontWeight="800" fill="currentColor">
        <text x="132" y="26" fontSize="14">z</text>
        <text x="142" y="15" fontSize="11">z</text>
        <text x="150" y="7" fontSize="9">z</text>
      </g>
    </svg>
  );
}

export default function OfflineScreen() {
  const { status, checking, retryIn, lastChecked, recheck } = useNetwork();
  const server = status === "server-down";
  // The in-app banner would say the same thing under this page — hide it
  // (display:none, so screen readers don't announce it twice either).
  useEffect(() => {
    document.documentElement.setAttribute("data-offline-screen", "1");
    return () => document.documentElement.removeAttribute("data-offline-screen");
  }, []);
  const time = lastChecked
    ? new Date(lastChecked).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })
    : null;

  return (
    <div className={"off " + (server ? "off-server" : "off-net")} role="alert" aria-live="assertive">
      <div className="ls-aurora" aria-hidden="true"><i /><i /><i /></div>

      <div className="off-card">
        <div className="off-art">{server ? <ServerArt /> : <WifiArt />}</div>

        <div className="off-chip">
          <span className="off-dot" aria-hidden="true" />
          {checking ? "Checking connection…" : server ? "Server not responding" : "No connection"}
        </div>

        <h1 className="off-title">{server ? "Can't reach the server" : "You're offline"}</h1>
        <p className="off-text">
          {server
            ? "Your internet looks fine, but our server isn't answering. If it's been idle it may be waking up — that usually takes under a minute."
            : "Check your Wi-Fi or mobile data. We'll reconnect on our own the moment your internet is back."}
        </p>

        <div className="off-actions">
          <button type="button" className="off-btn off-btn-primary" onClick={recheck} disabled={checking}>
            {checking ? (<><span className="btn-spinner" aria-hidden="true" />Checking…</>) : "Try again"}
          </button>
          <button type="button" className="off-btn" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>

        <div className="off-retry">
          <span className="off-ring" style={{ "--p": checking ? 1 : retryIn / 5 }} aria-hidden="true" />
          {checking ? "Checking…" : `Retrying automatically in ${retryIn}s`}
        </div>

        <details className="off-tips">
          <summary>Troubleshooting tips</summary>
          <ul>
            {server ? (
              <>
                <li>Give it a minute — a sleeping server needs time to start.</li>
                <li>Try opening another website to confirm your internet works.</li>
                <li>If this lasts more than a few minutes, tell an admin.</li>
              </>
            ) : (
              <>
                <li>Make sure Wi-Fi or mobile data is switched on and airplane mode is off.</li>
                <li>Move closer to your router, or try switching networks.</li>
                <li>If other sites work, a VPN or firewall may be blocking this one.</li>
              </>
            )}
          </ul>
        </details>

        {time && <div className="off-last">Last checked at {time}</div>}
      </div>
    </div>
  );
}
