// @ts-check
// Monday 08:00 IST: one weekly summary per digest subscriber. Real alerts and simulated counts are kept apart.
import { config } from '@lt/core/config.js';
import { logger } from '@lt/core/log.js';
import { createMailer } from '@lt/core/email/mailer.js';
import { renderDigest } from '@lt/core/email/templates.js';
import { humanAge, istLongDate } from '@lt/core/time.js';
import { stationMeta } from '@lt/core/stations.js';
import { oneShot } from '../lib/one-shot.js';

const log = logger('digest');
const STATUS_WORDS = { ok: 'all tested parameters within limits', above_acceptable: 'some results above the acceptable limit', above_permissible: 'some results above the permissible limit' };

/**
 * @param {import('@lt/core/db.js').Sql} sql
 * @param {{ mailer?: import('@lt/core/email/mailer.js').Mailer, now?: Date, onlySubscriptionId?: string }} [deps]
 */
export async function digestCycle(sql, deps = {}) {
  const mailer = deps.mailer ?? createMailer();
  const now = deps.now ?? new Date();
  const weekStart = new Date(now.getTime() - 7 * 86400_000);
  const only = deps.onlySubscriptionId ?? null;
  const subs = await sql`
    select id, email, radius_km, unsubscribe_token, ST_Y(geom::geometry) as lat, ST_X(geom::geometry) as lng
    from subscription
    where confirmed_at is not null and unsubscribed_at is null and 'digest' = any(kinds)
      and (${only}::uuid is null or id = ${only}::uuid)`;
  const [{ since }] = await sql`select min(fy) as since from wq_sample`;
  const knownSince = since ? istLongDate(new Date(`${since.slice(0, 4)}-04-01T00:00:00+05:30`)) : 'the start of our records';
  let sent = 0;
  for (const s of subs) {
    const pin = sql`ST_SetSRID(ST_MakePoint(${s.lng}, ${s.lat}), 4326)::geography`;
    const alerts = await sql`
      select a.kind, a.severity, a.title, a.body, a.is_mock, ST_Y(a.geom::geometry) as lat, ST_X(a.geom::geometry) as lng
      from alert a
      where a.created_at >= ${weekStart} and a.is_mock = false
        and (ST_DWithin(a.geom, ${pin}, ${s.radius_km * 1000})
             or exists (select 1 from delivery d where d.alert_id = a.id and d.subscription_id = ${s.id}))
      order by a.created_at desc limit 25`;
    const [{ n: simulatedCount }] = await sql`
      select count(*)::int as n from delivery d join alert a on a.id = d.alert_id
      where d.subscription_id = ${s.id} and a.is_mock and d.created_at >= ${weekStart}`;
    const stations = await sql`
      select station_no, name, last_reading_at, ST_Distance(geom, ${pin}) / 1000 as km,
             (select bool_or(in_violation) from river_param_state p where p.station_no = c.station_no) as violating
      from cpcb_station c where ST_DWithin(geom, ${pin}, ${s.radius_km * 1000}) order by km limit 3`;
    const areas = await sql`
      select g.name, ST_Distance(g.geom, ${pin}) / 1000 as km,
             (select max(coalesce(x.analysed_at, x.collected_at)) from wq_sample x where x.gp_area_id = g.id) as last_test,
             (select x.worst_status from wq_sample x where x.gp_area_id = g.id order by coalesce(x.analysed_at, x.collected_at) desc nulls last limit 1) as status
      from wq_area g where g.level = 'gp' and g.geom is not null and ST_DWithin(g.geom, ${pin}, ${s.radius_km * 1000})
      order by km limit 5`;
    const email = renderDigest(s, {
      alerts: alerts.map((a) => ({ ...a })),
      simulatedCount,
      stations: stations.map((x) => {
        const m = stationMeta(x.station_no, x.name);
        return { label: m.river ? `The ${m.river} at ${m.place}` : `River water at ${m.place}`, age: x.last_reading_at ? humanAge(now.getTime() - x.last_reading_at.getTime()) : 'unknown', status: x.violating ? 'outside a CPCB limit' : null, distance_km: Math.round(x.km * 10) / 10 };
      }),
      areas: areas.map((a) => ({ name: a.name, last_test: a.last_test ? istLongDate(a.last_test) : null, status: a.status ? STATUS_WORDS[/** @type {keyof typeof STATUS_WORDS} */ (a.status)] ?? null : null, distance_km: Math.round(a.km * 10) / 10, known_since: knownSince })),
      weekStart, weekEnd: now,
    }, config.publicBaseUrl);
    try {
      await mailer.send({ to: s.email, ...email });
      const [msg] = await sql`insert into email_message (subscription_id, kind, subject) values (${s.id}, 'digest', ${email.subject}) returning id`;
      await sql`update delivery set status = 'sent', sent_at = now(), message_id = ${msg.id} where subscription_id = ${s.id} and status = 'digest'`;
      await sql`update subscription set last_digest_at = now() where id = ${s.id}`;
      sent++;
    } catch (err) {
      log.error('digest send failed', { error: String(/** @type {Error} */ (err).message) });
    }
  }
  log.info('digests sent', { sent, subscribers: subs.length });
  return { sent };
}

/** @param {import('@lt/core/db.js').Sql} sql */
export const digestJob = async (sql) => {
  try { return await digestCycle(sql); } catch (err) { log.error('digest failed', { error: String(err) }); return null; }
};

/** One-shot entrypoint (services/worker/run-once.js, used by GitHub Actions). */
export async function run() {
  return oneShot((sql) => digestJob(sql));
}
