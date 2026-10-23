// @ts-check
// Run one named job once and exit. Production schedules (GitHub Actions) call this; the local Docker worker
// keeps running every job in-process with node-cron (services/worker/index.js).
//   node services/worker/run-once.js <job-name>
// Jobs: cpcb, wqmis-hierarchy, wqmis-samples, wqmis-reports, wqmis-dashboard, geocode, overdue, digest,
//       mailer, simulator, bootstrap
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSql } from '@lt/core/db.js';
import { migrate } from '@lt/core/migrate.js';

const jobName = process.argv[2];
const file = jobName && new URL(`./jobs/${jobName}.js`, import.meta.url);
if (!jobName || !/^[a-z-]+$/.test(jobName) || !file || !fs.existsSync(fileURLToPath(file))) {
  console.error('usage: node services/worker/run-once.js <job-name>');
  process.exit(1);
}
const mod = await import(file.href);
if (typeof mod.run !== 'function') {
  console.error(`jobs/${jobName}.js has no run() entrypoint`);
  process.exit(1);
}

// The web service migrates at boot, but a job may run first on a fresh deploy. Idempotent and lock-guarded.
const sql = createSql({ max: 1 });
try { await migrate(sql, fileURLToPath(new URL('../../db/migrations/', import.meta.url)), () => {}); } finally { await sql.end({ timeout: 5 }); }

await mod.run();
process.exit(process.exitCode ?? 0);
