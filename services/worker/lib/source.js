// @ts-check
// Wraps one run of a source job: records the attempt in source_health, opens a 1-hour circuit
// after 5 consecutive failures, and never lets an error escape (the worker must not crash).
import { logger } from '@lt/core/log.js';

export const BREAKER_THRESHOLD = 5;
export const BREAKER_OPEN_MS = 3600_000;

/** Thrown when a response doesn't look like what the parser expects. Last good data stays in place. */
export class SchemaError extends Error {}

/**
 * @typedef {{ records: number, newest_data_at?: Date|null, notes?: Record<string, unknown> }} RunResult
 * @param {import('@lt/core/db.js').Sql} sql
 * @param {string} source e.g. 'cpcb', 'wqmis-samples'
 * @param {() => Promise<RunResult>} fn
 * @returns {Promise<(RunResult & { ok: true }) | { ok: false, skipped?: boolean, error?: string }>}
 */
export async function runSource(sql, source, fn) {
  const log = logger(source);
  const [h] = await sql`select consecutive_failures, circuit_open_until from source_health where source = ${source}`;
  if (h?.circuit_open_until && h.circuit_open_until.getTime() > Date.now()) {
    log.warn('circuit open; skipping run', { until: h.circuit_open_until.toISOString() });
    return { ok: false, skipped: true };
  }
  await sql`
    insert into source_health (source, last_attempt_at) values (${source}, now())
    on conflict (source) do update set last_attempt_at = now()`;
  const started = Date.now();
  try {
    const res = await fn();
    await sql`
      update source_health set
        last_success_at = now(), last_error = null, records_last_run = ${res.records},
        newest_data_at = coalesce(${res.newest_data_at ?? null}::timestamptz, newest_data_at),
        consecutive_failures = 0, circuit_open_until = null,
        notes = ${res.notes ? sql.json(/** @type {any} */ (res.notes)) : null}
      where source = ${source}`;
    log.info('run ok', { records: res.records, ms: Date.now() - started, ...(res.notes?.warnings ? { warnings: res.notes.warnings } : {}) });
    return { ok: true, ...res };
  } catch (err) {
    const e = /** @type {Error} */ (err);
    const failures = (h?.consecutive_failures ?? 0) + 1;
    const openUntil = failures >= BREAKER_THRESHOLD ? new Date(Date.now() + BREAKER_OPEN_MS) : null;
    const kind = e instanceof SchemaError ? 'schema' : 'fetch';
    // undici reports network failures as "fetch failed" with the useful part (ENOTFOUND, ECONNRESET...) in cause.
    const cause = /** @type {any} */ (e).cause;
    if (cause?.code || cause?.message) e.message = `${e.message} (${cause.code ?? cause.message})`;
    await sql`
      update source_health set
        last_error = ${`${kind}: ${e.message}`.slice(0, 500)},
        consecutive_failures = ${failures}, circuit_open_until = ${openUntil}
      where source = ${source}`.catch(() => {});
    log.error('run failed', { kind, error: e.message, failures, circuit_open_until: openUntil?.toISOString() ?? null });
    return { ok: false, error: e.message };
  }
}
