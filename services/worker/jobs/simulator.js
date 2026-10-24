// @ts-check
// MOCK_MODE only. Every run fires one simulated alert; there's no coin flip. Two ways to run:
// - Local worker and the deployed web service: one alert every MOCK_INTERVAL_MIN..MAX minutes, the gap picked
//   at random each time (startSimulator).
// - One-shot (run-once.js): one alert per invocation (run).
import { config } from '@lt/core/config.js';
import { logger } from '@lt/core/log.js';
import { fireMockAlert, seedMockSubscription } from '@lt/core/simulator.js';
import { oneShot } from '../lib/one-shot.js';

const log = logger('simulator');

/** @param {import('@lt/core/db.js').Sql} sql @returns {() => void} stop */
export function startSimulator(sql) {
  /** @type {NodeJS.Timeout|undefined} */
  let timer;
  let stopped = false;
  const next = () => {
    const min = Math.max(0.1, config.mockIntervalMin);
    const max = Math.max(min, config.mockIntervalMax);
    const ms = (min + Math.random() * (max - min)) * 60_000;
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        const r = await fireMockAlert(sql);
        log.info('simulated alert', { kind: r.kind, title: r.title, deliveries: r.deliveries });
      } catch (err) {
        log.error('simulator failed', { error: String(err) });
      }
      next();
    }, ms);
  };
  next();
  return () => { stopped = true; clearTimeout(timer); };
}

/**
 * One tick: keep the optional seeded subscriber in step with MOCK_EMAIL, then fire.
 * @param {import('@lt/core/db.js').Sql} sql
 */
export async function simulatorTick(sql) {
  if (!config.mockMode) return { fired: false, reason: 'MOCK_MODE is off' };
  await seedMockSubscription(sql);
  const r = await fireMockAlert(sql);
  log.info('simulated alert', { kind: r.kind, title: r.title, deliveries: r.deliveries });
  return { fired: true, kind: r.kind, title: r.title, deliveries: r.deliveries };
}

/** One-shot entrypoint (services/worker/run-once.js, used by GitHub Actions). */
export async function run() {
  return oneShot((sql) => simulatorTick(sql));
}
