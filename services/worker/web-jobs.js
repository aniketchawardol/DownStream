// @ts-check
// The frequent jobs, run inside the web service (WEB_JOBS=true) so they don't wait on GitHub's scheduler,
// which drops runs under load. Mail goes out through the HTTPS relay (EMAIL_RELAY_URL): Render's free plan
// blocks SMTP ports, so without a relay the mailer is left to GitHub Actions.
// The heavy WQMIS crawls stay on GitHub Actions: they take hours and would starve a 512 MB free instance.
import cron from 'node-cron';
import { config } from '@lt/core/config.js';
import { logger } from '@lt/core/log.js';
import { seedMockSubscription } from '@lt/core/simulator.js';
import { cpcbJob } from './jobs/cpcb.js';
import { mailerJob } from './jobs/mailer.js';
import { startSimulator } from './jobs/simulator.js';

const log = logger('web-jobs');

/** @param {import('@lt/core/db.js').Sql} sql @returns {Promise<() => void>} stop */
export async function startWebJobs(sql) {
  /** @type {Set<string>} */
  const running = new Set();
  /** @param {string} name @param {() => Promise<unknown>} fn */
  const guarded = (name, fn) => {
    if (running.has(name)) return;
    running.add(name);
    fn().catch((err) => log.error('job crashed', { job: name, error: String(err) })).finally(() => running.delete(name));
  };
  const tz = { timezone: 'Asia/Kolkata' };
  const canMail = !!config.emailRelayUrl || config.emailDelivery === 'inline';
  const tasks = [cron.schedule('*/15 * * * *', () => guarded('cpcb', () => cpcbJob(sql)), tz)];
  if (canMail) tasks.push(cron.schedule('* * * * *', () => guarded('mailer', () => mailerJob(sql)), tz));
  else log.warn('mailer not started: set EMAIL_RELAY_URL (SMTP is blocked here); GitHub Actions sends mail meanwhile');

  // Render's free plan sleeps after 15 minutes without inbound requests. A request to our own public URL
  // arrives through Render's proxy like any other. GitHub's tick workflow pings too, to wake it if it slept.
  const ping = async () => {
    try {
      const r = await fetch(`${config.publicBaseUrl}/api/health`, { signal: AbortSignal.timeout(30_000) });
      log.info('keepalive', { status: r.status });
    } catch (err) { log.warn('keepalive failed', { error: String(err) }); }
  };
  if (/^https:/.test(config.publicBaseUrl)) tasks.push(cron.schedule('*/10 * * * *', ping, tz));

  /** @type {(() => void) | null} */
  let stopSim = null;
  if (config.mockMode) {
    await seedMockSubscription(sql);
    stopSim = startSimulator(sql);
  }
  log.info('web jobs started', { mailer: canMail, simulator: config.mockMode, every_min: [config.mockIntervalMin, config.mockIntervalMax] });
  return () => { for (const t of tasks) t.stop(); stopSim?.(); };
}
