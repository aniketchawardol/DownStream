// @ts-check
// Nodemailer over plain SMTP, or an HTTPS relay when EMAIL_RELAY_URL is set (Render's free plan blocks outbound
// SMTP ports, so the relay is how the deployed site sends mail). Real addresses go to the relay or SMTP_URL. Reserved test
// domains (RFC 2606/6761: example.com/org/net, .test, .example, .invalid, .localhost) can never receive mail,
// so they go to SMTP_SINK_URL (Mailpit) when set, are dropped in production, and otherwise use SMTP_URL.
// That lets development send real mail to real people while automated tests keep landing in Mailpit.
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../log.js';

const log = logger('mail');

/**
 * @typedef {{ to: string, subject: string, html: string, text: string, headers?: Record<string, string> }} OutgoingEmail
 * @typedef {{ send: (m: OutgoingEmail) => Promise<{ messageId?: string, skipped?: string }> }} Mailer
 */

export const RESERVED_TEST_DOMAIN = /@(?:[^@\s]+\.)?(?:example\.(?:com|org|net)|[^@\s]+\.(?:test|example|invalid|localhost))$/i;

/**
 * Which transport an address uses.
 * @param {string} to @param {{ sink: boolean, production: boolean }} o
 * @returns {'main'|'sink'|'skip'}
 */
export function routeFor(to, o) {
  if (!RESERVED_TEST_DOMAIN.test(to.trim())) return 'main';
  if (o.sink) return 'sink';
  return o.production ? 'skip' : 'main';
}

/** "DownStream <a@b.c>" -> display name. @param {string} from */
export const displayName = (from) => from.match(/^\s*"?([^"<]*?)"?\s*</)?.[1]?.trim() || '';

/**
 * A nodemailer-shaped transport that POSTs each message as JSON to scripts/gmail-relay.gs. Apps Script answers
 * a POST with a 302 to the result, which fetch follows. Apps Script can't set custom headers, so relayed mail
 * has no List-Unsubscribe header; every email still carries its unsubscribe link in the body.
 * @param {string} url @param {string} secret @param {typeof fetch} [fetchImpl]
 */
export function relayTransport(url, secret, fetchImpl = fetch) {
  return {
    /** @param {{ from: string, to: string, subject: string, html: string, text: string, headers?: Record<string, string> }} m */
    async sendMail(m) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret, to: m.to, subject: m.subject, html: m.html, text: m.text, name: displayName(m.from) }),
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.text();
      /** @type {any} */ let j;
      try { j = JSON.parse(body); } catch { throw new Error(`email relay: HTTP ${res.status}, not JSON: ${body.replace(/\s+/g, ' ').slice(0, 120)}`); }
      if (!j.ok) throw new Error(`email relay: ${j.error || 'refused'}`);
      return { messageId: j.id || 'relay' };
    },
  };
}

/** @param {string} [smtpUrl] @param {string|null} [sinkUrl] @param {string|null} [relayUrl] @returns {Mailer} */
export function createMailer(smtpUrl = config.smtpUrl, sinkUrl = config.smtpSinkUrl, relayUrl = config.emailRelayUrl) {
  const main = relayUrl ? relayTransport(relayUrl, config.emailRelaySecret) : nodemailer.createTransport(smtpUrl);
  const sink = sinkUrl ? nodemailer.createTransport(sinkUrl) : null;
  const production = config.nodeEnv === 'production';
  return {
    async send(m) {
      const route = routeFor(m.to, { sink: !!sink, production });
      if (route === 'skip') {
        log.info('not sent: reserved test domain', { to: m.to.replace(/^[^@]+/, '…') });
        return { skipped: 'reserved test domain' };
      }
      const t = route === 'sink' ? /** @type {import('nodemailer').Transporter} */ (sink) : /** @type {any} */ (main);
      const info = await t.sendMail({ from: config.emailFrom, to: m.to, subject: m.subject, html: m.html, text: m.text, headers: m.headers });
      return { messageId: info.messageId };
    },
  };
}
