// @ts-check
// Alert kinds (section 7) and the four plain-language subscription choices they belong to.

/** @typedef {'urgent'|'notice'|'info'} Severity */
/** @typedef {'river'|'tap'|'overdue'|'digest'} Group */

/** @type {Record<string, { severity: Severity, group: Group, source: 'cpcb'|'wqmis', label: string }>} */
export const ALERT_KINDS = {
  river_threshold: { severity: 'urgent', group: 'river', source: 'cpcb', label: 'River reading outside its limit' },
  river_recovered: { severity: 'info', group: 'river', source: 'cpcb', label: 'River reading back within its limit' },
  river_spike: { severity: 'notice', group: 'river', source: 'cpcb', label: 'Unusual river reading' },
  river_station_silent: { severity: 'info', group: 'river', source: 'cpcb', label: 'River station stopped reporting' },
  tap_contamination: { severity: 'urgent', group: 'tap', source: 'wqmis', label: 'Tap-water lab test above the permissible limit' },
  tap_caution: { severity: 'notice', group: 'tap', source: 'wqmis', label: 'Tap-water lab test above the acceptable limit' },
  tap_all_clear: { severity: 'info', group: 'tap', source: 'wqmis', label: 'Tap-water lab test within limits' },
  tap_overdue: { severity: 'notice', group: 'overdue', source: 'wqmis', label: 'Area overdue for a lab test' },
  regional_geogenic: { severity: 'notice', group: 'tap', source: 'wqmis', label: 'Rock-derived contaminant found nearby' },
};

/** The subscribe form's choices, in its own words. */
export const SUBSCRIPTION_GROUPS = /** @type {const} */ ({
  river: 'A river reading crosses a safe limit',
  tap: 'A new tap-water test fails',
  overdue: 'An area near me is overdue for testing',
  digest: 'A weekly summary',
});

export const ALL_GROUPS = /** @type {Group[]} */ (Object.keys(SUBSCRIPTION_GROUPS));

/** @param {string} kind */
export const kindInfo = (kind) => ALERT_KINDS[kind] ?? { severity: 'info', group: 'digest', source: 'cpcb', label: kind };
