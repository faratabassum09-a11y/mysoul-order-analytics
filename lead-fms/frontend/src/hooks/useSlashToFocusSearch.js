import { useEffect } from "react";

const editableTags = new Set(["INPUT", "TEXTAREA", "SELECT"]);

// Press "/" anywhere on a page that has a search box to jump straight into
// it, like GitHub/Gmail-style search shortcuts. No-op on pages without one.
export function useSlashToFocusSearch() {
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (editableTags.has(document.activeElement?.tagName)) return;
      const input = document.querySelector(".search-input input");
      if (input) {
        e.preventDefault();
        input.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
