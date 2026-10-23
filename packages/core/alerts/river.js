// @ts-check
// Pure river-alert logic: hysteresis for river_threshold / river_recovered, robust z-score spikes,
// silence detection, and deterministic dedupe keys. No I/O here, so it can be unit-tested directly.
import { riverCheck, SPIKE_PARAMETERS } from '../thresholds.js';

export const COOLDOWN_MS = 6 * 3600_000;
export const RECOVERY_READINGS = 2;
export const SILENT_AFTER_MS = 6 * 3600_000;
export const SPIKE_Z = 4;
export const SPIKE_MIN_POINTS = 48;

/**
 * @typedef {{ in_violation: boolean, ok_streak: number, last_measured_at: Date|null, last_value: number|null,
 *   violation_since: Date|null, last_alert_at: Date|null }} ParamState
 * @typedef {{ kind: 'river_threshold'|'river_recovered', station_no: string, parameter: string, value: number,
 *   measured_at: Date, limit: { min?: number, max?: number }, criteria_class: string, dedupe_key: string }} RiverEvent
 */

/** @returns {ParamState} */
export const freshState = () => ({ in_violation: false, ok_streak: 0, last_measured_at: null, last_value: null, violation_since: null, last_alert_at: null });

/** Hour bucket used in dedupe keys: '2026-10-23T04'. @param {Date} d */
export const hourKey = (d) => d.toISOString().slice(0, 13);

/**
 * Advance one station+parameter's state by one reading. Readings must be applied oldest first.
 * Prior state unknown counts as "within criteria", so a first reading in violation fires once.
 * @param {ParamState|null|undefined} prev
 * @param {{ station_no: string, parameter: string, value: number, measured_at: Date }} r
 * @param {'B'|'C'} cls
 * @returns {{ state: ParamState, events: RiverEvent[] }}
 */
export function stepRiverState(prev, r, cls) {
  const s = { ...(prev || freshState()) };
  /** @type {RiverEvent[]} */
  const events = [];
  if (s.last_measured_at && r.measured_at.getTime() <= s.last_measured_at.getTime()) return { state: s, events };
  const check = riverCheck(r.parameter, r.value, cls);
  s.last_measured_at = r.measured_at;
  s.last_value = r.value;
  if (!check) return { state: s, events }; // parameter has no official river criterion

  const base = { station_no: r.station_no, parameter: r.parameter, value: r.value, measured_at: r.measured_at, limit: check.limit, criteria_class: cls };
  if (check.violation) {
    s.ok_streak = 0;
    if (!s.in_violation) {
      s.in_violation = true;
      s.violation_since = r.measured_at;
      const cooled = !s.last_alert_at || r.measured_at.getTime() - s.last_alert_at.getTime() >= COOLDOWN_MS;
      if (cooled) {
        s.last_alert_at = r.measured_at;
        events.push({ ...base, kind: 'river_threshold', dedupe_key: `river_threshold:${r.station_no}:${r.parameter}:${hourKey(r.measured_at)}` });
      }
    }
  } else if (s.in_violation) {
    s.ok_streak += 1;
    if (s.ok_streak >= RECOVERY_READINGS) {
      // Only announce recovery for an episode we actually announced (not one muted by the cooldown).
      const announced = s.last_alert_at && s.violation_since && s.last_alert_at.getTime() >= s.violation_since.getTime();
      if (announced) events.push({ ...base, kind: 'river_recovered', dedupe_key: `river_recovered:${r.station_no}:${r.parameter}:${hourKey(r.measured_at)}` });
      s.in_violation = false;
      s.violation_since = null;
      s.ok_streak = 0;
    }
  } else {
    s.ok_streak = Math.min(s.ok_streak + 1, 1000);
  }
  return { state: s, events };
}

/** @param {number[]} xs */
export function median(xs) {
  if (!xs.length) return NaN;
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Robust z-score of x against a window: 0.6745 * (x - median) / MAD. Null when the window is too
 * small or flat (MAD = 0), because a flat sensor would make every wobble look infinite.
 * @param {number} x @param {number[]} window
 */
export function robustZ(x, window) {
  if (window.length < SPIKE_MIN_POINTS) return null;
  const med = median(window);
  const mad = median(window.map((v) => Math.abs(v - med)));
  if (!(mad > 0)) return null;
  return { z: (0.6745 * (x - med)) / mad, median: med, mad };
}

/** Instrument floors seen in CPCB data (docs/SOURCES.md): values at or below these are not measurements. */
export const SPIKE_FLOORS = /** @type {Record<string, number>} */ ({ CL: 5, COD: 5, TOC: 1, Nitrate: 0.3, EC: 1, WTb: 0 });
/** A spike must also be a real rise, not just a large z on a very steady sensor. */
export const SPIKE_MIN_RISE = 0.25;
/** The spike episode ends after two readings back under this z. */
export const SPIKE_CLEAR_Z = 2;

/**
 * Spike state machine for parameters without an official limit. Fires once when a reading rises
 * above z = 4 and at least 25% above the 7-day median; quiet until two calm readings end the episode,
 * then a 6-hour cooldown. Higher is worse for every spike parameter, so drops never fire.
 * @param {ParamState|null|undefined} prev
 * @param {{ station_no: string, parameter: string, value: number, measured_at: Date }} r
 * @param {number[]} window values from the previous 7 days, excluding r
 */
export function stepSpikeState(prev, r, window) {
  const s = { ...(prev || freshState()) };
  /** @type {any[]} */
  const events = [];
  if (s.last_measured_at && r.measured_at.getTime() <= s.last_measured_at.getTime()) return { state: s, events };
  s.last_measured_at = r.measured_at;
  s.last_value = r.value;
  const floor = SPIKE_FLOORS[r.parameter] ?? 0;
  if (!SPIKE_PARAMETERS.includes(r.parameter) || r.value <= floor) return { state: s, events };
  const res = robustZ(r.value, window.filter((v) => v > floor));
  if (!res) return { state: s, events };
  const rise = (r.value - res.median) / Math.max(Math.abs(res.median), 1e-9);
  if (res.z > SPIKE_Z && rise >= SPIKE_MIN_RISE) {
    s.ok_streak = 0;
    if (!s.in_violation) {
      s.in_violation = true;
      s.violation_since = r.measured_at;
      if (!s.last_alert_at || r.measured_at.getTime() - s.last_alert_at.getTime() >= COOLDOWN_MS) {
        s.last_alert_at = r.measured_at;
        events.push({
          kind: /** @type {const} */ ('river_spike'),
          station_no: r.station_no, parameter: r.parameter, value: r.value, measured_at: r.measured_at,
          z: Math.round(res.z * 10) / 10, median: res.median, mad: res.mad, direction: 'up',
          dedupe_key: `river_spike:${r.station_no}:${r.parameter}:${hourKey(r.measured_at)}`,
        });
      }
    }
  } else if (s.in_violation && res.z < SPIKE_CLEAR_Z) {
    s.ok_streak += 1;
    if (s.ok_streak >= RECOVERY_READINGS) { s.in_violation = false; s.violation_since = null; s.ok_streak = 0; }
  }
  return { state: s, events };
}

/** @param {string} stationNo @param {Date|null} lastReadingAt @param {Date} now */
export function silentEvent(stationNo, lastReadingAt, now) {
  if (!lastReadingAt || now.getTime() - lastReadingAt.getTime() < SILENT_AFTER_MS) return null;
  return {
    kind: /** @type {const} */ ('river_station_silent'), station_no: stationNo, last_reading_at: lastReadingAt,
    dedupe_key: `river_station_silent:${stationNo}:${lastReadingAt.toISOString()}`,
  };
}
