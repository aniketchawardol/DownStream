// @ts-check
// CPCB river stations: GeoJSON for the map, 48-hour series for the small multiples, and daily history.
import { CPCB_PARAMETERS } from '@lt/core/parsers/cpcb.js';
import { riverCheck, describeLimit, SPIKE_PARAMETERS } from '@lt/core/thresholds.js';
import { stationMeta } from '@lt/core/stations.js';
import { dailyRows, istDaysAgo, bucket, weekOf, r3 } from '../history.js';

export const STALE_RIVER_MS = 6 * 3600_000;
const PARAMS = Object.keys(CPCB_PARAMETERS);

/** Display unit: CPCB labels EC "mS/cm" but its values are µS/cm (docs/SOURCES.md). @param {string} p @param {string|null} unit */
export const displayUnit = (p, unit) => (p === 'EC' ? 'µS/cm' : unit);

/** @param {import('fastify').FastifyInstance} app @param {{ sql: import('@lt/core/db.js').Sql, config: any }} opts */
export default async function stations(app, { sql, config }) {
  const cls = config.riverCriteriaClass;

  app.get('/stations', async (_req, reply) => {
    const rows = await sql`
      select s.station_no, s.name, s.state, s.long_name, s.last_reading_at, s.diary,
             ST_Y(s.geom::geometry) as lat, ST_X(s.geom::geometry) as lng,
             coalesce(json_agg(json_build_object('parameter', r.parameter, 'value', r.value, 'unit', r.unit, 'measured_at', r.measured_at)) filter (where r.parameter is not null), '[]') as latest
      from cpcb_station s
      left join lateral (
        select distinct on (parameter) parameter, value, unit, measured_at
        from cpcb_reading where station_no = s.station_no and measured_at > coalesce(s.last_reading_at, now()) - interval '6 hours'
        order by parameter, measured_at desc
      ) r on true
      group by s.station_no
      order by s.station_no`;
    const now = Date.now();
    reply.header('cache-control', 'public, max-age=60');
    return {
      type: 'FeatureCollection',
      generated_at: new Date(now).toISOString(),
      criteria_class: cls,
      features: rows.map((s) => {
        const meta = stationMeta(s.station_no, s.name);
        /** @type {Record<string, any>} */
        const params = {};
        const violations = [];
        for (const r of s.latest) {
          const check = riverCheck(r.parameter, r.value, cls);
          const status = check ? (check.violation ? 'violation' : 'ok') : 'no_criteria';
          if (status === 'violation') violations.push(r.parameter);
          params[r.parameter] = {
            value: r.value, unit: displayUnit(r.parameter, r.unit), measured_at: r.measured_at,
            label: CPCB_PARAMETERS[/** @type {keyof typeof CPCB_PARAMETERS} */ (r.parameter)]?.label ?? r.parameter,
            status, limit: check?.limit ?? null, limit_text: check ? describeLimit(check.limit, r.unit) : null,
          };
        }
        const age = s.last_reading_at ? now - new Date(s.last_reading_at).getTime() : null;
        const outage = (s.diary || []).find((/** @type {any} */ d) => d.start && !d.end) ?? null;
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
          properties: {
            kind: 'station', station_no: s.station_no, name: s.name, place: meta.place, river: meta.river, state: s.state,
            last_reading_at: s.last_reading_at, age_minutes: age == null ? null : Math.round(age / 60_000),
            is_stale: age == null || age > STALE_RIVER_MS,
            status: age == null || age > STALE_RIVER_MS ? 'stale' : violations.length ? 'violation' : 'ok',
            violations, params, outage,
          },
        };
      }),
    };
  });

  app.get('/stations/:no/series', {
    schema: {
      params: { type: 'object', properties: { no: { type: 'string', pattern: '^[A-Z]{2}[0-9]{1,4}$' } }, required: ['no'] },
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { param: { type: 'string', enum: PARAMS }, hours: { type: 'integer', minimum: 1, maximum: 336, default: 48 } },
      },
    },
  }, async (req, reply) => {
    const { no } = /** @type {any} */ (req.params);
    const { param, hours } = /** @type {any} */ (req.query);
    const [st] = await sql`select station_no, name, last_reading_at from cpcb_station where station_no = ${no}`;
    if (!st) return reply.code(404).send({ error: 'not_found', message: `No CPCB station ${no}.` });
    // Window ends at the station's newest reading, so a stale station still shows its last 48 hours.
    const end = st.last_reading_at ?? new Date();
    const rows = await sql`
      select parameter, unit, measured_at, value from cpcb_reading
      where station_no = ${no} and measured_at > ${new Date(end.getTime() - hours * 3600_000)} and measured_at <= ${end}
        and (${param ?? null}::text is null or parameter = ${param ?? null})
      order by parameter, measured_at`;
    /** @type {Record<string, any>} */
    const series = {};
    for (const r of rows) {
      const s = (series[r.parameter] ??= {
        parameter: r.parameter, label: CPCB_PARAMETERS[/** @type {keyof typeof CPCB_PARAMETERS} */ (r.parameter)]?.label ?? r.parameter,
        unit: displayUnit(r.parameter, r.unit), limit: riverCheck(r.parameter, 0, cls)?.limit ?? null,
        spike_only: SPIKE_PARAMETERS.includes(r.parameter), points: [],
      });
      s.points.push([r.measured_at.toISOString(), r.value]);
    }
    reply.header('cache-control', 'public, max-age=120');
    return { station_no: no, name: st.name, hours, end: end.toISOString(), criteria_class: cls, series: Object.values(series) };
  });

  const stationParams = { type: 'object', properties: { no: { type: 'string', pattern: '^[A-Z]{2}[0-9]{1,4}$' } }, required: ['no'] };
  const RANGES = /** @type {Record<string, { days: number, bucket: 'day'|'week' }>} */ ({ '30d': { days: 30, bucket: 'day' }, '1y': { days: 365, bucket: 'day' }, all: { days: 20 * 365, bucket: 'week' } });

  // Daily history: CPCB's daily aggregates back to 2021 plus our own readings for the newest days.
  // "all" is bucketed by week to keep the response small; the summary always counts days.
  app.get('/stations/:no/history', {
    schema: {
      params: stationParams,
      querystring: { type: 'object', additionalProperties: false, properties: { range: { type: 'string', enum: Object.keys(RANGES), default: '1y' } } },
    },
  }, async (req, reply) => {
    const { no } = /** @type {any} */ (req.params);
    const { range } = /** @type {any} */ (req.query);
    const [st] = await sql`select station_no, name from cpcb_station where station_no = ${no}`;
    if (!st) return reply.code(404).send({ error: 'not_found', message: `No CPCB station ${no}.` });
    const { days, bucket: unit } = RANGES[range];
    const rows = await dailyRows(sql, { stations: [no], from: istDaysAgo(days) });
    /** @type {Map<string, import('../history.js').DailyRow[]>} */
    const byParam = new Map();
    for (const r of rows) (byParam.get(r.parameter) ?? byParam.set(r.parameter, []).get(r.parameter))?.push(r);
    const params = [...byParam].map(([parameter, list]) => {
      const limit = riverCheck(parameter, 0, cls)?.limit ?? null;
      let outside = 0, lowCoverage = 0;
      /** @type {{ value: number, day: string }|null} */ let lowest = null;
      /** @type {{ value: number, day: string }|null} */ let highest = null;
      for (const d of list) {
        if (d.mean == null) continue;
        if (riverCheck(parameter, d.mean, cls)?.violation) outside++;
        if ((d.coverage ?? 100) < 50) lowCoverage++;
        if (!lowest || d.mean < lowest.value) lowest = { value: d.mean, day: d.day };
        if (!highest || d.mean > highest.value) highest = { value: d.mean, day: d.day };
      }
      const shown = unit === 'week' ? bucket(list, weekOf) : list;
      return {
        parameter, label: CPCB_PARAMETERS[/** @type {keyof typeof CPCB_PARAMETERS} */ (parameter)]?.label ?? parameter,
        unit: displayUnit(parameter, CPCB_PARAMETERS[/** @type {keyof typeof CPCB_PARAMETERS} */ (parameter)]?.unit ?? null),
        limit, spike_only: SPIKE_PARAMETERS.includes(parameter),
        points: shown.map((d) => [d.day, r3(d.min), r3(d.mean), r3(d.max), d.coverage == null ? null : Math.round(d.coverage)]),
        summary: {
          days: list.length, days_outside: limit ? outside : null, low_coverage_days: lowCoverage,
          first_day: list[0]?.day ?? null, last_day: list.at(-1)?.day ?? null,
          lowest: lowest && { value: r3(lowest.value), day: lowest.day }, highest: highest && { value: r3(highest.value), day: highest.day },
        },
      };
    });
    reply.header('cache-control', 'public, max-age=600');
    return { station_no: no, name: st.name, range, bucket: unit, criteria_class: cls, params };
  });

  // Every daily record we hold for a station, one row per day and parameter.
  app.get('/stations/:no/history.csv', { schema: { params: stationParams } }, async (req, reply) => {
    const { no } = /** @type {any} */ (req.params);
    const [st] = await sql`select station_no, name from cpcb_station where station_no = ${no}`;
    if (!st) return reply.code(404).send({ error: 'not_found', message: `No CPCB station ${no}.` });
    const rows = await dailyRows(sql, { stations: [no], from: '2000-01-01' });
    const lines = ['date_ist,parameter,unit,daily_min,daily_mean,daily_max,coverage_percent'];
    for (const r of rows) {
      const unit = displayUnit(r.parameter, CPCB_PARAMETERS[/** @type {keyof typeof CPCB_PARAMETERS} */ (r.parameter)]?.unit ?? null) ?? '';
      lines.push([r.day, r.parameter, unit, r3(r.min), r3(r.mean), r3(r.max), r.coverage == null ? '' : Math.round(r.coverage)].map((v) => (v == null ? '' : String(v))).join(','));
    }
    reply.header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="cpcb-${no}-daily.csv"`)
      .header('cache-control', 'public, max-age=3600');
    return `${lines.join('\n')}\n`;
  });
}
