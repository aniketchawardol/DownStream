// @ts-check
// "What's near me": nearest river stations and nearest tested panchayats, with distance and data age.
import { stationMeta } from '@lt/core/stations.js';
import { inIndia } from '@lt/core/geo.js';

const point = { type: 'number' };

/** @param {import('fastify').FastifyInstance} app @param {{ sql: import('@lt/core/db.js').Sql }} opts */
export default async function nearby(app, { sql }) {
  app.get('/nearby', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false, required: ['lat', 'lng'],
        properties: { lat: { ...point, minimum: -90, maximum: 90 }, lng: { ...point, minimum: -180, maximum: 180 }, radius_km: { type: 'number', minimum: 1, maximum: 50, default: 15 } },
      },
    },
  }, async (req, reply) => {
    const { lat, lng, radius_km } = /** @type {any} */ (req.query);
    if (!inIndia(lat, lng)) return reply.code(400).send({ error: 'outside_india', message: 'That point is outside India. This site only covers Indian government data.' });
    const pin = sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;
    const stations = await sql`
      select station_no, name, last_reading_at, ST_Y(geom::geometry) as lat, ST_X(geom::geometry) as lng,
             ST_Distance(geom, ${pin}) / 1000 as distance_km
      from cpcb_station order by geom <-> ${pin} limit 3`;
    const areas = await sql`
      select g.id, g.name, b.name as block, ST_Y(g.geom::geometry) as lat, ST_X(g.geom::geometry) as lng, g.geocode_confidence,
             ST_Distance(g.geom, ${pin}) / 1000 as distance_km,
             t.last_tested_at, t.worst_status
      from wq_area g
      join wq_area b on b.id = g.parent_id
      join lateral (
        select coalesce(s.analysed_at, s.collected_at) as last_tested_at, s.worst_status
        from wq_sample s where s.gp_area_id = g.id order by coalesce(s.analysed_at, s.collected_at) desc nulls last limit 1
      ) t on true
      where g.level = 'gp' and g.geom is not null
      order by g.geom <-> ${pin} limit 6`;
    const now = Date.now();
    const round = (/** @type {number} */ x) => Math.round(x * 10) / 10;
    return {
      lat, lng, radius_km,
      stations: stations.map((s) => ({
        station_no: s.station_no, name: s.name, ...stationMeta(s.station_no, s.name), lat: s.lat, lng: s.lng,
        distance_km: round(s.distance_km), within_radius: s.distance_km <= radius_km,
        last_reading_at: s.last_reading_at, age_minutes: s.last_reading_at ? Math.round((now - s.last_reading_at.getTime()) / 60_000) : null,
      })),
      areas: areas.map((a) => ({
        id: String(a.id), name: a.name, block: a.block, lat: a.lat, lng: a.lng, approximate: (a.geocode_confidence ?? 0) < 0.5,
        distance_km: round(a.distance_km), within_radius: a.distance_km <= radius_km,
        last_tested_at: a.last_tested_at, worst_status: a.worst_status,
        age_days: a.last_tested_at ? Math.floor((now - a.last_tested_at.getTime()) / 86400_000) : null,
      })),
    };
  });
}
