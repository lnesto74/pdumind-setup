export const ALARM_PARAM_LABELS = {
  alarm_l1_voltage: 'Phase L1 Voltage',
  alarm_l1_current: 'Phase L1 Current',
  alarm_l2_voltage: 'Phase L2 Voltage',
  alarm_l2_current: 'Phase L2 Current',
  alarm_l3_voltage: 'Phase L3 Voltage',
  alarm_l3_current: 'Phase L3 Current',
  alarm_neutral: 'Neutral Line',
  alarm_phase_unbalance: 'Phase Unbalance',
  alarm_temp1: 'Temperature Sensor 1',
  alarm_hum1: 'Humidity Sensor 1',
  alarm_temp2: 'Temperature Sensor 2',
  alarm_hum2: 'Humidity Sensor 2',
  alarm_sensor1: 'Door / IO Sensor 1',
  alarm_sensor2: 'IO Sensor 2',
};

/** PDU mount letter + outlet index, e.g. A01 on slot A outlet 1. */
export function formatPduOutletId(mountPosition, outletNum) {
  const slot = String(mountPosition || 'A').trim().toUpperCase().charAt(0) || 'A';
  const n = parseInt(outletNum, 10);
  if (!Number.isFinite(n) || n < 1) return slot;
  return `${slot}${String(n).padStart(2, '0')}`;
}

/** Parse alarm_outlet{N}_load → outlet number or null. */
export function parseOutletLoadAlarmKey(key) {
  const m = /^alarm_outlet(\d+)_load$/.exec(key || '');
  return m ? parseInt(m[1], 10) : null;
}

/** Human label for outlet load-lost alarms with PDU slot + outlet code. */
export function outletLoadAlarmLabel(key, pdu) {
  const outletNum = parseOutletLoadAlarmKey(key);
  if (outletNum == null) return null;
  const code = formatPduOutletId(pdu?.mount_position, outletNum);
  return `Outlet ${code}`;
}

const MOUNT_LATERAL_M = { A: -0.22, B: -0.07, C: 0.07, D: 0.22 };
const U_HEIGHT_M = 0.04445;

/** Estimate hall-floor + rack-U coordinates for an outlet on a PDU. */
export function estimateOutletCoordinates(rackMeta, mountPosition, outletNum, heightU = 42) {
  const mount = String(mountPosition || 'A').trim().toUpperCase().charAt(0) || 'A';
  const lateral = MOUNT_LATERAL_M[mount] ?? 0;
  const x = (rackMeta?.x ?? 0) + lateral;
  const z = rackMeta?.z ?? 0;
  const uSlot = Math.max(1, Math.min(heightU, Math.round((outletNum / 24) * heightU)));
  const y = uSlot * U_HEIGHT_M;
  return {
    x,
    y,
    z,
    u: uSlot,
    row: rackMeta?.rowIndex != null ? rackMeta.rowIndex + 1 : null,
    bay: rackMeta?.positionInRow != null ? rackMeta.positionInRow + 1 : null,
  };
}

function isOutletLoadEntry(entry) {
  if (!entry) return false;
  if (parseOutletLoadAlarmKey(entry.key) != null) return true;
  const v = String(entry.value || '').toLowerCase();
  return v.includes('cable disconnected') || v.includes('unplugged') || v.includes('load lost');
}

function isOutletLoadFlag(flag) {
  return /outlet\d+_load/.test(flag?.param || '');
}

/** Active cable-unplugged warnings with rack / PDU / outlet / coordinates. */
export function collectOutletCableWarnings(hallPDUs, pduAlarms, rackMetaByCode = {}) {
  const warnings = [];
  const seen = new Set();

  for (const pdu of hallPDUs) {
    const alarm = pduAlarms[pdu.ip];
    if (!alarm) continue;

    const rackCode = pdu.rack_code || pdu.location;
    const rackMeta = rackMetaByCode[rackCode] || {};
    const rackLabel = pdu.rack_label || rackMeta.label || rackCode || '—';
    const mount = pdu.mount_position || 'A';

    const process = (outletNum, detail, outletCodeFromFlag) => {
      if (!outletNum || seen.has(`${pdu.ip}:${outletNum}`)) return;
      seen.add(`${pdu.ip}:${outletNum}`);
      const outletCode = outletCodeFromFlag || formatPduOutletId(mount, outletNum);
      const coords = estimateOutletCoordinates(rackMeta, mount, outletNum, rackMeta.heightU);
      warnings.push({
        id: `${pdu.ip}-outlet-${outletNum}`,
        pduIp: pdu.ip,
        pduLabel: pdu.label || pdu.ip,
        mountPosition: mount,
        outletNum,
        outletCode,
        rackCode,
        rackLabel,
        detail: detail || `Cable disconnected — Outlet ${outletCode}`,
        coords,
        coordLabel: `X ${coords.x.toFixed(2)}m · Z ${coords.z.toFixed(2)}m · U${coords.u}`,
        locationLabel: [
          rackLabel,
          `PDU ${mount}`,
          `Outlet ${outletCode}`,
        ].join(' · '),
      });
    };

    for (const entry of alarm.entries || []) {
      if (!isOutletLoadEntry(entry)) continue;
      const outletNum = parseOutletLoadAlarmKey(entry.key);
      if (outletNum != null) process(outletNum, entry.value);
    }

    for (const flag of alarm.flags || []) {
      if (!isOutletLoadFlag(flag)) continue;
      const m = /^outlet(\d+)_load$/.exec(flag.param || '');
      if (m) process(parseInt(m[1], 10), flag.detail || flag.status, flag.outlet_code);
    }
  }

  return warnings;
}

/** Rack-level alert from buildRackAlerts that indicates a cable unplug. */
export function isCableUnplugRackAlert(alert) {
  if (!alert) return false;
  const text = `${alert.title || ''} ${alert.message || ''}`.toLowerCase();
  return text.includes('cable disconnected')
    || text.includes('unplugged')
    || text.includes('load lost');
}

export function cableUnplugAlertKey(alert) {
  const outletM = /Outlet ([A-D]\d{2})/i.exec(`${alert.title || ''} ${alert.message || ''}`);
  const outlet = outletM ? outletM[1].toUpperCase() : '';
  return `${alert.pduIp || alert.pduId || ''}:${alert.rackId || ''}:${outlet}`;
}

export const ALARM_CATEGORY = {
  alarm_l1_voltage: 'Power',
  alarm_l2_voltage: 'Power',
  alarm_l3_voltage: 'Power',
  alarm_l1_current: 'Power',
  alarm_l2_current: 'Power',
  alarm_l3_current: 'Power',
  alarm_neutral: 'Power',
  alarm_phase_unbalance: 'Power',
  alarm_temp1: 'Environment',
  alarm_temp2: 'Environment',
  alarm_hum1: 'Environment',
  alarm_hum2: 'Environment',
  alarm_sensor1: 'Access',
  alarm_sensor2: 'Access',
};

function alarmValueSeverity(value) {
  if (!value || value === '-' || String(value).toLowerCase() === 'normal') return null;
  const v = String(value).toLowerCase();
  if (v.includes('critical') || v === 'open') return 'critical';
  if (v.includes('high') || v.includes('ajar') || v.includes('warning')) return 'warning';
  if (v.includes('load lost') || v.includes('cable disconnected') || v.includes('disconnected') || v.includes('unplugged')) return 'warning';
  return 'warning';
}

export function severityRank(severity) {
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

function formatAlarmMessage(entry, pdu) {
  const outletNum = parseOutletLoadAlarmKey(entry.key);
  if (outletNum != null) {
    const code = formatPduOutletId(pdu?.mount_position, outletNum);
    const rack = pdu?.rack_label || pdu?.rack_code || pdu?.location || '—';
    return `Rack ${rack} · PDU ${pdu?.mount_position || 'A'} · Outlet ${code} — cable disconnected`;
  }
  const label = ALARM_PARAM_LABELS[entry.key] || entry.key.replace(/_/g, ' ');
  return `${label}: ${entry.value}`;
}

function formatFlagMessage(flag, pdu) {
  const param = flag.param || '';
  const outletM = /^outlet(\d+)_load$/.exec(param);
  if (outletM) {
    const code = flag.outlet_code || formatPduOutletId(pdu?.mount_position, outletM[1]);
    const rack = pdu?.rack_label || pdu?.rack_code || pdu?.location || '—';
    return `Rack ${rack} · PDU ${pdu?.mount_position || 'A'} · Outlet ${code} — cable disconnected`;
  }
  const flagKey = param.startsWith('alarm_') ? param : `alarm_${param}`;
  const label = outletLoadAlarmLabel(flagKey, pdu) || ALARM_PARAM_LABELS[flagKey] || param.replace(/_/g, ' ');
  return flag.status ? `${label}: ${flag.status}` : label;
}

export function buildRackAlerts(hallPDUs, pduAlarms) {
  const alerts = [];
  for (const pdu of hallPDUs) {
    const alarm = pduAlarms[pdu.ip];
    if (!alarm) continue;

    const activeEntries = (alarm.entries || []).filter((e) => alarmValueSeverity(e.value));
    const loadFlags = (alarm.flags || []).filter((f) => /outlet\d+_load/.test(f.param || ''));
    if (activeEntries.length === 0 && loadFlags.length === 0 && !(alarm.count > 0)) continue;

    let severity = 'warning';
    const messages = [];
    for (const entry of activeEntries) {
      const sev = alarmValueSeverity(entry.value);
      if (sev === 'critical') severity = 'critical';
      messages.push(formatAlarmMessage(entry, pdu));
    }
    if (messages.length === 0 && loadFlags.length) {
      for (const f of loadFlags) {
        messages.push(formatFlagMessage(f, pdu));
      }
    } else if (messages.length === 0 && alarm.flags?.length) {
      for (const f of alarm.flags) {
        messages.push(formatFlagMessage(f, pdu));
        if (f.param.includes('temp') && f.param.includes('1')) severity = 'critical';
      }
    }

    alerts.push({
      pduId: pdu.id,
      pduIp: pdu.ip,
      pduLabel: pdu.label,
      rackId: pdu.rack_code || pdu.location,
      mountPosition: pdu.mount_position || 'A',
      severity,
      title: messages[0] || `${alarm.count} Active Alarm${alarm.count > 1 ? 's' : ''}`,
      message: messages.join(' · ') || 'Device alarm active',
      category: activeEntries[0] ? (ALARM_CATEGORY[activeEntries[0].key] || 'Outlet') : 'Outlet',
    });
  }
  return alerts.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

export function buildAttentionQueue(hallPDUs, pduAlarms, pduLiveStatus, pduEnv = {}) {
  const items = [];
  for (const pdu of hallPDUs) {
    const alarm = pduAlarms[pdu.ip];
    const online = pduLiveStatus[pdu.ip] === 'online';
    const env = pduEnv[pdu.ip] || {};
    const activeEntries = (alarm?.entries || []).filter((e) => alarmValueSeverity(e.value));
    const loadFlags = (alarm?.flags || []).filter((f) => /outlet\d+_load/.test(f.param || ''));
    const hasAlarm = activeEntries.length > 0 || loadFlags.length > 0 || (alarm?.count > 0);
    if (!hasAlarm && online) continue;

    let severity = 'normal';
    if (!online) severity = 'offline';
    else if (activeEntries.some((e) => alarmValueSeverity(e.value) === 'critical')) severity = 'critical';
    else if (hasAlarm) severity = 'warning';

    let summary = 'Monitoring';
    if (activeEntries[0]) {
      summary = formatAlarmMessage(activeEntries[0], pdu);
    } else if (loadFlags[0]) {
      summary = formatFlagMessage(loadFlags[0], pdu);
    } else if (!online) {
      summary = 'Offline';
    }

    items.push({
      ip: pdu.ip,
      label: pdu.label || pdu.ip,
      rack: pdu.rack_label || pdu.rack_code || pdu.location || '—',
      severity,
      online,
      alarmCount: alarm?.count || activeEntries.length || loadFlags.length,
      temp: env.temp,
      hum: env.hum,
      door: env.door,
      summary,
    });
  }
  return items.sort((a, b) => {
    const sev = severityRank(a.severity) - severityRank(b.severity);
    if (sev !== 0) return sev;
    return (b.alarmCount || 0) - (a.alarmCount || 0);
  });
}

export function extractEnvFromLiveResults(results) {
  if (!results?.length) return {};
  const find = (name) => results.find((r) => r.name === name)?.value?.replace?.(/"/g, '').trim();
  return {
    temp: find('Temperature1'),
    temp2: find('Temperature2'),
    hum: find('Humidity1'),
    door: find('DoorStatus'),
  };
}
