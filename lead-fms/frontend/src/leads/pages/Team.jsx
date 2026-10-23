import React, { useEffect, useState } from "react";
import PageHeader from "../../components/PageHeader.jsx";
import TableSkeleton from "../../components/TableSkeleton.jsx";
import ToggleSwitch from "../../components/ToggleSwitch.jsx";
import ConfirmDeleteButton from "../../components/ConfirmDeleteButton.jsx";
import SearchInput from "../../components/SearchInput.jsx";
import { api } from "../../api.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { avatarStyleFromString, initials } from "../../utils/colorFromString.js";
import { useLeads } from "../LeadsContext.jsx";

const empty = { name: "", email: "", password: "", leadName: "", role: "caller" };

// Admins create logins and decide who is a caller (sees only their own leads) and who is an admin.
export default function Team() {
  const { user: me } = useAuth();
  const { load: reloadLeads, toast } = useLeads();
  const [people, setPeople] = useState(null), [f, setF] = useState(empty), [busy, setBusy] = useState(null), [q, setQ] = useState("");
  const [nameId, setNameId] = useState(null), [nameVal, setNameVal] = useState(""), [pwId, setPwId] = useState(null), [pw, setPw] = useState("");
  const refresh = () => api.ldTeam().then(setPeople).catch((e) => toast(e.message, "bad"));
  const [miss, setMiss] = useState([]), [mf, setMf] = useState({});
  const loadMissing = () => api.ldMissingLogins().then(setMiss).catch(() => {});
  useEffect(() => { refresh(); loadMissing(); }, []);
  const genPw = () => { const a = new Uint32Array(10); crypto.getRandomValues(a); return Array.from(a, (n) => "abcdefghjkmnpqrstuvwxyz23456789"[n % 31]).join(""); };
  const createFor = async (m) => {
    const x = mf[m.name] || {};
    try {
      await api.ldAddPerson({ name: m.name, email: x.email, password: x.password, leadName: m.name, role: "caller" });
      toast(`Login created for ${m.name} — password: ${x.password}`, "good");
      await refresh(); await loadMissing(); reloadLeads().catch(() => {});
    } catch (err) { toast(err.message, "bad"); }
  };

  const put = async (p, patch, msg) => {
    setBusy(p._id);
    try {
      const u = await api.ldUpdatePerson(p._id, patch);
      setPeople((a) => a.map((x) => (x._id === p._id ? u : x)));
      setNameId(null); setPwId(null); setPw("");
      toast(msg, "good");
      reloadLeads().catch(() => {});
    } catch (e) { toast(e.message, "bad"); }
    setBusy(null);
  };
  const add = async (e) => {
    e.preventDefault();
    try { await api.ldAddPerson(f); toast(`Added ${f.name}`, "good"); setF(empty); await refresh(); reloadLeads().catch(() => {}); }
    catch (err) { toast(err.message, "bad"); }
  };
  const remove = async (p) => {
    try { await api.ldRemovePerson(p._id); setPeople((a) => a.filter((x) => x._id !== p._id)); toast(`Removed ${p.name}`, "bad"); }
    catch (e) { toast(e.message, "bad"); }
  };

  const needle = q.trim().toLowerCase();
  const rows = people?.filter((p) => !needle || [p.name, p.email, p.leadName, p.role].join(" ").toLowerCase().includes(needle));
  return (
    <div className="page">
      <PageHeader title="Team" subtitle="Who can sign in, and what they're allowed to do"
        meta={people && <span className="chip"><strong>{people.length}</strong> accounts</span>} />
      <form className="inline-form" onSubmit={add}>
        <input placeholder="Full name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input placeholder="Email (their login)" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <input placeholder="Password (min 8 chars)" type="password" required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <input placeholder="Caller name (= Assigned To)" value={f.leadName} onChange={(e) => setF({ ...f, leadName: e.target.value })} title="Leave blank to use the full name" />
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option value="caller">Caller</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit">Add User</button>
      </form>
      <p className="form-hint">
        <strong>Admins</strong> see every lead and the Daily Board, Reports, Team and Settings. <strong>Callers</strong> see only the leads
        assigned to their <strong>caller name</strong> — it has to match “Assigned To” in the intake sheet (or whatever an admin picks when
        assigning). Leave it blank to use the person's full name.
      </p>

      {miss.length > 0 && (
        <div className="ld-panel">
          <h3>Callers with leads but no login yet</h3>
          <p className="ld-small" style={{ marginTop: 0 }}>These names are in the sheet's “Assigned To”, so they have leads, but nobody can sign in as them — only admins can see those leads. Give each person their own login and they will see only their own tasks.</p>
          {miss.map((m) => {
            const x = mf[m.name] || {}, set = (patch) => setMf({ ...mf, [m.name]: { ...x, ...patch } });
            return (
              <form key={m.name} className="inline-form" onSubmit={(e) => { e.preventDefault(); createFor(m); }}>
                <span style={{ minWidth: 150 }}><b>{m.name}</b> <span className="ld-small">· {m.leads} leads</span></span>
                <input type="email" required placeholder="Their email (login)" value={x.email || ""} onChange={(e) => set({ email: e.target.value })} />
                <input required minLength={8} placeholder="Password (min 8)" value={x.password || ""} onChange={(e) => set({ password: e.target.value })} />
                <button type="button" className="ld-btn" onClick={() => set({ password: genPw() })}>Generate</button>
                <button type="submit">Create login</button>
              </form>
            );
          })}
        </div>
      )}

      <div className="toolbar"><SearchInput value={q} onChange={setQ} placeholder="Search by name, email, caller name… (press /)" /></div>
      <div className="table-wrap">
        <table className="table ld-sno">
          <thead><tr><th>S.No</th><th>Name</th><th>Email</th><th>Caller name (= Assigned To)</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {!people && <TableSkeleton columns={7} rows={6} />}
            {rows?.length === 0 && <tr><td colSpan={7} className="empty-state">No one matches “{q}”.</td></tr>}
            {rows?.map((p, i) => (
              <tr key={p._id} className={p.active ? "" : "row-inactive"}>
                <td>{i + 1}</td>
                <td><div className="name-cell"><span className="avatar" style={avatarStyleFromString(p.name)}>{initials(p.name)}</span>{p.name}{p._id === me?.id && <span className="badge badge-neutral" style={{ marginLeft: 8 }}>You</span>}</div></td>
                <td>{p.email}</td>
                <td>
                  {nameId === p._id ? (
                    <div className="row-actions">
                      <input className="cell-edit-input" value={nameVal} onChange={(e) => setNameVal(e.target.value)} style={{ width: 150 }} />
                      <button type="button" className="link-btn" onClick={() => put(p, { leadName: nameVal }, "Caller name saved")}>Save</button>
                      <button type="button" className="link-btn" onClick={() => setNameId(null)}>Cancel</button>
                    </div>
                  ) : (
                    <button type="button" className="link-btn" onClick={() => { setNameId(p._id); setNameVal(p.leadName === p.name ? "" : p.leadName); }}>
                      {p.leadName || <span className="muted">— add —</span>}
                    </button>
                  )}
                </td>
                <td>
                  <button type="button" className={"role-toggle " + (p.role === "admin" ? "role-admin" : "role-member")} disabled={busy === p._id}
                    title={p.role === "admin" ? "Click to make this person a Caller" : "Click to make this person an Admin"}
                    onClick={() => put(p, { role: p.role === "admin" ? "caller" : "admin" }, `${p.name} is now ${p.role === "admin" ? "a Caller" : "an Admin"}`)}>
                    {p.role === "admin" ? "Admin" : "Caller"}
                  </button>
                </td>
                <td>
                  <div className="status-cell">
                    <ToggleSwitch checked={p.active} disabled={busy === p._id} label={`Toggle ${p.name} active status`}
                      onChange={() => put(p, { active: !p.active }, `${p.name} marked ${p.active ? "inactive" : "active"}`)} />
                    <span className={"badge " + (p.active ? "badge-good" : "badge-bad")}>{p.active ? "Active" : "Inactive"}</span>
                  </div>
                </td>
                <td>
                  {pwId === p._id ? (
                    <form className="reset-pw-form" onSubmit={(e) => { e.preventDefault(); put(p, { password: pw }, "Password reset"); }}>
                      <input type="password" placeholder="New password" required minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} />
                      <button type="submit" className="link-btn">Save</button>
                      <button type="button" className="link-btn" onClick={() => { setPwId(null); setPw(""); }}>Cancel</button>
                    </form>
                  ) : (
                    <div className="row-actions">
                      <button type="button" className="link-btn" onClick={() => setPwId(p._id)}>Reset Password</button>
                      {p._id !== me?.id && <ConfirmDeleteButton onConfirm={() => remove(p)} />}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
