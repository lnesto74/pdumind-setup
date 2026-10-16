import assert from 'node:assert/strict';
import { aggregateRackPower, devicePowerReport, parsePower } from './rackPower.js';

const now = Date.parse('2026-10-14T07:00:00Z');
const pdu = (ip, slot) => ({ id: slot, ip, position: slot, hostname: `PDU-${slot}` });
const row = (name, value, unit) => ({ name, value, unit, measured_at: new Date(now).toISOString() });
const live = (results, extra = {}) => ({ telemetry: { results, measured_at: new Date(now).toISOString(), stale: false, authentication: 'ok', reachability: 'online', ...extra }, communication: { state: 'online', probedAt: now } });

assert.equal(parsePower('0.720kW').watts, 720);
assert.equal(parsePower('360', 'W').unit, 'W');
assert.equal(parsePower('360'), null);

const sample = [
  row('total_active_power', '0.720kW'),
  row('TotalPower', '0.720kW'),
  row('MasterPowerP1', '0.360kW'),
  row('l1_active_power', '0.360kW'),
  row('_phase_count', '3'),
];
const one = devicePowerReport({ results: sample, measured_at: new Date(now).toISOString(), stale: false, authentication: 'ok' }, now);
assert.equal(one.fresh, true);
assert.equal(one.watts, 720);
assert.equal(one.readings.filter(item => item.role === 'total').length, 1);

const rack = { id: '415', pdus: [pdu('10.0.0.1', 'A'), pdu('10.0.0.2', 'B'), pdu('10.0.0.1', 'A')] };
const reading = aggregateRackPower(rack, {
  '10.0.0.1': live(sample),
  '10.0.0.2': live([row('total_active_power', '680W'), row('MasterPowerP1', '200W'), row('_phase_count', '3')]),
}, now);
assert.equal(reading.verified, true);
assert.equal(reading.unit, 'kW');
assert.equal(reading.formattedValue, '1.400');

const phaseOnly = aggregateRackPower({ pdus: [pdu('10.0.0.1', 'A')] }, {
  '10.0.0.1': live([row('MasterPowerP1', '0.360kW'), row('_phase_count', '3')]),
}, now);
assert.equal(phaseOnly.verified, false);
assert.equal(phaseOnly.formattedValue, undefined);
assert.equal(phaseOnly.devices[0].readings[0].text, '0.360');

const summedPhases = aggregateRackPower({ pdus: [pdu('10.0.0.1', 'A')] }, {
  '10.0.0.1': live([row('l1_active_power', '0.360kW'), row('l2_active_power', '0.180kW'), row('l3_active_power', '0.180kW'), row('_phase_count', '3')]),
}, now);
assert.equal(summedPhases.verified, true);
assert.equal(summedPhases.formattedValue, '0.720');

const copied = aggregateRackPower({ pdus: [pdu('10.0.0.1', 'A')] }, {
  '10.0.0.1': live([row('total_active_power', '0.360kW'), row('MasterPowerP1', '0.360kW'), row('l2_voltage', '230V'), row('_phase_count', '3')]),
}, now);
assert.equal(copied.verified, false);

const partial = aggregateRackPower(rack, {
  '10.0.0.1': live(sample),
  '10.0.0.2': live(sample, { measured_at: new Date(now - 120000).toISOString(), stale: true, authentication: 'failed', reachability: 'offline', errors: [{ error: 'PDU login failed after 5 retries' }] }),
}, now);
assert.equal(partial.verified, false);
assert.ok(partial.devices.find(device => device.slot === 'A').verified);
assert.equal(partial.devices.find(device => device.slot === 'B').verified, false);
assert.equal(partial.devices.find(device => device.slot === 'B').readings[0].text, '0.720');

const unitless = aggregateRackPower({ pdus: [pdu('10.0.0.1', 'A')] }, {
  '10.0.0.1': live([row('total_active_power', '720')]),
}, now);
assert.equal(unitless.verified, false);

const single = aggregateRackPower({ pdus: [pdu('10.0.0.1', 'A')] }, {
  '10.0.0.1': live([row('MasterPowerP1', '180W'), row('_phase_count', '1')]),
}, now);
assert.equal(single.verified, true);
assert.equal(single.formattedValue, '180');
assert.equal(single.unit, 'W');

console.log('PASS: units, three-phase total, phase-only, alias duplicates, partial B, unitless and single-phase.');
