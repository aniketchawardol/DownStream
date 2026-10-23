// @ts-check
import postgres from 'postgres';
import { config } from './config.js';

/** @typedef {import('postgres').Sql<{}>} Sql */

/**
 * TLS when the URL asks for it, or for Render's external hostnames (*.render.com), which GitHub Actions
 * uses and which refuse plain connections. Render's internal hostnames ("dpg-…-a") and local Docker don't.
 * @param {string} url
 */
export function needsTls(url) {
  if (/[?&]sslmode=(require|verify-ca|verify-full)/.test(url)) return true;
  try { return new URL(url).hostname.endsWith('.render.com'); } catch { return false; }
}

/** @param {{ max?: number, url?: string }} [opts] @returns {Sql} */
export function createSql(opts = {}) {
  const url = opts.url || config.databaseUrl;
  return postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => {},
    ssl: needsTls(url) ? 'require' : undefined,
    transform: { undefined: null },
  });
}
