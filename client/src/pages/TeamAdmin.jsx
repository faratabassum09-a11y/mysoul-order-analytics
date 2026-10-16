import React, { useEffect, useState } from 'react';
import { api, useApi } from '../api.js';
import { Loading } from '../components.jsx';
import { fmtWhen, ROLE_LABEL } from '../flowUi.js';

function UserRow({ u, onChanged, setMsg }) {
  const [reset, setReset] = useState(false);
  const [pw, setPw] = useState('');
  const act = async (fn, ok) => { setMsg(null); try { await fn(); setMsg({ ok: true, text: ok }); onChanged(); } catch (e) { setMsg({ ok: false, text: e.message }); } };
  return (
    <tr>
      <td><b>{u.name}</b><div className="muted">{u.username}</div></td>
      <td>
        <select value={u.role} aria-label={`Role of ${u.name}`} onChange={(e) => act(() => api.patch(`/staff/users/${u.id}`, { role: e.target.value }), `${u.name} is now ${ROLE_LABEL[e.target.value]}.`)}>
          {Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </td>
      <td>{u.active ? <span className="tag Delivered">Active</span> : <span className="tag RTO">Switched off</span>}{u.mustChangePassword && <div className="muted">must set own password</div>}</td>
      <td className="muted">{u.lastLoginAt ? fmtWhen(u.lastLoginAt) : 'Never'}</td>
      <td>
        {reset ? (
          <span className="filters" style={{ margin: 0 }}>
            <input type="text" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New temporary password" autoComplete="off" />
            <button className="btn" disabled={pw.length < 8} onClick={() => act(async () => { await api.post(`/staff/users/${u.id}/password`, { password: pw }); setReset(false); setPw(''); }, `Temporary password set for ${u.name}. They choose their own at next sign-in.`)}>Set</button>
            <button className="btn ghost" onClick={() => { setReset(false); setPw(''); }}>Cancel</button>
          </span>
        ) : (
          <span className="filters" style={{ margin: 0 }}>
            <button className="btn ghost" onClick={() => setReset(true)}>Reset password</button>
            <button className="btn ghost" onClick={() => act(() => api.patch(`/staff/users/${u.id}`, { active: !u.active }), u.active ? `${u.name} is switched off and signed out.` : `${u.name} can sign in again.`)}>{u.active ? 'Switch off' : 'Switch on'}</button>
          </span>
        )}
      </td>
    </tr>
  );
}

export function TeamCard() {
  const { data, error, loading, reload } = useApi('/staff/users');
  const [form, setForm] = useState({ name: '', username: '', role: 'confirmation', password: '' });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const add = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.post('/staff/users', form);
      setMsg({ ok: true, text: `${form.name} added. Give them the username and this temporary password; they set their own at first sign-in.` });
      setForm({ name: '', username: '', role: 'confirmation', password: '' }); reload();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <h2>Team logins</h2>
      <p className="muted">One login per person, never shared. Every action in the Confirm queue and Dispatch desk is saved with the person&apos;s name, the time and the status before. Team members sign in at <b>/team</b> on their phone.</p>
      <Loading error={error} loading={loading && !data}>
        {data && (
          <>
            {data.users.length > 0 && (
              <div className="tablewrap"><table>
                <thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
                <tbody>{data.users.map((u) => <UserRow key={u.id} u={u} onChanged={reload} setMsg={setMsg} />)}</tbody>
              </table></div>
            )}
            {data.users.length === 0 && <div className="banner warn">No one has a login yet. Create the first admin below, then add your confirmation and packing team.</div>}
            <h2 style={{ marginTop: 16 }}>Add a person</h2>
            <div className="bucket" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <input type="text" value={form.name} placeholder="Full name" onChange={(e) => set('name', e.target.value)} />
              <input type="text" value={form.username} placeholder="Username, e.g. asha.k" autoCapitalize="none" onChange={(e) => set('username', e.target.value)} />
              <select value={form.role} onChange={(e) => set('role', e.target.value)}>{Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <input type="text" value={form.password} placeholder="Temporary password (8+ characters)" autoComplete="off" onChange={(e) => set('password', e.target.value)} />
            </div>
            <div className="filters"><button className="btn" disabled={busy || !form.name || !form.username || form.password.length < 8} onClick={add}>{busy ? 'Adding…' : 'Add person'}</button></div>
          </>
        )}
      </Loading>
      {msg && <div className={`banner ${msg.ok ? '' : 'err'}`}>{msg.text}</div>}
    </div>
  );
}

export function DeskSettingsCard() {
  const { data, error, loading } = useApi('/flow/config');
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (data) setF({ afterThree: data.afterThree, startFrom: data.startFrom || '', partialLinkUrl: data.partialLinkUrl || '' }); }, [data]);
  const save = async () => {
    setMsg(null);
    try { await api.put('/flow/config', f); setMsg({ ok: true, text: 'Saved. The desks use these settings straight away.' }); } catch (e) { setMsg({ ok: false, text: e.message }); }
  };
  return (
    <div className="card">
      <h2>Confirm queue settings</h2>
      <Loading error={error} loading={(loading && !data) || !f}>
        {f && (
          <>
            <div className="field"><label htmlFor="a3">After the third unanswered call</label>
              <select id="a3" value={f.afterThree} onChange={(e) => setF({ ...f, afterThree: e.target.value })}>
                <option value="cancel">Cancel the order automatically</option>
                <option value="escalate">Escalate to a lead (stays in the queue, flagged)</option>
              </select></div>
            <div className="field"><label htmlFor="sf">Show orders placed since</label>
              <input id="sf" type="date" value={f.startFrom} onChange={(e) => setF({ ...f, startFrom: e.target.value })} />
              <span className="muted">Leave empty for the last 7 days. Older pending orders in the sheet stay out of the queue.</span></div>
            <div className="field"><label htmlFor="pl">Partial payment link</label>
              <input id="pl" type="text" value={f.partialLinkUrl} placeholder="https://pages.razorpay.com/yourpage?order={orderId}&amount={amount}" onChange={(e) => setF({ ...f, partialLinkUrl: e.target.value })} />
              <span className="muted">Used by the &quot;Payment link&quot; button. Placeholders: {'{orderId}'}, {'{amount}'} (rupees), {'{amountPaise}'}, {'{phone}'}. Must start with https://. Leave empty to switch the button off.</span></div>
            <div className="filters"><button className="btn" onClick={save}>Save settings</button></div>
          </>
        )}
      </Loading>
      {msg && <div className={`banner ${msg.ok ? '' : 'err'}`}>{msg.text}</div>}
    </div>
  );
}
