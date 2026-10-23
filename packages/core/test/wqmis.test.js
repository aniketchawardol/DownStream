// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDropdown, displayName } from '../parsers/wqmis-dropdown.js';
import { parseParamList, parseSampleListJson, parseSampleListHtml, sourceType, reportDigits } from '../parsers/wqmis-samplelist.js';
import { parseReport } from '../parsers/wqmis-report.js';
import { parseCounts } from '../parsers/wqmis-counts.js';
import { parseMainDashboard, parseStateDashboard } from '../parsers/wqmis-dashboard.js';
import { judgeTapResult } from '../thresholds.js';

const raw = (name) => fs.readFileSync(new URL(`../../../fixtures/wqmis/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(raw(name));

test('dropdowns drop the placeholder at every level', () => {
  const d = parseDropdown(json('districts-15.json'), 'district');
  assert.equal(d.items.length, 31);
  assert.deepEqual(d.items.find((x) => x.jjm_id === '187'), { jjm_id: '187', name: 'Bagalkote', name_raw: 'Bagalkote' });
  assert.equal(parseDropdown(json('blocks-187.json'), 'block').items.length, 9);
  const gps = parseDropdown(json('gps-2481.json'), 'gp').items;
  assert.equal(gps.length, 30);
  assert.ok(gps.some((g) => g.jjm_id === '59783' && g.name === 'Adagal'));
  const v = parseDropdown(json('villages-59783.json'), 'village').items;
  assert.equal(v.length, 2);
  assert.equal(v[0].jjm_id, '588577', 'numeric village IDs become strings');
  assert.equal(parseDropdown({}, 'gp').items.length, 0);
});

test('upper-case names are normalised for display', () => {
  assert.equal(displayName('KULAGERI CROSS'), 'Kulageri Cross');
  assert.equal(displayName('Fakir-budhihal'), 'Fakir-budhihal');
});

test('inline parameter strings split on the last " : " and keep units', () => {
  const v = parseParamList(' Colour (Hazen units) : 1.000, Turbidity (NTU) : 0.800, pH (NA) : 7.350, Total Alkalinity (as Calcium Carbonate) (mg/l) : 278.600, Total coliform (CFU/ 100 ml) : 0.000');
  assert.deepEqual(v.map((x) => [x.key, x.label, x.unit, x.value]), [
    ['colour', 'Colour', 'Hazen units', 1],
    ['turbidity', 'Turbidity', 'NTU', 0.8],
    ['ph', 'pH', null, 7.35],
    ['alkalinity', 'Total Alkalinity (as Calcium Carbonate)', 'mg/l', 278.6],
    ['total_coliform', 'Total coliform', 'CFU/ 100 ml', 0],
  ]);
  assert.deepEqual(parseParamList(''), []);
  assert.equal(parseParamList('Total dissovled solids (mg/l) : 1200.000')[0].key, 'tds');
});

test('JSON sample list: rows, dates, source type and report digits', () => {
  const { rows, totalPages } = parseSampleListJson(json('samplelist-fil-59783-2025-2026-tested.json'));
  assert.equal(rows.length, 16);
  assert.equal(totalPages, 1);
  const r = rows.find((x) => x.sample_id === 'U1359972S35664446');
  assert.ok(r);
  assert.equal(r.report_digits, '35664446');
  assert.equal(r.gp, 'Adagal');
  assert.equal(r.block, 'Badami');
  assert.equal(r.source_type, 'Deep Tubewell');
  assert.equal(r.lab_name, 'RDW&SD Water Quality Testing Lab Bagalakote');
  assert.equal(r.collected_at?.toISOString(), '2026-03-04T18:30:00.000Z', '05/03/2026 IST');
  assert.equal(r.analysed_at?.toISOString(), '2026-03-05T18:30:00.000Z', '06/03/2026 IST');
  assert.equal(r.chemical.length, 14);
  assert.equal(r.bacteriological.length, 2);
  assert.equal(r.contaminated.length, 0);
  assert.ok(!('Name' in r.raw), 'no personal fields kept');
});

test('contaminated list rows name the parameters above the permissible limit', () => {
  const { rows } = parseSampleListJson(json('samplelist-fil-block-2481-2025-2026-contaminated.json'));
  assert.equal(rows.length, 19);
  const k = rows.find((x) => x.sample_id === 'U1359972S30117289');
  assert.deepEqual(k?.contaminated.map((c) => [c.key, c.value]), [['nitrate', 61.37], ['fluoride', 1.93]]);
  const m = rows.find((x) => x.sample_id === 'U1359972S35124026');
  assert.deepEqual(m?.contaminated.map((c) => c.key), ['hardness', 'e_coli', 'total_coliform']);
  assert.match(rows[0].remedial ?? '', /RO unit/);
});

test('HTML sample list maps columns by header text and agrees with the JSON variant', () => {
  const h = parseSampleListHtml(raw('samplelist-59783-2025-2026-tested.html'));
  assert.equal(h.fy, '2025-2026');
  assert.equal(h.rows.length, 16);
  const j = parseSampleListJson(json('samplelist-fil-59783-2025-2026-tested.json'));
  const pick = (r) => [r.sample_id, r.collected_at?.toISOString(), r.analysed_at?.toISOString(), r.chemical.length];
  assert.deepEqual(h.rows.map(pick).sort(), j.rows.map(pick).sort());
});

test('inconclusive rows are flagged', () => {
  const { rows } = parseSampleListHtml(raw('samplelist-59783-2025-2026-inconclusive.html'));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.inconclusive && r.analysed_at === null));
});

test('source type falls back to the leading category', () => {
  assert.equal(sourceType('School name : GOVT HIGH SCHOOL ADAGAL'), 'School');
  assert.equal(sourceType('Source Type : Deep Tubewell, location : Dewara South'), 'Deep Tubewell');
  assert.equal(sourceType('Near mata side'), null);
  assert.equal(reportDigits('U703822S28606524'), '28606524');
  assert.equal(reportDigits('junk'), null);
});

test('report: four IST timestamps, lab, coordinates, and no personal data', () => {
  const r = parseReport(raw('report-35664446-adagal-within-limits.html'));
  assert.equal(r.sample_id, 'U1359972S35664446');
  assert.equal(r.gp, 'Adagal');
  assert.equal(r.collected_at?.toISOString(), '2026-03-05T07:00:00.000Z', '05.03.2026 | 12:30:00 PM IST');
  assert.equal(r.received_at?.toISOString(), '2026-03-05T11:03:00.000Z');
  assert.equal(r.analysed_at?.toISOString(), '2026-03-06T11:35:00.000Z');
  assert.equal(r.reported_at?.toISOString(), '2026-04-04T09:46:26.000Z');
  assert.equal(r.lat, 15.55);
  assert.equal(r.lng, 75.56);
  assert.equal(r.lab_name, 'RDW&SD Water Quality Testing Lab Bagalakote');
  assert.equal(r.results.length, 16);
  for (const k of ['Name', 'Mobile', 'Email', 'Pin Code', 'Full Address']) assert.ok(!(k in r.fields), `${k} dropped`);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.results.every((x) => judgeTapResult(x).status !== 'above_permissible'));
});

test('report: E. coli counts are judged as contamination using the printed limits', () => {
  const r = parseReport(raw('report-28606524-bagavati-ecoli-present.html'));
  const ecoli = r.results.find((x) => x.key === 'e_coli');
  assert.ok(ecoli);
  assert.match(ecoli.acceptable_limit ?? '', /not be detectable/i);
  assert.equal(ecoli.value, 5);
  assert.equal(judgeTapResult(ecoli).status, 'above_permissible');
  const hard = r.results.find((x) => x.key === 'hardness');
  assert.equal(judgeTapResult(/** @type {any} */ (hard)).status, 'above_permissible');
  assert.ok(r.results.some((x) => x.nabl), 'NABL asterisks become a flag');
  assert.ok(r.results.every((x) => !x.label.endsWith('*')));
});

test('report: geogenic nitrate and fluoride above permissible; TDS above acceptable only', () => {
  const r = parseReport(raw('report-30117289-kainakatti-nitrate-fluoride.html'));
  const st = Object.fromEntries(r.results.map((x) => [x.key, judgeTapResult(x).status]));
  assert.equal(st.nitrate, 'above_permissible');
  assert.equal(st.fluoride, 'above_permissible');
  const h = parseReport(raw('report-35723920-herkal-tds-nitrate-chloride.html'));
  const hs = Object.fromEntries(h.results.map((x) => [x.key, judgeTapResult(x).status]));
  assert.equal(hs.tds, 'above_permissible');
  assert.equal(hs.chloride, 'above_permissible');
});

test('report: older 12-parameter layout with chlorine and temperature', () => {
  const r = parseReport(raw('report-19365256-old-himachal.html'));
  assert.equal(r.results.length, 12);
  const cl = r.results.find((x) => x.key === 'residual_chlorine');
  assert.ok(cl);
  assert.equal(judgeTapResult(cl).status, 'above_acceptable', '0.000 is below the 0.2 minimum');
  const t = r.results.find((x) => x.key === 'temperature');
  assert.equal(t && judgeTapResult(t).status, 'unknown', 'no limit for temperature');
});

test('count tables give per-area tested counts', () => {
  const g = parseCounts(raw('labtestingdata-gps-2481-2025-2026.html'));
  const adagal = g.rows.find((x) => x.id === '59783');
  assert.equal(adagal?.name, 'Adagal');
  assert.equal(adagal?.tested, 16);
  assert.equal(adagal?.inconclusive, 3);
  const b = parseCounts(raw('labtestingdata-blocks-187-2026-2027.html'));
  assert.equal(b.rows.length, 9);
  assert.equal(b.rows.find((x) => x.id === '2481')?.tested, 920);
});

test('dashboards', () => {
  const m = parseMainDashboard(json('dashboard-main.json'));
  assert.ok((m.data?.total_tested ?? 0) > 1_000_000);
  assert.equal(typeof m.data?.total_tested_yesterday, 'number');
  const s = parseStateDashboard(json('dashboard-states.json'));
  assert.equal(s.states.length, 34);
  assert.ok(s.states.find((x) => x.state_id === 15 && x.name === 'Karnataka'));
});
