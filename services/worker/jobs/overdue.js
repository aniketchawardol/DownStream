// @ts-check
// Daily 07:00 IST: panchayats inside any "overdue" subscriber's circle with no chemical test in 12 months
// or no bacteriological test in 6 months. One alert per panchayat, test type and gap (keyed to the last test).
import { logger } from '@lt/core/log.js';
import { createAlert } from '@lt/core/alerts/store.js';
import { overdueAlert } from '@lt/core/alerts/describe.js';
import { istLongDate } from '@lt/core/time.js';
import { runSource } from '../lib/source.js';
import { oneShot } from '../lib/one-shot.js';

const log = logger('overdue');
export const OVERDUE_MONTHS = { chemical: 12, bacteriological: 6 };

/**
 * Pure decision: is this test type overdue? Knowledge only reaches back to the earliest FY we fetched.
 * @param {Date|null} lastTest @param {Date} now @param {number} months @param {Date} knownSince
 */
export function isOverdue(lastTest, now, months, knownSince) {
  const cutoff = new Date(now.getTime() - months * 30.44 * 86400_000);
  if (lastTest) return lastTest < cutoff;
  return knownSince <= cutoff; // never tested in the window we can see, and that window is long enough to judge
}

/** @param {import('@lt/core/db.js').Sql} sql @param {Date} [now] */
export async function overdueCycle(sql, now = new Date()) {
  const gps = await sql`
    select g.id, g.name, b.name as block_name, d.name as district_name,
           ST_Y(g.geom::geometry) as lat, ST_X(g.geom::geometry) as lng,
           (select max(coalesce(s.analysed_at, s.collected_at)) from wq_sample s where s.gp_area_id = g.id and 'chemical' = any(s.test_kinds)) as last_chemical,
           (select max(coalesce(s.analysed_at, s.collected_at)) from wq_sample s where s.gp_area_id = g.id and 'bacteriological' = any(s.test_kinds)) as last_bacteriological
    from wq_area g
    join wq_area b on b.id = g.parent_id
    join wq_area d on d.id = b.parent_id
    where g.level = 'gp' and g.geom is not null and g.samples_fetched_at is not null and g.geocode_confidence >= 0.5
      and exists (select 1 from subscription s where s.confirmed_at is not null and s.unsubscribed_at is null
                  and 'overdue' = any(s.kinds) and ST_DWithin(s.geom, g.geom, s.radius_km * 1000))`;
  const [{ since }] = await sql`select min(fy) as since from wq_sample`;
  const knownSince = since ? new Date(`${since.slice(0, 4)}-04-01T00:00:00+05:30`) : now;
  let created = 0;
  for (const g of gps) {
    for (const test of /** @type {const} */ (['chemical', 'bacteriological'])) {
      const last = test === 'chemical' ? g.last_chemical : g.last_bacteriological;
      if (!isOverdue(last, now, OVERDUE_MONTHS[test], knownSince)) continue;
      const { title, body } = overdueAlert({ area_id: g.id, gp_name: g.name, block: g.block_name, district: g.district_name }, test, last, now, istLongDate(knownSince));
      const res = await createAlert(sql, {
        kind: 'tap_overdue', subject_ref: `wqmis-gp:${g.id}:${test}`, lat: g.lat, lng: g.lng, title, body,
        dedupe_key: `tap_overdue:${g.id}:${test}:${last ? last.toISOString().slice(0, 10) : 'none'}`,
      });
      if (res.created) created++;
    }
  }
  log.info('overdue checked', { gps: gps.length, created });
  return { records: created, notes: { gps_checked: gps.length } };
}

/** @param {import('@lt/core/db.js').Sql} sql */
export const overdueJob = (sql) => runSource(sql, 'overdue', () => overdueCycle(sql));

/** One-shot entrypoint (services/worker/run-once.js, used by GitHub Actions). */
export async function run() {
  return oneShot((sql) => overdueJob(sql));
}
