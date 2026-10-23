// @ts-check
// Weekly: districts -> blocks -> panchayats -> villages for the configured districts, upserted into wq_area.
import { config } from '@lt/core/config.js';
import { logger } from '@lt/core/log.js';
import { WqmisClient } from '../lib/wqmis.js';
import { runSource, SchemaError } from '../lib/source.js';
import { upsertArea } from '../lib/areas.js';
import { oneShot } from '../lib/one-shot.js';

const log = logger('wqmis-hierarchy');

/** @param {import('@lt/core/db.js').Sql} sql @param {WqmisClient} [client] */
export async function hierarchyCycle(sql, client = new WqmisClient()) {
  const counts = { districts: 0, blocks: 0, gps: 0, villages: 0 };
  /** @type {string[]} */
  const warnings = [];
  await client.session();
  for (const st of config.wqmisStates) {
    const d = await client.districts(st);
    warnings.push(...d.warnings);
    if (!d.items.length) throw new SchemaError(`state ${st}: no districts in dropdown`);
    /** @type {Map<string, string>} */
    const districtIds = new Map();
    for (const di of d.items) { districtIds.set(di.jjm_id, await upsertArea(sql, 'district', di, null, st)); counts.districts++; }
    for (const dt of config.wqmisDistricts.filter((x) => districtIds.has(x))) {
      const blocks = await client.blocks(st, dt);
      warnings.push(...blocks.warnings);
      for (const b of blocks.items) {
        const bid = await upsertArea(sql, 'block', b, districtIds.get(dt) ?? null, st);
        counts.blocks++;
        const gps = await client.gps(st, dt, b.jjm_id);
        warnings.push(...gps.warnings);
        for (const g of gps.items) {
          const gid = await upsertArea(sql, 'gp', g, bid, st);
          counts.gps++;
          try {
            const vs = await client.villages(st, dt, b.jjm_id, g.jjm_id);
            for (const v of vs.items) { await upsertArea(sql, 'village', v, gid, st); counts.villages++; }
          } catch (err) {
            warnings.push(`villages for GP ${g.jjm_id}: ${/** @type {Error} */ (err).message}`);
          }
        }
        log.info('block crawled', { block: b.name, gps: gps.items.length });
      }
    }
  }
  if (!counts.gps) throw new SchemaError('hierarchy crawl found no panchayats');
  return { records: counts.gps, notes: { ...counts, ...(warnings.length ? { warnings: warnings.slice(0, 20) } : {}) } };
}

/** @param {import('@lt/core/db.js').Sql} sql */
export const hierarchyJob = (sql) => runSource(sql, 'wqmis-hierarchy', () => hierarchyCycle(sql));

/** One-shot entrypoint (services/worker/run-once.js, used by GitHub Actions). */
export async function run() {
  return oneShot((sql) => hierarchyJob(sql));
}
