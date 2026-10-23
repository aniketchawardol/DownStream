// @ts-check
// Tap alerts for newly published samples, plus the per-subscriber regional_geogenic roll-up.
// Bacteriological results are only ever attributed to their own panchayat; the regional roll-up
// covers rock-derived contaminants (fluoride, arsenic, nitrate, uranium) and nothing else.
import { logger } from '@lt/core/log.js';
import { createAlert } from '@lt/core/alerts/store.js';
import { tapAlert, geogenicAlert } from '@lt/core/alerts/describe.js';
import { BIS_LIMITS } from '@lt/core/thresholds.js';
import { fiscalYear, istDate } from '@lt/core/time.js';
import { config } from '@lt/core/config.js';

const log = logger('tap-alerts');
const WAIT_FOR_REPORT_MS = 24 * 3600_000;
const GEOGENIC = Object.entries(BIS_LIMITS).filter(([, v]) => v.geogenic).map(([k]) => k);

/** Public link to the government report for a sample. @param {string|null} sid */
export const reportUrl = (sid) => (sid ? `${config.wqmisBase}/Common/final_report_print?s_id=${encodeURIComponent(sid)}` : null);

/**
 * @param {import('@lt/core/db.js').Sql} sql @param {Date} now
 */
export async function evaluateTapAlerts(sql, now) {
  // Wait up to a day for the report (printed limits, full dates) before alerting from list values alone.
  const samples = await sql`
    select s.*, g.id as area_id, g.name as gp_name, b.name as block_name, d.name as district_name,
           ST_Y(coalesce(g.geom, b.geom)::geometry) as lat, ST_X(coalesce(g.geom, b.geom)::geometry) as lng
    from wq_sample s
    join wq_area g on g.id = s.gp_area_id
    left join wq_area b on b.id = g.parent_id
    left join wq_area d on d.id = b.parent_id
    where s.alerted_at is null
      and (s.report_fetched_at is not null or s.report_attempts >= 3 or s.first_seen_at < ${new Date(now.getTime() - WAIT_FOR_REPORT_MS)})
    order by s.first_seen_at
    limit 2000`;
  let created = 0;
  /** @type {any[]} */
  const geogenicHits = [];
  for (const s of samples) {
    if (s.lat == null) {
      // Not geocoded yet. Give up after a week rather than holding the row forever.
      if (s.first_seen_at < new Date(now.getTime() - 7 * 86400_000)) await sql`update wq_sample set alerted_at = now() where sample_id = ${s.sample_id}`;
      continue;
    }
    const results = await sql`select * from wq_result where sample_id = ${s.sample_id} order by label`;
    const kind = s.worst_status === 'above_permissible' ? 'tap_contamination' : s.worst_status === 'above_acceptable' ? 'tap_caution' : s.worst_status === 'ok' ? 'tap_all_clear' : null;
    if (kind) {
      const shown = kind === 'tap_all_clear' ? [] : results.filter((r) => r.status === 'above_permissible' || (kind === 'tap_caution' && r.status === 'above_acceptable'));
      const { title, body } = tapAlert(kind,
        { area_id: s.area_id, gp_name: s.gp_name, block: s.block_name, district: s.district_name },
        { ...s, report_url: reportUrl(s.report_s_id) },
        shown.map((r) => ({ parameter_label: r.label, value_text: r.value_text, unit: r.unit, acceptable_text: r.acceptable_limit, permissible_text: r.permissible_limit, status: r.status })));
      const res = await createAlert(sql, { kind, subject_ref: `wqmis:${s.sample_id}`, lat: s.lat, lng: s.lng, title, body, dedupe_key: `${kind}:${s.sample_id}` });
      if (res.created) created++;
    }
    for (const r of results) if (GEOGENIC.includes(r.parameter) && r.status === 'above_permissible') geogenicHits.push({ ...r, sample: s });
    await sql`update wq_sample set alerted_at = now() where sample_id = ${s.sample_id}`;
  }
  created += await regionalGeogenic(sql, geogenicHits, now);
  if (created) log.info('tap alerts created', { created });
  return { created };
}

/**
 * For each subscriber whose circle contains a new geogenic exceedance, summarise that contaminant
 * across their whole circle for this financial year. One alert per subscriber, parameter and day.
 * @param {import('@lt/core/db.js').Sql} sql @param {any[]} hits @param {Date} now
 */
async function regionalGeogenic(sql, hits, now) {
  if (!hits.length) return 0;
  const fy = fiscalYear(now);
  let created = 0;
  for (const param of new Set(hits.map((h) => h.parameter))) {
    const ph = hits.filter((h) => h.parameter === param);
    const subs = await sql`
      select distinct s.id, s.radius_km, ST_Y(s.geom::geometry) as lat, ST_X(s.geom::geometry) as lng
      from subscription s
      where s.confirmed_at is not null and s.unsubscribed_at is null and 'tap' = any(s.kinds)
        and exists (select 1 from unnest(${ph.map((h) => h.sample.lng)}::float8[], ${ph.map((h) => h.sample.lat)}::float8[]) as p(lng, lat)
                    where ST_DWithin(s.geom, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)::geography, s.radius_km * 1000))`;
    for (const sub of subs) {
      const stats = await sql`
        select r.value_text, r.status, r.permissible_limit, r.unit, g.id as area_id, g.name as gp_name, s.collected_at,
               ST_Distance(coalesce(g.geom, b.geom), ST_SetSRID(ST_MakePoint(${sub.lng}, ${sub.lat}), 4326)::geography) / 1000 as km
        from wq_result r
        join wq_sample s on s.sample_id = r.sample_id
        join wq_area g on g.id = s.gp_area_id
        left join wq_area b on b.id = g.parent_id
        where r.parameter = ${param} and s.fy = ${fy}
          and ST_DWithin(coalesce(g.geom, b.geom), ST_SetSRID(ST_MakePoint(${sub.lng}, ${sub.lat}), 4326)::geography, ${sub.radius_km * 1000})`;
      const above = stats.filter((r) => r.status === 'above_permissible').sort((a, b) => a.km - b.km);
      if (!above.length) continue;
      const nearest = above[0];
      const label = BIS_LIMITS[param]?.label ?? param;
      const { title, body } = geogenicAlert({
        parameter_label: label, unit: nearest.unit, permissible_text: nearest.permissible_limit ?? '',
        count_above: above.length, count_tested: stats.length, radius_km: sub.radius_km, fy,
        nearest: { gp_name: nearest.gp_name, area_id: String(nearest.area_id), distance_km: Math.round(nearest.km * 10) / 10, value_text: nearest.value_text, collected_at: nearest.collected_at?.toISOString() ?? null },
      });
      const res = await createAlert(sql, {
        kind: 'regional_geogenic', subject_ref: `subscription:${sub.id}:${param}`, lat: sub.lat, lng: sub.lng, title, body,
        dedupe_key: `regional_geogenic:${sub.id}:${param}:${istDate(now)}`, target_subscription_id: sub.id,
      });
      if (res.created) created++;
    }
  }
  return created;
}
