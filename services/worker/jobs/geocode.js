// @ts-check
// Geocode districts, blocks and panchayats with Nominatim (one request per second, cached permanently).
// Every coordinate carries its source and a confidence score; the map and alerts show low-confidence
// places honestly rather than pretending to precision. data/geocode-overrides.csv always wins.
import fs from 'node:fs/promises';
import { config } from '@lt/core/config.js';
import { logger } from '@lt/core/log.js';
import { haversineKm } from '@lt/core/geo.js';
import { JJM_STATES } from '@lt/core/states.js';
import { politeFetch } from '../lib/http.js';
import { runSource } from '../lib/source.js';
import { oneShot } from '../lib/one-shot.js';

const log = logger('geocode');
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const PLACE_TYPES = new Set(['village', 'hamlet', 'town', 'city', 'suburb', 'administrative', 'locality', 'neighbourhood', 'isolated_dwelling', 'quarter']);

/** @typedef {{ lat: number, lng: number, type: string, importance: number, name: string }} Hit */

/** @param {string} q @returns {Promise<Hit[]>} */
async function nominatim(q) {
  const url = `${NOMINATIM}?${new URLSearchParams({ q, format: 'jsonv2', limit: '5', countrycodes: 'in', email: config.contactEmail })}`;
  const res = await politeFetch(url, { minGapMs: 1100, accept: 'application/json', timeoutMs: 30_000 });
  const arr = JSON.parse(res.text);
  if (!Array.isArray(arr)) return [];
  return arr.map((h) => ({ lat: Number(h.lat), lng: Number(h.lon), type: String(h.type || h.addresstype || ''), importance: Number(h.importance) || 0, name: String(h.name || h.display_name || '') }))
    .filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng));
}

/**
 * Best hit within maxKm of an anchor (or any hit when there's no anchor), preferring settlement types.
 * @param {Hit[]} hits @param {{ lat: number, lng: number }|null} anchor @param {number} maxKm
 */
export function pickHit(hits, anchor, maxKm) {
  const ok = hits.filter((h) => !anchor || haversineKm(anchor.lat, anchor.lng, h.lat, h.lng) <= maxKm);
  ok.sort((a, b) => Number(PLACE_TYPES.has(b.type)) - Number(PLACE_TYPES.has(a.type)) || b.importance - a.importance);
  return ok[0] ?? null;
}

/**
 * Fold transliteration variants so "Fakir-budhihal", "Fakirbudihal" and "Phakirbudihalli" compare equal:
 * long vowels, aspirates, w/v, Kannada place suffixes (-halli/-hal/-hala, -koppa/-kop, -keri/-kere), doubled letters.
 * @param {string} s
 */
export function normName(s) {
  let t = String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  t = t.replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u').replace(/aa/g, 'a');
  t = t.replace(/([kgcjtdpbs])h/g, '$1').replace(/f/g, 'p').replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/y$/, 'i');
  t = t.replace(/(halli|hali|hala|hal)$/, 'hal').replace(/(koppa|kopa|kop)$/, 'kop').replace(/(keri|kere|kerri)$/, 'ker').replace(/(gudda|guda|gud)$/, 'gud');
  t = t.replace(/(.)\1+/g, '$1');
  return t.replace(/a$/, '');
}

/** Jaro-Winkler similarity, 0..1. @param {string} a @param {string} b */
export function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false), bm = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; m++; break; }
    }
  }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) { if (!am[i]) continue; while (!bm[k]) k++; if (a[i] !== b[k]) t++; k++; }
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let p = 0;
  while (p < 4 && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

/** @typedef {{ lat: number, lng: number, type: string, names: string[] }} OsmPlace */

/** Every OSM settlement in a bounding box, in one Overpass request. @param {{ s: number, w: number, n: number, e: number }} b @returns {Promise<OsmPlace[]>} */
async function overpassPlaces(b) {
  const q = `[out:json][timeout:120];node["place"~"^(village|town|hamlet|city|suburb|isolated_dwelling|locality|neighbourhood)$"](${b.s},${b.w},${b.n},${b.e});out body;`;
  const res = await politeFetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', body: new URLSearchParams({ data: q }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, accept: 'application/json', minGapMs: 2000, timeoutMs: 150_000, retries: 2,
  });
  const j = JSON.parse(res.text);
  return (j.elements || []).filter((/** @type {any} */ e) => e.type === 'node' && e.tags).map((/** @type {any} */ e) => ({
    lat: e.lat, lng: e.lon, type: e.tags.place,
    names: [e.tags['name:en'], e.tags.name, e.tags.alt_name, e.tags.old_name, e.tags['name:kn-Latn']]
      .filter((n) => typeof n === 'string' && /[a-z]/i.test(n)).flatMap((n) => n.split(';')),
  })).filter((/** @type {OsmPlace} */ p) => p.names.length);
}

/**
 * Best OSM settlement for a name near an anchor. Exact folded match 0.9, close spelling 0.75, looser 0.6;
 * two equally good candidates lower the confidence, since one of them is a namesake.
 * @param {string} name @param {OsmPlace[]} places @param {{ lat: number, lng: number }} anchor @param {number} maxKm
 */
export function matchPlace(name, places, anchor, maxKm) {
  const target = normName(name);
  if (target.length < 3) return null;
  /** @type {{ p: OsmPlace, score: number, d: number }[]} */
  const scored = [];
  for (const p of places) {
    const d = haversineKm(anchor.lat, anchor.lng, p.lat, p.lng);
    if (d > maxKm) continue;
    const score = Math.max(...p.names.map((n) => jaroWinkler(target, normName(n))));
    if (score >= 0.88) scored.push({ p, score, d });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || a.d - b.d);
  const best = scored[0];
  const rivals = scored.filter((x) => x !== best && x.score >= best.score - 0.01 && haversineKm(x.p.lat, x.p.lng, best.p.lat, best.p.lng) > 3).length;
  let confidence = best.score === 1 ? 0.9 : best.score >= 0.94 ? 0.75 : 0.6;
  if (rivals) confidence -= 0.25;
  return { lat: best.p.lat, lng: best.p.lng, confidence: Math.round(confidence * 100) / 100, score: best.score };
}

/** @param {string} path */
export async function readOverrides(path) {
  try {
    const text = await fs.readFile(path, 'utf8');
    return text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).slice(1).map((l) => {
      const [level, jjm_id, lat, lng, ...note] = l.split(',').map((s) => s.trim());
      return { level, jjm_id, lat: Number(lat), lng: Number(lng), note: note.join(',') };
    }).filter((o) => o.level && o.jjm_id && Number.isFinite(o.lat) && Number.isFinite(o.lng));
  } catch { return []; }
}

/** @param {import('@lt/core/db.js').Sql} sql @param {string|number} id @param {{ lat: number, lng: number }} p @param {string} source @param {number} confidence */
const setGeom = (sql, id, p, source, confidence) => sql`
  update wq_area set geom = ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography,
    geocode_source = ${source}, geocode_confidence = ${confidence}, geocoded_at = now()
  where id = ${id}`;

/** @param {import('@lt/core/db.js').Sql} sql @param {{ search?: (q: string) => Promise<Hit[]>, places?: (bbox: any) => Promise<OsmPlace[]> }} [deps] */
export async function geocodeCycle(sql, deps = {}) {
  const search = deps.search ?? nominatim;
  /** @type {Record<string, number>} */
  const stats = { overrides: 0, districts: 0, blocks: 0, gps_osm: 0, gps: 0, gp_fallback_block: 0, failed: 0 };

  for (const o of await readOverrides(config.geocodeOverridesPath)) {
    const [a] = await sql`select id from wq_area where level = ${o.level} and jjm_id = ${o.jjm_id}`;
    if (a) { await setGeom(sql, a.id, o, 'override', 1); stats.overrides++; }
  }

  const point = (/** @type {any} */ r) => (r?.lat != null ? { lat: r.lat, lng: r.lng } : null);
  const areas = await sql`
    select a.id, a.level, a.name, a.state_id, a.geocode_source, a.parent_id,
           ST_Y(a.geom::geometry) as lat, ST_X(a.geom::geometry) as lng
    from wq_area a
    where a.level in ('district', 'block', 'gp')
      and (a.level <> 'district' or a.jjm_id = any(${config.wqmisDistricts}))
    order by case a.level when 'district' then 0 when 'block' then 1 else 2 end, a.name`;
  /** @type {Map<string, any>} */
  const byId = new Map(areas.map((a) => [String(a.id), a]));
  /** @type {Map<string, string[]>} */
  const villagesByGp = new Map();
  for (const v of await sql`select parent_id, name from wq_area where level = 'village'`) {
    const k = String(v.parent_id);
    if (!villagesByGp.has(k)) villagesByGp.set(k, []);
    /** @type {string[]} */ (villagesByGp.get(k)).push(v.name);
  }
  /** @type {OsmPlace[]|null} */
  let places = null;

  for (const a of areas) {
    if (a.lat != null && a.geocode_source !== 'block-centroid') continue;
    const state = JJM_STATES[a.state_id] ?? '';
    const parent = byId.get(String(a.parent_id));
    const grand = parent ? byId.get(String(parent.parent_id)) : null;
    try {
      if (a.level === 'district') {
        const hit = pickHit(await search(`${a.name} district, ${state}, India`), null, 0) ?? pickHit(await search(`${a.name}, ${state}, India`), null, 0);
        if (hit) { await setGeom(sql, a.id, hit, 'nominatim', 0.8); Object.assign(a, { lat: hit.lat, lng: hit.lng }); stats.districts++; } else stats.failed++;
      } else if (a.level === 'block') {
        const hit = pickHit(await search(`${a.name}, ${parent?.name ?? ''}, ${state}, India`), point(parent), 90);
        if (hit) { await setGeom(sql, a.id, hit, 'nominatim', 0.8); Object.assign(a, { lat: hit.lat, lng: hit.lng }); stats.blocks++; } else stats.failed++;
      } else {
        const block = parent;
        const district = grand;
        const anchor = point(block) ?? point(district);
        const maxKm = point(block) ? 35 : 80;
        // 1. OpenStreetMap settlements (one bulk request), matched on the GP name, then on its villages' names.
        if (anchor) {
          if (!places) {
            const pts = areas.filter((x) => x.level !== 'gp' && x.lat != null);
            const bbox = { s: Math.min(...pts.map((x) => x.lat)) - 0.6, n: Math.max(...pts.map((x) => x.lat)) + 0.6, w: Math.min(...pts.map((x) => x.lng)) - 0.6, e: Math.max(...pts.map((x) => x.lng)) + 0.6 };
            try { places = await (deps.places ? deps.places(bbox) : overpassPlaces(bbox)); log.info('osm settlements loaded', { count: places.length }); }
            catch (err) { places = []; log.warn('overpass failed; falling back to Nominatim only', { error: String(/** @type {Error} */ (err).message) }); }
          }
          let m = matchPlace(a.name, places, anchor, maxKm);
          let source = 'osm-match';
          if (!m) {
            for (const v of villagesByGp.get(String(a.id)) ?? []) {
              const mv = matchPlace(v, places, anchor, maxKm);
              if (mv) { m = { ...mv, confidence: Math.max(0.3, mv.confidence - 0.15) }; source = 'osm-village'; break; }
            }
          }
          if (m) { await setGeom(sql, a.id, m, source, m.confidence); stats.gps_osm++; continue; }
        }
        // 2. Nominatim free-text search.
        const tries = /** @type {const} */ ([
          [`${a.name}, ${block?.name ?? ''}, ${district?.name ?? ''}, ${state}, India`, point(block) ?? point(district), point(block) ? 35 : 80, 0.9],
          [`${a.name}, ${district?.name ?? ''}, ${state}, India`, point(block) ?? point(district), point(block) ? 35 : 80, 0.75],
          [`${a.name}, ${state}, India`, point(block) ?? point(district), point(block) ? 30 : 60, 0.6],
        ]);
        let done = false;
        for (const [q, anchor, km, conf] of tries) {
          const hit = pickHit(await search(q), anchor, km);
          if (hit) {
            await setGeom(sql, a.id, hit, 'nominatim', PLACE_TYPES.has(hit.type) ? conf : conf - 0.15);
            stats.gps++; done = true; break;
          }
        }
        // 3. The block's point, shown as approximate. (Coordinates printed on lab reports are not used: they
        // repeat a handful of values tens of km from the named village; see docs/SOURCES.md.)
        if (!done) {
          if (point(block)) { await setGeom(sql, a.id, /** @type {any} */ (point(block)), 'block-centroid', 0.2); stats.gp_fallback_block++; }
          else stats.failed++;
        }
      }
    } catch (err) {
      stats.failed++;
      log.warn('geocode failed', { area: a.name, level: a.level, error: String(/** @type {Error} */ (err).message) });
    }
  }

  // Cross-check Nominatim placements against OSM settlement matches. Agreement raises confidence; a
  // disagreement over 3 km means a namesake village, so the place is marked approximate rather than guessed.
  const unchecked = await sql`
    select g.id, g.name, ST_Y(g.geom::geometry) as lat, ST_X(g.geom::geometry) as lng,
           ST_Y(b.geom::geometry) as blat, ST_X(b.geom::geometry) as blng
    from wq_area g join wq_area b on b.id = g.parent_id
    where g.level = 'gp' and g.geocode_source = 'nominatim' and b.geom is not null`;
  if (unchecked.length) {
    if (!places) {
      const pts = areas.filter((x) => x.level !== 'gp' && x.lat != null);
      const bbox = { s: Math.min(...pts.map((x) => x.lat)) - 0.6, n: Math.max(...pts.map((x) => x.lat)) + 0.6, w: Math.min(...pts.map((x) => x.lng)) - 0.6, e: Math.max(...pts.map((x) => x.lng)) + 0.6 };
      places = await (deps.places ? deps.places(bbox) : overpassPlaces(bbox)).catch(() => []);
    }
    for (const g of unchecked) {
      if (!places?.length) break;
      const m = matchPlace(g.name, places, { lat: g.blat, lng: g.blng }, 35);
      if (!m) continue;
      const agree = haversineKm(g.lat, g.lng, m.lat, m.lng) < 3;
      await sql`update wq_area set geocode_source = ${agree ? 'nominatim+osm' : 'nominatim-disputed'},
        geocode_confidence = ${agree ? 0.92 : 0.4} where id = ${g.id}`;
      stats[agree ? 'cross_agree' : 'cross_disputed'] = (stats[agree ? 'cross_agree' : 'cross_disputed'] ?? 0) + 1;
    }
  }
  const [{ total, good }] = await sql`
    select count(*)::int as total, count(*) filter (where geom is not null and geocode_confidence >= 0.5)::int as good
    from wq_area where level = 'gp'`;
  log.info('geocode done', { ...stats, gp_total: total, gp_confident: good });
  return { records: stats.gps_osm + stats.gps + stats.blocks + stats.districts + stats.overrides, notes: { ...stats, gp_total: total, gp_confident: good, gp_confident_pct: total ? Math.round((100 * good) / total) : 0 } };
}

/** @param {import('@lt/core/db.js').Sql} sql */
export const geocodeJob = (sql) => runSource(sql, 'geocode', () => geocodeCycle(sql));

/** One-shot entrypoint (services/worker/run-once.js, used by GitHub Actions). */
export async function run() {
  return oneShot((sql) => geocodeJob(sql));
}
