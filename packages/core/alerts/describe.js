// @ts-check
// Titles and structured bodies for alerts. Shared by the real jobs and the simulator so mock alerts
// look exactly like real ones apart from their (fictional) subjects and the is_mock flag.
import { CPCB_PARAMETERS } from '../parsers/cpcb.js';
import { describeLimit, RIVER_CLASS_LABEL } from '../thresholds.js';

/** @param {string} p */
export const riverParamLabel = (p) => CPCB_PARAMETERS[/** @type {keyof typeof CPCB_PARAMETERS} */ (p)]?.label ?? p;

/** "Adagal panchayat"; names that already say panchayat (simulated subjects) are left alone. @param {string} name */
export const gpLabel = (name) => (/panchayat/i.test(name) ? name : `${name} panchayat`);

/** "the Ganga at Haridwar" or "river water at Pratapgarh". @param {{ place: string, river: string|null }} s */
export const riverPlace = (s) => (s.river ? `the ${s.river} at ${s.place}` : `river water at ${s.place}`);

/**
 * @param {'river_threshold'|'river_recovered'|'river_spike'} kind
 * @param {{ station_no: string, station_name: string, place: string, river: string|null }} st
 * @param {{ parameter: string, value: number, unit: string|null, measured_at: Date, limit?: { min?: number, max?: number },
 *   criteria_class?: 'B'|'C', z?: number, median?: number, direction?: string }} r
 */
export function riverAlert(kind, st, r) {
  const label = riverParamLabel(r.parameter);
  const lower = label === 'pH' ? 'pH' : label.charAt(0).toLowerCase() + label.slice(1);
  let title;
  if (kind === 'river_threshold') {
    const low = r.limit?.min != null && r.value < r.limit.min;
    const high = r.limit?.max != null && r.value > r.limit.max;
    title = `${label} ${low && !high ? 'below' : high && !low ? 'above' : 'outside'} the limit at ${st.place}`;
  } else if (kind === 'river_recovered') {
    title = `${label} back within the limit at ${st.place}`;
  } else {
    title = `Unusual ${lower} reading at ${st.place}`;
  }
  return {
    title,
    body: {
      water: 'river',
      station_no: st.station_no, station_name: st.station_name, place: st.place, river: st.river,
      parameter: r.parameter, parameter_label: label, value: r.value, unit: r.unit,
      limit_text: r.limit ? describeLimit(r.limit, r.unit) : null,
      criteria_class: r.criteria_class ?? null,
      criteria_label: r.criteria_class ? RIVER_CLASS_LABEL[r.criteria_class] : null,
      measured_at: r.measured_at.toISOString(),
      ...(kind === 'river_spike' ? { z: r.z, median: r.median, direction: r.direction } : {}),
      site_path: `/?station=${encodeURIComponent(st.station_no)}`,
    },
  };
}

/** @param {{ station_no: string, station_name: string, place: string, river: string|null }} st @param {Date} lastReadingAt */
export function silentAlert(st, lastReadingAt) {
  return {
    title: `River station at ${st.place} has stopped reporting`,
    body: {
      water: 'river', station_no: st.station_no, station_name: st.station_name, place: st.place, river: st.river,
      last_reading_at: lastReadingAt.toISOString(), site_path: `/?station=${encodeURIComponent(st.station_no)}`,
    },
  };
}

/**
 * @param {'tap_contamination'|'tap_caution'|'tap_all_clear'} kind
 * @param {{ area_id: string|number, gp_name: string, block?: string|null, district?: string|null }} gp
 * @param {{ sample_id: string, village_name?: string|null, source_type?: string|null, source_name?: string|null,
 *   collected_at?: Date|null, analysed_at?: Date|null, reported_at?: Date|null, first_seen_at?: Date|null, report_url?: string|null, lab_name?: string|null }} s
 * @param {{ parameter_label: string, value_text: string|null, unit: string|null, acceptable_text: string|null, permissible_text: string|null, status: string }[]} results
 */
export function tapAlert(kind, gp, s, results) {
  const where = gpLabel(gp.gp_name);
  const title = kind === 'tap_contamination' ? `Lab test above the permissible limit in ${where}`
    : kind === 'tap_caution' ? `Lab test above the acceptable limit in ${where}`
      : `Lab test within limits in ${where}`;
  const iso = (/** @type {Date|null|undefined} */ d) => (d ? d.toISOString() : null);
  return {
    title,
    body: {
      water: 'tap',
      sample_id: s.sample_id, area_id: String(gp.area_id), gp_name: gp.gp_name, block: gp.block ?? null, district: gp.district ?? null,
      village_name: s.village_name ?? null, source_type: s.source_type ?? null, source_name: s.source_name ?? null, lab_name: s.lab_name ?? null,
      collected_at: iso(s.collected_at), analysed_at: iso(s.analysed_at), reported_at: iso(s.reported_at), first_seen_at: iso(s.first_seen_at),
      results,
      report_url: s.report_url ?? null,
      site_path: `/?area=${encodeURIComponent(String(gp.area_id))}`,
    },
  };
}

/**
 * @param {{ area_id: string|number, gp_name: string, block?: string|null, district?: string|null }} gp
 * @param {'chemical'|'bacteriological'} test @param {Date|null} lastTestAt @param {Date} now @param {string} knownSince
 */
export function overdueAlert(gp, test, lastTestAt, now, knownSince) {
  const months = lastTestAt ? Math.floor((now.getTime() - lastTestAt.getTime()) / (30.44 * 86400_000)) : null;
  const title = lastTestAt
    ? `No ${test} lab test in ${gpLabel(gp.gp_name)} for ${months} months`
    : `No ${test} lab test found for ${gpLabel(gp.gp_name)} since ${knownSince}`;
  return {
    title,
    body: {
      water: 'tap', area_id: String(gp.area_id), gp_name: gp.gp_name, block: gp.block ?? null, district: gp.district ?? null,
      test, last_test_at: lastTestAt ? lastTestAt.toISOString() : null, months_since: months, known_since: knownSince,
      norm: test === 'chemical' ? 'at least one chemical and physical test per source each year' : 'at least two bacteriological tests per source each year',
      site_path: `/?area=${encodeURIComponent(String(gp.area_id))}`,
    },
  };
}

/**
 * @param {{ parameter_label: string, unit: string|null, permissible_text: string, count_above: number, count_tested: number,
 *   radius_km: number, fy: string, nearest: { gp_name: string, area_id: string, distance_km: number, value_text: string, collected_at: string|null } }} g
 */
export function geogenicAlert(g) {
  return {
    title: `${g.parameter_label} above the permissible limit in ${g.count_above} of ${g.count_tested} tests within ${g.radius_km} km`,
    body: { water: 'groundwater', ...g, site_path: `/?area=${encodeURIComponent(g.nearest.area_id)}` },
  };
}
