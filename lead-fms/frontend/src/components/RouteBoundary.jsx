import React, { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useNetwork } from "../context/NetworkContext.jsx";
import { isChunkError } from "../utils/lazyRetry.js";

// Catches what would otherwise be a blank white screen:
//  • a page chunk that couldn't be downloaded (offline / flaky / new deploy)
//  • any unexpected render error
// Shows a calm recovery card instead; chunk failures reload by themselves
// once the connection returns. Resets when you navigate elsewhere.

function Panel({ error, fullscreen, onReset }) {
  const { online } = useNetwork();
  const chunk = isChunkError(error);
  const wasOffline = useRef(false);

  useEffect(() => {
    if (!online) wasOffline.current = true;
    else if (wasOffline.current && chunk) window.location.reload();
  }, [online, chunk]);

  const offline = !online;
  const title = offline ? "You're offline" : chunk ? "Couldn't load this page" : "Something went wrong";
  const text = offline
    ? "This page needs a connection to load. It'll open automatically when you're back online."
    : chunk
    ? "The page didn't download properly — usually a hiccup in the connection or a fresh update. Reloading normally fixes it."
    : "An unexpected error stopped this page from showing. Your data is safe — try again, and reload if it keeps happening.";

  return (
    <div className={"eb" + (fullscreen ? " eb-full" : "")} role="alert">
      <div className="eb-card">
        <div className={"eb-icon" + (offline ? " eb-icon-off" : "")} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            {offline ? (
              <><path d="M2 8.8a15 15 0 0 1 20 0M5.5 12.4a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0" /><path d="M12 19.5h.01M3 3l18 18" /></>
            ) : (
              <><path d="M12 3.5 2.5 20h19L12 3.5Z" /><path d="M12 10v4.5M12 17.5h.01" /></>
            )}
          </svg>
        </div>
        <h2>{title}</h2>
        <p>{text}</p>
        <div className="eb-actions">
          {!chunk && !offline && <button type="button" className="eb-btn eb-btn-primary" onClick={onReset}>Try again</button>}
          <button type="button" className={"eb-btn" + (chunk || offline ? " eb-btn-primary" : "")} onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    </div>
  );
}

class Boundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error("[RouteBoundary]", error); }
  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <Panel error={this.state.error} fullscreen={this.props.fullscreen} onReset={() => this.setState({ error: null })} />;
  }
}

// For optional widgets (e.g. the chatbot bubble): if they fail to load,
// quietly render nothing instead of replacing the whole app with an error.
export class SilentBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.warn("[SilentBoundary]", error); }
  render() { return this.state.failed ? null : this.props.children; }
}

export default function RouteBoundary({ children, fullscreen = false }) {
  const { pathname } = useLocation();
  return <Boundary resetKey={pathname} fullscreen={fullscreen}>{children}</Boundary>;
}
