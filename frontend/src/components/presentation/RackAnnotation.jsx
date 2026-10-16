import React from 'react';
import {RACK_STATES} from '../../utils/rackStatus';
import {annotationPowerView} from '../../utils/annotationPower';
/** Dynamic adaptation of PX TwinCanvas campus-label; no telemetry aggregation here. */
export default function RackAnnotation({name,status,selected=false,detail=true,power,onSelect,onHover}){
 const state=RACK_STATES[status.state]||RACK_STATES.unknown;
 const view=annotationPowerView(power),reading=view.total;
 const description=view.partial
   ? `${view.devices.map(d=>`${d.name || d.label}: ${d.value} ${d.unit}`).join(' · ')} · ${view.coverage}`
   : `${reading.value} ${reading.unit}${reading.known?'':' · Verified rack power unavailable'}`;
 return <button type="button" className={`px-rack-annotation ${selected?'is-selected':''} ${detail?'':'is-distant'}`} data-testid="rack-status-label" data-level={detail?'label':'icon'} data-state={status.state} data-power-coverage={view.partial?'incomplete':reading.known?'complete':'unavailable'} aria-pressed={selected} aria-label={`${name} · ${state.label} · ${description}${status.disconnected?' · Disconnected':''}`} title={`${name} · ${state.label} · ${description}`} onClick={e=>{e.stopPropagation();onSelect();}} onPointerEnter={()=>onHover(true)} onPointerLeave={()=>onHover(false)} onFocus={()=>onHover(true)} onBlur={()=>onHover(false)}>
   <span className={`px-status-strip state-${status.state}`} style={{'--status-color':state.color}}/>
   {detail&&<strong className="px-rack-name">{name}</strong>}
   {detail&&view.partial ? <>
     {view.visible.map(device=>{
       const statusDevice=status.devices?.find(d=>d.ip===device.ip || d.id===device.id);
       const deviceState=RACK_STATES[statusDevice?.state]||RACK_STATES.unknown;
       return <span className="px-rack-reading px-rack-device-reading" key={device.id} title={device.name}>
         <span className="px-state-symbol" style={{color:deviceState.color}}>{deviceState.icon}</span>
         <span className="px-rack-slot">{device.label}</span><span className="px-rack-number">{device.value}</span><small>{device.unit}</small>
       </span>;
     })}
     <span className="px-rack-coverage">{view.coverage}</span>
   </> : <span className="px-rack-reading"><span className="px-state-symbol" style={{color:state.color}}>{state.icon}</span>{detail&&<><span className="px-rack-number">{reading.value}</span><small>{reading.unit}</small></>}{status.disconnected&&<span className="px-disconnected" title="Lost communication">⊘</span>}</span>}
   {detail&&(view.partial||['warning','critical'].includes(status.state))&&<span className="px-rack-state" style={{color:state.color}}>{state.icon} {state.label}{status.disconnected&&<span className="px-disconnected" title="Lost communication"> · ⊘</span>}</span>}
 </button>;
}
