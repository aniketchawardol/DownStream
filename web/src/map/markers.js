// @ts-check
// SVG markers. Shape = source (circle river, rounded square tap), ring arc = freshness,
// fill = status, glyph inside = status again (so colour never carries meaning alone).
import { riverFresh, tapFresh, status, riverPlace, ago } from '../format.js';

/** Glyph drawn on the fill. @param {string} cls @param {number} c centre */
function glyph(cls, c) {
  if (cls === 'ok') return `<path class="glyph-mark" d="M${c - 3.2} ${c + 0.2} l2.2 2.2 l4.2 -4.6"/>`;
  if (cls === 'caution') return `<path class="glyph-mark" d="M${c - 3.2} ${c} h6.4"/>`;
  if (cls === 'danger') return `<path class="glyph-mark" d="M${c} ${c - 3.6} v4"/><circle class="glyph-dot" cx="${c}" cy="${c + 3.2}" r="1.1"/>`;
  return '';
}

/** @param {number} p 0..1 */
const dash = (p) => `${(p * 100).toFixed(2)} 100`;

/** @param {any} props station feature properties */
export function riverMarker(props) {
  const st = props.is_stale ? 'stale' : props.status === 'violation' ? 'violation' : 'ok';
  const s = status(st);
  const fresh = props.is_stale ? 0 : riverFresh(props.age_minutes);
  const el = document.createElement('div');
  el.className = `mk mk-river`;
  el.dataset.kind = 'station';
  el.dataset.id = props.station_no;
  el.setAttribute('aria-hidden', 'true');
  el.title = `${riverPlace(props, true)}: ${s.word.toLowerCase()}. ${props.last_reading_at ? `Measured ${ago(props.last_reading_at)}.` : 'No readings yet.'}`;
  el.innerHTML = `<svg viewBox="0 0 30 30">
    <circle class="track" cx="15" cy="15" r="12.5"/>
    <circle class="ring${props.is_stale ? ' stale' : ''}" cx="15" cy="15" r="12.5" pathLength="100" transform="rotate(-90 15 15)"
      stroke-dasharray="${props.is_stale ? '' : dash(fresh)}" data-target="${fresh}"/>
    <circle class="fill ${s.cls}" cx="15" cy="15" r="7.5"/>${glyph(s.cls, 15)}
  </svg>`;
  return el;
}

/** @param {any} props area feature properties */
export function tapMarker(props) {
  const st = props.status === 'never' ? 'never' : props.status === 'stale' ? 'stale' : props.latest_round_status ?? 'unknown';
  const s = status(st);
  const stale = st === 'stale' || st === 'never';
  const chem = tapFresh(props.chemical_age_days, 365);
  const bact = tapFresh(props.bacteriological_age_days, 182);
  const el = document.createElement('div');
  el.className = `mk mk-tap${props.approximate ? ' approx' : ''}`;
  el.dataset.kind = 'area';
  el.dataset.id = props.id;
  el.setAttribute('aria-hidden', 'true');
  el.title = `${props.name} panchayat: ${s.word.toLowerCase()}. ${props.last_tested_at ? `Last lab test ${ago(props.last_tested_at)}.` : 'No lab test found.'}${props.approximate ? ' Location approximate.' : ''}`;
  el.innerHTML = `<svg viewBox="0 0 30 30">
    <rect class="track" x="2.5" y="2.5" width="25" height="25" rx="6"/>
    <rect class="ring chem${stale ? ' stale' : ''}" x="2.5" y="2.5" width="25" height="25" rx="6" pathLength="100"
      stroke-dasharray="${stale ? '' : dash(chem)}" data-target="${stale ? 0 : chem}"/>
    <rect class="ring bact${stale || props.bacteriological_age_days == null ? ' stale' : ''}" x="6.5" y="6.5" width="17" height="17" rx="3.5" pathLength="100"
      stroke-dasharray="${stale || props.bacteriological_age_days == null ? '' : dash(bact)}" data-target="${stale ? 0 : bact}"/>
    <rect class="fill ${s.cls}" x="9.5" y="9.5" width="11" height="11" rx="2"/>${glyph(s.cls, 15)}
  </svg>`;
  return el;
}

/** Neutral district marker shown when zoomed out: a count, no status colour. @param {string} name @param {number} count @param {number} freshest 0..1 */
export function districtMarker(name, count, freshest) {
  const el = document.createElement('div');
  el.className = 'mk mk-district';
  el.dataset.kind = 'district';
  el.setAttribute('aria-hidden', 'true');
  el.title = `${count} panchayats in ${name} with lab-test data. Zoom in to see them.`;
  el.innerHTML = `<svg viewBox="0 0 44 44">
    <rect class="outline" x="3" y="3" width="38" height="38" rx="9"/>
    <rect class="ring" x="3" y="3" width="38" height="38" rx="9" pathLength="100" stroke-dasharray="${dash(freshest)}" data-target="${freshest}" style="stroke: var(--umber); stroke-width: 3; fill: none"/>
    <text x="22" y="26.5" text-anchor="middle">${count}</text>
  </svg><span class="label">${name}: zoom in</span>`;
  return el;
}

/** Simulated subject: dashed outline, never a status fill. @param {{ id: string, name: string }} s @param {'station'|'gp'} type */
export function simMarker(s, type) {
  const el = document.createElement('div');
  el.className = 'mk mk-sim';
  el.dataset.kind = 'sim';
  el.dataset.id = s.id;
  el.setAttribute('aria-hidden', 'true');
  el.title = `${s.name}. Simulated: this place is invented for testing.`;
  el.innerHTML = type === 'station'
    ? `<svg viewBox="0 0 30 30"><circle class="outline" cx="15" cy="15" r="12.5"/><circle class="fill" cx="15" cy="15" r="7"/></svg><span class="label">${s.id} (simulated)</span>`
    : `<svg viewBox="0 0 30 30"><rect class="outline" x="2.5" y="2.5" width="25" height="25" rx="6"/><rect class="fill" x="9" y="9" width="12" height="12" rx="2"/></svg><span class="label">${s.id} (simulated)</span>`;
  return el;
}

export function pinMarker() {
  const el = document.createElement('div');
  el.className = 'mk-pin';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<svg viewBox="0 0 26 26"><circle cx="13" cy="13" r="6"/><path d="M13 1v7M13 18v7M1 13h7M18 13h7"/></svg>';
  return el;
}

export function mockPointMarker() {
  const el = document.createElement('div');
  el.className = 'mk-mockpoint';
  el.setAttribute('aria-hidden', 'true');
  el.title = 'Simulation point: simulated alerts are placed around here.';
  el.innerHTML = '<svg viewBox="0 0 34 34"><circle cx="17" cy="17" r="15"/><circle cx="17" cy="17" r="2.5" style="fill: var(--sim); stroke: none"/></svg>';
  return el;
}

/** Small inline glyph for list rows, matching the marker shape and status. @param {'station'|'area'|'sim'} kind @param {string} cls */
export function rowGlyph(kind, cls) {
  const fill = cls === 'ok' ? 'var(--ok)' : cls === 'caution' ? 'var(--caution)' : cls === 'danger' ? 'var(--danger)' : 'url(#hatch)';
  if (kind === 'sim') return `<svg class="glyph" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="9" fill="none" stroke="var(--sim)" stroke-width="2" stroke-dasharray="3 3"/></svg>`;
  if (kind === 'station') return `<svg class="glyph" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="9" fill="none" stroke="var(--survey)" stroke-width="2.5"/><circle cx="11" cy="11" r="5" fill="${fill}"/></svg>`;
  return `<svg class="glyph" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><rect x="2" y="2" width="18" height="18" rx="4" fill="none" stroke="var(--umber)" stroke-width="2.5"/><rect x="7" y="7" width="8" height="8" rx="1.5" fill="${fill}"/></svg>`;
}
