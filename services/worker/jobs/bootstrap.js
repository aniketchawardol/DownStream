// @ts-check
// Fill an empty or stale database without waiting for each job's own slot: the same checks the local worker
// makes at startup, run once. Safe to repeat; each step is skipped when its source succeeded recently.
import { logger } from '@lt/core/log.js';
import { istDate } from '@lt/core/time.js';
import { oneShot } from '../lib/one-shot.js';
import { cpcbJob } from './cpcb.js';
import { hierarchyJob } from './wqmis-hierarchy.js';
import { geocodeJob } from './geocode.js';
import { samplesJob } from './wqmis-samples.js';
import { dashboardJob } from './wqmis-dashboard.js';

const log = logger('bootstrap');

/** @param {import('@lt/core/db.js').Sql} sql */
export async function bootstrapCycle(sql) {
  /** @param {string} source @param {string} within */
  const fresh = async (source, within) => {
    const [r] = await sql`select 1 from source_health where source = ${source} and last_success_at > now() - ${within}::interval`;
    return !!r;
  };
  /** @type {Record<string, unknown>} */
  const ran = {};
  if (!(await fresh('cpcb', '1 hour'))) ran.cpcb = (await cpcbJob(sql)).ok;
  if (!(await fresh('wqmis-hierarchy', '7 days'))) ran.hierarchy = (await hierarchyJob(sql)).ok;
  const [{ ungeocoded }] = await sql`select count(*)::int as ungeocoded from wq_area where level = 'gp' and geom is null`;
  if (ungeocoded || !(await fresh('geocode', '30 days'))) ran.geocode = (await geocodeJob(sql)).ok;
  if (!(await fresh('wqmis-samples', '1 day'))) ran.samples = (await samplesJob(sql)).ok;
  const [{ snaps }] = await sql`select count(*)::int as snaps from wq_daily_snapshot where snapshot_date = ${istDate()}`;
  if (!snaps) ran.dashboard = (await dashboardJob(sql)).ok;
  log.info('bootstrap finished', { ran });
  const failed = Object.values(ran).some((ok) => ok === false);
  return { ok: !failed, ran };
}

/** One-shot entrypoint (services/worker/run-once.js, used by GitHub Actions). */
export async function run() {
  return oneShot((sql) => bootstrapCycle(sql));
}
