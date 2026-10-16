/** Presentation only: consume verified formatted readings, never sum device rows. */
export function annotationPowerText(reading) {
  if (!reading || reading.verified !== true || reading.stale !== false || typeof reading.formattedValue !== 'string' || !reading.formattedValue.trim() || !['kW','W'].includes(reading.unit)) return {value:'—',unit:'',known:false};
  return {value:reading.formattedValue,unit:reading.unit,known:true};
}

/** Incomplete coverage must not hide a fresh PDU reading or imply a rack total. */
export function annotationPowerView(power) {
  const total=annotationPowerText(power);
  const devices=(power?.devices || []).map(device=>({
    id:device.id, ip:device.ip, name:device.name, label:device.slot || device.name || device.ip,
    ...annotationPowerText(device),
  }));
  const known=devices.filter(device=>device.known).length;
  const partial=!total.known && known>0;
  // Keep a known reading visible even when it is not in the first two slots.
  const visible=partial ? [...devices.filter(d=>d.known),...devices.filter(d=>!d.known)].slice(0,2) : [];
  return {total,devices,known,partial,visible,coverage:`${known}/${devices.length} live · total —`};
}
