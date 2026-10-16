// Assignment occupancy is separate from electrical status. Uses existing slot conventions.
export const deviceName = p => [p?.label,p?.hostname,p?.ip_address].find(v=>typeof v==='string' && v.trim() && !/\{[^}]+\}/.test(v)) || '—';
export function slotIds(config) {
  const n = Number(config?.pdu?.pdusPerRack ?? 2);
  if (!Number.isInteger(n) || n < 1 || n > 26) return [];
  return Array.from({length:n},(_,i)=>(config?.pdu?.mounting || 'A/B') === 'A/B' ? String.fromCharCode(65+i) : String(i+1));
}
export function occupants(data, rackId, position) {
  return data.pdus.filter(p => String(p.rack_id) === String(rackId) && (p.mount_position || 'A') === position);
}
export function validateAssignment(data, ip, rackId, position) {
  const matches=data.pdus.filter(p=>p.ip_address===ip);
  if(matches.length!==1) return 'Device is missing or its address is not unique. Refresh the library.';
  if(rackId==null) return null;
  if(!data.racks.some(r=>String(r.id)===String(rackId))) return 'Rack no longer exists in this hall.';
  if(!slotIds(data.config).includes(position)) return 'This mounting position is not configured.';
  if(occupants(data,rackId,position).some(p=>p.ip_address!==ip)) return `Slot ${position} is occupied. Move or remove its device first.`;
  return null;
}
export function applyAssignment(data,ip,rackId,position) {
  const rack=data.racks.find(r=>String(r.id)===String(rackId));
  return {...data,pdus:data.pdus.map(p=>p.ip_address===ip ? {...p,rack_id:rackId,rack_code:rack?.rack_code || null,mount_position:position || p.mount_position}:p)};
}
export function assignmentResult(json,ip) {
  const item=json?.results?.find(r=>r.ip===ip);
  if(!json?.success || !item?.success) throw new Error(item?.error || json?.error || 'Assignment was not confirmed by the server.');
}
// Normalized illustration mapping, deliberately not a claim of physical installation coordinates.
// Callers can supply a reviewed mapping by slot ID. Default keeps the equipment centre clear.
export function slotZones(ids, mapping={}) {
  const tiers=Math.ceil(ids.length/4), height=.82/tiers;
  const xs=ids.length<=2?[.17,.71]:[.16,.29,.59,.72];
  return ids.map((id,i)=>({id,...(mapping[id] || {x:xs[i%xs.length],y:.09+Math.floor(i/4)*height,w:.12,h:height-.01})}));
}
