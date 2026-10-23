// @ts-check
// Shared helpers for the live probe scripts. Node built-ins only.
// Probes are the only code that hits government servers; they are run by hand, never in CI.
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(ROOT, 'fixtures');
const CONTACT = process.env.CONTACT_EMAIL || 'you@example.com';
export const UA = `DownStream/0.1 (water-quality transparency site; probe; +contact: ${CONTACT})`;
const MIN_INTERVAL_MS = Number(process.env.PROBE_MIN_INTERVAL_MS || 600);

/** @type {Map<string, Promise<unknown>>} one in-flight request per host */
const hostChains = new Map();
/** @type {Map<string, number>} */
const hostLast = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal cookie jar: name=value per host, enough for ASP.NET session + antiforgery cookies.
 */
export class CookieJar {
  constructor() { /** @type {Map<string,string>} */ this.cookies = new Map(); }
  /** @param {string[]|string|undefined} setCookie */
  store(setCookie) {
    if (!setCookie) return;
    for (const c of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

/**
 * Polite HTTPS request: serialised per host, >= MIN_INTERVAL_MS apart.
 * @param {string} url
 * @param {{method?:string, headers?:Record<string,string>, body?:string, jar?:CookieJar, insecure?:boolean, timeoutMs?:number}} [opts]
 * @returns {Promise<{status:number, headers:import('node:http').IncomingHttpHeaders, body:Buffer, text:string}>}
 */
export function request(url, opts = {}) {
  const u = new URL(url);
  const prev = hostChains.get(u.host) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const wait = (hostLast.get(u.host) || 0) + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await doRequest(u, opts); } finally { hostLast.set(u.host, Date.now()); }
  });
  hostChains.set(u.host, run);
  return run;
}

/** @param {URL} u @param {any} opts */
function doRequest(u, opts) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': UA, Accept: '*/*', ...(opts.headers || {}) };
    if (opts.jar && opts.jar.cookies.size) headers.Cookie = opts.jar.header();
    if (opts.body != null) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    const req = https.request(u, {
      method: opts.method || 'GET', headers,
      rejectUnauthorized: !opts.insecure,
      timeout: opts.timeoutMs || 45000,
    }, (res) => {
      opts.jar?.store(res.headers['set-cookie']);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode || 0, headers: res.headers, body, text: body.toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${u}`)));
    req.on('error', reject);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

/** @param {string} rel @param {string|Buffer} data */
export function save(rel, data) {
  const p = path.join(FIXTURES, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  console.log(`  saved fixtures/${rel} (${Buffer.byteLength(data)} B)`);
  return p;
}

// AES-128-CBC exactly as the WQMIS site's public aes.js does it (key = iv = '8080808080808080', PKCS7, base64).
const K = Buffer.from('8080808080808080');
/** @param {string|number} v */
export const enc = (v) => { const c = crypto.createCipheriv('aes-128-cbc', K, K); return Buffer.concat([c.update(String(v), 'utf8'), c.final()]).toString('base64'); };
/** @param {string} b */
export const dec = (b) => { const d = crypto.createDecipheriv('aes-128-cbc', K, K); return Buffer.concat([d.update(Buffer.from(b, 'base64')), d.final()]).toString('utf8'); };
