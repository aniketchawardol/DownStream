// @ts-check
// Monthly: each station's daily history from CPCB's year.json files (daily min, mean and max for every
// parameter, back to late 2021). About 480 files of ~200 KB for the first run, one at a time. Resumable:
// a station is marked done only after all its parameters are stored, and stations refreshed in the last
// 25 days are skipped, so a run cut short by a time budget continues where it stopped.
import { config } from '@lt/core/config.js';
import { logger } from '@lt/core/log.js';
import { parseCpcbDaily } from '@lt/core/parsers/cpcb.js';
import { politeFetch } from '../lib/http.js';
import { runSource } from '../lib/source.js';
import { outOfTime } from '../lib/deadline.js';
import { oneShot } from '../lib/one-shot.js';

const log = logger('cpcb-history');
export const REFRESH_DAYS = 25;

/** @param {string} url */
const defaultFetchText = async (url) => (await politeFetch(url, { accept: 'application/json', timeoutMs: 90_000 })).text;

/** Base of the KISTERS export tree, e.g. https://host/data/internet. */
const dataRoot = () => config.cpcbUrl.replace(/\/layers\/.*$/, '');

/**
 * @param {import('@lt/core/db.js').Sql} sql @param {string} stationNo @param {string} parameter
 * @param {import('@lt/core/parsers/cpcb.js').CpcbDay[]} days
 */
export async function upsertDays(sql, stationNo, parameter, days) {
  for (let i = 0; i < days.length; i += 1000) {
    const chunk = days.slice(i, i + 1000).map((d) => ({ station_no: stationNo, parameter, ...d }));
    await sql`
      insert into cpcb_daily ${sql(chunk, 'station_no', 'parameter', 'day', 'min', 'mean', 'max', 'coverage')}
      on conflict (station_no, parameter, day) do update set
        min = excluded.min, mean = excluded.mean, max = excluded.max, coverage = excluded.coverage`;
  }
}

/**
 * @param {import('@lt/core/db.js').Sql} sql
 * @param {{ fetchText?: (url: string) => Promise<string>, only?: string[] }} [deps]
 */
export async function historyCycle(sql, deps = {}) {
  const fetchText = deps.fetchText ?? defaultFetchText;
  const todo = await sql`
    select station_no, site_no, parameters from cpcb_station
    where site_no is not null
      and (history_at is null or history_at < now() - ${`${REFRESH_DAYS} days`}::interval)
      and (${deps.only ?? null}::text[] is null or station_no = any(${deps.only ?? null}::text[]))
    order by history_at nulls first, station_no`;
  let stations = 0, rows = 0, failed = 0;
  /** @type {string[]} */
  const warnings = [];
  let stoppedEarly = false;
  for (const st of todo) {
    if (outOfTime()) { stoppedEarly = true; break; }
    let ok = true;
    for (const [param, paramNo] of Object.entries(st.parameters || {})) {
      const url = `${dataRoot()}/stations/${encodeURIComponent(st.site_no)}/${encodeURIComponent(st.station_no)}/${encodeURIComponent(String(paramNo))}/year.json`;
      try {
        const { days, warnings: w } = parseCpcbDaily(JSON.parse(await fetchText(url)));
        if (w.length) warnings.push(`${st.station_no}/${param}: ${w[0]}`);
        await upsertDays(sql, st.station_no, param, days);
        rows += days.length;
      } catch (err) {
        // A parameter a station never measured has no file (404): not a reason to retry the station.
        const msg = String(/** @type {Error} */ (err).message);
        if (/\b404\b/.test(msg)) continue;
        ok = false;
        failed++;
        log.warn('year.json failed', { station: st.station_no, param, error: msg.slice(0, 160) });
      }
    }
    if (ok) {
      await sql`update cpcb_station set history_at = now() where station_no = ${st.station_no}`;
      stations++;
    }
  }
  const [{ newest }] = await sql`select max(day) as newest from cpcb_daily`;
  log.info('history stored', { stations, rows, failed, remaining: todo.length - stations, stoppedEarly });
  if (todo.length && !stations && failed) throw new Error(`every year.json failed (${failed})`);
  return {
    records: rows,
    newest_data_at: newest ? new Date(`${newest instanceof Date ? newest.toISOString().slice(0, 10) : newest}T00:00:00+05:30`) : null,
    notes: { stations, of: todo.length, failed, complete: !stoppedEarly && stations === todo.length, ...(warnings.length ? { warnings: warnings.slice(0, 5) } : {}) },
  };
}

/** @param {import('@lt/core/db.js').Sql} sql */
export const historyJob = (sql) => runSource(sql, 'cpcb-history', () => historyCycle(sql));

/** One-shot entrypoint (services/worker/run-once.js, used by GitHub Actions). */
export async function run() {
  return oneShot((sql) => historyJob(sql));
}
