// @ts-check
// Lab report page: Common/final_report_print?s_id=<enc(digits)>.
// Personal fields (Name, Mobile, Email, Pin Code) are masked by the site and are never kept.
import * as cheerio from 'cheerio';
import { parseIstDate } from '../time.js';
import { canonicalParam } from '../thresholds.js';

const PERSONAL = new Set(['name', 'mobile', 'email', 'pin code', 'full address', 'address']);

/**
 * @typedef {{ key: string, label: string, nabl: boolean, unit: string|null, acceptable_limit: string|null,
 *   permissible_limit: string|null, value_text: string, value: number|null, method: string|null, remarks: string|null }} ReportResult
 */

/** @param {string} s */
const nullIfBlank = (s) => { const t = s.replace(/\s+/g, ' ').trim(); return t && !/^(na|n\/a|-+)$/i.test(t) ? t : null; };

/**
 * @param {string} html
 * @returns {{ sample_id: string|null, fields: Record<string, string>, source: string|null, village: string|null, gp: string|null,
 *   block: string|null, district: string|null, state: string|null, remarks: string|null, lat: number|null, lng: number|null,
 *   collected_at: Date|null, received_at: Date|null, analysed_at: Date|null, reported_at: Date|null, lab_name: string|null,
 *   results: ReportResult[], warnings: string[] }}
 */
export function parseReport(html) {
  const $ = cheerio.load(html);
  /** @type {string[]} */
  const warnings = [];
  /** @type {Record<string, string>} */
  const fields = {};
  // Captions are labels without .form-control (classes vary: col-form-label for fields, d-block for dates).
  $('label').not('.form-control').each((_, el) => {
    const caption = $(el).text().replace(/\s+/g, ' ').replace(/:\s*$/, '').trim();
    if (!caption) return;
    // The value is the next .form-control label, either a sibling or inside the next sibling div.
    let v = $(el).next('label.form-control');
    if (!v.length) v = $(el).next().find('label.form-control').first();
    if (!v.length) return;
    if (PERSONAL.has(caption.toLowerCase())) return;
    if (!(caption in fields)) fields[caption] = v.text().replace(/\s+/g, ' ').trim();
  });
  const f = (/** @type {RegExp} */ re) => { const k = Object.keys(fields).find((x) => re.test(x)); return k ? nullIfBlank(fields[k]) : null; };
  const num = (/** @type {string|null} */ s) => { const n = s == null ? NaN : Number(s); return Number.isFinite(n) && n !== 0 ? n : null; };

  /** @type {ReportResult[]} */
  const results = [];
  const table = $('table').filter((_, t) => /parameters tested/i.test($(t).find('thead').text())).first();
  if (!table.length) warnings.push('no results table with a "Parameters tested" header');
  table.find('tbody > tr').each((_, tr) => {
    const c = $(tr).children('td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
    if (c.length < 6) return;
    const rawName = c[1];
    const nabl = /\*\s*$/.test(rawName);
    const label = rawName.replace(/\*+\s*$/, '').trim();
    const value_text = c[5];
    const n = Number(value_text);
    results.push({
      key: canonicalParam(label), label, nabl,
      unit: nullIfBlank(c[2]),
      acceptable_limit: nullIfBlank(c[3]),
      permissible_limit: nullIfBlank(c[4]),
      value_text,
      value: value_text !== '' && Number.isFinite(n) ? n : null,
      method: nullIfBlank(c[6] ?? ''),
      remarks: nullIfBlank(c[7] ?? ''),
    });
  });
  if (table.length && !results.length) warnings.push('results table has no rows');

  const lat = num(f(/^latitude$/i));
  const lng = num(f(/^longitude$/i));
  const labName = $('h2.jal-red').first().text().replace(/\s+/g, ' ').trim() || null;
  return {
    sample_id: f(/^sample id$/i),
    fields,
    source: f(/^source of sample$/i),
    village: f(/^village$/i),
    gp: f(/^gram panchayat$/i),
    block: f(/^block$/i),
    district: f(/^district$/i),
    state: f(/^state$/i),
    remarks: f(/^remarks$/i),
    lat: lat != null && lat > 5 && lat < 38 ? lat : null,
    lng: lng != null && lng > 67 && lng < 98 ? lng : null,
    collected_at: parseIstDate(f(/sample collection/i)),
    received_at: parseIstDate(f(/received in lab/i)),
    analysed_at: parseIstDate(f(/sample analysed/i)),
    reported_at: parseIstDate(f(/report generation/i)),
    lab_name: labName,
    results,
    warnings,
  };
}
