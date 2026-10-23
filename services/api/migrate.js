// @ts-check
// One-shot migration runner (the `migrate` compose service). server.js runs the same logic at boot.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSql } from '@lt/core/db.js';
import { migrate } from '@lt/core/migrate.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const sql = createSql({ max: 1 });
  try {
    for (let attempt = 1; ; attempt++) {
      try { await migrate(sql, MIGRATIONS_DIR); break; } catch (err) {
        if (attempt >= 10) throw err;
        console.warn(`migration attempt ${attempt} failed (${/** @type {Error} */ (err).message}); retrying in 3 s`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  } catch (err) {
    console.error('migration failed:', err);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
