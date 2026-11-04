// @ts-check
// River station: "Reading from 10:30 IST, 14 minutes ago", then two tabs: 12 small multiples of the last
// 48 hours, and the full history (hourly for a week, CPCB's daily aggregates back to 2021) as charts and a table.
import { scaleLinear, scaleTime } from 'd3-scale';
import { line, curveMonotoneX } from 'd3-shape';
import { getSeries, getSeriesHours, getStationHistory } from '../api.js';
import { esc, num, istTime, istDate, istDateTime, ago, riverPlace, status } from '../format.js';
import { rowGlyph } from '../map/markers.js';
import { timeChart } from '../charts.js';
import { tabsHtml, wireTabs } from '../tabs.js';

const ORDER = ['DO', 'BOD', 'pH', 'WTb', 'EC', 'COD', 'TOC', 'Nitrate', 'CL', 'WT', 'Depth', 'S'];
const FLOORS = /** @type {Record<string, number>} */ ({ CL: 5, COD: 5, TOC: 1, Nitrate: 0.3, EC: 1 });
const NOTES = /** @type {Record<string, string>} */ ({
  BOD: 'Sensor estimate, not a 5-day lab BOD.',
  EC: 'CPCB labels this mS/cm; the values match µS/cm.',
});

/** @param {any} s series @param {any} latest latest value object from /stations */
function sparkline(s, latest) {
  const W = 180, H = 44;
  const pts = s.points.map((/** @type {[string, number]} */ [t, v]) => [new Date(t), v]).filter((/** @type {any[]} */ p) => Number.isFinite(p[1]));
  if (pts.length < 2) return '<svg aria-hidden="true"></svg>';
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const values = pts.map((/** @type {any[]} */ p) => p[1]);
  const lim = s.limit;
  const extra = lim ? [lim.min, lim.max].filter((v) => v != null) : [];
  let lo = Math.min(...values, ...extra), hi = Math.max(...values, ...extra);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  const x = scaleTime().domain([t0, t1]).range([0, W]);
  const y = scaleLinear().domain([lo - pad, hi + pad]).range([H, 0]);
  // Gaps longer than 2 hours break the line rather than inventing values.
  const gapAware = pts.map((/** @type {any[]} */ p, i) => (i && p[0] - pts[i - 1][0] > 2 * 3600_000 ? [p[0], NaN] : p));
  const path = line().defined((/** @type {any} */ d) => Number.isFinite(d[1])).x((/** @type {any} */ d) => x(d[0])).y((/** @type {any} */ d) => y(d[1])).curve(curveMonotoneX)(/** @type {any} */ (gapAware)) ?? '';
  let band = '';
  if (lim) {
    const top = lim.max != null ? y(lim.max) : 0;
    const bottom = lim.min != null ? y(lim.min) : H;
    band = `<rect class="band" x="0" width="${W}" y="${Math.max(0, top)}" height="${Math.max(0, Math.min(H, bottom) - Math.max(0, top))}"/>`
      + (lim.max != null ? `<line class="band-edge" x1="0" x2="${W}" y1="${top}" y2="${top}"/>` : '')
      + (lim.min != null ? `<line class="band-edge" x1="0" x2="${W}" y1="${bottom}" y2="${bottom}"/>` : '');
  }
  const last = pts[pts.length - 1];
  const label = `${s.label}, last 48 hours: from ${num(Math.min(...values))} to ${num(Math.max(...values))}${s.unit ? ` ${s.unit}` : ''}, latest ${num(latest?.value ?? last[1])}.`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${band}<path class="spark" d="${path}" vector-effect="non-scaling-stroke"/><circle class="last" cx="${x(last[0])}" cy="${y(last[1])}" r="2.5"/></svg>`;
}

/** @param {HTMLElement} root @param {any} feature station feature */
export async function renderStation(root, feature) {
  const p = feature.properties;
  const lastAt = p.last_reading_at ? new Date(p.last_reading_at) : null;
  const statusWord = p.is_stale ? status('stale') : p.status === 'violation' ? status('violation') : status('ok');
  const head = `
    <div class="close-row"><p class="kind-line">${rowGlyph('station', statusWord.cls)} CPCB river station ${esc(p.station_no)}</p>
      <button type="button" class="btn-text" data-close>Close</button></div>
    <div class="place-head">
      <h2>${esc(riverPlace(p, true))}</h2>
      <p class="sub">${esc(p.name)}, ${esc(p.state ?? '')}</p>
    </div>
    <p class="reading-line">${lastAt ? `Reading from ${esc(istTime(lastAt))}, ${esc(ago(lastAt))}.` : 'This station has not sent a reading yet.'}</p>
    ${p.is_stale && lastAt ? `<p class="note">No reading since ${esc(istDateTime(lastAt))}. These are its last values, kept on the map as stale rather than dropped.${p.outage ? ` CPCB's station log records "${esc(p.outage.reason)}" since ${esc(p.outage.start.slice(0, 10))}.` : ''}</p>` : ''}
    <p class="here-row"><button type="button" class="btn" data-alerts-here>Get alerts near here</button></p>
    <p class="water-kind">This is river water at this station, not tap water. ${p.violations?.length && !p.is_stale ? `<strong class="status-word danger">${esc(p.violations.map((/** @type {string} */ v) => p.params[v]?.label ?? v).join(', '))} outside the CPCB limit.</strong>` : ''}</p>`;
  root.innerHTML = `${head}${tabsHtml([{ id: 'now', label: 'Last 48 hours' }, { id: 'history', label: 'History since 2021' }], 'now', 'Station data')}`;
  /** @type {(() => void)[]} */
  const cleanups = [];
  wireTabs(root, (id, panel) => {
    for (const c of cleanups.splice(0)) c();
    if (id === 'now') renderLatest(panel, p);
    else renderHistory(panel, p, '1y', cleanups);
  });
}

/** The latest 48 hours as small multiples. @param {HTMLElement} panel @param {any} p station properties */
async function renderLatest(panel, p) {
  panel.innerHTML = '<p class="note">Loading the last 48 hours.</p>';
  let series = [];
  try {
    series = (await getSeries(p.station_no)).series;
  } catch (err) {
    panel.innerHTML = `<p class="note">${esc(/** @type {Error} */ (err).message)}</p>`;
    return;
  }
  const byParam = new Map(series.map((/** @type {any} */ s) => [s.parameter, s]));
  const cells = ORDER.filter((k) => byParam.has(k) || p.params[k]).map((k) => {
    const s = byParam.get(k) ?? { parameter: k, label: p.params[k]?.label ?? k, unit: p.params[k]?.unit, points: [], limit: p.params[k]?.limit };
    const latest = p.params[k];
    const st = latest?.status ?? 'no_criteria';
    const atFloor = latest && FLOORS[k] != null && latest.value <= FLOORS[k];
    const word = st === 'violation' ? status('violation') : st === 'ok' ? { word: `Within ${latest.limit_text}`, cls: 'ok' } : { word: 'No official limit', cls: 'none' };
    return `<div class="multiple${st === 'violation' ? ' violation' : ''}">
      <h3>${esc(s.label)}</h3>
      <div><span class="big">${latest ? esc(num(latest.value)) : '–'}</span>${s.unit ? `<span class="unit">${esc(s.unit)}</span>` : ''}</div>
      ${sparkline(s, latest)}
      <span class="status-word ${word.cls}">${esc(st === 'violation' ? `Outside limit (${latest.limit_text})` : word.word)}</span>
      ${atFloor ? '<span class="foot">At the sensor’s lowest reading; may be below detection.</span>' : NOTES[k] ? `<span class="foot">${esc(NOTES[k])}</span>` : ''}
    </div>`;
  }).join('');
  panel.innerHTML = `
    <div class="multiples">${cells}</div>
    <p class="note">Shaded bands show CPCB's ${esc(document.body.dataset.criteriaLabel || 'Class C')} limits. Lines break where the station sent nothing for more than two hours. Times are IST.</p>`;
}

/* ---------- History ---------- */

const RANGES = /** @type {const} */ ([['7d', '7 days'], ['30d', '30 days'], ['1y', '1 year'], ['all', 'Since 2021']]);
const DAY = 86400_000;
/** Midnight IST of a YYYY-MM-DD day. @param {string} d */
const istMidnight = (d) => new Date(`${d}T00:00:00+05:30`);
const weekFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/**
 * @typedef {{ parameter: string, label: string, unit: string|null, limit: any, summaryText: string,
 *   points: import('../charts.js').Pt[], gapMs: number, describe: (pt: any) => string }} HistParam
 */

/** Hourly readings for the past week. @param {any} p @returns {Promise<{ params: HistParam[], table: string }>} */
async function weekParams(p) {
  const data = await getSeriesHours(p.station_no, 168);
  const params = data.series.map((/** @type {any} */ s) => {
    const pts = s.points.map((/** @type {[string, number]} */ [t, v]) => ({ t: new Date(t), v }));
    const vals = pts.map((/** @type {any} */ x) => x.v);
    const lim = s.limit;
    const outside = lim ? pts.filter((/** @type {any} */ x) => (lim.min != null && x.v < lim.min) || (lim.max != null && x.v > lim.max)).length : 0;
    const u = s.unit ? ` ${s.unit}` : '';
    return {
      parameter: s.parameter, label: s.label, unit: s.unit, limit: lim, gapMs: 2 * 3600_000, points: pts,
      summaryText: (!pts.length ? 'No readings this week.'
        : pts.length === 1 ? `One reading this week: ${num(vals[0])}${u}.`
          : `${pts.length} hourly readings, from ${num(Math.min(...vals))} to ${num(Math.max(...vals))}${u}.`)
        + (lim && pts.length ? ` ${outside ? `${outside === pts.length && pts.length > 1 ? 'All' : outside} outside the limit.` : pts.length > 1 ? 'All within the limit.' : 'Within the limit.'}` : ''),
      describe: (/** @type {any} */ x) => `<strong>${esc(istDateTime(x.t))}</strong><br>${esc(num(x.v))}${esc(u)}`,
    };
  });
  return { params, table: '' };
}

/** CPCB's daily aggregates, weekly for "all". @param {any} p @param {'30d'|'1y'|'all'} range @returns {Promise<{ params: HistParam[], table: string }>} */
async function dailyParams(p, range) {
  const data = await getStationHistory(p.station_no, range);
  const weekly = data.bucket === 'week';
  /** @type {HistParam[]} */
  const params = data.params.map((/** @type {any} */ s) => {
    const sm = s.summary;
    const u = s.unit ? ` ${s.unit}` : '';
    const since = sm.first_day ? ` since ${istDate(istMidnight(sm.first_day))}` : '';
    // For a minimum-only limit (dissolved oxygen) the low point matters; otherwise the high point.
    const extreme = s.limit?.min != null && s.limit?.max == null
      ? sm.lowest && `Lowest daily average ${num(sm.lowest.value)}${u}, on ${istDate(istMidnight(sm.lowest.day))}.`
      : sm.highest && `Highest daily average ${num(sm.highest.value)}${u}, on ${istDate(istMidnight(sm.highest.day))}.`;
    const text = s.limit
      ? `Daily average outside the limit on ${sm.days_outside} of ${sm.days} days${since}. ${extreme ?? ''}`
      : sm.lowest ? `Daily averages from ${num(sm.lowest.value)} to ${num(sm.highest.value)}${u} over ${sm.days} days${since}.` : 'No daily values.';
    return {
      parameter: s.parameter, label: s.label, unit: s.unit, limit: s.limit, gapMs: (weekly ? 8 : 1.5) * DAY,
      points: s.points.map((/** @type {any[]} */ [d, lo, v, hi, cov]) => ({ t: istMidnight(d), v, lo, hi, data: { cov } })),
      summaryText: text + (sm.low_coverage_days > sm.days / 4 ? ` On ${sm.low_coverage_days} days the station sent less than half its readings.` : ''),
      describe: (/** @type {any} */ x) => `<strong>${esc(weekly ? `Week of ${weekFmt.format(x.t)}` : istDate(x.t))}</strong><br>`
        + `${weekly ? 'Average' : 'Daily average'} ${esc(num(x.v))}${esc(u)}<br>Low ${esc(num(x.lo))}, high ${esc(num(x.hi))}`
        + (x.data.cov != null ? `<br><small>${x.data.cov}% of readings arrived</small>` : ''),
    };
  });
  // Table: one row per day (or week), the average of each parameter, newest first.
  const cols = ORDER.filter((k) => params.some((x) => x.parameter === k));
  /** @type {Map<string, Record<string, number|null>>} */
  const rows = new Map();
  for (const s of data.params) for (const [d, , v] of s.points) (rows.get(d) ?? rows.set(d, {}).get(d))[s.parameter] = v;
  const days = [...rows.keys()].sort().reverse();
  const unitOf = (/** @type {string} */ k) => params.find((q) => q.parameter === k);
  const head = cols.map((k) => `<th scope="col" title="${esc(unitOf(k)?.label)}">${esc(k)}${unitOf(k)?.unit ? `<small>${esc(unitOf(k)?.unit)}</small>` : ''}</th>`).join('');
  const what = weekly ? 'Weekly' : 'Daily';
  const table = `<details class="records"><summary>${what} averages as a table (${days.length} rows)</summary>
    <div class="table-scroll" tabindex="0" role="region" aria-label="${what} averages"><table><thead><tr><th scope="col">${weekly ? 'Week of' : 'Date'}</th>${head}</tr></thead><tbody>
    ${days.map((d) => `<tr><th scope="row">${esc(weekly ? weekFmt.format(istMidnight(d)) : istDate(istMidnight(d)))}</th>${cols.map((k) => { const v = rows.get(d)?.[k]; return `<td>${v == null ? '–' : esc(num(v))}</td>`; }).join('')}</tr>`).join('')}
    </tbody></table></div></details>`;
  return { params, table };
}

/**
 * One chart per parameter for the chosen period, a table of averages, and a CSV link.
 * @param {HTMLElement} panel @param {any} p @param {string} range @param {(() => void)[]} cleanups
 */
async function renderHistory(panel, p, range, cleanups) {
  const buttons = RANGES.map(([id, label]) => `<button type="button" class="seg-btn" data-range="${id}" aria-pressed="${id === range}">${label}</button>`).join('');
  panel.innerHTML = `<div class="seg-row" role="group" aria-label="Period">${buttons}</div><div class="hist-body"><p class="note">Loading history.</p></div>`;
  panel.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', async () => {
    for (const c of cleanups.splice(0)) c();
    const next = /** @type {string} */ (/** @type {HTMLElement} */ (b).dataset.range);
    await renderHistory(panel, p, next, cleanups);
    /** @type {HTMLElement|null} */ (panel.querySelector(`[data-range="${next}"]`))?.focus();
  }));
  const body = /** @type {HTMLElement} */ (panel.querySelector('.hist-body'));
  /** @type {{ params: HistParam[], table: string }} */
  let got;
  try {
    got = range === '7d' ? await weekParams(p) : await dailyParams(p, /** @type {any} */ (range));
  } catch (err) {
    body.innerHTML = `<p class="note">${esc(/** @type {Error} */ (err).message)}</p>`;
    return;
  }
  const params = got.params.sort((a, b) => ORDER.indexOf(a.parameter) - ORDER.indexOf(b.parameter));
  const intro = range === '7d'
    ? 'Every hourly reading from the past week.'
    : `CPCB's daily low, average and high${range === 'all' ? ', averaged by week' : ''}. The line is the average; the shaded ribbon spans the low and high.`;
  body.innerHTML = `<p class="note">${intro} Bands mark CPCB's limits where it sets one. Hover, tap, or focus a chart and use the arrow keys to read values.</p>
    ${params.map((x, i) => `<section class="hist-card"><h3>${esc(x.label)}${x.unit ? ` <small>${esc(x.unit)}</small>` : ''}</h3>
      <p class="hist-sum">${esc(x.summaryText)}</p><div class="chart-host" data-i="${i}"></div>${NOTES[x.parameter] ? `<p class="foot">${esc(NOTES[x.parameter])}</p>` : ''}</section>`).join('')}
    ${got.table}
    <p class="csv-link"><a href="/api/stations/${esc(encodeURIComponent(p.station_no))}/history.csv" download>Download every daily record for this station (CSV)</a></p>`;
  body.querySelectorAll('.chart-host').forEach((host) => {
    const x = params[Number(/** @type {HTMLElement} */ (host).dataset.i)];
    cleanups.push(timeChart(/** @type {HTMLElement} */ (host), {
      mode: 'line', points: x.points, label: x.label, unit: x.unit, limit: x.limit, gapMs: x.gapMs, height: 140,
      describe: x.describe, summary: `${x.label}: ${x.summaryText}`,
    }));
  });
}
