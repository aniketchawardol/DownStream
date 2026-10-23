// @ts-check
// Fetch OpenFreeMap's Positron style and recolour it to the site palette (light and "night survey").
// Writes web/public/map-style-light.json and map-style-dark.json. The generated files are committed, so
// builds work offline; if the fetch fails the existing files are kept.
//   node web/scripts/build-style.mjs            (MAP_STYLE_URL overrides the source style)
import fs from 'node:fs/promises';

const SRC = process.env.MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/positron';
const OUT = new URL('../public/', import.meta.url);

const THEMES = {
  light: {
    background: '#E7ECEA', park: '#DFE6E2', wood: '#DAE2DE', residential: '#E0E6E3', building: '#D9E0DD', ice: '#F1F4F3',
    water: '#BFD0D7', waterway: '#1E5E8A', road: '34,42,45', label: '#222A2D', labelSoft: '#4A5458', halo: '#E7ECEA', waterLabel: '#1E5E8A',
  },
  dark: {
    background: '#182022', park: '#1B2427', wood: '#1C2629', residential: '#1D2629', building: '#222C2F', ice: '#202A2D',
    water: '#2C3D47', waterway: '#7DB3D9', road: '220,227,224', label: '#DCE3E0', labelSoft: '#AEB8B4', halo: '#182022', waterLabel: '#7DB3D9',
  },
};

const HIDE = new Set([
  'airport', 'highway-shield-non-us', 'highway-shield-us-interstate', 'road_shield_us', 'highway-name-path',
  'railway_transit_dashline', 'railway_service_dashline', 'railway_dashline', 'aeroway-taxiway', 'aeroway-runway-casing',
  'aeroway-area', 'aeroway-runway', 'tunnel_motorway_casing', 'highway_major_casing', 'highway_motorway_casing',
  'highway_motorway_bridge_casing', 'road_area_pier', 'road_pier',
  // International and disputed boundary lines are not drawn (see docs/DESIGN.md); state lines stay.
  'boundary_2', 'boundary_disputed',
]);

/** @param {any} style @param {typeof THEMES.light} t */
function recolour(style, t) {
  const s = structuredClone(style);
  s.name = `DownStream ${t === THEMES.dark ? 'night survey' : 'survey'} (from OpenFreeMap Positron)`;
  const road = (/** @type {number} */ a) => `rgba(${t.road},${a})`;
  s.layers = s.layers.filter((/** @type {any} */ l) => !HIDE.has(l.id)).map((/** @type {any} */ l) => {
    const p = (l.paint ??= {});
    const id = l.id;
    if (id === 'background') p['background-color'] = t.background;
    else if (id === 'park') p['fill-color'] = t.park;
    else if (id === 'water') { p['fill-color'] = t.water; delete p['fill-opacity']; }
    else if (id.startsWith('landcover_ice') || id.startsWith('landcover_glacier')) p['fill-color'] = t.ice;
    else if (id === 'landuse_residential') p['fill-color'] = t.residential;
    else if (id === 'landcover_wood') p['fill-color'] = t.wood;
    else if (id === 'building') { p['fill-color'] = t.building; delete p['fill-outline-color']; }
    else if (id === 'waterway') {
      p['line-color'] = t.waterway;
      p['line-opacity'] = 0.7;
      // Major rivers heavier than streams and canals.
      p['line-width'] = ['interpolate', ['linear'], ['zoom'],
        4, ['match', ['get', 'class'], 'river', 0.9, 0.3],
        8, ['match', ['get', 'class'], 'river', 1.6, 0.6],
        12, ['match', ['get', 'class'], 'river', 3, 1.1],
        16, ['match', ['get', 'class'], 'river', 6, 2]];
    } else if (id === 'highway_path' || id === 'highway_minor') p['line-color'] = road(0.12);
    else if (id === 'highway_major_inner' || id === 'highway_major_subtle') p['line-color'] = road(0.16);
    else if (id.startsWith('highway_motorway') || id === 'tunnel_motorway_inner') p['line-color'] = road(0.18);
    else if (id.startsWith('railway')) p['line-color'] = road(0.18);
    else if (id === 'boundary_3') { p['line-color'] = road(0.28); p['line-dasharray'] = [3, 2]; }
    else if (l.type === 'symbol') {
      const isWater = id.startsWith('water') || id === 'waterway_line_label';
      p['text-color'] = isWater ? t.waterLabel : id.startsWith('highway') || id === 'label_other' ? t.labelSoft : t.label;
      p['text-halo-color'] = t.halo;
      p['text-halo-width'] = 1.4;
      delete p['text-halo-blur'];
    }
    return l;
  });
  return s;
}

try {
  const res = await fetch(SRC, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const style = await res.json();
  for (const [name, t] of Object.entries(THEMES)) {
    await fs.writeFile(new URL(`map-style-${name}.json`, OUT), JSON.stringify(recolour(style, t)));
  }
  console.log(`map styles written from ${SRC}`);
} catch (err) {
  console.warn(`map style fetch failed (${/** @type {Error} */ (err).message}); keeping the committed copies`);
}
