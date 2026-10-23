// @ts-check
// All schedules from section 6, in IST. Jobs never overlap themselves, and WQMIS jobs share one lane so
// the government server only ever sees one crawler at a time.
import cron from 'node-cron';
import { config } from '@lt/core/config.js';
import { logger } from '@lt/core/log.js';
import { seedMockSubscription } from '@lt/core/simulator.js';
import { cpcbJob } from './jobs/cpcb.js';
import { hierarchyJob } from './jobs/wqmis-hierarchy.js';
import { samplesJob, reportsJob } from './jobs/wqmis-samples.js';
import { dashboardJob } from './jobs/wqmis-dashboard.js';
import { geocodeJob } from './jobs/geocode.js';
import { overdueJob } from './jobs/overdue.js';
import { digestJob } from './jobs/digest.js';
import { mailerJob } from './jobs/mailer.js';
import { startSimulator } from './jobs/simulator.js';
import { pruneRaw } from './lib/http.js';
import { istDate } from '@lt/core/time.js';

const log = logger('schedule');

/** @param {import('@lt/core/db.js').Sql} sql */
export async function startSchedule(sql) {
  /** @type {Set<string>} */
  const running = new Set();
  /** @type {Promise<unknown>} */
  let wqmisLane = Promise.resolve();

  /** Run fn unless it's already running. @param {string} name @param {() => Promise<unknown>} fn @param {{ lane?: 'wqmis' }} [o] */
  const guarded = (name, fn, o = {}) => {
    if (running.has(name)) { log.warn('skipping overlapping run', { job: name }); return Promise.resolve(); }
    running.add(name);
    const go = () => fn().catch((err) => log.error('job crashed', { job: name, error: String(err) })).finally(() => running.delete(name));
    if (o.lane === 'wqmis') { wqmisLane = wqmisLane.then(go); return wqmisLane; }
    return go();
  };

  const tz = { timezone: 'Asia/Kolkata' };
  const tasks = [
    cron.schedule('*/15 * * * *', () => guarded('cpcb', () => cpcbJob(sql)), tz),
    cron.schedule('0 1 * * 0', () => guarded('wqmis-hierarchy', async () => { await hierarchyJob(sql); await geocodeJob(sql); }, { lane: 'wqmis' }), tz),
    cron.schedule('0 2 * * *', () => guarded('wqmis-samples', () => samplesJob(sql), { lane: 'wqmis' }), tz),
    cron.schedule('20 * * * *', () => guarded('wqmis-reports', () => reportsJob(sql), { lane: 'wqmis' }), tz),
    cron.schedule('0 10 * * *', () => guarded('wqmis-dashboard', () => dashboardJob(sql), { lane: 'wqmis' }), tz),
    cron.schedule('0 7 * * *', () => guarded('overdue', () => overdueJob(sql)), tz),
    cron.schedule('0 8 * * 1', () => guarded('digest', () => digestJob(sql)), tz),
    cron.schedule('* * * * *', () => guarded('mailer', () => mailerJob(sql)), tz),
    cron.schedule('30 3 * * *', () => guarded('prune-raw', async () => log.info('raw archive pruned', { days_removed: await pruneRaw(30) })), tz),
  ];

  /** @type {(() => void) | null} */
  let stopSim = null;
  if (config.mockMode) {
    const id = await seedMockSubscription(sql);
    log.info('simulation mode on', { seeded_subscriber: id ? config.mockEmail : 'none (MOCK_EMAIL empty)', at: [config.mockLat, config.mockLng], every_min: [config.mockIntervalMin, config.mockIntervalMax] });
    stopSim = startSimulator(sql);
  }

  // Bootstrap: fill an empty database without waiting for the first scheduled slot. Keyed on each
  // job's last success, so a run interrupted by a restart is simply run again.
  (async () => {
    await guarded('cpcb', () => cpcbJob(sql));
    const ok = async (/** @type {string} */ source, /** @type {string} */ within) => {
      const [r] = await sql`select 1 from source_health where source = ${source} and last_success_at > now() - ${within}::interval`;
      return !!r;
    };
    if (!(await ok('wqmis-hierarchy', '7 days'))) await guarded('wqmis-hierarchy', () => hierarchyJob(sql), { lane: 'wqmis' });
    const [{ ungeocoded }] = await sql`select count(*)::int as ungeocoded from wq_area where level = 'gp' and geom is null`;
    if (ungeocoded || !(await ok('geocode', '30 days'))) await guarded('geocode', () => geocodeJob(sql), { lane: 'wqmis' });
    if (!(await ok('wqmis-samples', '1 day'))) await guarded('wqmis-samples', () => samplesJob(sql), { lane: 'wqmis' });
    const [{ snaps }] = await sql`select count(*)::int as snaps from wq_daily_snapshot where snapshot_date = ${istDate()}`;
    if (!snaps) await guarded('wqmis-dashboard', () => dashboardJob(sql), { lane: 'wqmis' });
    log.info('bootstrap finished');
  })().catch((err) => log.error('bootstrap failed', { error: String(err) }));

  log.info('schedules registered', { jobs: tasks.length, mock_mode: config.mockMode });
  return async () => {
    for (const t of tasks) t.stop();
    stopSim?.();
  };
}
