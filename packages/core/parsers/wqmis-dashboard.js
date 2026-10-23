// @ts-check
// National and state-wise daily dashboards (POST Main/GetMainDashboard, Main/GetMainDashboard_samples_tested_laboratories).
// "Yesterday" figures roll over daily, so one snapshot per day builds the history the source doesn't keep.

const MAIN_FIELDS = ['total_laboratories', 'total_tested', 'total_village_test_complete', 'contaminated', 'ftk_testing',
  'total_village_ftk_test_complete', 'contaminated_ftk', 'Villages_trained_ftk', 'total_tested_yesterday',
  'contaminated_yesterday', 'ftk_testing_yesterday', 'contaminated_ftk_yesterday'];

/** @param {unknown} v */
const n = (v) => { const x = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : null; };

/** @param {unknown} json */
export function parseMainDashboard(json) {
  const o = /** @type {any} */ (Array.isArray(json) ? json[0] : json);
  if (!o || typeof o !== 'object') return { data: null, warnings: ['main dashboard is not an object'] };
  /** @type {Record<string, number|null>} */
  const data = {};
  for (const k of MAIN_FIELDS) data[k] = n(o[k]);
  const warnings = data.total_tested_yesterday == null ? ['main dashboard has no total_tested_yesterday'] : [];
  return { data, warnings };
}

/** @param {unknown} json */
export function parseStateDashboard(json) {
  if (!Array.isArray(json)) return { states: [], warnings: ['state dashboard is not an array'] };
  const states = json.filter((s) => s && typeof s === 'object' && s.StateName).map((s) => ({
    state_id: n(s.StateId),
    name: String(s.StateName).replace(/&amp;/g, '&').trim(),
    laboratories: n(s.totallaboratories),
    received_yesterday: n(s.sample_received_lab_yesterday),
    received: n(s.sample_received_lab),
    tested_yesterday: n(s.sample_tested_Yesterday ?? s.sample_tested_yesterday),
    tested: n(s.sample_tested),
    contaminated: n(s.sample_contaminated ?? s.Samples_found_contaminated),
    contaminated_yesterday: n(s.Samples_found_contaminated_yesterday),
    ftk_tests_yesterday: n(s.Number_FTK_test_done_yesterday),
    ftk_tests: n(s.Number_FTK_test_done),
    villages_ftk_complete: n(s.total_village_ftk_test_complete),
  }));
  return { states, warnings: states.length ? [] : ['state dashboard has no states'] };
}
