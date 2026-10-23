// @ts-check
// Every 15 minutes: fetch CPCB's layer file (latest value per station x parameter), keep every new
// (station, parameter, timestamp), backfill 7 days of history once per station, then evaluate alerts.
import { config } from '@lt/core/config.js';
import { logger } from '@lt/core/log.js';
import { parseCpcbLayer, parseCpcbSeries } from '@lt/core/parsers/cpcb.js';
import { politeFetch, archiveRaw } from '../lib/http.js';
import { runSource, SchemaError } from '../lib/source.js';
import { evaluateRiverReadings, checkSilentStations } from './alerts.js';
import { oneShot } from '../lib/one-shot.js';

const log = logger('cpcb');

/** @param {string} url */
const defaultFetchText = async (url) => (await politeFetch(url, { accept: 'application/json', timeoutMs: 60_000 })).text;

/** Base of the KISTERS export tree, e.g. https://host/data/internet. */
const dataRoot = () => config.cpcbUrl.replace(/\/layers\/.*$/, '');

/**
 * @param {import('@lt/core/db.js').Sql} sql
 * @param {import('@lt/core/parsers/cpcb.js').CpcbReading[]} readings
 * @returns {Promise<import('@lt/core/parsers/cpcb.js').CpcbReading[]>} the rows that were new
 */
export async function insertReadings(sql, readings) {
  /** @type {any[]} */
  const inserted = [];
  for (let i = 0; i < readings.length; i += 1000) {
    const chunk = readings.slice(i, i + 1000).map((r) => ({ station_no: r.station_no, parameter: r.parameter, value: r.value, unit: r.unit, measured_at: r.measured_at }));
    const rows = await sql`
      insert into cpcb_reading ${sql(chunk, 'station_no', 'parameter', 'value', 'unit', 'measured_at')}
      on conflict (station_no, parameter, measured_at) do nothing
      returning station_no, parameter, value, unit, measured_at`;
    inserted.push(...rows);
  }
  return inserted;
}

/**
 * One CPCB cycle. Dependencies are injectable so tests can run it against fixtures.
 * @param {import('@lt/core/db.js').Sql} sql
 * @param {{ fetchText?: (url: string) => Promise<string>, backfill?: boolean, now?: Date }} [deps]
 */
export async function cpcbCycle(sql, deps = {}) {
  const fetchText = deps.fetchText ?? defaultFetchText;
  const text = await fetchText(`${config.cpcbUrl}?t=${Date.now()}`);
  await archiveRaw('cpcb', 'layer10.json', text);
  /** @type {unknown} */
  let json;
  try { json = JSON.parse(text); } catch { throw new SchemaError('layer file is not JSON'); }
  const { stations, readings, warnings } = parseCpcbLayer(json);
  if (!stations.length || !readings.length) throw new SchemaError(`layer parsed to ${stations.length} stations / ${readings.length} readings`);

  for (const s of stations) {
    await sql`
      insert into cpcb_station (station_no, name, state, geom, diary, site_no, parameters, long_name, updated_at)
      values (${s.station_no}, ${s.name}, ${s.state}, ST_SetSRID(ST_MakePoint(${s.lng}, ${s.lat}), 4326)::geography,
              ${sql.json(/** @type {any} */ (s.diary))}, ${s.site_no}, ${sql.json(s.parameters)}, ${s.raw_name}, now())
      on conflict (station_no) do update set
        name = excluded.name, state = excluded.state, geom = excluded.geom, diary = excluded.diary,
        site_no = excluded.site_no, parameters = excluded.parameters, long_name = excluded.long_name, updated_at = now()`;
  }

  // Backfill: stations never backfilled get their week.json history first, applied silently to the
  // alert state so a week-old excursion never fires an alert today.
  let backfilled = 0;
  if (deps.backfill !== false) {
    const todo = await sql`select station_no, site_no, parameters from cpcb_station where backfilled_at is null and site_no is not null order by station_no`;
    for (const st of todo) {
      /** @type {import('@lt/core/parsers/cpcb.js').CpcbReading[]} */
      const hist = [];
      for (const [param, paramNo] of Object.entries(st.parameters || {})) {
        try {
          const t = await fetchText(`${dataRoot()}/stations/${encodeURIComponent(st.site_no)}/${encodeURIComponent(st.station_no)}/${encodeURIComponent(String(paramNo))}/week.json`);
          const parsed = parseCpcbSeries(JSON.parse(t));
          hist.push(...parsed.readings.map((r) => ({ ...r, parameter: param })));
        } catch (err) {
          log.warn('history fetch failed', { station: st.station_no, param, error: String(/** @type {Error} */ (err).message) });
        }
      }
      const live = new Set(readings.filter((r) => r.station_no === st.station_no).map((r) => `${r.parameter}|${r.measured_at.toISOString()}`));
      const fresh = await insertReadings(sql, hist.filter((r) => !live.has(`${r.parameter}|${r.measured_at.toISOString()}`)));
      await evaluateRiverReadings(sql, fresh, { silent: true });
      await sql`update cpcb_station set backfilled_at = now() where station_no = ${st.station_no}`;
      backfilled += fresh.length;
    }
  }

  const fresh = await insertReadings(sql, readings);
  await sql`
    update cpcb_station s set last_reading_at = m.t
    from (select station_no, max(measured_at) t from cpcb_reading group by station_no) m
    where m.station_no = s.station_no`;
  const alerts = await evaluateRiverReadings(sql, fresh);
  const silent = await checkSilentStations(sql, deps.now);

  const newest = readings.reduce((m, r) => (r.measured_at > m ? r.measured_at : m), new Date(0));
  const staleCut = (deps.now ?? new Date()).getTime() - 6 * 3600_000;
  const latestByStation = new Map();
  for (const r of readings) latestByStation.set(r.station_no, Math.max(latestByStation.get(r.station_no) ?? 0, r.measured_at.getTime()));
  const stale = [...latestByStation].filter(([, t]) => t < staleCut).map(([s]) => s).sort();
  return {
    records: fresh.length,
    newest_data_at: newest,
    notes: { stations: stations.length, layer_objects: Array.isArray(json) ? json.length : 0, backfilled, stale, alerts_created: alerts.created + silent.created, ...(warnings.length ? { warnings } : {}) },
  };
}

/** @param {import('@lt/core/db.js').Sql} sql */
export const cpcbJob = (sql) => runSource(sql, 'cpcb', () => cpcbCycle(sql));

/** One-shot entrypoint (services/worker/run-once.js, used by GitHub Actions). */
export async function run() {
  return oneShot((sql) => cpcbJob(sql));
}
