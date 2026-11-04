// @ts-check
// Daily river history: CPCB's daily min/mean/max (cpcb_daily, from year.json) plus, for days CPCB's file
// doesn't have yet, the same aggregates of our own hourly readings. Days are IST calendar days.

/**
 * @typedef {{ station_no: string, parameter: string, day: string, min: number|null, mean: number|null, max: number|null, coverage: number|null }} DailyRow
 */

/**
 * @param {import('@lt/core/db.js').Sql} sql
 * @param {{ stations: string[], params?: string[]|null, from: string }} q from is an IST date, YYYY-MM-DD
 * @returns {Promise<DailyRow[]>} ordered by station, parameter, day
 */
export async function dailyRows(sql, { stations, params = null, from }) {
  return sql`
    with derived as (
      select station_no, parameter, (measured_at at time zone 'Asia/Kolkata')::date as day,
             min(value) as min, avg(value) as mean, max(value) as max,
             least(100, count(*) * 100.0 / 24)::real as coverage
      from cpcb_reading
      where station_no = any(${stations}) and (${params}::text[] is null or parameter = any(${params}::text[]))
        and measured_at >= ${from}::date - interval '1 day'
      group by 1, 2, 3
    ), merged as (
      select station_no, parameter, day, min, mean, max, coverage from cpcb_daily
      where station_no = any(${stations}) and (${params}::text[] is null or parameter = any(${params}::text[])) and day >= ${from}::date
      union all
      select d.station_no, d.parameter, d.day, d.min, d.mean, d.max, d.coverage from derived d
      where d.day >= ${from}::date
        and not exists (select 1 from cpcb_daily c where c.station_no = d.station_no and c.parameter = d.parameter and c.day = d.day)
    )
    select station_no, parameter, to_char(day, 'YYYY-MM-DD') as day, min, mean, max, coverage
    from merged order by station_no, parameter, day`;
}

/** IST date n days before today. @param {number} n */
export const istDaysAgo = (n) => new Date(Date.now() + 330 * 60_000 - n * 86400_000).toISOString().slice(0, 10);

/** Monday of the ISO week containing an IST date. @param {string} day */
export const weekOf = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/**
 * Collapse daily rows into buckets (week or month): lowest min, mean of means, highest max, mean coverage.
 * @param {DailyRow[]} rows one station and parameter, by day @param {(day: string) => string} keyOf
 */
export function bucket(rows, keyOf) {
  /** @type {Map<string, { day: string, min: number|null, max: number|null, means: number[], cov: number[] }>} */
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r.day);
    const b = m.get(k) ?? { day: k, min: null, max: null, means: [], cov: [] };
    if (r.min != null) b.min = b.min == null ? r.min : Math.min(b.min, r.min);
    if (r.max != null) b.max = b.max == null ? r.max : Math.max(b.max, r.max);
    if (r.mean != null) b.means.push(r.mean);
    if (r.coverage != null) b.cov.push(r.coverage);
    m.set(k, b);
  }
  const avg = (/** @type {number[]} */ a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return [...m.values()].map((b) => ({ day: b.day, min: b.min, mean: avg(b.means), max: b.max, coverage: avg(b.cov) }));
}

/** Round for JSON: 3 significant decimals is plenty for sensor data. @param {number|null} v */
export const r3 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
