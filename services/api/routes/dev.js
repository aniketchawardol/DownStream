// @ts-check
// POST /api/dev/simulate: only registered when MOCK_MODE=true. Fires one simulated alert now.
import { fireMockAlert, SIM_KINDS } from '@lt/core/simulator.js';

/** @param {import('fastify').FastifyInstance} app @param {{ sql: import('@lt/core/db.js').Sql }} opts */
export default async function dev(app, { sql }) {
  app.post('/dev/simulate', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: [...SIM_KINDS] } } } },
  }, async (req, reply) => {
    const { kind } = /** @type {any} */ (req.query);
    const r = await fireMockAlert(sql, kind);
    return reply.code(201).send({ simulated: true, kind: r.kind, title: r.title, alert_id: r.id, deliveries: r.deliveries });
  });
}
