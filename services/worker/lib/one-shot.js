// @ts-check
// Run one job against its own short-lived connection pool, print the result, and set the exit code:
// a source failure exits 1 (a red run in GitHub Actions); a circuit-breaker skip exits 0.
import { createSql } from '@lt/core/db.js';

/**
 * @template T
 * @param {(sql: import('@lt/core/db.js').Sql) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function oneShot(fn) {
  const sql = createSql({ max: 3 });
  try {
    const result = await fn(sql);
    console.log(JSON.stringify(result ?? null));
    const r = /** @type {any} */ (result);
    if (r && r.ok === false && !r.skipped) process.exitCode = 1;
    return result;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
