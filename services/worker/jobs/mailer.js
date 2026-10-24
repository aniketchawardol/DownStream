// @ts-check
// Every minute: send pending deliveries.
// - Urgent alerts go out at the next tick, always (they ignore both the window and the daily cap).
// - Otherwise an address gets at most one alert email per 15-minute window: alerts arriving within a window
//   of the previous email wait and are bundled into the next one.
// - At most MAX_EMAILS_PER_DAY alert emails per address per IST day; non-urgent overflow goes to the digest.
// - Simulated and real alerts never share an email.
import { config } from '@lt/core/config.js';
import { logger } from '@lt/core/log.js';
import { createMailer } from '@lt/core/email/mailer.js';
import { renderAlertEmail, renderConfirmation } from '@lt/core/email/templates.js';
import { istDayStart } from '@lt/core/time.js';
import { oneShot } from '../lib/one-shot.js';

const log = logger('mailer');
export const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

/**
 * Pure decision for one subscription's pending bundle.
 * @param {{ hasUrgent: boolean, lastSentAt: Date|null, sentToday: number, now: Date, cap: number }} p
 * @returns {'send'|'wait'|'to_digest'}
 */
export function decide(p) {
  if (p.hasUrgent) return 'send';
  if (p.sentToday >= p.cap) return 'to_digest';
  if (p.lastSentAt && p.now.getTime() - p.lastSentAt.getTime() < WINDOW_MS) return 'wait';
  return 'send';
}

/**
 * Confirmation emails the web service queued (EMAIL_DELIVERY=queue). Each row is claimed before sending so it
 * goes out once even if two mailers overlap; a failed send is released for the next run. Gives up after a day.
 * @param {import('@lt/core/db.js').Sql} sql @param {import('@lt/core/email/mailer.js').Mailer} mailer
 */
export async function sendQueuedConfirmations(sql, mailer) {
  const claimed = await sql`
    update subscription s set confirm_sent_at = now()
    where s.id in (
      select id from subscription
      where confirmed_at is null and confirm_sent_at is null and unsubscribed_at is null and created_at > now() - interval '1 day'
      order by created_at limit 50 for update skip locked)
    returning s.id, s.email, s.radius_km, s.kinds, s.confirm_token, s.unsubscribe_token,
      ST_Y(s.geom::geometry) as lat, ST_X(s.geom::geometry) as lng,
      (select g.name from wq_area g where g.level = 'gp' and g.geom is not null and g.geocode_confidence >= 0.5
       order by g.geom <-> s.geom limit 1) as near`;
  let sent = 0;
  for (const s of claimed) {
    const msg = renderConfirmation({ ...s, kinds: s.kinds }, config.publicBaseUrl);
    try {
      await mailer.send({ to: s.email, ...msg });
      await sql`insert into email_message (subscription_id, kind, subject) values (${s.id}, 'confirm', ${msg.subject})`;
      sent++;
    } catch (err) {
      await sql`update subscription set confirm_sent_at = null where id = ${s.id}`;
      log.error('confirmation send failed; will retry', { error: String(/** @type {Error} */ (err).message).slice(0, 200) });
    }
  }
  if (claimed.length) log.info('queued confirmations sent', { sent, of: claimed.length });
  return sent;
}

/**
 * @param {import('@lt/core/db.js').Sql} sql
 * @param {{ mailer?: import('@lt/core/email/mailer.js').Mailer, now?: Date }} [deps]
 */
export async function mailerCycle(sql, deps = {}) {
  const mailer = deps.mailer ?? createMailer();
  const now = deps.now ?? new Date();
  const confirmations = await sendQueuedConfirmations(sql, mailer);
  // Deliveries for subscriptions that have since been unsubscribed are dropped.
  await sql`
    update delivery d set status = 'skipped', error = 'unsubscribed'
    from subscription s where s.id = d.subscription_id and d.status in ('pending', 'digest') and s.unsubscribed_at is not null`;
  const pending = await sql`
    select d.alert_id, d.subscription_id, d.error, a.kind, a.severity, a.title, a.body, a.is_mock,
           ST_Y(a.geom::geometry) as lat, ST_X(a.geom::geometry) as lng,
           s.email, s.radius_km, s.unsubscribe_token, ST_Y(s.geom::geometry) as sub_lat, ST_X(s.geom::geometry) as sub_lng
    from delivery d
    join alert a on a.id = d.alert_id
    join subscription s on s.id = d.subscription_id
    where d.status = 'pending' and s.confirmed_at is not null
    order by d.created_at`;
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const p of pending) {
    const k = `${p.subscription_id}|${p.is_mock}`;
    if (!groups.has(k)) groups.set(k, []);
    /** @type {any[]} */ (groups.get(k)).push(p);
  }
  let sent = 0, waited = 0, digested = 0, failed = 0;
  const dayStart = istDayStart(now);
  for (const items of groups.values()) {
    const first = items[0];
    const [{ last, today }] = await sql`
      select max(sent_at) as last, count(*) filter (where sent_at >= ${dayStart})::int as today
      from email_message where subscription_id = ${first.subscription_id} and kind = 'alerts' and error is null`;
    const action = decide({ hasUrgent: items.some((i) => i.severity === 'urgent'), lastSentAt: last, sentToday: today, now, cap: config.maxEmailsPerDay });
    const ids = items.map((i) => i.alert_id);
    if (action === 'wait') { waited += items.length; continue; }
    if (action === 'to_digest') {
      await sql`update delivery set status = 'digest', error = 'daily cap reached' where subscription_id = ${first.subscription_id} and alert_id = any(${ids}) and status = 'pending'`;
      digested += items.length;
      continue;
    }
    const email = renderAlertEmail(
      { lat: first.sub_lat, lng: first.sub_lng, radius_km: first.radius_km, unsubscribe_token: first.unsubscribe_token },
      items.map((i) => ({ kind: i.kind, title: i.title, body: i.body, lat: i.lat, lng: i.lng, is_mock: i.is_mock, severity: i.severity })),
      config.publicBaseUrl,
    );
    try {
      await mailer.send({ to: first.email, ...email });
      const [msg] = await sql`
        insert into email_message (subscription_id, kind, subject, is_mock) values (${first.subscription_id}, 'alerts', ${email.subject}, ${first.is_mock})
        returning id`;
      await sql`update delivery set status = 'sent', sent_at = now(), error = null, message_id = ${msg.id}
                where subscription_id = ${first.subscription_id} and alert_id = any(${ids}) and status = 'pending'`;
      sent++;
      log.info('alert email sent', { alerts: items.length, mock: first.is_mock, subject: email.subject });
    } catch (err) {
      failed++;
      const msg = String(/** @type {Error} */ (err).message).slice(0, 300);
      const attempts = Number(String(first.error ?? '').match(/^attempt (\d+)/)?.[1] ?? 0) + 1;
      await sql`update delivery set status = ${attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'}, error = ${`attempt ${attempts}: ${msg}`}
                where subscription_id = ${first.subscription_id} and alert_id = any(${ids}) and status = 'pending'`;
      log.error('send failed', { attempts, error: msg });
    }
  }
  return { confirmations, sent, waited, digested, failed };
}

/** @param {import('@lt/core/db.js').Sql} sql */
export const mailerJob = async (sql) => {
  try { return await mailerCycle(sql); } catch (err) { log.error('mailer cycle failed', { error: String(err) }); return null; }
};

/** One-shot entrypoint (services/worker/run-once.js, used by GitHub Actions). */
export async function run() {
  return oneShot((sql) => mailerJob(sql));
}
