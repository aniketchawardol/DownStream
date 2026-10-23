// @ts-check
// Alert evaluation that needs the database. The decisions themselves live in @lt/core/alerts/*.
import { config } from '@lt/core/config.js';
import { logger } from '@lt/core/log.js';
import { createAlert } from '@lt/core/alerts/store.js';
import { stepRiverState, stepSpikeState, silentEvent } from '@lt/core/alerts/river.js';
import { riverAlert, silentAlert } from '@lt/core/alerts/describe.js';
import { SPIKE_PARAMETERS } from '@lt/core/thresholds.js';
import { stationMeta } from '@lt/core/stations.js';

const log = logger('alerts');

/**
 * Apply readings (any order) to the per-parameter state and, unless silent, raise river alerts.
 * Parameters with official criteria use the threshold state machine; the rest use spike detection.
 * @param {import('@lt/core/db.js').Sql} sql
 * @param {{ station_no: string, parameter: string, value: number, unit: string|null, measured_at: Date }[]} readings
 * @param {{ silent?: boolean, cls?: 'B'|'C' }} [opts]
 */
export async function evaluateRiverReadings(sql, readings, opts = {}) {
  const cls = opts.cls ?? config.riverCriteriaClass;
  if (!readings.length) return { created: 0 };
  const sorted = [...readings].sort((a, b) => a.measured_at.getTime() - b.measured_at.getTime());
  const keys = [...new Set(sorted.map((r) => r.station_no))];
  const stateRows = await sql`select * from river_param_state where station_no = any(${keys})`;
  /** @type {Map<string, any>} */
  const states = new Map(stateRows.map((s) => [`${s.station_no}|${s.parameter}`, s]));
  const stations = new Map((await sql`
    select station_no, name, ST_Y(geom::geometry) as lat, ST_X(geom::geometry) as lng
    from cpcb_station where station_no = any(${keys})`).map((s) => [s.station_no, s]));

  // 7-day windows for spike parameters (only needed when we may raise alerts).
  /** @type {Map<string, { t: number, v: number }[]>} */
  const series = new Map();
  if (!opts.silent && sorted.some((r) => SPIKE_PARAMETERS.includes(r.parameter))) {
    const rows = await sql`
      select station_no, parameter, measured_at, value from cpcb_reading
      where station_no = any(${keys}) and parameter = any(${SPIKE_PARAMETERS})
        and measured_at > ${new Date(sorted[0].measured_at.getTime() - 8 * 86400_000)}`;
    for (const w of rows) {
      const k = `${w.station_no}|${w.parameter}`;
      if (!series.has(k)) series.set(k, []);
      /** @type {any[]} */ (series.get(k)).push({ t: w.measured_at.getTime(), v: w.value });
    }
  }

  /** @type {any[]} */
  const events = [];
  const touched = new Set();
  for (const r of sorted) {
    const k = `${r.station_no}|${r.parameter}`;
    let out;
    if (SPIKE_PARAMETERS.includes(r.parameter)) {
      const t = r.measured_at.getTime();
      const window = opts.silent ? [] : (series.get(k) || []).filter((p) => p.t < t && p.t >= t - 7 * 86400_000).map((p) => p.v);
      out = stepSpikeState(states.get(k), r, window);
    } else {
      out = stepRiverState(states.get(k), r, cls);
    }
    states.set(k, out.state);
    touched.add(k);
    if (!opts.silent) events.push(...out.events.map((e) => ({ ...e, unit: r.unit })));
  }

  for (const k of touched) {
    const [station_no, parameter] = k.split('|');
    const s = states.get(k);
    await sql`
      insert into river_param_state (station_no, parameter, in_violation, ok_streak, last_measured_at, last_value, violation_since, last_alert_at)
      values (${station_no}, ${parameter}, ${s.in_violation}, ${s.ok_streak}, ${s.last_measured_at}, ${s.last_value}, ${s.violation_since}, ${s.last_alert_at})
      on conflict (station_no, parameter) do update set
        in_violation = excluded.in_violation, ok_streak = excluded.ok_streak, last_measured_at = excluded.last_measured_at,
        last_value = excluded.last_value, violation_since = excluded.violation_since, last_alert_at = excluded.last_alert_at`;
  }

  let created = 0;
  for (const e of events) {
    const st = stations.get(e.station_no);
    if (!st) continue;
    const meta = stationMeta(e.station_no, st.name);
    const { title, body } = riverAlert(e.kind, { station_no: e.station_no, station_name: st.name, ...meta }, e);
    const res = await createAlert(sql, { kind: e.kind, subject_ref: `cpcb:${e.station_no}:${e.parameter}`, lat: st.lat, lng: st.lng, title, body, dedupe_key: e.dedupe_key });
    if (res.created) { created++; log.info('river alert', { kind: e.kind, title, deliveries: res.deliveries }); }
  }
  return { created };
}

/** Raise river_station_silent for stations with no reading in 6 hours. @param {import('@lt/core/db.js').Sql} sql @param {Date} [now] */
export async function checkSilentStations(sql, now = new Date()) {
  const rows = await sql`
    select station_no, name, last_reading_at, ST_Y(geom::geometry) as lat, ST_X(geom::geometry) as lng
    from cpcb_station where last_reading_at is not null`;
  let created = 0;
  for (const s of rows) {
    const ev = silentEvent(s.station_no, s.last_reading_at, now);
    if (!ev) continue;
    const meta = stationMeta(s.station_no, s.name);
    const { title, body } = silentAlert({ station_no: s.station_no, station_name: s.name, ...meta }, s.last_reading_at);
    const res = await createAlert(sql, { kind: ev.kind, subject_ref: `cpcb:${s.station_no}`, lat: s.lat, lng: s.lng, title, body, dedupe_key: ev.dedupe_key });
    if (res.created) created++;
  }
  return { created };
}
