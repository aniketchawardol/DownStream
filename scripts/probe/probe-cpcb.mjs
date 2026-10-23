// @ts-check
// Live probe of the CPCB real-time water-quality portal (KISTERS web portal static export).
// Usage: node scripts/probe/probe-cpcb.mjs        (saves raw responses to fixtures/cpcb/)
import { request, save } from './lib.mjs';

const HOST = 'https://rtwqmsdb1.cpcb.gov.in';
const DATA = `${HOST}/data/internet`;
let insecure = process.env.CPCB_INSECURE_TLS === 'true';

/** GET with normal TLS verification first; fall back to insecure for this host only on a cert error. */
async function get(url) {
  try {
    return await request(url, { insecure });
  } catch (e) {
    const code = /** @type {any} */ (e).code || '';
    if (!insecure && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)) {
      console.warn(`  WARN TLS verification failed for ${HOST} (${code}); retrying insecurely for this host only`);
      insecure = true;
      return request(url, { insecure });
    }
    throw e;
  }
}

async function getJson(url, fixture) {
  const res = await get(url);
  console.log(`${res.status} ${url} (${res.body.length} B)`);
  if (res.status !== 200) return null;
  if (fixture) save(fixture, res.body);
  return JSON.parse(res.text);
}

const t = Date.now();
console.log('# CPCB layer 10 (latest value per station x parameter)');
const layer = await getJson(`${DATA}/layers/10/index.json?t=${t}`, 'cpcb/layer10.json');
if (layer) {
  const stations = new Map();
  for (const o of layer) stations.set(o.station_no, Math.max(stations.get(o.station_no) || 0, Date.parse(o.timestamp)));
  const stale = [...stations].filter(([, ts]) => t - ts > 3 * 3600e3).map(([s, ts]) => `${s} (${Math.round((t - ts) / 3600e3)} h)`);
  console.log(`  ${layer.length} objects, ${stations.size} stations; stale > 3 h: ${stale.join(', ') || 'none'}`);
  console.log(`  parameters: ${[...new Set(layer.map((o) => `${o.stationparameter_name} [${o.ts_unitsymbol}]`))].join(', ')}`);
}

console.log('\n# Station metadata, quality layers');
await getJson(`${DATA}/stations/stations.json`, 'cpcb/stations.json');
await getJson(`${DATA}/layers/20/index.json`, 'cpcb/layer20-qualified-hours.json');
await getJson(`${DATA}/layers/21/index.json`, 'cpcb/layer21-station-coverage.json');

console.log('\n# Per-station history files: stations/<site_no>/<station_no>/<stationparameter_no>/{week,year}.json');
await getJson(`${DATA}/stations/DSP_SWAN/UT67/pH/week.json`, 'cpcb/week-UT67-pH.json');
await getJson(`${DATA}/stations/DSP_SWAN/UT67/DO/week.json`, 'cpcb/week-UT67-DO.json');
await getJson(`${DATA}/stations/DSP_SWAN/WB90/DO/week.json`, 'cpcb/week-WB90-DO-stale.json');
const year = await getJson(`${DATA}/stations/DSP_SWAN/UT67/DO/year.json`, 'cpcb/year-UT67-DO.json');
if (year) console.log(`  year.json: ${year[0].rows} rows, columns ${year[0].columns}, ${year[0].data[0]?.[0]} .. ${year[0].data.at(-1)?.[0]}`);

console.log('\n# Paths that do not exist (expected 404)');
for (const p of ['stations/DSP_SWAN/UT67/pH/day.json', 'stations/DSP_SWAN/UT67/pH/month.json', 'stations/DSP_SWAN/UT67/pH/complete.json', 'layers/11/index.json']) {
  const r = await get(`${DATA}/${p}`);
  console.log(`${r.status} ${p}`);
}
console.log(`\nTLS mode used: ${insecure ? 'INSECURE (rejectUnauthorized=false)' : 'verified'}`);
