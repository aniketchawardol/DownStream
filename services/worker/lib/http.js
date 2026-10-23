// @ts-check
// Polite HTTP for government servers: one request in flight per host, a minimum gap between
// requests, exponential backoff on 5xx/timeouts, and a raw-response archive for debugging.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { Agent, fetch as undiciFetch } from 'undici';
import { config, userAgent } from '@lt/core/config.js';
import { logger } from '@lt/core/log.js';

const gzip = promisify(zlib.gzip);
const log = logger('http');

export class HttpError extends Error {
  /** @param {string} msg @param {number} status @param {string} [body] */
  constructor(msg, status, body) { super(msg); this.status = status; this.body = body; }
}

/** @type {Map<string, { last: number, chain: Promise<unknown> }>} */
const hosts = new Map();

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
let warnedInsecure = false;

/** Dispatcher for a URL: insecure only for CPCB's host, and only when CPCB_INSECURE_TLS=true. @param {string} url */
export function dispatcherFor(url) {
  const host = new URL(url).host;
  if (config.cpcbInsecureTls && host === new URL(config.cpcbUrl).host) {
    if (!warnedInsecure) { log.warn('TLS verification disabled for this host only (CPCB_INSECURE_TLS=true)', { host }); warnedInsecure = true; }
    return insecureAgent;
  }
  return undefined;
}

/**
 * Run fn in the host's queue, at least minGapMs after the previous request to that host finished.
 * @template T @param {string} host @param {number} minGapMs @param {() => Promise<T>} fn @returns {Promise<T>}
 */
function queued(host, minGapMs, fn) {
  const h = hosts.get(host) ?? { last: 0, chain: Promise.resolve() };
  hosts.set(host, h);
  const run = h.chain.catch(() => {}).then(async () => {
    const wait = h.last + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { h.last = Date.now(); }
  });
  h.chain = run;
  return run;
}

/**
 * @typedef {{ method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number,
 *   retries?: number, minGapMs?: number, fetchImpl?: typeof undiciFetch, accept?: string }} RequestOpts
 */

/**
 * Fetch text with politeness, retries and backoff. Throws HttpError on final failure.
 * @param {string} url @param {RequestOpts} [opts]
 * @returns {Promise<{ status: number, text: string, url: string, headers: Headers }>}
 */
export async function politeFetch(url, opts = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = 45_000, retries = 3, minGapMs = config.wqmisMinIntervalMs, fetchImpl = undiciFetch } = opts;
  const host = new URL(url).host;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const res = await queued(host, Math.max(500, minGapMs), async () => {
        const r = await fetchImpl(url, {
          method,
          headers: { 'user-agent': userAgent(), accept: opts.accept || '*/*', 'accept-language': 'en-IN,en;q=0.9', ...headers },
          body,
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
          dispatcher: dispatcherFor(url),
        });
        const text = await r.text();
        return { status: r.status, text, url: r.url || url, headers: /** @type {Headers} */ (/** @type {unknown} */ (r.headers)) };
      });
      if (res.status >= 500) throw new HttpError(`HTTP ${res.status} from ${host}`, res.status, res.text.slice(0, 500));
      if (res.status >= 400) throw Object.assign(new HttpError(`HTTP ${res.status} from ${host}`, res.status, res.text.slice(0, 500)), { permanent: true });
      return res;
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e.permanent || attempt > retries) throw err;
      const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
      log.warn('request failed; backing off', { host, attempt, backoff_ms: backoff, error: String(e.message || e) });
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

/**
 * Save a raw response under data/raw/<source>/<YYYY-MM-DD>/<time>-<name>.gz. Never throws.
 * @param {string} source @param {string} name @param {string} body
 */
export async function archiveRaw(source, name, body) {
  try {
    const now = new Date();
    const dir = path.join(config.rawDir, source, now.toISOString().slice(0, 10));
    await fs.mkdir(dir, { recursive: true });
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
    await fs.writeFile(path.join(dir, `${now.toISOString().slice(11, 19).replace(/:/g, '')}-${safe}.gz`), await gzip(body));
  } catch (err) {
    log.warn('raw archive write failed', { source, error: String(err) });
  }
}

/** Delete archive day-folders older than maxAgeDays. @param {number} [maxAgeDays] */
export async function pruneRaw(maxAgeDays = 30) {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400_000).toISOString().slice(0, 10);
  let removed = 0;
  try {
    for (const source of await fs.readdir(config.rawDir)) {
      const sdir = path.join(config.rawDir, source);
      for (const day of await fs.readdir(sdir).catch(() => [])) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) {
          await fs.rm(path.join(sdir, day), { recursive: true, force: true });
          removed++;
        }
      }
    }
  } catch { /* archive dir may not exist yet */ }
  return removed;
}
