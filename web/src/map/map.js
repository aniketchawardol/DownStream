// @ts-check
// MapLibre map with DOM (SVG) markers. Loaded lazily after the hero has painted.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre finds its worker next to its own module, which breaks once bundled; point it at the copied asset.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { riverMarker, tapMarker, districtMarker, simMarker, pinMarker, mockPointMarker } from './markers.js';
import { isDark, isMobile, reducedMotion } from '../format.js';

maplibregl.setWorkerUrl(workerUrl);

const DETAIL_ZOOM = 8;
const INDIA = /** @type {[[number, number], [number, number]]} */ ([[72.5, 11.5], [90.5, 31.5]]);

/** Circle polygon for the alert radius (64 vertices). @param {number} lat @param {number} lng @param {number} km */
function circle(lat, lng, km) {
  const coords = [];
  const R = 6371.0088;
  const r = Math.PI / 180;
  for (let i = 0; i <= 64; i++) {
    const b = (i / 64) * 2 * Math.PI;
    const d = km / R;
    const la = Math.asin(Math.sin(lat * r) * Math.cos(d) + Math.cos(lat * r) * Math.sin(d) * Math.cos(b));
    const lo = lng * r + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat * r), Math.cos(d) - Math.sin(lat * r) * Math.sin(la));
    coords.push([lo / r, la / r]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } };
}

/**
 * @param {HTMLElement} container
 * @param {{ onSelect: (kind: 'station'|'area'|'sim', id: string) => void, onPick: (lat: number, lng: number) => void }} handlers
 */
export function createMap(container, handlers) {
  const styleUrl = () => (isDark() ? '/map-style-dark.json' : '/map-style-light.json');
  const map = new maplibregl.Map({
    container,
    style: styleUrl(),
    bounds: INDIA,
    fitBoundsOptions: { padding: 24 },
    minZoom: 3.5,
    maxZoom: 15,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    cooperativeGestures: true, // the map never hijacks page or sheet scrolling
    attributionControl: { compact: false },
    fadeDuration: 0,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  /** @type {Map<string, { marker: maplibregl.Marker, el: HTMLElement, lngLat: [number, number] }>} */
  const markers = new Map();
  /** @type {maplibregl.Marker|null} */ let pin = null;
  /** @type {any} */ let radiusFeature = null;
  let animatedHigh = false;

  const updateDetail = () => {
    container.dataset.detail = map.getZoom() >= DETAIL_ZOOM ? 'high' : 'low';
    container.dataset.labels = map.getZoom() >= 11 ? 'on' : 'off';
    container.dataset.far = map.getZoom() < 5.6 ? 'yes' : 'no';
    maybeAnimateHigh();
  };
  map.on('zoom', updateDetail);

  const addRadiusLayers = () => {
    if (map.getSource('radius')) return;
    map.addSource('radius', { type: 'geojson', data: radiusFeature ?? { type: 'FeatureCollection', features: [] } });
    const survey = getComputedStyle(document.documentElement).getPropertyValue('--survey').trim() || '#1E5E8A';
    map.addLayer({ id: 'radius-fill', type: 'fill', source: 'radius', paint: { 'fill-color': survey, 'fill-opacity': 0.08 } });
    map.addLayer({ id: 'radius-line', type: 'line', source: 'radius', paint: { 'line-color': survey, 'line-width': 1.5, 'line-dasharray': [3, 2] } });
  };
  map.on('style.load', addRadiusLayers);

  // Theme follows the system: swap the recoloured style; DOM markers survive, layers are re-added.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => map.setStyle(styleUrl()));

  map.on('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.originalEvent.target);
    if (t.closest('.mk')) return;
    handlers.onPick(e.lngLat.lat, e.lngLat.lng);
  });

  /** @param {string} key @param {HTMLElement} el @param {[number, number]} lngLat */
  function add(key, el, lngLat) {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const kind = /** @type {any} */ (el.dataset.kind);
      if (kind === 'district') { map.flyTo({ center: lngLat, zoom: DETAIL_ZOOM + 0.6, essential: true }); return; }
      handlers.onSelect(kind, /** @type {string} */ (el.dataset.id));
    });
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(lngLat).addTo(map);
    markers.get(key)?.marker.remove();
    markers.set(key, { marker, el, lngLat });
  }

  // Rings start empty (a pending class holds them at 0) and draw to their value once, as a CSS transition:
  // 600 ms each, delayed 0–300 ms by distance from the map centre. No per-frame JavaScript.
  if (!reducedMotion()) container.classList.add('rings-pending', 'taps-pending');

  /** @param {HTMLElement[]} els @param {'rings-pending'|'taps-pending'} pending */
  function drawRings(els, pending) {
    const c = map.project(map.getCenter());
    const byEl = new Map([...markers.values()].map((m) => [m.el, m]));
    const items = els.map((el) => { const m = byEl.get(el); const p = m ? map.project(m.lngLat) : c; return { el, d: Math.hypot(p.x - c.x, p.y - c.y) }; });
    const maxD = Math.max(1, ...items.map((i) => i.d));
    for (const { el, d } of items) el.style.setProperty('--d', `${Math.round((d / maxD) * 300)}ms`);
    // Two frames: the markers must be laid out at 0 before the class goes, or there is nothing to transition from.
    requestAnimationFrame(() => requestAnimationFrame(() => container.classList.remove(pending)));
  }
  function maybeAnimateHigh() {
    if (animatedHigh || map.getZoom() < DETAIL_ZOOM) return;
    animatedHigh = true;
    drawRings([...markers.values()].filter((m) => m.el.classList.contains('mk-tap')).map((m) => m.el), 'taps-pending');
  }

  const ready = new Promise((resolve) => map.once('load', resolve));

  return {
    map,
    ready,
    /** @param {any[]} stations @param {any[]} areas @param {any} config @param {{ animate?: boolean }} [opts] */
    async setData(stations, areas, config, opts = {}) {
      for (const f of stations) add(`station:${f.properties.station_no}`, riverMarker(f.properties), f.geometry.coordinates);
      for (const f of areas) add(`area:${f.properties.id}`, tapMarker(f.properties), f.geometry.coordinates);
      // One neutral marker per district while zoomed out (196 panchayats sit within ~120 km).
      /** @type {Map<string, any[]>} */
      const byDistrict = new Map();
      for (const f of areas) { const k = f.properties.district; if (!byDistrict.has(k)) byDistrict.set(k, []); /** @type {any[]} */ (byDistrict.get(k)).push(f); }
      for (const [name, fs] of byDistrict) {
        const lng = fs.reduce((s, f) => s + f.geometry.coordinates[0], 0) / fs.length;
        const lat = fs.reduce((s, f) => s + f.geometry.coordinates[1], 0) / fs.length;
        const newest = Math.min(...fs.map((f) => f.properties.chemical_age_days ?? 9999));
        add(`district:${name}`, districtMarker(name, fs.length, Math.max(0, Math.min(1, 1 - (newest - 30) / 335))), [lng, lat]);
      }
      if (config?.mock_mode && config.mock) {
        add('mock:point', mockPointMarker(), [config.mock.lng, config.mock.lat]);
        for (const s of config.mock.subjects.stations) add(`sim:${s.id}`, simMarker(s, 'station'), [s.lng, s.lat]);
        for (const s of config.mock.subjects.gps) add(`sim:${s.id}`, simMarker(s, 'gp'), [s.lng, s.lat]);
      }
      updateDetail();
      await ready;
      if (opts.animate !== false && stations.length) {
        const pts = [...stations, ...areas].map((f) => f.geometry.coordinates);
        const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
        map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: isMobile() ? 24 : { top: 60, bottom: 60, left: 50, right: 70 }, duration: 0, maxZoom: 6 } /* camera padding for the phone sheet is added by MapLibre */);
        updateDetail();
      }
      container.closest('.map-wrap')?.classList.add('map-ready');
      if (opts.animate === false) return;
      drawRings([...markers.values()].filter((m) => !m.el.classList.contains('mk-tap')).map((m) => m.el), 'rings-pending');
      maybeAnimateHigh();
    },
    /** @param {'station'|'area'|'sim'|null} kind @param {string|null} id */
    select(kind, id) {
      for (const m of markers.values()) m.el.classList.remove('selected');
      if (!kind || !id) return;
      markers.get(`${kind}:${id}`)?.el.classList.add('selected');
    },
    /** @param {number} lat @param {number} lng @param {number} [zoom] */
    flyTo(lat, lng, zoom) {
      map.flyTo({ center: [lng, lat], zoom: zoom ?? Math.max(map.getZoom(), 9), essential: true, duration: reducedMotion() ? 0 : 1200 });
    },
    /** @param {{ lat: number, lng: number } | null} p @param {number} radiusKm */
    setPin(p, radiusKm) {
      if (!p) { pin?.remove(); pin = null; radiusFeature = null; /** @type {any} */ (map.getSource('radius'))?.setData({ type: 'FeatureCollection', features: [] }); return; }
      if (!pin) pin = new maplibregl.Marker({ element: pinMarker(), anchor: 'center' }).setLngLat([p.lng, p.lat]).addTo(map);
      else pin.setLngLat([p.lng, p.lat]);
      radiusFeature = circle(p.lat, p.lng, radiusKm);
      /** @type {any} */ (map.getSource('radius'))?.setData(radiusFeature);
    },
    /** Keep the visible map centred above the mobile sheet. @param {number} bottom */
    setBottomPadding(bottom) { map.setPadding({ top: 0, left: 0, right: 0, bottom }); },
    resize() { map.resize(); },
    isMobile,
  };
}
