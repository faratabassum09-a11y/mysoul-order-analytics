import React, { useEffect, useState } from "react";
import { useNetwork } from "../context/NetworkContext.jsx";

// Non-blocking connection status for when you're already inside the app:
// slides down when the connection drops (the page stays usable with what
// was already loaded), counts down to the next retry, then flashes a green
// "Back online" and goes away by itself.

const Icon = ({ tone }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {tone === "ok" ? (
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    ) : tone === "server" ? (
      <>
        <rect x="3" y="4" width="18" height="6.5" rx="2" />
        <rect x="3" y="13.5" width="18" height="6.5" rx="2" />
        <path d="M7 7.25h.01M7 16.75h.01" />
      </>
    ) : (
      <>
        <path d="M2 8.8a15 15 0 0 1 20 0M5.5 12.4a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0" />
        <path d="M12 19.5h.01M3 3l18 18" />
      </>
    )}
  </svg>
);

export default function NetworkBanner() {
  const { status, checking, retryIn, justReconnected, recheck } = useNetwork();
  const show = status !== "online" || justReconnected;
  const [render, setRender] = useState(show);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (show) { setRender(true); setLeaving(false); return; }
    if (!render) return;
    setLeaving(true);
    const t = setTimeout(() => { setRender(false); setLeaving(false); }, 260);
    return () => clearTimeout(t);
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!render) return null;
  const tone = status === "offline" ? "offline" : status === "server-down" ? "server" : "ok";

  return (
    <div className={`net-banner net-${tone}` + (leaving ? " net-leave" : "")} role="status" aria-live="polite">
      <span className="net-icon"><Icon tone={tone} /></span>
      <span className="net-msg">
        {tone === "ok" && <strong>Back online</strong>}
        {tone === "offline" && (<><strong>You're offline</strong><span className="net-sub"> · showing what's already loaded</span></>)}
        {tone === "server" && (<><strong>Server not responding</strong><span className="net-sub"> · it may be waking up</span></>)}
      </span>
      {tone !== "ok" && (
        <button type="button" className="net-retry" onClick={recheck} disabled={checking}>
          {checking ? <span className="net-spin" aria-label="Checking" /> : `Retry · ${retryIn}s`}
        </button>
      )}
    </div>
  );
}
