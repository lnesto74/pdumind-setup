import assert from 'node:assert/strict';
import {annotationPowerView as view} from './annotationPower.js';
import {aggregateRackPower} from './rackPower.js';
const now=Date.parse('2026-10-14T08:13:19Z');
const rack={pdus:[{id:1,ip:'a',position:'A',hostname:'SIN1-PDU-2NBM04-A'},{id:2,ip:'b',position:'B',hostname:'SIN1-PDU-2NBM04-B'}]};
const sample=(value,extra={})=>({communication:{state:'online'},telemetry:{measured_at:new Date(now).toISOString(),results:[{name:'total_active_power',value}],...extra}});
let evidence={a:sample('0.720kW'),b:{communication:{state:'offline'}}};
let aggregate=aggregateRackPower(rack,evidence,now), result=view(aggregate);
assert.equal(aggregate.verified,false);
assert.equal(aggregate.formattedValue,undefined);
assert.equal(result.total.known,false);
assert.equal(result.partial,true);
assert.deepEqual(result.visible.map(d=>[d.label,d.value,d.unit]),[['A','0.720','kW'],['B','—','']]);
assert.equal(result.coverage,'1/2 live · total —');
// Live changes, including a measured zero, must reach the plaque without reload.
for(const value of ['0.750','0.000']){
 evidence.a=sample(`${value}kW`);
 assert.equal(view(aggregateRackPower(rack,evidence,now)).visible[0].value,value);
}
// Recovery restores the existing aggregate; no partial sum is ever invented.
evidence.b=sample('680W');
result=view(aggregateRackPower(rack,evidence,now));
assert.equal(result.partial,false);assert.equal(result.total.value,'0.680');
// Once the source expires the earlier number must disappear.
result=view(aggregateRackPower(rack,evidence,now+3600000));
assert.equal(result.partial,false);assert.equal(result.known,0);assert.equal(result.total.value,'—');
// A stale source carrying a plausible cached value is not a live reading.
evidence.a=sample('0.720kW',{stale:true});evidence.b={communication:{state:'offline'}};
assert.equal(view(aggregateRackPower(rack,evidence,now)).known,0);
// Reuse existing verified phase-total formatting, including original units.
evidence.a=sample(null);evidence.a.telemetry.results=[{name:'_phase_count',value:'3'},...['l1','l2','l3'].map(p=>({name:`${p}_active_power`,value:'0.240kW'}))];
assert.equal(view(aggregateRackPower(rack,evidence,now)).visible[0].value,'0.720');
// More than two assigned devices: retain actual identities and reveal fresh C.
const many={pdus:[...rack.pdus,{id:3,ip:'c',position:'C',hostname:'Actual third PDU'}]};
result=view(aggregateRackPower(many,{c:sample('123W')},now));
assert.equal(result.devices.length,3);assert.equal(result.visible[0].label,'C');assert.equal(result.visible[0].value,'123');assert.equal(result.coverage,'1/3 live · total —');
console.log('PASS: plaque partial coverage, A live/B missing, live updates, measured zero, recovery, stale readings, phase totals and >2 actual PDUs.');
