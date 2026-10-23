// @ts-check
// Simulation mode. Mock alerts use clearly fictional subjects placed a few km from the mock point, never a
// real station, panchayat or village, and always carry is_mock = true.
import { config } from './config.js';
import { offsetPoint } from './geo.js';
import { riverAlert, tapAlert, overdueAlert, geogenicAlert, silentAlert } from './alerts/describe.js';
import { createAlert } from './alerts/store.js';
import { RIVER_CRITERIA } from './thresholds.js';
import { ALL_GROUPS } from './alerts/kinds.js';

/** Fixed fictional subjects around the mock point (bearing degrees, distance km). */
export function simSubjects(lat = config.mockLat, lng = config.mockLng) {
  const at = (/** @type {number} */ km, /** @type {number} */ deg) => offsetPoint(lat, lng, km, deg);
  return {
    stations: [
      { id: 'SIM-01', name: 'Test river station SIM-01', ...at(4, 40) },
      { id: 'SIM-02', name: 'Test river station SIM-02', ...at(7, 200) },
    ],
    gps: [
      { id: 'SIM-GP-1', name: 'Test panchayat SIM-GP-1', ...at(3, 300) },
      { id: 'SIM-GP-2', name: 'Test panchayat SIM-GP-2', ...at(6, 120) },
      { id: 'SIM-GP-3', name: 'Test panchayat SIM-GP-3', ...at(9, 250) },
    ],
  };
}

/** Weighted towards urgent kinds so a demo has something to show. */
export const SIM_WEIGHTS = /** @type {const} */ ([
  ['tap_contamination', 26], ['river_threshold', 26], ['tap_caution', 12], ['river_spike', 10],
  ['regional_geogenic', 6], ['tap_overdue', 6], ['river_recovered', 5], ['tap_all_clear', 5], ['river_station_silent', 4],
]);
export const SIM_KINDS = SIM_WEIGHTS.map(([k]) => k);

/** @param {() => number} rnd */
export function pickKind(rnd = Math.random) {
  const total = SIM_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let x = rnd() * total;
  for (const [k, w] of SIM_WEIGHTS) { if ((x -= w) < 0) return k; }
  return SIM_WEIGHTS[0][0];
}

/** @param {number} a @param {number} b @param {() => number} rnd @param {number} [dp] */
const between = (a, b, rnd, dp = 2) => Math.round((a + (b - a) * rnd()) * 10 ** dp) / 10 ** dp;

/**
 * Build one plausible mock alert (not yet stored).
 * @param {string} kind @param {{ rnd?: () => number, now?: Date }} [o]
 */
export function buildMockAlert(kind, o = {}) {
  const rnd = o.rnd ?? Math.random;
  const now = o.now ?? new Date();
  const subj = simSubjects();
  const station = subj.stations[Math.floor(rnd() * subj.stations.length)];
  const gp = subj.gps[Math.floor(rnd() * subj.gps.length)];
  const cls = config.riverCriteriaClass;
  const st = { station_no: station.id, station_name: station.name, place: station.name, river: null };
  const g = { area_id: gp.id, gp_name: gp.name, block: 'Test block', district: 'Test district' };
  const sampleBase = { sample_id: `SIM-${now.getTime()}`, village_name: null, source_type: 'Test source', source_name: 'a test tap', lab_name: 'Test laboratory',
    collected_at: new Date(now.getTime() - 9 * 86400_000), analysed_at: new Date(now.getTime() - 6 * 86400_000), reported_at: new Date(now.getTime() - 86400_000), first_seen_at: now, report_url: null };
  /** @type {{ title: string, body: any }} */
  let a;
  let where = gp;
  switch (kind) {
    case 'river_threshold': {
      const p = rnd() < 0.5 ? { parameter: 'DO', value: between(2.1, 3.9, rnd), unit: 'mg/l' } : rnd() < 0.5 ? { parameter: 'BOD', value: between(3.4, 9, rnd), unit: 'mg/l' } : { parameter: 'pH', value: between(9.1, 9.8, rnd), unit: null };
      a = riverAlert('river_threshold', st, { ...p, measured_at: now, limit: RIVER_CRITERIA[cls][p.parameter], criteria_class: cls });
      where = station; break;
    }
    case 'river_recovered':
      a = riverAlert('river_recovered', st, { parameter: 'DO', value: between(4.6, 7.2, rnd), unit: 'mg/l', measured_at: now, limit: RIVER_CRITERIA[cls].DO, criteria_class: cls });
      where = station; break;
    case 'river_spike': {
      const med = between(8, 25, rnd, 1);
      a = riverAlert('river_spike', st, { parameter: 'WTb', value: Math.round(med * between(5, 14, rnd, 1)), unit: 'NTU', measured_at: now, z: between(5, 12, rnd, 1), median: med, direction: 'up' });
      where = station; break;
    }
    case 'river_station_silent':
      a = silentAlert(st, new Date(now.getTime() - between(6.5, 30, rnd, 1) * 3600_000));
      where = station; break;
    case 'tap_contamination': {
      const r = rnd() < 0.5
        ? { parameter_label: 'E. coli', value_text: String(between(2, 40, rnd, 0)), unit: 'CFU/100 ml', acceptable_text: 'Shall not be detectable in any 100 ml sample', permissible_text: 'No Relaxation', status: 'above_permissible' }
        : { parameter_label: 'Fluoride (as F)', value_text: between(1.6, 3.2, rnd).toFixed(2), unit: 'mg/l', acceptable_text: '1', permissible_text: '1.5', status: 'above_permissible' };
      a = tapAlert('tap_contamination', g, sampleBase, [r]); break;
    }
    case 'tap_caution':
      a = tapAlert('tap_caution', g, sampleBase, [{ parameter_label: 'Total dissolved solids', value_text: String(between(560, 1900, rnd, 0)), unit: 'mg/l', acceptable_text: '500', permissible_text: '2000', status: 'above_acceptable' }]);
      break;
    case 'tap_all_clear':
      a = tapAlert('tap_all_clear', g, sampleBase, []); break;
    case 'tap_overdue':
      a = overdueAlert(g, rnd() < 0.5 ? 'chemical' : 'bacteriological', new Date(now.getTime() - between(13, 20, rnd, 0) * 30.44 * 86400_000), now, '1 Apr 2025');
      break;
    case 'regional_geogenic':
    default:
      a = geogenicAlert({ parameter_label: 'Fluoride', unit: 'mg/l', permissible_text: '1.5', count_above: Math.round(between(2, 9, rnd, 0)), count_tested: Math.round(between(20, 60, rnd, 0)), radius_km: 15, fy: '2026-2027',
        nearest: { gp_name: gp.name, area_id: gp.id, distance_km: between(2, 9, rnd, 1), value_text: between(1.6, 2.6, rnd).toFixed(2), collected_at: null } });
      kind = 'regional_geogenic';
  }
  a.body.simulated = true;
  a.body.site_path = `/?sim=${encodeURIComponent(where.id)}`;
  return { kind, title: a.title, body: a.body, lat: where.lat, lng: where.lng, subject_ref: `sim:${where.id}` };
}

/**
 * Store one mock alert and fan it out (matching is purely spatial, as for real alerts).
 * @param {import('./db.js').Sql} sql @param {string} [kind]
 */
export async function fireMockAlert(sql, kind) {
  const k = kind && SIM_KINDS.includes(/** @type {any} */ (kind)) ? kind : pickKind();
  const m = buildMockAlert(k);
  const res = await createAlert(sql, { ...m, is_mock: true, dedupe_key: `sim:${m.kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` });
  return { ...res, kind: m.kind, title: m.title };
}

/** Seed (idempotently) the confirmed mock subscription for MOCK_EMAIL at the mock point. @param {import('./db.js').Sql} sql */
export async function seedMockSubscription(sql) {
  // Only one seeded simulation subscriber at a time: changing or clearing MOCK_EMAIL retires the previous one.
  await sql`update subscription set unsubscribed_at = now() where is_mock and email <> ${config.mockEmail} and unsubscribed_at is null`;
  if (!config.mockEmail) return null; // people subscribe at the simulation point from the site instead
  const [existing] = await sql`select id from subscription where is_mock and email = ${config.mockEmail} and unsubscribed_at is null limit 1`;
  if (existing) {
    await sql`update subscription set geom = ST_SetSRID(ST_MakePoint(${config.mockLng}, ${config.mockLat}), 4326)::geography where id = ${existing.id}`;
    return existing.id;
  }
  const [row] = await sql`
    insert into subscription (email, geom, radius_km, kinds, confirmed_at, unsubscribe_token, is_mock)
    values (${config.mockEmail}, ST_SetSRID(ST_MakePoint(${config.mockLng}, ${config.mockLat}), 4326)::geography, 15, ${ALL_GROUPS},
            now(), ${crypto.randomUUID().replace(/-/g, '')}, true)
    returning id`;
  return row.id;
}
