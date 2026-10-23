// @ts-check
// Parsers for CPCB's real-time water-quality portal (KISTERS web portal layout).
// Treat every field as untrusted: skip what doesn't fit and report it, never throw on a bad row.
import { cleanStationName } from '../stations.js';

export const CPCB_PARAMETERS = /** @type {const} */ ({
  pH: { label: 'pH', unit: null },
  DO: { label: 'Dissolved oxygen', unit: 'mg/l' },
  BOD: { label: 'Biochemical oxygen demand', unit: 'mg/l' },
  COD: { label: 'Chemical oxygen demand', unit: 'mg/l' },
  TOC: { label: 'Total organic carbon', unit: 'mg/l' },
  Nitrate: { label: 'Nitrate', unit: 'mg/l' },
  CL: { label: 'Chloride', unit: 'mg/l' },
  EC: { label: 'Conductivity', unit: 'mS/cm' },
  WTb: { label: 'Turbidity', unit: 'NTU' },
  WT: { label: 'Water temperature', unit: '°C' },
  Depth: { label: 'Depth', unit: 'm' },
  S: { label: 'River stage', unit: 'm' },
});

/**
 * @typedef {{ station_no: string, station_id: string|null, site_no: string|null, name: string, raw_name: string, state: string|null,
 *   lat: number, lng: number, status_remark: string|null, diary: DiaryEntry[], parameters: Record<string, string> }} CpcbStation
 * @typedef {{ station_no: string, parameter: string, value: number, unit: string|null, measured_at: Date }} CpcbReading
 * @typedef {{ start: string|null, end: string|null, reason: string }} DiaryEntry
 */

/** @param {unknown} v */
const unitOf = (v) => (typeof v === 'string' && v.trim() && !/^-+$/.test(v.trim()) ? v.trim() : null);

/** @param {unknown} v */
const toNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
};

/**
 * Parse `station_diary_status`: "2023-11-05 15:00:00: FM Start: Technical issue<br>2024-10-20 16:00:00: FM End: Technical issue".
 * Times are the portal's local wall clock (IST). Returns outages pairing each start with its end.
 * @param {unknown} s @returns {DiaryEntry[]}
 */
export function parseDiary(s) {
  if (typeof s !== 'string' || !s.trim()) return [];
  /** @type {DiaryEntry[]} */
  const out = [];
  /** @type {Record<string, DiaryEntry>} */
  const open = {};
  for (const part of s.split(/<br\s*\/?>/i)) {
    const m = part.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})?:\s*FM (Start|End):\s*(.+)$/i);
    if (!m) continue;
    const at = `${m[1]}T${m[2]}:00+05:30`;
    const reason = m[4].trim();
    if (/start/i.test(m[3])) {
      open[reason] = { start: at, end: null, reason };
      out.push(open[reason]);
    } else if (open[reason]) {
      open[reason].end = at;
      delete open[reason];
    } else {
      out.push({ start: null, end: at, reason });
    }
  }
  return out;
}

/**
 * Parse the layer file (layers/10/index.json): one object per station x parameter, latest value only.
 * @param {unknown} json
 * @returns {{ stations: CpcbStation[], readings: CpcbReading[], warnings: string[] }}
 */
export function parseCpcbLayer(json) {
  /** @type {string[]} */
  const warnings = [];
  if (!Array.isArray(json)) return { stations: [], readings: [], warnings: ['layer is not a JSON array'] };
  /** @type {Map<string, CpcbStation>} */
  const stations = new Map();
  /** @type {CpcbReading[]} */
  const readings = [];
  const unknownParams = new Set();
  let skipped = 0;
  for (const o of json) {
    if (!o || typeof o !== 'object') { skipped++; continue; }
    const no = typeof o.station_no === 'string' ? o.station_no.trim() : '';
    const lat = toNum(o.station_latitude);
    const lng = toNum(o.station_longitude);
    if (!no || lat == null || lng == null) { skipped++; continue; }
    if (!stations.has(no)) {
      stations.set(no, {
        station_no: no,
        station_id: o.station_id != null ? String(o.station_id) : null,
        site_no: typeof o.site_no === 'string' && o.site_no.trim() ? o.site_no.trim() : null,
        name: cleanStationName(String(o.station_name || no)),
        raw_name: String(o.station_name || no),
        state: typeof o.territory_name === 'string' && o.territory_name.trim() ? o.territory_name.trim() : null,
        lat, lng,
        status_remark: o.station_status_remark || null,
        diary: parseDiary(o.station_diary_status),
        parameters: {},
      });
    }
    const parameter = typeof o.stationparameter_name === 'string' ? o.stationparameter_name.trim() : '';
    const value = toNum(o.ts_value);
    const at = typeof o.timestamp === 'string' ? new Date(o.timestamp) : null;
    if (!parameter || value == null || !at || Number.isNaN(at.getTime())) { skipped++; continue; }
    if (!(parameter in CPCB_PARAMETERS)) unknownParams.add(parameter);
    // stationparameter_no is the path segment of the per-station history files
    /** @type {CpcbStation} */ (stations.get(no)).parameters[parameter] = String(o.stationparameter_no || parameter);
    readings.push({ station_no: no, parameter, value, unit: unitOf(o.ts_unitsymbol), measured_at: at });
  }
  if (skipped) warnings.push(`${skipped} layer objects skipped (missing station, coordinates, value or timestamp)`);
  if (unknownParams.size) warnings.push(`unknown parameter codes: ${[...unknownParams].join(', ')}`);
  return { stations: [...stations.values()], readings, warnings };
}

/**
 * Parse a KISTERS per-station time-series file:
 * [{ station_no, stationparameter_name, ts_unitsymbol, columns: "Timestamp,Value", data: [["2026-10-17T00:30:00.000Z", 6.76], ...] }]
 * @param {unknown} json
 * @returns {{ readings: CpcbReading[], warnings: string[] }}
 */
export function parseCpcbSeries(json) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {CpcbReading[]} */
  const readings = [];
  const blocks = Array.isArray(json) ? json : [json];
  for (const b of blocks) {
    if (!b || typeof b !== 'object' || !Array.isArray(b.data)) { warnings.push('series block without data array'); continue; }
    const no = String(b.station_no || '').trim();
    const parameter = String(b.stationparameter_name || '').trim();
    if (!no || !parameter) { warnings.push('series block without station or parameter'); continue; }
    const cols = String(b.columns || 'Timestamp,Value').split(',').map((c) => c.trim().toLowerCase());
    const ti = Math.max(0, cols.indexOf('timestamp'));
    const vi = cols.indexOf('value') >= 0 ? cols.indexOf('value') : 1;
    for (const row of b.data) {
      if (!Array.isArray(row)) continue;
      const at = new Date(row[ti]);
      const value = toNum(row[vi]);
      if (Number.isNaN(at.getTime()) || value == null) continue;
      readings.push({ station_no: no, parameter, value, unit: unitOf(b.ts_unitsymbol), measured_at: at });
    }
  }
  return { readings, warnings };
}
