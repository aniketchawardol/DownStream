// @ts-check
// Daily: tested samples for every panchayat in scope, with a count-based change detector so unchanged
// panchayats aren't re-read. Hourly: a polite drip of lab-report fetches (contaminated samples first).
import { config } from '@lt/core/config.js';
import { logger } from '@lt/core/log.js';
import { enc } from '@lt/core/aes.js';
import { fiscalYear, previousFiscalYear, toIst } from '@lt/core/time.js';
import { judgeTapResult, worstStatus, BIS_LIMITS } from '@lt/core/thresholds.js';
import { describeSource } from '@lt/core/parsers/wqmis-samplelist.js';
import { parseReport } from '@lt/core/parsers/wqmis-report.js';
import { WqmisClient } from '../lib/wqmis.js';
import { runSource } from '../lib/source.js';
import { gpsInScope } from '../lib/areas.js';
import { evaluateTapAlerts } from './tap-alerts.js';
import { outOfTime } from '../lib/deadline.js';
import { oneShot } from '../lib/one-shot.js';

const log = logger('wqmis-samples');

/** Printed form of a BIS range, for samples whose own report hasn't been read. @param {import('@lt/core/thresholds.js').Range|null|undefined} r */
function rangeText(r) {
  if (!r) return 'No Relaxation';
  if (r.absent) return 'Shall not be detectable in any 100 ml sample';
  if (r.min != null && r.max != null) return `${r.min}-${r.max}`;
  if (r.min != null) return `${r.min} (min)`;
  return r.max != null ? String(r.max) : null;
}

/** @param {import('@lt/core/db.js').Sql} sql */
async function learnedLimits(sql) {
  const rows = await sql`select parameter, acceptable_limit, permissible_limit from wq_param_limit`;
  return new Map(rows.map((r) => [r.parameter, r]));
}

/**
 * Turn list values into wq_result rows. Limits: learned from WQMIS reports ('wqmis') else BIS ('bis').
 * Anything the lab listed under "Contaminated parameters" is above the permissible limit, whatever we compute.
 * @param {import('@lt/core/parsers/wqmis-samplelist.js').SampleRow} row @param {Map<string, any>} learned
 */
export function resultsFromList(row, learned) {
  const contaminated = new Set(row.contaminated.map((c) => c.key));
  const seen = new Set();
  const out = [];
  for (const v of [...row.chemical, ...row.bacteriological]) {
    if (seen.has(v.key)) continue;
    seen.add(v.key);
    const l = learned.get(v.key);
    const bis = BIS_LIMITS[v.key];
    const acceptable_limit = l?.acceptable_limit ?? (bis ? rangeText(bis.acceptable) : null);
    const permissible_limit = l?.permissible_limit ?? (bis ? rangeText(bis.permissible) : null);
    let { status } = judgeTapResult({ key: v.key, value: v.value, value_text: v.value_text, acceptable_limit, permissible_limit });
    if (contaminated.has(v.key)) status = 'above_permissible';
    out.push({
      parameter: v.key, label: v.label, value_text: v.value_text, value: v.value, unit: v.unit,
      acceptable_limit, permissible_limit, status, limits_source: l ? 'wqmis' : bis ? 'bis' : null, method: null, nabl: null,
    });
  }
  return out;
}

/** @param {import('@lt/core/db.js').Sql} sql @param {string} sampleId @param {any[]} results */
async function replaceResults(sql, sampleId, results) {
  await sql`delete from wq_result where sample_id = ${sampleId}`;
  if (!results.length) return;
  await sql`insert into wq_result ${sql(results.map((r) => ({ sample_id: sampleId, ...r })), 'sample_id', 'parameter', 'label', 'value_text', 'value', 'unit', 'acceptable_limit', 'permissible_limit', 'status', 'limits_source', 'method', 'nabl')}
    on conflict (sample_id, parameter) do nothing`;
}

/**
 * Insert unseen samples for one GP. Baseline inserts (first ever fetch of the GP) are marked alerted so
 * history never fires alerts; later new samples are left for tap-alert evaluation.
 * @param {import('@lt/core/db.js').Sql} sql @param {any} gp @param {import('@lt/core/parsers/wqmis-samplelist.js').SampleRow[]} rows
 * @param {string} fy @param {Map<string, any>} learned @param {boolean} baseline
 */
export async function insertSamples(sql, gp, rows, fy, learned, baseline) {
  let inserted = 0;
  for (const row of rows) {
    if (row.inconclusive) continue;
    const results = resultsFromList(row, learned);
    const test_kinds = [row.chemical.length ? 'chemical' : null, row.bacteriological.length ? 'bacteriological' : null].filter(Boolean);
    const worst = worstStatus(results.map((r) => r.status));
    const [ins] = await sql`
      insert into wq_sample (sample_id, gp_area_id, village_name, source_type, source_name, collected_at, analysed_at, fy, lab_name,
        test_kinds, status_text, contaminated_text, remedial_remarks, raw, worst_status, report_s_id, alerted_at)
      values (${row.sample_id}, ${gp.id}, ${row.village || null}, ${row.source_type}, ${describeSource(row.source_raw)},
        ${row.collected_at}, ${row.analysed_at}, ${fy}, ${row.lab_name}, ${test_kinds}, ${row.status_text},
        ${row.raw.Contaminated_parameters || null}, ${row.remedial}, ${sql.json(row.raw)}, ${worst},
        ${row.report_digits ? enc(row.report_digits) : null}, ${baseline ? new Date() : null})
      on conflict (sample_id) do nothing
      returning sample_id`;
    if (!ins) continue;
    inserted++;
    await replaceResults(sql, row.sample_id, results);
  }
  return inserted;
}

/**
 * @param {import('@lt/core/db.js').Sql} sql
 * @param {{ client?: WqmisClient, now?: Date, reportBudget?: number }} [opts]
 */
export async function samplesCycle(sql, opts = {}) {
  const client = opts.client ?? new WqmisClient();
  const now = opts.now ?? new Date();
  await client.session();
  const fy = fiscalYear(now);
  const prevFy = previousFiscalYear(fy);
  const month = toIst(now).getUTCMonth(); // April = 3
  // The previous FY is re-read during April-June (late results land there) and once for any GP that has never had it read.
  const prevAlways = month >= 3 && month <= 5;
  const fys = [fy, prevFy];
  const learned = await learnedLimits(sql);
  const gps = await gpsInScope(sql, config.wqmisDistricts);
  // Baseline = the first read of a (GP, FY). Those rows are history, so they never raise alerts.
  const isBaseline = (/** @type {any} */ gp, /** @type {string} */ f) => gp.tested_counts?.[f] == null;
  /** @type {Map<string, any[]>} */
  const byBlock = new Map();
  for (const g of gps) { const k = String(g.block_area_id); if (!byBlock.has(k)) byBlock.set(k, []); /** @type {any[]} */ (byBlock.get(k)).push(g); }

  let inserted = 0, fetched = 0, skipped = 0, stoppedEarly = false;
  /** @type {string[]} */
  const warnings = [];
  blocks: for (const blockGps of byBlock.values()) {
    const first = blockGps[0];
    for (const f of fys) {
      if (outOfTime()) { stoppedEarly = true; break blocks; }
      const due = f === fy || prevAlways ? blockGps : blockGps.filter((g) => isBaseline(g, f));
      if (!due.length) continue;
      /** @type {Map<string, number>} */
      let counts = new Map();
      try {
        const c = await client.gpCounts({ fy: f, st: first.state_id, dt: first.district_jjm, bl: first.block_jjm, gp: first.jjm_id });
        counts = new Map(c.rows.map((r) => [String(r.id), Number(r.tested)]));
      } catch (err) {
        warnings.push(`counts for block ${first.block_name} ${f}: ${/** @type {Error} */ (err).message}`);
      }
      for (const gp of due) {
        // Out of time: stop cleanly. GPs not yet read keep no count for this FY, so the next run picks them up.
        if (outOfTime()) { stoppedEarly = true; break blocks; }
        const tested = counts.get(String(gp.jjm_id));
        const prev = gp.tested_counts?.[f];
        if (tested != null && (tested === prev || (tested === 0 && prev == null))) {
          skipped++;
          // A GP with no tests yet still counts as fetched, so its first-ever test later is news, not baseline.
          if (prev == null) await sql`update wq_area set samples_fetched_at = coalesce(samples_fetched_at, now()), tested_counts = coalesce(tested_counts, '{}'::jsonb) || ${sql.json({ [f]: tested })} where id = ${gp.id}`;
          continue;
        }
        try {
          const list = await client.sampleList({ fy: f, st: gp.state_id, dt: gp.district_jjm, bl: gp.block_jjm, gp: gp.jjm_id });
          warnings.push(...list.warnings);
          // Never record a count the list can't back up, or the change detector would skip this GP for good.
          if (tested && !list.rows.length) throw new Error(`count says ${tested} tested but the list came back empty`);
          inserted += await insertSamples(sql, gp, list.rows, f, learned, isBaseline(gp, f));
          fetched++;
          await sql`
            update wq_area set samples_fetched_at = now(),
              tested_counts = coalesce(tested_counts, '{}'::jsonb) || ${sql.json({ [f]: tested ?? list.rows.length })}
            where id = ${gp.id}`;
        } catch (err) {
          warnings.push(`samples for GP ${gp.name} ${f}: ${/** @type {Error} */ (err).message}`);
        }
      }
    }
    log.info('block done', { block: first.block_name, inserted_so_far: inserted });
  }
  if (!stoppedEarly && gps.length && fetched === 0 && skipped === 0) throw new Error(`no panchayat could be read (${warnings[0] ?? 'unknown error'})`);

  if (stoppedEarly) log.warn('time budget spent; the next run continues the crawl', { gps_fetched: fetched });
  const reports = stoppedEarly ? { ok: 0, failed: 0, skipped: 'out of time' } : await fetchReports(sql, client, opts.reportBudget ?? 300);
  const alerts = await evaluateTapAlerts(sql, now);
  const [{ newest }] = await sql`select max(analysed_at) as newest from wq_sample`;
  return {
    records: inserted,
    newest_data_at: newest,
    notes: { fys, complete: !stoppedEarly, gps: gps.length, gps_fetched: fetched, gps_unchanged: skipped, reports, alerts_created: alerts.created, ...(warnings.length ? { warnings: warnings.slice(0, 20) } : {}) },
  };
}

/**
 * Fetch lab reports for samples that don't have one yet: contaminated first, then the newest.
 * @param {import('@lt/core/db.js').Sql} sql @param {WqmisClient} client @param {number} budget
 */
export async function fetchReports(sql, client, budget) {
  const todo = await sql`
    select sample_id from wq_sample
    where report_fetched_at is null and report_attempts < 3 and sample_id ~ '^U[0-9]+S[0-9]+$'
    order by (worst_status = 'above_permissible') desc, (alerted_at is null) desc, analysed_at desc nulls last
    limit ${budget}`;
  let ok = 0, failed = 0;
  for (const { sample_id } of todo) {
    if (outOfTime()) break;
    const digits = sample_id.split('S').pop();
    try {
      const parsed = parseReport(await client.report(digits));
      if (!parsed.results.length) throw new Error(parsed.warnings[0] ?? 'report has no results');
      if (parsed.sample_id && parsed.sample_id !== sample_id) throw new Error(`report is for ${parsed.sample_id}`);
      const results = parsed.results.map((r) => {
        const j = judgeTapResult(r);
        return { parameter: r.key, label: r.label, value_text: r.value_text, value: r.value, unit: r.unit, acceptable_limit: r.acceptable_limit, permissible_limit: r.permissible_limit, status: j.status, limits_source: 'report', method: r.method, nabl: r.nabl };
      });
      // De-duplicate keys (e.g. two TDS spellings): keep the first.
      const unique = [...new Map(results.map((r) => [r.parameter, r])).values()];
      await sql.begin(async (tx) => {
        await tx`
          update wq_sample set
            collected_at = coalesce(${parsed.collected_at}, collected_at), received_at = ${parsed.received_at},
            analysed_at = coalesce(${parsed.analysed_at}, analysed_at), reported_at = ${parsed.reported_at},
            lab_name = coalesce(${parsed.lab_name}, lab_name), report_lat = ${parsed.lat}, report_lng = ${parsed.lng},
            worst_status = ${worstStatus(unique.map((r) => r.status))}, report_fetched_at = now(), report_error = null
          where sample_id = ${sample_id}`;
        await replaceResults(/** @type {any} */ (tx), sample_id, unique);
        for (const r of parsed.results) {
          if (!r.acceptable_limit && !r.permissible_limit) continue;
          await tx`
            insert into wq_param_limit (parameter, label, unit, acceptable_limit, permissible_limit, seen_at, sample_id)
            values (${r.key}, ${r.label}, ${r.unit}, ${r.acceptable_limit}, ${r.permissible_limit}, now(), ${sample_id})
            on conflict (parameter) do update set label = excluded.label, unit = excluded.unit, acceptable_limit = excluded.acceptable_limit,
              permissible_limit = excluded.permissible_limit, seen_at = now(), sample_id = excluded.sample_id`;
        }
      });
      ok++;
    } catch (err) {
      failed++;
      await sql`update wq_sample set report_attempts = report_attempts + 1, report_error = ${String(/** @type {Error} */ (err).message).slice(0, 300)} where sample_id = ${sample_id}`;
    }
  }
  const [{ backlog }] = await sql`select count(*)::int as backlog from wq_sample where report_fetched_at is null and report_attempts < 3`;
  if (todo.length) log.info('reports fetched', { ok, failed, backlog });
  return { ok, failed, backlog };
}

/** @param {import('@lt/core/db.js').Sql} sql */
export const samplesJob = (sql) => runSource(sql, 'wqmis-samples', () => samplesCycle(sql));

/** Hourly drip while a backlog exists. @param {import('@lt/core/db.js').Sql} sql */
export const reportsJob = (sql) => runSource(sql, 'wqmis-reports', async () => {
  const [{ backlog }] = await sql`select count(*)::int as backlog from wq_sample where report_fetched_at is null and report_attempts < 3`;
  if (!backlog) return { records: 0, notes: { backlog: 0 } };
  const client = new WqmisClient();
  await client.session();
  const r = await fetchReports(sql, client, 500);
  const alerts = await evaluateTapAlerts(sql, new Date());
  const [{ newest }] = await sql`select max(reported_at) as newest from wq_sample`;
  return { records: r.ok, newest_data_at: newest, notes: { ...r, alerts_created: alerts.created } };
});

/** One-shot entrypoint (services/worker/run-once.js, used by GitHub Actions). */
export async function run() {
  return oneShot((sql) => samplesJob(sql));
}
