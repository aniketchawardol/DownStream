// @ts-check
// API tests against a throwaway database (water_test) on the compose Postgres. Skipped if it isn't reachable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.MOCK_MODE = 'true';
process.env.PUBLIC_BASE_URL = 'http://site.test';
const inDocker = fs.existsSync('/.dockerenv');
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL || `postgres://water:water@${inDocker ? 'db:5432' : 'localhost:5433'}/water`;
const TEST_URL = ADMIN_URL.replace(/\/[^/]+$/, '/water_test');

const { createSql } = await import('@lt/core/db.js');
const { migrate } = await import('@lt/core/migrate.js');
const { buildApp } = await import('../server.js');

/** @type {any} */ let sql;
/** @type {any} */ let app;
/** @type {any[]} */ const outbox = [];
let skip = '';

before(async () => {
  const admin = createSql({ url: ADMIN_URL, max: 1 });
  try {
    const [exists] = await admin`select 1 from pg_database where datname = 'water_test'`;
    if (!exists) await admin.unsafe('create database water_test');
  } catch (err) {
    skip = `database not reachable (${/** @type {Error} */ (err).message})`;
    return;
  } finally {
    await admin.end({ timeout: 2 });
  }
  sql = createSql({ url: TEST_URL, max: 4 });
  await migrate(sql, fileURLToPath(new URL('../../../db/migrations/', import.meta.url)), () => {});
  await sql`truncate delivery, email_message, alert, subscription, wq_result, wq_sample, wq_param_limit, wq_area, river_param_state, cpcb_reading, cpcb_station, wq_daily_snapshot, source_health cascade`;
  // Seed: one river station with 48 h of DO, one geocoded panchayat with two samples.
  await sql`insert into cpcb_station (station_no, name, state, geom, last_reading_at) values ('UK55', 'D/s of Har Ki Pauri, Dam Kothi, Haridwar', 'Uttarakhand', ST_SetSRID(ST_MakePoint(78.1576, 29.9415), 4326)::geography, now() - interval '20 minutes')`;
  for (let h = 0; h < 48; h++) {
    await sql`insert into cpcb_reading (station_no, parameter, value, unit, measured_at) values ('UK55', 'DO', ${h === 0 ? 3.2 : 7 + (h % 3) / 10}, 'mg/l', now() - interval '20 minutes' - ${`${h} hours`}::interval)`;
    await sql`insert into cpcb_reading (station_no, parameter, value, unit, measured_at) values ('UK55', 'EC', 300, 'mS/cm', now() - interval '20 minutes' - ${`${h} hours`}::interval)`;
  }
  const [d] = await sql`insert into wq_area (level, jjm_id, state_id, name, geom, geocode_source, geocode_confidence) values ('district', '187', 15, 'Bagalkote', ST_SetSRID(ST_MakePoint(75.7, 16.18), 4326)::geography, 'nominatim', 0.8) returning id`;
  const [b] = await sql`insert into wq_area (level, jjm_id, parent_id, state_id, name, geom, geocode_source, geocode_confidence) values ('block', '2481', ${d.id}, 15, 'Badami', ST_SetSRID(ST_MakePoint(75.68, 15.92), 4326)::geography, 'nominatim', 0.8) returning id`;
  const [g] = await sql`insert into wq_area (level, jjm_id, parent_id, state_id, name, geom, geocode_source, geocode_confidence, samples_fetched_at) values ('gp', '59783', ${b.id}, 15, 'Adagal', ST_SetSRID(ST_MakePoint(75.56, 15.55), 4326)::geography, 'nominatim', 0.9, now()) returning id`;
  await sql`insert into wq_sample (sample_id, gp_area_id, collected_at, analysed_at, reported_at, test_kinds, worst_status, fy, report_s_id, received_at, report_fetched_at)
            values ('U1S1', ${g.id}, now() - interval '40 days', now() - interval '38 days', now() - interval '20 days', '{chemical,bacteriological}', 'above_permissible', '2026-2027', 'abc+/=', now() - interval '40 days' + interval '3 hours', now()),
                   ('U1S2', ${g.id}, now() - interval '200 days', now() - interval '199 days', null, '{chemical}', 'ok', '2025-2026', null, null, null)`;
  await sql`insert into wq_result (sample_id, parameter, label, value_text, value, unit, acceptable_limit, permissible_limit, status, limits_source)
            values ('U1S1', 'fluoride', 'Fluoride (as F)', '1.930', 1.93, 'mg/l', '1', '1.5', 'above_permissible', 'report'),
                   ('U1S1', 'e_coli', 'E. coli', '0.000', 0, 'CFU/100 ml', 'Shall not be detectable in any 100 ml sample', 'No Relaxation', 'ok', 'report')`;
  app = await buildApp({ sql, logger: false, mailer: { send: async (m) => { outbox.push(m); return {}; } } });
});

after(async () => {
  await app?.close();
  await sql?.end({ timeout: 2 });
});

/** @param {import('node:test').TestContext} t */
const needDb = (t) => { if (skip) { t.skip(skip); return false; } return true; };

test('GET /api/health returns 200 with per-source status', async (t) => {
  if (!needDb(t)) return;
  await sql`insert into source_health (source, last_success_at, newest_data_at) values ('cpcb', now(), now() - interval '20 minutes') on conflict do nothing`;
  const r = await app.inject('/api/health');
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.db, 'up');
  assert.ok(Array.isArray(j.sources));
});

test('GET /api/stations: GeoJSON with per-parameter status, staleness and the EC unit fix', async (t) => {
  if (!needDb(t)) return;
  const j = (await app.inject('/api/stations')).json();
  assert.equal(j.type, 'FeatureCollection');
  const f = j.features[0];
  assert.deepEqual(f.geometry.coordinates, [78.1576, 29.9415]);
  assert.equal(f.properties.place, 'Haridwar');
  assert.equal(f.properties.river, 'Ganga');
  assert.equal(f.properties.is_stale, false);
  assert.equal(f.properties.params.DO.status, 'violation');
  assert.deepEqual(f.properties.violations, ['DO']);
  assert.equal(f.properties.params.EC.unit, 'µS/cm');
  assert.equal(f.properties.params.EC.status, 'no_criteria');
});

test('GET /api/stations/:no/series validates input and returns 48 h', async (t) => {
  if (!needDb(t)) return;
  const r = await app.inject('/api/stations/UK55/series?param=DO&hours=48');
  assert.equal(r.statusCode, 200);
  const s = r.json().series[0];
  assert.equal(s.parameter, 'DO');
  assert.ok(s.points.length >= 47 && s.points.length <= 48);
  assert.deepEqual(s.limit, { min: 4 });
  assert.equal((await app.inject('/api/stations/UK55/series?param=nope')).statusCode, 400);
  assert.equal((await app.inject('/api/stations/UK55/series?hours=9999')).statusCode, 400);
  assert.equal((await app.inject("/api/stations/x';drop/series")).statusCode, 400);
  assert.equal((await app.inject('/api/stations/ZZ99/series')).statusCode, 404);
});

test('GET /api/areas and /api/areas/:id/samples', async (t) => {
  if (!needDb(t)) return;
  const j = (await app.inject('/api/areas?bbox=75,15,76,16.5')).json();
  assert.equal(j.features.length, 1);
  const p = j.features[0].properties;
  assert.equal(p.name, 'Adagal');
  assert.equal(p.status, 'above_permissible');
  assert.equal(p.chemical_age_days, 38);
  assert.equal(p.approximate, false);
  assert.equal((await app.inject('/api/areas?bbox=nonsense')).statusCode, 400);
  assert.equal((await app.inject('/api/areas?bbox=80,20,81,21')).json().features.length, 0);
  const s = (await app.inject(`/api/areas/${p.id}/samples`)).json();
  assert.equal(s.samples.length, 2);
  assert.equal(s.samples[0].sample_id, 'U1S1');
  assert.equal(s.samples[0].results.length, 2);
  assert.match(s.samples[0].report_url, /final_report_print\?s_id=abc%2B%2F%3D$/);
  assert.equal((await app.inject('/api/areas/999999/samples')).statusCode, 404);
});

test('GET /api/nearby returns distances and ages; rejects points outside India', async (t) => {
  if (!needDb(t)) return;
  const j = (await app.inject('/api/nearby?lat=15.6&lng=75.6&radius_km=15')).json();
  assert.equal(j.areas[0].name, 'Adagal');
  assert.ok(j.areas[0].distance_km > 5 && j.areas[0].distance_km < 8);
  assert.equal(j.areas[0].within_radius, true);
  assert.equal(j.stations[0].station_no, 'UK55');
  assert.equal(j.stations[0].within_radius, false);
  assert.equal((await app.inject('/api/nearby?lat=51.5&lng=-0.1')).statusCode, 400);
  assert.equal((await app.inject('/api/nearby?lat=abc&lng=1')).statusCode, 400);
});

test('subscription: validation, double opt-in, confirm, unsubscribe (GET and one-click POST)', async (t) => {
  if (!needDb(t)) return;
  const ok = { email: 'Resident@Example.in', lat: 16.18, lng: 75.7, radius_km: 15, kinds: ['river', 'tap'] };
  let n = 0;
  const bad = async (body) => (await app.inject({ method: 'POST', url: '/api/subscriptions', payload: body, remoteAddress: `10.9.0.${n++}` })).statusCode;
  assert.equal(await bad({ ...ok, email: 'not-an-email' }), 400);
  assert.equal(await bad({ ...ok, lat: 51.5, lng: -0.1 }), 400);
  assert.equal(await bad({ ...ok, radius_km: 80 }), 400);
  assert.equal(await bad({ ...ok, kinds: [] }), 400);
  assert.equal(await bad({ ...ok, kinds: ['everything'] }), 400);

  const r = await app.inject({ method: 'POST', url: '/api/subscriptions', payload: ok, remoteAddress: '10.0.0.1' });
  assert.equal(r.statusCode, 202);
  assert.deepEqual(r.json(), { status: 'confirmation_sent', email: 'resident@example.in' });
  const mail = outbox.at(-1);
  assert.equal(mail.to, 'resident@example.in');
  assert.match(mail.text, /near Adagal/);
  const confirm = mail.text.match(/http:\/\/site\.test(\/api\/subscriptions\/confirm\?token=[\w-]+)/)?.[1];
  assert.ok(confirm);
  const [pending] = await sql`select confirmed_at from subscription where email = 'resident@example.in'`;
  assert.equal(pending.confirmed_at, null, 'not active until confirmed');

  const c = await app.inject(confirm);
  assert.equal(c.statusCode, 303);
  assert.equal(c.headers.location, '/?subscribed=ok');
  assert.equal((await app.inject('/api/subscriptions/confirm?token=wrong-token-123')).headers.location, '/?subscribed=invalid');

  const unsub = mail.headers['List-Unsubscribe'].slice(1, -1).replace('http://site.test', '');
  const u = await app.inject(unsub);
  assert.equal(u.headers.location, '/?unsubscribed=ok');
  const [row] = await sql`select confirmed_at, unsubscribed_at from subscription where email = 'resident@example.in'`;
  assert.ok(row.confirmed_at && row.unsubscribed_at);
  assert.equal((await app.inject({ method: 'POST', url: unsub })).statusCode, 200, 'one-click POST is idempotent');
});

test('subscription rate limits: per email (3/hour) and per IP (5/hour)', async (t) => {
  if (!needDb(t)) return;
  const body = { email: 'busy@example.in', lat: 16.18, lng: 75.7, radius_km: 5, kinds: ['digest'] };
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: 'POST', url: '/api/subscriptions', payload: body, remoteAddress: `10.1.0.${i}` })).statusCode);
  assert.deepEqual(codes, [202, 202, 202, 429]);
  const ipCodes = [];
  for (let i = 0; i < 6; i++) ipCodes.push((await app.inject({ method: 'POST', url: '/api/subscriptions', payload: { ...body, email: `ip${i}@example.in` }, remoteAddress: '10.2.0.1' })).statusCode);
  assert.equal(ipCodes.at(-1), 429);
});

test('POST /api/dev/simulate creates a mock alert that reaches confirmed subscribers nearby', async (t) => {
  if (!needDb(t)) return;
  await sql`insert into subscription (email, geom, radius_km, kinds, confirmed_at, unsubscribe_token) values ('near@example.in', ST_SetSRID(ST_MakePoint(75.7, 16.18), 4326)::geography, 15, '{river,tap,overdue,digest}', now(), 'unsub-near-123456')`;
  const r = await app.inject({ method: 'POST', url: '/api/dev/simulate?kind=tap_contamination' });
  assert.equal(r.statusCode, 201);
  const j = r.json();
  assert.equal(j.kind, 'tap_contamination');
  assert.equal(j.simulated, true);
  assert.ok(j.deliveries >= 1);
  const [a] = await sql`select is_mock, severity from alert where id = ${j.alert_id}`;
  assert.deepEqual({ ...a }, { is_mock: true, severity: 'urgent' });
  assert.equal((await app.inject({ method: 'POST', url: '/api/dev/simulate?kind=bogus' })).statusCode, 400);
  const al = (await app.inject('/api/alerts?include_mock=true&lat=16.18&lng=75.7&radius_km=20')).json();
  assert.ok(al.alerts.some((x) => x.id === j.alert_id));
  assert.ok(!(await app.inject('/api/alerts')).json().alerts.some((x) => x.is_mock), 'mock alerts hidden unless asked for');
});

test('config, lags, dashboard, search', async (t) => {
  if (!needDb(t)) return;
  const c = (await app.inject('/api/config')).json();
  assert.equal(c.mock_mode, true);
  assert.equal(c.mock.subjects.gps.length, 3);
  assert.equal(c.criteria_class, 'C');
  const l = (await app.inject('/api/lags')).json();
  assert.equal(l.samples, 1);
  assert.equal(Math.round(l.collected_to_received), 3);
  await sql`insert into wq_daily_snapshot (snapshot_date, scope, payload) values (current_date, 'national', '{"total_tested_yesterday": 4005}')`;
  assert.equal((await app.inject('/api/dashboard/daily?days=7')).json().snapshots[0].payload.total_tested_yesterday, 4005);
  const s = (await app.inject('/api/search?q=adag')).json();
  assert.equal(s.results[0].name, 'Adagal');
  assert.equal(s.results[0].type, 'panchayat');
  assert.equal((await app.inject('/api/search?q=a')).statusCode, 400);
});

test('dev route does not exist without mock mode', async (t) => {
  if (!needDb(t)) return;
  const { config } = await import('@lt/core/config.js');
  const prev = config.mockMode;
  config.mockMode = false;
  const plain = await buildApp({ sql, logger: false, mailer: { send: async () => ({}) } });
  config.mockMode = prev;
  assert.equal((await plain.inject({ method: 'POST', url: '/api/dev/simulate' })).statusCode, 404);
  await plain.close();
});

test('server-rendered first paint: live hero and simulation band in the HTML, SPA fallback', async (t) => {
  if (!needDb(t)) return;
  const fsm = await import('node:fs');
  const dist = new URL('../../../web/dist/index.html', import.meta.url);
  if (!fsm.existsSync(dist)) return t.skip('web/dist not built');
  const page = await app.inject('/');
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /<html lang="en-IN" class="sim">/);
  assert.match(page.body, /<div class="sim-band" id="sim-band" role="status">/);
  assert.match(page.body, /<h1 id="hero-sentence" class="hero-sentence">The Ganga at Haridwar was measured <span class="num">20 minutes<\/span> ago\. Taps in Adagal were last lab-tested/);
  const deep = await app.inject('/some/deep/link?station=UK55');
  assert.equal(deep.statusCode, 200);
  assert.match(deep.body, /hero-sentence/);
  assert.equal((await app.inject('/api/nope')).statusCode, 404);
  assert.equal((await app.inject('/missing.js')).statusCode, 404);
});
