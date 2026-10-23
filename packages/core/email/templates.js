// @ts-check
// Fixed email templates with {placeholders}. Each alert kind has one sentence template, so a later
// move to DLT-registered SMS templates is a mapping exercise rather than a rewrite.
import { haversineKm } from '../geo.js';
import { istClock, istLongDate } from '../time.js';
import { kindInfo, SUBSCRIPTION_GROUPS } from '../alerts/kinds.js';
import { gpLabel } from '../alerts/describe.js';

const SIMULATED_LINE = 'This alert is simulated. It was invented to test the alert system and does not describe any real place or any real water.';
const FOOTER_HONESTY = 'DownStream republishes official government water data with its dates. It cannot tell you whether water is safe to drink between official tests.';

/** One sentence per alert kind. {where} already includes the water type. */
export const ALERT_TEMPLATES = {
  river_threshold: '{parameter_label} was {value_unit} in {where}, outside the limit of {limit_text} for {criteria_label}. Measured at {measured_at}.',
  river_recovered: '{parameter_label} was {value_unit} in {where}, back within the limit of {limit_text} for two readings in a row. Measured at {measured_at}.',
  river_spike: '{parameter_label} was {value_unit} in {where}, far {direction_word} its usual level over the past week (median {median_unit}). CPCB sets no limit for this parameter. Measured at {measured_at}.',
  river_station_silent: 'The station measuring {where} has sent no reading since {last_reading_at}.',
  tap_contamination: 'A lab test of {source_desc} in {gp} found {findings}.',
  tap_caution: 'A lab test of {source_desc} in {gp} found {findings}. This is within the permissible limit that applies when no other source is available.',
  tap_all_clear: 'A lab test of {source_desc} in {gp} found all tested parameters within limits.',
  tap_overdue: '{title}. Jal Jeevan Mission norms call for {norm}.',
  regional_geogenic: '{parameter_label} was above the permissible limit of {permissible_text} in {count_above} of {count_tested} lab tests within {radius_km} km of your pin this financial year. The closest was {nearest_value} in {nearest_gp}, {nearest_distance} km away. {parameter_label} comes from rock, so it often affects groundwater across a whole area.',
};

/** Replace {name} placeholders; unknown names become an empty string. @param {string} tpl @param {Record<string, unknown>} vars */
export function fill(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

/** @param {string} s */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);

/** @param {string|null|undefined} iso */
const when = (iso) => (iso ? `${istClock(new Date(iso))} on ${istLongDate(new Date(iso))}` : 'an unknown time');
/** @param {string|null|undefined} iso */
const day = (iso) => (iso ? istLongDate(new Date(iso)) : null);
/** @param {number|null|undefined} v @param {string|null|undefined} unit */
const vu = (v, unit) => (v == null ? '' : `${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ''}`);

/**
 * Variables for one alert, from its stored body.
 * @param {{ kind: string, title: string, body: any, lat: number, lng: number, is_mock: boolean }} a
 * @param {{ lat: number, lng: number }} pin
 */
export function alertVars(a, pin) {
  const b = a.body || {};
  const distance_km = Math.round(haversineKm(pin.lat, pin.lng, a.lat, a.lng) * 10) / 10;
  const where = b.simulated
    ? (b.water === 'river' ? `river water at ${b.place}` : gpLabel(b.gp_name ?? ''))
    : b.water === 'river' ? (b.river ? `the ${b.river} at ${b.place} (river water at CPCB station ${b.station_no})` : `river water at ${b.place} (CPCB station ${b.station_no})`) : gpLabel(b.gp_name ?? '');
  const failing = (b.results || []).filter((/** @type {any} */ r) => r.status === 'above_permissible' || r.status === 'above_acceptable');
  const findings = failing.map((/** @type {any} */ r) => `${r.parameter_label} at ${r.value_text}${r.unit ? ` ${r.unit}` : ''} (acceptable limit ${r.acceptable_text ?? 'not printed'}${r.permissible_text ? `, permissible ${r.permissible_text}` : ''})`).join('; ');
  const source_desc = [b.source_name || b.source_type || 'a drinking-water source', b.village_name ? `in ${b.village_name} village` : null].filter(Boolean).join(' ');
  return {
    ...b,
    title: a.title,
    where,
    distance_km,
    value_unit: vu(b.value, b.unit),
    median_unit: vu(b.median, b.unit),
    direction_word: b.direction === 'down' ? 'below' : 'above',
    measured_at: when(b.measured_at),
    last_reading_at: when(b.last_reading_at),
    findings: findings || 'results outside the limits',
    source_desc,
    nearest_value: b.nearest ? `${b.nearest.value_text}${b.unit ? ` ${b.unit}` : ''}` : '',
    nearest_gp: b.nearest?.gp_name ? gpLabel(b.nearest.gp_name) : '',
    gp: gpLabel(b.gp_name ?? ''),
    nearest_distance: b.nearest?.distance_km,
  };
}

/**
 * @param {{ kind: string, title: string, body: any, lat: number, lng: number, is_mock: boolean, severity: string }} a
 * @param {{ lat: number, lng: number }} pin @param {string} baseUrl
 */
function renderAlertBlock(a, pin, baseUrl) {
  const v = alertVars(a, pin);
  const b = a.body || {};
  const sentence = fill(ALERT_TEMPLATES[/** @type {keyof typeof ALERT_TEMPLATES} */ (a.kind)] ?? '{title}.', v);
  const severity = a.severity === 'urgent' ? 'Urgent' : a.severity === 'notice' ? 'Notice' : 'For information';
  const sourceLine = b.simulated
    ? 'Source: the simulator. No real measurement or lab test was made.'
    : kindInfo(a.kind).source === 'cpcb'
    ? 'Source: CPCB real-time river monitoring station. This is river water, not tap water.'
    : b.water === 'groundwater'
      ? 'Source: Jal Jeevan Mission laboratory tests (WQMIS) of drinking-water sources near your pin.'
      : 'Source: Jal Jeevan Mission laboratory test (WQMIS) of a rural drinking-water source.';
  const whereLine = `Where: ${b.water === 'river' ? `${b.station_name}` : b.simulated ? gpLabel(b.gp_name ?? b.nearest?.gp_name ?? 'a simulated place') : [b.village_name ? `${b.village_name} village` : null, b.gp_name ? gpLabel(b.gp_name) : null, b.block ? `${b.block} block` : null, b.district ? `${b.district} district` : null].filter(Boolean).join(', ') || v.where}, ${v.distance_km} km from your pin.`;
  const dates = b.water === 'tap' && b.sample_id
    ? `Collected ${day(b.collected_at) ?? 'date not published'}. Analysed ${day(b.analysed_at) ?? 'date not published'}. First seen by this site ${day(b.first_seen_at) ?? 'today'}.`
    : null;
  const mapUrl = `${baseUrl}${b.site_path || '/'}`;
  const lines = [`${severity}: ${a.title}`, sentence, whereLine, sourceLine, dates, `See it on the map: ${mapUrl}`, b.report_url ? `Government lab report: ${b.report_url}` : null].filter(Boolean);
  const html = `
    <tr><td style="padding:20px 0 4px 0;">
      <p style="margin:0 0 6px 0;font:600 13px/1.4 'Anek Latin',system-ui,sans-serif;color:${a.severity === 'urgent' ? '#B1271C' : a.severity === 'notice' ? '#7a5c00' : '#2E7A57'};">${esc(severity)}${a.is_mock ? ' (simulated)' : ''}</p>
      <h2 style="margin:0 0 10px 0;font:600 21px/1.3 'Anek Latin',system-ui,sans-serif;color:#222A2D;">${esc(a.title)}</h2>
      <p style="margin:0 0 10px 0;">${esc(sentence)}</p>
      <p style="margin:0 0 10px 0;">${esc(whereLine)}</p>
      <p style="margin:0 0 10px 0;color:#4a5458;">${esc(sourceLine)}</p>
      ${dates ? `<p style="margin:0 0 10px 0;">${esc(dates)}</p>` : ''}
      <p style="margin:0;"><a href="${esc(mapUrl)}" style="color:#1E5E8A;">See it on the map</a>${b.report_url ? ` &nbsp; <a href="${esc(b.report_url)}" style="color:#1E5E8A;">Government lab report</a>` : ''}</p>
    </td></tr>`;
  return { text: lines.join('\n'), html };
}

/** @param {{ preheader: string, bodyHtml: string, unsubscribeUrl: string, simulated: boolean }} p */
function layout(p) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>DownStream</title></head>
<body style="margin:0;padding:0;background:#E7ECEA;">
<span style="display:none;max-height:0;overflow:hidden;">${esc(p.preheader)}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#E7ECEA;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-top:4px solid #1E5E8A;">
<tr><td style="padding:24px 28px 28px 28px;font:18px/1.6 'Source Serif 4',Georgia,'Times New Roman',serif;color:#222A2D;">
<p style="margin:0 0 4px 0;font:600 16px/1.4 'Anek Latin',system-ui,sans-serif;color:#1E5E8A;">DownStream</p>
${p.simulated ? `<p style="margin:12px 0 0 0;padding:10px 12px;background:#F6E7B4;border-left:4px solid #D4A017;font:16px/1.5 'Source Serif 4',Georgia,serif;">${esc(SIMULATED_LINE)}</p>` : ''}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${p.bodyHtml}</table>
<hr style="border:0;border-top:1px solid #c9d2cf;margin:28px 0 16px 0;">
<p style="margin:0 0 8px 0;font-size:14px;line-height:1.5;color:#4a5458;">${esc(FOOTER_HONESTY)}</p>
<p style="margin:0;font-size:14px;line-height:1.5;color:#4a5458;">You get this because you subscribed to alerts for a pin on DownStream. <a href="${esc(p.unsubscribeUrl)}" style="color:#1E5E8A;">Unsubscribe with one click</a>.</p>
</td></tr></table></td></tr></table></body></html>`;
}

/** @param {string} baseUrl @param {string} token */
export const unsubscribeUrl = (baseUrl, token) => `${baseUrl}/api/unsubscribe?token=${encodeURIComponent(token)}`;

/** List-Unsubscribe headers (RFC 8058 one-click). @param {string} url */
export const unsubscribeHeaders = (url) => ({ 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });

/**
 * @param {{ email: string, lat: number, lng: number, radius_km: number, kinds: string[], confirm_token: string, unsubscribe_token: string, near?: string|null }} sub
 * @param {string} baseUrl
 */
export function renderConfirmation(sub, baseUrl) {
  const confirmUrl = `${baseUrl}/api/subscriptions/confirm?token=${encodeURIComponent(sub.confirm_token)}`;
  const unsub = unsubscribeUrl(baseUrl, sub.unsubscribe_token);
  const choices = sub.kinds.map((k) => SUBSCRIPTION_GROUPS[/** @type {keyof typeof SUBSCRIPTION_GROUPS} */ (k)] ?? k);
  const pin = `${sub.lat.toFixed(4)}, ${sub.lng.toFixed(4)}${sub.near ? ` (near ${sub.near})` : ''}`;
  const subject = 'Confirm your DownStream water alerts';
  const text = [
    'DownStream',
    '',
    `You asked for emails about government water data within ${sub.radius_km} km of a pin at ${pin}.`,
    `You chose: ${choices.join('; ')}.`,
    '',
    `Open this link to start alerts: ${confirmUrl}`,
    '',
    'If you did not ask for this, ignore this email. Nothing else will be sent.',
    '',
    FOOTER_HONESTY,
    `Unsubscribe: ${unsub}`,
  ].join('\n');
  const bodyHtml = `<tr><td style="padding:16px 0 0 0;">
    <h1 style="margin:0 0 12px 0;font:600 24px/1.25 'Anek Latin',system-ui,sans-serif;">Confirm your water alerts</h1>
    <p style="margin:0 0 10px 0;">You asked for emails about government water data within ${esc(String(sub.radius_km))} km of a pin at ${esc(pin)}.</p>
    <p style="margin:0 0 10px 0;">You chose:</p>
    <ul style="margin:0 0 16px 20px;padding:0;">${choices.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
    <p style="margin:0 0 16px 0;"><a href="${esc(confirmUrl)}" style="display:inline-block;padding:10px 18px;background:#1E5E8A;color:#ffffff;text-decoration:none;border-radius:999px;font:600 16px/1.4 'Anek Latin',system-ui,sans-serif;">Start alerts</a></p>
    <p style="margin:0 0 10px 0;font-size:16px;">Or open this link: <a href="${esc(confirmUrl)}" style="color:#1E5E8A;word-break:break-all;">${esc(confirmUrl)}</a></p>
    <p style="margin:0;">If you did not ask for this, ignore this email. Nothing else will be sent.</p>
  </td></tr>`;
  return { subject, text, html: layout({ preheader: 'Open the link to start alerts.', bodyHtml, unsubscribeUrl: unsub, simulated: false }), headers: unsubscribeHeaders(unsub) };
}

/**
 * One email carrying a bundle of alerts for one subscription. Never mixes simulated and real alerts.
 * @param {{ lat: number, lng: number, radius_km: number, unsubscribe_token: string }} sub
 * @param {{ kind: string, title: string, body: any, lat: number, lng: number, is_mock: boolean, severity: string }[]} alerts
 * @param {string} baseUrl
 */
export function renderAlertEmail(sub, alerts, baseUrl) {
  const simulated = alerts.some((a) => a.is_mock);
  const order = { urgent: 0, notice: 1, info: 2 };
  const sorted = [...alerts].sort((a, b) => (order[/** @type {keyof typeof order} */ (a.severity)] ?? 3) - (order[/** @type {keyof typeof order} */ (b.severity)] ?? 3));
  const unsub = unsubscribeUrl(baseUrl, sub.unsubscribe_token);
  const blocks = sorted.map((a) => renderAlertBlock(a, sub, baseUrl));
  const base = sorted.length === 1 ? sorted[0].title : `${sorted.length} water alerts within ${sub.radius_km} km of your pin`;
  const subject = `${simulated ? '[Simulated] ' : ''}${base}`;
  const text = [
    ...(simulated ? [SIMULATED_LINE, ''] : []),
    'DownStream',
    '',
    blocks.map((b) => b.text).join('\n\n'),
    '',
    FOOTER_HONESTY,
    `Unsubscribe with one click: ${unsub}`,
  ].join('\n');
  return { subject, text, html: layout({ preheader: sorted[0]?.title ?? '', bodyHtml: blocks.map((b) => b.html).join(''), unsubscribeUrl: unsub, simulated }), headers: unsubscribeHeaders(unsub) };
}

/**
 * Weekly summary.
 * @param {{ lat: number, lng: number, radius_km: number, unsubscribe_token: string }} sub
 * @param {{ alerts: any[], simulatedCount: number, stations: any[], areas: any[], weekStart: Date, weekEnd: Date }} d
 * @param {string} baseUrl
 */
export function renderDigest(sub, d, baseUrl) {
  const unsub = unsubscribeUrl(baseUrl, sub.unsubscribe_token);
  const range = `${istLongDate(d.weekStart)} to ${istLongDate(d.weekEnd)}`;
  const subject = `Weekly water summary for your pin, ${range}`;
  const stationLines = d.stations.map((s) => `${s.label}: last reading ${s.age} ago${s.status ? `, ${s.status}` : ''}, ${s.distance_km} km away.`);
  const areaLines = d.areas.map((a) => (a.last_test ? `${a.name} panchayat: last lab test ${a.last_test}${a.status ? `, ${a.status}` : ''}, ${a.distance_km} km away.` : `${a.name} panchayat: no lab test found since ${a.known_since}, ${a.distance_km} km away.`));
  const blocks = d.alerts.map((a) => renderAlertBlock(a, sub, baseUrl));
  const text = [
    'DownStream',
    `Weekly summary, ${range}, within ${sub.radius_km} km of your pin.`,
    '',
    d.alerts.length ? `${d.alerts.length} alert${d.alerts.length === 1 ? '' : 's'} this week:` : 'No new alerts from official data this week.',
    ...blocks.map((b) => `\n${b.text}`),
    '',
    'River stations nearest your pin (river water, not tap water):',
    ...(stationLines.length ? stationLines : ['None within your radius.']),
    '',
    'Panchayats nearest your pin (rural drinking-water sources):',
    ...(areaLines.length ? areaLines : ['None with published locations within your radius.']),
    ...(d.simulatedCount ? ['', `${d.simulatedCount} simulated alert${d.simulatedCount === 1 ? ' was' : 's were'} also sent this week. They were invented for testing and are not counted above.`] : []),
    '',
    FOOTER_HONESTY,
    `Unsubscribe with one click: ${unsub}`,
  ].join('\n');
  const list = (/** @type {string[]} */ items, empty) => (items.length ? `<ul style="margin:0 0 16px 20px;padding:0;">${items.map((i) => `<li style="margin:0 0 4px 0;">${esc(i)}</li>`).join('')}</ul>` : `<p>${esc(empty)}</p>`);
  const bodyHtml = `<tr><td style="padding:16px 0 0 0;">
    <h1 style="margin:0 0 6px 0;font:600 24px/1.25 'Anek Latin',system-ui,sans-serif;">Weekly water summary</h1>
    <p style="margin:0 0 12px 0;color:#4a5458;">${esc(range)}, within ${esc(String(sub.radius_km))} km of your pin.</p>
    <p style="margin:0;">${esc(d.alerts.length ? `${d.alerts.length} alert${d.alerts.length === 1 ? '' : 's'} this week.` : 'No new alerts from official data this week.')}</p>
  </td></tr>
  ${blocks.map((b) => b.html).join('')}
  <tr><td style="padding:20px 0 0 0;">
    <h2 style="margin:0 0 8px 0;font:600 18px/1.3 'Anek Latin',system-ui,sans-serif;">River stations nearest your pin</h2>
    <p style="margin:0 0 6px 0;font-size:15px;color:#4a5458;">River water, not tap water.</p>
    ${list(stationLines, 'None within your radius.')}
    <h2 style="margin:0 0 8px 0;font:600 18px/1.3 'Anek Latin',system-ui,sans-serif;">Panchayats nearest your pin</h2>
    ${list(areaLines, 'None with published locations within your radius.')}
    ${d.simulatedCount ? `<p style="margin:0;color:#4a5458;">${esc(`${d.simulatedCount} simulated alert${d.simulatedCount === 1 ? ' was' : 's were'} also sent this week. They were invented for testing and are not counted above.`)}</p>` : ''}
  </td></tr>`;
  return { subject, text, html: layout({ preheader: `Your weekly water summary, ${range}`, bodyHtml, unsubscribeUrl: unsub, simulated: false }), headers: unsubscribeHeaders(unsub) };
}
