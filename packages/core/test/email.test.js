// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAlertEmail, renderConfirmation, renderDigest, fill, ALERT_TEMPLATES } from '../email/templates.js';
import { riverAlert, tapAlert } from '../alerts/describe.js';
import { buildMockAlert } from '../simulator.js';

const BASE = 'https://example.test';
const sub = { lat: 29.9, lng: 78.1, radius_km: 10, unsubscribe_token: 'tok_unsub_123456' };

test('templates fill placeholders and leave no braces behind', () => {
  assert.equal(fill('{a} and {b}', { a: 1 }), '1 and ');
  for (const t of Object.values(ALERT_TEMPLATES)) assert.match(t, /\{\w+\}/);
});

test('river alert email: value, limit, place, distance, source, link, unsubscribe', () => {
  const a = riverAlert('river_threshold', { station_no: 'UK55', station_name: 'D/s of Har Ki Pauri, Dam Kothi, Haridwar', place: 'Haridwar', river: 'Ganga' },
    { parameter: 'DO', value: 3.2, unit: 'mg/l', measured_at: new Date('2026-10-23T04:30:00Z'), limit: { min: 4 }, criteria_class: 'C' });
  const e = renderAlertEmail(sub, [{ ...a, kind: 'river_threshold', lat: 29.9415, lng: 78.1576, is_mock: false, severity: 'urgent' }], BASE);
  assert.equal(e.subject, 'Dissolved oxygen below the limit at Haridwar');
  assert.match(e.text, /Dissolved oxygen was 3\.2 mg\/l in the Ganga at Haridwar \(river water at CPCB station UK55\), outside the limit of at least 4 mg\/l/);
  assert.match(e.text, /10:00 IST on 23 Oct 2026/);
  assert.match(e.text, /km from your pin/);
  assert.match(e.text, /This is river water, not tap water/);
  assert.match(e.text, /https:\/\/example\.test\/\?station=UK55/);
  assert.match(e.text, /https:\/\/example\.test\/api\/unsubscribe\?token=tok_unsub_123456/);
  assert.equal(e.headers['List-Unsubscribe'], '<https://example.test/api/unsubscribe?token=tok_unsub_123456>');
  assert.equal(e.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(!/\{\w+\}/.test(e.text), 'no unfilled placeholders');
  assert.match(e.html, /max-width:600px/);
  assert.match(e.html, /border-top:4px solid #1E5E8A/);
});

test('tap alert email has all three dates and the government report link', () => {
  const a = tapAlert('tap_contamination', { area_id: 7, gp_name: 'Adagal', block: 'Badami', district: 'Bagalkote' },
    { sample_id: 'U1S2', source_name: 'a household tap (deep tubewell)', village_name: 'Adagal', collected_at: new Date('2026-03-05T07:00:00Z'), analysed_at: new Date('2026-03-06T11:35:00Z'), first_seen_at: new Date('2026-10-23T05:00:00Z'), report_url: 'https://ejalshakti.gov.in/WQMIS/Common/final_report_print?s_id=x' },
    [{ parameter_label: 'E. coli', value_text: '5.000', unit: 'CFU/100 ml', acceptable_text: 'Shall not be detectable in any 100 ml sample', permissible_text: 'No Relaxation', status: 'above_permissible' }]);
  const e = renderAlertEmail(sub, [{ ...a, kind: 'tap_contamination', lat: 29.95, lng: 78.12, is_mock: false, severity: 'urgent' }], BASE);
  assert.match(e.text, /Collected 5 Mar 2026\. Analysed 6 Mar 2026\. First seen by this site 23 Oct 2026\./);
  assert.match(e.text, /Government lab report: https:\/\/ejalshakti/);
  assert.match(e.text, /E\. coli at 5\.000 CFU\/100 ml/);
  assert.match(e.text, /Adagal village, Adagal panchayat, Badami block, Bagalkote district/);
  assert.ok(!/safe/i.test(e.text.replace(/safe to drink between official tests/, '')), 'never calls water safe');
});

test('simulated alerts: subject prefix, first line says invented, no real-source wording', () => {
  const m = buildMockAlert('tap_contamination', { rnd: () => 0.3 });
  const e = renderAlertEmail(sub, [{ ...m, lat: m.lat, lng: m.lng, is_mock: true, severity: 'urgent' }], BASE);
  assert.match(e.subject, /^\[Simulated\] /);
  assert.match(e.text.split('\n')[0], /simulated.*invented/i);
  assert.match(e.text, /Source: the simulator/);
  assert.ok(!/CPCB station|JJM laboratory/.test(e.text));
  assert.ok(!/panchayat panchayat/i.test(e.text + e.subject));
});

test('bundles list urgent first and use a count subject', () => {
  const r = buildMockAlert('river_spike', { rnd: () => 0.5 });
  const t = buildMockAlert('tap_contamination', { rnd: () => 0.5 });
  const e = renderAlertEmail(sub, [{ ...r, is_mock: true, severity: 'notice' }, { ...t, is_mock: true, severity: 'urgent' }], BASE);
  assert.equal(e.subject, '[Simulated] 2 water alerts within 10 km of your pin');
  assert.ok(e.text.indexOf('Urgent:') < e.text.indexOf('Notice:'));
});

test('confirmation and digest emails', () => {
  const c = renderConfirmation({ email: 'a@b.in', lat: 16.18, lng: 75.7, radius_km: 15, kinds: ['river', 'digest'], confirm_token: 'conf_tok_123456', unsubscribe_token: 'u_tok_1234567', near: 'Adagal' }, BASE);
  assert.match(c.text, /api\/subscriptions\/confirm\?token=conf_tok_123456/);
  assert.match(c.text, /A river reading crosses a safe limit; A weekly summary/);
  assert.match(c.text, /near Adagal/);
  const d = renderDigest(sub, { alerts: [], simulatedCount: 3, stations: [], areas: [{ name: 'Adagal', last_test: null, status: null, distance_km: 2, known_since: '1 Apr 2025' }], weekStart: new Date('2026-10-16T00:00:00Z'), weekEnd: new Date('2026-10-23T00:00:00Z') }, BASE);
  assert.match(d.text, /No new alerts from official data this week/);
  assert.match(d.text, /3 simulated alerts were also sent this week/);
  assert.match(d.text, /Adagal panchayat: no lab test found since 1 Apr 2025/);
});

test('reserved test domains never reach a real provider', async () => {
  const { routeFor, RESERVED_TEST_DOMAIN } = await import('../email/mailer.js');
  for (const a of ['loop-1@example.com', 'x@mail.example.org', 'y@site.test', 'z@foo.invalid', 'k@a.localhost']) assert.ok(RESERVED_TEST_DOMAIN.test(a), a);
  for (const a of ['someone@gmail.com', 'a@example.co.in', 'b@notexample.com', 'c@testing.in']) assert.ok(!RESERVED_TEST_DOMAIN.test(a), a);
  assert.equal(routeFor('someone@gmail.com', { sink: true, production: false }), 'main');
  assert.equal(routeFor('loop@example.com', { sink: true, production: false }), 'sink', 'development: test addresses go to Mailpit');
  assert.equal(routeFor('loop@example.com', { sink: false, production: true }), 'skip', 'production: dropped, never bounced');
  assert.equal(routeFor('loop@example.com', { sink: false, production: false }), 'main', 'Mailpit-only setups keep working');
});
