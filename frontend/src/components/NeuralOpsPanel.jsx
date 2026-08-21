import { buildAttentionQueue } from '../utils/neuralOpsAlerts';

const SeverityDot = ({ severity }) => {
  const colors = {
    critical: 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]',
    warning: 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]',
    offline: 'bg-slate-500',
    normal: 'bg-emerald-500',
  };
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${colors[severity] || colors.normal}`} />;
};

export default function NeuralOpsPanel({
  hallPDUs,
  pduAlarms,
  pduLiveStatus,
  pduEnv,
  rackAlerts,
  onSelectPdu,
  onSelectAlert,
}) {
  const onlineCount = hallPDUs.filter((p) => pduLiveStatus[p.ip] === 'online').length;
  const criticalCount = rackAlerts.filter((a) => a.severity === 'critical').length;
  const warningCount = rackAlerts.filter((a) => a.severity === 'warning').length;
  const attention = buildAttentionQueue(hallPDUs, pduAlarms, pduLiveStatus, pduEnv);

  const envSamples = hallPDUs
    .map((p) => pduEnv[p.ip])
    .filter(Boolean);
  const avgTemp = envSamples.length
    ? (envSamples.reduce((s, e) => s + parseFloat(e.temp || 0), 0) / envSamples.length).toFixed(1)
    : '—';
  const avgHum = envSamples.length
    ? (envSamples.reduce((s, e) => s + parseFloat(e.hum || 0), 0) / envSamples.length).toFixed(0)
    : '—';
  const openDoors = envSamples.filter((e) => e.door && e.door !== 'Closed').length;

  return (
    <aside className="w-72 flex-shrink-0 border-l border-[#233544] bg-[#0B1120] flex flex-col h-full min-h-0 overflow-hidden">
      {/* Status strip */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-[#233544] bg-gradient-to-r from-[#161E2E] to-[#0B1120]">
        <div className="flex items-center gap-2 mb-2">
          <span className="material-icons-outlined text-[#00E5FF] text-sm">dashboard</span>
          <span className="text-[10px] font-bold uppercase tracking-widest text-[#00E5FF]">Switchboard</span>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-[#161E2E] rounded-lg py-2 px-1">
            <p className="text-lg font-mono font-bold text-emerald-400">{onlineCount}</p>
            <p className="text-[9px] text-slate-500 uppercase">Online</p>
          </div>
          <div className="bg-[#161E2E] rounded-lg py-2 px-1">
            <p className="text-lg font-mono font-bold text-red-400">{criticalCount}</p>
            <p className="text-[9px] text-slate-500 uppercase">Critical</p>
          </div>
          <div className="bg-[#161E2E] rounded-lg py-2 px-1">
            <p className="text-lg font-mono font-bold text-amber-400">{warningCount}</p>
            <p className="text-[9px] text-slate-500 uppercase">Warning</p>
          </div>
        </div>
      </div>

      {/* Environment strip */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-[#233544]">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Environment</p>
        <div className="grid grid-cols-3 gap-2">
          <div className="flex items-center gap-2 bg-[#161E2E] rounded-lg px-2 py-2">
            <span className="material-icons-outlined text-orange-400 text-sm">thermostat</span>
            <div>
              <p className="text-xs font-mono font-bold text-white">{avgTemp}°C</p>
              <p className="text-[9px] text-slate-500">Avg temp</p>
            </div>
          </div>
          <div className="flex items-center gap-2 bg-[#161E2E] rounded-lg px-2 py-2">
            <span className="material-icons-outlined text-blue-400 text-sm">water_drop</span>
            <div>
              <p className="text-xs font-mono font-bold text-white">{avgHum}%</p>
              <p className="text-[9px] text-slate-500">Humidity</p>
            </div>
          </div>
          <div className="flex items-center gap-2 bg-[#161E2E] rounded-lg px-2 py-2">
            <span className={`material-icons-outlined text-sm ${openDoors > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
              {openDoors > 0 ? 'door_front' : 'lock'}
            </span>
            <div>
              <p className={`text-xs font-mono font-bold ${openDoors > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                {openDoors > 0 ? openDoors : 'OK'}
              </p>
              <p className="text-[9px] text-slate-500">Doors</p>
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable alerts + attention */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="flex-shrink-0 px-4 py-2 border-b border-[#233544]/50 bg-[#0B1120] flex items-center justify-between">
          <span className="text-[9px] text-slate-500 uppercase tracking-wider">Alerts &amp; attention</span>
          <span className="text-[9px] text-[#00E5FF]/70 flex items-center gap-1">
            <span className="material-icons-outlined text-xs">south</span>
            scroll
          </span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto neural-panel-scroll overscroll-contain">
        <div className="px-4 py-3">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1">
            <span className="material-icons-outlined text-sm text-red-400">notifications_active</span>
            Alert Stream
            {rackAlerts.length > 0 && (
              <span className="ml-auto px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 text-[9px] font-mono">{rackAlerts.length}</span>
            )}
          </p>
          {rackAlerts.length === 0 ? (
            <div className="text-center py-6 text-slate-600">
              <span className="material-icons-outlined text-3xl mb-2 block text-emerald-500/50">check_circle</span>
              <p className="text-xs">All racks nominal</p>
            </div>
          ) : (
            <div className="space-y-2">
              {rackAlerts.map((alert) => (
                <button
                  key={alert.pduIp}
                  type="button"
                  onClick={() => onSelectAlert?.(alert)}
                  className={`w-full text-left p-3 rounded-lg border transition-all hover:scale-[1.01] ${
                    alert.severity === 'critical'
                      ? 'bg-red-500/10 border-red-500/40 hover:bg-red-500/15'
                      : 'bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/15'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <SeverityDot severity={alert.severity} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-white truncate">{alert.pduLabel || alert.pduIp}</p>
                      <p className="text-[10px] text-slate-400 font-mono">{alert.rackId || 'Unassigned'}</p>
                      <p className={`text-[10px] mt-1 ${alert.severity === 'critical' ? 'text-red-300' : 'text-amber-300'}`}>
                        {alert.title}
                      </p>
                      {pduEnv[alert.pduIp] && (
                        <p className="text-[9px] font-mono text-slate-500 mt-1 flex items-center gap-2">
                          <span>{pduEnv[alert.pduIp].temp}°C</span>
                          <span>{pduEnv[alert.pduIp].hum}%</span>
                          <span className={pduEnv[alert.pduIp].door !== 'Closed' ? 'text-red-400' : ''}>
                            {pduEnv[alert.pduIp].door === 'Closed' ? '🔒' : `🚪 ${pduEnv[alert.pduIp].door}`}
                          </span>
                        </p>
                      )}
                    </div>
                    <span className="text-[9px] uppercase font-bold text-slate-500">{alert.category}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Attention queue */}
        <div className="px-4 py-3 border-t border-[#233544]">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1">
            <span className="material-icons-outlined text-sm text-amber-400">priority_high</span>
            Attention Queue
          </p>
          {attention.length === 0 ? (
            <p className="text-xs text-slate-600 py-2">No items require attention</p>
          ) : (
            <div className="space-y-1.5">
              {attention.slice(0, 8).map((item) => (
                <button
                  key={item.ip}
                  type="button"
                  onClick={() => onSelectPdu?.(item.ip)}
                  className="w-full flex items-center gap-2 px-2 py-2 rounded-lg bg-[#161E2E] hover:bg-[#233544] border border-[#233544] transition-colors text-left"
                >
                  <SeverityDot severity={item.severity} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-mono text-white truncate">{item.label}</p>
                    <p className="text-[9px] text-slate-500 truncate">{item.summary}</p>
                  </div>
                  {item.temp && (
                    <span className="text-[9px] font-mono text-orange-400">{item.temp}°</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        </div>
      </div>
    </aside>
  );
}
