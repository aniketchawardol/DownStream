// @ts-check
// Short display names for CPCB's 40 real-time stations. CPCB's own names are long and inconsistent
// ("UK55_D/s of Har Ki Pauri, Dam Kothi, Haridwar"), so the site uses a short place, plus the river
// only where the station name says it or the location leaves no doubt. Unknown rivers stay null and
// the UI says "river water at {place}" instead of guessing.

/** @type {Record<string, { place: string, river: string|null }>} */
export const STATION_META = {
  BH72: { place: 'Chausa', river: 'Ganga' },
  BH73: { place: 'Manjhi, Chhapra', river: 'Ghaghara' },
  BH74: { place: 'Buxar', river: 'Ganga' },
  BH75: { place: 'Bhagalpur', river: 'Ganga' },
  BH76: { place: 'Fatuha, Patna', river: 'Punpun' },
  BH77: { place: 'Patna', river: 'Ganga' },
  BH78: { place: 'Khagaria', river: 'Burhi Gandak' },
  BH79: { place: 'Kursela', river: 'Kosi' },
  BH80: { place: 'Arrah', river: 'Son' },
  BH81: { place: 'Hajipur', river: 'Gandak' },
  HR56: { place: 'Mohana, Sonipat', river: null },
  JH82: { place: 'Pathardih', river: 'Damodar' },
  JH83: { place: 'Sahebganj', river: 'Ganga' },
  JH84: { place: 'Rajmahal', river: 'Ganga' },
  UK51: { place: 'Dhari Devi', river: 'Alaknanda' },
  UK52: { place: 'Kirtinagar', river: 'Alaknanda' },
  UK53: { place: 'Tehri', river: 'Bhagirathi' },
  UK54: { place: 'Rishikesh canal', river: null },
  UK55: { place: 'Haridwar', river: 'Ganga' },
  UT57: { place: 'Rajnagar Extension, Ghaziabad', river: 'Hindon' },
  UT58: { place: 'Kanpur', river: 'Ganga' },
  UT59: { place: 'Shuklaganj, Kanpur', river: 'Ganga' },
  UT60: { place: 'Mathura', river: 'Yamuna' },
  UT61: { place: 'Narora', river: 'Ganga' },
  UT62: { place: 'Kashipur', river: 'Kosi' },
  UT63: { place: 'Allahabad', river: 'Yamuna' },
  UT64: { place: 'Phaphamau, Allahabad', river: 'Ganga' },
  UT65: { place: 'Chunar', river: 'Ganga' },
  UT66: { place: 'Ghazipur', river: 'Ganga' },
  UT67: { place: 'Pratapgarh', river: null },
  UT68: { place: 'Asothar, Fatehpur', river: null },
  UT69: { place: 'Auraiya', river: null },
  UT70: { place: 'Amauli, Fatehpur', river: null },
  UT71: { place: 'Beladandi Bridge', river: 'Ramganga' },
  WB85: { place: 'Raghunathpur', river: null },
  WB86: { place: 'Farakka', river: 'Ganga' },
  WB87: { place: 'Nabadwip', river: 'Hooghly' },
  WB88: { place: 'Chinsurah', river: 'Hooghly' },
  WB89: { place: 'Durgapur', river: 'Damodar' },
  WB90: { place: 'Ramgarh', river: 'Damodar' },
};

/**
 * Display meta for any station, falling back to the text after the code prefix.
 * @param {string} stationNo @param {string} [rawName]
 */
export function stationMeta(stationNo, rawName = '') {
  const known = STATION_META[stationNo];
  if (known) return known;
  const clean = rawName.replace(/^[A-Z]{2}\d+_/, '').trim();
  const river = clean.match(/\bRiver\s+([A-Z][a-z]+)/)?.[1] ?? null;
  const place = clean.split(',').map((s) => s.trim()).filter(Boolean).pop() || stationNo;
  return { place, river };
}

/** "UK55_D/s of Har Ki Pauri, Dam Kothi, Haridwar" -> "D/s of Har Ki Pauri, Dam Kothi, Haridwar". @param {string} raw */
export const cleanStationName = (raw) => (raw || '').replace(/^[A-Z]{2}\d+_/, '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/[.\s]+$/, '').trim();
