// @ts-check

/** Great-circle distance in km. @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0088;
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Point offset by a distance (km) along a bearing (degrees). @param {number} lat @param {number} lng @param {number} km @param {number} bearingDeg */
export function offsetPoint(lat, lng, km, bearingDeg) {
  const R = 6371.0088;
  const r = Math.PI / 180;
  const d = km / R;
  const b = bearingDeg * r;
  const la1 = lat * r;
  const lo1 = lng * r;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: la2 / r, lng: lo2 / r };
}

/** Rough check that a point lies within India's bounding box. @param {number} lat @param {number} lng */
export function inIndia(lat, lng) {
  return lat >= 6 && lat <= 37.6 && lng >= 68 && lng <= 97.5;
}

/** Parse 'minLng,minLat,maxLng,maxLat'; null when invalid. @param {string|undefined} s */
export function parseBbox(s) {
  if (!s) return null;
  const p = s.split(',').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null;
  const [w, so, e, n] = p;
  if (w < -180 || e > 180 || so < -90 || n > 90 || w >= e || so >= n) return null;
  return { w, s: so, e, n };
}
