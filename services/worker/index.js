// @ts-check
// Worker entry point. Jobs are registered in ./schedule.js.
import { fileURLToPath } from 'node:url';
import { createSql } from '@lt/core/db.js';
import { migrate } from '@lt/core/migrate.js';
import { logger } from '@lt/core/log.js';

const log = logger('worker');
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

const sql = createSql({ max: 5 });
for (let attempt = 1; ; attempt++) {
  try { await migrate(sql, MIGRATIONS_DIR, (m) => log.info(m)); break; } catch (err) {
    if (attempt >= 10) throw err;
    log.warn('migration failed; retrying', { attempt, error: String(err) });
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const { startSchedule } = await import('./schedule.js');
const stop = await startSchedule(sql);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    log.info('shutting down', { sig });
    await stop();
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { error: String(err) }));
process.on('uncaughtException', (err) => log.error('uncaught exception', { error: String(err), stack: err.stack }));
