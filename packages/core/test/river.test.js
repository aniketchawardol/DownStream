// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCpcbLayer } from '../parsers/cpcb.js';
import { stepRiverState, stepSpikeState, silentEvent, robustZ, COOLDOWN_MS } from '../alerts/river.js';

const layer = JSON.parse(fs.readFileSync(new URL('../../../fixtures/cpcb/layer10.json', import.meta.url), 'utf8'));

/** The real UK55 (Haridwar) objects from the fixture, all within Class C, with DO set to 3.2 mg/l (minimum is 4). */
function lowDoFixture() {
  return layer.filter((o) => o.station_no === 'UK55').map((o) => (o.stationparameter_name === 'DO' ? { ...o, ts_value: 3.2 } : o));
}

/** Run one ingest cycle's worth of readings through the state machine. */
function run(readings, states) {
  const events = [];
  for (const r of readings) {
    const k = `${r.station_no}|${r.parameter}`;
    const out = stepRiverState(states.get(k), r, 'C');
    states.set(k, out.state);
    events.push(...out.events);
  }
  return events;
}

test('DO = 3.2 mg/l raises exactly one river_threshold alert, and a repeat run raises none', () => {
  const { readings } = parseCpcbLayer(lowDoFixture());
  const states = new Map();
  const first = run(readings, states).filter((e) => e.kind === 'river_threshold');
  assert.equal(first.length, 1, `expected one alert, got ${first.map((e) => e.parameter).join(', ')}`);
  assert.equal(first[0].parameter, 'DO');
  assert.equal(first[0].value, 3.2);
  assert.deepEqual(first[0].limit, { min: 4 });
  assert.match(first[0].dedupe_key, /^river_threshold:UK55:DO:\d{4}-\d{2}-\d{2}T\d{2}$/);
  const again = run(parseCpcbLayer(lowDoFixture()).readings, states);
  assert.equal(again.length, 0);
});

const at = (h) => new Date(Date.UTC(2026, 9, 23, 0) + h * 3600_000);
const r = (h, value) => ({ station_no: 'UK55', parameter: 'DO', value, measured_at: at(h) });

test('hysteresis: one alert per violation episode, recovery after two good readings, 6-hour cooldown', () => {
  const states = new Map();
  const seq = [[0, 6], [1, 3.5], [2, 3.1], [3, 3.4], [4, 5], [5, 5.2], [6, 3.6], [7, 6], [8, 6], [13, 3.0]];
  const events = run(seq.map(([h, v]) => r(h, v)), states);
  assert.deepEqual(events.map((e) => `${e.kind}@${e.measured_at.getUTCHours()}`), [
    'river_threshold@1', // first transition into violation
    'river_recovered@5', // two consecutive good readings (4, 5)
    // 6: back into violation but within 6 h of the alert at 1 -> muted, and its recovery is not announced
    'river_threshold@13', // 12 h after the last alert -> fires again
  ]);
  assert.ok(at(13).getTime() - at(1).getTime() >= COOLDOWN_MS);
});

test('readings at or before the last processed timestamp are ignored', () => {
  const states = new Map();
  run([r(5, 3)], states);
  assert.equal(run([r(5, 3), r(4, 2)], states).length, 0);
});

test('parameters without river criteria never raise threshold alerts', () => {
  const states = new Map();
  const ev = run([{ station_no: 'UK55', parameter: 'WTb', value: 900, measured_at: at(1) }], states);
  assert.equal(ev.length, 0);
});

test('spikes: upward only, at least 25% above the weekly median, once per episode', () => {
  const window = Array.from({ length: 168 }, (_, i) => 20 + Math.sin(i) * 2);
  const wtb = (h, value) => ({ station_no: 'UK55', parameter: 'WTb', value, measured_at: at(h) });
  let st = null;
  const step = (h, v) => { const o = stepSpikeState(st, wtb(h, v), window); st = o.state; return o.events; };
  assert.equal(step(1, 21).length, 0, 'normal reading');
  const ev = step(2, 95);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'river_spike');
  assert.ok(ev[0].z > 4);
  assert.equal(ev[0].dedupe_key, 'river_spike:UK55:WTb:2026-10-23T02');
  assert.equal(step(3, 99).length, 0, 'still elevated: same episode, no repeat');
  step(4, 20); step(5, 21);
  assert.equal(step(6, 96).length, 0, 'new episode inside the 6-hour cooldown stays quiet');
  step(7, 20); step(8, 20);
  assert.equal(step(9, 97).length, 1, 'after the cooldown a new episode fires');
});

test('spikes ignore drops, instrument floors, tiny rises and flat sensors', () => {
  const window = Array.from({ length: 168 }, (_, i) => 280 + Math.sin(i) * 3);
  const one = (parameter, value, w = window) => stepSpikeState(null, { station_no: 'BH72', parameter, value, measured_at: at(1) }, w).events.length;
  assert.equal(one('EC', 150), 0, 'a drop is not a spike');
  assert.equal(one('EC', 1), 0, 'EC = 1 is the instrument floor');
  assert.equal(one('EC', 300), 0, 'z is large but the rise is only 7%');
  assert.equal(one('EC', 380), 1, '+36% and far outside the usual range');
  assert.equal(one('DO', 95), 0, 'DO has an official limit, so no spike check');
  assert.equal(one('CL', 30, Array(60).fill(5)), 0, 'window entirely at the CL floor: nothing to compare with');
  assert.equal(robustZ(5, [1, 1, 1]), null, 'too few points');
  assert.equal(robustZ(5, Array(60).fill(1)), null, 'flat window has MAD 0');
});

test('silent station after 6 hours, keyed to the silence episode', () => {
  const last = at(0);
  assert.equal(silentEvent('BH75', last, at(5)), null);
  const ev = silentEvent('BH75', last, at(7));
  assert.equal(ev?.dedupe_key, `river_station_silent:BH75:${last.toISOString()}`);
  assert.deepEqual(silentEvent('BH75', last, at(30))?.dedupe_key, ev?.dedupe_key);
});
