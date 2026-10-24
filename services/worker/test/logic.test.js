// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, WINDOW_MS } from '../jobs/mailer.js';
import { isOverdue } from '../jobs/overdue.js';
import { pickHit } from '../jobs/geocode.js';
import { resultsFromList } from '../jobs/wqmis-samples.js';
import { parseSampleListJson } from '@lt/core/parsers/wqmis-samplelist.js';
import fs from 'node:fs';

const now = new Date('2026-10-23T06:00:00Z');

test('mailer batching: one email per 15-minute window, urgent always goes, cap sends overflow to digest', () => {
  const base = { hasUrgent: false, lastSentAt: null, sentToday: 0, now, cap: 6 };
  assert.equal(decide(base), 'send', 'nothing sent yet');
  assert.equal(decide({ ...base, lastSentAt: new Date(now.getTime() - 5 * 60_000) }), 'wait', 'inside the window');
  assert.equal(decide({ ...base, lastSentAt: new Date(now.getTime() - WINDOW_MS) }), 'send', 'window over');
  assert.equal(decide({ ...base, hasUrgent: true, lastSentAt: new Date(now.getTime() - 60_000) }), 'send', 'urgent ignores the window');
  assert.equal(decide({ ...base, sentToday: 6 }), 'to_digest', 'cap reached');
  assert.equal(decide({ ...base, sentToday: 9, hasUrgent: true }), 'send', 'urgent ignores the cap');
});

test('overdue: 12 months chemical, 6 months bacteriological, and only judge what we can see', () => {
  const since = new Date('2025-04-01T00:00:00+05:30');
  const months = (m) => new Date(now.getTime() - m * 30.44 * 86400_000);
  assert.equal(isOverdue(months(13), now, 12, since), true);
  assert.equal(isOverdue(months(11), now, 12, since), false);
  assert.equal(isOverdue(months(7), now, 6, since), true);
  assert.equal(isOverdue(null, now, 12, since), true, 'no test since April 2025 and 18+ months visible');
  assert.equal(isOverdue(null, now, 12, new Date('2026-04-01T00:00:00+05:30')), false, 'only 7 months of history: cannot say');
});

test('geocode picks a settlement within range of its block', () => {
  const block = { lat: 15.92, lng: 75.68 };
  const hits = [
    { lat: 28.6, lng: 77.2, type: 'village', importance: 0.9, name: 'Far away namesake' },
    { lat: 15.95, lng: 75.7, type: 'river', importance: 0.6, name: 'River' },
    { lat: 15.97, lng: 75.66, type: 'village', importance: 0.3, name: 'Right one' },
  ];
  assert.equal(pickHit(hits, block, 35)?.name, 'Right one');
  assert.equal(pickHit(hits.slice(0, 1), block, 35), null);
});

test('list values: lab-flagged contamination wins, BIS limits fill in until a report is read', () => {
  const j = JSON.parse(fs.readFileSync(new URL('../../../fixtures/wqmis/samplelist-fil-block-2481-2025-2026-contaminated.json', import.meta.url), 'utf8'));
  const row = parseSampleListJson(j).rows.find((r) => r.sample_id === 'U1359972S35124026');
  assert.ok(row);
  const res = resultsFromList(row, new Map());
  const by = Object.fromEntries(res.map((r) => [r.parameter, r]));
  assert.equal(by.e_coli.status, 'above_permissible');
  assert.equal(by.hardness.status, 'above_permissible');
  assert.equal(by.hardness.limits_source, 'bis');
  assert.equal(by.hardness.permissible_limit, '600');
  assert.equal(by.ph.status, 'ok');
  const learned = new Map([['hardness', { acceptable_limit: '200', permissible_limit: '600' }]]);
  assert.equal(resultsFromList(row, learned).find((r) => r.parameter === 'hardness')?.limits_source, 'wqmis');
});

test('TLS for Render external database URLs only', async () => {
  const { needsTls } = await import('@lt/core/db.js');
  assert.equal(needsTls('postgresql://u:p@dpg-abc123-a.singapore-postgres.render.com/water'), true, 'external, used by GitHub Actions');
  assert.equal(needsTls('postgresql://u:p@dpg-abc123-a/water'), false, 'internal, used by the web service');
  assert.equal(needsTls('postgres://water:water@db:5432/water'), false);
  assert.equal(needsTls('postgres://u:p@example.org/db?sslmode=require'), true);
});

test('simulator tick: off without MOCK_MODE', async () => {
  const { simulatorTick } = await import('../jobs/simulator.js');
  const { config } = await import('@lt/core/config.js');
  const prev = config.mockMode;
  config.mockMode = false;
  assert.deepEqual(await simulatorTick(/** @type {any} */ (null)), { fired: false, reason: 'MOCK_MODE is off' });
  config.mockMode = prev;
});

test('every scheduled job has a one-shot run() entrypoint', async () => {
  for (const name of ['cpcb', 'wqmis-hierarchy', 'wqmis-samples', 'wqmis-reports', 'wqmis-dashboard', 'geocode', 'overdue', 'digest', 'mailer', 'simulator', 'bootstrap']) {
    const mod = await import(`../jobs/${name}.js`);
    assert.equal(typeof mod.run, 'function', `${name}.js exports run()`);
  }
});
