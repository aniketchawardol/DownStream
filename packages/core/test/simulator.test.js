// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildMockAlert, simSubjects, pickKind, SIM_KINDS } from '../simulator.js';
import { STATION_META } from '../stations.js';
import { haversineKm } from '../geo.js';
import { config } from '../config.js';

const gpNames = JSON.parse(fs.readFileSync(new URL('../../../fixtures/wqmis/gps-2481.json', import.meta.url), 'utf8'))
  .map((g) => g.PanchayatName).filter((n) => n && !/select/i.test(n));
const realNames = [...Object.keys(STATION_META), ...Object.values(STATION_META).map((m) => m.place), ...gpNames, 'Adagal', 'Bagalkote', 'Badami'];

test('every simulated kind names only fictional subjects near the mock point', () => {
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const kind of SIM_KINDS) {
    for (let i = 0; i < 20; i++) {
      const m = buildMockAlert(kind, { rnd });
      const text = JSON.stringify(m);
      for (const name of realNames) assert.ok(!new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text), `${kind} mentions real name ${name}`);
      assert.match(m.title + JSON.stringify(m.body), /SIM-/);
      assert.equal(m.body.simulated, true);
      assert.ok(haversineKm(config.mockLat, config.mockLng, m.lat, m.lng) < 12, 'within a few km of the mock point');
    }
  }
});

test('subjects are deterministic and labelled as tests', () => {
  const s = simSubjects();
  assert.deepEqual(s, simSubjects());
  for (const x of [...s.stations, ...s.gps]) assert.match(x.name, /^Test (river station|panchayat) SIM-/);
});

test('kind picker leans towards urgent alerts', () => {
  let i = 0;
  const seq = Array.from({ length: 1000 }, (_, k) => (k + 0.5) / 1000);
  const counts = {};
  for (let k = 0; k < 1000; k++) { const kind = pickKind(() => seq[i++]); counts[kind] = (counts[kind] || 0) + 1; }
  assert.ok(counts.tap_contamination + counts.river_threshold > 450);
  assert.ok(SIM_KINDS.every((k) => counts[k] > 0));
});
