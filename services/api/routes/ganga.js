// @ts-check
// The Ganga, upstream to downstream: one parameter's daily (past year) or monthly (since 2021) average at
// every main-stem station, aligned to a shared list of frames for the animated view.
import { CPCB_PARAMETERS } from '@lt/core/parsers/cpcb.js';
import { riverCheck, describeLimit } from '@lt/core/thresholds.js';
import { GANGA_STATIONS, cumulativeKm } from '@lt/core/ganga.js';
import { dailyRows, istDaysAgo, bucket, r3 } from '../history.js';
import { displayUnit } from './stations.js';

export const GANGA_PARAMS = ['DO', 'BOD', 'pH', 'WTb', 'WT', 'EC'];

/** Every IST day from `from` to `to`, inclusive. @param {string} from @param {string} to */
function daysBetween(from, to) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

/** @param {import('fastify').FastifyInstance} app @param {{ sql: import('@lt/core/db.js').Sql, config: any }} opts */
export default async function ganga(app, { sql, config }) {
  const cls = config.riverCriteriaClass;

  app.get('/ganga', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { param: { type: 'string', enum: GANGA_PARAMS, default: 'DO' }, span: { type: 'string', enum: ['year', 'all'], default: 'year' } },
      },
    },
  }, async (req, reply) => {
    const { param, span } = /** @type {any} */ (req.query);
    const nos = GANGA_STATIONS.map((s) => s.station_no);
    const found = await sql`
      select station_no, name, ST_Y(geom::geometry) as lat, ST_X(geom::geometry) as lng, last_reading_at
      from cpcb_station where station_no = any(${nos})`;
    const byNo = new Map(found.map((s) => [s.station_no, s]));
    const ordered = GANGA_STATIONS.filter((g) => byNo.has(g.station_no)).map((g) => ({ ...g, ...byNo.get(g.station_no) }));
    const km = cumulativeKm(ordered);

    const today = istDaysAgo(0);
    const from = span === 'year' ? istDaysAgo(364) : '2021-11-01';
    const rows = await dailyRows(sql, { stations: ordered.map((s) => s.station_no), params: [param], from });
    /** @type {Map<string, import('../history.js').DailyRow[]>} */
    const byStation = new Map();
    for (const r of rows) (byStation.get(r.station_no) ?? byStation.set(r.station_no, []).get(r.station_no))?.push(r);

    const month = (/** @type {string} */ d) => `${d.slice(0, 7)}-01`;
    let frames = span === 'year' ? daysBetween(from, today) : [...new Set(daysBetween(rows.reduce((m, r) => (r.day < m ? r.day : m), today), today).map(month))];
    // Trim leading frames where no station has data yet.
    const series = ordered.map((s) => {
      const list = byStation.get(s.station_no) ?? [];
      const points = span === 'year' ? list : bucket(list, month);
      const at = new Map(points.map((p) => [p.day, p.mean]));
      return { s, values: frames.map((f) => r3(at.get(f) ?? null)) };
    });
    const first = frames.findIndex((_, i) => series.some((x) => x.values[i] != null));
    if (first > 0) { frames = frames.slice(first); for (const x of series) x.values = x.values.slice(first); }

    const meta = CPCB_PARAMETERS[/** @type {keyof typeof CPCB_PARAMETERS} */ (param)];
    const unit = displayUnit(param, meta?.unit ?? null);
    const limit = riverCheck(param, 0, cls)?.limit ?? null;
    reply.header('cache-control', 'public, max-age=900');
    return {
      param, label: meta?.label ?? param, unit, span, bucket: span === 'year' ? 'day' : 'month',
      limit, limit_text: limit ? describeLimit(limit, unit) : null, criteria_class: cls,
      frames,
      stations: series.map(({ s, values }, i) => ({
        station_no: s.station_no, place: s.place, reach: s.reach, name: s.name, lat: s.lat, lng: s.lng,
        km: Math.round(km[i]), last_reading_at: s.last_reading_at, values,
      })),
    };
  });
}
