// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fiscalYear, previousFiscalYear, parseIstDate, istDate, istClock, humanAge } from '../time.js';

test('fiscal year starts on 1 April IST', () => {
  assert.equal(fiscalYear(new Date('2026-10-23T00:00:00Z')), '2026-2027');
  assert.equal(fiscalYear(new Date('2026-03-31T18:00:00Z')), '2025-2026', '31 Mar 23:30 IST');
  assert.equal(fiscalYear(new Date('2026-03-31T18:30:00Z')), '2026-2027', '1 Apr 00:00 IST');
  assert.equal(previousFiscalYear('2026-2027'), '2025-2026');
});

test('IST wall-clock dates parse to the right UTC instant', () => {
  assert.equal(parseIstDate('23/10/2026')?.toISOString(), '2026-10-22T18:30:00.000Z');
  assert.equal(parseIstDate('23-10-2026 14:05')?.toISOString(), '2026-10-23T08:35:00.000Z');
  assert.equal(parseIstDate('23-Oct-2026 02:05 PM')?.toISOString(), '2026-10-23T08:35:00.000Z');
  assert.equal(parseIstDate('2026-10-23')?.toISOString(), '2026-10-22T18:30:00.000Z');
  assert.equal(parseIstDate('2026-10-23T04:30:00.000Z')?.toISOString(), '2026-10-23T04:30:00.000Z');
  for (const junk of ['', '-', 'NA', null, undefined, '31/13/2026', 'soon']) assert.equal(parseIstDate(junk), null);
});

test('display helpers use IST', () => {
  const d = new Date('2026-10-23T05:00:00Z');
  assert.equal(istDate(d), '2026-10-23');
  assert.equal(istClock(d), '10:30 IST');
  assert.equal(humanAge(14 * 60_000), '14 minutes');
  assert.equal(humanAge(3 * 3600_000), '3 hours');
  assert.equal(humanAge(13 * 86400_000), '13 days');
  assert.equal(humanAge(130 * 86400_000), '4 months');
});
