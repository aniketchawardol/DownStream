// @ts-check
import { createMailer } from '@lt/core/email/mailer.js';
import health from './health.js';
import stations from './stations.js';
import areas from './areas.js';
import nearby from './nearby.js';
import subscriptions from './subscriptions.js';
import misc from './misc.js';
import dev from './dev.js';

/**
 * Every /api route. Validation errors come back as { error, message } in plain words.
 * @param {import('fastify').FastifyInstance} app
 * @param {{ sql: import('@lt/core/db.js').Sql, config: typeof import('@lt/core/config.js').config, mailer?: import('@lt/core/email/mailer.js').Mailer, prefix?: string }} opts
 */
export default async function routes(app, { prefix: _prefix, ...deps }) {
  const mailer = deps.mailer ?? createMailer();
  app.setErrorHandler((err, req, reply) => {
    const e = /** @type {any} */ (err);
    if (e.validation) return reply.code(400).send({ error: 'bad_request', message: `Check the request: ${e.message}.` });
    if (e.statusCode === 429) return reply.code(429).send({ error: 'rate_limited', message: 'Too many requests. Wait a little and try again.' });
    req.log.error({ err }, 'request failed');
    return reply.code(e.statusCode && e.statusCode < 500 ? e.statusCode : 500).send({ error: 'server_error', message: 'Something went wrong on our side. Try again in a minute.' });
  });
  await app.register(health, deps);
  await app.register(stations, deps);
  await app.register(areas, deps);
  await app.register(nearby, deps);
  await app.register(subscriptions, { ...deps, mailer });
  await app.register(misc, deps);
  if (deps.config.mockMode) await app.register(dev, deps);
}
