// @ts-check
// Server-rendered first paint: the live hero sentence and, in simulation mode, the simulation band are
// written into index.html, so the page's first frame already answers "how old is the data here?" and
// nothing shifts when the scripts arrive. Recomputed at most once a minute.
import { config } from '@lt/core/config.js';
import { heroHtml } from '@lt/core/hero.js';
import { stationMeta } from '@lt/core/stations.js';

const STALE_MS = 6 * 3600_000;
const TTL_MS = 60_000;

/** @param {import('@lt/core/db.js').Sql} sql @param {string} template web/dist/index.html */
export function firstPaint(sql, template) {
  /** @type {{ at: number, html: string } | null} */
  let cache = null;
  /** @type {Promise<string> | null} */
  let inflight = null;

  async function render() {
    let html = template;
    if (config.mockMode) {
      html = html.replace(/<html lang="en-IN">/, '<html lang="en-IN" class="sim">')
        .replace(/(<div class="sim-band" id="sim-band" role="status") hidden>/, '$1>');
    }
    try {
      const now = Date.now();
      const stations = (await sql`
        select station_no, name, last_reading_at, ST_Y(geom::geometry) as lat, ST_X(geom::geometry) as lng from cpcb_station`)
        .map((s) => ({ ...stationMeta(s.station_no, s.name), lat: s.lat, lng: s.lng, last_reading_at: s.last_reading_at, is_stale: !s.last_reading_at || now - s.last_reading_at.getTime() > STALE_MS }));
      const areas = (await sql`
        select g.name, ST_Y(g.geom::geometry) as lat, ST_X(g.geom::geometry) as lng, coalesce(g.geocode_confidence, 0) < 0.5 as approximate,
               (select max(coalesce(s.analysed_at, s.collected_at)) from wq_sample s where s.gp_area_id = g.id) as last_tested_at
        from wq_area g where g.level = 'gp' and g.geom is not null`).map((a) => ({ ...a }));
      const hero = heroHtml(stations, areas, null, now);
      if (hero) html = html.replace(/(<h1 id="hero-sentence" class="hero-sentence">)[\s\S]*?(<\/h1>)/, `$1${hero}$2`);
    } catch {
      // Database unavailable: serve the static question; the page explains the outage once its scripts run.
    }
    return html;
  }

  return async () => {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.html;
    inflight ??= render().then((html) => { cache = { at: Date.now(), html }; return html; }).finally(() => { inflight = null; });
    return inflight;
  };
}
