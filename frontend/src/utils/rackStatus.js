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
const VOLTAGE_NAMES = ['l1_voltage','MasterVoltageP1','phase1Voltage'];
function voltageOn(results) {
  const row = (Array.isArray(results) ? results : []).find(r => VOLTAGE_NAMES.includes(r.name) && !r.error);
  if (!row) return null;
  const n = parseFloat(String(row.value ?? '').replace(/"/g,''));
  // A live line voltage means the feed is energised. Zero is not proof it is off.
  return Number.isFinite(n) && n >= 50 ? row : null;
}
// Current, zero voltage, outlet status and reachability alone do not confirm power.
export function readPowerEvidence(raw = {}) {
  const row = (Array.isArray(raw.results) ? raw.results : []).find(r => ['PowerState','InputPowerState','PduPowerState'].includes(r.name) && !r.error);
  let value = cleaned(raw.power_state ?? raw.powerState ?? row?.value);
  let stamp = row?.timestamp;
  let fromVoltage = false;
  if (value !== 'on' && value !== 'off') {
    const volt = voltageOn(raw.results);
    if (volt) { value = 'on'; stamp = volt.timestamp ?? volt.measured_at; fromVoltage = true; }
  }
  const sample = sourceTime(raw.measured_at ?? raw.collected_at);
  const rowTime = sourceTime(raw.power_updated_at ?? stamp);
  return {
    state: value === 'on' || value === 'off' ? value : 'unknown',
    timestamp: sample ?? rowTime ?? sourceTime(raw.ts_utc ?? raw.updated_at ?? raw.timestamp),
    verified: raw.power_verified !== false && !row?.error,
    fromVoltage,
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
  if (!incoming) {
    // A failed request is not evidence of recovery. Preserve the last disconnection
    // and its timestamp, but do not renew the freshness of a failed response.
    return {...previous, state: previous.state === 'offline' ? 'offline' : 'unknown', unavailable: true};
  }
  const nextTs = sourceTime(incoming.probedAt ?? incoming.timestamp);
  const prevTs = sourceTime(previous.probedAt ?? previous.timestamp);
  if (nextTs == null || (prevTs != null && nextTs < prevTs)) return previous;
  const next = {...incoming};
  delete next.receivedAt;
  return next;
}
function blockingSample(raw) {
  if (raw.stale === true || raw.authentication === 'failed') return true;
  const text = (raw.errors || []).map(item => `${item?.error || ''} ${item?.value || ''} ${item?.name || ''}`).join(' ');
  return /login failed|unreachable|authentication/i.test(text);
}
export function mergeDeviceEvidence(previous = {}, incoming) {
  if (!incoming) return previous;
  if (incoming.failed && !incoming.telemetry) return {...previous, telemetryUnavailable: true};
  const prevTel = previous.telemetry || {};
  const nextTel = incoming.telemetry;
  if (!nextTel) return {...previous, telemetryUnavailable: !!incoming.failed};
  const prevAttempt = sourceTime(prevTel.last_attempt_at ?? prevTel.measured_at);
  const nextAttempt = sourceTime(nextTel.last_attempt_at ?? nextTel.measured_at);
  if (prevAttempt != null && nextAttempt != null && nextAttempt < prevAttempt) return previous;
  const prevMeasured = sourceTime(prevTel.measured_at);
  const nextMeasured = sourceTime(nextTel.measured_at);
  if (prevMeasured != null && nextMeasured != null && nextMeasured < prevMeasured) {
    return {
      ...previous,
      telemetry: {
        ...prevTel,
        stale: nextTel.stale !== false,
        authentication: nextTel.authentication ?? prevTel.authentication,
        reachability: nextTel.reachability ?? prevTel.reachability,
        errors: nextTel.errors ?? prevTel.errors,
        last_attempt_at: nextTel.last_attempt_at ?? prevTel.last_attempt_at,
        status: nextTel.status ?? prevTel.status,
      },
      alarms: previous.alarms,
      telemetryUnavailable: false,
    };
  }
  return {...previous, telemetry: nextTel, alarms: incoming.alarms ?? previous.alarms, telemetryUnavailable: !!incoming.failed};
}
export function retainHallEvidence(previous, ips) {
  const allow = ips instanceof Set ? ips : new Set(ips);
  return Object.fromEntries(Object.entries(previous || {}).filter(([ip]) => allow.has(ip)));
}
function deviceStatus(pdu, data, now) {
  const raw = data?.telemetry || {};
  const power = readPowerEvidence(raw);
  const communication = data?.communication || {};
  const sampleStale = blockingSample(raw);
  // Probe time belongs to reachability. It is not a measurement time.
  const commFresh = !communication.unavailable && isFresh(communication.probedAt ?? communication.timestamp, now);
  const comm = commFresh && ['online','offline'].includes(communication.state) ? communication.state : 'unknown';
  const disconnected = communication.state === 'offline';
  const powerTimestamp = power.timestamp;
  const fresh = !data?.telemetryUnavailable && !sampleStale && power.verified && isFresh(powerTimestamp, now) && !disconnected;
  const state = fresh ? power.state : 'unknown';
  const sourceTimestamp = sourceTime(raw.measured_at ?? raw.collected_at ?? raw.ts_utc ?? raw.timestamp);
  const rawAlarms = Array.isArray(raw.alarms) ? raw.alarms : data?.alarms?.entries || [];
  const flags = data?.alarms?.flags || [];
  const all = [...rawAlarms,...flags].filter(a => !isResolved(a)).map(a => {
    const severity = alarmSeverity(a);
    const timestamp = sourceTime(a.timestamp ?? a.measured_at ?? a.ts_utc ?? a.ts ?? sourceTimestamp);
    // Individual explicit active alarms may remain verified even if another PDU loses communication.
    const active = !data?.telemetryUnavailable && !sampleStale && !!severity && a.stale !== true && isFresh(timestamp, now) && (comm !== 'offline' || a.active === true);
    return { severity, timestamp, active, summary: a.message || a.detail || `${a.key || a.param || 'Alarm'}: ${a.value || a.status || severity}`, key: a.id || a.key || a.param };
  }).filter(a=>a.severity);
  if (!all.length && data?.alarms?.count > 0) all.push({severity:'warning',timestamp:sourceTimestamp,active:!data?.telemetryUnavailable&&!sampleStale&&isFresh(sourceTimestamp,now)&&comm!=='offline',summary:`${data.alarms.count} reported alarms`,key:'reported'});
  const alarms = all.filter((a,i)=>all.findIndex(b=>b.key===a.key && b.summary===a.summary)===i);
  const active = alarms.filter(a=>a.active);
  const main = active.some(a=>a.severity==='critical') ? 'critical' : active.length ? 'warning' : state;
  return { id:pdu.dbId ?? pdu.id ?? pdu.ip, name:pdu.hostname || pdu.label || pdu.ip || pdu.id, slot:pdu.position || pdu.mount_position, ip:pdu.ip,
    power:state, state:main, communication:comm, communicationUpdated:sourceTime(communication.probedAt ?? communication.timestamp), disconnected,
    timestamp:powerTimestamp ?? sourceTimestamp, stale:!fresh || state==='unknown', alarms, lastKnownPower:power.state };
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
