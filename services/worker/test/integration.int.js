// @ts-check
// Integration: real Postgres (water_test) + real SMTP into Mailpit. CPCB ingest from the fixture, river alerts,
// the mailer, and geocode overrides. Run with `npm run test:integration` while `docker compose up` is running.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const inDocker = fs.existsSync('/.dockerenv');
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL || `postgres://water:water@${inDocker ? 'db:5432' : 'localhost:5433'}/water`;
const TEST_URL = ADMIN_URL.replace(/\/[^/]+$/, '/water_test');
const MAILPIT = process.env.MAILPIT_URL || `http://${inDocker ? 'mailpit' : 'localhost'}:8025`;
process.env.SMTP_URL = `smtp://${inDocker ? 'mailpit' : 'localhost'}:1025`;
process.env.PUBLIC_BASE_URL = 'http://site.test';
process.env.RAW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-raw-'));

const { createSql } = await import('@lt/core/db.js');
const { migrate } = await import('@lt/core/migrate.js');
const { config } = await import('@lt/core/config.js');
const { cpcbCycle } = await import('../jobs/cpcb.js');
const { mailerCycle } = await import('../jobs/mailer.js');
const { geocodeCycle } = await import('../jobs/geocode.js');

const layer = JSON.parse(fs.readFileSync(new URL('../../../fixtures/cpcb/layer10.json', import.meta.url), 'utf8'));
// Haridwar's real readings with DO forced to 3.2 mg/l (Class C minimum is 4).
const lowDo = JSON.stringify(layer.map((/** @type {any} */ o) => (o.station_no === 'UK55' && o.stationparameter_name === 'DO' ? { ...o, ts_value: 3.2 } : o)));
const fixtureNow = new Date('2026-10-23T07:00:00Z');
const email = `river-${Date.now()}@example.com`;

/** @type {any} */ let sql;
let skip = '';

before(async () => {
  const admin = createSql({ url: ADMIN_URL, max: 1 });
  try {
    const [exists] = await admin`select 1 from pg_database where datname = 'water_test'`;
    if (!exists) await admin.unsafe('create database water_test');
    await fetch(`${MAILPIT}/api/v1/info`);
  } catch (err) {
    skip = `needs the compose db and Mailpit (${/** @type {Error} */ (err).message})`;
    return;
  } finally {
    await admin.end({ timeout: 2 });
  }
  sql = createSql({ url: TEST_URL, max: 4 });
  await migrate(sql, fileURLToPath(new URL('../../../db/migrations/', import.meta.url)), () => {});
  await sql`truncate delivery, email_message, alert, subscription, wq_result, wq_sample, wq_param_limit, wq_area, river_param_state, cpcb_reading, cpcb_station, wq_daily_snapshot, source_health cascade`;
  await sql`insert into subscription (email, geom, radius_km, kinds, confirmed_at, unsubscribe_token)
            values (${email}, ST_SetSRID(ST_MakePoint(78.16, 29.95), 4326)::geography, 10, '{river}', now(), ${`tok-${Date.now()}`})`;
});
after(async () => { await sql?.end({ timeout: 2 }); });

test('CPCB ingest -> one river alert -> mailer -> Mailpit; a second cycle adds nothing', async (t) => {
  if (skip) return t.skip(skip);
  const first = await cpcbCycle(sql, { fetchText: async () => lowDo, backfill: false, now: fixtureNow });
  assert.equal(first.records, 468, 'every station x parameter stored');
  assert.deepEqual(first.notes.stale, ['BH75', 'WB90'], 'stale stations flagged');
  const alerts = await sql`select kind, subject_ref, dedupe_key from alert where kind = 'river_threshold' and subject_ref = 'cpcb:UK55:DO'`;
  assert.equal(alerts.length, 1);
  const [{ n: deliveries }] = await sql`select count(*)::int as n from delivery d join subscription s on s.id = d.subscription_id where s.email = ${email}`;
  assert.equal(deliveries, 1, 'only the Haridwar alert falls inside the 10 km circle');

  const second = await cpcbCycle(sql, { fetchText: async () => lowDo, backfill: false, now: fixtureNow });
  assert.equal(second.records, 0, 'readings grow only by new timestamps');
  const [{ n: after2 }] = await sql`select count(*)::int as n from alert where kind = 'river_threshold'`;
  const [{ n: total }] = await sql`select count(*)::int as n from cpcb_reading`;
  assert.equal(total, 468);
  assert.ok(after2 >= 1);
  const [{ n: again }] = await sql`select count(*)::int as n from alert where subject_ref = 'cpcb:UK55:DO'`;
  assert.equal(again, 1, 'repeat run raises no second alert');

  const sent = await mailerCycle(sql, { now: new Date() });
  assert.ok(sent.sent >= 1);
  let msg;
  for (let i = 0; i < 20 && !msg; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`).then((x) => x.json());
    msg = r.messages?.[0];
    if (!msg) await new Promise((res) => setTimeout(res, 300));
  }
  assert.ok(msg, 'email arrived in Mailpit');
  assert.equal(msg.Subject, 'Dissolved oxygen below the limit at Haridwar');
  const full = await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`).then((x) => x.json());
  assert.match(full.Text, /Dissolved oxygen was 3\.2 mg\/l in the Ganga at Haridwar/);
  assert.match(full.Text, /This is river water, not tap water/);
  assert.match(full.Text, /http:\/\/site\.test\/api\/unsubscribe\?token=/);
  const [{ status }] = await sql`select d.status from delivery d join subscription s on s.id = d.subscription_id where s.email = ${email}`;
  assert.equal(status, 'sent');
});

test('circuit breaker: 5 failures pause the source for an hour, last good data stays, recovery is automatic', async (t) => {
  if (skip) return t.skip(skip);
  const { runSource, BREAKER_THRESHOLD } = await import('../lib/source.js');
  const down = async () => { throw new Error('getaddrinfo ENOTFOUND rtwqmsdb1.cpcb.gov.in'); };
  for (let i = 0; i < BREAKER_THRESHOLD; i++) assert.equal((await runSource(sql, 'breaker-test', down)).ok, false);
  const [open] = await sql`select consecutive_failures, circuit_open_until, last_error from source_health where source = 'breaker-test'`;
  assert.equal(open.consecutive_failures, 5);
  assert.ok(open.circuit_open_until > new Date(Date.now() + 55 * 60_000), 'paused for about an hour');
  assert.match(open.last_error, /ENOTFOUND/);
  let called = false;
  const skipped = await runSource(sql, 'breaker-test', async () => { called = true; return { records: 1 }; });
  assert.equal(/** @type {any} */ (skipped).skipped, true);
  assert.equal(called, false, 'no request while the circuit is open');
  await sql`update source_health set circuit_open_until = now() - interval '1 second' where source = 'breaker-test'`; // the hour passes
  const back = await runSource(sql, 'breaker-test', async () => ({ records: 7, newest_data_at: new Date() }));
  assert.equal(back.ok, true);
  const [healed] = await sql`select consecutive_failures, circuit_open_until, last_error, records_last_run from source_health where source = 'breaker-test'`;
  assert.deepEqual({ ...healed }, { consecutive_failures: 0, circuit_open_until: null, last_error: null, records_last_run: 7 });
});

test('a schema surprise is recorded and keeps the last good data', async (t) => {
  if (skip) return t.skip(skip);
  const { runSource } = await import('../lib/source.js');
  const before = (await sql`select count(*)::int as n from cpcb_reading`)[0].n;
  const r = await runSource(sql, 'cpcb-schema-test', () => cpcbCycle(sql, { fetchText: async () => '{"layers": "moved"}', backfill: false }));
  assert.equal(r.ok, false);
  const [h] = await sql`select last_error from source_health where source = 'cpcb-schema-test'`;
  assert.match(h.last_error, /^schema: /);
  assert.equal((await sql`select count(*)::int as n from cpcb_reading`)[0].n, before, 'nothing deleted');
});

test('tap alerts: new contaminated sample, geogenic roll-up, overdue, and the weekly digest', async (t) => {
  if (skip) return t.skip(skip);
  const { evaluateTapAlerts } = await import('../jobs/tap-alerts.js');
  const { overdueCycle } = await import('../jobs/overdue.js');
  const { digestCycle } = await import('../jobs/digest.js');
  const now = new Date();
  const tapEmail = `tap-${Date.now()}@example.com`;
  const [d] = await sql`insert into wq_area (level, jjm_id, state_id, name) values ('district', 'T187', 15, 'Testdistrict') returning id`;
  const [b] = await sql`insert into wq_area (level, jjm_id, parent_id, state_id, name, geom) values ('block', 'T2481', ${d.id}, 15, 'Testblock', ST_SetSRID(ST_MakePoint(75.6, 15.9), 4326)::geography) returning id`;
  const [g] = await sql`insert into wq_area (level, jjm_id, parent_id, state_id, name, geom, geocode_confidence, samples_fetched_at)
    values ('gp', 'T59783', ${b.id}, 15, 'Testgp', ST_SetSRID(ST_MakePoint(75.56, 15.72), 4326)::geography, 0.9, now()) returning id`;
  const [stale] = await sql`insert into wq_area (level, jjm_id, parent_id, state_id, name, geom, geocode_confidence, samples_fetched_at)
    values ('gp', 'T59784', ${b.id}, 15, 'Oldgp', ST_SetSRID(ST_MakePoint(75.58, 15.74), 4326)::geography, 0.9, now()) returning id`;
  const [sub] = await sql`insert into subscription (email, geom, radius_km, kinds, confirmed_at, unsubscribe_token)
    values (${tapEmail}, ST_SetSRID(ST_MakePoint(75.57, 15.73), 4326)::geography, 10, '{tap,overdue,digest}', now(), ${`tap-tok-${Date.now()}`}) returning id`;
  // A freshly published sample (alerted_at null) with fluoride and E. coli above the permissible limit.
  await sql`insert into wq_sample (sample_id, gp_area_id, collected_at, analysed_at, reported_at, report_fetched_at, test_kinds, worst_status, fy, source_name, first_seen_at)
    values ('UT1S1', ${g.id}, ${new Date(now.getTime() - 9 * 86400_000)}, ${new Date(now.getTime() - 7 * 86400_000)}, ${new Date(now.getTime() - 2 * 86400_000)}, now(),
            '{chemical,bacteriological}', 'above_permissible', ${(await import('@lt/core/time.js')).fiscalYear(now)}, 'a household tap (deep tubewell)', now())`;
  await sql`insert into wq_result (sample_id, parameter, label, value_text, value, unit, acceptable_limit, permissible_limit, status, limits_source) values
    ('UT1S1', 'fluoride', 'Fluoride (as F)', '1.930', 1.93, 'mg/l', '1', '1.5', 'above_permissible', 'report'),
    ('UT1S1', 'e_coli', 'E. coli', '5.000', 5, 'CFU/100 ml', 'Shall not be detectable in any 100 ml sample', 'No Relaxation', 'above_permissible', 'report')`;
  // The other GP was last tested chemically 14 months ago.
  await sql`insert into wq_sample (sample_id, gp_area_id, collected_at, analysed_at, test_kinds, worst_status, fy, alerted_at)
    values ('UT1S2', ${stale.id}, ${new Date(now.getTime() - 430 * 86400_000)}, ${new Date(now.getTime() - 428 * 86400_000)}, '{chemical}', 'ok', '2024-2025', now())`;

  const res = await evaluateTapAlerts(sql, now);
  assert.equal(res.created, 2, 'tap_contamination plus one regional_geogenic roll-up');
  const kinds = (await sql`select a.kind, a.title, a.body from alert a join delivery dl on dl.alert_id = a.id where dl.subscription_id = ${sub.id} order by a.kind`);
  assert.deepEqual(kinds.map((k) => k.kind), ['regional_geogenic', 'tap_contamination']);
  const contamination = kinds.find((k) => k.kind === 'tap_contamination');
  assert.equal(contamination.title, 'Lab test above the permissible limit in Testgp panchayat');
  assert.deepEqual(contamination.body.results.map((r) => r.parameter_label).sort(), ['E. coli', 'Fluoride (as F)']);
  const regional = kinds.find((k) => k.kind === 'regional_geogenic');
  assert.match(regional.title, /^Fluoride above the permissible limit in 1 of 1 tests within 10 km/);
  assert.ok(!/coli/i.test(JSON.stringify(regional.body)), 'bacteria never spread beyond their own panchayat');
  assert.equal((await evaluateTapAlerts(sql, now)).created, 0, 'a sample alerts once');

  const od = await overdueCycle(sql, now);
  assert.ok(od.records >= 2, 'chemical and bacteriological overdue for the stale GP');
  const overdue = await sql`select title from alert where kind = 'tap_overdue' and subject_ref like ${`wqmis-gp:${stale.id}:%`} order by title`;
  assert.match(overdue[0].title, /No bacteriological lab test (found for Oldgp panchayat since|in Oldgp panchayat for)/);
  assert.match(overdue[1].title, /No chemical lab test in Oldgp panchayat for 14 months/);
  assert.equal((await overdueCycle(sql, now)).records, 0, 'same gap, no repeat');

  const dg = await digestCycle(sql, { now, onlySubscriptionId: sub.id });
  assert.equal(dg.sent, 1);
  const found = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${tapEmail}" subject:"Weekly water summary"`)}`).then((x) => x.json());
  assert.equal(found.messages.length, 1);
  const full = await fetch(`${MAILPIT}/api/v1/message/${found.messages[0].ID}`).then((x) => x.json());
  assert.match(full.Text, /Testgp panchayat: last lab test/);
  assert.match(full.Text, /Collected .*\. Analysed .*\. First seen by this site/);
});

test('queued confirmation emails are sent once by the mailer', async (t) => {
  if (skip) return t.skip(skip);
  const qEmail = `queued-${Date.now()}@example.com`;
  await sql`insert into subscription (email, geom, radius_km, kinds, confirm_token, unsubscribe_token)
    values (${qEmail}, ST_SetSRID(ST_MakePoint(75.7, 16.18), 4326)::geography, 10, '{tap}', ${`ct-${Date.now()}`}, ${`ut-${Date.now()}`})`;
  const first = await mailerCycle(sql, { now: new Date() });
  assert.equal(first.confirmations, 1);
  assert.equal((await mailerCycle(sql, { now: new Date() })).confirmations, 0, 'never sent twice');
  let msg;
  for (let i = 0; i < 20 && !msg; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${qEmail}"`)}`).then((x) => x.json());
    msg = r.messages?.[0];
    if (!msg) await new Promise((res) => setTimeout(res, 300));
  }
  assert.equal(msg?.Subject, 'Confirm your DownStream water alerts');
  const full = await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`).then((x) => x.json());
  assert.match(full.Text, /http:\/\/site\.test\/api\/subscriptions\/confirm\?token=ct-/);
});

test('geocode overrides win over every other source', async (t) => {
  if (skip) return t.skip(skip);
  const [d] = await sql`insert into wq_area (level, jjm_id, state_id, name) values ('district', '187', 15, 'Bagalkote') returning id`;
  const [b] = await sql`insert into wq_area (level, jjm_id, parent_id, state_id, name) values ('block', '2481', ${d.id}, 15, 'Badami') returning id`;
  await sql`insert into wq_area (level, jjm_id, parent_id, state_id, name) values ('gp', '59783', ${b.id}, 15, 'Adagal'), ('gp', '99999', ${b.id}, 15, 'Nowhere')`;
  const csv = path.join(process.env.RAW_DIR ?? os.tmpdir(), 'overrides.csv');
  fs.writeFileSync(csv, '# test\nlevel,jjm_id,lat,lng,note\ngp,59783,15.7212,75.5269,checked by hand\n');
  config.geocodeOverridesPath = csv;
  const stub = async (/** @type {string} */ q) => (/Badami/.test(q) && !/Adagal|Nowhere/.test(q) ? [{ lat: 15.92, lng: 75.68, type: 'town', importance: 0.5, name: 'Badami' }]
    : /Bagalkote district/.test(q) ? [{ lat: 16.18, lng: 75.7, type: 'administrative', importance: 0.6, name: 'Bagalkote' }] : []);
  const res = await geocodeCycle(sql, { search: stub, places: async () => [{ lat: 15.9, lng: 75.6, type: 'village', names: ['Adagal'] }] });
  const rows = await sql`select name, geocode_source, geocode_confidence, round(ST_Y(geom::geometry)::numeric, 4)::float as lat from wq_area where level = 'gp' order by name`;
  const adagal = rows.find((/** @type {any} */ r) => r.name === 'Adagal');
  assert.equal(adagal.geocode_source, 'override');
  assert.equal(adagal.geocode_confidence, 1);
  assert.equal(adagal.lat, 15.7212);
  const nowhere = rows.find((/** @type {any} */ r) => r.name === 'Nowhere');
  assert.equal(nowhere.geocode_source, 'block-centroid', 'unmatched GP falls back to its block, marked approximate');
  assert.ok(nowhere.geocode_confidence < 0.5);
  assert.equal(res.notes.overrides, 1);
});
