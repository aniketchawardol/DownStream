// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riverCheck, parseLimitText, judgeTapResult, canonicalParam, bacteriaPresent, worstStatus } from '../thresholds.js';

test('river criteria for class B and C', () => {
  assert.equal(riverCheck('DO', 4.5, 'C')?.violation, false);
  assert.equal(riverCheck('DO', 4.5, 'B')?.violation, true);
  assert.equal(riverCheck('pH', 9.2, 'C')?.violation, true);
  assert.equal(riverCheck('pH', 8.8, 'C')?.violation, false);
  assert.equal(riverCheck('BOD', 3.01, 'C')?.violation, true);
  assert.equal(riverCheck('WTb', 500, 'C'), null);
});

test('printed limit text', () => {
  assert.deepEqual(parseLimitText('6.5-8.5'), { min: 6.5, max: 8.5 });
  assert.deepEqual(parseLimitText('6.5 - 8.5'), { min: 6.5, max: 8.5 });
  assert.deepEqual(parseLimitText('1'), { max: 1 });
  assert.deepEqual(parseLimitText('0.2 (Min)'), { min: 0.2 });
  assert.equal(parseLimitText('No relaxation'), 'no_relaxation');
  assert.deepEqual(parseLimitText('Shall not be detectable in any 100 ml sample'), { absent: true });
  assert.equal(parseLimitText('-'), null);
});

test('tap results prefer printed limits and fall back to BIS', () => {
  assert.equal(judgeTapResult({ parameter: 'Fluoride', value: 1.2, acceptable_limit: '1', permissible_limit: '1.5' }).status, 'above_acceptable');
  assert.equal(judgeTapResult({ parameter: 'Fluoride', value: 1.6 }).status, 'above_permissible');
  const printed = judgeTapResult({ parameter: 'Fluoride', value: 1.2, acceptable_limit: '1.5', permissible_limit: '2' });
  assert.equal(printed.status, 'ok');
  assert.equal(printed.limits_from, 'report');
  assert.equal(judgeTapResult({ parameter: 'Nitrate', value: 50, acceptable_limit: '45', permissible_limit: 'No relaxation' }).status, 'above_permissible');
  assert.equal(judgeTapResult({ parameter: 'pH', value: 8.7 }).status, 'above_permissible');
  assert.equal(judgeTapResult({ parameter: 'Total Dissolved Solids', value: 900 }).status, 'above_acceptable');
  assert.equal(judgeTapResult({ parameter: 'E.Coli', value: null, value_text: 'Present' }).status, 'above_permissible');
  assert.equal(judgeTapResult({ parameter: 'Total Coliform', value: null, value_text: 'Absent' }).status, 'ok');
  assert.equal(judgeTapResult({ parameter: 'Mystery', value: 3 }).status, 'unknown');
});

test('parameter names map to canonical keys', () => {
  assert.equal(canonicalParam('Total Dissolved Solids (TDS)'), 'tds');
  assert.equal(canonicalParam('E. coli'), 'e_coli');
  assert.equal(canonicalParam('Total Coliform Bacteria'), 'total_coliform');
  assert.equal(canonicalParam('Nitrate as NO3'), 'nitrate');
  assert.equal(canonicalParam('pH Value'), 'ph');
  assert.equal(canonicalParam('Residual Free Chlorine'), 'residual_chlorine');
});

test('bacteria present/absent text and worst status', () => {
  assert.equal(bacteriaPresent('Absent'), false);
  assert.equal(bacteriaPresent('Not Detected'), false);
  assert.equal(bacteriaPresent('Present'), true);
  assert.equal(bacteriaPresent(''), null);
  assert.equal(worstStatus(['ok', 'above_acceptable', 'ok']), 'above_acceptable');
  assert.equal(worstStatus(['unknown', 'ok']), 'ok');
  assert.equal(worstStatus(['unknown']), 'unknown');
  assert.equal(worstStatus([]), 'unknown');
});
