// @ts-check
// Interactive time charts for the history tabs. One SVG per chart, drawn at the host's real width (redrawn
// when it changes), with a crosshair and tooltip driven by pointer, touch or keyboard (arrow keys, Home,
// End, Enter). Two modes:
// - 'line': a value per time (hourly readings, or daily means), optionally with a low-high band behind it.
// - 'dots': separate measurements coloured by status (lab samples), with reference lines for limits.
import { scaleLinear, scaleTime } from 'd3-scale';
import { line, area, curveMonotoneX } from 'd3-shape';
import { esc, num } from './format.js';

/**
 * @typedef {{ t: Date, v: number|null, lo?: number|null, hi?: number|null, cls?: string, data?: any }} Pt
 * @typedef {{ value: number, label: string, cls: string }} RefLine
 * @typedef {{
 *   mode: 'line'|'dots', points: Pt[], label: string, unit?: string|null,
 *   limit?: { min?: number, max?: number }|null, refLines?: RefLine[], gapMs?: number, height?: number,
 *   describe: (p: Pt) => string, summary: string, onPick?: (p: Pt) => void,
 * }} ChartCfg
 */

const IST = 'Asia/Kolkata';
const fmt = (/** @type {Intl.DateTimeFormatOptions} */ o) => new Intl.DateTimeFormat('en-IN', { timeZone: IST, ...o });
const F = {
  hour: fmt({ hour: '2-digit', minute: '2-digit', hour12: false }),
  day: fmt({ day: 'numeric', month: 'short' }),
  month: fmt({ month: 'short', year: '2-digit' }),
  year: fmt({ year: 'numeric' }),
};

/** Tick labels that suit the time span shown. @param {number} spanMs */
function tickFormat(spanMs) {
  const day = 86400_000;
  if (spanMs <= 3 * day) return (/** @type {Date} */ d) => (F.hour.format(d) === '00:00' ? F.day.format(d) : F.hour.format(d));
  if (spanMs <= 120 * day) return (/** @type {Date} */ d) => F.day.format(d);
  if (spanMs <= 3 * 365 * day) return (/** @type {Date} */ d) => F.month.format(d).replace(' ', ' ’');
  return (/** @type {Date} */ d) => F.year.format(d);
}

/** Index of the point nearest in time. @param {Pt[]} pts @param {number} t */
function nearest(pts, t) {
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].t.getTime() < t) lo = mid; else hi = mid; }
  return Math.abs(pts[lo].t.getTime() - t) <= Math.abs(pts[hi].t.getTime() - t) ? lo : hi;
}

/**
 * Draw a chart into host (cleared first). Returns a function that removes listeners.
 * @param {HTMLElement} host @param {ChartCfg} cfg
 */
export function timeChart(host, cfg) {
  const pts = cfg.points.filter((p) => p.t instanceof Date && !Number.isNaN(p.t.getTime())).sort((a, b) => a.t.getTime() - b.t.getTime());
  host.classList.add('tchart');
  if (pts.filter((p) => p.v != null || cfg.mode === 'dots').length < 1) {
    host.innerHTML = '<p class="note">No values in this period.</p>';
    return () => {};
  }
  const H = cfg.height ?? 150;
  const M = { t: 10, r: 10, b: 22, l: 40 };
  let idx = -1;
  /** @type {any} */ let x, y, W = 0;

  const draw = () => {
    W = Math.max(240, Math.round(host.clientWidth || 340));
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const span = Math.max(1, t1.getTime() - t0.getTime());
    x = scaleTime().domain(span < 1000 ? [new Date(t0.getTime() - 86400_000), new Date(t1.getTime() + 86400_000)] : [t0, t1]).range([M.l, W - M.r]);
    const vals = pts.flatMap((p) => [p.v, p.lo, p.hi]).filter((v) => v != null && Number.isFinite(v));
    const extra = [cfg.limit?.min, cfg.limit?.max, ...(cfg.refLines ?? []).map((r) => r.value)].filter((v) => v != null && Number.isFinite(v));
    let lo = Math.min(...vals, ...extra), hi = Math.max(...vals, ...extra);
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.08;
    // Measurements that can't be negative never get a negative axis from padding.
    y = scaleLinear().domain([lo >= 0 ? Math.max(0, lo - pad) : lo - pad, hi + pad]).nice(4).range([H - M.b, M.t]);

    const gap = cfg.gapMs ?? Infinity;
    const broken = pts.map((p, i) => (i && p.t.getTime() - pts[i - 1].t.getTime() > gap ? { ...p, v: null, lo: null, hi: null } : p));
    const xs = (/** @type {Pt} */ p) => x(p.t), ys = (/** @type {number} */ v) => y(v);
    let body = '';
    if (cfg.limit) {
      const top = cfg.limit.max != null ? y(cfg.limit.max) : M.t;
      const bottom = cfg.limit.min != null ? y(cfg.limit.min) : H - M.b;
      body += `<rect class="band" x="${M.l}" width="${W - M.l - M.r}" y="${Math.max(M.t, top)}" height="${Math.max(0, Math.min(H - M.b, bottom) - Math.max(M.t, top))}"/>`;
      for (const v of [cfg.limit.min, cfg.limit.max]) if (v != null) body += `<line class="band-edge" x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    }
    for (const r of cfg.refLines ?? []) {
      body += `<line class="ref ${esc(r.cls)}" x1="${M.l}" x2="${W - M.r}" y1="${y(r.value)}" y2="${y(r.value)}"/><text class="ref-label ${esc(r.cls)}" x="${W - M.r - 2}" y="${y(r.value) - 3}" text-anchor="end">${esc(r.label)}</text>`;
    }
    if (cfg.mode === 'line') {
      if (pts.some((p) => p.lo != null && p.hi != null)) {
        const a = area().defined((/** @type {any} */ p) => p.lo != null && p.hi != null).x(/** @type {any} */ (xs)).y0((/** @type {any} */ p) => ys(p.lo)).y1((/** @type {any} */ p) => ys(p.hi)).curve(curveMonotoneX);
        body += `<path class="range" d="${a(/** @type {any} */ (broken)) ?? ''}"/>`;
      }
      const l = line().defined((/** @type {any} */ p) => p.v != null).x(/** @type {any} */ (xs)).y((/** @type {any} */ p) => ys(p.v)).curve(curveMonotoneX);
      body += `<path class="mean" d="${l(/** @type {any} */ (broken)) ?? ''}"/>`;
      // Isolated points (no neighbour on either side) would be invisible as a line.
      broken.forEach((p, i) => { if (p.v != null && broken[i - 1]?.v == null && broken[i + 1]?.v == null) body += `<circle class="lone" cx="${xs(p)}" cy="${ys(p.v)}" r="2"/>`; });
    } else {
      const r = pts.length > 150 ? 2.5 : 3.5;
      body += pts.filter((p) => p.v != null).map((p) => `<circle class="dot ${esc(p.cls ?? 'none')}" cx="${xs(p)}" cy="${ys(/** @type {number} */ (p.v))}" r="${r}"/>`).join('');
    }
    const fmtT = tickFormat(span);
    const xt = x.ticks(Math.max(2, Math.floor((W - M.l - M.r) / 90)));
    const yt = y.ticks(4);
    const axes = `<g class="axis">${xt.map((/** @type {Date} */ t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${H - M.b}" y2="${H - M.b + 4}"/><text x="${x(t)}" y="${H - 6}" text-anchor="middle">${esc(fmtT(t))}</text>`).join('')}
      ${yt.map((/** @type {number} */ v) => `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${M.l - 6}" y="${y(v) + 4}" text-anchor="end">${esc(num(v, 3))}</text>`).join('')}
      <line x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"/></g>`;
    host.innerHTML = `<div class="tchart-plot" tabindex="0" role="img" aria-label="${esc(cfg.summary)}">
        <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">${axes}${body}
          <g class="cross" hidden><line class="cross-x" y1="${M.t}" y2="${H - M.b}"/><circle class="cross-dot" r="4.5"/></g>
          <rect class="hit" x="${M.l}" y="0" width="${W - M.l - M.r}" height="${H}"/></svg>
        <div class="tchart-tip" hidden></div>
      </div><p class="sr-only" aria-live="polite"></p>`;
    if (idx >= 0) show(idx, false);
  };

  /** @param {number} i @param {boolean} announce */
  const show = (i, announce) => {
    idx = Math.max(0, Math.min(pts.length - 1, i));
    const p = pts[idx];
    const plot = /** @type {HTMLElement} */ (host.querySelector('.tchart-plot'));
    const cross = /** @type {SVGGElement} */ (host.querySelector('.cross'));
    const tip = /** @type {HTMLElement} */ (host.querySelector('.tchart-tip'));
    const px = x(p.t);
    cross.removeAttribute('hidden');
    cross.querySelector('.cross-x')?.setAttribute('x1', String(px));
    cross.querySelector('.cross-x')?.setAttribute('x2', String(px));
    const dot = cross.querySelector('.cross-dot');
    if (p.v != null) { dot?.removeAttribute('hidden'); dot?.setAttribute('cx', String(px)); dot?.setAttribute('cy', String(y(p.v))); } else dot?.setAttribute('hidden', '');
    tip.innerHTML = cfg.describe(p);
    tip.hidden = false;
    const w = tip.offsetWidth || 160;
    tip.style.left = `${Math.max(0, Math.min(W - w, px - w / 2))}px`;
    tip.style.top = `${Math.max(0, (p.v != null ? y(p.v) : M.t) - tip.offsetHeight - 10)}px`;
    if (announce) /** @type {HTMLElement} */ (host.querySelector('[aria-live]')).textContent = tip.innerText.split('\n').filter(Boolean).join('. ');
    plot.classList.toggle('pickable', !!cfg.onPick);
  };
  const hide = () => {
    host.querySelector('.cross')?.setAttribute('hidden', '');
    const tip = /** @type {HTMLElement|null} */ (host.querySelector('.tchart-tip'));
    if (tip) tip.hidden = true;
  };
  const fromEvent = (/** @type {PointerEvent} */ e) => {
    const svg = /** @type {SVGSVGElement} */ (host.querySelector('svg'));
    const r = svg.getBoundingClientRect();
    return nearest(pts, x.invert(((e.clientX - r.left) / r.width) * W).getTime());
  };
  const onMove = (/** @type {Event} */ e) => { if ((/** @type {any} */ (e.target)).closest?.('.tchart-plot')) show(fromEvent(/** @type {PointerEvent} */ (e)), false); };
  const onLeave = (/** @type {Event} */ e) => { if (!host.contains(/** @type {any} */ (e).relatedTarget)) hide(); };
  const onClick = (/** @type {Event} */ e) => { if (cfg.onPick && (/** @type {any} */ (e.target)).closest?.('.tchart-plot')) cfg.onPick(pts[fromEvent(/** @type {PointerEvent} */ (e))]); };
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    const step = e.shiftKey ? 10 : 1;
    const k = { ArrowLeft: idx < 0 ? pts.length - 1 : idx - step, ArrowRight: idx < 0 ? 0 : idx + step, Home: 0, End: pts.length - 1 }[e.key];
    if (k != null) { e.preventDefault(); show(k, true); } else if (e.key === 'Enter' && idx >= 0 && cfg.onPick) cfg.onPick(pts[idx]);
    else if (e.key === 'Escape') hide();
  };
  draw();
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerdown', onMove);
  host.addEventListener('pointerleave', onLeave);
  host.addEventListener('click', onClick);
  host.addEventListener('keydown', onKey);
  host.addEventListener('focusout', onLeave);
  let lastW = W;
  const ro = new ResizeObserver(() => { const w = Math.round(host.clientWidth); if (w && Math.abs(w - lastW) > 4) { lastW = w; draw(); } });
  ro.observe(host);
  return () => { ro.disconnect(); host.removeEventListener('pointermove', onMove); host.removeEventListener('pointerdown', onMove); host.removeEventListener('pointerleave', onLeave); host.removeEventListener('click', onClick); host.removeEventListener('keydown', onKey); host.removeEventListener('focusout', onLeave); };
}

/**
 * Month-by-month stacked bars of samples by result, oldest left. Static SVG with a <title> per month.
 * @param {{ month: string, ok: number, caution: number, danger: number, unknown: number }[]} months @param {number} width
 */
export function monthStrip(months, width) {
  if (!months.length) return '';
  // Fill empty months so gaps in testing show as gaps.
  const all = [];
  const [y0, m0] = months[0].month.split('-').map(Number);
  const [y1, m1] = months[months.length - 1].month.split('-').map(Number);
  const by = new Map(months.map((m) => [m.month, m]));
  for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (y++, m = 1) : m++) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    all.push(by.get(k) ?? { month: k, ok: 0, caution: 0, danger: 0, unknown: 0 });
  }
  const H = 74, top = 8, bottom = 18;
  const max = Math.max(1, ...all.map((m) => m.ok + m.caution + m.danger + m.unknown));
  const bw = (width - 4) / all.length;
  const yv = scaleLinear().domain([0, max]).range([H - bottom, top]);
  const lab = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const bars = all.map((m, i) => {
    let base = H - bottom;
    const segs = /** @type {const} */ ([['danger', m.danger], ['caution', m.caution], ['ok', m.ok], ['none', m.unknown]]).map(([cls, n]) => {
      if (!n) return '';
      const h = (H - bottom) - yv(n);
      base -= h;
      return `<rect class="seg ${cls}" x="${2 + i * bw + 1}" y="${base}" width="${Math.max(1, bw - 2)}" height="${h}"/>`;
    }).join('');
    const total = m.ok + m.caution + m.danger + m.unknown;
    const when = lab.format(new Date(`${m.month}-15T00:00:00Z`));
    const tip = total ? `${when}: ${total} sample${total === 1 ? '' : 's'}, ${m.danger} above permissible, ${m.caution} above acceptable only, ${m.ok} within limits` : `${when}: no samples`;
    return `<g><title>${esc(tip)}</title><rect class="hit" x="${2 + i * bw}" y="0" width="${bw}" height="${H}"/>${segs}</g>`;
  }).join('');
  const every = Math.max(1, Math.ceil(all.length / Math.floor(width / 60)));
  const labels = all.map((m, i) => (i % every ? '' : `<text x="${2 + i * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${esc(lab.format(new Date(`${m.month}-15T00:00:00Z`)).replace(/ (\d{2})(\d{2})$/, ' ’$2'))}</text>`)).join('');
  return `<svg class="month-strip" viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" aria-hidden="true"><g class="axis">${labels}<line x1="2" x2="${width - 2}" y1="${H - bottom}" y2="${H - bottom}"/></g>${bars}</svg>`;
}
