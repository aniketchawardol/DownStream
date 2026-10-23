// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';

const LOCK_ID = 727_274_001; // arbitrary; shared by every process that migrates

/**
 * Apply pending db/migrations/*.sql in name order inside one transaction,
 * serialised across processes (web and worker booting together) with an advisory lock.
 * @param {import('./db.js').Sql} sql
 * @param {string} dir
 * @param {(msg: string) => void} [log]
 */
export async function migrate(sql, dir, log = console.log) {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  /** @type {string[]} */
  const applied = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())`;
    const done = new Set((await tx`select name from schema_migrations`).map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const text = await fs.readFile(path.join(dir, f), 'utf8');
      await tx.unsafe(text).simple();
      await tx`insert into schema_migrations (name) values (${f})`;
      applied.push(f);
    }
  });
  log(applied.length ? `migrations applied: ${applied.join(', ')}` : 'migrations: up to date');
  return applied;
}
