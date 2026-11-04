// @ts-check
// Geocoded panchayats (GeoJSON) and their lab samples.
import { parseBbox } from '@lt/core/geo.js';
import { BIS_LIMITS } from '@lt/core/thresholds.js';

const DAY = 86400_000;

const STATUS_CODE = /** @type {Record<string, number>} */ ({ ok: 0, above_acceptable: 1, above_permissible: 2 });

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
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 40 }, sample_id: { type: 'string', minLength: 1, maxLength: 60 } },
      },
    },
  }, async (req, reply) => {
    const { id } = /** @type {any} */ (req.params);
    const { limit, sample_id: only = null } = /** @type {any} */ (req.query);
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
      from wq_sample s where s.gp_area_id = ${id} and (${only}::text is null or s.sample_id = ${only})
      order by coalesce(s.analysed_at, s.collected_at) desc nulls last
      limit ${limit}`;
    const [counts] = await sql`
      select count(*)::int as total, min(collected_at) as earliest, max(first_seen_at) as last_seen
      from wq_sample where gp_area_id = ${id}`;
    reply.header('cache-control', 'public, max-age=300');
    return {
      area: { ...area, id: String(area.id), approximate: (area.geocode_confidence ?? 0) < 0.5 },
      counts,
      // Older samples than `limit` are listed by /areas/:id/history.
      bis_groups: Object.fromEntries(Object.entries(BIS_LIMITS).map(([k, v]) => [k, v.group])),
      samples: samples.map((s) => ({ ...s, report_url: reportUrl(config.wqmisBase, s.report_s_id) })),
    };
  });

  /** Every sample and result for a panchayat, oldest first. @param {string} id */
  const allResults = (id) => sql`
    select s.sample_id, to_char(coalesce(s.analysed_at, s.collected_at) at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as day,
           s.source_name, s.village_name, s.source_type, s.test_kinds, s.worst_status, s.report_s_id,
           r.parameter, r.label, r.value, r.value_text, r.unit, r.acceptable_limit, r.permissible_limit, r.status
    from wq_sample s left join wq_result r on r.sample_id = s.sample_id
    where s.gp_area_id = ${id}
    order by coalesce(s.analysed_at, s.collected_at) nulls first, s.sample_id, r.label`;

  // All past samples, compact: a month-by-month count, every sample in a list, and one series per parameter.
  app.get('/areas/:id/history', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9]{1,12}$' } }, required: ['id'] } },
  }, async (req, reply) => {
    const { id } = /** @type {any} */ (req.params);
    const [area] = await sql`
      select g.id, g.name, b.name as block, d.name as district
      from wq_area g join wq_area b on b.id = g.parent_id join wq_area d on d.id = b.parent_id
      where g.id = ${id} and g.level = 'gp'`;
    if (!area) return reply.code(404).send({ error: 'not_found', message: 'No panchayat with that id.' });
    const rows = await allResults(id);
    /** @type {Map<string, any>} */
    const samples = new Map();
    /** @type {Map<string, any>} */
    const params = new Map();
    for (const r of rows) {
      let s = samples.get(r.sample_id);
      if (!s) {
        s = { sample_id: r.sample_id, day: r.day, source_name: r.source_name, village_name: r.village_name, source_type: r.source_type,
          test_kinds: r.test_kinds, worst_status: r.worst_status, failing: [], report_url: reportUrl(config.wqmisBase, r.report_s_id) };
        samples.set(r.sample_id, s);
      }
      if (!r.parameter) continue;
      if (r.status === 'above_permissible' || r.status === 'above_acceptable') s.failing.push(r.label);
      const p = params.get(r.parameter) ?? params.set(r.parameter, {
        parameter: r.parameter, label: r.label, unit: r.unit, acceptable_limit: null, permissible_limit: null,
        presence: /coli/i.test(r.label ?? '') || /absent|not\s+be\s+detect/i.test(r.acceptable_limit ?? ''),
        tested: 0, above_acceptable: 0, above_permissible: 0, points: [],
      }).get(r.parameter);
      // Rows run oldest first, so the newest printed limits win.
      if (r.acceptable_limit) p.acceptable_limit = r.acceptable_limit;
      if (r.permissible_limit) p.permissible_limit = r.permissible_limit;
      if (r.unit) p.unit = r.unit;
      p.tested++;
      if (r.status === 'above_acceptable') p.above_acceptable++;
      if (r.status === 'above_permissible') p.above_permissible++;
      p.points.push([r.day, r.value == null ? null : Number(r.value), STATUS_CODE[r.status] ?? -1, r.sample_id, r.value == null ? r.value_text : undefined]);
    }
    const list = [...samples.values()].reverse(); // newest first
    const index = new Map(list.map((x, i) => [x.sample_id, i]));
    for (const p of params.values()) for (const pt of p.points) { pt[3] = index.get(pt[3]); if (pt[4] === undefined) pt.length = 4; }
    /** @type {Map<string, any>} */
    const months = new Map();
    for (const s of list) {
      if (!s.day) continue;
      const k = s.day.slice(0, 7);
      const m = months.get(k) ?? months.set(k, { month: k, ok: 0, caution: 0, danger: 0, unknown: 0 }).get(k);
      m[s.worst_status === 'above_permissible' ? 'danger' : s.worst_status === 'above_acceptable' ? 'caution' : s.worst_status === 'ok' ? 'ok' : 'unknown']++;
    }
    reply.header('cache-control', 'public, max-age=300');
    return {
      area: { ...area, id: String(area.id) },
      total: list.length,
      first_day: list.findLast((s) => s.day)?.day ?? null,
      last_day: list[0]?.day ?? null,
      months: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
      // Points are [day, value, status, sample index, value text when there's no number]; status is
      // 0 within limits, 1 above acceptable, 2 above permissible, -1 not judged.
      status_codes: { 0: 'ok', 1: 'above_acceptable', 2: 'above_permissible', '-1': 'unknown' },
      samples: list,
      params: [...params.values()].sort((a, b) => b.above_permissible - a.above_permissible || b.above_acceptable - a.above_acceptable || b.tested - a.tested),
    };
  });

  app.get('/areas/:id/history.csv', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9]{1,12}$' } }, required: ['id'] } },
  }, async (req, reply) => {
    const { id } = /** @type {any} */ (req.params);
    const [area] = await sql`select id from wq_area where id = ${id} and level = 'gp'`;
    if (!area) return reply.code(404).send({ error: 'not_found', message: 'No panchayat with that id.' });
    const q = (/** @type {unknown} */ v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = ['date_ist,sample_id,village,source,source_type,parameter,value,unit,acceptable_limit,permissible_limit,status'];
    for (const r of await allResults(id)) {
      lines.push([r.day, r.sample_id, r.village_name, r.source_name, r.source_type, r.label, r.value_text, r.unit, r.acceptable_limit, r.permissible_limit, r.status].map(q).join(','));
    }
    reply.header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="jjm-panchayat-${id}-samples.csv"`)
      .header('cache-control', 'public, max-age=3600');
    return `${lines.join('\n')}\n`;
  });
}
