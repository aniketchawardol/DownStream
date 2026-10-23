// @ts-check
// Geocoded panchayats (GeoJSON) and their lab samples.
import { parseBbox } from '@lt/core/geo.js';
import { BIS_LIMITS } from '@lt/core/thresholds.js';

const DAY = 86400_000;

/** Public link to a sample's government report. @param {string} base @param {string|null} sid */
const reportUrl = (base, sid) => (sid ? `${base}/Common/final_report_print?s_id=${encodeURIComponent(sid)}` : null);

/** @param {import('fastify').FastifyInstance} app @param {{ sql: import('@lt/core/db.js').Sql, config: any }} opts */
export default async function areas(app, { sql, config }) {
  app.get('/areas', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { bbox: { type: 'string', maxLength: 120 } } } },
  }, async (req, reply) => {
    const { bbox: raw } = /** @type {any} */ (req.query);
    const bbox = raw ? parseBbox(raw) : null;
    if (raw && !bbox) return reply.code(400).send({ error: 'bad_request', message: 'bbox must be minLng,minLat,maxLng,maxLat.' });
    const rows = await sql`
      with s as (
        select gp_area_id, sample_id, worst_status, test_kinds, coalesce(analysed_at, collected_at) as tested_at, collected_at
        from wq_sample
      ), latest as (
        select gp_area_id, max(tested_at) as last_tested_at,
               max(tested_at) filter (where 'chemical' = any(test_kinds)) as last_chemical_at,
               max(tested_at) filter (where 'bacteriological' = any(test_kinds)) as last_bacteriological_at,
               count(*) filter (where tested_at > now() - interval '365 days')::int as tests_12m,
               count(*) filter (where tested_at > now() - interval '365 days' and worst_status = 'above_permissible')::int as above_permissible_12m
        from s group by gp_area_id
      )
      select g.id, g.name, b.name as block, d.name as district, g.geocode_source, g.geocode_confidence,
             ST_Y(g.geom::geometry) as lat, ST_X(g.geom::geometry) as lng,
             l.last_tested_at, l.last_chemical_at, l.last_bacteriological_at, l.tests_12m, l.above_permissible_12m,
             (select case max(case x.worst_status when 'above_permissible' then 3 when 'above_acceptable' then 2 when 'ok' then 1 else 0 end)
                       when 3 then 'above_permissible' when 2 then 'above_acceptable' when 1 then 'ok' else 'unknown' end
              from s x where x.gp_area_id = g.id and x.tested_at >= l.last_tested_at - interval '30 days') as latest_round_status
      from wq_area g
      join wq_area b on b.id = g.parent_id
      join wq_area d on d.id = b.parent_id
      left join latest l on l.gp_area_id = g.id
      where g.level = 'gp' and g.geom is not null
        and (${bbox ? bbox.w : null}::float8 is null
             or ST_Intersects(g.geom, ST_MakeEnvelope(${bbox?.w ?? 0}, ${bbox?.s ?? 0}, ${bbox?.e ?? 0}, ${bbox?.n ?? 0}, 4326)::geography))
      order by g.name
      limit 5000`;
    const now = Date.now();
    const days = (/** @type {Date|null} */ d) => (d ? Math.floor((now - d.getTime()) / DAY) : null);
    reply.header('cache-control', 'public, max-age=300');
    return {
      type: 'FeatureCollection',
      generated_at: new Date(now).toISOString(),
      features: rows.map((g) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [g.lng, g.lat] },
        properties: {
          kind: 'area', id: String(g.id), name: g.name, block: g.block, district: g.district,
          last_tested_at: g.last_tested_at, last_chemical_at: g.last_chemical_at, last_bacteriological_at: g.last_bacteriological_at,
          chemical_age_days: days(g.last_chemical_at), bacteriological_age_days: days(g.last_bacteriological_at),
          tests_12m: g.tests_12m ?? 0, above_permissible_12m: g.above_permissible_12m ?? 0,
          status: g.last_tested_at ? (days(g.last_chemical_at) ?? 9999) > 365 ? 'stale' : g.latest_round_status : 'never',
          latest_round_status: g.latest_round_status,
          geocode_source: g.geocode_source, geocode_confidence: g.geocode_confidence,
          approximate: (g.geocode_confidence ?? 0) < 0.5,
        },
      })),
    };
  });

  app.get('/areas/:id/samples', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9]{1,12}$' } }, required: ['id'] },
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 40 } } },
    },
  }, async (req, reply) => {
    const { id } = /** @type {any} */ (req.params);
    const { limit } = /** @type {any} */ (req.query);
    const [area] = await sql`
      select g.id, g.name, b.name as block, d.name as district, g.geocode_source, g.geocode_confidence, g.samples_fetched_at,
             ST_Y(g.geom::geometry) as lat, ST_X(g.geom::geometry) as lng,
             (select count(*)::int from wq_area v where v.parent_id = g.id and v.level = 'village') as villages
      from wq_area g join wq_area b on b.id = g.parent_id join wq_area d on d.id = b.parent_id
      where g.id = ${id} and g.level = 'gp'`;
    if (!area) return reply.code(404).send({ error: 'not_found', message: 'No panchayat with that id.' });
    const samples = await sql`
      select s.sample_id, s.village_name, s.source_type, s.source_name, s.lab_name, s.fy, s.test_kinds, s.worst_status,
             s.collected_at, s.received_at, s.analysed_at, s.reported_at, s.first_seen_at, s.report_s_id, s.report_fetched_at,
             s.remedial_remarks,
             coalesce((select json_agg(json_build_object('parameter', r.parameter, 'label', r.label, 'value_text', r.value_text, 'value', r.value,
                       'unit', r.unit, 'acceptable_limit', r.acceptable_limit, 'permissible_limit', r.permissible_limit, 'status', r.status,
                       'limits_source', r.limits_source, 'nabl', r.nabl) order by r.label) from wq_result r where r.sample_id = s.sample_id), '[]') as results
      from wq_sample s where s.gp_area_id = ${id}
      order by coalesce(s.analysed_at, s.collected_at) desc nulls last
      limit ${limit}`;
    const [counts] = await sql`
      select count(*)::int as total, min(collected_at) as earliest, max(first_seen_at) as last_seen
      from wq_sample where gp_area_id = ${id}`;
    reply.header('cache-control', 'public, max-age=300');
    return {
      area: { ...area, id: String(area.id), approximate: (area.geocode_confidence ?? 0) < 0.5 },
      counts,
      bis_groups: Object.fromEntries(Object.entries(BIS_LIMITS).map(([k, v]) => [k, v.group])),
      samples: samples.map((s) => ({ ...s, report_url: reportUrl(config.wqmisBase, s.report_s_id) })),
    };
  });
}
