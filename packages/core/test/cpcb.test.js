// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCpcbLayer, parseCpcbSeries, parseDiary } from '../parsers/cpcb.js';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`../../../fixtures/cpcb/${name}`, import.meta.url), 'utf8'));

test('layer fixture parses into 40 stations and one reading per station x parameter', () => {
  const { stations, readings, warnings } = parseCpcbLayer(fixture('layer10.json'));
  assert.equal(stations.length, 40);
  assert.equal(readings.length, 468);
  assert.deepEqual(warnings, []);
  const ut67 = stations.find((s) => s.station_no === 'UT67');
  assert.ok(ut67);
  assert.equal(ut67.name, 'Kheerveer Bridge, Kishundaspur Road, Pratapgarh');
  assert.equal(ut67.state, 'Uttar Pradesh');
  assert.equal(ut67.site_no, 'DSP_SWAN');
  assert.equal(ut67.parameters.DO, 'DO');
  assert.ok(ut67.lat > 25 && ut67.lat < 26 && ut67.lng > 81 && ut67.lng < 83);
  const ph = readings.find((r) => r.station_no === 'UT67' && r.parameter === 'pH');
  assert.equal(ph?.unit, null, "pH unit '---' becomes null");
  assert.ok(ph?.measured_at instanceof Date && !Number.isNaN(ph.measured_at.getTime()));
});

test('layer parser survives junk without throwing', () => {
  assert.deepEqual(parseCpcbLayer({ not: 'an array' }).stations, []);
  const r = parseCpcbLayer([null, 5, { station_no: 'X1' }, { station_no: 'X2', station_latitude: 25, station_longitude: 82, stationparameter_name: 'DO', ts_value: 'n/a', timestamp: '2026-10-23T04:30:00.000Z' }]);
  assert.equal(r.readings.length, 0);
  assert.equal(r.stations.length, 1);
  assert.match(r.warnings[0], /skipped/);
});

test('diary pairs outage starts with their ends', () => {
  const d = parseDiary('2023-11-05 15:00:00: FM Start: Technical issue<br>2024-10-20 16:00:00: FM End: Technical issue<br>2024-12-18 10:00:00: FM Start: Flood event');
  assert.equal(d.length, 2);
  assert.deepEqual(d[0], { start: '2023-11-05T15:00:00+05:30', end: '2024-10-20T16:00:00+05:30', reason: 'Technical issue' });
  assert.equal(d[1].end, null);
  assert.deepEqual(parseDiary(''), []);
});

test('week.json history parses to readings; an empty stale series yields none', () => {
  const { readings } = parseCpcbSeries(fixture('week-UT67-DO.json'));
  assert.ok(readings.length > 100);
  assert.ok(readings.every((r) => r.station_no === 'UT67' && r.parameter === 'DO' && r.unit === 'mg/l'));
  assert.equal(parseCpcbSeries(fixture('week-WB90-DO-stale.json')).readings.length, 0);
});
