import { useEffect, useRef } from "react";

// Calls `fn` every `ms` while the tab is visible, and once more whenever the
// tab regains focus. This is what keeps every signed-in user's screen in sync
// with changes someone else made (e.g. an admin approving a task) without a
// manual refresh.
export function usePolling(fn, ms = 15000) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const tick = () => { if (!document.hidden) ref.current(); };
    const id = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [ms]);
}
