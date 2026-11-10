/*
 * Pay-period math shared by the server and the browser.
 *
 * Dates are plain "YYYY-MM-DD" strings, and arithmetic runs on UTC midnights,
 * so daylight-saving changes can never shift a date.
 *
 * Each person has one of three schedules, set by the owner:
 *   weekly    Every week. `payday` is any one payday; each period is the 7 days before a payday.
 *   biweekly  Every two weeks (the default). Each period is the 14 days ending the day before a payday.
 *   monthly   Calendar months. Payment is due on the last day of the month.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PayPeriod = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const DEFAULT_SCHEDULE = { type: 'biweekly', payday: '2026-10-12' };

  function toMs(s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); }
  function fromMs(ms) {
    const d = new Date(ms);
    return String(d.getUTCFullYear()).padStart(4, '0') + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function isValidDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const y = +s.slice(0, 4);
    return y >= 2000 && y <= 2999 && fromMs(toMs(s)) === s;
  }
  function addDays(s, n) { return fromMs(toMs(s) + n * DAY_MS); }
  function diffDays(a, b) { return Math.round((toMs(b) - toMs(a)) / DAY_MS); }
  function weekday(s) { return new Date(toMs(s)).getUTCDay(); } // 0 = Sunday
  function eachDay(from, to) { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }

  function normalize(schedule) {
    const s = schedule || {};
    if (s.type === 'monthly') return { type: 'monthly' };
    const type = s.type === 'weekly' ? 'weekly' : 'biweekly';
    return { type, payday: isValidDate(s.payday) ? s.payday : DEFAULT_SCHEDULE.payday };
  }

  /** The pay period containing `date`: { start, end, due }. */
  function periodFor(date, schedule) {
    const s = normalize(schedule);
    if (s.type === 'monthly') {
      const y = +date.slice(0, 4), m = +date.slice(5, 7) - 1;
      const start = fromMs(Date.UTC(y, m, 1));
      const end = fromMs(Date.UTC(y, m + 1, 0));
      return { start, end, due: end };
    }
    const len = s.type === 'weekly' ? 7 : 14;
    const anchor = addDays(s.payday, -len);
    const idx = Math.floor(diffDays(anchor, date) / len);
    const start = addDays(anchor, idx * len);
    return { start, end: addDays(start, len - 1), due: addDays(start, len) };
  }
  function nextPeriod(p, schedule) { return periodFor(addDays(p.end, 1), schedule); }
  function prevPeriod(p, schedule) { return periodFor(addDays(p.start, -1), schedule); }

  /** Returns the period if start/end exactly match one under this schedule, else null. */
  function periodByStart(start, schedule) {
    if (!isValidDate(start)) return null;
    const p = periodFor(start, schedule);
    return p.start === start ? p : null;
  }

  /** Calendar date in a timezone, e.g. dateIn('America/New_York'). */
  function dateIn(tz, when) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(when || new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  /** Invoice number in the style of "Inv082026" (monthly) or "Inv11092026" (every two weeks). */
  function invoiceNumber(p, schedule) {
    const s = normalize(schedule);
    const y = p.due.slice(0, 4), m = p.due.slice(5, 7), d = p.due.slice(8, 10);
    if (s.type === 'monthly' && p.start.slice(8) === '01' && p.end === p.due) return `Inv${m}${y}`;
    return `Inv${m}${d}${y}`;
  }

  const LABELS = { weekly: 'Every week', biweekly: 'Every 2 weeks', monthly: 'Once a month' };
  function label(schedule) { return LABELS[normalize(schedule).type]; }

  return {
    DEFAULT_SCHEDULE, label, toMs, fromMs, isValidDate, addDays, diffDays, weekday, eachDay,
    normalize, periodFor, nextPeriod, prevPeriod, periodByStart, dateIn, invoiceNumber,
  };
});

