// @ts-check
// Limits used to judge readings. Sources and verification notes are in docs/SOURCES.md.

// ---------------------------------------------------------------------------------------------
// Rivers: CPCB "designated best use" primary water-quality criteria (pH, DO, BOD).
// Class B = outdoor bathing; Class C = drinking-water source after conventional treatment.
// ---------------------------------------------------------------------------------------------

/** @type {Record<'B'|'C', Record<string, { min?: number, max?: number }>>} */
export const RIVER_CRITERIA = {
  B: { pH: { min: 6.5, max: 8.5 }, DO: { min: 5 }, BOD: { max: 3 } },
  C: { pH: { min: 6.0, max: 9.0 }, DO: { min: 4 }, BOD: { max: 3 } },
};

export const RIVER_CLASS_LABEL = {
  B: 'Class B (outdoor bathing)',
  C: 'Class C (drinking-water source after conventional treatment)',
};

/** Parameters with no official river limit; these get statistical spike detection instead. */
export const SPIKE_PARAMETERS = ['WTb', 'EC', 'COD', 'TOC', 'Nitrate', 'CL'];

/**
 * @param {string} parameter @param {number} value @param {'B'|'C'} cls
 * @returns {{ violation: boolean, limit: { min?: number, max?: number } } | null} null when no criterion applies
 */
export function riverCheck(parameter, value, cls) {
  const limit = RIVER_CRITERIA[cls]?.[parameter];
  if (!limit) return null;
  const violation = (limit.min != null && value < limit.min) || (limit.max != null && value > limit.max);
  return { violation, limit };
}

/** "≥ 4 mg/l", "≤ 3 mg/l", "6.0–9.0". @param {{ min?: number, max?: number }} limit @param {string|null} [unit] */
export function describeLimit(limit, unit) {
  const u = unit ? ` ${unit}` : '';
  if (limit.min != null && limit.max != null) return `${limit.min}–${limit.max}${u}`;
  if (limit.min != null) return `at least ${limit.min}${u}`;
  if (limit.max != null) return `at most ${limit.max}${u}`;
  return '';
}

// ---------------------------------------------------------------------------------------------
// Taps: BIS IS 10500:2012 drinking-water specification. Only a fallback: the acceptable and
// permissible limits printed on each lab report always win.
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ min?: number, max?: number, absent?: boolean }} Range
 * @typedef {{ label: string, unit: string|null, acceptable: Range, permissible: Range|null, group: 'chemical'|'physical'|'bacteriological', geogenic?: boolean }} TapLimit
 */

/** permissible: null means "no relaxation", i.e. the acceptable limit applies. @type {Record<string, TapLimit>} */
export const BIS_LIMITS = {
  colour: { label: 'Colour', unit: 'Hazen units', acceptable: { max: 5 }, permissible: { max: 15 }, group: 'physical' },
  ph: { label: 'pH', unit: null, acceptable: { min: 6.5, max: 8.5 }, permissible: null, group: 'physical' },
  turbidity: { label: 'Turbidity', unit: 'NTU', acceptable: { max: 1 }, permissible: { max: 5 }, group: 'physical' },
  tds: { label: 'Total dissolved solids', unit: 'mg/l', acceptable: { max: 500 }, permissible: { max: 2000 }, group: 'chemical' },
  hardness: { label: 'Total hardness (as CaCO3)', unit: 'mg/l', acceptable: { max: 200 }, permissible: { max: 600 }, group: 'chemical' },
  alkalinity: { label: 'Total alkalinity (as CaCO3)', unit: 'mg/l', acceptable: { max: 200 }, permissible: { max: 600 }, group: 'chemical' },
  calcium: { label: 'Calcium', unit: 'mg/l', acceptable: { max: 75 }, permissible: { max: 200 }, group: 'chemical' },
  magnesium: { label: 'Magnesium', unit: 'mg/l', acceptable: { max: 30 }, permissible: { max: 100 }, group: 'chemical' },
  chloride: { label: 'Chloride', unit: 'mg/l', acceptable: { max: 250 }, permissible: { max: 1000 }, group: 'chemical' },
  sulphate: { label: 'Sulphate', unit: 'mg/l', acceptable: { max: 200 }, permissible: { max: 400 }, group: 'chemical' },
  fluoride: { label: 'Fluoride', unit: 'mg/l', acceptable: { max: 1.0 }, permissible: { max: 1.5 }, group: 'chemical', geogenic: true },
  nitrate: { label: 'Nitrate (as NO3)', unit: 'mg/l', acceptable: { max: 45 }, permissible: null, group: 'chemical', geogenic: true },
  // Iron: the IS 10500:2012 text says 0.3 mg/l, but every WQMIS lab report prints 1 / No Relaxation. Follow the reports.
  iron: { label: 'Iron', unit: 'mg/l', acceptable: { max: 1.0 }, permissible: null, group: 'chemical' },
  manganese: { label: 'Manganese', unit: 'mg/l', acceptable: { max: 0.1 }, permissible: { max: 0.3 }, group: 'chemical' },
  // Arsenic: the 2012 text gives 0.01 / 0.05. UNVERIFIED: Amendment 1 (2015) may have removed the 0.05 relaxation.
  arsenic: { label: 'Arsenic', unit: 'mg/l', acceptable: { max: 0.01 }, permissible: { max: 0.05 }, group: 'chemical', geogenic: true },
  uranium: { label: 'Uranium', unit: 'mg/l', acceptable: { max: 0.03 }, permissible: null, group: 'chemical', geogenic: true },
  residual_chlorine: { label: 'Free residual chlorine', unit: 'mg/l', acceptable: { min: 0.2 }, permissible: { max: 1 }, group: 'chemical' },
  total_coliform: { label: 'Total coliform', unit: null, acceptable: { absent: true }, permissible: { absent: true }, group: 'bacteriological' },
  e_coli: { label: 'E. coli', unit: null, acceptable: { absent: true }, permissible: { absent: true }, group: 'bacteriological' },
};

/** Map a lab report's parameter name to a canonical key. @param {string} name */
export function canonicalParam(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (/\be ?coli\b|escherichia|thermotolerant|faecal coli|fecal coli/.test(n)) return 'e_coli';
  if (/coliform/.test(n)) return 'total_coliform';
  if (/^ph\b|\bph value\b|\bph\b/.test(n)) return 'ph';
  if (/turbidity/.test(n)) return 'turbidity';
  if (/solids|\btds\b/.test(n)) return 'tds'; // includes WQMIS's "Total dissovled solids" (sic)
  if (/hardness/.test(n)) return 'hardness';
  if (/alkalinity/.test(n)) return 'alkalinity';
  if (/calcium/.test(n)) return 'calcium';
  if (/magnesium/.test(n)) return 'magnesium';
  if (/chloride/.test(n)) return 'chloride';
  if (/sulphate|sulfate/.test(n)) return 'sulphate';
  if (/fluoride/.test(n)) return 'fluoride';
  if (/nitrate/.test(n)) return 'nitrate';
  if (/\biron\b|\bfe\b/.test(n)) return 'iron';
  if (/manganese/.test(n)) return 'manganese';
  if (/arsenic/.test(n)) return 'arsenic';
  if (/uranium/.test(n)) return 'uranium';
  if (/chlorine/.test(n)) return 'residual_chlorine';
  if (/colou?r/.test(n)) return 'colour';
  if (/conductivity/.test(n)) return 'conductivity';
  if (/temperature/.test(n)) return 'temperature';
  return n.replace(/ /g, '_') || 'unknown';
}

/**
 * Parse printed limit text: "6.5-8.5", "1", "0.2 (Min)", "No relaxation", "Shall not be detectable in any 100 ml sample".
 * @param {string|null|undefined} text
 * @returns {Range|'no_relaxation'|null}
 */
export function parseLimitText(text) {
  if (text == null) return null;
  const t = String(text).trim();
  if (!t || /^(-+|na|n\/a|nil)$/i.test(t)) return null;
  if (/no\s*relax/i.test(t)) return 'no_relaxation';
  if (/not\s*(be\s*)?detect|absent|shall not/i.test(t)) return { absent: true };
  const nums = (t.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return null;
  if (nums.length >= 2 && /\d\s*(-|–|to)\s*\d/i.test(t)) return { min: Math.min(nums[0], nums[1]), max: Math.max(nums[0], nums[1]) };
  if (/min/i.test(t)) return { min: nums[0] };
  return { max: nums[0] };
}

/** True when the result says organisms were found. WQMIS prints CFU/100 ml counts ("0.000", "5.000"). @param {string|null|undefined} text */
export function bacteriaPresent(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t) > 0;
  if (/not\s*detect|absent|negative|\bnil\b|-ve|^0$|^<\s*1|not present|^no$|^n$/.test(t)) return false;
  if (/present|detect|positive|\+ve|^yes$|^y$|^\d+(\.\d+)?$/.test(t)) return true;
  return null;
}

/** @param {number} v @param {Range} r */
const outside = (v, r) => (r.min != null && v < r.min) || (r.max != null && v > r.max);

/**
 * Judge one tap result. Printed limits first, BIS fallback second.
 * @param {{ key?: string, parameter?: string, label?: string, value: number|null, value_text?: string|null, acceptable_limit?: string|null, permissible_limit?: string|null }} r
 * @returns {{ key: string, status: 'ok'|'above_acceptable'|'above_permissible'|'unknown', acceptable: Range|null, permissible: Range|null, limits_from: 'report'|'bis'|null }}
 */
export function judgeTapResult(r) {
  const key = r.key ?? canonicalParam(r.parameter ?? r.label ?? '');
  const bis = BIS_LIMITS[key];
  const pa = parseLimitText(r.acceptable_limit);
  const pp = parseLimitText(r.permissible_limit);
  const fromReport = pa != null && pa !== 'no_relaxation';
  /** @type {Range|null} */
  let acceptable = fromReport ? /** @type {Range} */ (pa) : bis ? bis.acceptable : null;
  // Reports print a bare "0.2" for free residual chlorine, which is a minimum, not a maximum.
  if (fromReport && acceptable && bis?.acceptable.min != null && bis.acceptable.max == null && acceptable.max != null && acceptable.min == null) {
    acceptable = { min: acceptable.max };
  }
  /** @type {Range|null} */
  let permissible = pp && pp !== 'no_relaxation' ? pp : null;
  if (!permissible) permissible = pp === 'no_relaxation' ? acceptable : bis ? (bis.permissible ?? bis.acceptable) : acceptable;
  const limits_from = fromReport ? 'report' : bis ? 'bis' : null;

  const isBact = bis?.group === 'bacteriological' || acceptable?.absent;
  if (isBact) {
    const present = bacteriaPresent(r.value_text ?? (r.value != null ? String(r.value) : null));
    return { key, status: present == null ? 'unknown' : present ? 'above_permissible' : 'ok', acceptable, permissible, limits_from };
  }
  if (r.value == null || !Number.isFinite(r.value) || !acceptable) return { key, status: 'unknown', acceptable, permissible, limits_from };
  if (permissible && outside(r.value, permissible)) return { key, status: 'above_permissible', acceptable, permissible, limits_from };
  if (outside(r.value, acceptable)) return { key, status: 'above_acceptable', acceptable, permissible, limits_from };
  return { key, status: 'ok', acceptable, permissible, limits_from };
}

/** Worst of a list of statuses. @param {string[]} statuses */
export function worstStatus(statuses) {
  const order = ['unknown', 'ok', 'above_acceptable', 'above_permissible'];
  let worst = statuses.length ? 'ok' : 'unknown';
  for (const s of statuses) if (order.indexOf(s) > order.indexOf(worst)) worst = s;
  // "unknown" only wins if nothing was judged at all
  if (statuses.length && statuses.every((s) => s === 'unknown')) return 'unknown';
  return worst;
}
