// @ts-check
// Report/Labtestingdata: counts for the siblings of the deepest selected area. Used as a cheap change
// detector so the daily job only re-reads sample lists for GPs whose "tested" count moved.
import * as cheerio from 'cheerio';

/** Column order after S.No. and name, matching the currentstatus codes in docs/SOURCES.md. */
export const COUNT_COLUMNS = ['submitted', 'not_received', 'received', 'received_not_tested', 'tested', 'tested_chemical',
  'tested_bacteriological', 'inconclusive', 'contaminated', 'contaminated_chemical', 'contaminated_bacteriological',
  'remedial', 'remedial_chemical', 'remedial_bacteriological'];

/**
 * @param {string} html
 * @returns {{ rows: ({ id: string, name: string } & Record<string, number|string>)[], warnings: string[] }}
 */
export function parseCounts(html) {
  const $ = cheerio.load(html);
  /** @type {any[]} */
  const rows = [];
  $('tbody.tblLabtesting > tr').each((_, tr) => {
    const tds = $(tr).children('td');
    if (tds.length < 2 + COUNT_COLUMNS.length) return;
    const nameCell = $(tds[1]);
    const name = nameCell.text().replace(/\s+/g, ' ').trim();
    if (!name || /^total$/i.test(name)) return;
    const onclick = nameCell.find('a').attr('onclick') || '';
    const link = $(tr).find('a[onclick*="labtestingsample"]').attr('onclick') || '';
    const id = onclick.match(/GetData\('\d+',\s*'(\d+)'/)?.[1] ?? link.match(/labtestingsample\('\d+',\s*(\d+)\)/)?.[1];
    if (!id) return;
    /** @type {any} */
    const row = { id, name };
    COUNT_COLUMNS.forEach((col, i) => { row[col] = Number($(tds[2 + i]).text().replace(/[^\d]/g, '')) || 0; });
    rows.push(row);
  });
  return { rows, warnings: rows.length ? [] : ['count table has no rows'] };
}
