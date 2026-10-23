// @ts-check
// Daily 10:00 IST: keep one snapshot of the national and state-wise "yesterday" numbers per day.
import { istDate } from '@lt/core/time.js';
import { WqmisClient } from '../lib/wqmis.js';
import { runSource, SchemaError } from '../lib/source.js';
import { oneShot } from '../lib/one-shot.js';

/** @param {import('@lt/core/db.js').Sql} sql @param {WqmisClient} [client] @param {Date} [now] */
export async function dashboardCycle(sql, client = new WqmisClient(), now = new Date()) {
  const { main, states } = await client.dashboards();
  if (!main.data && !states.states.length) throw new SchemaError([...main.warnings, ...states.warnings].join('; '));
  const day = istDate(now);
  const upsert = (/** @type {string} */ scope, /** @type {any} */ payload) => sql`
    insert into wq_daily_snapshot (snapshot_date, scope, payload) values (${day}, ${scope}, ${sql.json(payload)})
    on conflict (snapshot_date, scope) do update set payload = excluded.payload`;
  if (main.data) await upsert('national', { ...main.data, fetched_at: now.toISOString() });
  if (states.states.length) await upsert('states', { states: states.states, fetched_at: now.toISOString() });
  return { records: (main.data ? 1 : 0) + states.states.length, newest_data_at: now, notes: { states: states.states.length, warnings: [...main.warnings, ...states.warnings] } };
}

/** @param {import('@lt/core/db.js').Sql} sql */
export const dashboardJob = (sql) => runSource(sql, 'wqmis-dashboard', () => dashboardCycle(sql));

/** One-shot entrypoint (services/worker/run-once.js, used by GitHub Actions). */
export async function run() {
  return oneShot((sql) => dashboardJob(sql));
}
