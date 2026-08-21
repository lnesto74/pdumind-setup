import React from 'react';
import PduMonitoringTree from './PduMonitoringTree';

const PDU_TABS = [
  { id: 'telemetry', icon: 'analytics', label: 'Telemetry' },
  { id: 'warnings', icon: 'warning_amber', label: 'Warnings' },
  { id: 'outlets', icon: 'power', label: 'Outlets' },
  { id: 'pdu-settings', icon: 'settings', label: 'Settings' },
];

export function DemoPduDetailShell({ showFleetSplit, fleetProps, children }) {
  if (!showFleetSplit) return children;
  return <DemoFleetPanel {...fleetProps}>{children}</DemoFleetPanel>;
}

export default function DemoFleetPanel({
  pdus,
  pduFilter,
  onPduFilterChange,
  selectedPduId,
  onSelectPdu,
  pduLiveStatus,
  pduAlarms,
  pduEnv,
  isDemoMode,
  activeTab,
  onTabChange,
  children,
}) {
  const filtered = pdus.filter((pdu) => {
    if (pduFilter === 'all') return true;
    const st = pduLiveStatus[pdu.ip] || 'offline';
    if (pduFilter === 'live') return st === 'online';
    return st !== 'online';
  });

  const selected = pdus.find((p) => p.id === selectedPduId);

  return (
    <div className="flex flex-1 min-h-0 w-full overflow-hidden">
      {/* PDU list */}
      <div className="w-[min(320px,32vw)] min-w-[280px] max-w-[360px] flex-shrink-0 border-r border-[#233544] bg-[#0B1120] flex flex-col min-h-0">
        <div className="px-4 py-3 border-b border-[#233544] flex-shrink-0">
          <h2 className="text-xs font-bold text-white uppercase tracking-wider mb-2.5">Fleet PDUs</h2>
          <div className="flex gap-1.5">
            {[
              { id: 'all', label: 'All' },
              { id: 'live', label: 'Live' },
              { id: 'offline', label: 'Off' },
            ].map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => onPduFilterChange(f.id)}
                className={`flex-1 py-1.5 text-[10px] rounded-md uppercase font-bold tracking-wide ${
                  pduFilter === f.id ? 'bg-[#00E5FF]/20 text-[#00E5FF]' : 'text-slate-500 hover:bg-[#161E2E]'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5 min-h-0">
          {filtered.length === 0 ? (
            <p className="text-xs text-slate-600 text-center py-8">No PDUs</p>
          ) : (
            <PduMonitoringTree
              pdus={filtered}
              selectedPduId={selectedPduId}
              onSelectPdu={onSelectPdu}
              pduLiveStatus={pduLiveStatus}
              pduAlarms={pduAlarms}
              pduEnv={isDemoMode ? pduEnv : {}}
              dense
            />
          )}
        </div>
      </div>

      {/* Detail pane */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#0B1120]">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-slate-600 text-sm">
            Select a PDU from the fleet list
          </div>
        ) : (
          <>
            <div className="flex-shrink-0 border-b border-[#233544] px-5 py-3 bg-[#0B1120]">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="material-icons-outlined text-[#00E5FF] text-xl">dns</span>
                  <div className="min-w-0">
                    <p className="text-base font-bold text-white truncate">{selected.label || selected.ip}</p>
                    <p className="text-[11px] font-mono text-slate-500 truncate">
                      {selected.ip}
                      {selected.location ? ` · ${selected.location}` : ''}
                    </p>
                  </div>
                </div>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${
                  pduLiveStatus[selected.ip] === 'online'
                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                    : 'bg-slate-500/15 text-slate-400 border border-slate-500/30'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${pduLiveStatus[selected.ip] === 'online' ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
                  {pduLiveStatus[selected.ip] === 'online' ? 'Live' : 'Offline'}
                </span>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {PDU_TABS.map((tab) => {
                  const alarmCount = tab.id === 'warnings' ? (pduAlarms[selected.ip]?.count || 0) : 0;
                  const disabled = tab.id === 'pdu-settings' && !selected.dbId;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => onTabChange(tab.id)}
                      className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${
                        disabled ? 'opacity-40 cursor-not-allowed text-slate-600'
                          : activeTab === tab.id
                            ? 'bg-[#00E5FF]/15 text-[#00E5FF] border border-[#00E5FF]/40'
                            : alarmCount > 0
                              ? 'text-red-400 bg-red-500/10 border border-red-500/30'
                              : 'text-slate-400 hover:bg-[#161E2E] border border-transparent'
                      }`}
                    >
                      <span className="material-icons-outlined text-sm">{tab.icon}</span>
                      {tab.label}
                      {alarmCount > 0 && (
                        <span className="text-[9px] font-mono bg-red-500 text-white px-1 rounded">{alarmCount}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 p-4 xl:p-5">{children}</div>
          </>
        )}
      </div>
    </div>
  );
}
