export const STATUS_FRESH_MS = 90000;
export const RACK_STATES = {
  no_pdu: { label: 'NO PDU', icon: '+', color: '#9aa2ac', description: 'No PDU assigned; other rack equipment may be present.' },
  unknown: { label: 'UNKNOWN', icon: '?', color: '#8d9fad', description: 'Assigned power state is incomplete, stale or unverified.' },
  off: { label: 'OFF', icon: '⏻', color: '#9198a2', description: 'Every assigned PDU is confirmed off.' },
  on: { label: 'ON', icon: '✓', color: '#90bd9c', description: 'Every assigned PDU is confirmed on, without active alarms.' },
  partial: { label: 'PARTIAL', icon: '◐', color: '#90bd9c', description: 'Confirmed on and off PDUs in this rack.' },
  warning: { label: 'WARNING', icon: '⚠', color: '#d5ab65', description: 'Verified active warning.' },
  critical: { label: 'CRITICAL', icon: '!', color: '#d67d7a', description: 'Verified active critical alarm.' },
};
export const STATUS_FILTERS = [['all','All'],['no_pdu','No PDU'],['on','On'],['off','Off'],['partial','Partial'],['unknown','Unknown'],['issues','Issues']];
export function sourceTime(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function isFresh(timestamp, now = Date.now()) {
  const time = sourceTime(timestamp);
  return time != null && now - time >= -5000 && now - time <= STATUS_FRESH_MS;
}
const cleaned = v => String(v ?? '').replace(/"/g,'').trim().toLowerCase();
// Deliberately excludes current, zero voltage, outlet status, reachability and device metadata.
// These do not establish the whole PDU's confirmed power state.
export function readPowerEvidence(raw = {}) {
  const row = (Array.isArray(raw.results) ? raw.results : []).find(r => ['PowerState','InputPowerState','PduPowerState'].includes(r.name) && !r.error);
  const value = cleaned(raw.power_state ?? raw.powerState ?? row?.value);
  return {
    state: value === 'on' || value === 'off' ? value : 'unknown',
    timestamp: sourceTime(raw.power_updated_at ?? row?.timestamp ?? raw.measured_at ?? raw.collected_at ?? raw.ts_utc ?? raw.updated_at ?? raw.timestamp),
    verified: raw.power_verified !== false && !row?.error,
  };
}
function alarmSeverity(item) {
  const value = cleaned(item.severity ?? item.value ?? item.status);
  if (/critical|\btrip(?:ped)?\b/.test(value) || value === 'open') return 'critical';
  if (/warning|high|low|ajar|load lost|disconnected|unplugged/.test(value)) return 'warning';
  return null;
}
function isResolved(a) { return a.active === false || !!a.resolved_at || /^(resolved|cleared|normal|ok|inactive|off|0|-)$/.test(cleaned(a.status ?? a.value)); }
export function mergeCommunicationEvidence(previous = {}, incoming) {
  if (incoming) return incoming;
  // A failed request is not evidence of recovery. Preserve the last disconnection
  // and its timestamp, but do not renew the freshness of a failed response.
  return {...previous, state: previous.state === 'offline' ? 'offline' : 'unknown', unavailable: true};
}
function deviceStatus(pdu, data, now) {
  const raw = data?.telemetry || {};
  const power = readPowerEvidence(raw);
  const communication = data?.communication || {};
  // Receipt freshness applies ONLY to the reachability response, never to cached measurements.
  const commFresh = !communication.unavailable && isFresh(communication.receivedAt, now);
  const comm = commFresh && ['online','offline'].includes(communication.state) ? communication.state : 'unknown';
  const disconnected = communication.state === 'offline';
  const fresh = !data?.telemetryUnavailable && power.verified && isFresh(power.timestamp, now) && !disconnected && !raw.errors?.length;
  const state = fresh ? power.state : 'unknown';
  const sourceTimestamp = sourceTime(raw.measured_at ?? raw.collected_at ?? raw.ts_utc ?? raw.updated_at ?? raw.timestamp);
  const rawAlarms = Array.isArray(raw.alarms) ? raw.alarms : data?.alarms?.entries || [];
  const flags = data?.alarms?.flags || [];
  const all = [...rawAlarms,...flags].filter(a => !isResolved(a)).map(a => {
    const severity = alarmSeverity(a);
    const timestamp = sourceTime(a.timestamp ?? a.ts_utc ?? a.ts ?? sourceTimestamp);
    // Individual explicit active alarms may remain verified even if another PDU loses communication.
    const active = !data?.telemetryUnavailable && !!severity && a.stale !== true && isFresh(timestamp, now) && !raw.errors?.length && (comm !== 'offline' || a.active === true);
    return { severity, timestamp, active, summary: a.message || a.detail || `${a.key || a.param || 'Alarm'}: ${a.value || a.status || severity}`, key: a.id || a.key || a.param };
  }).filter(a=>a.severity);
  if (!all.length && data?.alarms?.count > 0) all.push({severity:'warning',timestamp:sourceTimestamp,active:!data?.telemetryUnavailable&&isFresh(sourceTimestamp,now)&&comm!=='offline'&&!raw.errors?.length,summary:`${data.alarms.count} reported alarms`,key:'reported'});
  const alarms = all.filter((a,i)=>all.findIndex(b=>b.key===a.key && b.summary===a.summary)===i);
  const active = alarms.filter(a=>a.active);
  const main = active.some(a=>a.severity==='critical') ? 'critical' : active.length ? 'warning' : state;
  return { id:pdu.dbId ?? pdu.id ?? pdu.ip, name:pdu.hostname || pdu.label || pdu.ip || pdu.id, slot:pdu.position || pdu.mount_position, ip:pdu.ip,
    power:state, state:main, communication:comm, communicationUpdated:sourceTime(communication.timestamp), disconnected,
    timestamp:power.timestamp ?? sourceTimestamp, stale:!fresh || state==='unknown', alarms, lastKnownPower:power.state };
}
export function aggregateRackStatus(rack, evidence = {}, now = Date.now()) {
  const devices=(rack.pdus || []).map(pdu=>deviceStatus(pdu,evidence[pdu.ip],now));
  const active=devices.flatMap(p=>p.alarms.filter(a=>a.active));
  let state='no_pdu';
  if(devices.length){
    if(active.some(a=>a.severity==='critical'))state='critical';
    else if(active.length)state='warning';
    else if(devices.some(p=>p.power==='unknown'))state='unknown';
    else if(devices.every(p=>p.power==='on'))state='on';
    else if(devices.every(p=>p.power==='off'))state='off';
    else state='partial';
  }
  const times=devices.map(p=>p.timestamp).filter(t=>t!=null);
  const disconnected=devices.some(p=>p.disconnected);
  const stale=devices.some(p=>p.stale);
  return {state,devices,disconnected,stale,activeAlarms:active,lastKnownAlarms:devices.flatMap(p=>p.alarms.filter(a=>!a.active)),
    communication: !devices.length?'Not applicable':disconnected?'Disconnected':devices.every(p=>p.communication==='online')?'Online':'Unknown',
    timestamp:times.length===devices.length && times.length?Math.min(...times):null,
    issues:disconnected || active.length>0 || devices.some(p=>p.alarms.some(a=>!a.active))};
}
export function matchesRackFilter(status, filter) {return filter==='all' || (filter==='issues'?status.issues:status.state===filter);}
export function rackStatusCounts(statuses) {return Object.fromEntries(STATUS_FILTERS.map(([key])=>[key,Object.values(statuses).filter(s=>matchesRackFilter(s,key)).length]));}
export function formatStatusTime(ts) {return ts==null?'Not provided by source':new Date(ts).toISOString().replace('T',' ').replace(/\.\d{3}Z$/, ' UTC');}
