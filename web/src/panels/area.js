// @ts-check
// Panchayat: latest lab sample as report rulers, the date sequence, and earlier samples.
import { scaleLinear } from 'd3-scale';
import { parseLimitText } from '@lt/core/thresholds.js';
import { getSamples } from '../api.js';
import { esc, num, istDate, istTime, ageWords, status, transition } from '../format.js';
import { rowGlyph } from '../map/markers.js';

const LIMIT_SOURCE = {
  report: 'Limits as printed on this lab report (BIS IS 10500:2012).',
  wqmis: 'This report has not been read yet. Limits shown are those printed on other WQMIS lab reports.',
  bis: 'This report has not been read yet. Limits shown are from BIS IS 10500:2012.',
};

/** @param {any} r a wq_result row */
function rulerModel(r) {
  const label = String(r.label || r.parameter);
  const a0 = parseLimitText(r.acceptable_limit);
  const p0 = parseLimitText(r.permissible_limit);
  if ((a0 && a0 !== 'no_relaxation' && a0.absent) || /coli/i.test(label)) return { type: 'presence' };
  /** @type {any} */ let A = a0 && a0 !== 'no_relaxation' ? { ...a0 } : null;
  /** @type {any} */ let P = p0 === 'no_relaxation' ? A : p0 && !p0.absent ? { ...p0 } : A;
  if (r.parameter === 'residual_chlorine' && A?.max != null && A.min == null) A = { min: A.max };
  if (!A || r.value == null) return { type: 'plain' };
  const marks = [r.value, A.min, A.max, P?.min, P?.max].filter((x) => Number.isFinite(x));
  const hasMin = A.min != null;
  const top = Math.max(...marks);
  const lo = hasMin && A.max != null ? Math.min(...marks) - (top - Math.min(...marks)) * 0.35 : 0;
  const hi = top * 1.18 + (top === 0 ? 1 : 0);
  return { type: 'scale', A, P: P ?? A, lo: Math.max(0, lo), hi };
}

/** Short display units: WQMIS prints conductivity as "micromhos per centimeter / microsiemens per centimeter". @param {string|null} u */
const shortUnit = (u) => (!u || /^na$/i.test(u) ? '' : /microsiemens|micromhos/i.test(u) ? 'µS/cm' : u.replace(/\s*\/\s*/g, '/'));

/** @param {any} r */
function ruler(r) {
  const m = rulerModel(r);
  const st = status(r.status);
  const unit = shortUnit(r.unit);
  const value = `<span class="value">${esc(r.value != null ? num(r.value, 3) : r.value_text)}${unit ? `<small>${esc(unit)}</small>` : ''}</span>`;
  if (m.type === 'presence') {
    const detected = r.status === 'above_permissible';
    return `<li class="ruler"><span class="label">${esc(r.label)}</span>${value}
      <svg viewBox="0 0 360 30" preserveAspectRatio="none" aria-hidden="true">
        <rect class="zone-ok" x="0" y="8" width="60" height="12"/><rect class="zone-danger" x="60" y="8" width="300" height="12"/>
        <line class="axis" x1="0" x2="360" y1="20" y2="20"/><line class="tick" x1="60" x2="60" y1="6" y2="22"/>
        <text class="tick-label" x="64" y="30">must not be detectable</text>
        <circle class="marker ${esc(r.status)}" cx="${detected ? 220 : 24}" cy="14" r="6"/>
      </svg>
      <span class="status-word ${st.cls}">${detected ? 'Detected. Shall not be detectable in any 100 ml sample.' : r.status === 'ok' ? 'Not detected' : st.word}</span></li>`;
  }
  if (m.type === 'plain') {
    return `<li class="ruler"><span class="label">${esc(r.label)}</span>${value}<span class="status-word none">No limit printed for this parameter</span></li>`;
  }
  const x = scaleLinear().domain([m.lo, m.hi]).range([0, 360]).clamp(true);
  const { A, P } = m;
  /** @type {[string, number, number][]} */
  const zones = [];
  const z = (/** @type {string} */ cls, /** @type {number} */ a, /** @type {number} */ b) => { if (b > a) zones.push([cls, a, b]); };
  const aMin = A.min ?? m.lo, aMax = A.max ?? m.hi;
  const pMin = P.min ?? (A.min != null && P.max != null && P.min == null ? m.lo : aMin);
  const pMax = P.max ?? aMax;
  z('zone-danger', m.lo, Math.min(pMin, aMin));
  z('zone-caution', Math.min(pMin, aMin), aMin);
  z('zone-ok', aMin, aMax);
  z('zone-caution', aMax, Math.max(pMax, aMax));
  z('zone-danger', Math.max(pMax, aMax), m.hi);
  const ticks = [...new Set([A.min, A.max, P.min, P.max].filter((t) => Number.isFinite(t)))];
  const over = r.value > m.hi;
  return `<li class="ruler"><span class="label">${esc(r.label)}</span>${value}
    <svg viewBox="0 0 360 30" preserveAspectRatio="none" role="img" aria-label="${esc(`${r.label}: ${r.value_text}${unit ? ` ${unit}` : ''}. Acceptable ${r.acceptable_limit ?? 'not printed'}, permissible ${r.permissible_limit ?? 'not printed'}.`)}">
      ${zones.map(([c, a, b]) => `<rect class="${c}" x="${x(a)}" y="8" width="${x(b) - x(a)}" height="12"/>`).join('')}
      <line class="axis" x1="0" x2="360" y1="20" y2="20"/>
      ${ticks.map((t) => `<line class="tick" x1="${x(t)}" x2="${x(t)}" y1="6" y2="22"/><text class="tick-label" x="${x(t)}" y="30" text-anchor="middle">${esc(num(t, 3))}</text>`).join('')}
      <circle class="marker ${esc(r.status)}" cx="${over ? 352 : x(r.value)}" cy="14" r="6"/>
      ${over ? '<path d="M356 9 l4 5 l-4 5" fill="none" stroke="currentColor" stroke-width="1.5"/>' : ''}
    </svg>
    <span class="status-word ${st.cls}">${esc(st.word)}${r.acceptable_limit ? ` (acceptable ${esc(r.acceptable_limit)}${r.permissible_limit ? `, permissible ${esc(r.permissible_limit)}` : ''})` : ''}</span></li>`;
}

/** Gap between two steps. Without the report only dates are known, so say days, never hours. @param {Date} a @param {Date} b @param {boolean} timed */
function gap(a, b, timed) {
  const ms = b.getTime() - a.getTime();
  if (!timed) {
    const days = Math.round(ms / 86400_000);
    return days <= 0 ? 'same day' : days === 1 ? 'next day' : `${ageWords(ms)} later`;
  }
  return ms < 3600_000 ? 'within the hour' : `${ageWords(ms)} later`;
}

/** @param {any} s sample */
function sequence(s) {
  const steps = [
    ['Collected', s.collected_at], ['Reached the lab', s.received_at], ['Analysed', s.analysed_at],
    ['Report generated', s.reported_at], ['First seen here', s.first_seen_at],
  ].filter(([, d]) => d).map(([l, d]) => [l, new Date(d)]);
  return `<ol class="sequence" aria-label="How this sample became public">${steps.map(([l, d], i) => {
    const prev = i ? /** @type {Date} */ (steps[i - 1][1]) : null;
    const hasTime = s.report_fetched_at && l !== 'First seen here';
    return `<li><span>${esc(l)}</span><span><time datetime="${/** @type {Date} */ (d).toISOString()}">${esc(istDate(/** @type {Date} */ (d)))}${hasTime ? `, ${esc(istTime(/** @type {Date} */ (d)))}` : ''}</time>${prev ? ` <small class="note">(${esc(gap(prev, /** @type {Date} */ (d), !!s.report_fetched_at && l !== 'First seen here'))})</small>` : ''}</span></li>`;
  }).join('')}</ol>`;
}

/** @param {any} s */
function verdict(s) {
  const d = s.analysed_at ?? s.collected_at;
  const when = d ? `Last lab test on ${istDate(d)}` : 'Last lab test';
  const bad = s.results.filter((/** @type {any} */ r) => r.status === 'above_permissible').map((/** @type {any} */ r) => r.label);
  const caution = s.results.filter((/** @type {any} */ r) => r.status === 'above_acceptable').map((/** @type {any} */ r) => r.label);
  if (bad.length) return `${when}: ${bad.join(', ')} above the permissible limit.`;
  if (caution.length) return `${when}: ${caution.join(', ')} above the acceptable limit, within the permissible limit.`;
  if (s.worst_status === 'ok') return `${when}: all tested parameters within limits.`;
  return `${when}: results could not be judged against printed limits.`;
}

/** @param {any} s @param {string} reportNote */
function sampleBlock(s, reportNote) {
  const kinds = (s.test_kinds || []).join(' and ') || 'unspecified';
  const where = [s.source_name, s.village_name ? `${s.village_name} village` : null].filter(Boolean).join(', ');
  const src = s.results.find((/** @type {any} */ r) => r.limits_source)?.limits_source ?? 'bis';
  return `
    <p class="verdict">${esc(verdict(s))}</p>
    <p class="sample-meta">${esc(where.charAt(0).toUpperCase() + where.slice(1))}. ${esc(kinds.charAt(0).toUpperCase() + kinds.slice(1))} test${s.lab_name ? ` by ${esc(s.lab_name)}` : ''}. Sample ${esc(s.sample_id)}.</p>
    ${sequence(s)}
    <ul class="rulers">${s.results.map(ruler).join('')}</ul>
    <p class="limits-src">${esc(LIMIT_SOURCE[/** @type {keyof typeof LIMIT_SOURCE} */ (src)] ?? LIMIT_SOURCE.bis)}</p>
    ${s.remedial_remarks ? `<p class="note">Lab’s remedial note: ${esc(s.remedial_remarks)}</p>` : ''}
    ${s.report_url ? `<p><a href="${esc(s.report_url)}" target="_blank" rel="noopener">Open the government lab report</a></p><p class="note">${reportNote}</p>` : ''}`;
}

/** @param {HTMLElement} root @param {any} feature */
export async function renderArea(root, feature) {
  const p = feature.properties;
  const st = status(p.status === 'never' ? 'never' : p.status === 'stale' ? 'stale' : p.latest_round_status);
  const head = `
    <div class="close-row"><p class="kind-line">${rowGlyph('area', st.cls)} Panchayat, Jal Jeevan Mission lab tests</p>
      <button type="button" class="btn-text" data-close>Close</button></div>
    <div class="place-head"><h2>${esc(p.name)}</h2><p class="sub">${esc(p.block)} block, ${esc(p.district)} district</p></div>
    ${p.approximate ? `<p class="approx">Location approximate. ${p.geocode_source === 'block-centroid' ? `OpenStreetMap had no match, so it is drawn at ${esc(p.block)} block’s position.`
      : p.geocode_source === 'nominatim-disputed' ? `More than one village with this name lies near ${esc(p.block)}; this marker may be on the other one.`
        : 'The name matched an OpenStreetMap village only loosely.'}</p>` : ''}
    <p class="here-row"><button type="button" class="btn" data-alerts-here>Get alerts near here</button></p>
    <p class="water-kind tap">These are laboratory tests of rural drinking-water sources such as taps, tubewells and handpumps. Each source is tested once or twice a year at best.</p>`;
  root.innerHTML = `${head}<p class="note">Loading lab results.</p>`;
  let data;
  try { data = await getSamples(p.id); } catch (err) {
    root.innerHTML = `${head}<p class="note">${esc(/** @type {Error} */ (err).message)}</p>`;
    return;
  }
  const reportNote = 'WQMIS shows a report only after its report page has been opened in the same browser. If the link shows an error, open <a href="https://ejalshakti.gov.in/WQMIS/Report/Report_L" target="_blank" rel="noopener">WQMIS reports</a> once, then try again.';
  if (!data.samples.length) {
    root.innerHTML = `${head}<p class="empty">No lab tests published for this panchayat this year. Use “Get alerts near here” to hear when one appears.</p>`;
    return;
  }
  const samples = data.samples;
  // The marker's colour is the worst result in the latest testing round (samples within 30 days of the newest), so say so.
  const t = (/** @type {any} */ x) => new Date(x.analysed_at ?? x.collected_at ?? 0).getTime();
  const newest = t(samples[0]);
  const round = samples.filter((/** @type {any} */ x) => newest - t(x) <= 30 * 86400_000);
  const roundBad = round.filter((/** @type {any} */ x) => x.worst_status === 'above_permissible').length;
  const roundCaution = round.filter((/** @type {any} */ x) => x.worst_status === 'above_acceptable').length;
  const roundLine = round.length > 1
    ? `<p class="round-line">Latest testing round: ${round.length} samples from ${esc(istDate(new Date(t(round[round.length - 1]))))} to ${esc(istDate(new Date(newest)))}. ${roundBad ? `${roundBad} above the permissible limit` : 'None above the permissible limit'}${roundCaution ? `, ${roundCaution} above the acceptable limit only` : ''}. The map marker shows the worst of them.</p>`
    : '';
  const render = (/** @type {number} */ i) => {
    const s = samples[i];
    const others = samples.map((/** @type {any} */ x, j) => ({ x, j })).filter(({ j }) => j !== i);
    root.innerHTML = `${head}
      ${roundLine}
      <h3>${i === 0 ? 'Latest sample' : 'Earlier sample'}</h3>
      ${sampleBlock(s, reportNote)}
      <details class="samples-other"${i ? ' open' : ''}><summary>${i === 0 ? `Earlier samples (${others.length} of ${data.counts.total})` : 'Other samples'}</summary>
        <ol>${others.map(({ x, j }) => `<li><button type="button" class="place-row" data-sample="${j}">${rowGlyph('area', status(x.worst_status).cls)}
          <span class="name">${esc(x.analysed_at ? istDate(x.analysed_at) : x.collected_at ? istDate(x.collected_at) : 'Undated')}</span>
          <span class="dist status-word ${status(x.worst_status).cls}">${esc(status(x.worst_status).word)}</span>
          <span class="meta">${esc([x.source_name, x.village_name].filter(Boolean).join(', '))}</span></button></li>`).join('')}</ol></details>`;
    root.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', () => {
      transition(() => render(Number(/** @type {HTMLElement} */ (b).dataset.sample)));
      root.focus();
    }));
  };
  render(0);
}
