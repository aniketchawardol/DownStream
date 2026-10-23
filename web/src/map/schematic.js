// @ts-check
// Phones get this lightweight schematic first: the same rings and squares, placed by latitude and longitude
// on a plain grid, with a few cities for orientation. The interactive map (1 MB of WebGL) loads the moment
// the reader touches the map, picks a place, or sets a pin. Labelled as a schematic, not a map.
import { riverFresh, status, esc } from '../format.js';

const CITIES = [
  ['Delhi', 28.61, 77.21], ['Lucknow', 26.85, 80.95], ['Patna', 25.59, 85.14], ['Kolkata', 22.57, 88.36],
  ['Varanasi', 25.32, 82.97], ['Mumbai', 19.08, 72.88], ['Hyderabad', 17.39, 78.49], ['Bhopal', 23.26, 77.41],
];

/**
 * @param {HTMLElement} host the map fallback element
 * @param {{ stations: any[], areas: any[], visibleHeight: number, onSelect: (kind: 'station', id: string) => void, onOpen: () => void }} o
 */
export function renderSchematic(host, o) {
  const W = host.clientWidth;
  const H = Math.max(220, o.visibleHeight);
  const pts = [...o.stations, ...o.areas].map((f) => f.geometry.coordinates);
  if (!pts.length || !W) return;
  const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  const [w, e, s, n] = [Math.min(...lngs) - 0.6, Math.max(...lngs) + 0.6, Math.min(...lats) - 0.6, Math.max(...lats) + 0.6];
  const kx = Math.cos(((s + n) / 2) * Math.PI / 180);
  const pad = 28;
  const scale = Math.min((W - 2 * pad) / ((e - w) * kx), (H - 2 * pad - 56) / (n - s));
  const offX = (W - (e - w) * kx * scale) / 2;
  const offY = pad;
  const x = (/** @type {number} */ lng) => offX + (lng - w) * kx * scale;
  const y = (/** @type {number} */ lat) => offY + (n - lat) * scale;

  const cities = CITIES.filter(([, la, lo]) => la >= s && la <= n && lo >= w && lo <= e)
    .map(([name, la, lo]) => `<circle class="sch-city-dot" cx="${x(+lo)}" cy="${y(+la)}" r="2"/><text class="sch-city" x="${x(+lo) + 5}" y="${y(+la) + 4}">${name}</text>`).join('');
  const ganga = o.stations.filter((f) => f.properties.river === 'Ganga').sort((a, b) => a.geometry.coordinates[0] - b.geometry.coordinates[0]);
  const river = ganga.length > 1 ? `<polyline class="sch-river" points="${ganga.map((f) => `${x(f.geometry.coordinates[0])},${y(f.geometry.coordinates[1])}`).join(' ')}"/>` : '';

  const stations = o.stations.map((f) => {
    const p = f.properties;
    const cls = status(p.is_stale ? 'stale' : p.status === 'violation' ? 'violation' : 'ok').cls;
    const fresh = p.is_stale ? 0 : riverFresh(p.age_minutes);
    const cx = x(f.geometry.coordinates[0]), cy = y(f.geometry.coordinates[1]);
    const delay = Math.round((Math.hypot(cx - W / 2, cy - H / 2) / Math.hypot(W / 2, H / 2)) * 300); // staggered by distance from the centre
    return `<g class="sch-station sch-hit" data-id="${esc(p.station_no)}" style="--d:${delay}ms">
      <circle class="track" cx="${cx}" cy="${cy}" r="8"/>
      <circle class="sch-ring${p.is_stale ? ' stale' : ''}" cx="${cx}" cy="${cy}" r="8" pathLength="100" transform="rotate(-90 ${cx} ${cy})" stroke-dasharray="${p.is_stale ? '' : `${(fresh * 100).toFixed(1)} 100`}"/>
      <circle class="sch-fill ${cls}" cx="${cx}" cy="${cy}" r="4.5"/></g>`;
  }).join('');

  /** @type {Map<string, any[]>} */
  const byDistrict = new Map();
  for (const f of o.areas) { const k = f.properties.district; if (!byDistrict.has(k)) byDistrict.set(k, []); /** @type {any[]} */ (byDistrict.get(k)).push(f); }
  const districts = [...byDistrict].map(([name, fs]) => {
    const cx = x(fs.reduce((a, f) => a + f.geometry.coordinates[0], 0) / fs.length);
    const cy = y(fs.reduce((a, f) => a + f.geometry.coordinates[1], 0) / fs.length);
    return `<g class="sch-district sch-hit" data-district="${esc(name)}"><rect class="outline" x="${cx - 17}" y="${cy - 17}" width="34" height="34" rx="8"/>
      <text x="${cx}" y="${cy + 4}" text-anchor="middle">${fs.length}</text><text class="sch-label" x="${cx + 22}" y="${cy + 4}">${esc(name)} panchayats</text></g>`;
  }).join('');

  host.innerHTML = `<div class="schematic rings-pending"><svg viewBox="0 0 ${W} ${host.clientHeight}" role="img" aria-label="Schematic of river stations and tested panchayats. Open the interactive map for detail.">
    ${cities}${river}${districts}${stations}
    <text class="sch-note" x="${pad / 2}" y="${H - 64}">Schematic, not to scale. Each ring shows how fresh a station's data is.</text>
  </svg></div>
  <button type="button" class="btn btn-primary sch-open" style="top:${H - 52}px">Open the interactive map</button>`;
  const sch = /** @type {HTMLElement} */ (host.querySelector('.schematic'));
  requestAnimationFrame(() => requestAnimationFrame(() => sch.classList.remove('rings-pending')));
  host.querySelector('.sch-open')?.addEventListener('click', o.onOpen);
  host.querySelectorAll('.sch-station').forEach((g) => g.addEventListener('click', () => o.onSelect('station', /** @type {string} */ (/** @type {HTMLElement} */ (g).dataset.id))));
  host.querySelectorAll('.sch-district').forEach((g) => g.addEventListener('click', o.onOpen));
}
