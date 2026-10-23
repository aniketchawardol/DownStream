// @ts-check
// Times are stored in UTC and shown in Asia/Kolkata (UTC+05:30, no DST).

export const IST_OFFSET_MIN = 330;
export const TZ = 'Asia/Kolkata';

/** A Date shifted so its UTC fields read as IST wall-clock time. @param {Date} d */
export function toIst(d) {
  return new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
}

/** India's fiscal year (1 April to 31 March) as 'YYYY-YYYY'. @param {Date} [d] */
export function fiscalYear(d = new Date()) {
  const ist = toIst(d);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${start + 1}`;
}

/** @param {string} fy */
export function previousFiscalYear(fy) {
  const s = Number(fy.slice(0, 4)) - 1;
  return `${s}-${s + 1}`;
}

/** IST calendar date 'YYYY-MM-DD'. @param {Date} [d] */
export function istDate(d = new Date()) {
  return toIst(d).toISOString().slice(0, 10);
}

/** Start of the IST day containing d, as a UTC instant. @param {Date} [d] */
export function istDayStart(d = new Date()) {
  return new Date(`${istDate(d)}T00:00:00+05:30`);
}

const MONTHS = /** @type {Record<string, number>} */ ({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
});

/**
 * Parse an IST wall-clock date such as '23/10/2026', '23-10-2026 14:05', '23-Oct-2026 02:05 PM',
 * '2026-10-23' or ISO into a UTC Date. Null for blanks and placeholders.
 * @param {string|null|undefined} s
 */
export function parseIstDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t || /^(-+|na|n\/a|null|0|nil)$/i.test(t)) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) {
    const d = new Date(/(z|[+-]\d{2}:?\d{2})$/i.test(t) ? t : `${t}+05:30`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  let y = 0, mo = 0, da = 0, h = 0, mi = 0, se = 0;
  /** @type {string|undefined} */ let ampm;
  // WQMIS reports print '05.03.2026 | 12:30:00 PM'; sample lists print '05/03/2026'.
  let m = t.match(/^(\d{1,2})[/\-. ](\d{1,2}|[A-Za-z]{3,9})[/\-. ,]+(\d{4})(?:[ T,|]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/);
  if (m) {
    da = Number(m[1]);
    mo = /\d/.test(m[2]) ? Number(m[2]) : MONTHS[m[2].slice(0, 3).toLowerCase()] || 0;
    y = Number(m[3]);
    if (m[4]) { h = Number(m[4]); mi = Number(m[5]); se = Number(m[6] || 0); ampm = m[7]; }
  } else if ((m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/))) {
    y = Number(m[1]); mo = Number(m[2]); da = Number(m[3]);
    if (m[4]) { h = Number(m[4]); mi = Number(m[5]); se = Number(m[6] || 0); ampm = m[7]; }
  } else {
    return null;
  }
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  if (!mo || mo > 12 || !da || da > 31 || y < 1990 || y > 2100 || h > 23 || mi > 59) return null;
  return new Date(Date.UTC(y, mo - 1, da, h, mi, se) - IST_OFFSET_MIN * 60_000);
}

/** e.g. '10:30 IST'. @param {Date} d */
export function istClock(d) {
  return `${toIst(d).toISOString().slice(11, 16)} IST`;
}

/** e.g. '23 Oct 2026'. @param {Date} d */
export function istLongDate(d) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

/** Human age: '14 minutes', '3 hours', '5 days', '4 months'. @param {number} ms */
export function humanAge(ms) {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} day${d === 1 ? '' : 's'}`;
  const mo = Math.round(d / 30.44);
  return `${mo} month${mo === 1 ? '' : 's'}`;
}
