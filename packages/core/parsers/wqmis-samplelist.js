// @ts-check
// WQMIS sample lists. Two shapes carry the same rows:
//   POST Report/labtestingsamplelist_fil/  -> JSON { Labtestingdata: [...], TotalPage, CurentPage }  (used for ingestion)
//   GET  Report/labtestingsamplelist       -> HTML table, 15 columns, mapped by header text          (fallback, first page only)
// Parameter values are inline: " Colour (Hazen units) : 1.000, pH (NA) : 7.350, TDS (mg/l) : 973.000".
import * as cheerio from 'cheerio';
import { parseIstDate } from '../time.js';
import { canonicalParam } from '../thresholds.js';
import { displayName } from './wqmis-dropdown.js';

/**
 * @typedef {{ key: string, label: string, unit: string|null, value_text: string, value: number|null }} ListValue
 * @typedef {{ sample_id: string, report_digits: string|null, district: string, block: string, gp: string, village: string,
 *   source_raw: string, source_type: string|null, lab_name: string|null, collected_at: Date|null, analysed_at: Date|null,
 *   status_text: string, inconclusive: boolean, contaminated: ListValue[], chemical: ListValue[], bacteriological: ListValue[],
 *   remedial: string|null, raw: Record<string, string> }} SampleRow
 */

/**
 * Split an inline parameter string. Items are separated by commas; each item's value follows the LAST " : ",
 * and its unit is the final parenthesised group of the name ("(NA)" means no unit).
 * @param {string|null|undefined} s @returns {ListValue[]}
 */
export function parseParamList(s) {
  if (!s || !String(s).trim()) return [];
  /** @type {ListValue[]} */
  const out = [];
  for (const item of String(s).split(/,\s*(?=[^,]*\s:\s)/)) {
    const i = item.lastIndexOf(' : ');
    if (i < 0) continue;
    const name = item.slice(0, i).trim();
    const value_text = item.slice(i + 3).trim();
    if (!name) continue;
    const um = name.match(/\(([^()]*)\)\s*$/);
    const rawUnit = um ? um[1].trim() : null;
    const unit = !rawUnit || /^na$/i.test(rawUnit) ? null : rawUnit;
    const label = (um ? name.slice(0, um.index).trim() : name).replace(/\*+$/, '').trim();
    const n = Number(value_text);
    out.push({ key: canonicalParam(label), label, unit, value_text, value: value_text !== '' && Number.isFinite(n) ? n : null });
  }
  return out;
}

/** Derive a short source type from the free-text "Sample source". @param {string} raw */
export function sourceType(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/Source type\s*:\s*([^\],]+)/i);
  if (m) return m[1].trim();
  const lead = t.match(/^(Individual house tap water|Public tap water|School|Anganwadi|Hand ?pump|Open well|Tube ?well|Bore ?well)/i);
  if (lead) return lead[1].replace(/\s+/g, ' ');
  return null;
}

/**
 * Plain-language description of the free-text "Sample source", e.g. "a household tap (deep tubewell)",
 * "the school tap at Govt High School Adagal". Never more specific than the source text itself.
 * @param {string} raw
 */
export function describeSource(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  const type = t.match(/Source type\s*:\s*([^\],]+)/i)?.[1]?.trim().toLowerCase();
  const named = (/** @type {RegExp} */ re) => t.match(re)?.[1]?.replace(/\s*\[.*$/, '').trim();
  const school = named(/School name\s*:\s*([^\[]+)/i);
  if (school) return `the school tap at ${displayName(school)}`;
  const aw = named(/Anganwadi Name\s*:\s*([^\[]+)/i);
  if (aw) return `the anganwadi tap at ${displayName(aw)}`;
  if (/^Individual house tap/i.test(t)) return `a household tap${type ? ` (${type})` : ''}`;
  if (/^Public tap/i.test(t)) return `a public tap${type ? ` (${type})` : ''}`;
  if (type) return `a ${type}`;
  return 'a drinking-water source';
}

/** @param {string} id */
export const reportDigits = (id) => id.match(/^U\d+S(\d+)$/)?.[1] ?? null;

/**
 * @param {Record<string, any>} r a row with the JSON field names
 * @returns {SampleRow|null}
 */
function normaliseRow(r) {
  const sample_id = String(r.SampleId ?? '').trim();
  if (!sample_id) return null;
  const status_text = String(r.Status ?? '').trim();
  const analysedRaw = String(r.s_report_approval_action_time ?? '').trim();
  const remedial = [r.Remedial_chem_remarks, r.Remedial_bact_remarks].map((x) => String(x ?? '').trim()).filter(Boolean).join(' / ') || null;
  const source_raw = String(r.sample_sourceName ?? '').replace(/\s+/g, ' ').trim();
  return {
    sample_id,
    report_digits: reportDigits(sample_id),
    district: displayName(r.District ?? ''),
    block: displayName(r.Block ?? ''),
    gp: displayName(r.Grampanchayat ?? ''),
    village: displayName(r.Village ?? ''),
    source_raw,
    source_type: sourceType(source_raw),
    lab_name: String(r.labname ?? '').trim() || null,
    collected_at: parseIstDate(r.sample_collection_time),
    analysed_at: parseIstDate(analysedRaw),
    status_text,
    inconclusive: !status_text || analysedRaw === '--',
    contaminated: parseParamList(r.Contaminated_parameters),
    chemical: parseParamList(r.chemical_parameter),
    bacteriological: parseParamList(r.bact_parameter),
    remedial,
    raw: {
      SampleId: sample_id, sample_sourceName: source_raw, labname: String(r.labname ?? ''),
      sample_collection_time: String(r.sample_collection_time ?? ''), s_report_approval_action_time: analysedRaw,
      Status: status_text, Contaminated_parameters: String(r.Contaminated_parameters ?? '').trim(),
      chemical_parameter: String(r.chemical_parameter ?? '').trim(), bact_parameter: String(r.bact_parameter ?? '').trim(),
    },
  };
}

/**
 * @param {unknown} json response of labtestingsamplelist_fil/
 * @returns {{ rows: SampleRow[], totalPages: number, page: number, warnings: string[] }}
 */
export function parseSampleListJson(json) {
  const o = /** @type {any} */ (json);
  if (!o || typeof o !== 'object' || !('Labtestingdata' in o)) return { rows: [], totalPages: 0, page: 0, warnings: ['sample list JSON has no Labtestingdata'] };
  const list = Array.isArray(o.Labtestingdata) ? o.Labtestingdata : [];
  const rows = list.map(normaliseRow).filter((r) => r != null);
  const warnings = rows.length < list.length ? [`${list.length - rows.length} rows without a sample ID`] : [];
  return { rows: /** @type {SampleRow[]} */ (rows), totalPages: Number(o.TotalPage) || (rows.length ? 1 : 0), page: Number(o.CurentPage) || 1, warnings };
}

/** Header text -> JSON field name. Matched by header text, not position. */
const HEADER_MAP = [
  [/^state/i, 'State'], [/^district/i, 'District'], [/^block/i, 'Block'], [/gram\s*panchayat/i, 'Grampanchayat'],
  [/^village/i, 'Village'], [/sample\s*source/i, 'sample_sourceName'], [/sample\s*id/i, 'SampleId'], [/lab\s*name/i, 'labname'],
  [/collection\s*date/i, 'sample_collection_time'], [/tested\s*date/i, 's_report_approval_action_time'], [/status/i, 'Status'],
  [/contaminated/i, 'Contaminated_parameters'], [/chemical/i, 'chemical_parameter'], [/bacteriolog/i, 'bact_parameter'],
  [/remedial.*chem/i, 'Remedial_chem_remarks'], [/remedial.*bact/i, 'Remedial_bact_remarks'],
];

/**
 * @param {string} html page from Report/labtestingsamplelist
 * @returns {{ rows: SampleRow[], fy: string|null, totalPages: number, warnings: string[] }}
 */
export function parseSampleListHtml(html) {
  const $ = cheerio.load(html);
  // Every header of the results table (the S.No. header has no headName class, so select all th).
  const table = $('table').has('tbody.tbllabtestingsample').first();
  const headers = (table.length ? table.find('thead th') : $('th')).map((_, th) => $(th).text().replace(/\s+/g, ' ').trim()).get();
  const fy = headers.join(' ').match(/(\d{4}-\d{4})/)?.[1] ?? null;
  /** @type {(string|null)[]} */
  const fields = headers.map((h) => {
    if (/^s\.?\s*no/i.test(h)) return null;
    const hit = HEADER_MAP.find(([re]) => /** @type {RegExp} */ (re).test(h));
    return hit ? /** @type {string} */ (hit[1]) : null;
  });
  /** @type {string[]} */
  const warnings = [];
  if (!fields.includes('SampleId')) warnings.push('sample list table has no "Sample Id" header');
  /** @type {SampleRow[]} */
  const rows = [];
  $('tbody.tbllabtestingsample > tr').each((_, tr) => {
    const cells = $(tr).children('td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length < Math.min(fields.length, 8)) return; // "No records available"
    /** @type {Record<string, string>} */
    const r = {};
    fields.forEach((f, i) => { if (f) r[f] = cells[i] ?? ''; });
    const row = normaliseRow(r);
    if (row) rows.push(row);
  });
  const pageOptions = $('#ddlPageNo option').length;
  return { rows, fy, totalPages: Math.max(1, pageOptions), warnings };
}
