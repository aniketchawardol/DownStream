// @ts-check
// wq_area helpers shared by the WQMIS and geocoding jobs.

/**
 * @param {import('@lt/core/db.js').Sql} sql
 * @param {'district'|'block'|'gp'|'village'} level
 * @param {{ jjm_id: string, name: string, name_raw: string }} item
 * @param {string|number|bigint|null} parentId @param {number} stateId
 * @returns {Promise<string>} area id
 */
export async function upsertArea(sql, level, item, parentId, stateId) {
  const [row] = await sql`
    insert into wq_area (level, jjm_id, parent_id, state_id, name, name_raw, crawled_at)
    values (${level}, ${item.jjm_id}, ${parentId == null ? null : String(parentId)}, ${stateId}, ${item.name}, ${item.name_raw}, now())
    on conflict (level, jjm_id) do update set
      parent_id = excluded.parent_id, state_id = excluded.state_id, name = excluded.name, name_raw = excluded.name_raw, crawled_at = now()
    returning id`;
  return String(row.id);
}

/** GPs (with their block and district) for the configured districts. @param {import('@lt/core/db.js').Sql} sql @param {string[]} districtIds */
export async function gpsInScope(sql, districtIds) {
  return sql`
    select g.id, g.jjm_id, g.name, g.state_id, g.tested_counts, g.samples_fetched_at,
           b.id as block_area_id, b.jjm_id as block_jjm, b.name as block_name,
           d.id as district_area_id, d.jjm_id as district_jjm, d.name as district_name
    from wq_area g
    join wq_area b on b.id = g.parent_id and b.level = 'block'
    join wq_area d on d.id = b.parent_id and d.level = 'district'
    where g.level = 'gp' and d.jjm_id = any(${districtIds})
    order by d.jjm_id, b.name, g.name`;
}
