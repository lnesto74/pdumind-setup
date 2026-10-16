import React, {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import Icon from './presentation/Icon';
import {deviceName,slotIds,occupants,validateAssignment,applyAssignment,assignmentResult,slotZones} from '../utils/assignmentModel';
import {parseChainSuffix} from '../utils/pduChainTree';
import '../styles/assignment.css';
const API_BASE=import.meta.env.VITE_API_URL || '';
const ASSETS='/models/pdumind-assignment/';
const EMPTY={config:null,racks:[],pdus:[]};
const pct=n=>`${n*100}%`;
function RackImage({children,small=false}) {return <div className={`assignment-rack-image ${small?'is-small':''}`}><img src={`${ASSETS}rack-front.png`} alt="" loading={small?'lazy':'eager'} draggable={false}/>{children}</div>;}
export default function AssignPdusPanel({selectedHallId,refreshKey=0,onAssigned,halls=[],onHallChange,onOpenDevices,mountingPositions={}}) {
 const [data,setData]=useState(EMPTY),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[message,setMessage]=useState(null);
 const [rackId,setRackId]=useState(null),[row,setRow]=useState('all'),[query,setQuery]=useState(''),[filter,setFilter]=useState('all');
 const [picked,setPicked]=useState(null),[drag,setDrag]=useState(null),[hover,setHover]=useState(null);
 const generation=useRef(0),busy=useRef(false),liveHall=useRef(selectedHallId);liveHall.current=selectedHallId;
 useEffect(()=>{liveHall.current=selectedHallId;return()=>{liveHall.current=null;};},[selectedHallId]);
 const cancel=useCallback(()=>{setPicked(null);setDrag(null);setHover(null);},[]);
 const read=useCallback(async()=>{
  const res=await fetch(`${API_BASE}/api/halls/${selectedHallId}/state`);
  if(!res.ok)throw new Error('Unable to load assignments.');
  const j=await res.json();return {config:j.config||null,racks:j.racks||[],pdus:j.pdus||[]};
 },[selectedHallId]);
 useEffect(()=>{let active=true;const g=++generation.current;setLoading(true);
  if(!selectedHallId){setData(EMPTY);setLoading(false);return;}
  read().then(d=>{if(active && g===generation.current)setData(d)}).catch(e=>{if(active)setMessage({error:true,text:e.message})}).finally(()=>{if(active)setLoading(false)});
  return ()=>{active=false};
 },[read,refreshKey]);
 useEffect(()=>{setData(EMPTY);setMessage(null);setRackId(null);setRow('all');cancel();setQuery('');},[selectedHallId,cancel]);
 useEffect(()=>{const key=e=>{if(e.key==='Escape'){cancel();setMessage({text:'Selection cancelled.'});}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[cancel]);
 const ids=useMemo(()=>slotIds(data.config),[data.config]);
 const zones=useMemo(()=>slotZones(ids,mountingPositions),[ids,mountingPositions]);
 const rack=data.racks.find(r=>r.id===rackId);
 const selectedDevice=data.pdus.find(p=>p.ip_address===(drag||picked));
 const rows=useMemo(()=>[...new Set(data.racks.map(r=>r.row_index??0))].sort((a,b)=>a-b),[data.racks]);
 const unassigned=data.pdus.filter(p=>p.rack_id==null);
 const library=useMemo(()=>data.pdus.filter(p=>(filter==='all'||p.rack_id==null) && [deviceName(p),p.ip_address,p.rack_code].some(v=>String(v||'').toLowerCase().includes(query.toLowerCase()))).sort((a,b)=>Number(a.rack_id!=null)-Number(b.rack_id!=null)||deviceName(a).localeCompare(deviceName(b),undefined,{numeric:true})),[data.pdus,filter,query]);
 const locate=p=>{const r=data.racks.find(r=>r.id===p.rack_id);if(r){setRackId(r.id);setRow(String(r.row_index??0));}};
 async function assign(ip,targetId,position){
  if(busy.current||loading)return;
  const reason=validateAssignment(data,ip,targetId,position);if(reason){setMessage({error:true,text:reason});return;}
  busy.current=true;setSaving(true);setMessage({text:'Checking destination…'});
  const hall=selectedHallId;let previous=data;let confirmed=false;
  try {
   // Re-read before writing so another operator's saved assignment is not overwritten.
   previous=await read();if(liveHall.current!==hall)return;
   const conflict=validateAssignment(previous,ip,targetId,position);if(conflict){setData(previous);throw new Error(conflict);}
   setData(applyAssignment(previous,ip,targetId,position));setMessage({text:'Saving assignment…'});
   const res=await fetch(`${API_BASE}/api/halls/${hall}/pdus/bulk-rack-assign`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assignments:[{pdu_ip:ip,rack_id:targetId,mount_position:position||'A'}]})});
   const result=await res.json();if(!res.ok)throw new Error(result.error||'Assignment failed.');assignmentResult(result,ip);confirmed=true;
   if(liveHall.current!==hall)return;
   setMessage({text:targetId==null?'Device unassigned.':`${deviceName(previous.pdus.find(p=>p.ip_address===ip))} assigned to ${previous.racks.find(r=>r.id===targetId)?.rack_code} · ${position}`});cancel();
   try {const fresh=await read();if(liveHall.current===hall)setData(fresh);}catch{setMessage({text:'Assignment saved. Refresh is temporarily unavailable.'});}
   onAssigned?.();
  }catch(e){if(liveHall.current===hall){if(!confirmed)setData(previous);setMessage({error:true,text:e.message||'Assignment failed. Previous assignment restored.'});}}
  finally{busy.current=false;setSaving(false);}
 }
 const place=position=>{if(!rack||!selectedDevice)return;const ip=selectedDevice.ip_address;setDrag(null);setHover(null);assign(ip,rack.id,position);};
 const selectDevice=p=>{if(saving)return;setPicked(picked===p.ip_address?null:p.ip_address);if(p.rack_id!=null)locate(p);};
 const occupied=(r,pos)=>occupants(data,r.id,pos);
 const count=r=>data.pdus.filter(p=>p.rack_id===r.id).length;
 if(!selectedHallId)return <div className="assignment-empty">Select a data hall to assign PDUs.</div>;
 return <section className="assignment-workspace" aria-label="Assign PDUs" aria-busy={loading||saving} onDragEnter={e=>e.preventDefault()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();cancel();}}>
  <header className="assignment-header"><h1>Assign PDUs</h1>{halls.length>0&&<select aria-label="Assignment data hall" value={selectedHallId} disabled={saving} onChange={e=>onHallChange?.(Number(e.target.value))}>{halls.map(h=><option key={h.id} value={h.id}>{h.name}</option>)}</select>}<span>Mounting assignments</span>{onOpenDevices&&<button onClick={onOpenDevices}>Device hierarchy <Icon>chevron_right</Icon></button>}</header>
  <div className="assignment-columns">
   <aside className="assignment-library" aria-label="PDU library"><h2>PDU library <small>{loading?'—':data.pdus.length}</small></h2>
    <label className="assignment-search"><Icon>search</Icon><input aria-label="Search PDUs" placeholder="Search name or IP" value={query} onChange={e=>setQuery(e.target.value)}/></label>
    <div className="assignment-tabs" role="group" aria-label="Library filter"><button aria-pressed={filter==='unassigned'} onClick={()=>setFilter('unassigned')}>Unassigned ({loading?'—':unassigned.length})</button><button aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>All ({loading?'—':data.pdus.length})</button></div>
    <div className="assignment-device-list">{!loading&&library.length===0&&<p className="assignment-empty">{data.pdus.length?'No matching devices.':'No PDUs in this hall.'}</p>}{library.map(p=>{const chain=parseChainSuffix(p.hostname||p.label);return <div className={`assignment-device ${picked===p.ip_address?'is-selected':''}`} key={p.id||p.ip_address}>
     <button className="assignment-device-pick" draggable={!saving} disabled={saving||!p.ip_address} aria-pressed={picked===p.ip_address} onClick={()=>selectDevice(p)}
      onDragStart={e=>{setDrag(p.ip_address);setPicked(p.ip_address);e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',p.ip_address);e.dataTransfer.setDragImage(e.currentTarget,24,35);}}
      onDragEnd={()=>{setDrag(null);setHover(null);setPicked(null);}} title={`${deviceName(p)} · ${p.ip_address||'—'}`}>
      <img src={`${ASSETS}pdu-front.png`} alt="" loading="lazy" draggable={false}/><span><strong>{deviceName(p)}</strong><small>{p.ip_address||'—'}</small>{chain&&<small>{chain.idx===1?'Master':`Slave ${chain.idx}`}</small>}<small>{p.rack_code?`${p.rack_code} · ${p.mount_position||'A'}`:'Unassigned'}</small></span><Icon>drag_indicator</Icon>
     </button>{p.rack_id!=null&&<button className="assignment-locate" onClick={()=>locate(p)} aria-label={`Locate ${deviceName(p)}`}>Locate <Icon>my_location</Icon></button>}
    </div>})}</div>
   </aside>
   <section className="assignment-overview" aria-label="Hall overview"><div className="assignment-section-heading"><h2>Hall overview <small>{loading?'—':data.racks.length} racks</small></h2><select aria-label="Filter rack row" value={row} onChange={e=>setRow(e.target.value)}><option value="all">All rows</option>{rows.map(r=><option key={r} value={r}>Row {r+1}</option>)}</select></div>
    <div className="assignment-hall-scroll">{loading?<p className="assignment-empty">Loading saved assignments…</p>:rows.filter(r=>row==='all'||String(r)===row).map(ri=><section className="assignment-row" key={ri}><h3>Row {ri+1}</h3><div className="assignment-rack-grid">{data.racks.filter(r=>(r.row_index??0)===ri).sort((a,b)=>(a.position_index??0)-(b.position_index??0)).map(r=><button className={`assignment-rack-card ${r.id===rackId?'is-selected':''}`} key={r.id} onClick={()=>setRackId(r.id)} aria-pressed={r.id===rackId} aria-label={`${r.label||r.rack_code}, ${count(r)} of ${ids.length} assigned`}>
     <RackImage small>{zones.map(z=>occupied(r,z.id).length>0&&<img className="assignment-mini-pdu" key={z.id} src={`${ASSETS}pdu-front.png`} alt="" loading="lazy" draggable={false} style={{left:pct(z.x),top:pct(z.y),width:pct(z.w),height:pct(z.h)}}/>)}</RackImage><strong>{r.label||r.rack_code}</strong><small>{count(r)} / {ids.length} assigned</small>
    </button>)}</div></section>)}{!loading&&!data.racks.length&&<p className="assignment-empty">No racks configured in this hall.</p>}</div>
   </section>
   <section className="assignment-detail" aria-label="Selected rack mounting"><h2>{rack?(rack.label||rack.rack_code):'Select a rack'}{rack&&<small>Front mounting</small>}</h2>
    {!rack?<div className="assignment-empty"><Icon>view_in_ar</Icon><p>Select a rack in the overview to inspect its mounting positions.</p></div>:<div className="assignment-detail-scroll"><p className="assignment-schematic">Schematic mounting positions · slot IDs are not electrical feeds</p>
     <RackImage>{zones.map(z=>{const members=occupied(rack,z.id),p=members[0],reason=selectedDevice?validateAssignment(data,selectedDevice.ip_address,rack.id,z.id):null,valid=selectedDevice&&!reason,active=hover===z.id;return <button key={z.id} className={`assignment-slot ${p?'is-occupied':''} ${valid?'is-valid':''} ${active?'is-hovered':''} ${reason?'is-unavailable':''}`} style={{left:pct(z.x),top:pct(z.y),width:pct(z.w),height:pct(z.h)}}
      aria-label={`Slot ${z.id} · ${p?deviceName(p):'Available'}${reason?` · ${reason}`:''}`} aria-disabled={saving||!!reason} title={reason||`${rack.rack_code} · Slot ${z.id}${p?` · ${deviceName(p)}`:''}`} disabled={saving}
      onClick={()=>{if(reason)setMessage({error:true,text:reason});else if(selectedDevice)place(z.id);else if(p)selectDevice(p);}}
      onDragEnter={e=>{e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect=valid?'move':'none';setHover(z.id);}}
      onDragOver={e=>{e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect=valid?'move':'none';setHover(z.id);}}
      onDragLeave={()=>setHover(null)} onDrop={e=>{e.preventDefault();e.stopPropagation();if(valid)place(z.id);else{setMessage({error:true,text:reason||'Select a device from the library.'});cancel();}}}>
      <b>{z.id}</b>{(p||(active&&valid))&&<img src={`${ASSETS}pdu-front.png`} draggable={false} alt=""/>}{!p&&!active&&<span>{selectedDevice?'Place here':'Available'}</span>}{active&&selectedDevice&&<span className="assignment-destination">{reason||`${deviceName(selectedDevice)} → ${rack.rack_code} · ${z.id}`}</span>}{members.length>1&&<span>Conflict: {members.length} devices</span>}
     </button>})}</RackImage>
     <div className="assignment-mapping" aria-label="Slot to device mapping">{ids.map(pos=>{const members=occupied(rack,pos);const reason=selectedDevice?validateAssignment(data,selectedDevice.ip_address,rack.id,pos):null;return <div key={pos} className={hover===pos?'is-target':''}
 onDragEnter={e=>{e.preventDefault();setHover(pos);}} onDragLeave={()=>setHover(null)}
 onDragOver={e=>{e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect=selectedDevice&&!reason?'move':'none';setHover(pos);}}
 onDrop={e=>{e.preventDefault();e.stopPropagation();if(selectedDevice&&!reason)place(pos);else{setMessage({error:true,text:reason||'Select a device.'});cancel();}}}><b>{pos}</b><span>{members.length?members.map(p=><span key={p.id} title={p.ip_address}>{deviceName(p)}<small>{p.ip_address||'—'}</small></span>):'Available'}</span>{members.map(p=><button key={p.id} disabled={saving} onClick={()=>assign(p.ip_address,null,p.mount_position)} aria-label={`Unassign ${deviceName(p)}`} title="Remove mounting assignment"><Icon>close</Icon></button>)}</div>})}</div>
    </div>}
   </section>
  </div>
  <footer className="assignment-footer"><span role={message?.error?'alert':'status'} className={message?.error?'is-error':''}>{message?.text||(selectedDevice?`${deviceName(selectedDevice)} selected · choose a mounting slot`:'Drag a PDU to a slot, or select a device then a slot. Enter / Space to select; Escape to cancel.')}</span>{selectedDevice&&!saving&&<button onClick={cancel}>Cancel selection</button>}</footer>
 </section>;
}
