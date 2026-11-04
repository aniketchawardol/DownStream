// @ts-check
// CPCB's real-time stations on the Ganga, upstream to downstream. CPCB doesn't publish river membership or
// order, so this list is curated from station names and positions (see STATION_META in stations.js):
// - Source: the Bhagirathi below Tehri Dam. The Alaknanda stations (Dhari Devi, Kirtinagar) join at
//   Devprayag on a separate branch and are left out to keep one line.
// - Left out as not on the main stem: the Rishikesh distributing canal, the Yamuna (Mathura, Allahabad
//   Sangam), Fatehpur and Auraiya stations (Yamuna side), and tributaries (Ramganga, Ghaghara, Son, Punpun,
//   Gandak, Burhi Gandak, Kosi, Damodar, Hindon).
// - Below Farakka the river splits; the Bhagirathi–Hooghly branch (Nabadwip, Chinsurah) is the one with stations.

/** @type {{ station_no: string, place: string, reach: string }[]} */
export const GANGA_STATIONS = [
  { station_no: 'UK53', place: 'Tehri', reach: 'Bhagirathi' },
  { station_no: 'UK55', place: 'Haridwar', reach: 'Ganga' },
  { station_no: 'UT61', place: 'Narora', reach: 'Ganga' },
  { station_no: 'UT58', place: 'Kanpur (upstream)', reach: 'Ganga' },
  { station_no: 'UT59', place: 'Kanpur (downstream)', reach: 'Ganga' },
  { station_no: 'UT64', place: 'Phaphamau, Allahabad', reach: 'Ganga' },
  { station_no: 'UT65', place: 'Chunar', reach: 'Ganga' },
  { station_no: 'UT66', place: 'Ghazipur', reach: 'Ganga' },
  { station_no: 'BH72', place: 'Chausa', reach: 'Ganga' },
  { station_no: 'BH74', place: 'Buxar', reach: 'Ganga' },
  { station_no: 'BH77', place: 'Patna', reach: 'Ganga' },
  { station_no: 'BH75', place: 'Bhagalpur', reach: 'Ganga' },
  { station_no: 'JH83', place: 'Sahebganj', reach: 'Ganga' },
  { station_no: 'JH84', place: 'Rajmahal', reach: 'Ganga' },
  { station_no: 'WB86', place: 'Farakka', reach: 'Ganga' },
  { station_no: 'WB87', place: 'Nabadwip', reach: 'Hooghly' },
  { station_no: 'WB88', place: 'Chinsurah', reach: 'Hooghly' },
];

/** Great-circle distance in km. @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Distance from the first station, adding straight lines between consecutive stations. The river is
 * longer than this (it meanders), so the UI calls it "station to station in straight lines".
 * @param {{ lat: number, lng: number }[]} pts in river order @returns {number[]}
 */
export function cumulativeKm(pts) {
  /** @type {number[]} */
  const out = [];
  pts.forEach((p, i) => out.push(i ? out[i - 1] + haversineKm(pts[i - 1].lat, pts[i - 1].lng, p.lat, p.lng) : 0));
  return out;
}
