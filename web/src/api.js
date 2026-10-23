// @ts-check
// Thin fetch wrapper: JSON in, JSON out, errors carry the server's plain-words message.

export class ApiError extends Error {
  /** @param {string} message @param {number} status @param {string} [code] */
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

/** @param {string} path @param {RequestInit} [init] */
export async function api(path, init) {
  let res;
  try {
    res = await fetch(`/api${path}`, { ...init, headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  } catch {
    throw new ApiError('This site couldn’t be reached. Check your connection and try again.', 0, 'network');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.message || `The server answered ${res.status}. Try again in a minute.`, res.status, body?.error);
  return body;
}

export const getConfig = () => api('/config');
export const getStations = () => api('/stations');
export const getAreas = () => api('/areas');
export const getHealth = () => api('/health');
/** @param {string} no */
export const getSeries = (no) => api(`/stations/${encodeURIComponent(no)}/series?hours=48`);
/** @param {string} id */
export const getSamples = (id) => api(`/areas/${encodeURIComponent(id)}/samples`);
/** @param {number} lat @param {number} lng @param {number} r */
export const getNearby = (lat, lng, r) => api(`/nearby?lat=${lat}&lng=${lng}&radius_km=${r}`);
/** @param {URLSearchParams} q */
export const getAlerts = (q) => api(`/alerts?${q}`);
export const getLags = () => api('/lags');
export const getDaily = () => api('/dashboard/daily?days=14');
/** @param {string} q */
export const search = (q) => api(`/search?q=${encodeURIComponent(q)}`);
/** @param {{ email: string, lat: number, lng: number, radius_km: number, kinds: string[] }} body */
export const subscribe = (body) => api('/subscriptions', { method: 'POST', body: JSON.stringify(body) });
