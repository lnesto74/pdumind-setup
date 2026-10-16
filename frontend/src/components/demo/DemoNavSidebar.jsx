import React from 'react';
import RecordReplayControls from '../RecordReplayControls';
import PduMonitoringTree from './PduMonitoringTree';
import Icon from '../presentation/Icon';
import {useWorkspace} from '../presentation/Workspace';
const PRIMARY=[{id:'stencil',label:'Stencil',icon:'architecture'},{id:'switchboard',label:'Switchboard',icon:'dashboard'}];
const STENCIL_SUB=[{id:'designer',label:'Designer',icon:'view_in_ar'},{id:'assign',label:'Assign',icon:'drag_indicator'},{id:'commission',label:'Commission',icon:'rocket_launch'},{id:'teams',label:'Teams',icon:'groups'},{id:'integrations',label:'Integrations',icon:'settings_input_antenna'}];
const SWITCHBOARD_SUB=[{id:'overview',label:'Overview',icon:'hub'},{id:'alarms',label:'Alarms',icon:'warning_amber'},{id:'fleet',label:'Fleet',icon:'electrical_services'}];
export default function DemoNavSidebar({
  primaryMode,
  onPrimaryModeChange,
  stencilSection,
  onStencilSectionChange,
  switchboardSection,
  onSwitchboardSectionChange,
  integrationsConnected,
  globalAlarmCount,
  halls,
  selectedHallId,
  onHallChange,
  selectedHall,
  hallPduCount,
  livePduCount,
  pdus = [],
  pduFilter = 'all',
  onPduFilterChange,
  selectedPduId,
  onSelectPdu,
  pduLiveStatus = {},
  pduAlarms = {},
  pduEnv = {},
  hallLoading = false,
  compact = false,
  isDemoSession = false,
  onReplayLoaded,
  onReplayStopped,
}) {
  const w=useWorkspace();
  const isSwitchboard=primaryMode==='switchboard';
  const items=isSwitchboard?SWITCHBOARD_SUB:STENCIL_SUB;
  const active=isSwitchboard?switchboardSection:stencilSection;
  const select=isSwitchboard?onSwitchboardSectionChange:onStencilSectionChange;
  const fieldAvailable=!isSwitchboard&&stencilSection==='designer';
  const fieldVisible=w?.panel==='field'&&fieldAvailable;
  return <>
    <nav className="px-rail" aria-label="PDUMIND navigation">
      {PRIMARY.map(item=><button key={item.id} title={item.label} aria-label={item.label} aria-pressed={primaryMode===item.id} onClick={()=>onPrimaryModeChange(item.id)}><Icon name={item.icon}/><small>{item.label}</small></button>)}
      <hr/>
      {items.map(item=><button key={item.id} title={item.label} aria-label={item.label} aria-pressed={active===item.id} onClick={()=>select(item.id)}><Icon name={item.icon}/><small>{item.label}</small>{item.id==='alarms'&&globalAlarmCount>0&&<em>{globalAlarmCount}</em>}{item.id==='integrations'&&integrationsConnected&&<span className="px-connected"/>}</button>)}
      {!compact&&<button className="px-rail-collapse" title={w?.collapsed?'Open workspace':'Collapse workspace'} aria-label={w?.collapsed?'Open workspace':'Collapse workspace'} onClick={()=>w?.setCollapsed(!w.collapsed)}><Icon name={w?.collapsed?'chevron_right':'chevron_left'}/></button>}
    </nav>
    {!compact&&<aside className={`px-workspace ${w?.collapsed?'is-collapsed':''}`} aria-label="Workspace">
      <div className="px-workspace-heading"><label htmlFor="workspace-hall">Data hall</label><select id="workspace-hall" value={selectedHallId||''} onChange={e=>onHallChange(parseInt(e.target.value,10))}>{halls.map(h=><option key={h.id} value={h.id}>{h.name}</option>)}</select><small>{livePduCount}/{hallPduCount} live{globalAlarmCount>0?` · ${globalAlarmCount} alarms`:''}</small></div>
      <div className="px-tabs" role="tablist" aria-label="Workspace panels"><button role="tab" aria-selected={!fieldVisible} onClick={()=>w?.setPanel('devices')}>Devices</button><button role="tab" aria-selected={fieldVisible} disabled={!fieldAvailable} title={fieldAvailable?'Configure the data hall':'Available in Stencil Designer'} onClick={()=>w?.setPanel('field')}>Field Control</button></div>
      <div className="px-workspace-body" hidden={fieldVisible} role="tabpanel" aria-label="Devices">
        <div className="px-segments">{[['all','All'],['live','Live'],['offline','Off']].map(([id,label])=><button key={id} aria-pressed={pduFilter===id} onClick={()=>onPduFilterChange?.(id)}>{label}</button>)}</div>
        <div className="px-device-list">{hallLoading?<p>Loading…</p>:pdus.length?<PduMonitoringTree pdus={pdus} selectedPduId={selectedPduId} onSelectPdu={onSelectPdu} pduLiveStatus={pduLiveStatus} pduAlarms={pduAlarms} pduEnv={pduEnv} dense/>:<p>No PDUs. Commission via Stencil → Commission.</p>}</div>
        <RecordReplayControls isDemoSession={isDemoSession} selectedHallId={selectedHallId} onReplayLoaded={onReplayLoaded} onReplayStopped={onReplayStopped}/>
      </div>
      <div ref={w?.setFieldHost} hidden={!fieldVisible} className="px-field-host" role="tabpanel" aria-label="Field Control"/>
    </aside>}
  </>;
}
