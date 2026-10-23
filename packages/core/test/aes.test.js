// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enc, dec, encq } from '../aes.js';

test('AES matches the verified WQMIS test vectors', () => {
  assert.equal(enc('15'), 'n4y3XImHOT34OR3rSpPhoQ==');
  assert.equal(enc('19365256'), 'wTFPbUYrtkpKCPa8pkatkA==');
  assert.equal(enc(15), enc('15'));
});

test('AES round-trips and URL-encodes base64 for query strings', () => {
  for (const v of ['0', '187', '2481', '59783', '2025-2026']) assert.equal(dec(enc(v)), v);
  assert.equal(encq('15'), 'n4y3XImHOT34OR3rSpPhoQ%3D%3D');
  assert.ok(!/[+/=]/.test(encq('2025-2026')));
});
