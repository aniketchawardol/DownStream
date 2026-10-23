// @ts-check
// Writing alerts and fanning them out to matching subscriptions. The dedupe_key makes re-runs harmless.
import { kindInfo } from './kinds.js';

/**
 * @typedef {{ kind: string, source?: string, subject_ref: string, lat: number, lng: number, title: string,
 *   body: Record<string, unknown>, is_mock?: boolean, dedupe_key: string, severity?: 'urgent'|'notice'|'info',
 *   target_subscription_id?: string }} NewAlert
 */

/**
 * Insert an alert (no-op if its dedupe_key exists) and create a delivery for every confirmed
 * subscription whose circle contains it and whose choices include the alert's group.
 * Info-level alerts are held for the weekly digest, so they only reach digest subscribers.
 * @param {import('../db.js').Sql} sql @param {NewAlert} a
 * @returns {Promise<{ id: string|null, created: boolean, deliveries: number }>}
 */
export async function createAlert(sql, a) {
  const info = kindInfo(a.kind);
  const severity = a.severity ?? info.severity;
  const [row] = await sql`
    insert into alert (kind, severity, source, subject_ref, geom, title, body, is_mock, dedupe_key)
    values (${a.kind}, ${severity}, ${a.source ?? info.source}, ${a.subject_ref},
            ST_SetSRID(ST_MakePoint(${a.lng}, ${a.lat}), 4326)::geography,
            ${a.title}, ${sql.json(/** @type {any} */ (a.body))}, ${!!a.is_mock}, ${a.dedupe_key})
    on conflict (dedupe_key) do nothing
    returning id`;
  if (!row) return { id: null, created: false, deliveries: 0 };
  const status = severity === 'info' ? 'digest' : 'pending';
  const target = a.target_subscription_id ?? null;
  const inserted = await sql`
    insert into delivery (alert_id, subscription_id, status)
    select ${row.id}, s.id, ${status}
    from subscription s, alert al
    where al.id = ${row.id}
      and s.confirmed_at is not null and s.unsubscribed_at is null
      and ${info.group} = any(s.kinds)
      and (${severity} <> 'info' or 'digest' = any(s.kinds))
      and (${target}::uuid is null or s.id = ${target}::uuid)
      and (${target}::uuid is not null or ST_DWithin(s.geom, al.geom, s.radius_km * 1000))
    on conflict do nothing
    returning subscription_id`;
  return { id: row.id, created: true, deliveries: inserted.length };
}
