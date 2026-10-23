// @ts-check
// Double opt-in subscriptions. Nothing but the confirmation email is sent until the link is opened.
import crypto from 'node:crypto';
import { ALL_GROUPS } from '@lt/core/alerts/kinds.js';
import { renderConfirmation } from '@lt/core/email/templates.js';
import { inIndia } from '@lt/core/geo.js';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;
const PER_EMAIL_PER_HOUR = 3;
const token = () => crypto.randomBytes(24).toString('base64url');

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{ sql: import('@lt/core/db.js').Sql, config: any, mailer: import('@lt/core/email/mailer.js').Mailer }} opts
 */
export default async function subscriptions(app, { sql, config, mailer }) {
  app.post('/subscriptions', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['email', 'lat', 'lng', 'radius_km', 'kinds'],
        properties: {
          email: { type: 'string', minLength: 3, maxLength: 254 },
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
          radius_km: { type: 'number', minimum: 1, maximum: 50 },
          kinds: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', enum: ALL_GROUPS } },
        },
      },
    },
  }, async (req, reply) => {
    const b = /** @type {{ email: string, lat: number, lng: number, radius_km: number, kinds: string[] }} */ (req.body);
    const email = b.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'bad_email', message: 'That email address doesn’t look right. Check it and try again.' });
    if (!inIndia(b.lat, b.lng)) return reply.code(400).send({ error: 'outside_india', message: 'Drop the pin inside India. This site only covers Indian government data.' });
    const [{ recent }] = await sql`select count(*)::int as recent from subscription where email = ${email} and created_at > now() - interval '1 hour'`;
    if (recent >= PER_EMAIL_PER_HOUR) return reply.code(429).send({ error: 'too_many', message: 'Too many sign-ups for this address in the last hour. Try again later.' });

    const radius_km = Math.round(b.radius_km * 10) / 10;
    const sub = { email, lat: b.lat, lng: b.lng, radius_km, kinds: b.kinds, confirm_token: token(), unsubscribe_token: token() };
    const [near] = await sql`
      select g.name from wq_area g where g.level = 'gp' and g.geom is not null and g.geocode_confidence >= 0.5
      order by g.geom <-> ST_SetSRID(ST_MakePoint(${b.lng}, ${b.lat}), 4326)::geography limit 1`;
    const [row] = await sql`
      insert into subscription (email, geom, radius_km, kinds, confirm_token, unsubscribe_token)
      values (${email}, ST_SetSRID(ST_MakePoint(${b.lng}, ${b.lat}), 4326)::geography, ${radius_km}, ${b.kinds}, ${sub.confirm_token}, ${sub.unsubscribe_token})
      returning id`;
    const msg = renderConfirmation({ ...sub, near: near?.name ?? null }, config.publicBaseUrl);
    try {
      await mailer.send({ to: email, ...msg });
      await sql`insert into email_message (subscription_id, kind, subject) values (${row.id}, 'confirm', ${msg.subject})`;
    } catch (err) {
      req.log.error({ err }, 'confirmation email failed');
      await sql`delete from subscription where id = ${row.id}`;
      return reply.code(502).send({ error: 'email_failed', message: 'The confirmation email couldn’t be sent. Nothing was saved. Try again in a few minutes.' });
    }
    return reply.code(202).send({ status: 'confirmation_sent', email });
  });

  app.get('/subscriptions/confirm', {
    schema: { querystring: { type: 'object', required: ['token'], properties: { token: { type: 'string', minLength: 10, maxLength: 100 } } } },
  }, async (req, reply) => {
    const { token: t } = /** @type {any} */ (req.query);
    const [row] = await sql`
      update subscription set confirmed_at = coalesce(confirmed_at, now())
      where confirm_token = ${t} and unsubscribed_at is null
      returning id`;
    // Relative, so it lands on whichever host served the link (dev proxy, production, tests).
    return reply.redirect(`/?subscribed=${row ? 'ok' : 'invalid'}`, 303);
  });

  const unsubscribe = async (/** @type {string} */ t) => {
    const [row] = await sql`
      update subscription set unsubscribed_at = coalesce(unsubscribed_at, now())
      where unsubscribe_token = ${t}
      returning id`;
    return !!row;
  };
  const tokenQuery = { querystring: { type: 'object', required: ['token'], properties: { token: { type: 'string', minLength: 10, maxLength: 100 } } } };

  app.get('/unsubscribe', { schema: tokenQuery }, async (req, reply) => {
    const ok = await unsubscribe(/** @type {any} */ (req.query).token);
    return reply.redirect(`/?unsubscribed=${ok ? 'ok' : 'invalid'}`, 303);
  });

  // RFC 8058 one-click unsubscribe from the List-Unsubscribe-Post header.
  app.post('/unsubscribe', { schema: tokenQuery }, async (req, reply) => {
    const ok = await unsubscribe(/** @type {any} */ (req.query).token);
    return reply.code(ok ? 200 : 404).send({ status: ok ? 'unsubscribed' : 'not_found' });
  });
}
