import plaqueAnchors from './rackPlaqueAnchors.json';
import RackAnnotation from '../presentation/RackAnnotation';
import {annotationPowerView} from '../../utils/annotationPower';
import React, { useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { Batch } from './IndustrialViewport';
import { layoutStatusTooltip } from '../../utils/statusTooltipLayout';
import { RACK_STATES, STATUS_FILTERS, rackStatusCounts, formatStatusTime } from '../../utils/rackStatus';

const plaqueGeometry = new THREE.PlaneGeometry(.32, .095);
const plaqueMaterials = new Map();
function plaqueMaterial(state, disconnected) {
  const key = `${state}:${disconnected}`;
  if (plaqueMaterials.has(key)) return plaqueMaterials.get(key);
  const {color,icon}=RACK_STATES[state];
  const c=document.createElement('canvas');c.width=384;c.height=114;
  const x=c.getContext('2d');x.fillStyle='#252b31';x.fillRect(0,0,384,114);
  x.strokeStyle='#60676e';x.lineWidth=3;x.strokeRect(2,2,380,110);
  x.fillStyle=color;
  if(state==='no_pdu'){ for(let i=15;i<365;i+=44)x.fillRect(i,14,25,7); }
  else { x.fillRect(15,14,354,7);if(state==='partial'){x.fillStyle='#9198a2';x.fillRect(192,14,177,7);} }
  x.fillStyle=color;x.font='bold 61px sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillText(icon,192,69);
  if(disconnected){x.strokeStyle='#c3c9cf';x.lineWidth=5;x.beginPath();x.moveTo(317,57);x.lineTo(333,73);x.moveTo(343,83);x.lineTo(359,99);x.moveTo(353,54);x.lineTo(317,96);x.stroke();}
  const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;
  const material=new THREE.MeshBasicMaterial({map:texture,toneMapped:false});
  plaqueMaterials.set(key,material);return material;
}
const statusColor=state=>RACK_STATES[state]?.color || RACK_STATES.unknown.color;
export function RackStatusDetails({ rack, status, power, compact=false }) {
  if(!status)return null;
  return <div data-testid="rack-status-details" style={{color:'#dce1e7',fontSize:compact?11:12,lineHeight:1.45}}>
    <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:7}}><strong>{rack.label || rack.rackCode || rack.id}</strong><span style={{color:statusColor(status.state),marginLeft:'auto'}}>{RACK_STATES[status.state].icon} {RACK_STATES[status.state].label}</span></div>
    {status.state==='no_pdu' && <p style={{color:'#a7b0ba'}}>No PDU assigned. Other equipment may be present.</p>}
    {status.devices.map(device=><div key={device.id} style={{padding:'5px 0',borderTop:'1px solid #ffffff12'}}>
      <div style={{display:'flex',gap:8}}><span title={device.name} style={{minWidth:0,overflowWrap:'anywhere',whiteSpace:'normal',flex:1}}>{device.slot ? `PDU ${device.slot} · `:''}{device.name}</span><strong style={{color:statusColor(device.state),flexShrink:0}}>{RACK_STATES[device.state]?.label || 'UNKNOWN'}</strong></div>
      <div style={{color:'#9da8b4',fontSize:9}}>Power · {device.power.toUpperCase()} · {device.disconnected?'⊘ Disconnected':`Communication · ${device.communication}`} · {device.stale?'Unverified / stale':'Verified power'}{device.stale && device.lastKnownPower!=='unknown'?` · last known ${device.lastKnownPower.toUpperCase()}`:''}</div>
      {!compact && <div style={{color:'#8895a2',fontSize:9}}>Updated · {formatStatusTime(device.timestamp)}</div>}
      {(power?.devices||[]).filter(item=>item.ip===device.ip||item.id===device.id).flatMap(item=>(item.readings||[]).map((reading,index)=><div key={`${reading.name}-${index}`} style={{color:'#9da8b4',fontSize:9}}>{reading.role==='phase'?`L${reading.phase} phase`:'Total'} · {reading.text} {reading.unit} · {item.verified && reading.role==='total'?'verified':'not a live rack total'} · {formatStatusTime(reading.measuredAt||item.measuredAt)}</div>))}
      {device.alarms.map((alarm,i)=><div key={`${alarm.key}-${i}`} style={{color:alarm.active?statusColor(alarm.severity):'#9da8b4',fontSize:9,marginTop:3}}>{alarm.active?'Active':'Last known / stale'} · {alarm.summary}<br/>{formatStatusTime(alarm.timestamp)}</div>)}
    </div>)}
    <div style={{marginTop:7,paddingTop:6,borderTop:'1px solid #ffffff18',color:'#adb8c2'}}>Communication · {status.disconnected?'⊘ ':''}{status.communication}</div>
    <div style={{color:'#8f9ba8',fontSize:9}}>Updated · {formatStatusTime(status.timestamp)}</div>
    {status.stale && <div style={{color:'#9ca7b3',fontSize:9}}>Power freshness or confirmation unavailable; no OFF inference.</div>}
    {power && power.verified!==true && <div style={{color:'#9ca7b3',fontSize:9}}>Rack total unavailable · {annotationPowerView(power).known}/{power.devices?.length || 0} PDU readings verified.</div>}
  </div>;
}

export function RackStatusLegend({statuses,filter,onFilter,loading=false}) {
  const [expanded,setExpanded]=useState(false);const counts=rackStatusCounts(statuses);
  const assigned=Object.values(statuses).filter(s=>s.devices.length);
  const assignedPdus=new Set(assigned.flatMap(s=>s.devices.map(d=>d.id))).size;
  if(loading)return <div className="absolute z-20 top-3 left-3 rounded-lg border border-white/10 bg-[#161c23]/95 px-3 py-2 text-[11px] text-slate-300" role="status">Loading rack assignments…</div>;
  return <div className="absolute z-20 top-3 left-3 max-w-[calc(100%-1.5rem)] rounded-lg border border-white/10 bg-[#161c23]/95 px-3 py-2 shadow-lg" style={{width:272}} aria-label="Rack status filters">
    <div className="flex justify-between items-center mb-2"><span className="text-[10px] font-semibold uppercase tracking-wider text-slate-300">Rack status</span><button className="text-[9px] text-slate-400 hover:text-white" onClick={()=>setExpanded(v=>!v)} aria-expanded={expanded}>Legend {expanded?'−':'+'}</button></div>
    <div className="text-[11px] text-slate-300 mb-2">{assignedPdus} assigned PDUs · {assigned.length} racks</div>
    <div className="flex flex-wrap gap-1">{STATUS_FILTERS.map(([key,label])=><button key={key} aria-pressed={filter===key} onClick={()=>onFilter(key)} className={`rounded px-2 py-1 text-[9px] border ${filter===key?'bg-slate-600/50 border-slate-400 text-white':'border-white/10 text-slate-400 hover:text-white'}`}>{label} <span className="font-mono">{counts[key]}</span></button>)}</div>
    {expanded&&<div className="mt-2 space-y-1 border-t border-white/10 pt-2">{Object.entries(RACK_STATES).map(([key,v])=><div key={key} title={v.description} className="flex items-center gap-2 text-[9px]"><span style={{color:v.color,width:16}}>{v.icon}</span><span style={{color:v.color,width:65}}>{v.label}</span><span className="text-slate-400">{key==='no_pdu'?'No PDU assignment':key==='unknown'?'Unverified or stale power':key==='partial'?'Confirmed on + off':key==='off'?'All confirmed off':key==='on'?'All confirmed on':'Active alarm'}</span></div>)}<div className="text-[9px] text-slate-400 pt-1">⊘ Communication loss · independent of power/alarm<br/>Issues includes alarms, disconnections and stale alarms.</div></div>}
  </div>;
}

function frameAnchor(rack,rear){
  const base=plaqueAnchors[rear?'rear':'front'],t=plaqueAnchors.templateDimensions,d=rack.dimensions,p=rack.position;
  return new THREE.Vector3(base[0]*d.width/t[0],base[1]*d.height/t[1],base[2]*d.depth/t[2]+(rear?.008:-.008)).applyAxisAngle(new THREE.Vector3(0,1,0),rack.rotationY || 0).add(new THREE.Vector3(p.x,p.y || 0,p.z));
}
function isRear(rack,camera){return new THREE.Vector3().subVectors(camera.position,new THREE.Vector3(rack.position.x,rack.position.y || 0,rack.position.z)).applyAxisAngle(new THREE.Vector3(0,1,0),-(rack.rotationY || 0)).z>0;}
function rackAnchor(rack,camera){return frameAnchor(rack,isRear(rack,camera));}

function ScreenStatusTooltip({rack,status,power,selected,openDoors,serviceSide}) {
  const {camera,size}=useThree();const card=useRef(),content=useRef(),line=useRef();
  useFrame(()=>{
    if(!card.current||!content.current||!line.current)return;
    const p=rack.position,d=rack.dimensions,anchor=rackAnchor(rack,camera).project(camera);
    const screen={x:(anchor.x+1)*size.width/2,y:(1-anchor.y)*size.height/2};
    const projected={left:Infinity,right:-Infinity,top:Infinity,bottom:-Infinity};
    const project=world=>{
      if(rack.rotationY)world.sub(new THREE.Vector3(p.x,p.y||0,p.z)).applyAxisAngle(new THREE.Vector3(0,1,0),rack.rotationY).add(new THREE.Vector3(p.x,p.y||0,p.z));
      const point=world.project(camera),sx=(point.x+1)*size.width/2,sy=(1-point.y)*size.height/2;
      projected.left=Math.min(projected.left,sx);projected.right=Math.max(projected.right,sx);projected.top=Math.min(projected.top,sy);projected.bottom=Math.max(projected.bottom,sy);
    };
    for(const x of [-1,1])for(const y of [0,1])for(const z of [-1,1])project(new THREE.Vector3(p.x+x*d.width/2,(p.y||0)+y*d.height,p.z+z*d.depth/2));
    // Match the GLB door's hinge and 108-degree swing, rather than inflating
    // the whole cabinet in every direction (which wastes narrow-canvas space).
    if(openDoors){
      const rear=serviceSide==='rear',angle=(rear?-1:1)*Math.PI*.60;
      const hingeX=p.x-d.width*(.26/.6),hingeZ=p.z+(rear?1:-1)*d.depth*.492;
      for(const along of [-.02,d.width*.9])for(const y of [0,d.height])for(const thickness of [-.02,.02]){
        project(new THREE.Vector3(hingeX+Math.cos(angle)*along+Math.sin(angle)*thickness,(p.y||0)+y,hingeZ-Math.sin(angle)*along+Math.cos(angle)*thickness));
      }
    }
    const box=layoutStatusTooltip({width:size.width,height:size.height,rack:projected,anchor:screen,naturalHeight:content.current.scrollHeight+24});
    Object.assign(card.current.style,{left:`${box.x}px`,top:`${box.y}px`,width:`${box.width}px`,maxHeight:`${box.height}px`});
    card.current.dataset.placement=box.side;
    const x1=Math.max(0,Math.min(size.width,screen.x)),y1=Math.max(0,Math.min(size.height,screen.y));
    const x2=Math.max(box.x,Math.min(box.x+box.width,x1)),y2=Math.max(box.y,Math.min(box.y+box.height,y1));
    for(const [key,value] of Object.entries({x1,y1,x2,y2}))line.current.setAttribute(key,value);
  });
  return <Html calculatePosition={()=>[0,0]} zIndexRange={[45,35]} style={{width:size.width,height:size.height,pointerEvents:'none'}}>
    <svg width={size.width} height={size.height} style={{position:'absolute',inset:0,overflow:'hidden'}} aria-hidden="true"><line ref={line} stroke="#84929d" strokeWidth="1" opacity=".65"/></svg>
    <div ref={card} role="tooltip" data-testid="rack-status-tooltip" style={{position:'absolute',width:260,maxHeight:300,overflowY:'auto',padding:12,background:'#161c23f5',border:'1px solid #687580',borderRadius:8,boxShadow:'0 8px 24px #0007',pointerEvents:selected?'auto':'none'}}><div ref={content}><RackStatusDetails rack={rack} status={status} power={power} compact/></div></div>
  </Html>;
}

export function RackStatusPlaques({racks,statuses,dimmedIds,onSelectRack,onHoverRack,selectedRack,hoveredRack,openDoors,serviceSide,rackPowerReadings={}}) {
  const {camera,size}=useThree();const timer=useRef(0);const signature=useRef('');const [labels,setLabels]=useState([]);
  const occluders=useMemo(()=>racks.map(r=>({id:r.id,inverse:new THREE.Matrix4().compose(new THREE.Vector3(r.position.x,r.position.y||0,r.position.z),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),r.rotationY||0),new THREE.Vector3(1,1,1)).invert(),box:new THREE.Box3(new THREE.Vector3(-r.dimensions.width/2,0,-r.dimensions.depth/2),new THREE.Vector3(r.dimensions.width/2,r.dimensions.height,r.dimensions.depth/2))})),[racks]);
  // Shared physical plaques, fixed to frame on both service faces. Door transforms never touch them.
  const batches=useMemo(()=>{
    const groups=new Map();for(const rack of racks){const status=statuses[rack.id];if(!status)continue;const key=`${status.state}:${status.disconnected}`;
      if(!groups.has(key))groups.set(key,{part:{name:key,geometry:plaqueGeometry,material:plaqueMaterial(status.state,status.disconnected),matrix:new THREE.Matrix4()},items:[]});
      for(const rear of [false,true])groups.get(key).items.push({rack,dim:dimmedIds?.has(rack.id),matrix:new THREE.Matrix4().compose(frameAnchor(rack,rear),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),(rear?0:Math.PI)+(rack.rotationY || 0)),new THREE.Vector3(1,1,1))});
    }return [...groups.values()];
  },[racks,statuses,dimmedIds]);
  useFrame((_,dt)=>{timer.current+=dt;if(timer.current<.2)return;timer.current=0;
    const candidates=[],hit=new THREE.Vector3();
    for(const rack of racks){if(dimmedIds?.has(rack.id))continue;const p=rack.position,d=rack.dimensions;
      const foot=new THREE.Vector3(p.x,p.y||0,p.z).project(camera),point=rackAnchor(rack,camera),top=point.clone().project(camera);
      if(top.z>1||top.z< -1||Math.abs(top.x)>1||Math.abs(top.y)>1)continue;
      const pixels=Math.abs(top.y-foot.y)*size.height/2;if(pixels<36)continue;
      const ray=new THREE.Ray(camera.position,point.clone().sub(camera.position).normalize());const distance=camera.position.distanceTo(point);
      if(occluders.some(other=>{if(other.id===rack.id)return false;const localRay=ray.clone().applyMatrix4(other.inverse);return localRay.intersectBox(other.box,hit)&&localRay.origin.distanceTo(hit)<distance-.02;}))continue;
      const full=pixels>=95,priority=rack.id===selectedRack?.id?-3:statuses[rack.id]?.state==='critical'?-2:statuses[rack.id]?.state==='warning'?-1:0;
      candidates.push({id:rack.id,full,rear:isRear(rack,camera),x:(top.x+1)*size.width/2,y:(1-top.y)*size.height/2,d:distance,width:full?132:30,height:full?(annotationPowerView(rackPowerReadings[rack.id]).partial?96:62):24,priority});
    }
    candidates.sort((a,b)=>a.priority-b.priority||a.d-b.d);const kept=[];
    for(const item of candidates)if(kept.length<48&&!kept.some(k=>Math.abs(k.x-item.x)<(k.width+item.width)/2+4&&Math.abs(k.y-item.y)<(k.height+item.height)/2))kept.push(item);
    const key=kept.map(v=>`${v.id}:${v.full}:${v.rear}`).join('|');if(key!==signature.current){signature.current=key;setLabels(kept);}
  });
  const detailRack=selectedRack || hoveredRack;const detail=detailRack&&statuses[detailRack.id];const detailPower=detailRack?rackPowerReadings[detailRack.id]:null;
  const rackById=new Map(racks.map(r=>[r.id,r]));
  return <>
    {batches.map(({part,items})=><Batch key={part.name} part={part} items={items} onPick={i=>onSelectRack(i.rack)} onHover={i=>onHoverRack(i?.rack||null)}/>)}
    {labels.map(label=>{const rack=rackById.get(label.id);if(!rack)return null;const status=statuses[rack.id];return <Html key={`${rack.id}-${label.rear}`} position={rackAnchor(rack,camera).toArray()} center zIndexRange={[15,5]} style={{pointerEvents:'none'}}><RackAnnotation name={rack.label||rack.rackCode||rack.id} status={status} selected={rack.id===selectedRack?.id} detail={label.full} power={rackPowerReadings[rack.id]} onSelect={()=>onSelectRack(rack)} onHover={over=>onHoverRack(over?rack:null)}/></Html>})}
    {detailRack&&detail&&<ScreenStatusTooltip rack={detailRack} status={detail} power={detailPower} selected={!!selectedRack} openDoors={openDoors} serviceSide={serviceSide}/>}
  </>;
}
