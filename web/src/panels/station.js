// @ts-check
// River station: "Reading from 10:30 IST, 14 minutes ago", then 12 small multiples of the last 48 hours.
import { scaleLinear, scaleTime } from 'd3-scale';
import { line, curveMonotoneX } from 'd3-shape';
import { getSeries } from '../api.js';
import { esc, num, istTime, istDateTime, ago, riverPlace, status } from '../format.js';
import { rowGlyph } from '../map/markers.js';

const ORDER = ['DO', 'BOD', 'pH', 'WTb', 'EC', 'COD', 'TOC', 'Nitrate', 'CL', 'WT', 'Depth', 'S'];
const FLOORS = /** @type {Record<string, number>} */ ({ CL: 5, COD: 5, TOC: 1, Nitrate: 0.3, EC: 1 });
const NOTES = /** @type {Record<string, string>} */ ({
  BOD: 'Sensor estimate, not a 5-day lab BOD.',
  EC: 'CPCB labels this mS/cm; the values match µS/cm.',
});

/** @param {any} s series @param {any} latest latest value object from /stations */
function sparkline(s, latest) {
  const W = 180, H = 44;
  const pts = s.points.map((/** @type {[string, number]} */ [t, v]) => [new Date(t), v]).filter((/** @type {any[]} */ p) => Number.isFinite(p[1]));
  if (pts.length < 2) return '<svg aria-hidden="true"></svg>';
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const values = pts.map((/** @type {any[]} */ p) => p[1]);
  const lim = s.limit;
  const extra = lim ? [lim.min, lim.max].filter((v) => v != null) : [];
  let lo = Math.min(...values, ...extra), hi = Math.max(...values, ...extra);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  const x = scaleTime().domain([t0, t1]).range([0, W]);
  const y = scaleLinear().domain([lo - pad, hi + pad]).range([H, 0]);
  // Gaps longer than 2 hours break the line rather than inventing values.
  const gapAware = pts.map((/** @type {any[]} */ p, i) => (i && p[0] - pts[i - 1][0] > 2 * 3600_000 ? [p[0], NaN] : p));
  const path = line().defined((/** @type {any} */ d) => Number.isFinite(d[1])).x((/** @type {any} */ d) => x(d[0])).y((/** @type {any} */ d) => y(d[1])).curve(curveMonotoneX)(/** @type {any} */ (gapAware)) ?? '';
  let band = '';
  if (lim) {
    const top = lim.max != null ? y(lim.max) : 0;
    const bottom = lim.min != null ? y(lim.min) : H;
    band = `<rect class="band" x="0" width="${W}" y="${Math.max(0, top)}" height="${Math.max(0, Math.min(H, bottom) - Math.max(0, top))}"/>`
      + (lim.max != null ? `<line class="band-edge" x1="0" x2="${W}" y1="${top}" y2="${top}"/>` : '')
      + (lim.min != null ? `<line class="band-edge" x1="0" x2="${W}" y1="${bottom}" y2="${bottom}"/>` : '');
  }
  const last = pts[pts.length - 1];
  const label = `${s.label}, last 48 hours: from ${num(Math.min(...values))} to ${num(Math.max(...values))}${s.unit ? ` ${s.unit}` : ''}, latest ${num(latest?.value ?? last[1])}.`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${band}<path class="spark" d="${path}" vector-effect="non-scaling-stroke"/><circle class="last" cx="${x(last[0])}" cy="${y(last[1])}" r="2.5"/></svg>`;
}

/** @param {HTMLElement} root @param {any} feature station feature */
export async function renderStation(root, feature) {
  const p = feature.properties;
  const lastAt = p.last_reading_at ? new Date(p.last_reading_at) : null;
  const statusWord = p.is_stale ? status('stale') : p.status === 'violation' ? status('violation') : status('ok');
  const head = `
    <div class="close-row"><p class="kind-line">${rowGlyph('station', statusWord.cls)} CPCB river station ${esc(p.station_no)}</p>
      <button type="button" class="btn-text" data-close>Close</button></div>
    <div class="place-head">
      <h2>${esc(riverPlace(p, true))}</h2>
      <p class="sub">${esc(p.name)}, ${esc(p.state ?? '')}</p>
    </div>
    <p class="reading-line">${lastAt ? `Reading from ${esc(istTime(lastAt))}, ${esc(ago(lastAt))}.` : 'This station has not sent a reading yet.'}</p>
    ${p.is_stale && lastAt ? `<p class="note">No reading since ${esc(istDateTime(lastAt))}. These are its last values, kept on the map as stale rather than dropped.${p.outage ? ` CPCB's station log records "${esc(p.outage.reason)}" since ${esc(p.outage.start.slice(0, 10))}.` : ''}</p>` : ''}
    <p class="here-row"><button type="button" class="btn" data-alerts-here>Get alerts near here</button></p>
    <p class="water-kind">This is river water at this station, not tap water. ${p.violations?.length && !p.is_stale ? `<strong class="status-word danger">${esc(p.violations.map((/** @type {string} */ v) => p.params[v]?.label ?? v).join(', '))} outside the CPCB limit.</strong>` : ''}</p>`;
  root.innerHTML = `${head}<p class="note">Loading the last 48 hours.</p>`;
  let series = [];
  try {
    series = (await getSeries(p.station_no)).series;
  } catch (err) {
    root.innerHTML = `${head}<p class="note">${esc(/** @type {Error} */ (err).message)}</p>`;
    return;
  }
  const byParam = new Map(series.map((/** @type {any} */ s) => [s.parameter, s]));
  const cells = ORDER.filter((k) => byParam.has(k) || p.params[k]).map((k) => {
    const s = byParam.get(k) ?? { parameter: k, label: p.params[k]?.label ?? k, unit: p.params[k]?.unit, points: [], limit: p.params[k]?.limit };
    const latest = p.params[k];
    const st = latest?.status ?? 'no_criteria';
    const atFloor = latest && FLOORS[k] != null && latest.value <= FLOORS[k];
    const word = st === 'violation' ? status('violation') : st === 'ok' ? { word: `Within ${latest.limit_text}`, cls: 'ok' } : { word: 'No official limit', cls: 'none' };
    return `<div class="multiple${st === 'violation' ? ' violation' : ''}">
      <h3>${esc(s.label)}</h3>
      <div><span class="big">${latest ? esc(num(latest.value)) : '–'}</span>${s.unit ? `<span class="unit">${esc(s.unit)}</span>` : ''}</div>
      ${sparkline(s, latest)}
      <span class="status-word ${word.cls}">${esc(st === 'violation' ? `Outside limit (${latest.limit_text})` : word.word)}</span>
      ${atFloor ? '<span class="foot">At the sensor’s lowest reading; may be below detection.</span>' : NOTES[k] ? `<span class="foot">${esc(NOTES[k])}</span>` : ''}
    </div>`;
  }).join('');
  root.innerHTML = `${head}
    <div class="multiples">${cells}</div>
    <p class="note">Shaded bands show CPCB's ${esc(document.body.dataset.criteriaLabel || 'Class C')} limits. Lines break where the station sent nothing for more than two hours. Times are IST.</p>`;
}
