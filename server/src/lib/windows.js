const T = require('./istTime');
const { DAY } = T;

const LABELS = {
  today: 'Today', yesterday: 'Yesterday', this_week: 'This week', last_week: 'Last week',
  this_month: 'This month', last_month: 'Last month', last_3_months: 'Last 3 months',
  last_6_months: 'Last 6 months', last_12_months: 'Last 12 months', all_time: 'All time', custom: 'Custom range',
};

// Returns { key, label, start, end (exclusive), prev: {start,end}|null, partial }.
// Calendar windows compare with the previous calendar period; rolling windows with the equal-length block before.
function resolveWindow(key, now = new Date(), custom = {}) {
  const sod = T.startOfDay(now);
  let start = null, end = null, prev = null;
  switch (key) {
    case 'today': start = sod; end = new Date(sod.getTime() + DAY); break;
    case 'yesterday': end = sod; start = new Date(sod.getTime() - DAY); break;
    case 'this_week': start = T.startOfWeek(now); end = new Date(start.getTime() + 7 * DAY);
      prev = { start: new Date(start.getTime() - 7 * DAY), end: start }; break;
    case 'last_week': end = T.startOfWeek(now); start = new Date(end.getTime() - 7 * DAY);
      prev = { start: new Date(start.getTime() - 7 * DAY), end: start }; break;
    case 'this_month': start = T.startOfMonth(now); end = T.addMonths(start, 1);
      prev = { start: T.addMonths(start, -1), end: start }; break;
    case 'last_month': end = T.startOfMonth(now); start = T.addMonths(end, -1);
      prev = { start: T.addMonths(start, -1), end: start }; break;
    case 'last_3_months': case 'last_6_months': case 'last_12_months': {
      const n = Number(key.split('_')[1]);
      end = new Date(sod.getTime() + DAY);
      const p = T.istParts(now);
      start = T.istToDate(p.y, p.m - n, p.d);
      break;
    }
    case 'all_time': break;
    case 'custom': {
      const f = T.parseYmd(custom.from), t = T.parseYmd(custom.to);
      if (!f || !t || t < f) throw Object.assign(new Error('Custom range needs valid from/to dates (YYYY-MM-DD), from <= to'), { status: 400 });
      start = f; end = new Date(t.getTime() + DAY); break;
    }
    default: throw Object.assign(new Error(`Unknown window "${key}"`), { status: 400 });
  }
  if (start && end && !prev) {
    const len = end.getTime() - start.getTime();
    prev = { start: new Date(start.getTime() - len), end: start };
  }
  return { key, label: LABELS[key], start, end, prev, partial: !!end && now < end };
}

const dateFilter = (range) => (range && range.start ? { orderDate: { $gte: range.start, $lt: range.end } } : {});

module.exports = { resolveWindow, dateFilter, LABELS };
