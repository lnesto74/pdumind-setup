import assert from 'node:assert/strict';import {annotationPowerText as display} from './annotationPower.js';
for(const r of [null,{}, {value:11600}, {verified:true,stale:true,formattedValue:'11.6',unit:'kW'}, {verified:false,stale:false,formattedValue:'11.6',unit:'kW'}, {verified:true,formattedValue:'11.6',unit:'kW'}])assert.deepEqual(display(r),{value:'—',unit:'',known:false});
for(const [value,unit] of [['0.0','kW'],['11.600','kW'],['1098.1','W']])assert.deepEqual(display({verified:true,stale:false,formattedValue:value,unit}),{value,unit,known:true});
assert.equal(display({devices:[{power:6000},{power:6000}]}).value,'—');
console.log('PASS: annotation never aggregates device rows, never invents power, preserves verified zero, unit and precision, hides stale/unverified values.');
