// @ts-check
// Smaller read endpoints: config for the frontend, alerts timeline, daily dashboard history,
// publication lags for "How a tap sample becomes public", and place search.
import { ALERT_KINDS, SUBSCRIPTION_GROUPS } from '@lt/core/alerts/kinds.js';
import { RIVER_CRITERIA, RIVER_CLASS_LABEL } from '@lt/core/thresholds.js';
import { simSubjects } from '@lt/core/simulator.js';
import { stationMeta } from '@lt/core/stations.js';
import { inIndia } from '@lt/core/geo.js';
import { userAgent } from '@lt/core/config.js';

/** @param {import('fastify').FastifyInstance} app @param {{ sql: import('@lt/core/db.js').Sql, config: any }} opts */
export default async function misc(app, { sql, config }) {
  app.get('/config', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return {
      mock_mode: config.mockMode,
      mock: config.mockMode ? { lat: config.mockLat, lng: config.mockLng, radius_km: 15, subjects: simSubjects() } : null,
      map_style_url: config.mapStyleUrl,
      criteria_class: config.riverCriteriaClass,
      criteria_label: RIVER_CLASS_LABEL[/** @type {'B'|'C'} */ (config.riverCriteriaClass)],
      river_criteria: RIVER_CRITERIA[/** @type {'B'|'C'} */ (config.riverCriteriaClass)],
      subscription_groups: SUBSCRIPTION_GROUPS,
      alert_kinds: ALERT_KINDS,
    };
  });

  app.get('/alerts', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          lat: { type: 'number', minimum: -90, maximum: 90 }, lng: { type: 'number', minimum: -180, maximum: 180 },
          radius_km: { type: 'number', minimum: 1, maximum: 500, default: 50 },
          include_mock: { type: 'boolean', default: false },
          days: { type: 'integer', minimum: 1, maximum: 90, default: 14 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  }, async (req, reply) => {
    const q = /** @type {any} */ (req.query);
    if ((q.lat == null) !== (q.lng == null)) return reply.code(400).send({ error: 'bad_request', message: 'Send both lat and lng, or neither.' });
    const near = q.lat != null;
    const rows = await sql`
      select id, kind, severity, source, title, body, is_mock, created_at, ST_Y(geom::geometry) as lat, ST_X(geom::geometry) as lng
      ${near ? sql`, ST_Distance(geom, ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography) / 1000 as distance_km` : sql``}
      from alert
      where created_at > now() - make_interval(days => ${q.days})
        and (${q.include_mock} or not is_mock)
        and kind <> 'regional_geogenic'
        ${near ? sql`and ST_DWithin(geom, ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography, ${q.radius_km * 1000})` : sql``}
      order by created_at desc limit ${q.limit}`;
    reply.header('cache-control', 'no-cache');
    return { alerts: rows.map((r) => ({ ...r, distance_km: r.distance_km != null ? Math.round(r.distance_km * 10) / 10 : undefined })) };
  });

  app.get('/dashboard/daily', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } } } },
  }, async (req, reply) => {
    const { days } = /** @type {any} */ (req.query);
    const rows = await sql`
      select snapshot_date::text as date, scope, payload from wq_daily_snapshot
      where snapshot_date > current_date - ${days}::int order by snapshot_date desc, scope`;
    reply.header('cache-control', 'public, max-age=600');
    return { days, snapshots: rows };
  });

  // Median hours between each step of a tap sample's journey, from samples whose reports we've read.
  app.get('/lags', async (_req, reply) => {
    const [r] = await sql`
      select count(*)::int as samples,
        percentile_cont(0.5) within group (order by extract(epoch from received_at - collected_at) / 3600) as collected_to_received,
        percentile_cont(0.5) within group (order by extract(epoch from analysed_at - received_at) / 3600) as received_to_analysed,
        percentile_cont(0.5) within group (order by extract(epoch from reported_at - analysed_at) / 3600) as analysed_to_reported,
        percentile_cont(0.5) within group (order by extract(epoch from first_seen_at - reported_at) / 3600) as reported_to_first_seen,
        percentile_cont(0.5) within group (order by extract(epoch from first_seen_at - collected_at) / 3600) as collected_to_first_seen,
        min(collected_at) as earliest, max(first_seen_at) as latest
      from wq_sample
      where report_fetched_at is not null and received_at is not null and reported_at is not null
        and received_at >= collected_at and analysed_at >= received_at and reported_at >= analysed_at`;
    // first_seen_at only measures publication lag for samples that appeared after our first crawl.
    const [fresh] = await sql`
      select count(*)::int as samples,
        percentile_cont(0.5) within group (order by extract(epoch from first_seen_at - reported_at) / 3600) as reported_to_first_seen
      from wq_sample s
      join wq_area g on g.id = s.gp_area_id
      where s.reported_at is not null and s.first_seen_at > g.crawled_at - interval '30 days'
        and s.first_seen_at > (select min(first_seen_at) + interval '1 day' from wq_sample)`;
    reply.header('cache-control', 'public, max-age=600');
    return { ...r, reported_to_first_seen: fresh.samples >= 5 ? fresh.reported_to_first_seen : null, first_seen_samples: fresh.samples };
  });

  /** @type {Map<string, { at: number, hits: any[] }>} */
  const geoCache = new Map();
  let lastNominatim = 0;

  app.get('/search', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { querystring: { type: 'object', additionalProperties: false, required: ['q'], properties: { q: { type: 'string', minLength: 2, maxLength: 80 } } } },
  }, async (req, reply) => {
    const q = /** @type {any} */ (req.query).q.trim();
    const like = `%${q.replace(/[%_\\]/g, (/** @type {string} */ c) => `\\${c}`)}%`;
    const places = await sql`
      select a.level, a.id, a.name, p.name as parent, ST_Y(a.geom::geometry) as lat, ST_X(a.geom::geometry) as lng
      from wq_area a left join wq_area p on p.id = a.parent_id
      where a.level in ('district', 'block', 'gp') and a.geom is not null and a.name ilike ${like}
      order by (lower(a.name) = lower(${q})) desc, case a.level when 'district' then 0 when 'block' then 1 else 2 end, a.name
      limit 8`;
    const stations = await sql`
      select station_no, name, ST_Y(geom::geometry) as lat, ST_X(geom::geometry) as lng from cpcb_station
      where name ilike ${like} or station_no ilike ${like} limit 5`;
    // In simulation mode, "test" or "testing" finds the simulation point, so testers can subscribe there.
    const testPoint = config.mockMode && /^(test|simulat|sim\b|mock)/i.test(q)
      ? [{ type: 'test point', id: 'mock', name: 'Simulation test point', detail: 'Simulated alerts are placed within 9 km of here', lat: config.mockLat, lng: config.mockLng }]
      : [];
    const hits = [
      ...testPoint,
      ...places.map((p) => ({ type: p.level === 'gp' ? 'panchayat' : p.level, id: String(p.id), name: p.name, detail: p.parent ? `${p.level === 'gp' ? 'Block' : 'District'}: ${p.parent}` : 'District', lat: p.lat, lng: p.lng })),
      ...stations.map((s) => { const m = stationMeta(s.station_no, s.name); return { type: 'station', id: s.station_no, name: m.river ? `${m.river} at ${m.place}` : m.place, detail: `CPCB river station ${s.station_no}`, lat: s.lat, lng: s.lng }; }),
    ];
    // Fall back to OpenStreetMap for towns and PIN codes we don't hold, at most one request per second.
    if (hits.length < 3) {
      const key = q.toLowerCase();
      const cached = geoCache.get(key);
      if (cached && Date.now() - cached.at < 86400_000) hits.push(...cached.hits);
      else if (Date.now() - lastNominatim > 1100) {
        lastNominatim = Date.now();
        try {
          const params = /^\d{6}$/.test(q) ? { postalcode: q, country: 'India' } : { q: `${q}, India` };
          const res = await fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ ...params, format: 'jsonv2', limit: '5', countrycodes: 'in', email: config.contactEmail })}`, {
            headers: { 'user-agent': userAgent() }, signal: AbortSignal.timeout(8000),
          });
          const arr = /** @type {any[]} */ (await res.json());
          const osm = arr.map((h) => ({ type: 'place', id: `osm:${h.osm_id}`, name: String(h.name || h.display_name).split(',')[0], detail: String(h.display_name).split(',').slice(1, 3).join(',').trim(), lat: Number(h.lat), lng: Number(h.lon) }))
            .filter((h) => inIndia(h.lat, h.lng));
          geoCache.set(key, { at: Date.now(), hits: osm });
          if (geoCache.size > 500) geoCache.delete(/** @type {string} */ (geoCache.keys().next().value));
          hits.push(...osm);
        } catch (err) {
          req.log.warn({ err }, 'nominatim search failed');
        }
      }
    }
    reply.header('cache-control', 'public, max-age=300');
    return { q, results: hits.slice(0, 10) };
  });
}
