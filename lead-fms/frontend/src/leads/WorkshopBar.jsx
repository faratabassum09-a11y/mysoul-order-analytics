import React from "react";
import { useLeads } from "./LeadsContext.jsx";
import { NO_WS } from "./leadUtils.js";

// One chip per workshop, built from the sheet's "Workshop Name" column — type a new workshop name in the sheet and its
// chip appears here by itself. `items` = the leads to count (pass the page's own list so the numbers match the cards).
export default function WorkshopBar({ items }) {
  const { workshops, workshop, setWorkshop, leads } = useLeads();
  if (!workshops.length) return null;
  const list = items || leads, cnt = new Map();
  let none = 0;
  for (const l of list) l.workshop ? cnt.set(l.workshop, (cnt.get(l.workshop) || 0) + 1) : none++;
  const chip = (v, label, n) => (
    <button key={v || "all"} type="button" className={"ld-chip" + (workshop === v ? " on" : "")} onClick={() => setWorkshop(v)}>{label} <span className="ld-chip-n">{n}</span></button>
  );
  return (
    <div className="ld-wsbar" role="group" aria-label="Filter by workshop">
      <span className="ld-small">Workshop</span>
      <div className="ld-wsbar-scroll">
        {chip("", "All", list.length)}
        {workshops.map((w) => chip(w.name, w.name, cnt.get(w.name) || 0))}
        {none > 0 && chip(NO_WS, "No workshop", none)}
      </div>
    </div>
  );
}
