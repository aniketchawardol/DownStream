// @ts-check
// The live hero sentence, shared by the server (first paint) and the browser (after location changes):
// "The Ganga at {freshest station near the viewer, else the freshest overall} was measured {n} minutes ago.
//  Taps in {nearest tested panchayat} were last lab-tested {n} months ago."

const NEAR_KM = 400;

/** @param {unknown} s */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);

/** '14 minutes', '3 hours', '5 days', '4 months'. @param {number} ms */
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

/** @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
function km(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

/**
 * @typedef {{ lat: number, lng: number, place: string, river: string|null, last_reading_at: string|Date|null, is_stale: boolean }} HeroStation
 * @typedef {{ lat: number, lng: number, name: string, last_tested_at: string|Date|null, approximate: boolean }} HeroArea
 * @param {HeroStation[]} stations @param {HeroArea[]} areas @param {{ lat: number, lng: number } | null} viewer @param {number} [now]
 * @returns {string|null} HTML (escaped) or null when there is nothing to say
 */
export function heroHtml(stations, areas, viewer, now = Date.now()) {
  const t = (/** @type {string|Date} */ d) => new Date(d).getTime();
  const fresh = stations.filter((s) => !s.is_stale && s.last_reading_at);
  let river = null;
  if (fresh.length) {
    const minAge = Math.min(...fresh.map((s) => now - t(/** @type {any} */ (s.last_reading_at))));
    const sameHour = fresh.filter((s) => now - t(/** @type {any} */ (s.last_reading_at)) - minAge < 3600_000);
    if (viewer) river = fresh.map((s) => ({ s, d: km(viewer.lat, viewer.lng, s.lat, s.lng) })).filter((x) => x.d <= NEAR_KM).sort((a, b) => a.d - b.d)[0]?.s ?? null;
    // Among the freshest, prefer a named river, and the Ganga itself where there's a tie.
    river ??= sameHour.find((s) => s.river === 'Ganga') ?? sameHour.find((s) => s.river) ?? sameHour[0];
  }
  const tested = areas.filter((a) => a.last_tested_at && !a.approximate);
  let area = null;
  if (tested.length) {
    area = viewer
      ? tested.map((a) => ({ a, d: km(viewer.lat, viewer.lng, a.lat, a.lng) })).sort((x, y) => x.d - y.d)[0].a
      : [...tested].sort((x, y) => t(/** @type {any} */ (y.last_tested_at)) - t(/** @type {any} */ (x.last_tested_at)))[0];
  }
  const parts = [];
  if (river) {
    const where = river.river ? `The ${river.river} at ${river.place}` : `River water at ${river.place}`;
    parts.push(`${esc(where)} was measured <span class="num">${esc(ageWords(now - t(/** @type {any} */ (river.last_reading_at))))}</span> ago.`);
  } else if (stations.length) {
    parts.push('No river station has reported in the last six hours.');
  }
  if (area) parts.push(`Taps in ${esc(area.name)} were last lab-tested <span class="num">${esc(ageWords(now - t(/** @type {any} */ (area.last_tested_at))))}</span> ago.`);
  return parts.length ? parts.join(' ') : null;
}
