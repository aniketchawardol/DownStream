// @ts-check
import '@fontsource-variable/anek-latin/wdth.css';
import '@fontsource-variable/source-serif-4/index.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

import { getConfig, getStations, getAreas, getHealth, search } from './api.js';
import { state, set, on, findSelected } from './state.js';
import { heroSentence } from './hero.js';
import { initSheet } from './sheet.js';
import { initSubscribe } from './panels/subscribe.js';
import { renderNearby, renderAlerts, renderPlaces, renderLedger, renderJourney, renderSim } from './panels/misc.js';
import { esc, transition, isMobile, reducedMotion } from './format.js';

const $ = (/** @type {string} */ s) => /** @type {HTMLElement} */ (document.querySelector(s));
const els = {
  simBand: $('#sim-band'), notice: $('#notice-band'), layout: $('#layout'), sheet: $('#sheet'), sheetScroll: $('#sheet-scroll'),
  handle: /** @type {HTMLButtonElement} */ ($('#sheet-handle')), below: $('#below'), hero: $('#hero-sentence'), heroNote: $('#hero-note'),
  locate: /** @type {HTMLButtonElement} */ ($('#btn-locate')), alertsBtn: $('#btn-alerts'), locateStatus: $('#locate-status'),
  searchForm: /** @type {HTMLFormElement} */ ($('#place-search')), searchResults: $('#search-results'), selected: $('#selected'),
  nearby: $('#nearby'), subscribe: $('#subscribe'), alerts: $('#alerts-recent'), places: $('#places-body'),
  ledger: $('#ledger-table'), freshness: /** @type {HTMLAnchorElement} */ ($('#freshness')), journey: $('#journey'),
  mapEl: $('#map'), legend: $('#legend'), masthead: $('.masthead'),
};

/** @type {ReturnType<typeof import('./map/map.js').createMap> | null} */
let mapApi = null;
/** @type {ReturnType<typeof initSheet> | null} */
let sheet = null;

/* ---------- Bands, notices, layout mode ---------- */

function updateBandHeight() {
  const h = [els.simBand, els.notice].filter((b) => !b.hidden).reduce((s, b) => s + b.offsetHeight, 0);
  document.documentElement.style.setProperty('--band-h', `${h}px`);
  if (sheet) sheet.snapTo(sheet.current);
  mapApi?.resize();
}

function urlNotices() {
  const q = new URLSearchParams(location.search);
  /** @type {Record<string, string>} */
  const msgs = {
    'subscribed=ok': 'Alerts are on. You’ll get emails about official data within your radius.',
    'subscribed=invalid': 'That confirmation link has expired or was already used. Subscribe again to get a new one.',
    'unsubscribed=ok': 'You’re unsubscribed. No more emails will be sent to that address for this pin.',
    'unsubscribed=invalid': 'That unsubscribe link wasn’t recognised. If emails continue, reply to one and say so.',
  };
  for (const [k, v] of q) {
    const m = msgs[`${k}=${v}`];
    if (!m) continue;
    els.notice.innerHTML = `<span>${esc(m)}</span><button type="button">Dismiss</button>`;
    els.notice.hidden = false;
    els.notice.querySelector('button')?.addEventListener('click', () => { els.notice.hidden = true; updateBandHeight(); });
    q.delete(k);
  }
  const rest = q.toString();
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}`);
}

/** Below-the-fold sections live after the layout on desktop and inside the sheet on phones. */
function placeBelow() {
  if (isMobile()) { if (els.below.parentElement !== els.sheetScroll) els.sheetScroll.append(els.below); }
  else if (els.below.previousElementSibling !== els.layout) els.layout.after(els.below);
}

/* ---------- Hero ---------- */

function renderHero() {
  const s = heroSentence(state.stations, state.areas, state.viewer);
  if (s) els.hero.innerHTML = s.html;
  else if (state.health && !state.stations.length) els.hero.textContent = 'River and tap-water data are still being collected. Check back in a few minutes.';
}

/* ---------- Selection ---------- */

/** @param {'station'|'area'|'sim'} kind @param {string} id @param {{ fly?: boolean, focus?: boolean }} [o] */
async function select(kind, id, o = {}) {
  const f = findSelected({ kind, id });
  if (!f) return;
  set({ selected: { kind, id } });
  mapApi?.select(kind, id);
  const param = kind === 'station' ? 'station' : kind === 'area' ? 'area' : 'sim';
  history.replaceState(null, '', `?${param}=${encodeURIComponent(id)}`);
  const coords = kind === 'sim' ? [f.lng, f.lat] : f.geometry.coordinates;
  if (!mapApi) ensureMap(); // flies to the selection once loaded
  else if (o.fly !== false) mapApi.flyTo(coords[1], coords[0], kind === 'station' ? 9 : 11);
  if (isMobile()) sheet?.snapTo('half');
  const reveal = () => {
    scrollColumnTo(els.selected);
    if (o.focus !== false) els.selected.focus({ preventScroll: true });
  };
  // The panel's first paint (heading and loading line) is synchronous, so it can be revealed straight away.
  const render = () => {
    const done = kind === 'station' ? import('./panels/station.js').then((m) => m.renderStation(els.selected, f))
      : kind === 'area' ? import('./panels/area.js').then((m) => m.renderArea(els.selected, f))
        : renderSim(els.selected, f);
    return done;
  };
  els.selected.innerHTML = '<p class="note">Loading.</p>';
  reveal();
  transition(() => { render(); });
}

/** Scroll the reading column (or the phone sheet) to an element without moving the page itself. @param {HTMLElement} el */
function scrollColumnTo(el) {
  const box = els.sheetScroll;
  const sticky = isMobile() ? 0 : els.masthead.offsetHeight;
  const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - sticky - 8;
  box.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? 'auto' : 'smooth' });
}

function clearSelection() {
  set({ selected: null });
  mapApi?.select(null, null);
  els.selected.innerHTML = '';
  history.replaceState(null, '', location.pathname);
}

els.selected.addEventListener('click', (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.closest('[data-close]')) { clearSelection(); els.sheetScroll.scrollTo({ top: 0 }); els.locate.focus({ preventScroll: true }); return; }
  if (t.closest('[data-alerts-here]') && state.selected) {
    const f = findSelected(state.selected);
    const [lng, lat] = state.selected.kind === 'sim' ? [f.lng, f.lat] : f.geometry.coordinates;
    setPin(lat, lng);
    openSubscribe();
  }
});

/** Open a site_path like "/?station=UK55" from an alert. @param {string} path */
function openPath(path) {
  const q = new URLSearchParams(path.split('?')[1] ?? '');
  if (q.get('station')) select('station', /** @type {string} */ (q.get('station')));
  else if (q.get('area')) select('area', /** @type {string} */ (q.get('area')));
  else if (q.get('sim')) select('sim', /** @type {string} */ (q.get('sim')));
}

/* ---------- Pin, location, search ---------- */

/** @param {number} lat @param {number} lng @param {{ fly?: boolean }} [o] */
function setPin(lat, lng, o = {}) {
  set({ pin: { lat, lng } });
  if (!mapApi) ensureMap();
  mapApi?.setPin(state.pin, state.radius);
  if (o.fly) mapApi?.flyTo(lat, lng, 9.5);
  renderNearby(els.nearby, { lat, lng }, state.radius, (k, id) => select(k, id));
  renderPlaces(els.places, (k, id) => select(k, id));
  renderAlerts(els.alerts, openPath);
}
on('radius', (s) => mapApi?.setPin(s.pin, s.radius));

function openSubscribe() {
  if (isMobile()) sheet?.snapTo('full');
  scrollColumnTo(els.subscribe);
  const target = /** @type {HTMLElement} */ (state.pin ? els.subscribe.querySelector('#email') : els.subscribe.querySelector('#radius'));
  setTimeout(() => target?.focus({ preventScroll: true }), reducedMotion() ? 0 : 400);
}

function showSearch(reason) {
  els.locateStatus.textContent = reason;
  /** @type {HTMLInputElement} */ (els.searchForm.querySelector('input')).focus();
}

els.locate.addEventListener('click', () => {
  if (!('geolocation' in navigator)) { showSearch('This browser can’t share a location. Search for a place instead.'); return; }
  els.locate.disabled = true;
  els.locateStatus.textContent = 'Asking your browser for your location.';
  navigator.geolocation.getCurrentPosition((pos) => {
    els.locate.disabled = false;
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    if (lat < 6 || lat > 37.6 || lng < 68 || lng > 97.5) { showSearch('Your location is outside India. This site covers Indian government data only. Search for a place in India instead.'); return; }
    set({ viewer: { lat, lng } });
    els.locateStatus.textContent = `Using your location (accurate to about ${Math.round(accuracy)} m). It stays in this browser.`;
    setPin(lat, lng, { fly: true });
    renderHero();
  }, (err) => {
    els.locate.disabled = false;
    showSearch(err.code === err.PERMISSION_DENIED
      ? 'Location wasn’t shared. Search for a district, block, panchayat, town or PIN code instead.'
      : 'Your location couldn’t be found. Search for a place instead.');
  }, { enableHighAccuracy: false, timeout: 12_000, maximumAge: 600_000 });
});

els.alertsBtn.addEventListener('click', openSubscribe);

els.searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = /** @type {HTMLInputElement} */ (els.searchForm.querySelector('input')).value.trim();
  if (q.length < 2) return;
  els.searchResults.innerHTML = '<li class="note">Searching.</li>';
  try {
    const { results } = await search(q);
    els.searchResults.innerHTML = results.length
      ? results.map((/** @type {any} */ r, i) => `<li><button type="button" data-i="${i}">${esc(r.name)}<small>${esc(r.detail || r.type)}</small></button></li>`).join('')
      : '<li class="note">Nothing found. Try a district or block name, or click the map.</li>';
    els.searchResults.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const r = results[Number(b.dataset.i)];
      set({ viewer: { lat: r.lat, lng: r.lng } });
      setPin(r.lat, r.lng, { fly: true });
      renderHero();
      if (r.type === 'panchayat') select('area', r.id, { fly: false });
      else if (r.type === 'station') select('station', r.id, { fly: false });
      els.searchResults.innerHTML = '';
      els.locateStatus.textContent = `Showing data near ${r.name}.`;
    }));
  } catch (err) {
    els.searchResults.innerHTML = `<li class="note">${esc(/** @type {Error} */ (err).message)}</li>`;
  }
});

els.searchForm.addEventListener('keydown', (e) => { if (e.key === 'Escape') els.searchResults.innerHTML = ''; });

/* ---------- Map (lazy) ---------- */

/** @type {Promise<void> | null} */
let mapLoading = null;
/** Load the interactive map once; later callers share the same promise. */
function ensureMap() {
  mapLoading ??= loadMap().catch((err) => {
    console.error(err);
    $('#map-fallback').textContent = 'The map couldn’t load. Every place is in the list of places.';
  });
  return mapLoading;
}

async function loadMap() {
  const { createMap } = await import('./map/map.js');
  mapApi = createMap(els.mapEl, {
    onSelect: (kind, id) => select(kind, id, { fly: false, focus: false }),
    onPick: (lat, lng) => {
      setPin(lat, lng);
      if (isMobile()) sheet?.snapTo('half');
    },
  });
  if (isMobile()) mapApi.setBottomPadding(Math.max(0, window.innerHeight - (els.sheet.getBoundingClientRect().top)));
  await mapApi.setData(state.stations, state.areas, state.config);
  if (state.pin) mapApi.setPin(state.pin, state.radius);
  if (state.selected) {
    mapApi.select(state.selected.kind, state.selected.id);
    const f = findSelected(state.selected);
    const [lng, lat] = state.selected.kind === 'sim' ? [f.lng, f.lat] : f.geometry.coordinates;
    mapApi.flyTo(lat, lng, state.selected.kind === 'station' ? 9 : 11);
  }
}

/* ---------- Boot ---------- */

async function boot() {
  urlNotices();
  placeBelow();
  matchMedia('(max-width: 899px)').addEventListener('change', () => { placeBelow(); mapApi?.resize(); });
  sheet = initSheet(els.sheet, els.handle, [els.masthead], (visible) => mapApi?.setBottomPadding(Math.max(0, visible)));
  // The legend's default (open on desktop, closed on phones) lives in CSS; the button only records a choice.
  const legendBtn = /** @type {HTMLButtonElement} */ ($('#legend-btn'));
  const legendOpen = () => (els.legend.dataset.open ? els.legend.dataset.open === 'true' : !isMobile());
  legendBtn.setAttribute('aria-expanded', String(legendOpen()));
  legendBtn.addEventListener('click', () => { const open = !legendOpen(); els.legend.dataset.open = String(open); legendBtn.setAttribute('aria-expanded', String(open)); });
  initSubscribe(/** @type {HTMLFormElement} */ ($('#subscribe-form')));

  const [config, stations, areas, health] = await Promise.allSettled([getConfig(), getStations(), getAreas(), getHealth()]);
  const ok = (/** @type {PromiseSettledResult<any>} */ r) => (r.status === 'fulfilled' ? r.value : null);
  set({
    config: ok(config),
    stations: ok(stations)?.features ?? [],
    areas: ok(areas)?.features ?? [],
    health: ok(health),
  });
  if (state.config?.mock_mode) {
    els.simBand.hidden = false;
    document.documentElement.classList.add('sim');
    // Testing: one click puts the alert pin on the simulation point, where simulated alerts are placed.
    $('#testpoint').hidden = false;
    $('#btn-testpoint').addEventListener('click', () => {
      const m = state.config.mock;
      if (state.radius < m.radius_km) set({ radius: m.radius_km });
      setPin(m.lat, m.lng, { fly: true });
      /** @type {HTMLElement} */ (els.subscribe.querySelector('#email')).focus();
    });
  }
  if (state.config?.criteria_label) {
    document.body.dataset.criteriaLabel = state.config.criteria_label;
    const cl = document.getElementById('criteria-label');
    if (cl) cl.textContent = state.config.criteria_label;
  }
  updateBandHeight();
  if (stations.status === 'rejected') els.heroNote.textContent = 'River data couldn’t be loaded just now. The map still shows tap-water tests.';
  renderHero();
  renderLedger(state.health, els.ledger, els.freshness);
  renderPlaces(els.places, (k, id) => select(k, id));
  renderAlerts(els.alerts, openPath);

  const q = new URLSearchParams(location.search);
  if (q.get('station')) select('station', /** @type {string} */ (q.get('station')), { focus: false });
  else if (q.get('area')) select('area', /** @type {string} */ (q.get('area')), { focus: false });
  else if (q.get('sim')) select('sim', /** @type {string} */ (q.get('sim')), { focus: false });

  // The map comes after the hero has painted. Phones get a schematic first and load the map on intent.
  if (isMobile() && !state.selected) {
    const { renderSchematic } = await import('./map/schematic.js');
    renderSchematic($('#map-fallback'), {
      stations: state.stations, areas: state.areas,
      visibleHeight: els.sheet.getBoundingClientRect().top - els.mapEl.getBoundingClientRect().top,
      onSelect: (kind, id) => select(kind, id),
      onOpen: () => { ensureMap(); },
    });
    $('#map-wrap').addEventListener('pointerdown', () => { ensureMap(); }, { once: true });
  } else {
    const idle = /** @type {any} */ (window).requestIdleCallback ?? ((/** @type {Function} */ fn) => setTimeout(fn, 1));
    idle(() => ensureMap(), { timeout: 600 });
  }

  // Below-the-fold data loads when it comes near the screen.
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { io.disconnect(); renderJourney(els.journey); }
  }, { rootMargin: '400px' });
  io.observe(els.journey);

  // Keep ages honest on a page left open: refresh river data and source status every five minutes.
  setInterval(async () => {
    try {
      const [s, h] = await Promise.all([getStations(), getHealth()]);
      set({ stations: s.features, health: h });
      renderHero();
      renderLedger(h, els.ledger, els.freshness);
      await mapApi?.setData(state.stations, [], null, { animate: false });
      if (state.selected) mapApi?.select(state.selected.kind, state.selected.id);
    } catch { /* keep showing the last good data */ }
  }, 5 * 60_000);
}

window.addEventListener('resize', updateBandHeight);
boot();
