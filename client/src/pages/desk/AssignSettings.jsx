import React, { useEffect, useState } from 'react';
import { api, useApi } from '../../api.js';
import { useToast } from '../../deskUi.jsx';
import { notifyDesk, useLabels } from './shared.jsx';

// Settings, Team assignment: for every column of the three queues choose Off / Manual / Auto, who is on it and each person's share.
const GROUPS = [
  { title: 'Confirm queue', kind: 'confirmation', slots: [['confirm1', 'fu1'], ['confirm2', 'fu2'], ['confirm3', 'fu3']] },
  { title: 'Pending orders', kind: 'confirmation', slots: [['pending1', 'day1'], ['pending2', 'day2'], ['pending3', 'day3']] },
  { title: 'Dispatch queue', kind: 'packing', slots: [['slip', 'stepSlip'], ['packed', 'stepPacked'], ['handover', 'stepHandover']] },
];
const MODES = [['off', 'Off', 'Everyone sees every order.'], ['manual', 'Manual', 'An admin gives each order to a person, or a person takes it.'], ['auto', 'Auto', 'Orders are shared out by themselves, in the ratio below.']];
const ratioText = (members, name) => {
  const on = members.filter((m) => m.on); const total = on.reduce((n, m) => n + Number(m.weight || 0), 0);
  if (!on.length || !total) return '';
  return on.map((m) => `${name(m.id)} ${Math.round((m.weight / total) * 100)}%`).join(' · ');
};

export default function AssignSettings() {
  const { L } = useLabels();
  const { data, reload } = useApi('/desk/assign/config');
  const [cfg, setCfg] = useState(null); const [busy, setBusy] = useState(false); const [toast, show] = useToast();
  useEffect(() => { if (data) setCfg(JSON.parse(JSON.stringify(data.config))); }, [data]);
  if (!cfg) return <div className="sd-set-card" id="assign"><h2>Team assignment</h2><p className="cap">Loading…</p></div>;
  const team = data.team; const nameOf = (id) => (team.find((p) => p.id === id) || {}).name || 'Removed person';
  const setSlot = (k, patch) => setCfg((c) => ({ ...c, slots: { ...c.slots, [k]: { ...c.slots[k], ...patch } } }));
  const eligible = (kind) => team.filter((p) => p.role === 'admin' || p.role === kind);
  const toggle = (k, id) => { const cur = cfg.slots[k].members; setSlot(k, { members: cur.some((m) => m.id === id) ? cur.filter((m) => m.id !== id) : [...cur, { id, weight: 1, on: true }] }); };
  const patchMember = (k, id, patch) => setSlot(k, { members: cfg.slots[k].members.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  const copyTo = (group, from) => setCfg((c) => { const src = c.slots[from]; const slots = { ...c.slots }; group.slots.forEach(([k]) => { slots[k] = { mode: src.mode, members: src.members.map((m) => ({ ...m })) }; }); return { ...c, slots }; });
  const payload = () => ({ visibility: cfg.visibility, keepSamePerson: cfg.keepSamePerson, slots: Object.fromEntries(Object.entries(cfg.slots).map(([k, s]) => [k, { mode: s.mode, members: s.members.map((m) => ({ id: m.id, weight: Number(m.weight), on: m.on })) }])) });
  const save = async () => {
    setBusy(true);
    try { await api.put('/desk/assign/config', payload()); notifyDesk(); reload(); show('Team assignment saved. Open orders were shared out following the new rules.'); }
    catch (e) { show(e.message, 'err'); } finally { setBusy(false); }
  };
  const reshare = async (slot) => {
    setBusy(true);
    try { await api.put('/desk/assign/config', payload()); const r = await api.post('/desk/assign/rebalance', { slot }); notifyDesk(); reload(); show(r.moved ? `${r.moved} order${r.moved === 1 ? '' : 's'} moved to even out the work.` : 'Already even. Nothing moved.'); }
    catch (e) { show(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="sd-set-card" id="assign">
      <h2>Team assignment</h2>
      <p className="cap">Decide who works which orders. Each column can be <b>Off</b> (everyone sees everything), <b>Manual</b> (an admin gives orders to people) or <b>Auto</b> (orders are shared out by themselves). In Auto, give each person a <b>share</b>: with shares 2 and 1 the first person gets twice as many orders. When you add a person, they receive the next orders until they catch up; press “Share out again” to even out the orders already given. Switch a person off for the day (“Present”) and their open orders move to the others.</p>
      <label className="sd-set-row"><span><b>What team members see</b><small>Admins always see everything.</small></span>
        <select value={cfg.visibility} onChange={(e) => setCfg({ ...cfg, visibility: e.target.value })}><option value="all">All orders (their own are marked)</option><option value="own">Only their own orders and the unassigned ones</option></select></label>
      <label className="sd-check"><input type="checkbox" checked={cfg.keepSamePerson} onChange={(e) => setCfg({ ...cfg, keepSamePerson: e.target.checked })} /> When an order moves to the next column, keep it with the same person if they are on that column too</label>
      {GROUPS.map((g) => (
        <div key={g.title} className="asg-group">
          <h3>{g.title}</h3>
          {g.slots.map(([k, labelKey], gi) => {
            const s = cfg.slots[k]; const people = eligible(g.kind); const load = (data.load[k]) || {};
            return (
              <div className="asg-slot" key={k}>
                <div className="asg-head">
                  <b>{L(labelKey)}</b>
                  <span className="muted">{(load.none || 0) + Object.entries(load).filter(([x]) => x !== 'none').reduce((n, [, v]) => n + v, 0)} open{load.none ? ` · ${load.none} unassigned` : ''}</span>
                  <div className="sd-seg asg-modes" role="radiogroup" aria-label={`${L(labelKey)} assignment`}>
                    {MODES.map(([m, label, tip]) => <button key={m} type="button" role="radio" aria-checked={s.mode === m} title={tip} className={s.mode === m ? 'on' : ''} onClick={() => setSlot(k, { mode: m })}>{label}</button>)}
                  </div>
                </div>
                {s.mode !== 'off' && (
                  <>
                    <div className="asg-people">
                      {people.length === 0 && <span className="muted">No team members yet. Add people in Settings, Team logins.</span>}
                      {people.map((p) => {
                        const m = s.members.find((x) => x.id === p.id);
                        return (
                          <div key={p.id} className={`asg-person ${m ? 'in' : ''} ${m && !m.on ? 'away' : ''}`}>
                            <label className="asg-pick"><input type="checkbox" checked={!!m} onChange={() => toggle(k, p.id)} /> <span>{p.name}{p.role === 'admin' ? <em> · admin</em> : null}</span></label>
                            {m && (
                              <>
                                {s.mode === 'auto' && <label className="asg-share">Share <input type="number" min="1" max="100" step="1" value={m.weight} onChange={(e) => patchMember(k, p.id, { weight: e.target.value })} /></label>}
                                <label className="asg-present"><input type="checkbox" checked={m.on} onChange={(e) => patchMember(k, p.id, { on: e.target.checked })} /> Present</label>
                                <span className="asg-n" title="Orders this person holds now">{load[p.id] || 0}</span>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {s.mode === 'auto' && ratioText(s.members, nameOf) && <p className="sd-sum">Ratio: {ratioText(s.members, nameOf)}</p>}
                    <div className="asg-tools">
                      {s.mode === 'auto' && <button type="button" className="btn ghost" disabled={busy} onClick={() => reshare(k)}>Share out again</button>}
                      <button type="button" className="btn ghost" onClick={() => copyTo(g, k)}>Copy this to the other {g.title} columns</button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <div className="sd-savebar inline"><button className="btn big" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save team assignment'}</button></div>
      {toast}
    </div>
  );
}
