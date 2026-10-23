// @ts-check
// Live probe of JJM WQMIS public reports (https://ejalshakti.gov.in/WQMIS). No login, no mobile API.
// Usage: node scripts/probe/probe-wqmis.mjs [--skip-crawl-size]   (saves raw responses to fixtures/wqmis/)
import { request, save, CookieJar, enc, dec } from './lib.mjs';

const B = 'https://ejalshakti.gov.in/WQMIS';
const ST = 15, DT = 187, BL = 2481, GP = 59783; // Karnataka > Bagalkote > Badami > Adagal
const e = (v) => encodeURIComponent(enc(v));
const skipCrawlSize = process.argv.includes('--skip-crawl-size');

// AES sanity check against the spec's verified vectors.
console.log('# AES vectors', enc('15') === 'n4y3XImHOT34OR3rSpPhoQ==' && enc('19365256') === 'wTFPbUYrtkpKCPa8pkatkA==' && dec(enc('2025-2026')) === '2025-2026' ? 'OK' : 'FAILED');

// 1. Session + anti-forgery token.
const jar = new CookieJar();
const page = await request(`${B}/Report/Report_L`, { jar });
const token = page.text.match(/__RequestVerificationToken[^>]*?value="([^"]+)"/)?.[1];
console.log(`# Session: GET Report/Report_L -> ${page.status}, cookies [${[...jar.cookies.keys()].join(', ')}], token ${token ? 'found' : 'MISSING'}`);
if (!token) process.exit(1);

/** POST a dropdown endpoint exactly like the page's jQuery does (form-encoded, token as form field + header). */
async function postForm(path, fields) {
  const body = new URLSearchParams({ ...fields, __RequestVerificationToken: token }).toString();
  const r = await request(`${B}/${path}`, {
    method: 'POST', jar, body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
      RequestVerificationToken: /** @type {string} */ (token), Referer: `${B}/Report/Report_L`,
    },
  });
  console.log(`POST ${path} -> ${r.status} ${r.body.length} B`);
  return r;
}
const items = (r) => JSON.parse(r.text);

console.log('\n# Hierarchy dropdowns (all POST + token)');
const districts = await postForm('Common/District_Bind_without_session', { state_id: enc(ST) });
save(`wqmis/districts-${ST}.json`, districts.body);
const blocks = await postForm('Common/Block_Bind_without_session', { state_id: enc(ST), District_id: enc(DT) });
save(`wqmis/blocks-${DT}.json`, blocks.body);
const gps = await postForm('Common/GetGramPanchayat_Bind_without_session', { state_id: enc(ST), District_id: enc(DT), Block_id: enc(BL) });
save(`wqmis/gps-${BL}.json`, gps.body);
const villages = await postForm('Common/GetVillage_Bind_without_session', { state_id: enc(ST), District_id: enc(DT), Block_id: enc(BL), Grampanchayat_id: enc(GP) });
save(`wqmis/villages-${GP}.json`, villages.body);
console.log(`  districts ${items(districts).length - 1}, blocks ${items(blocks).length - 1}, GPs in Badami ${items(gps).length - 1}, villages in Adagal ${items(villages).length - 1} (placeholder excluded)`);

if (!skipCrawlSize) {
  console.log('\n# Crawl size for Bagalkote');
  let total = 0;
  for (const b of items(blocks).filter((x) => x.JJM_BlockId && x.JJM_BlockId.trim() && x.JJM_BlockId !== '0')) {
    const r = await postForm('Common/GetGramPanchayat_Bind_without_session', { state_id: enc(ST), District_id: enc(DT), Block_id: enc(b.JJM_BlockId) });
    const n = items(r).filter((x) => x.JJM_PanchayatId && String(x.JJM_PanchayatId).trim() && x.JJM_PanchayatId !== '0').length;
    console.log(`  ${b.BlockName} (${b.JJM_BlockId}): ${n} GPs`);
    total += n;
  }
  console.log(`  TOTAL: ${total} GPs`);
}

console.log('\n# Sample lists (GET HTML page, villid=enc(0) -> whole GP)');
const listUrl = (cs, fy, bl, gp) => `${B}/Report/labtestingsamplelist?currentstatus=${e(cs)}&fy=${e(fy)}&stid=${e(ST)}&dtid=${e(DT)}&blid=${e(bl)}&gpid=${e(gp)}&villid=${e(0)}`;
const rowCount = (h) => (h.split('tbllabtestingsample')[1]?.split('</tbody>')[0].match(/<tr/g) || []).length;
for (const [name, cs, fy, bl, gp] of /** @type {const} */ ([
  ['samplelist-59783-2025-2026-tested', 3, '2025-2026', BL, GP],
  ['samplelist-59783-2026-2027-tested', 3, '2026-2027', BL, GP],
  ['samplelist-59783-2025-2026-inconclusive', 4, '2025-2026', BL, GP],
  ['samplelist-block-2481-2025-2026-contaminated', 8, '2025-2026', BL, 0],
])) {
  const r = await request(listUrl(cs, fy, bl, gp), { jar, timeoutMs: 120000 });
  console.log(`GET labtestingsamplelist cs=${cs} fy=${fy} bl=${bl} gp=${gp} -> ${r.status}, ${rowCount(r.text)} rows`);
  save(`wqmis/${name}.html`, r.body);
}

console.log('\n# Count tables: GET Report/Labtestingdata lists the SIBLINGS of the deepest non-zero id (per-district / per-block / per-GP counts)');
for (const [name, fy, bl, gp] of /** @type {const} */ ([
  ['labtestingdata-districts-15-2026-2027', '2026-2027', 0, 0],
  ['labtestingdata-blocks-187-2026-2027', '2026-2027', BL, 0],
  ['labtestingdata-gps-2481-2025-2026', '2025-2026', BL, GP],
])) {
  const r = await request(`${B}/Report/Labtestingdata?fy=${e(fy)}&stid=${e(ST)}&dtid=${e(DT)}&blid=${e(bl)}&gpid=${e(gp)}&viid=${e(0)}`, { jar, timeoutMs: 120000 });
  console.log(`GET Labtestingdata fy=${fy} bl=${bl} gp=${gp} -> ${r.status}, ${(r.text.match(/labtestingsample\('3',/g) || []).length} rows with links`);
  save(`wqmis/${name}.html`, r.body);
}

console.log('\n# Paged JSON variant: POST Report/labtestingsamplelist_fil/ (session cookie required, no token)');
async function fil(cpage, cs, fy, bl, gp) {
  const body = new URLSearchParams({ cpage: enc(cpage), currentstatus: enc(cs), stid: enc(ST), dtid: enc(DT), blid: enc(bl), gpid: enc(gp), villid: enc(0), fy: enc(fy) }).toString();
  const r = await request(`${B}/Report/labtestingsamplelist_fil/`, {
    method: 'POST', jar, body, timeoutMs: 120000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
  });
  const j = JSON.parse(r.text);
  console.log(`POST _fil cpage=${cpage} cs=${cs} fy=${fy} bl=${bl} gp=${gp} -> ${r.status}, ${j.Labtestingdata?.length ?? 0} rows, TotalPage ${j.TotalPage}`);
  return r;
}
save('wqmis/samplelist-fil-59783-2025-2026-tested.json', (await fil(1, 3, '2025-2026', BL, GP)).body);
save('wqmis/samplelist-fil-block-2481-2025-2026-contaminated.json', (await fil(1, 8, '2025-2026', BL, 0)).body);

console.log('\n# Lab reports: GET Common/final_report_print?s_id=enc(<digits after "S" in the sample ID>)');
for (const [sid, label] of [
  ['35664446', 'adagal-within-limits'], ['28606524', 'bagavati-ecoli-present'], ['35723920', 'herkal-tds-nitrate-chloride'],
  ['30117289', 'kainakatti-nitrate-fluoride'], ['19365256', 'old-himachal'],
]) {
  const r = await request(`${B}/Common/final_report_print?s_id=${e(sid)}`, { jar });
  const ok = r.status === 200 && r.text.includes('Parameters tested');
  console.log(`GET final_report_print s_id=${sid} -> ${r.status} ${ok ? 'report' : 'NO REPORT TABLE'}`);
  save(`wqmis/report-${sid}-${label}.html`, r.body);
}

console.log('\n# National dashboards (POST, empty body; GET returns 404)');
for (const [p, f] of [['Main/GetMainDashboard', 'dashboard-main.json'], ['Main/GetMainDashboard_samples_tested_laboratories', 'dashboard-states.json']]) {
  const r = await request(`${B}/${p}`, { method: 'POST', jar, body: '', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' } });
  console.log(`POST ${p} -> ${r.status} ${r.body.length} B`);
  save(`wqmis/${f}`, r.body);
}
