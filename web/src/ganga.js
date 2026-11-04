// @ts-check
// "The Ganga": a full-screen view of the river from Tehri to the Hooghly, built from CPCB's main-stem stations.
// - A ribbon that widens downstream, each stretch coloured by its station's value, with water flowing to the sea.
// - A profile of the chosen measure along the river (wide screens) or a bar per station (phones).
// - A day-by-day (past year) or month-by-month (since 2021) slider with Play, and a station x time heat map.
// Stations are spaced evenly in river order, not by distance: several are only a few km apart (Kanpur
// upstream and downstream, Chausa and Buxar) and would overlap. Distances are in the tooltips and table.
import { scaleLinear } from 'd3-scale';
import { line, area, curveMonotoneX } from 'd3-shape';
import { getGanga } from './api.js';
import { esc, num, istDate, reducedMotion } from './format.js';
import './styles/ganga.css';

const PARAMS = /** @type {const} */ ([['DO', 'Dissolved oxygen'], ['BOD', 'BOD'], ['pH', 'pH'], ['WTb', 'Turbidity'], ['WT', 'Temperature']]);
const SPANS = /** @type {const} */ ([['year', 'Past year, day by day'], ['all', 'Since 2021, month by month']]);
const monthFmt = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** @type {Map<string, Promise<any>>} */
const cache = new Map();
/** @param {string} param @param {'year'|'all'} span */
const load = (param, span) => {
  const k = `${param}|${span}`;
  if (!cache.has(k)) cache.set(k, getGanga(param, span).catch((e) => { cache.delete(k); throw e; }));
  return /** @type {Promise<any>} */ (cache.get(k));
};

/* ---------- Colour ---------- */

/** @param {string} c "#rrggbb", "#rgb" or "rgb(a)(…)" @returns {number[]} */
const rgbOf = (c) => {
  const s = c.trim();
  if (s.startsWith('#')) {
    const h = s.length === 4 ? s.slice(1).split('').map((x) => x + x).join('') : s.slice(1, 7);
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return (s.match(/[\d.]+/g) || ['0', '0', '0']).slice(0, 3).map(Number);
};
const palette = () => {
  const cs = getComputedStyle(document.documentElement);
  const v = (/** @type {string} */ n) => cs.getPropertyValue(n).trim();
  return { ok: v('--ok'), caution: v('--caution'), danger: v('--danger'), none: v('--stale'), seqLo: rgbOf(v('--seq-lo') || '#CFE3EE'), seqHi: rgbOf(v('--seq-hi') || '#1E5E8A') };
};

/**
 * Status against CPCB's limit: 'danger' outside it, 'caution' within 10% of it, 'ok' otherwise;
 * 'seq' for measures without a limit (coloured by value instead); 'none' for no data.
 * @param {number|null} v @param {{ min?: number, max?: number }|null} limit
 */
export function judge(v, limit) {
  if (v == null) return 'none';
  if (!limit) return 'seq';
  const lo = limit.min, hi = limit.max;
  if ((lo != null && v < lo) || (hi != null && v > hi)) return 'danger';
  const m = (lo != null && hi != null ? hi - lo : /** @type {number} */ (lo ?? hi)) * 0.1;
  if ((lo != null && v < lo + m) || (hi != null && v > hi - m)) return 'caution';
  return 'ok';
}

/* ---------- View ---------- */

/** @type {HTMLElement|null} */
let root = null;
/** @type {((stationNo: string) => void) | null} */
let onSelectStation = null;
/** @type {HTMLElement|null} */
let opener = null;
/** @type {{ el: Element, inert: boolean }[]} */
let inerted = [];

const st = {
  param: 'DO', span: /** @type {'year'|'all'} */ ('year'), frame: 0, playing: false,
  /** @type {any} */ data: null, /** @type {(number|null)[]} */ shown: [], timer: 0, tween: 0, first: true,
  /** @type {ResizeObserver|null} */ ro: null, lastW: 0,
};

/**
 * Open the view. `onSelect` is called with a station number when the reader picks one.
 * @param {{ onSelect: (stationNo: string) => void, opener?: HTMLElement }} o
 */
export async function openGanga(o) {
  onSelectStation = o.onSelect;
  opener = o.opener ?? /** @type {HTMLElement|null} */ (document.activeElement);
  if (!root) build();
  const r = /** @type {HTMLElement} */ (root);
  r.hidden = false;
  r.classList.remove('leaving');
  // Everything else on the page is inert while the dialog is open.
  inerted = [...document.body.children].filter((el) => el !== r && el.tagName !== 'SCRIPT').map((el) => ({ el, inert: /** @type {any} */ (el).inert }));
  for (const { el } of inerted) /** @type {any} */ (el).inert = true;
  document.documentElement.classList.add('ganga-open');
  /** @type {HTMLElement} */ (r.querySelector('#ganga-h')).focus();
  st.first = true;
  await show();
}

export function closeGanga() {
  if (!root || root.hidden) return;
  stop();
  for (const { el, inert } of inerted) /** @type {any} */ (el).inert = inert;
  inerted = [];
  document.documentElement.classList.remove('ganga-open');
  const r = root;
  if (reducedMotion()) r.hidden = true;
  else { r.classList.add('leaving'); setTimeout(() => { r.hidden = true; r.classList.remove('leaving'); }, 220); }
  opener?.focus?.();
}

function build() {
  root = document.createElement('div');
  root.className = 'ganga';
  root.id = 'ganga';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'ganga-h');
  root.hidden = true;
  root.innerHTML = `
    <div class="ganga-inner">
      <header class="ganga-head">
        <div><p class="ganga-kicker">CPCB real-time stations, upstream to downstream</p>
          <h2 id="ganga-h" tabindex="-1">The Ganga, from Tehri to the Hooghly</h2></div>
        <button type="button" class="btn ganga-close" data-close>Close</button>
      </header>
      <div class="ganga-controls">
        <div class="seg-row" role="group" aria-label="Measure">${PARAMS.map(([k, l]) => `<button type="button" class="seg-btn" data-param="${k}" aria-pressed="${k === st.param}">${l}</button>`).join('')}</div>
        <div class="seg-row" role="group" aria-label="Period">${SPANS.map(([k, l]) => `<button type="button" class="seg-btn" data-span="${k}" aria-pressed="${k === st.span}">${l}</button>`).join('')}</div>
      </div>
      <div class="ganga-stats">
        <div class="stat"><span class="big" data-stat="a">–</span><span class="lab" data-stat="a-lab"></span></div>
        <div class="stat"><span class="big" data-stat="b">–</span><span class="lab" data-stat="b-lab"></span></div>
        <div class="stat"><span class="big" data-stat="c">–</span><span class="lab" data-stat="c-lab"></span></div>
      </div>
      <p class="ganga-headline" aria-live="polite"></p>
      <div class="ganga-stage"><svg class="ganga-svg" aria-hidden="true"></svg><div class="ganga-tip" hidden></div></div>
      <div class="ganga-time">
        <button type="button" class="btn btn-primary ganga-play" aria-pressed="false">Play</button>
        <input type="range" class="ganga-slider" min="0" max="0" value="0" aria-label="Date" />
        <output class="ganga-date"></output>
      </div>
      <figure class="ganga-heat"><canvas aria-hidden="true"></canvas><div class="heat-marker" aria-hidden="true"></div>
        <figcaption></figcaption></figure>
      <details class="ganga-table"><summary>The selected date as a table</summary><div class="table-scroll" tabindex="0" role="region" aria-label="Values by station"></div></details>
      <p class="note ganga-foot">Daily averages from CPCB's real-time stations (its daily aggregates, plus this site's own hourly readings for the newest days); monthly view averages them by month. Limits are CPCB's ${esc(document.body.dataset.criteriaLabel || 'Class C')} criteria; turbidity and temperature have none, so they're coloured by value. Distances add straight lines between stations, so the river itself is longer. Real-time sensors can fail or drift: one odd day at one station is more likely the sensor than the river.</p>
    </div>`;
  document.body.append(root);
  const r = root;
  r.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest('[data-close]')) { closeGanga(); return; }
    const p = /** @type {HTMLElement|null} */ (t.closest('[data-param]'));
    if (p && p.dataset.param !== st.param) { st.param = /** @type {string} */ (p.dataset.param); pressed('[data-param]', st.param); show(); return; }
    const s = /** @type {HTMLElement|null} */ (t.closest('[data-span]'));
    if (s && s.dataset.span !== st.span) { st.span = /** @type {any} */ (s.dataset.span); pressed('[data-span]', st.span); st.first = true; show(); return; }
    const pick = /** @type {SVGElement|null} */ (t.closest('[data-station]'));
    if (pick) choose(/** @type {string} */ (pick.getAttribute('data-station')));
  });
  r.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeGanga(); return; }
    if (e.key === 'Tab') trapFocus(e);
    const node = /** @type {HTMLElement} */ (e.target).closest?.('[data-station]');
    if (node && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(/** @type {string} */ (node.getAttribute('data-station'))); }
  });
  const slider = /** @type {HTMLInputElement} */ (r.querySelector('.ganga-slider'));
  slider.addEventListener('input', () => { stop(); setFrame(Number(slider.value), 160); });
  r.querySelector('.ganga-play')?.addEventListener('click', () => (st.playing ? stop() : play()));
  const canvas = /** @type {HTMLCanvasElement} */ (r.querySelector('.ganga-heat canvas'));
  const fromHeat = (/** @type {PointerEvent} */ e) => {
    const g = heatGeom();
    if (!g || !st.data) return;
    const x = e.clientX - canvas.getBoundingClientRect().left - g.left;
    if (x < 0) return;
    stop();
    setFrame(Math.min(st.data.frames.length - 1, Math.max(0, Math.floor(x / g.cw))), 120);
  };
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); fromHeat(e); });
  canvas.addEventListener('pointermove', (e) => { if (canvas.hasPointerCapture(e.pointerId)) fromHeat(e); });
  r.querySelector('.ganga-table')?.addEventListener('toggle', () => renderTable());
  const stage = /** @type {HTMLElement} */ (r.querySelector('.ganga-stage'));
  st.ro = new ResizeObserver(() => {
    const w = Math.round(stage.clientWidth);
    if (st.data && w && Math.abs(w - st.lastW) > 8) { st.lastW = w; drawStage(); drawHeat(); paint(st.shown, false); }
  });
  st.ro.observe(stage);
  // Tooltips for stations, from the pointer or keyboard focus.
  const tip = /** @type {HTMLElement} */ (r.querySelector('.ganga-tip'));
  const showTip = (/** @type {Element} */ el) => {
    const i = Number(el.getAttribute('data-i'));
    if (!st.data || Number.isNaN(i)) return;
    tip.innerHTML = tipHtml(i);
    tip.hidden = false;
    const box = el.getBoundingClientRect(), sb = stage.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(4, Math.min(sb.width - w - 4, box.left - sb.left + box.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(4, box.top - sb.top - tip.offsetHeight - 10)}px`;
  };
  stage.addEventListener('pointerover', (e) => { const el = /** @type {Element} */ (e.target).closest?.('[data-i]'); if (el) showTip(el); });
  stage.addEventListener('pointerout', (e) => { if (!(/** @type {any} */ (e).relatedTarget)?.closest?.('[data-i]')) tip.hidden = true; });
  stage.addEventListener('focusin', (e) => { const el = /** @type {Element} */ (e.target).closest?.('[data-i]'); if (el) showTip(el); });
  stage.addEventListener('focusout', () => { tip.hidden = true; });
}

/** @param {string} sel @param {string} on */
function pressed(sel, on) {
  root?.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(Object.values(/** @type {HTMLElement} */ (b).dataset)[0] === on)));
}

/** @param {KeyboardEvent} e */
function trapFocus(e) {
  const f = /** @type {HTMLElement[]} */ ([...(/** @type {HTMLElement} */ (root)).querySelectorAll('button, input, summary, [tabindex="0"], a[href]')]).filter((x) => !x.closest('[hidden]') && x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/** @param {string} no */
function choose(no) {
  closeGanga();
  onSelectStation?.(no);
}

/** Load the current measure and period, then draw everything. */
async function show() {
  const r = /** @type {HTMLElement} */ (root);
  stop();
  const headline = /** @type {HTMLElement} */ (r.querySelector('.ganga-headline'));
  const prevDate = st.data?.frames?.[st.frame];
  r.classList.add('loading');
  headline.textContent = 'Loading the river.';
  try {
    st.data = await load(st.param, st.span);
  } catch (err) {
    headline.textContent = /** @type {Error} */ (err).message;
    r.classList.remove('loading');
    return;
  }
  r.classList.remove('loading');
  const d = st.data;
  const slider = /** @type {HTMLInputElement} */ (r.querySelector('.ganga-slider'));
  slider.max = String(Math.max(0, d.frames.length - 1));
  // Keep the same date when switching measure; otherwise the newest frame where most stations reported.
  const same = prevDate ? d.frames.indexOf(prevDate) : -1;
  st.frame = same >= 0 && !st.first ? same : latestGood(d);
  st.shown = d.stations.map(() => null);
  st.lastW = Math.round(/** @type {HTMLElement} */ (r.querySelector('.ganga-stage')).clientWidth);
  drawStage();
  drawHeat();
  setFrame(st.frame, 0, st.first);
  st.first = false;
}

/**
 * The newest frame where most stations reported. In the daily view today is still incomplete (a few hours
 * of readings make a poor daily average), so it starts from yesterday.
 * @param {any} d
 */
function latestGood(d) {
  const n = d.stations.length;
  const from = d.bucket === 'day' ? d.frames.length - 2 : d.frames.length - 1;
  for (let f = from; f >= 0; f--) if (d.stations.filter((/** @type {any} */ s) => s.values[f] != null).length >= n * 0.75) return f;
  return Math.max(0, from);
}

/* ---------- Geometry ---------- */

/** @type {any} */
let G = null;

/** Value domain across every frame (2nd to 98th percentile) plus the limit, for a stable axis while playing. */
function domain() {
  const d = st.data;
  const all = d.stations.flatMap((/** @type {any} */ s) => s.values).filter((/** @type {any} */ v) => v != null).sort((/** @type {number} */ a, /** @type {number} */ b) => a - b);
  if (!all.length) return [0, 1];
  const q = (/** @type {number} */ p) => all[Math.min(all.length - 1, Math.max(0, Math.round(p * (all.length - 1))))];
  let lo = q(0.02), hi = q(0.98);
  // An upper limit (BOD) keeps the axis near it: sensor outliers of 20x the limit would flatten everything
  // that matters. Clamped points sit on the axis edge and their labels still give the real value.
  if (d.limit?.max != null && d.limit?.min == null) hi = Math.min(hi, d.limit.max * 4);
  for (const v of [d.limit?.min, d.limit?.max]) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (hi - lo < 1e-9) hi = lo + 1;
  return [lo, hi];
}

const shortPlace = (/** @type {string} */ p) => p.replace(' (upstream)', ' up').replace(' (downstream)', ' down').split(',')[0];

function drawStage() {
  const r = /** @type {HTMLElement} */ (root);
  const d = st.data;
  const svg = /** @type {SVGSVGElement} */ (r.querySelector('.ganga-svg'));
  const W = Math.max(300, Math.round(/** @type {HTMLElement} */ (r.querySelector('.ganga-stage')).clientWidth));
  const n = d.stations.length;
  const vertical = W < 720;
  const [d0, d1] = domain();
  const motion = !reducedMotion();
  let body = '';
  if (!vertical) {
    // River across the top (centre line near y = 84), profile chart between PT (top) and PB (bottom).
    const PT = 186, PB = 362, H = 392, padL = 56, padR = 56;
    const xs = d.stations.map((/** @type {any} */ _s, /** @type {number} */ i) => padL + (i * (W - padL - padR)) / Math.max(1, n - 1));
    const x0 = xs[0] - 34, x1 = xs[n - 1] + 34;
    const cy = (/** @type {number} */ x) => 84 + 13 * Math.sin(x / 88) + 6 * Math.sin(x / 31 + 1.3);
    const wid = (/** @type {number} */ x) => 9 + 24 * Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
    const yv = scaleLinear().domain([d0, d1]).nice(5).range([PB, PT]);
    G = { vertical, W, H, xs, cy, wid, yv, x0, x1, PT, PB };
    body += ribbon(x0, x1, (t) => [t, cy(t)], wid, true, motion);
    // Station connectors, nodes, labels.
    body += d.stations.map((/** @type {any} */ s, /** @type {number} */ i) => {
      const x = xs[i], y = cy(x), w = wid(x);
      const above = i % 2 === 0;
      return `<line class="tie" x1="${x}" x2="${x}" y1="${y + w / 2 + 2}" y2="${PT}"/>
        <g class="node" data-station="${esc(s.station_no)}" data-i="${i}" tabindex="0" role="button" aria-label="${esc(`${s.place}: open this station's history`)}" style="--d:${i * 55}ms">
          <circle class="pulse" cx="${x}" cy="${y}" r="9"/><circle class="dot" cx="${x}" cy="${y}" r="7"/></g>
        <text class="place${above ? '' : ' below'}" x="${x}" y="${above ? y - w / 2 - 12 : y + w / 2 + 22}" text-anchor="middle">${esc(shortPlace(s.place))}</text>`;
    }).join('');
    body += `<text class="end-label" x="${x0 - 4}" y="${cy(x0) + 4}" text-anchor="end">Himalaya</text><text class="end-label" x="${x1 + 4}" y="${cy(x1) + 4}">Bay of Bengal</text>`;
    // Profile axis and limit band.
    const ticks = yv.ticks(5);
    body += `<g class="axis">${ticks.map((v) => `<line class="grid" x1="${padL - 8}" x2="${W - padR + 8}" y1="${yv(v)}" y2="${yv(v)}"/><text x="${padL - 14}" y="${yv(v) + 4}" text-anchor="end">${esc(num(v, 2))}</text>`).join('')}
      <text class="unit" x="${padL - 14}" y="${PT - 12}" text-anchor="end">${esc(d.unit ?? '')}</text></g>`;
    if (d.limit) {
      const top = d.limit.max != null ? yv(d.limit.max) : PT, bottom = d.limit.min != null ? yv(d.limit.min) : PB;
      body += `<rect class="band" x="${padL - 8}" width="${W - padL - padR + 16}" y="${Math.max(PT, top)}" height="${Math.max(0, Math.min(PB, bottom) - Math.max(PT, top))}"/>`;
      for (const v of [d.limit.min, d.limit.max]) if (v != null) body += `<line class="band-edge" x1="${padL - 8}" x2="${W - padR + 8}" y1="${yv(v)}" y2="${yv(v)}"/><text class="band-label" x="${W - padR + 13}" y="${yv(v) + 4}">limit ${esc(num(v, 2))}</text>`;
    }
    body += `<path class="prof-area" d=""/><path class="prof-line" d=""/>`;
    body += d.stations.map((/** @type {any} */ s, /** @type {number} */ i) => `<g class="pdot" data-station="${esc(s.station_no)}" data-i="${i}"><circle cx="${xs[i]}" cy="${PB}" r="5"/><text x="${xs[i]}" y="${PB - 12}" text-anchor="middle"></text></g>`).join('');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
  } else {
    const row = 46, top = 34, H = top + n * row + 26;
    const ys = d.stations.map((/** @type {any} */ _s, /** @type {number} */ i) => top + 12 + i * row);
    const y0 = ys[0] - 30, y1 = ys[n - 1] + 26;
    const cx = (/** @type {number} */ y) => 30 + 8 * Math.sin(y / 70) + 4 * Math.sin(y / 23 + 0.7);
    const wid = (/** @type {number} */ y) => 8 + 16 * Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
    const bx0 = Math.round(W * 0.52), bx1 = W - 8;
    const xv = scaleLinear().domain([Math.min(0, d0), d1]).range([bx0, bx1 - 44]);
    G = { vertical, W, H, ys, cx, wid, xv, bx0, bx1, y0, y1 };
    body += ribbon(y0, y1, (t) => [cx(t), t], wid, false, motion);
    if (d.limit) {
      const l = d.limit.min != null && d.limit.max != null ? [xv(d.limit.min), xv(d.limit.max)] : d.limit.min != null ? [xv(d.limit.min), bx1 - 44] : [bx0, xv(/** @type {number} */ (d.limit.max))];
      body += `<rect class="band" x="${l[0]}" width="${Math.max(0, l[1] - l[0])}" y="${top - 4}" height="${n * row}"/>`;
      for (const v of [d.limit.min, d.limit.max]) if (v != null) body += `<line class="band-edge" x1="${xv(v)}" x2="${xv(v)}" y1="${top - 4}" y2="${top - 4 + n * row}"/><text class="band-label" x="${xv(v)}" y="${top - 10}" text-anchor="middle">limit ${esc(num(v, 2))}</text>`;
    }
    body += d.stations.map((/** @type {any} */ s, /** @type {number} */ i) => {
      const y = ys[i], x = cx(y);
      return `<g class="node" data-station="${esc(s.station_no)}" data-i="${i}" tabindex="0" role="button" aria-label="${esc(`${s.place}: open this station's history`)}" style="--d:${i * 45}ms">
          <circle class="pulse" cx="${x}" cy="${y}" r="8"/><circle class="dot" cx="${x}" cy="${y}" r="6.5"/></g>
        <g class="vrow" data-station="${esc(s.station_no)}" data-i="${i}"><rect class="hit" x="${x + 14}" y="${y - row / 2}" width="${W - x - 14}" height="${row}"/>
          <text class="place" x="${x + 22}" y="${y - 2}">${esc(shortPlace(s.place))}</text><text class="km" x="${x + 22}" y="${y + 13}">${s.km ? `~${s.km} km` : 'start'}</text>
          <rect class="vbar" x="${bx0}" y="${y - 5}" height="10" width="0" rx="2"/><text class="vval" x="${bx0}" y="${y + 4}"></text></g>`;
    }).join('');
    body += `<text class="end-label" x="${cx(y0) + 16}" y="${top - 12}">Himalaya</text><text class="end-label" x="${cx(y1) + 18}" y="${H - 6}">Bay of Bengal</text>`;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
  }
  const reveal = motion && st.first;
  svg.innerHTML = body;
  svg.classList.toggle('reveal', reveal);
  svg.classList.toggle('vertical', vertical);
  if (reveal) { void svg.getBoundingClientRect(); svg.classList.add('go'); }
}

/**
 * The river as a filled ribbon along a meandering centre line, with a gradient that colours each stretch,
 * plus three dashed "current" lines that flow downstream.
 * @param {number} a0 @param {number} a1 start and end along the flow axis
 * @param {(t: number) => [number, number]} at centre point at t @param {(t: number) => number} wid
 * @param {boolean} horizontal @param {boolean} motion
 */
function ribbon(a0, a1, at, wid, horizontal, motion) {
  const steps = Math.max(40, Math.round((a1 - a0) / 6));
  /** @type {[number, number][]} */ const left = [];
  /** @type {[number, number][]} */ const right = [];
  /** @type {[number, number][][]} */ const lanes = [[], [], []];
  for (let k = 0; k <= steps; k++) {
    const t = a0 + ((a1 - a0) * k) / steps;
    const [x, y] = at(t);
    const w = wid(t);
    if (horizontal) { left.push([x, y - w / 2]); right.push([x, y + w / 2]); [-0.24, 0.02, 0.26].forEach((o, j) => lanes[j].push([x, y + o * w])); } else { left.push([x - w / 2, y]); right.push([x + w / 2, y]); [-0.24, 0.02, 0.26].forEach((o, j) => lanes[j].push([x + o * w, y])); }
  }
  const pts = (/** @type {[number, number][]} */ a) => a.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L');
  const outline = `M${pts(left)} L${pts(right.reverse())} Z`;
  const pos = G.vertical ? G.ys : G.xs;
  const stops = st.data.stations.map((/** @type {any} */ _s, /** @type {number} */ i) => `<stop data-i="${i}" offset="${((pos[i] - a0) / (a1 - a0)).toFixed(4)}"/>`).join('');
  const grad = horizontal ? `x1="${a0}" x2="${a1}" y1="0" y2="0"` : `x1="0" x2="0" y1="${a0}" y2="${a1}"`;
  return `<defs><linearGradient id="ganga-grad" gradientUnits="userSpaceOnUse" ${grad}>${stops}</linearGradient>
      <clipPath id="ganga-clip"><path d="${outline}"/></clipPath></defs>
    <path class="riverbed" d="${outline}"/>
    <path class="river" d="${outline}" fill="url(#ganga-grad)"/>
    <g class="current${motion ? ' moving' : ''}" clip-path="url(#ganga-clip)">${lanes.map((l, j) => `<path class="lane l${j}" d="M${pts(l)}"/>`).join('')}</g>`;
}

/* ---------- Frames ---------- */

/** @param {number} f @param {number} ms tween duration @param {boolean} [countUp] animate the station count */
function setFrame(f, ms, countUp = !st.playing && ms > 0) {
  const d = st.data;
  st.frame = f;
  const r = /** @type {HTMLElement} */ (root);
  /** @type {HTMLInputElement} */ (r.querySelector('.ganga-slider')).value = String(f);
  const label = frameLabel(f);
  /** @type {HTMLOutputElement} */ (r.querySelector('.ganga-date')).value = label;
  /** @type {HTMLInputElement} */ (r.querySelector('.ganga-slider')).setAttribute('aria-valuetext', label);
  const target = d.stations.map((/** @type {any} */ s) => s.values[f]);
  colour(target);
  if (countUp && st.first) { const a = r.querySelector('[data-stat="a"]'); if (a) a.textContent = '0'; }
  stats(f, target, countUp);
  moveMarker(f);
  cancelAnimationFrame(st.tween);
  const from = st.shown.slice();
  if (!ms || reducedMotion() || from.every((v) => v == null)) { paint(target, false); return; }
  const t0 = performance.now();
  const step = (/** @type {number} */ now) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - (1 - k) ** 3;
    paint(target.map((/** @type {number|null} */ v, /** @type {number} */ i) => (v == null || from[i] == null ? v : /** @type {number} */ (from[i]) + (v - /** @type {number} */ (from[i])) * e)), k < 1);
    if (k < 1) st.tween = requestAnimationFrame(step);
  };
  st.tween = requestAnimationFrame(step);
  if (/** @type {HTMLDetailsElement} */ (r.querySelector('.ganga-table')).open && !st.playing) renderTable();
}

/** @param {number} f */
function frameLabel(f) {
  const day = st.data.frames[f];
  if (!day) return '';
  return st.data.bucket === 'month' ? monthFmt.format(new Date(`${day}T00:00:00Z`)) : istDate(new Date(`${day}T00:00:00+05:30`));
}

/** Colour every stretch, node, profile dot and bar for the frame's values. @param {(number|null)[]} vals */
function colour(vals) {
  const r = /** @type {HTMLElement} */ (root);
  const d = st.data;
  const pal = palette();
  const [d0, d1] = domain();
  const colourOf = (/** @type {number|null} */ v) => {
    const j = judge(v, d.limit);
    if (j === 'seq') {
      const t = Math.min(1, Math.max(0, ((/** @type {number} */ (v)) - d0) / (d1 - d0)));
      return { j, c: `rgb(${pal.seqLo.map((a, i) => Math.round(a + (pal.seqHi[i] - a) * t)).join(',')})` };
    }
    return { j, c: /** @type {any} */ (pal)[j] };
  };
  vals.forEach((v, i) => {
    const { j, c } = colourOf(v);
    r.querySelector(`#ganga-grad stop[data-i="${i}"]`)?.setAttribute('style', `stop-color:${c}`);
    r.querySelectorAll(`.ganga-svg [data-i="${i}"]`).forEach((g) => { g.setAttribute('data-status', j); /** @type {SVGElement} */ (g).style.setProperty('--c', c); });
  });
}

/** Move the profile line, dots, value labels and bars. @param {(number|null)[]} vals */
function paint(vals) {
  st.shown = vals.slice();
  const r = /** @type {HTMLElement} */ (root);
  if (!G) return;
  const d = st.data;
  const fmt = (/** @type {number|null} */ v) => (v == null ? '' : num(v, d.param === 'pH' ? 2 : 1));
  if (!G.vertical) {
    // Values beyond the axis (a sensor glitch, a rare extreme) sit on its edge; their labels give the real value.
    const yOf = (/** @type {number} */ v) => Math.max(G.PT - 6, Math.min(G.PB, G.yv(v)));
    const pts = vals.map((v, i) => [G.xs[i], v]);
    const ln = line().defined((/** @type {any} */ p) => p[1] != null).x((/** @type {any} */ p) => p[0]).y((/** @type {any} */ p) => yOf(p[1])).curve(curveMonotoneX);
    const ar = area().defined((/** @type {any} */ p) => p[1] != null).x((/** @type {any} */ p) => p[0]).y0(G.PB).y1((/** @type {any} */ p) => yOf(p[1])).curve(curveMonotoneX);
    r.querySelector('.prof-line')?.setAttribute('d', ln(/** @type {any} */ (pts)) ?? '');
    r.querySelector('.prof-area')?.setAttribute('d', ar(/** @type {any} */ (pts)) ?? '');
    const showVals = G.W / vals.length >= 46;
    r.querySelectorAll('.pdot').forEach((g, i) => {
      const v = vals[i];
      const y = v == null ? G.PB : yOf(v);
      g.querySelector('circle')?.setAttribute('cy', String(y));
      const t = /** @type {SVGTextElement} */ (g.querySelector('text'));
      t.setAttribute('y', String(y - 10));
      t.textContent = showVals ? fmt(v) : '';
      g.classList.toggle('missing', v == null);
    });
  } else {
    r.querySelectorAll('.vrow').forEach((g, i) => {
      const v = vals[i];
      const bar = /** @type {SVGRectElement} */ (g.querySelector('.vbar'));
      const x = v == null ? G.bx0 : Math.max(G.bx0, Math.min(G.bx1 - 44, G.xv(v)));
      bar.setAttribute('width', String(Math.max(0, x - G.bx0)));
      const t = /** @type {SVGTextElement} */ (g.querySelector('.vval'));
      t.setAttribute('x', String(x + 6));
      t.textContent = v == null ? 'no data' : fmt(v);
      g.classList.toggle('missing', v == null);
    });
  }
}

/** The three big numbers and the headline sentence. @param {number} f @param {(number|null)[]} vals @param {boolean} count */
function stats(f, vals, count) {
  const r = /** @type {HTMLElement} */ (root);
  const d = st.data;
  const set = (/** @type {string} */ k, /** @type {string} */ v) => { const el = r.querySelector(`[data-stat="${k}"]`); if (el) el.textContent = v; };
  const u = d.unit ? ` ${d.unit}` : '';
  const rep = d.stations.map((/** @type {any} */ s, /** @type {number} */ i) => ({ s, v: vals[i] })).filter((/** @type {any} */ x) => x.v != null);
  const when = frameLabel(f);
  const avgWord = d.bucket === 'month' ? 'monthly average' : 'daily average';
  const headline = /** @type {HTMLElement} */ (r.querySelector('.ganga-headline'));
  set('c', when);
  set('c-lab', d.bucket === 'month' ? 'month shown' : 'day shown');
  if (!rep.length) {
    set('a', '–'); set('a-lab', 'no stations reported'); set('b', '–'); set('b-lab', '');
    headline.textContent = `No station reported ${d.label.toLowerCase()} for ${when}.`;
    return;
  }
  const label = d.param === 'pH' ? 'pH' : d.label.toLowerCase();
  if (d.limit) {
    const within = rep.filter((/** @type {any} */ x) => judge(x.v, d.limit) !== 'danger');
    const mid = d.limit.min != null && d.limit.max != null ? (d.limit.min + d.limit.max) / 2 : null;
    const badness = (/** @type {number} */ v) => (mid != null ? Math.abs(v - mid) : d.limit.min != null ? -v : v);
    const worst = rep.reduce((/** @type {any} */ a, /** @type {any} */ b) => (badness(b.v) > badness(a.v) ? b : a));
    countTo(r.querySelector('[data-stat="a"]'), within.length, `/${rep.length}`, count);
    set('a-lab', 'stations within the limit');
    set('b', `${num(worst.v, 2)}${u}`);
    set('b-lab', `${judge(worst.v, d.limit) === 'danger' ? 'worst, outside the limit' : 'closest to the limit'}: ${shortPlace(worst.s.place)}`);
    const out = rep.filter((/** @type {any} */ x) => judge(x.v, d.limit) === 'danger');
    headline.textContent = `${when}: the ${avgWord} of ${label} was within CPCB's limit (${d.limit_text}) at ${within.length} of ${rep.length} reporting stations.`
      + (out.length ? ` Outside it at ${out.slice(0, 4).map((/** @type {any} */ x) => `${shortPlace(x.s.place)} (${num(x.v, 2)}${u})`).join(', ')}${out.length > 4 ? ` and ${out.length - 4} more` : ''}.` : '');
  } else {
    const hi = rep.reduce((/** @type {any} */ a, /** @type {any} */ b) => (b.v > a.v ? b : a));
    const lo = rep.reduce((/** @type {any} */ a, /** @type {any} */ b) => (b.v < a.v ? b : a));
    set('a', `${num(hi.v, 1)}${u}`); set('a-lab', `highest: ${shortPlace(hi.s.place)}`);
    set('b', `${num(lo.v, 1)}${u}`); set('b-lab', `lowest: ${shortPlace(lo.s.place)}`);
    headline.textContent = `${when}: the ${avgWord} of ${label} ran from ${num(lo.v, 1)}${u} at ${shortPlace(lo.s.place)} to ${num(hi.v, 1)}${u} at ${shortPlace(hi.s.place)}, across ${rep.length} reporting stations. CPCB sets no limit for it.`;
  }
}

/** Count a number up from its current value. @param {Element|null} el @param {number} to @param {string} suffix @param {boolean} animate */
function countTo(el, to, suffix, animate) {
  if (!el) return;
  const from = Number.parseInt(el.textContent || '', 10);
  if (!animate || reducedMotion() || !Number.isFinite(from) || from === to) { el.textContent = `${to}${suffix}`; return; }
  const t0 = performance.now();
  const tick = (/** @type {number} */ now) => {
    const k = Math.min(1, (now - t0) / 450);
    el.textContent = `${Math.round(from + (to - from) * k)}${suffix}`;
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------- Heat map ---------- */

function heatGeom() {
  const r = /** @type {HTMLElement} */ (root);
  const canvas = /** @type {HTMLCanvasElement} */ (r.querySelector('.ganga-heat canvas'));
  if (!st.data) return null;
  const W = Math.max(280, Math.round((/** @type {HTMLElement} */ (canvas.parentElement)).clientWidth));
  const left = W < 520 ? 74 : 112;
  const rh = W < 520 ? 9 : 11;
  return { canvas, W, left, rh, H: st.data.stations.length * rh + 4, cw: (W - left - 4) / st.data.frames.length };
}

function drawHeat() {
  const g = heatGeom();
  if (!g) return;
  const d = st.data;
  const { canvas, W, left, rh, H, cw } = g;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const pal = palette();
  const [d0, d1] = domain();
  const cs = getComputedStyle(/** @type {HTMLElement} */ (root));
  ctx.font = `500 ${rh >= 11 ? 11 : 10}px ${cs.getPropertyValue('--font-ui') || 'system-ui'}`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = cs.getPropertyValue('--ink-soft') || '#555';
  /** @type {{ place: string, n: number, of: number }[]} */
  const outside = [];
  d.stations.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
    const y = 2 + i * rh;
    ctx.fillStyle = cs.getPropertyValue('--ink-soft') || '#555';
    ctx.textAlign = 'right';
    ctx.fillText(shortPlace(s.place), left - 6, y + rh / 2);
    let n = 0, of = 0;
    s.values.forEach((/** @type {number|null} */ v, /** @type {number} */ f) => {
      if (v == null) return;
      const j = judge(v, d.limit);
      of++;
      if (j === 'danger') n++;
      ctx.fillStyle = j === 'seq' ? `rgb(${pal.seqLo.map((a, k) => Math.round(a + (pal.seqHi[k] - a) * Math.min(1, Math.max(0, (v - d0) / (d1 - d0))))).join(',')})` : /** @type {any} */ (pal)[j];
      ctx.fillRect(left + f * cw, y, Math.max(1, cw + 0.4), rh - 1);
    });
    outside.push({ place: shortPlace(s.place), n, of });
  });
  const cap = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (root).querySelector('.ganga-heat figcaption'));
  const unit = d.bucket === 'month' ? 'month' : 'day';
  const worst = outside.filter((x) => x.n).sort((a, b) => b.n / b.of - a.n / a.of).slice(0, 3);
  cap.innerHTML = `Each row is a station, upstream at the top; each column is a ${unit}. Click or drag to jump to a ${unit}. `
    + (d.limit
      ? `<span class="key ok">within</span> <span class="key caution">within 10% of the limit</span> <span class="key danger">outside</span>. `
        + (worst.length ? `Most often outside the limit: ${worst.map((x) => `${esc(x.place)} (${x.n} of ${x.of} ${unit}s)`).join(', ')}.` : 'No station was outside the limit in this period.')
      : 'Darker means higher. CPCB sets no limit for this measure.');
  moveMarker(st.frame);
}

/** @param {number} f */
function moveMarker(f) {
  const g = heatGeom();
  const m = /** @type {HTMLElement|null} */ (root?.querySelector('.heat-marker') ?? null);
  if (!g || !m) return;
  m.style.left = `${g.left + f * g.cw + g.cw / 2}px`;
  m.style.height = `${g.H}px`;
}

/* ---------- Table and tooltip ---------- */

function renderTable() {
  const r = /** @type {HTMLElement} */ (root);
  const box = /** @type {HTMLElement} */ (r.querySelector('.ganga-table .table-scroll'));
  if (!(/** @type {HTMLDetailsElement} */ (r.querySelector('.ganga-table')).open) || !st.data) return;
  const d = st.data;
  const word = { ok: 'Within the limit', caution: 'Within, close to the limit', danger: 'Outside the limit', seq: 'No limit', none: 'No data' };
  box.innerHTML = `<table><thead><tr><th scope="col">Station</th><th scope="col">Reach</th><th scope="col">Distance</th><th scope="col">${esc(d.label)}${d.unit ? `<small>${esc(d.unit)}</small>` : ''}</th><th scope="col">Status</th></tr></thead><tbody>
    ${d.stations.map((/** @type {any} */ s) => { const v = s.values[st.frame]; const j = judge(v, d.limit); return `<tr><th scope="row">${esc(s.place)}</th><td>${esc(s.reach)}</td><td>~${s.km} km</td><td>${v == null ? '–' : esc(num(v, 2))}</td><td><span class="status-word ${j === 'seq' ? 'none' : j}">${word[/** @type {keyof typeof word} */ (j)]}</span></td></tr>`; }).join('')}
    </tbody></table>`;
}

/** @param {number} i */
function tipHtml(i) {
  const d = st.data;
  const s = d.stations[i];
  const v = s.values[st.frame];
  const j = judge(v, d.limit);
  const word = { ok: 'within the limit', caution: 'within, but close to the limit', danger: 'outside the limit', seq: '', none: '' }[j];
  return `<strong>${esc(s.place)}</strong> <small>${esc(s.reach)}, ~${s.km} km downstream</small><br>`
    + (v == null ? `No data for ${esc(frameLabel(st.frame))}.` : `${esc(d.label)}: ${esc(num(v, 2))}${d.unit ? ` ${esc(d.unit)}` : ''}${word ? `, ${esc(word)}` : ''}`)
    + '<br><small>Click to open its full history</small>';
}

/* ---------- Playback ---------- */

function play() {
  const d = st.data;
  if (!d) return;
  const r = /** @type {HTMLElement} */ (root);
  // From the default frame (the last complete day) or the end, playing starts over from the beginning.
  if (st.frame >= d.frames.length - 2) setFrame(0, 0);
  st.playing = true;
  const btn = /** @type {HTMLElement} */ (r.querySelector('.ganga-play'));
  btn.textContent = 'Pause';
  btn.setAttribute('aria-pressed', 'true');
  r.classList.add('playing');
  const every = d.bucket === 'month' ? 420 : 90;
  st.timer = window.setInterval(() => {
    if (st.frame >= d.frames.length - 1) { stop(); return; }
    setFrame(st.frame + 1, reducedMotion() ? 0 : every * 0.9);
  }, every);
}

function stop() {
  if (!st.playing) return;
  st.playing = false;
  clearInterval(st.timer);
  const r = /** @type {HTMLElement} */ (root);
  const btn = /** @type {HTMLElement} */ (r.querySelector('.ganga-play'));
  btn.textContent = 'Play';
  btn.setAttribute('aria-pressed', 'false');
  r.classList.remove('playing');
  stats(st.frame, st.data.stations.map((/** @type {any} */ s) => s.values[st.frame]), false);
  renderTable();
}
