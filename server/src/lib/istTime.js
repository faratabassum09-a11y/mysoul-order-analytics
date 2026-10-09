// All business dates are IST (Asia/Kolkata, UTC+05:30, no DST).
const OFFSET = 330 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const shifted = (d) => new Date(d.getTime() + OFFSET);

function istParts(d) {
  const s = shifted(d);
  return {
    y: s.getUTCFullYear(),
    m: s.getUTCMonth(), // 0-based
    d: s.getUTCDate(),
    h: s.getUTCHours(),
    mi: s.getUTCMinutes(),
    dow: (s.getUTCDay() + 6) % 7, // Monday = 0
  };
}

// Build a Date from IST wall-clock parts (month 0-based). Overflow normalises like Date.UTC.
function istToDate(y, m, d, h = 0, mi = 0, s = 0) {
  return new Date(Date.UTC(y, m, d, h, mi, s) - OFFSET);
}

const startOfDay = (d) => new Date(Math.floor((d.getTime() + OFFSET) / DAY) * DAY - OFFSET);
const startOfWeek = (d) => {
  const sd = startOfDay(d);
  return new Date(sd.getTime() - istParts(sd).dow * DAY);
};
const startOfMonth = (d) => {
  const p = istParts(d);
  return istToDate(p.y, p.m, 1);
};
const addMonths = (d, n) => {
  const p = istParts(d);
  return istToDate(p.y, p.m + n, 1);
};
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => {
  const p = istParts(d);
  return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`;
};
const fmtDateTime = (d) => {
  const p = istParts(d);
  return `${p.y}-${pad(p.m + 1)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
};
function parseYmd(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
  if (!m) return null;
  const d = istToDate(+m[1], +m[2] - 1, +m[3]);
  return fmtDate(d) === str ? d : null;
}

module.exports = { OFFSET, DAY, istParts, istToDate, startOfDay, startOfWeek, startOfMonth, addMonths, fmtDate, fmtDateTime, parseYmd };
