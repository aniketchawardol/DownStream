// @ts-check
// The one public process: JSON API under /api, plus the built frontend (web/dist) for every other path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { config } from '@lt/core/config.js';
import { createSql } from '@lt/core/db.js';
import { migrate } from '@lt/core/migrate.js';
import { MIGRATIONS_DIR } from './migrate.js';
import routes from './routes/index.js';
import { firstPaint } from './first-paint.js';

const DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

/**
 * @param {{ sql?: import('@lt/core/db.js').Sql, logger?: boolean, mailer?: import('@lt/core/email/mailer.js').Mailer }} [opts]
 */
export async function buildApp(opts = {}) {
  const sql = opts.sql ?? createSql();
  const app = Fastify({
    logger: opts.logger ?? { level: config.nodeEnv === 'production' ? 'info' : 'warn' },
    trustProxy: true,
    bodyLimit: 16 * 1024,
  });
  await app.register(rateLimit, { global: false });
  await app.register(routes, { prefix: '/api', sql, config, mailer: opts.mailer });

  if (fs.existsSync(path.join(DIST, 'index.html'))) {
    const page = firstPaint(sql, fs.readFileSync(path.join(DIST, 'index.html'), 'utf8'));
    const sendPage = async (/** @type {import('fastify').FastifyReply} */ reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(await page());
    await app.register(fastifyStatic, {
      root: DIST,
      wildcard: false,
      index: false,
      // @fastify/static v10 passes the Fastify reply here, not the raw response.
      setHeaders(/** @type {any} */ reply, /** @type {string} */ filePath) {
        // Vite fingerprints everything under assets/, so those can be cached forever.
        const immutable = filePath.includes(`${path.sep}assets${path.sep}`) || filePath.includes('/assets/');
        reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url === '/api') return reply.code(404).send({ error: 'not_found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(404).send({ error: 'not_found' });
      if (path.extname(req.url.split('?')[0])) return reply.code(404).send('Not found');
      return sendPage(reply);
    });
    app.get('/', (_req, reply) => sendPage(reply));
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));
  }

  app.addHook('onClose', async () => { if (!opts.sql) await sql.end({ timeout: 5 }); });
  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const bootSql = createSql({ max: 1 });
  for (let attempt = 1; ; attempt++) {
    try { await migrate(bootSql, MIGRATIONS_DIR); break; } catch (err) {
      if (attempt >= 10) throw err;
      console.warn(`migration attempt ${attempt} failed (${/** @type {Error} */ (err).message}); retrying in 3 s`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  await bootSql.end({ timeout: 5 });
  const app = await buildApp({ logger: true });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { app.close().finally(() => process.exit(0)); });
}
