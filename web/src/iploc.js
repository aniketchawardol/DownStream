// @ts-check
// Approximate location from the internet connection, for laptops and desktops that can't locate themselves
// (no GPS, and Wi-Fi positioning off or unavailable). City level at best: Indian IP geolocation is often tens
// of kilometres out, so callers say so. The lookup goes from the browser straight to the provider, which sees
// the IP address; nothing is sent to DownStream's server.

/** @typedef {{ lat: number, lng: number, city: string, region: string, country: string, source: string }} IpPlace */

/** @type {[string, string, (j: any) => Omit<IpPlace, 'source'> | null][]} */
const PROVIDERS = [
  ['ipapi.co', 'https://ipapi.co/json/', (j) => (j.error ? null : { lat: Number(j.latitude), lng: Number(j.longitude), city: j.city, region: j.region, country: j.country_code })],
  ['ipwho.is', 'https://ipwho.is/', (j) => (j.success === false ? null : { lat: Number(j.latitude), lng: Number(j.longitude), city: j.city, region: j.region, country: j.country_code })],
];

/** First provider with a city-level answer; a country-level guess (no city) is worse than asking. @returns {Promise<IpPlace|null>} */
export async function ipLocation() {
  for (const [source, url, pick] of PROVIDERS) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const p = pick(await r.json());
      if (p && p.city && Number.isFinite(p.lat) && Number.isFinite(p.lng)) return { ...p, source };
    } catch { /* try the next provider */ }
  }
  return null;
}
