// In dev, Vite proxies "/api" to the local backend (see vite.config.js).
// In production, set VITE_API_URL to the deployed backend's URL
// (for example https://your-app.onrender.com/api) at build time.

const BASE = import.meta.env.VITE_API_URL || "/api";

export { BASE as API_BASE };

let authToken = localStorage.getItem("authToken") || null;
let onUnauthorized = null;

// Called from AuthContext on login/logout.
export function setAuthToken(token) {
  authToken = token;
  if (token) {
    localStorage.setItem("authToken", token);
  } else {
    localStorage.removeItem("authToken");
  }
}

// AuthContext registers a callback here so that ANY request
// that returns 401 sends the user back to login.
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

// fetch() only rejects when the request never reached the server (offline,
// DNS failure, server down, CORS block). Turn that into a friendly error
// flagged `.network = true` and tell the NetworkProvider so it can verify
// the connection and show the right "offline" / "server unreachable" UI.
async function netFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    window.dispatchEvent(new CustomEvent("app:network-error"));
    const err = new Error(
      navigator.onLine === false
        ? "You're offline. Check your internet connection and try again."
        : "Can't reach the server right now. Please try again in a moment."
    );
    err.network = true;
    throw err;
  }
}

async function request(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const res = await netFetch(`${BASE}${path}`, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    setAuthToken(null);
    onUnauthorized?.();
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));

    throw new Error(
      err.error ||
      err.message ||
      "Request failed"
    );
  }

  return res.json();
}

export const api = {
  // ---- auth ----
  login: (email, password) => request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: () => request("/auth/me"),
  updateProfile: (data) => request("/auth/me", { method: "PUT", body: JSON.stringify(data) }),
  changePassword: (currentPassword, newPassword) =>
    request("/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }),

  // ---- leads & follow-ups ----
  ldStats: () => request("/stats"),
  ldConfig: () => request("/config"),
  ldSaveConfig: (data) => request("/config", { method: "PUT", body: JSON.stringify(data) }),
  ldLeads: () => request("/leads"),
  ldAddLead: (data) => request("/leads", { method: "POST", body: JSON.stringify(data) }),
  ldBulkAssign: (ids, assignedTo) => request("/leads/bulk-assign", { method: "POST", body: JSON.stringify({ ids, assignedTo }) }),
  ldPatchLead: (id, data) => request(`/leads/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  ldSaveFollowUp: (id, n, data) => request(`/leads/${id}/fu/${n}`, { method: "PATCH", body: JSON.stringify(data) }),
  ldSync: () => request("/sync", { method: "POST" }),
  ldSheetKey: () => request("/sheet-key", { method: "POST" }),
  ldSheetTest: (data) => request("/sheet-test", { method: "POST", body: JSON.stringify(data) }),
  ldSheetScript: () => request("/sheet-script"),
  ldMarkAttendance: (day, entries) => request("/attendance", { method: "POST", body: JSON.stringify({ day, entries }) }), // phone numbers and/or emails
  ldImportLog: () => request("/import-log"),
  ldActivity: () => request("/activity"),
  ldToday: () => request("/today"),
  ldDaily: (days = 14) => request(`/daily?days=${days}`),
  ldSnapshot: () => request("/snapshot", { method: "POST" }),
  ldReports: (months) => request(`/reports?months=${months}`),
  ldCallers: () => request("/callers"),
  ldProgress: () => request("/progress"),
  ldHistory: (id) => request(`/leads/${id}/history`),
  ldReshare: (queue) => request("/assign/reshare", { method: "POST", body: JSON.stringify({ queue }) }),
  ldMissingLogins: () => request("/team/missing"),

  // ---- team (admin) ----
  ldTeam: () => request("/team"),
  ldAddPerson: (data) => request("/team", { method: "POST", body: JSON.stringify(data) }),
  ldUpdatePerson: (id, data) => request(`/team/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  ldRemovePerson: (id) => request(`/team/${id}`, { method: "DELETE" }),
};
