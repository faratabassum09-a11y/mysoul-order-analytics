import { useEffect, useState } from 'react';

const BASE = '/api';
try { localStorage.removeItem('accessKey'); } catch (e) { /* the old shared key is gone; clear any leftover */ }
// Each team member signs in with their own login; the token identifies who did what.
export const getStaffToken = () => localStorage.getItem('staffToken') || '';
export const setStaffToken = (t) => (t ? localStorage.setItem('staffToken', t) : localStorage.removeItem('staffToken'));

function qs(params = {}) {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') u.set(k, v); });
  const s = u.toString();
  return s ? `?${s}` : '';
}

const authHeaders = () => {
  const h = {};
  const t = getStaffToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
};

async function request(method, path, { params, body, form, quiet401 } = {}) {
  const headers = authHeaders();
  let payload;
  if (form) payload = form;
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}${qs(params)}`, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !quiet401) {
    window.dispatchEvent(new Event('staff-expired'));
    throw new Error('Your session ended. Sign in again.');
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, code: data.code });
  return data;
}

export const api = {
  get: (path, params) => request('GET', path, { params }),
  post: (path, body, opts) => request('POST', path, { body, ...opts }),
  put: (path, body) => request('PUT', path, { body }),
  patch: (path, body) => request('PATCH', path, { body }),
  upload: (path, form) => request('POST', path, { form }),
  async download(path, params, filename) {
    const res = await fetch(`${BASE}${path}${qs(params)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('Export failed');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  },
};

// Proof photos need the sign-in header, so an <img src> cannot load them directly: fetch, keep as an object URL, reuse.
const blobCache = new Map();
export async function proofUrl(id) {
  if (blobCache.has(id)) return blobCache.get(id);
  const res = await fetch(`${BASE}/flow/proofs/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Could not load this photo');
  const url = URL.createObjectURL(await res.blob());
  blobCache.set(id, url);
  return url;
}

// Fetch on mount and whenever path/params change. Ignores out-of-order responses.
export function useApi(path, params, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const key = JSON.stringify([path, params, enabled]);
  const [tick, setTick] = useState(0);
  // When the server reports newly synced data, quietly refetch in the background (no "Loading…" flash).
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const on = () => api.get(path, params).then((data) => live && setState({ data, error: null, loading: false }), () => {});
    window.addEventListener('data-updated', on);
    return () => { live = false; window.removeEventListener('data-updated', on); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get(path, params).then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error) => live && setState({ data: null, error: error.message, loading: false })
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
