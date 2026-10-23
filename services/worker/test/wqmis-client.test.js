// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isBlankEnvelope } from '../lib/wqmis.js';

test('a lost-session blank envelope is told apart from a genuinely empty list', () => {
  const real = JSON.parse(fs.readFileSync(new URL('../../../fixtures/wqmis/samplelist-fil-59783-2025-2026-tested.json', import.meta.url), 'utf8'));
  assert.equal(isBlankEnvelope(real), false);
  assert.equal(isBlankEnvelope({ ...real, Labtestingdata: [], TotalPage: 0 }), false, 'empty but echoes FY and state');
  assert.equal(isBlankEnvelope({ FinancialYear: null, StateId: 0, Labtestingdata: null, TotalPage: 0 }), true);
});
