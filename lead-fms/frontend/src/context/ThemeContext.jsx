import React, { createContext, useContext, useEffect, useState } from "react";

const ThemeContext = createContext(null);

function getInitialTheme() {
  const stored = typeof window !== "undefined" && localStorage.getItem("theme");
  if (stored === "light" || stored === "dark") return stored;
  // No saved preference yet — always start in dark mode by default,
  // regardless of the OS/browser setting. The person can still switch to
  // light and it'll be remembered (above) from then on.
  return "dark";
}

// Applies data-theme="dark|light" on <html>, which every color in
// index.css is defined relative to (see the :root[data-theme="dark"]
// block) — so this one attribute re-themes the whole app.
export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
