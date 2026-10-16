// Appearance only. Manual opt-in; no customer-name matching or inventory writes.
export const AGODA_PRESET = Object.freeze({
  id: 'agoda-white-racks-black-cage', name: 'Agoda — White Racks / Black Cage',
  base: '/models/agoda-preset/', defaultEnabled: false,
  assets: ['rack', 'cage-panel', 'cage-gate', 'floor-tile', 'tray', 'ceiling'],
});
const finite = value => value !== null && value !== '' && Number.isFinite(Number(value));
export function savedAppearanceLayout(layout, storedRacks) {
  if (!layout || !storedRacks?.length) return layout;
  const saved = new Map(storedRacks.map(r => [r.id, r]));
  return {...layout, racks: layout.racks.map(rack => {
    const row = saved.get(rack.dbRackId);
    if (!row) return rack;
    const position = {...rack.position};
    for (const axis of ['x','y','z']) if (finite(row[`${axis}_m`])) position[axis] = Number(row[`${axis}_m`]);
    const dimensions = {...rack.dimensions};
    for (const key of ['width','depth']) if (finite(row[`${key}_mm`]) && row[`${key}_mm`] > 0) dimensions[key] = row[`${key}_mm`] / 1000;
    const heightU = finite(row.height_u) && row.height_u > 0 ? Number(row.height_u) : rack.heightU;
    if (finite(row.height_u) && row.height_u > 0) dimensions.height = heightU * .04445;
    return {...rack, position, dimensions, heightU, rotationY: finite(row.rotation_deg) ? Number(row.rotation_deg) * Math.PI / 180 : 0};
  })};
}
