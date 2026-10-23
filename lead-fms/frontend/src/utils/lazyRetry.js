import { lazy } from "react";

// Drop-in replacement for React.lazy that survives flaky networks and new
// deploys:
//  1. retries the dynamic import a couple of times with a short back-off
//     (a dropped packet shouldn't white-screen the app);
//  2. if the file is genuinely gone (we deployed a new build and the old
//     hashed chunk 404s), reloads the page to pick up the new build — at
//     most once per minute. The timestamp is shared by every lazy page and is
//     deliberately NOT cleared when some other chunk loads fine; otherwise one
//     permanently missing chunk would reload the app in an endless loop.
const RELOAD_FLAG = "chunk-reload-at";
const RELOAD_COOLDOWN_MS = 60_000;

export function isChunkError(err) {
  const msg = String(err?.message || err || "");
  return (
    err?.name === "ChunkLoadError" ||
    /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk .* failed|Unable to preload CSS/i.test(msg)
  );
}

export function lazyRetry(factory, { retries = 2, delay = 700 } = {}) {
  return lazy(async () => {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        return await factory();
      } catch (err) {
        lastErr = err;
        if (i < retries) await new Promise((r) => setTimeout(r, delay * (i + 1)));
      }
    }
    // Online but the chunk is missing => stale build. Reload once.
    if (navigator.onLine !== false && isChunkError(lastErr)) {
      const last = Number(sessionStorage.getItem(RELOAD_FLAG) || 0);
      if (Date.now() - last > RELOAD_COOLDOWN_MS) {
        sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
        window.location.reload();
        return new Promise(() => {}); // hold the Suspense fallback while reloading
      }
    }
    throw lastErr;
  });
}
