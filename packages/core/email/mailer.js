// @ts-check
// Nodemailer over plain SMTP. Real addresses go to SMTP_URL (Mailpit or a real provider). Reserved test
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

/** @param {string} [smtpUrl] @param {string|null} [sinkUrl] @returns {Mailer} */
export function createMailer(smtpUrl = config.smtpUrl, sinkUrl = config.smtpSinkUrl) {
  const main = nodemailer.createTransport(smtpUrl);
  const sink = sinkUrl ? nodemailer.createTransport(sinkUrl) : null;
  const production = config.nodeEnv === 'production';
  return {
    async send(m) {
      const route = routeFor(m.to, { sink: !!sink, production });
      if (route === 'skip') {
        log.info('not sent: reserved test domain', { to: m.to.replace(/^[^@]+/, '…') });
        return { skipped: 'reserved test domain' };
      }
      const t = route === 'sink' ? /** @type {import('nodemailer').Transporter} */ (sink) : main;
      const info = await t.sendMail({ from: config.emailFrom, to: m.to, subject: m.subject, html: m.html, text: m.text, headers: m.headers });
      return { messageId: info.messageId };
    },
  };
}
