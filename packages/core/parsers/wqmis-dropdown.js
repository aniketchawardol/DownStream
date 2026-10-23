// @ts-check
// Hierarchy dropdown responses: JSON arrays whose first item is a "--Select--" placeholder.

export const DROPDOWN_FIELDS = /** @type {const} */ ({
  district: { id: 'JJM_DistrictId', name: 'DistrictName' },
  block: { id: 'JJM_BlockId', name: 'BlockName' },
  gp: { id: 'JJM_PanchayatId', name: 'PanchayatName' },
  village: { id: 'JJM_VillageId', name: 'VillageName' },
});

/** "KULAGERI CROSS" -> "Kulageri Cross"; mixed-case names are left alone. @param {string} s */
export function displayName(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t !== t.toUpperCase() || !/[A-Z]/.test(t)) return t;
  return t.toLowerCase().replace(/(^|[\s\-(/.])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

/**
 * @param {unknown} json @param {keyof typeof DROPDOWN_FIELDS} level
 * @returns {{ items: { jjm_id: string, name: string, name_raw: string }[], warnings: string[] }}
 */
export function parseDropdown(json, level) {
  const f = DROPDOWN_FIELDS[level];
  if (!Array.isArray(json)) return { items: [], warnings: [`${level} dropdown is not a JSON array`] };
  const items = [];
  let missing = 0;
  for (const o of json) {
    if (!o || typeof o !== 'object') continue;
    const id = o[f.id];
    const name = o[f.name];
    // Placeholder IDs seen: " " (districts), "" (blocks, GPs), 0 (villages).
    if (id == null || !String(id).trim() || String(id).trim() === '0' || /--\s*select\s*--/i.test(String(name))) continue;
    if (typeof name !== 'string' || !name.trim()) { missing++; continue; }
    items.push({ jjm_id: String(id).trim(), name: displayName(name), name_raw: name.trim() });
  }
  return { items, warnings: missing ? [`${missing} ${level} items without a name`] : [] };
}
