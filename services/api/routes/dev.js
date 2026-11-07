// @ts-check
// Simulation-only routes (registered when MOCK_MODE=true):
// - POST /api/dev/simulate fires one random simulated alert now.
// - POST /api/dev/report broadcasts a citizen report. Its place is fixed here, at the simulation test point,
//   whatever the client sends, so it only ever reaches people who subscribed there for simulated alerts.
import { fireMockAlert, SIM_KINDS } from '@lt/core/simulator.js';
import { createAlert } from '@lt/core/alerts/store.js';
import { CITIZEN_ISSUES, CITIZEN_WATER, DETAILS_MAX, HAS_LINK, buildCitizenReport, cleanDetails } from '@lt/core/alerts/citizen.js';

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

  app.post('/dev/report', {
    config: { rateLimit: { max: 6, timeWindow: '10 minutes' } },
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['issue', 'water'],
        properties: {
          issue: { type: 'string', enum: Object.keys(CITIZEN_ISSUES) },
          water: { type: 'string', enum: Object.keys(CITIZEN_WATER) },
          details: { type: 'string', maxLength: DETAILS_MAX * 2 },
          urgent: { type: 'boolean', default: false },
        },
      },
    },
  }, async (req, reply) => {
    const b = /** @type {{ issue: any, water: 'river'|'tap', details?: string, urgent?: boolean }} */ (req.body);
    const details = cleanDetails(b.details ?? '');
    if (details.length > DETAILS_MAX) return reply.code(400).send({ error: 'too_long', message: `Keep the details to ${DETAILS_MAX} characters.` });
    if (HAS_LINK.test(details)) return reply.code(400).send({ error: 'no_links', message: 'Links and web addresses aren’t allowed in reports. Describe what you saw instead.' });
    if (b.issue === 'other' && details.length < 10) return reply.code(400).send({ error: 'need_details', message: 'For “Something else”, describe what you saw in a few words.' });
    const a = buildCitizenReport({ ...b, details });
    const r = await createAlert(sql, { ...a, is_mock: true, dedupe_key: `report:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` });
    req.log.info({ alert: r.id, deliveries: r.deliveries, urgent: a.severity === 'urgent' }, 'citizen report broadcast');
    return reply.code(201).send({ alert_id: r.id, title: a.title, severity: a.severity, deliveries: r.deliveries, lat: a.lat, lng: a.lng, site_path: a.body.site_path });
  });
}
