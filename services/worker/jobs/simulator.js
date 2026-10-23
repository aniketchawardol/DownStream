// @ts-check
// MOCK_MODE only. Two ways to run:
// - Local worker: one simulated alert at a random interval of MOCK_INTERVAL_MIN..MAX minutes (startSimulator).
// - GitHub Actions: invoked on a fixed 5-minute schedule; each run flips a coin (~50%) so alerts stay sporadic (run).
import { config } from '@lt/core/config.js';
import { logger } from '@lt/core/log.js';
import { fireMockAlert, seedMockSubscription } from '@lt/core/simulator.js';
import { oneShot } from '../lib/one-shot.js';

const log = logger('simulator');
export const FIRE_CHANCE = 0.5;

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
 * One scheduled tick: keep the optional seeded subscriber in step with MOCK_EMAIL, then maybe fire.
 * @param {import('@lt/core/db.js').Sql} sql @param {() => number} [rnd]
 */
export async function simulatorTick(sql, rnd = Math.random) {
  if (!config.mockMode) return { fired: false, reason: 'MOCK_MODE is off' };
  await seedMockSubscription(sql);
  if (rnd() >= FIRE_CHANCE) return { fired: false, reason: 'coin said not this time' };
  const r = await fireMockAlert(sql);
  log.info('simulated alert', { kind: r.kind, title: r.title, deliveries: r.deliveries });
  return { fired: true, kind: r.kind, title: r.title, deliveries: r.deliveries };
}

/** One-shot entrypoint (services/worker/run-once.js, used by GitHub Actions). */
export async function run() {
  return oneShot((sql) => simulatorTick(sql));
}
