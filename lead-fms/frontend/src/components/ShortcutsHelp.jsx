import React, { useEffect, useRef, useState } from "react";

const shortcuts = [
  { keys: "/", desc: "Jump into the search box (on pages that have one)" },
  { keys: "Esc", desc: "Close an open dialog or this panel" },
  { keys: "Tap an outcome", desc: "On My Tasks, one tap on Connected / DNP / … logs the call instantly" },
  { keys: "Note…", desc: "Add a note or schedule a callback before saving the outcome" },
  { keys: "Remove, then Confirm?", desc: "Removing someone needs a second click within 3s — hard to hit by accident" },
  { keys: "Show 300 more", desc: "Big lead lists load 200 rows first so the page stays fast" },
];

export default function ShortcutsHelp() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className="shortcuts-wrap" ref={ref}>
      {open && (
        <div className="shortcuts-panel">
          <div className="shortcuts-title">Handy shortcuts</div>
          <ul>
            {shortcuts.map((s) => (
              <li key={s.keys}>
                <kbd>{s.keys}</kbd>
                <span>{s.desc}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        className="shortcuts-btn"
        aria-label="Keyboard shortcuts and tips"
        title="Keyboard shortcuts and tips"
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
    </div>
  );
}
