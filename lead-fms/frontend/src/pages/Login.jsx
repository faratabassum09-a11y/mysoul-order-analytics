import React, { useState } from "react";
import SchoolBrand from "../components/SchoolLogo.jsx";
import { useAuth } from "../context/AuthContext.jsx";

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setSlow(false);
    setBusy(true);
    const slowTimer = setTimeout(() => setSlow(true), 3500);
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message || "Couldn't sign in");
    } finally {
      clearTimeout(slowTimer);
      setBusy(false);
      setSlow(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <SchoolBrand size={52} />
          <div className="login-suite">Sign in to Lead FMS</div>
        </div>
        <form onSubmit={submit} className="login-form">
          <label>
            Email
            <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@mysoulschool.in" />
          </label>
          <label>
            Password
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? (
              <span className="login-btn-busy">
                <span className="btn-spinner" aria-hidden="true" />
                {slow ? "Waking up the server…" : "Signing in…"}
              </span>
            ) : (
              "Sign In"
            )}
          </button>
          {slow && (
            <p className="login-slow-hint">
              This can take up to a minute right after the server's been idle — hang tight.
            </p>
          )}
        </form>
        <p className="login-hint">
          Don't have an account? Ask an admin to add you from the <strong>Team</strong> page.
        </p>
      </div>
    </div>
  );
}
