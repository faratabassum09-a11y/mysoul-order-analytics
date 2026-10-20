import { useEffect, useRef, useState } from 'react';

const HOUR = 3600 * 1000;

// Same thresholds as the server (server/src/lib/flow.js): green under 2 h, amber 2 to 4 h, red after 4 h.
export const slaBand = (ms) => (ms < 2 * HOUR ? 'green' : ms <= 4 * HOUR ? 'amber' : 'red');
export const BAND_TEXT = { green: 'On track', amber: 'Getting late', red: 'Overdue' };

const p2 = (n) => String(n).padStart(2, '0');
// 02:14:07 : the live timer on every queue card
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return `${p2(h)}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
}
export function duration(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${p2(m % 60)}m` : `${m}m`;
}

// "2 min" / "3 hr" / "2 days": one unit, rounded down. Used for "Due 2 min ago" style labels.
export function shortSpan(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}

export const fmtWhen = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '—');
export const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '—');
export const grams = (g) => (g == null ? '—' : g >= 1000 ? `${(g / 1000).toFixed(g % 1000 === 0 ? 0 : 2)} kg` : `${g} g`);

export const ROLE_LABEL = { admin: 'Admin', confirmation: 'Confirmation team', packing: 'Dispatch team' };
export const ROLE_ORDER = ['admin', 'confirmation', 'packing'];

// One login can hold several roles (for example Confirmation + Dispatch, without being an admin). `roles` is the list; `role` is the primary one on older data.
export const rolesOf = (u) => {
  if (!u) return [];
  const list = Array.isArray(u.roles) && u.roles.length ? u.roles : (u.role ? [u.role] : []);
  return ROLE_ORDER.filter((r) => list.includes(r));
};
export const hasRole = (u, ...want) => rolesOf(u).some((r) => want.includes(r));
export const isAdmin = (u) => rolesOf(u).includes('admin');
// "Confirmation team + Dispatch team"
export const roleSummary = (u) => rolesOf(u).map((r) => ROLE_LABEL[r]).join(' + ') || '—';

// A ticking clock for live timers. One interval per component that uses it; paused while the tab is hidden.
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, intervalMs);
    const vis = () => setNow(Date.now());
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [intervalMs]);
  return now;
}

// Phones often have a wrong clock. Timers use the server's "now" from each list response, so SLA colours match on every device.
export function useServerOffset(serverNow) {
  const ref = useRef(0);
  if (serverNow) ref.current = new Date(serverNow).getTime() - Date.now();
  return ref.current;
}

// Refetch every N seconds and whenever the person returns to the tab. (The list is the shared truth: two people may work it at once.)
export function useAutoRefresh(reload, seconds = 30) {
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) reload(); }, seconds * 1000);
    const vis = () => { if (!document.hidden) reload(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds]);
}

// Shrink a camera photo before upload: longest side 1600 px, JPEG. A phone photo is 3 to 8 MB; this is a few hundred KB,
// so uploads work on weak mobile data and stay under the host's request size limit.
export async function compressPhoto(file, maxSide = 1600, quality = 0.8) {
  if (!file || !/^image\//.test(file.type || 'image/jpeg')) throw new Error('That file is not a photo.');
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This photo format cannot be read. Take the photo again with the camera.')); };
      img.src = url;
    });
  }
  const w0 = bitmap.width, h0 = bitmap.height;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w0 * scale); canvas.height = Math.round(h0 * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not prepare the photo. Try again.');
  return new File([blob], 'proof.jpg', { type: 'image/jpeg' });
}
