// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCitizenReport, cleanDetails, HAS_LINK, DETAILS_MAX } from '../alerts/citizen.js';
import { renderAlertEmail } from '../email/templates.js';
import { config } from '../config.js';

test('a citizen report sits exactly on the simulation test point', () => {
  const a = buildCitizenReport({ issue: 'dead_fish', water: 'river', details: 'Dozens near the ghat', urgent: true });
  assert.equal(a.lat, config.mockLat);
  assert.equal(a.lng, config.mockLng);
  assert.equal(a.kind, 'citizen_report');
  assert.equal(a.severity, 'urgent');
  assert.equal(a.group, 'river');
  assert.equal(a.title, 'Citizen report: dead fish in the river at the test point');
  assert.equal(a.body.site_path, '/?sim=SIM-POINT');
  const tap = buildCitizenReport({ issue: 'illness', water: 'tap' });
  assert.equal(tap.severity, 'notice');
  assert.equal(tap.group, 'tap', 'tap reports reach tap subscribers');
  assert.match(tap.title, /people falling ill after drinking the tap water/);
});

test('details: whitespace and control characters collapse; length is capped; links are spotted', () => {
  assert.equal(cleanDetails('  foam\n\n on\tthe\u0007 water  '), 'foam on the water');
  assert.equal(buildCitizenReport({ issue: 'other', water: 'river', details: 'x'.repeat(400) }).body.details.length, DETAILS_MAX);
  for (const s of ['see http://x.example', 'go to www.example.org', 'visit bad-site.xyz now']) assert.ok(HAS_LINK.test(s), s);
  for (const s of ['dead fish at 7 am', 'the water is 2.5 m deep']) assert.ok(!HAS_LINK.test(s), s);
});

test('report email: quotes the reporter, names the test point, says nobody has checked it, escapes HTML', () => {
  const a = buildCitizenReport({ issue: 'sewage', water: 'river', details: 'Black water <script>alert(1)</script> from the drain', urgent: true }, { now: new Date('2026-11-07T05:30:00Z') });
  const e = renderAlertEmail(
    { lat: config.mockLat, lng: config.mockLng, radius_km: 15, unsubscribe_token: 'tok_unsub_123456' },
    [{ ...a, is_mock: true }],
    'https://example.test',
  );
  assert.equal(e.subject, '[Simulated] Citizen report: sewage or waste flowing into the river at the test point');
  assert.match(e.text, /Someone at the simulation test point reported sewage or waste flowing into the river, in their words: “Black water <script>alert\(1\)<\/script> from the drain”\. Reported at 11:00 IST/);
  assert.match(e.text, /Where: the simulation test point \(16\.1800, 75\.7000\), 0 km from your pin\./);
  assert.match(e.text, /No laboratory or authority has checked it/);
  assert.match(e.text, /https:\/\/example\.test\/\?sim=SIM-POINT/);
  assert.ok(!e.html.includes('<script>'), 'escaped in HTML');
  assert.match(e.html, /&lt;script&gt;/);
});
