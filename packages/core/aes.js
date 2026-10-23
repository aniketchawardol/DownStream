// @ts-check
// WQMIS parameter encryption, mirroring the site's public aes.js:
// AES-128-CBC, key = IV = ASCII '8080808080808080', PKCS7 padding, base64 output.
import crypto from 'node:crypto';

const K = Buffer.from('8080808080808080');

/** @param {string|number} v */
export const enc = (v) => {
  const c = crypto.createCipheriv('aes-128-cbc', K, K);
  return Buffer.concat([c.update(String(v), 'utf8'), c.final()]).toString('base64');
};

/** @param {string} b */
export const dec = (b) => {
  const d = crypto.createDecipheriv('aes-128-cbc', K, K);
  return Buffer.concat([d.update(Buffer.from(b, 'base64')), d.final()]).toString('utf8');
};

/** enc() then URL-encode, for query strings (base64 contains + / =). @param {string|number} v */
export const encq = (v) => encodeURIComponent(enc(v));
