// @ts-check
// One small observable store. Panels read from it and re-render on change.

/**
 * @typedef {{ kind: 'station'|'area'|'sim', id: string } | null} Selection
 * @typedef {{
 *   config: any, stations: any[], areas: any[], health: any,
 *   viewer: { lat: number, lng: number } | null,
 *   pin: { lat: number, lng: number } | null,
 *   radius: number,
 *   selected: Selection,
 * }} State
 */

/** @type {State} */
export const state = {
  config: null, stations: [], areas: [], health: null,
  viewer: null, pin: null, radius: 10, selected: null,
};

/** @type {Map<string, Set<(s: State) => void>>} */
const subs = new Map();

/** @param {keyof State | '*'} key @param {(s: State) => void} fn */
export function on(key, fn) {
  if (!subs.has(key)) subs.set(key, new Set());
  /** @type {Set<any>} */ (subs.get(key)).add(fn);
}

/** @param {Partial<State>} patch */
export function set(patch) {
  Object.assign(state, patch);
  const fired = new Set();
  for (const k of [...Object.keys(patch), '*']) for (const fn of subs.get(k) ?? []) if (!fired.has(fn)) { fired.add(fn); fn(state); }
}

/** Find a station or panchayat feature by selection. @param {Selection} sel */
export function findSelected(sel) {
  if (!sel) return null;
  if (sel.kind === 'station') return state.stations.find((f) => f.properties.station_no === sel.id) ?? null;
  if (sel.kind === 'area') return state.areas.find((f) => f.properties.id === sel.id) ?? null;
  if (sel.kind === 'sim') {
    const s = state.config?.mock?.subjects;
    return [...(s?.stations ?? []), ...(s?.gps ?? [])].find((x) => x.id === sel.id) ?? null;
  }
  return null;
}
