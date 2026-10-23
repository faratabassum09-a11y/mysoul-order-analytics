import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useToast } from "../components/Toast.jsx";
import { usePolling } from "../hooks/usePolling.js";
import { UpdateModal } from "./ui.jsx";
import LeadDrawer from "./LeadDrawer.jsx";
import { NO_WS } from "./leadUtils.js";

const Ctx = createContext(null);
export const useLeads = () => useContext(Ctx);

// Holds the leads + settings for the whole Lead FMS app so every page shares one copy:
// updating a follow-up on the Tasks page is instantly visible on Leads, Dashboard, etc.
export function LeadsProvider({ children }) {
  const { isLeadAdmin: admin, leadName } = useAuth();
  const toast = useToast();
  const [leads, setLeads] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [callers, setCallers] = useState([]);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);
  const [drawer, setDrawer] = useState(null); // id of the lead whose history is open
  const [tick, setTick] = useState(0); // bumps after every saved call so the live race refreshes at once
  const [workshop, setWorkshopRaw] = useState(() => sessionStorage.getItem("ld-workshop") || "");
  const who = admin ? "" : leadName;

  const load = useCallback(async () => {
    const [l, c] = await Promise.all([api.ldLeads(), api.ldConfig()]);
    setLeads(l);
    setCfg(c);
    if (admin) api.ldCallers().then(setCallers).catch(() => {});
  }, [admin]);

  useEffect(() => { load().catch((e) => toast(e.message, "bad")); }, [load]);
  usePolling(() => load().catch(() => {}), 90000); // pick up leads imported / updated by others
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []); // overdue flips live

  const replace = (u) => setLeads((p) => p.map((x) => (x._id === u._id ? u : x)));
  const saveFollowUp = async (l, n, body, set) => {
    replace(await api.ldSaveFollowUp(l._id, n, { ...body, set }));
    setTick((t) => t + 1);
    toast(admin ? `Saved: ${body.status}` : "Saved ✓ Nice work!", "good");
  };
  const patchLead = async (l, body) => replace(await api.ldPatchLead(l._id, body));
  const sync = async () => {
    setBusy(true);
    try {
      const r = await api.ldSync();
      await load();
      toast(`Sheet synced: ${r.added} new leads, ${r.updated} updated`, "good");
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  const all = leads || [];
  // callers: the Leads tab / Dashboard show their own lead-qualification leads (Day 1/2 live in Attendance)
  const lqLeads = useMemo(() => (admin ? all : all.filter((l) => (l.assignedTo || "").toLowerCase() === (leadName || "").toLowerCase())), [all, admin, leadName]);
  const names = useMemo(() => [...new Set([...callers, ...all.map((l) => l.assignedTo).filter(Boolean)])].sort(), [callers, all]);

  // Workshops come straight from the "Workshop Name" column: the moment a lead arrives with a new name, it gets a filter.
  // Newest workshop first.
  const workshops = useMemo(() => {
    const m = new Map();
    for (const l of all) {
      if (!l.workshop) continue;
      const x = m.get(l.workshop) || { name: l.workshop, count: 0, latest: 0 };
      x.count++; x.latest = Math.max(x.latest, +new Date(l.ts || 0));
      m.set(l.workshop, x);
    }
    return [...m.values()].sort((a, b) => b.latest - a.latest || a.name.localeCompare(b.name));
  }, [all]);
  // a remembered workshop that no longer exists simply means "all"
  const ws = workshop === NO_WS || workshops.some((w) => w.name === workshop) ? workshop : "";
  const setWorkshop = (v) => { setWorkshopRaw(v); sessionStorage.setItem("ld-workshop", v); };
  const inWs = useCallback((l) => !ws || (ws === NO_WS ? !l.workshop : l.workshop === ws), [ws]);
  const openLead = (l) => setDrawer(l._id);

  const value = { leads: all, loaded: leads !== null, lqLeads, cfg, callers: names, now, admin, who, busy, load, saveFollowUp, patchLead, sync, setModal, toast, tick, workshops, workshop: ws, setWorkshop, inWs, openLead };
  const open = drawer && all.find((x) => x._id === drawer);
  return (
    <Ctx.Provider value={value}>
      {children}
      {open && cfg && <LeadDrawer lead={open} cfg={cfg} admin={admin} callers={names} now={now} workshops={workshops} onClose={() => setDrawer(null)}
        onUpdate={async (body) => { try { await patchLead(open, body); toast("Saved", "good"); } catch (e) { toast(e.message, "bad"); } }}
        onCall={(set, n) => { setDrawer(null); setModal({ l: open, n, set }); }} />}
      {modal && cfg && (
        <>
          <UpdateModal m={modal} cfg={cfg} leads={all} admin={admin} onClose={() => setModal(null)}
            onSave={async (b) => { try { await saveFollowUp(modal.l, modal.n, b, modal.set); setModal(null); } catch (e) { toast(e.message, "bad"); } }} />
        </>
      )}
    </Ctx.Provider>
  );
}
