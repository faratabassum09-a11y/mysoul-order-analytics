import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export const WINDOWS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['last_week', 'Last week'],
  ['this_month', 'This month'], ['last_month', 'Last month'], ['last_3_months', 'Last 3 months'],
  ['last_quarter', 'Last quarter'], ['last_6_months', 'Last 6 months'], ['last_12_months', 'Last 12 months'], ['this_year', 'This year'], ['all_time', 'All time'], ['custom', 'Custom range'],
];

const Ctx = createContext(null);
const load = () => { try { return JSON.parse(localStorage.getItem('filters')) || {}; } catch { return {}; } };

export function FilterProvider({ children }) {
  const saved = load();
  const [window_, setWindow] = useState(saved.window || 'this_month');
  const [from, setFrom] = useState(saved.from || '');
  const [to, setTo] = useState(saved.to || '');
  const [gran, setGran] = useState(saved.gran || 'daily');
  useEffect(() => { localStorage.setItem('filters', JSON.stringify({ window: window_, from, to, gran })); }, [window_, from, to, gran]);
  const value = useMemo(() => ({
    window: window_, from, to, gran, setWindow, setFrom, setTo, setGran,
    ready: window_ !== 'custom' || (from && to && from <= to),
    params: window_ === 'custom' ? { window: window_, from, to } : { window: window_ },
  }), [window_, from, to, gran]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useFilters = () => useContext(Ctx);
