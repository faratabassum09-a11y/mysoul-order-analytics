import React from "react";

// In-app loading state for a page that's still downloading (Suspense
// fallback). It mirrors the real layout — title, stat tiles, table — so the
// page doesn't jump when content arrives, and a thin progress bar runs along
// the top of the screen. It fades in after a beat, so pages that load
// instantly never flash a skeleton at all.
const COLS = [34, 18, 22, 14, 12];

export default function PageLoader({ rows = 7 }) {
  return (
    <div className="page pl" role="status" aria-busy="true" aria-label="Loading page">
      <span className="pl-topbar" aria-hidden="true" />
      <div className="pl-head">
        <i className="sk pl-title" />
        <i className="sk pl-sub" />
      </div>
      <div className="pl-stats">
        {[0, 1, 2, 3].map((n) => (
          <div className="pl-stat" key={n}>
            <i className="sk" style={{ width: "46%", height: 10 }} />
            <i className="sk pl-big" />
          </div>
        ))}
      </div>
      <div className="pl-panel">
        <div className="pl-toolbar">
          <i className="sk" style={{ width: 220, height: 32, borderRadius: 9 }} />
          <i className="sk" style={{ width: 92, height: 32, borderRadius: 9 }} />
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div className="pl-row" key={r} style={{ animationDelay: `${r * 60}ms` }}>
            {COLS.map((w, c) => (
              <span className="pl-cell" key={c} style={{ flex: w }}>
                <i className="sk" style={{ width: `${45 + ((r * 11 + c * 17) % 50)}%` }} />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
