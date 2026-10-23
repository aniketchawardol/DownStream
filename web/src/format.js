// @ts-check
// Formatting, status vocabulary and freshness-ring maths shared by every panel.

const TZ = 'Asia/Kolkata';
const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const shortDateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short' });

/** @param {string|Date|null|undefined} d */
export const toDate = (d) => (d == null ? null : d instanceof Date ? d : new Date(d));

/** '10:30 IST' @param {string|Date} d */
export const istTime = (d) => `${timeFmt.format(/** @type {Date} */ (toDate(d)))} IST`;
/** '23 Oct 2026' @param {string|Date} d */
export const istDate = (d) => dateFmt.format(/** @type {Date} */ (toDate(d)));
/** '23 Oct' @param {string|Date} d */
export const istShortDate = (d) => shortDateFmt.format(/** @type {Date} */ (toDate(d)));
/** '10:30 IST on 23 Oct 2026' @param {string|Date} d */
export const istDateTime = (d) => `${istTime(d)} on ${istDate(d)}`;

/** Age in plain words: '14 minutes', '3 hours', '5 days', '4 months'. @param {number} ms */
export function ageWords(ms) {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return 'less than a minute';
  if (min < 90) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d} day${d === 1 ? '' : 's'}`;
  const mo = Math.round(d / 30.44);
  if (mo < 24) return `${mo} month${mo === 1 ? '' : 's'}`;
  const y = Math.floor(mo / 12);
  return `${y} year${y === 1 ? '' : 's'}`;
}
/** @param {string|Date|null|undefined} d */
export const ago = (d) => (d ? `${ageWords(Date.now() - /** @type {Date} */ (toDate(d)).getTime())} ago` : 'never');

/** Numbers with tabular figures in the Indian locale. @param {number|null|undefined} v @param {number} [dp] */
export function num(v, dp = 2) {
  if (v == null || !Number.isFinite(v)) return '–';
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 10 ? Math.min(dp, 1) : dp;
  return v.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** HTML-escape. @param {unknown} s */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);

/** Status vocabulary. Colour never travels alone: every status has words and a class for shape/glyph. */
export const STATUS = /** @type {Record<string, { word: string, cls: 'ok'|'caution'|'danger'|'stale'|'none' }>} */ ({
  ok: { word: 'Within limits', cls: 'ok' },
  above_acceptable: { word: 'Above acceptable limit', cls: 'caution' },
  above_permissible: { word: 'Above permissible limit', cls: 'danger' },
  violation: { word: 'Outside river limit', cls: 'danger' },
  stale: { word: 'No recent data', cls: 'stale' },
  never: { word: 'No lab test found', cls: 'none' },
  unknown: { word: 'Not judged', cls: 'none' },
  no_criteria: { word: 'No official limit', cls: 'none' },
});
/** @param {string|null|undefined} s */
export const status = (s) => STATUS[s ?? 'unknown'] ?? STATUS.unknown;

const clamp01 = (/** @type {number} */ x) => Math.max(0, Math.min(1, x));
/** River ring: full under 1 hour, empty at 24 hours. @param {number|null} ageMin */
export const riverFresh = (ageMin) => (ageMin == null ? 0 : clamp01(1 - (ageMin / 60 - 1) / 23));
/** Panchayat ring: full under 30 days, empty at `emptyDays` (365 chemical, 182 bacteriological). @param {number|null} days @param {number} emptyDays */
export const tapFresh = (days, emptyDays) => (days == null ? 0 : clamp01(1 - (days - 30) / (emptyDays - 30)));

/** "the Ganga at Haridwar" / "river water at Pratapgarh". @param {{ river: string|null, place: string }} p @param {boolean} [cap] */
export function riverPlace(p, cap = false) {
  const s = p.river ? `the ${p.river} at ${p.place}` : `river water at ${p.place}`;
  return cap ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Plain km. @param {number} km */
export const km = (km) => `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;

/** Great-circle distance in km. @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
export function distanceKm(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isMobile = () => matchMedia('(max-width: 899px)').matches;
export const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

/** Swap panel content with a view transition where supported. @param {() => void} fn */
export function transition(fn) {
  const d = /** @type {any} */ (document);
  if (d.startViewTransition && !reducedMotion()) d.startViewTransition(fn);
  else fn();
}
