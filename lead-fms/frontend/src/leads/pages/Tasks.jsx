import React, { useMemo, useState } from "react";
import PageHeader from "../../components/PageHeader.jsx";
import PageLoader from "../../components/PageLoader.jsx";
import SearchInput from "../../components/SearchInput.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { useLeads } from "../LeadsContext.jsx";
import { Stats, Pill } from "../ui.jsx";
import WorkshopBar from "../WorkshopBar.jsx";
import TeamRace from "../TeamRace.jsx";
import {
  ATT_COLS, DELAY_BUCKETS, SETS, TODAY_BUCKETS, bucketOf, daysAgo, delay, endOfToday, fmt, fuCols, isDueToday, ownerOf, shortDate, stageWho, state, stepName, tasksOf, wa, waText,
} from "../leadUtils.js";

// ---- tiny inline icons (no emoji, so they look the same on every phone) ----
const Ico = ({ d, size = 17 }) => (
  <svg className="ld-ico" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const PhoneIco = () => <Ico d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />;
const ChatIco = () => <Ico d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />;
const UserIco = () => <Ico size={13} d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />;
const TickIco = () => <Ico d="M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3" />;

const stepLabel = (set, i) => (set === "d1Fus" ? "Day 1 · " : set === "d2Fus" ? "Day 2 · " : "") + (set === "fus" ? stepName(i) : stepName(i).toLowerCase());
const BATCH = 10; // callers see a small, friendly batch at a time instead of a mountain
const ADMIN_BATCH = 50;
const clock = (d) => new Date(d).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();
const hello = (h) => (h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening");
const real = (v) => v && !/^(n\/?a|na)$/i.test(v);
const byPlanned = (a, b) => new Date(a.f.planned) - new Date(b.f.planned);

// ---------------------------------------------------------------------------
// One follow-up card. Callers get a calm card (no phone number, no alarm); admins get the full detail.
// Defined at module level on purpose: a component declared inside the page would be rebuilt (and flicker) on every
// 30-second clock tick and every refresh.
// ---------------------------------------------------------------------------
function TaskCard({ x, cb, calm, delayed, now, cfg, openLead, setModal }) {
  const { l, f, i, set } = x, s = state(f, now), step = stepLabel(set, i);
  const detail = [l.city, l.profession, l.level].filter(real).join(" · ");
  const prev = i > 0 ? l[set][i - 1] : null; // how the previous call went — the first thing a caller wants to know
  const last = prev && (prev.status || prev.note) ? `Last call: ${prev.status || "called"}${prev.note ? " · " + prev.note : ""}` : "";
  const open = () => setModal({ l, n: i + 1, set });
  const call = <a className="ld-btn ld-btn-solid" href={"tel:" + l.phone}><PhoneIco /> Call</a>;
  const chat = <a className="ld-btn ld-btn-wa" href={wa(l.phone, waText(l, cfg))} target="_blank" rel="noreferrer"><ChatIco /> WhatsApp</a>;
  const upd = <button type="button" className="ld-btn" onClick={open}><TickIco /> Update status</button>;
  const nameBtn = <button type="button" className="ld-namebtn" onClick={() => openLead(l)} title="See this lead's history"><b>{l.name}</b></button>;

  if (calm) {
    const tag = cb ? "Callback · " + clock(f.callbackAt) : delayed ? "From " + shortDate(f.planned) : s === "over" ? "Ready to call" : "Today · " + clock(f.planned);
    return (
      <div className="ld-task ld-task-calm">
        <div className="ld-task-head">
          <div className="ld-who">
            <span className="ld-avatar" aria-hidden="true">{(l.name || "?").trim()[0]?.toUpperCase()}</span>
            <div>{nameBtn}<div className="ld-small">{cb ? "They asked for a call back" : step}{detail ? " · " + detail : ""}</div></div>
          </div>
          <span className="ld-soft">{tag}</span>
        </div>
        {l.workshop && <div className="ld-tags"><span className="ld-ws" title="Workshop">{l.workshop}</span></div>}
        {cb && f.note && <div className="ld-note">“{f.note}”</div>}
        {!cb && last && <div className="ld-last ld-clip" title={last}>{last}</div>}
        <div className="ld-actions ld-actions-3">{call}{chat}{upd}</div>
      </div>
    );
  }
  const tone = cb ? "wait" : s, owner = ownerOf(l, set);
  return (
    <div className={"ld-task ld-task-sm ld-task-" + tone}>
      <div className="ld-nameline">{nameBtn}<a className="ld-phone" href={"tel:" + l.phone}>{l.phone}</a></div>
      <div className="ld-tags">
        <Pill s={tone}>{cb ? "Callback " + fmt(f.callbackAt) : `${step} · ${s === "over" ? "overdue " + delay(f, now) : "due " + fmt(f.planned)}`}</Pill>
        {l.workshop && <span className="ld-ws" title="Workshop">{l.workshop}</span>}
        <span className={"ld-who-tag" + (owner === "Unassigned" ? " none" : "")} title="Assigned to"><UserIco />{owner}</span>
      </div>
      {(detail || (cb && f.note)) && <div className="ld-small ld-clip">{detail}{cb && f.note ? (detail ? " · " : "") + "📝 " + f.note : ""}</div>}
      {!cb && last && <div className="ld-last ld-clip" title={last}>{last}</div>}
      <div className="ld-actions ld-actions-3 ld-actions-sm">{call}{chat}{upd}</div>
    </div>
  );
}

// one column of cards (with its own "show more")
function TaskColumn({ id, label, sub, items, tone, lim, onMore, step, calm, emptyMsg, card }) {
  const n = lim || step, shown = items.slice(0, n);
  return (
    <section className={"ld-col" + (tone ? " ld-col-" + tone : "")} aria-label={label}>
      <header className="ld-col-head"><b>{label}</b><span className="ld-col-sub">{sub}</span><span className="ld-col-count">{items.length}</span></header>
      <div className="ld-col-body">
        {shown.map((x) => <TaskCard key={x.l._id + x.set + x.i} x={x} {...card} />)}
        {!items.length && <div className="ld-empty ld-empty-sm">{emptyMsg}</div>}
      </div>
      {items.length > n && <div className="ld-more"><button type="button" className="ld-btn" onClick={() => onMore(id, n + step)}>{calm ? "Show a few more" : `Show ${Math.min(step, items.length - n)} more`} ({items.length - n} left)</button></div>}
    </section>
  );
}

// The working lists. view = "today" (everything planned for today), "followups" (Delayed: planned on an earlier day and
// still pending) or "attendees" (Day 1 / Day 2 calls). Each is laid out as one column per follow-up step.
export default function Tasks({ view = "today" }) {
  const { leads, loaded, cfg, now, who, admin, setModal, inWs, openLead, callers } = useLeads();
  const { user } = useAuth();
  const [lims, setLims] = useState({}); // how many cards each column shows
  const [q, setQ] = useState(""), [caller, setCaller] = useState("all"), [bucket, setBucket] = useState("all"), [sort, setSort] = useState("old");
  const delayed = view === "followups", attendees = view === "attendees", today = view === "today";
  const calm = !admin, eod = endOfToday().getTime(), sod = new Date().setHours(0, 0, 0, 0);

  // everything actionable up to the end of today for this person, oldest first — recomputed only when the data changes
  const due = useMemo(() => tasksOf(leads, who, cfg).filter((t) => new Date(t.f.planned) <= eod).sort(byPlanned), [leads, who, cfg, eod]);
  // "Today": planned for today. "Delayed": planned on an earlier day. Attendee calls have their own page.
  const poolAll = useMemo(
    () => (attendees ? due.filter((t) => t.set !== "fus") : due.filter((t) => t.set === "fus" && (delayed ? !isDueToday(t) : isDueToday(t)))),
    [due, attendees, delayed]
  );
  const cbs = useMemo(() => (!today ? [] : leads
    .flatMap((l) => l.fus.map((f, i) => ({ l, f, i, set: "fus" })))
    .filter((x) => x.f.status === "Callback" && x.f.callbackAt && new Date(x.f.callbackAt) <= eod && (!who || stageWho(x.l, "fus") === who.toLowerCase()))
    .sort((a, b) => new Date(a.f.callbackAt) - new Date(b.f.callbackAt))), [leads, who, eod, today]);
  const doneToday = useMemo(
    () => leads.flatMap((l) => SETS.flatMap(([set]) => (l[set] || []).filter((f) => f.actual && new Date(f.actual) >= sod && (!who || stageWho(l, set) === who.toLowerCase())))).length,
    [leads, who, sod]
  );

  // ---- filters: workshop (global) · search · caller (admins) · how long it has waited ----
  const needle = q.trim().toLowerCase();
  const fits = (t) => inWs(t.l)
    && (!needle || [t.l.name, admin ? t.l.phone : "", t.l.city, t.l.profession, t.l.workshop].join(" ").toLowerCase().includes(needle))
    && (caller === "all" || (caller === "none" ? ownerOf(t.l, t.set) === "Unassigned" : ownerOf(t.l, t.set).toLowerCase() === caller.toLowerCase()));
  const base = poolAll.filter(fits);
  const buckets = delayed ? DELAY_BUCKETS : today ? TODAY_BUCKETS : null;
  const bCount = (k) => base.filter((t) => bucketOf(t, now, delayed) === k).length;
  let pool = buckets && bucket !== "all" ? base.filter((t) => bucketOf(t, now, delayed) === bucket) : base;
  if (delayed && sort === "new") pool = [...pool].reverse();
  const cbShown = cbs.filter(fits);
  const filtered = !!needle || caller !== "all" || bucket !== "all";
  const clear = () => { setQ(""); setCaller("all"); setBucket("all"); };

  if (!loaded || !cfg) return <PageLoader />;

  const first = (user?.name || "").split(" ")[0];
  const title = attendees ? "Attendee Follow-ups" : delayed ? "Delayed Follow-ups" : calm && first ? `${hello(now.getHours())}, ${first} 🌿` : "Today Follow-ups";
  const subtitle = attendees
    ? "Calls to people who attended Day 1 or Day 2 — oldest first"
    : delayed
    ? calm ? "Conversations from earlier days that are still waiting — start with the oldest" : "Follow-ups from earlier days that are still pending, oldest first, one column per follow-up"
    : calm ? "A few lovely conversations are waiting for you. Take them one at a time, you've got this." : "Everything planned for today in time order, one column per follow-up";
  const step = calm ? BATCH : ADMIN_BATCH;
  const dueNow = base.filter((t) => new Date(t.f.planned) <= now).length;
  const oldest = delayed && base.length ? daysAgo(base[0].f.planned, now) : 0;

  const stats = delayed || attendees
    ? [[attendees ? "Attendee follow-ups" : "Delayed follow-ups", base.length, base.length ? "accent" : ""], ...(delayed && !calm ? [["Oldest waiting", oldest ? oldest + (oldest === 1 ? " day" : " days") : "—", oldest > 7 ? "bad" : ""]] : []), [calm ? "Conversations done today" : "Done today", doneToday, doneToday ? "good" : ""]]
    : calm
    ? [["Follow-ups today", base.length, base.length ? "accent" : ""], ["Ready to call now", dueNow, dueNow ? "accent" : ""], ["Conversations done today", doneToday, doneToday ? "good" : ""], ...(cbs.length ? [["Callbacks planned", cbs.length, "accent"]] : [])]
    : [["Follow-ups today", base.length, base.length ? "accent" : ""], ["Due now", dueNow, dueNow ? "bad" : ""], ["Callbacks scheduled", cbs.length], ["Done today", doneToday, doneToday ? "good" : ""]];

  const emptyMsg = filtered ? "Nothing matches these filters" : attendees || delayed ? "None pending 🎉" : "Nothing planned";
  const doneMsg = filtered ? "No follow-ups match these filters." : attendees ? "🎉 No attendee follow-ups pending." : delayed ? (calm ? "🎉 You're all caught up. Lovely work!" : "🎉 No delayed follow-ups.") : "No follow-ups planned for today yet.";
  const card = { calm, delayed, now, cfg, openLead, setModal };
  const more = (id, n) => setLims((p) => ({ ...p, [id]: n }));
  const colTasks = ([set, i]) => pool.filter((t) => t.set === set && t.i === i);

  return (
    <div className="page">
      <PageHeader title={title} subtitle={subtitle} />
      {today && <TeamRace />}
      <Stats items={stats} />
      <WorkshopBar items={[...new Map(poolAll.map((t) => [t.l._id, t.l])).values()]} />

      {!!poolAll.length && (
        <>
          <div className="toolbar ld-tbar">
            <SearchInput value={q} onChange={setQ} placeholder={admin ? "Search name, phone, city, workshop… (press /)" : "Search name, city or workshop… (press /)"} />
            <div className="filter-row">
              {admin && (
                <select value={caller} onChange={(e) => setCaller(e.target.value)} aria-label="Caller">
                  <option value="all">All callers</option><option value="none">Unassigned</option>{callers.map((c) => <option key={c}>{c}</option>)}
                </select>
              )}
              {delayed && (
                <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
                  <option value="old">Waiting longest first</option><option value="new">Most recent first</option>
                </select>
              )}
              {filtered && <button type="button" className="ld-btn" onClick={clear}>Clear filters</button>}
            </div>
          </div>
          {buckets && (
            <div className="ld-wsbar" role="group" aria-label={delayed ? "How long it has waited" : "Timing"}>
              <span className="ld-small">{delayed ? "Waiting" : "Timing"}</span>
              <div className="ld-wsbar-scroll">
                <button type="button" className={"ld-chip" + (bucket === "all" ? " on" : "")} onClick={() => setBucket("all")}>All <span className="ld-chip-n">{base.length}</span></button>
                {buckets.map(([k, label]) => <button key={k} type="button" className={"ld-chip" + (bucket === k ? " on" : "")} onClick={() => setBucket(k)}>{calm && k === "now" ? "Ready now" : label} <span className="ld-chip-n">{bCount(k)}</span></button>)}
              </div>
            </div>
          )}
        </>
      )}

      {today && cbShown.length > 0 && (
        <>
          <h2>{calm ? "They're expecting your call" : "📞 Callbacks"}</h2>
          <div className="ld-tasks">{cbShown.map((x) => <TaskCard key={x.l._id + x.i} x={x} cb {...card} />)}</div>
        </>
      )}
      {calm && delayed && pool.length > 0 && <p className="ld-small">Finish these and your next ones appear here automatically.</p>}
      {!pool.length && <div className="ld-empty" style={{ marginTop: 14 }}>{doneMsg} {filtered && <button type="button" className="link-btn" onClick={clear}>Clear filters</button>}</div>}
      {!!pool.length && !attendees && (
        <div className="ld-cols">
          {/* one column per follow-up declared in Settings — add FU4 there and it appears here */}
          {fuCols(cfg, leads).map(([set, i, label, sub]) => (
            <TaskColumn key={label} id={label} label={label} sub={sub} items={colTasks([set, i])} tone={"fu" + ((i % 3) + 1)} lim={lims[label]} onMore={more} step={step} calm={calm} emptyMsg={emptyMsg} card={card} />
          ))}
        </div>
      )}
      {!!pool.length && attendees && (
        <div className="ld-cols ld-cols-2">
          {ATT_COLS.map(([set, label]) => <TaskColumn key={set} id={set} label={label} sub="" items={pool.filter((t) => t.set === set)} lim={lims[set]} onMore={more} step={step} calm={calm} emptyMsg={emptyMsg} card={card} />)}
        </div>
      )}
    </div>
  );
}
