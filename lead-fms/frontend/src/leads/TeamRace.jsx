import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { usePolling } from "../hooks/usePolling.js";
import { avatarStyleFromString, initials } from "../utils/colorFromString.js";
import { useLeads } from "./LeadsContext.jsx";
import { ago } from "./leadUtils.js";

const MEDAL = ["🥇", "🥈", "🥉"];
const tone = (p) => (p >= 100 ? "full" : p >= 67 ? "high" : p >= 34 ? "mid" : "low");

// Live "who is ahead today" board shown to everyone on Today Follow-ups: each person's name and a bar that fills as they
// finish calls. Updates every 15 s, and instantly after you save one of your own calls. No phone numbers or lead details.
export default function TeamRace() {
  const { tick, now } = useLeads();
  const { leadName } = useAuth();
  const [d, setD] = useState(null);
  const load = useCallback(() => api.ldProgress().then(setD).catch(() => {}), []);
  useEffect(() => { load(); }, [load, tick]);
  usePolling(load, 15000);
  if (!d) return null;
  const me = (leadName || "").toLowerCase(), mine = d.rows.findIndex((r) => r.name.toLowerCase() === me), you = mine >= 0 ? d.rows[mine] : null;
  const ahead = mine > 0 ? d.rows[mine - 1] : null;
  let line = "";
  if (you) {
    if (you.pct >= 100) line = "You've cleared today's list — brilliant work!";
    else if (mine === 0 && you.done > 0) line = d.rows.length > 1 ? "You're in the lead — keep it going!" : "Great pace — keep going!";
    else if (ahead && ahead.done > you.done) line = `You're #${mine + 1} — ${ahead.done - you.done} call${ahead.done - you.done === 1 ? "" : "s"} behind ${ahead.name}`;
    else line = `You're #${mine + 1} — ${you.left} to go`;
  }
  return (
    <section className="ld-panel ld-race" aria-label="Today's team progress">
      <div className="ld-panel-head">
        <h3>Today's team race <span className="ld-live"><i />LIVE</span></h3>
        <span className="ld-small">{d.team.done} of {d.team.total} calls · {d.team.pct}% as a team</span>
      </div>
      <div className="ld-track ld-race-team"><i className={"ld-race-fill ld-race-" + tone(d.team.pct)} style={{ width: d.team.pct + "%" }} /></div>
      {line && <p className="ld-race-me">{line}</p>}
      {!d.rows.length && <div className="ld-empty ld-empty-sm">No follow-ups planned for today yet.</div>}
      <div className="ld-race-rows">
        {d.rows.map((r, i) => {
          const isMe = r.name.toLowerCase() === me;
          return (
            <div key={r.name} className={"ld-race-row" + (isMe ? " me" : "")}>
              <span className="ld-race-rank">{r.done > 0 && i < 3 ? MEDAL[i] : i + 1}</span>
              <span className="avatar ld-race-av" style={avatarStyleFromString(r.name)}>{initials(r.name)}</span>
              <div className="ld-race-main">
                <div className="ld-race-top">
                  <b>{r.name}{isMe && <span className="ld-you">You</span>}</b>
                  <span className="ld-small">{r.pct >= 100 ? "All done ✓" : `${r.done} / ${r.total} calls`} · <b>{r.pct}%</b></span>
                </div>
                <div className="ld-track ld-race-track"><i className={"ld-race-fill ld-race-" + tone(r.pct)} style={{ width: Math.max(r.pct, r.done ? 3 : 0) + "%" }} /></div>
                <div className="ld-small">{r.connected} connected{r.last ? ` · last call ${ago(r.last, now)}` : " · yet to start"}</div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
