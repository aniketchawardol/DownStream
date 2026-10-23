// @ts-check
// Smaller panels: simulated subjects, nearby, recent alerts, places list, freshness ledger, journey.
import { getAlerts, getNearby, getLags, getDaily } from '../api.js';
import { esc, ago, km, status, riverPlace, istDateTime, istDate, istTime, ageWords, num, distanceKm, reducedMotion, isMobile } from '../format.js';
import { rowGlyph } from '../map/markers.js';
import { state } from '../state.js';

/* ---------- Simulated subject ---------- */

/** @param {HTMLElement} root @param {any} subject */
export async function renderSim(root, subject) {
  root.innerHTML = `
    <div class="close-row"><p class="kind-line">${rowGlyph('sim', 'none')} <span class="tag-sim">Simulated</span></p>
      <button type="button" class="btn-text" data-close>Close</button></div>
    <div class="place-head"><h2>${esc(subject.name)}</h2><p class="sub">Invented for testing. Not a real place.</p></div>
    <p class="here-row"><button type="button" class="btn" data-alerts-here>Get alerts near here</button></p>
    <p class="water-kind">Simulation mode places invented stations and panchayats a few kilometres from a test point and raises random alerts for them, so the alert emails can be tried without waiting for real contamination. Nothing here describes real water.</p>
    <h3>Simulated alerts here</h3><ol class="near-list" id="sim-alerts"><li class="note">Loading.</li></ol>`;
  try {
    const q = new URLSearchParams({ include_mock: 'true', lat: String(subject.lat), lng: String(subject.lng), radius_km: '1', days: '7', limit: '10' });
    const { alerts } = await getAlerts(q);
    const list = /** @type {HTMLElement} */ (root.querySelector('#sim-alerts'));
    const mine = alerts.filter((/** @type {any} */ a) => a.is_mock);
    list.innerHTML = mine.length
      ? mine.map((/** @type {any} */ a) => `<li class="place-row" style="cursor:default"><span class="name" style="grid-column:1/4">${esc(a.title)}</span><span class="meta">${esc(ago(a.created_at))}</span></li>`).join('')
      : '<li class="note">None in the last week. A new one is invented every few minutes.</li>';
  } catch { /* the heading is enough */ }
}

/* ---------- Nearby ---------- */

/** @param {HTMLElement} section @param {{ lat: number, lng: number }} pin @param {number} radius @param {(kind: any, id: string) => void} onSelect */
export async function renderNearby(section, pin, radius, onSelect) {
  const body = /** @type {HTMLElement} */ (section.querySelector('#nearby-body'));
  section.hidden = false;
  body.innerHTML = '<p class="note">Finding the nearest stations and tested panchayats.</p>';
  let d;
  try { d = await getNearby(pin.lat, pin.lng, radius); } catch (err) {
    body.innerHTML = `<p class="note">${esc(/** @type {Error} */ (err).message)}</p>`;
    return;
  }
  const st = d.stations.map((/** @type {any} */ s) => {
    const f = state.stations.find((x) => x.properties.station_no === s.station_no);
    const cls = f ? status(f.properties.is_stale ? 'stale' : f.properties.status === 'violation' ? 'violation' : 'ok').cls : 'none';
    return `<li><button type="button" class="place-row" data-kind="station" data-id="${esc(s.station_no)}">${rowGlyph('station', cls)}
      <span class="name">${esc(riverPlace(s, true))}</span><span class="dist">${esc(km(s.distance_km))}</span>
      <span class="meta">River water. ${s.last_reading_at ? `Measured ${esc(ago(s.last_reading_at))}` : 'No readings yet'}.</span></button></li>`;
  }).join('');
  const ar = d.areas.map((/** @type {any} */ a) => `<li><button type="button" class="place-row" data-kind="area" data-id="${esc(a.id)}">${rowGlyph('area', status(a.worst_status).cls)}
      <span class="name">${esc(a.name)}</span><span class="dist">${esc(km(a.distance_km))}</span>
      <span class="meta">Tap water. Last lab test ${a.last_tested_at ? esc(ago(a.last_tested_at)) : 'unknown'}: ${esc(status(a.worst_status).word.toLowerCase())}.${a.approximate ? ' Location approximate.' : ''}</span></button></li>`).join('');
  const farStations = d.stations.length && !d.stations[0].within_radius;
  body.innerHTML = `
    <p class="near-group">Tested panchayats</p>
    ${ar ? `<ul class="near-list">${ar}</ul>` : '<p class="note">No tested panchayats with known locations yet. This site currently covers Bagalkote district in Karnataka.</p>'}
    <p class="near-group">River stations${farStations ? ' (none within your radius; nearest shown)' : ''}</p>
    <ul class="near-list">${st}</ul>`;
  body.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => onSelect(/** @type {HTMLElement} */ (b).dataset.kind, /** @type {string} */ (/** @type {HTMLElement} */ (b).dataset.id))));
}

/* ---------- Recent alerts ---------- */

/** @param {HTMLElement} section @param {(path: string) => void} openPath */
export async function renderAlerts(section, openPath) {
  const list = /** @type {HTMLElement} */ (section.querySelector('#alerts-list'));
  const q = new URLSearchParams({ include_mock: String(!!state.config?.mock_mode), days: '7', limit: '8' });
  const pin = state.pin ?? state.viewer;
  if (pin) { q.set('lat', String(pin.lat)); q.set('lng', String(pin.lng)); q.set('radius_km', '100'); }
  try {
    const { alerts } = await getAlerts(q);
    section.hidden = !alerts.length;
    list.innerHTML = alerts.map((/** @type {any} */ a) => `<li>${a.is_mock ? '<span class="tag-sim">Simulated</span>' : ''}<a href="${esc(a.body?.site_path ?? '/')}" data-path="${esc(a.body?.site_path ?? '/')}">${esc(a.title)}</a>
      <span class="when">${esc(a.severity === 'urgent' ? 'Urgent' : a.severity === 'notice' ? 'Notice' : 'For information')}, ${esc(ago(a.created_at))}${a.distance_km != null ? `, ${esc(km(a.distance_km))} from your pin` : ''}</span></li>`).join('');
    list.querySelectorAll('[data-path]').forEach((l) => l.addEventListener('click', (e) => { e.preventDefault(); openPath(/** @type {string} */ (/** @type {HTMLElement} */ (l).dataset.path)); }));
  } catch { section.hidden = true; }
}

/* ---------- Places list: the keyboard mirror of the map ---------- */

/** @param {HTMLElement} body @param {(kind: any, id: string) => void} onSelect */
export function renderPlaces(body, onSelect) {
  const ref = state.pin ?? state.viewer;
  const dist = (/** @type {number[]} */ c) => (ref ? distanceKm(ref.lat, ref.lng, c[1], c[0]) : null);
  const stations = state.stations.map((f) => ({ f, d: dist(f.geometry.coordinates) }))
    .sort((a, b) => (a.d != null && b.d != null ? a.d - b.d : riverPlace(a.f.properties).localeCompare(riverPlace(b.f.properties))));
  const areas = state.areas.map((f) => ({ f, d: dist(f.geometry.coordinates) }))
    .sort((a, b) => (a.d != null && b.d != null ? a.d - b.d : a.f.properties.name.localeCompare(b.f.properties.name)));
  const stationRow = ({ f, d }) => {
    const p = f.properties;
    const s = status(p.is_stale ? 'stale' : p.status === 'violation' ? 'violation' : 'ok');
    return `<li><button type="button" class="place-row" data-kind="station" data-id="${esc(p.station_no)}">${rowGlyph('station', s.cls)}
      <span class="name">${esc(riverPlace(p, true))}</span><span class="dist">${d != null ? esc(km(d)) : ''}</span>
      <span class="meta"><span class="status-word ${s.cls}">${esc(s.word)}</span>. ${p.last_reading_at ? `Measured ${esc(ago(p.last_reading_at))}` : 'No readings'}.</span></button></li>`;
  };
  const areaRow = ({ f, d }) => {
    const p = f.properties;
    const s = status(p.status === 'never' ? 'never' : p.status === 'stale' ? 'stale' : p.latest_round_status);
    return `<li data-name="${esc(p.name.toLowerCase())} ${esc(p.block.toLowerCase())}"><button type="button" class="place-row" data-kind="area" data-id="${esc(p.id)}">${rowGlyph('area', s.cls)}
      <span class="name">${esc(p.name)}</span><span class="dist">${d != null ? esc(km(d)) : ''}</span>
      <span class="meta"><span class="status-word ${s.cls}">${esc(s.word)}</span>. ${p.last_tested_at ? `Last lab test ${esc(ago(p.last_tested_at))}` : 'No lab test found'}. ${esc(p.block)} block.</span></button></li>`;
  };
  const sims = state.config?.mock_mode ? [...state.config.mock.subjects.stations, ...state.config.mock.subjects.gps] : [];
  const districts = [...new Set(state.areas.map((f) => f.properties.district))].join(', ');
  body.innerHTML = `
    <details open><summary>River stations (${stations.length})</summary><ul>${stations.map(stationRow).join('')}</ul></details>
    <details${ref ? ' open' : ''}><summary>Panchayats${districts ? ` in ${esc(districts)}` : ''} (${areas.length})</summary>
      <div class="filter"><label class="sr-only" for="area-filter">Filter panchayats by name or block</label>
      <input type="search" id="area-filter" placeholder="Filter by panchayat or block" autocomplete="off"/></div>
      <ul id="area-list">${areas.length ? areas.map(areaRow).join('') : '<li class="note">Panchayats appear here once their locations are known.</li>'}</ul></details>
    ${sims.length ? `<details><summary>Simulated places (${sims.length})</summary><ul>${sims.map((s) => `<li><button type="button" class="place-row" data-kind="sim" data-id="${esc(s.id)}">${rowGlyph('sim', 'none')}<span class="name">${esc(s.name)}</span><span class="dist"></span><span class="meta">Invented for testing.</span></button></li>`).join('')}</ul></details>` : ''}`;
  body.querySelectorAll('button[data-kind]').forEach((b) => b.addEventListener('click', () => onSelect(/** @type {HTMLElement} */ (b).dataset.kind, /** @type {string} */ (/** @type {HTMLElement} */ (b).dataset.id))));
  const filter = /** @type {HTMLInputElement|null} */ (body.querySelector('#area-filter'));
  filter?.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    body.querySelectorAll('#area-list li[data-name]').forEach((li) => { /** @type {HTMLElement} */ (li).hidden = !!q && !(/** @type {HTMLElement} */ (li).dataset.name ?? '').includes(q); });
  });
}

/* ---------- Freshness ledger + header pill ---------- */

const SOURCES = /** @type {Record<string, string>} */ ({
  cpcb: 'CPCB river stations (every 15 minutes)',
  'wqmis-samples': 'WQMIS sample lists (daily)',
  'wqmis-reports': 'WQMIS lab reports (hourly while a backlog exists)',
  'wqmis-hierarchy': 'WQMIS districts, blocks and panchayats (weekly)',
  'wqmis-dashboard': 'WQMIS national dashboard (daily)',
  geocode: 'Panchayat locations from OpenStreetMap',
  overdue: 'Overdue-testing check (daily)',
});

/** @param {any} health @param {HTMLElement} table @param {HTMLAnchorElement} pill */
export function renderLedger(health, table, pill) {
  const tbody = /** @type {HTMLElement} */ (table.querySelector('tbody'));
  const rows = (health?.sources ?? []).filter((/** @type {any} */ s) => SOURCES[s.source]);
  rows.sort((/** @type {any} */ a, /** @type {any} */ b) => Object.keys(SOURCES).indexOf(a.source) - Object.keys(SOURCES).indexOf(b.source));
  tbody.innerHTML = rows.length ? rows.map((/** @type {any} */ s) => {
    const failing = s.last_error && (!s.last_success_at || new Date(s.last_attempt_at) > new Date(s.last_success_at));
    const state = s.circuit_open ? `<span class="state-paused">Paused until ${esc(istTime(s.circuit_open_until))} after repeated failures</span>`
      : failing ? `<span class="state-bad">Last attempt failed</span><small>${esc(String(s.last_error).slice(0, 140))}</small>`
        : s.last_success_at ? '<span class="state-ok">Working</span>' : '<span class="state-paused">Not run yet</span>';
    return `<tr><td>${esc(SOURCES[s.source])}</td>
      <td>${s.last_success_at ? `${esc(istDateTime(s.last_success_at))}<small>${esc(ago(s.last_success_at))}</small>` : 'Never'}</td>
      <td>${s.newest_data_at ? `${esc(istDateTime(s.newest_data_at))}<small>${esc(ago(s.newest_data_at))}</small>` : '–'}</td>
      <td class="num">${s.records_last_run != null ? esc(num(s.records_last_run, 0)) : '–'}</td>
      <td>${state}</td></tr>`;
  }).join('') : `<tr><td colspan="5">${health?.db === 'down' ? 'The database is unreachable, so source status is unknown.' : 'No source has run yet.'}</td></tr>`;

  const cpcb = (health?.sources ?? []).find((/** @type {any} */ s) => s.source === 'cpcb');
  if (!cpcb?.newest_data_at) { pill.textContent = 'Waiting for the first river data'; pill.dataset.state = 'degraded'; return; }
  const failing = cpcb.last_error && new Date(cpcb.last_attempt_at) > new Date(cpcb.last_success_at ?? 0);
  if (failing || cpcb.circuit_open) {
    pill.textContent = `River data couldn’t be refreshed (CPCB didn’t respond). Showing readings from ${istTime(cpcb.newest_data_at)}.`;
    pill.dataset.state = 'down';
  } else {
    pill.textContent = `River data from ${istTime(cpcb.newest_data_at)}`;
    pill.dataset.state = Date.now() - new Date(cpcb.newest_data_at).getTime() > 3 * 3600_000 ? 'degraded' : 'ok';
  }
}

/* ---------- "How a tap sample becomes public" ---------- */

/** @param {number|null} h hours */
const hours = (h) => (h == null || !Number.isFinite(h) ? null : ageWords(h * 3600_000));

/** @param {HTMLElement} section */
export async function renderJourney(section) {
  const [lags, daily] = await Promise.all([getLags().catch(() => null), getDaily().catch(() => null)]);
  const set = (/** @type {string} */ key, /** @type {string|null} */ text) => {
    const el = /** @type {HTMLElement|null} */ (section.querySelector(`[data-lag="${key}"]`));
    if (el) el.textContent = text ?? '';
  };
  if (lags?.samples) {
    set('collected_to_received', hours(lags.collected_to_received) && `Median ${hours(lags.collected_to_received)} from collection to the lab.`);
    set('received_to_analysed', hours(lags.received_to_analysed) && `Median ${hours(lags.received_to_analysed)} from arrival to analysis.`);
    set('analysed_to_reported', hours(lags.analysed_to_reported) && `Median ${hours(lags.analysed_to_reported)} from analysis to the report.`);
    set('reported_to_first_seen', lags.reported_to_first_seen != null
      ? `Median ${hours(lags.reported_to_first_seen)} from the report to this site.`
      : 'This site started recently, so it can’t yet say how quickly new reports appear.');
    set('collected_to_first_seen', `Based on ${num(lags.samples, 0)} lab reports read so far, collected between ${istDate(lags.earliest)} and ${istDate(lags.latest)}.`);
  } else {
    set('collected_to_first_seen', 'Median times appear once this site has read some lab reports.');
  }
  const nat = daily?.snapshots?.find((/** @type {any} */ s) => s.scope === 'national');
  const natEl = /** @type {HTMLElement} */ (section.querySelector('#national'));
  if (nat?.payload?.total_tested_yesterday != null) {
    natEl.textContent = `The Jal Jeevan Mission dashboard read on ${istDate(nat.date)} said labs across India tested ${num(nat.payload.total_tested_yesterday, 0)} samples the day before, and ${num(nat.payload.contaminated_yesterday, 0)} were found contaminated. Those national figures change every day; this site keeps one copy a day.`;
  }
  stepThrough(section);
}

/** Pin the sequence and light each step as the reader scrolls (desktop, motion allowed). @param {HTMLElement} section */
async function stepThrough(section) {
  const items = [...section.querySelectorAll('.steps li')];
  if (reducedMotion() || isMobile()) { items.forEach((li) => li.classList.add('static')); return; }
  const { gsap } = await import('gsap');
  const { ScrollTrigger } = await import('gsap/ScrollTrigger');
  gsap.registerPlugin(ScrollTrigger);
  section.classList.add('pinned');
  ScrollTrigger.create({
    trigger: section,
    start: 'top top',
    end: () => `+=${items.length * 220}`,
    pin: true,
    onUpdate: (st) => {
      const n = Math.min(items.length, Math.floor(st.progress * items.length + 0.35) + 1);
      items.forEach((li, i) => li.classList.toggle('on', i < n));
    },
    onLeave: () => items.forEach((li) => li.classList.add('on')),
  });
}
