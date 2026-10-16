import { isFresh, sourceTime } from './rackStatus.js';

const TOTAL_NAMES = ['total_active_power', 'TotalPower', 'deviceStatusActivePower'];
const PHASE_NAMES = [
  ['l1_active_power', 'MasterPowerP1', 'phase1ActivePower'],
  ['l2_active_power', 'MasterPowerP2', 'phase2ActivePower'],
  ['l3_active_power', 'MasterPowerP3', 'phase3ActivePower'],
];
const WATT_TOLERANCE = 0.5;

function rowsOf(telemetry) {
  const raw = telemetry?.results;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (raw && typeof raw === 'object') return Object.values(raw).filter(Boolean);
  return [];
}

export function parsePower(raw, unitHint) {
  if (raw == null || raw === '') return null;
  const text = String(raw).replace(/"/g, '').trim();
  const match = text.match(/^(-?\d+(?:\.\d+)?)(?:\s*)(kW|W)?$/i);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const embedded = match[2] ? (match[2].toLowerCase() === 'kw' ? 'kW' : 'W') : null;
  const unit = embedded || (unitHint === 'kW' || unitHint === 'W' ? unitHint : null);
  if (!unit) return null;
  return {
    watts: unit === 'kW' ? number * 1000 : number,
    unit,
    text: match[1],
    decimals: (match[1].split('.')[1] || '').length,
  };
}

function readingFrom(row) {
  const parsed = parsePower(row?.value, row?.unit);
  if (!parsed) return null;
  return { ...parsed, name: row.name, measuredAt: sourceTime(row.measured_at ?? row.timestamp) };
}

function collapse(readings) {
  const unique = [];
  for (const reading of readings) {
    if (!unique.some(item => Math.abs(item.watts - reading.watts) <= WATT_TOLERANCE)) unique.push(reading);
  }
  return { readings: unique, conflict: unique.length > 1 };
}

function phaseCount(rows) {
  const raw = rows.find(row => row.name === '_phase_count')?.value;
  const count = parseInt(String(raw ?? '').replace(/"/g, ''), 10);
  if (count === 1 || count === 3) return count;
  const present = name => rows.some(row => row.name === name && row.value != null && String(row.value).trim() !== '');
  if (PHASE_NAMES.slice(1).some(names => names.some(present)) || ['l2_voltage', 'l3_voltage', 'MasterVoltageP2', 'MasterVoltageP3'].some(present)) return 3;
  return null;
}

function blockingFailure(telemetry) {
  if (!telemetry) return false;
  if (telemetry.stale === true || telemetry.authentication === 'failed' || telemetry.reachability === 'offline') return true;
  const text = (telemetry.errors || []).map(item => `${item?.error || ''} ${item?.value || ''} ${item?.name || ''}`).join(' ');
  return /login failed|unreachable|authentication/i.test(text);
}

export function devicePowerReport(telemetry, now = Date.now()) {
  const rows = rowsOf(telemetry);
  const byName = new Map();
  for (const row of rows) if (row?.name && !byName.has(row.name)) byName.set(row.name, row);
  const totals = collapse(TOTAL_NAMES.map(name => readingFrom(byName.get(name))).filter(Boolean));
  const phases = PHASE_NAMES.map(names => collapse(names.map(name => readingFrom(byName.get(name))).filter(Boolean)));
  const count = phaseCount(rows);
  const readings = [];
  totals.readings.forEach(reading => readings.push({ ...reading, role: 'total' }));
  phases.forEach((group, index) => group.readings.forEach(reading => readings.push({ ...reading, role: 'phase', phase: index + 1 })));

  let candidate = null;
  if (!totals.conflict && totals.readings.length === 1) {
    const total = totals.readings[0];
    const phaseWatts = phases.map(group => group.readings[0]).filter(Boolean);
    const equalsPhase = phaseWatts.some(reading => Math.abs(reading.watts - total.watts) <= WATT_TOLERANCE);
    const complete = phaseWatts.length === 3 && phases.every(group => !group.conflict && group.readings.length === 1);
    const sum = complete ? phaseWatts.reduce((sum, reading) => sum + reading.watts, 0) : null;
    const equalsSum = sum != null && Math.abs(sum - total.watts) <= Math.max(WATT_TOLERANCE, Math.abs(total.watts) * 0.02);
    const copiedPhase = equalsPhase && !equalsSum && (count === 3 || (count !== 1 && phaseWatts.length > 0));
    if (!copiedPhase) candidate = total;
  } else if (!totals.readings.length && count === 1 && !phases[0].conflict && phases[0].readings.length === 1 && phases.slice(1).every(group => !group.readings.length)) {
    candidate = phases[0].readings[0];
  } else if (!totals.readings.length && count === 3 && phases.every(group => !group.conflict && group.readings.length === 1)) {
    const watts = phases.reduce((sum, group) => sum + group.readings[0].watts, 0);
    const decimals = Math.max(...phases.map(group => group.readings[0].decimals));
    candidate = {
      watts,
      unit: phases.every(group => group.readings[0].unit === 'W') ? 'W' : 'kW',
      text: null,
      decimals,
      name: 'phase_sum',
      measuredAt: phases.map(group => group.readings[0].measuredAt).filter(time => time != null).sort((a, b) => a - b)[0] ?? null,
    };
  }

  const measuredAt = sourceTime(telemetry?.measured_at) ?? candidate?.measuredAt ?? null;
  const fresh = !!candidate && !blockingFailure(telemetry) && isFresh(measuredAt, now);
  return { candidate, readings, measuredAt, fresh, watts: fresh ? candidate.watts : null };
}

function formatAggregate(parts) {
  const totals = parts.map(part => part.candidate);
  const sameText = totals.length === 1 && totals[0].text && (totals[0].unit === 'kW' || totals[0].unit === 'W');
  if (sameText) return { formattedValue: totals[0].text, unit: totals[0].unit };
  const watts = totals.reduce((sum, total) => sum + total.watts, 0);
  const decimals = Math.min(3, Math.max(...totals.map(total => total.decimals || 0), 0));
  const unit = totals.every(total => total.unit === 'W') ? 'W' : 'kW';
  const value = unit === 'W' ? watts : watts / 1000;
  return { formattedValue: value.toFixed(decimals), unit };
}

/** Verified rack total: one fresh device total per assigned PDU, after unit,
 * three-phase and alias checks. Missing, stale or partial coverage is not a total. */
export function aggregateRackPower(rack, evidence = {}, now = Date.now()) {
  const seen = new Set();
  const devices = [];
  for (const pdu of rack?.pdus || []) {
    const ip = pdu?.ip || pdu?.ip_address;
    if (!ip || seen.has(ip)) continue;
    seen.add(ip);
    const data = evidence[ip] || {};
    const report = devicePowerReport(data.telemetry, now);
    const disconnected = data.communication?.state === 'offline' || data.telemetry?.reachability === 'offline';
    const verified = report.fresh && !disconnected && !data.telemetryUnavailable;
    devices.push({
      id: pdu.dbId ?? pdu.id ?? ip,
      ip,
      name: pdu.hostname || pdu.label || ip,
      slot: pdu.position || pdu.mount_position || '',
      verified,
      stale: !verified,
      watts: verified ? report.watts : null,
      // Reuse the verified formatter for individual readings when rack coverage is incomplete.
      ...(verified ? formatAggregate([{candidate: report.candidate}]) : {}),
      candidate: report.candidate,
      readings: report.readings,
      measuredAt: report.measuredAt,
    });
  }
  const complete = devices.length > 0 && devices.every(device => device.verified && device.candidate);
  const formatted = complete ? formatAggregate(devices) : {};
  return {
    verified: complete,
    stale: !complete,
    formattedValue: formatted.formattedValue,
    unit: formatted.unit,
    devices,
  };
}
