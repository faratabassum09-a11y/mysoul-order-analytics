import { useEffect, useState } from 'react';

const BASE = '/api';
export const getKey = () => localStorage.getItem('accessKey') || '';
export const setKey = (k) => localStorage.setItem('accessKey', k);

function qs(params = {}) {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') u.set(k, v); });
  const s = u.toString();
  return s ? `?${s}` : '';
}

async function request(method, path, { params, body, form } = {}) {
  const headers = { 'x-access-key': getKey() };
  let payload;
  if (form) payload = form;
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}${qs(params)}`, { method, headers, body: payload });
  if (res.status === 401) { window.dispatchEvent(new Event('auth-required')); throw new Error('Access key required'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (path, params) => request('GET', path, { params }),
  post: (path, body) => request('POST', path, { body }),
  put: (path, body) => request('PUT', path, { body }),
  upload: (path, form) => request('POST', path, { form }),
  async download(path, params, filename) {
    const res = await fetch(`${BASE}${path}${qs(params)}`, { headers: { 'x-access-key': getKey() } });
    if (!res.ok) throw new Error('Export failed');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  },
};

// Fetch on mount and whenever path/params change. Ignores out-of-order responses.
export function useApi(path, params, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const key = JSON.stringify([path, params, enabled]);
  const [tick, setTick] = useState(0);
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
