import React, { useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { useToast } from "../components/Toast.jsx";
import { avatarStyleFromString, initials } from "../utils/colorFromString.js";

const TABS = [
  { id: "profile", label: "Profile", icon: "M12 12a4.8 4.8 0 1 0 0-9.6 4.8 4.8 0 0 0 0 9.6Zm0 2.4c-3.6 0-9.6 1.8-9.6 5.4V22h19.2v-2.2c0-3.6-6-5.4-9.6-5.4Z" },
  { id: "security", label: "Security", icon: "M12 2 4 5v6c0 5 3.4 9.4 8 10.5C16.6 20.4 20 16 20 11V5l-8-3Zm0 4.6a2.6 2.6 0 0 1 1.3 4.85V14a1.3 1.3 0 0 1-2.6 0v-2.55A2.6 2.6 0 0 1 12 6.6Z" },
];

export default function Account() {
  const { user, updateProfile, isAdmin } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const toast = useToast();
  const [tab, setTab] = useState("profile");

  const [name, setName] = useState(user?.name || "");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState("");
  const profileDirty = name !== (user?.name || "");

  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pwStrength = (() => {
    const v = form.newPassword;
    if (!v) return 0;
    let s = 0;
    if (v.length >= 8) s++;
    if (v.length >= 12) s++;
    if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
    if (/[0-9]/.test(v) && /[^A-Za-z0-9]/.test(v)) s++;
    return Math.min(s, 4);
  })();
  const pwLabels = ["Too short", "Weak", "Okay", "Good", "Strong"];
  const pwColors = ["var(--bad)", "var(--bad)", "var(--warn)", "var(--good)", "var(--good)"];

  const submitProfile = async (e) => {
    e.preventDefault();
    setProfileError("");
    setProfileBusy(true);
    try {
      const res = await api.updateProfile({ name });
      updateProfile(res.user);
      toast("Profile updated", "good");
    } catch (err) {
      setProfileError(err.message);
    } finally {
      setProfileBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (form.newPassword !== form.confirm) {
      setError("New password and confirmation don't match");
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(form.currentPassword, form.newPassword);
      setForm({ currentPassword: "", newPassword: "", confirm: "" });
      toast("Password updated", "good");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page account-page">
      <PageHeader title="Account" subtitle="Your profile and security" />

      <div className="account-hero">
        <div className="account-hero-glow" aria-hidden="true" />
        <span className="avatar account-hero-avatar" style={avatarStyleFromString(user?.name || "")}>{initials(user?.name || "")}</span>
        <div className="account-hero-info">
          <div className="account-hero-name">
            {user?.name}
            <span className={"role-pill" + (isAdmin ? " role-pill-admin" : "")}>{isAdmin ? "Admin" : "Caller"}</span>
          </div>
          <div className="account-hero-email">{user?.email}</div>
          {user?.createdAt && (
            <div className="account-hero-since">Member since {new Date(user.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</div>
          )}
        </div>
      </div>

      <div className="account-tabs" role="tablist" aria-label="Account sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
            className={"account-tab" + (tab === t.id ? " account-tab-active" : "")} onClick={() => setTab(t.id)}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "profile" && (
        <div className="settings-card account-panel">
          <h3>Edit Profile</h3>
          <p className="settings-hint">This is how you show up across the app — sidebar, activity and reports.</p>
          <form onSubmit={submitProfile} className="stacked-form account-form">
            <label>
              Display name
              <input required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Caller name
              <input value={user?.leadName || ""} readOnly disabled />
              <span className="field-hint">Leads assigned to this name show up for you. An admin can change it on the Team page.</span>
            </label>
            {profileError && <p className="error">{profileError}</p>}
            <div className="account-form-actions">
              <button type="submit" disabled={profileBusy || !profileDirty}>{profileBusy ? "Saving…" : "Save Profile"}</button>
              {profileDirty && !profileBusy && <span className="account-unsaved">Unsaved changes</span>}
            </div>
          </form>
          <hr className="modal-divider" />
          <h3>Appearance</h3>
          <p className="settings-hint">Light or dark — remembered on this device.</p>
          <button type="button" className="btn-ghost" style={{ padding: "8px 16px", borderRadius: 8, cursor: "pointer" }} onClick={toggleTheme}>
            {theme === "dark" ? "☀ Switch to light mode" : "☾ Switch to dark mode"}
          </button>
        </div>
      )}

      {tab === "security" && (
        <div className="settings-card account-panel">
          <h3>Change Password</h3>
          <p className="settings-hint">Choose something you don't use anywhere else — at least 8 characters.</p>
          <form onSubmit={submit} className="stacked-form account-form">
            <label>
              Current password
              <input type="password" required value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />
            </label>
            <label>
              New password
              <input type="password" required minLength={8} value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} />
              {form.newPassword && (
                <span className="pw-strength">
                  <span className="pw-strength-bars">
                    {[0, 1, 2, 3].map((i) => (
                      <span key={i} className="pw-strength-bar" style={{ background: i < pwStrength ? pwColors[pwStrength] : "var(--line)" }} />
                    ))}
                  </span>
                  <span style={{ color: pwColors[pwStrength] }}>{pwLabels[pwStrength]}</span>
                </span>
              )}
            </label>
            <label>
              Confirm new password
              <input type="password" required minLength={8} value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
              {form.confirm && (
                <span className={"field-hint" + (form.confirm === form.newPassword ? " field-hint-good" : " field-hint-bad")}>
                  {form.confirm === form.newPassword ? "Passwords match" : "Doesn't match yet"}
                </span>
              )}
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={busy}>{busy ? "Saving…" : "Update Password"}</button>
          </form>
        </div>
      )}
    </div>
  );
}
