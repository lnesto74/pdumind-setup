import React, { useState, useEffect, useCallback, useMemo } from 'react';
import DataHallDesigner from './DataHallDesigner/DataHallDesigner';

const API_BASE = '';
const REFRESH_MS = 30000;

function healthColor(score) {
  if (score === 0) return 'text-slate-500';
  if (score >= 80) return 'text-emerald-400';
  if (score >= 50) return 'text-amber-400';
  return 'text-red-400';
}

function healthBg(score) {
  if (score === 0) return 'bg-slate-500/20 border-slate-500/30';
  if (score >= 80) return 'bg-emerald-500/10 border-emerald-500/30';
  if (score >= 50) return 'bg-amber-500/10 border-amber-500/30';
  return 'bg-red-500/10 border-red-500/30';
}

function statusIcon(status) {
  if (status === 'offline') return { icon: 'cloud_off', color: 'text-slate-500' };
  if (status === 'critical') return { icon: 'error', color: 'text-red-400' };
  if (status === 'warning') return { icon: 'warning', color: 'text-amber-400' };
  return { icon: 'check_circle', color: 'text-emerald-400' };
}

export default function FleetCommandCenter() {
  const [hubInfo, setHubInfo] = useState(null);
  const [hallId, setHallId] = useState(null);
  const [hallName, setHallName] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState(null);

  const fetchHub = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/hub/info`);
      if (res.ok) setHubInfo(await res.json());
    } catch {}
  }, []);

  const fetchHall = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/halls/default`);
      if (!res.ok) throw new Error('Hall not available');
      const data = await res.json();
      const id = data.hall?.id;
      if (id) {
        setHallId(id);
        setHallName(data.hall?.name || 'Data Hall');
      }
      return id;
    } catch (e) {
      setError('Cannot load data hall layout');
      return null;
    }
  }, []);

  const fetchSnapshot = useCallback(async (id) => {
    const hid = id || hallId;
    if (!hid) return;
    try {
      const res = await fetch(`${API_BASE}/api/halls/${hid}/fleet-snapshot`);
      if (res.status === 403) {
        setError('Viewer access is disabled by the coordinator');
        setSnapshot(null);
        return;
      }
      if (!res.ok) throw new Error('Snapshot failed');
      const data = await res.json();
      setSnapshot(data);
      setLastRefresh(new Date());
      setError('');
    } catch {
      setError('Cannot reach coordinator hub');
    }
  }, [hallId]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await fetchHub();
      const id = await fetchHall();
      if (id) await fetchSnapshot(id);
      setLoading(false);
    })();
  }, [fetchHub, fetchHall, fetchSnapshot]);

  useEffect(() => {
    if (!hallId) return;
    const interval = setInterval(() => fetchSnapshot(hallId), REFRESH_MS);
    return () => clearInterval(interval);
  }, [hallId, fetchSnapshot]);

  const alerts = useMemo(() => {
    if (!snapshot?.pdus) return [];
    return snapshot.pdus
      .filter(p => p.status !== 'healthy')
      .map(p => ({
        pduId: p.id,
        rackId: p.rack_code,
        severity: p.status === 'healthy' ? 'warning' : p.status === 'warning' ? 'warning' : 'critical',
        title: p.label || p.ip,
        message: p.issues?.join(' · ') || p.status,
      }));
  }, [snapshot]);

  const heatmapByRack = useMemo(() => {
    const map = {};
    if (!snapshot?.pdus) return map;
    for (const p of snapshot.pdus) {
      if (!p.rack_code) continue;
      const load = p.metrics?.load_pct ?? (p.metrics?.online ? Math.max(10, 100 - p.health_score) : 0);
      map[p.rack_code] = map[p.rack_code] != null ? Math.max(map[p.rack_code], load) : load;
    }
    return map;
  }, [snapshot]);

  const fleet = snapshot?.fleet;

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0B1120] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-pulse text-[#00E5FF] text-sm mb-2">Fleet Command Center</div>
          <div className="text-slate-600 text-xs">Connecting to coordinator...</div>
        </div>
      </div>
    );
  }

  if (error && !snapshot) {
    return (
      <div className="min-h-screen bg-[#0B1120] flex items-center justify-center p-6">
        <div className="max-w-md text-center p-8 rounded-2xl bg-[#0f172a] border border-[#233544]">
          <span className="material-icons-outlined text-4xl text-amber-400 mb-4">link_off</span>
          <h1 className="text-white font-bold mb-2">Cannot connect</h1>
          <p className="text-sm text-slate-400 mb-4">{error}</p>
          <p className="text-xs text-slate-600">Ask your IT coordinator for the correct hub URL.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B1120] text-gray-200 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-[#0B1120]/95 backdrop-blur border-b border-[#233544] px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <img src="/logo/pdumind-logo-2.png" alt="PDUMind" className="h-8 w-auto opacity-90" />
            <div>
              <h1 className="text-sm font-bold text-white flex items-center gap-2">
                Fleet Command Center
                <span className="text-[9px] font-normal px-2 py-0.5 rounded bg-[#00E5FF]/10 text-[#00E5FF] border border-[#00E5FF]/30 uppercase tracking-wider">
                  Read-only
                </span>
              </h1>
              <p className="text-[10px] text-slate-500">{hallName}{hubInfo?.hub_name ? ` · ${hubInfo.hub_name}` : ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-slate-500">
            {lastRefresh && (
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Updated {lastRefresh.toLocaleTimeString()}
              </span>
            )}
            <span className="font-mono text-slate-600">refresh {REFRESH_MS / 1000}s</span>
          </div>
        </div>
      </header>

      {/* Fleet stats */}
      {fleet && (
        <div className="px-6 py-4 grid grid-cols-2 md:grid-cols-4 gap-3 border-b border-[#233544]/50">
          {[
            { label: 'Fleet Health', value: `${fleet.avg_health_score}`, unit: '/100', icon: 'favorite', accent: healthColor(fleet.avg_health_score) },
            { label: 'PDUs Online', value: `${fleet.online_pdus}`, unit: `/${fleet.total_pdus}`, icon: 'power', accent: 'text-emerald-400' },
            { label: 'Active Alarms', value: `${fleet.alarm_count}`, unit: '', icon: 'notifications_active', accent: fleet.alarm_count > 0 ? 'text-red-400' : 'text-slate-500' },
            { label: 'Fleet Status', value: fleet.status, unit: '', icon: 'dashboard', accent: fleet.status === 'healthy' ? 'text-emerald-400' : fleet.status === 'warning' ? 'text-amber-400' : 'text-red-400' },
          ].map(stat => (
            <div key={stat.label} className="p-3 rounded-xl bg-[#161E2E] border border-[#233544]">
              <div className="flex items-center gap-2 mb-1">
                <span className={`material-icons-outlined text-sm ${stat.accent}`}>{stat.icon}</span>
                <span className="text-[9px] text-slate-500 uppercase tracking-wider">{stat.label}</span>
              </div>
              <div className={`text-xl font-bold font-mono capitalize ${stat.accent}`}>
                {stat.value}<span className="text-xs text-slate-500 ml-1">{stat.unit}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Main: attention list + 3D */}
      <div className="flex-1 flex min-h-0">
        {/* Attention list */}
        <aside className="w-72 shrink-0 border-r border-[#233544] bg-[#0f172a] overflow-y-auto hidden lg:block">
          <div className="p-4 border-b border-[#233544]">
            <h2 className="text-xs font-bold text-white flex items-center gap-2">
              <span className="material-icons-outlined text-amber-400 text-sm">priority_high</span>
              Needs Attention
            </h2>
            <p className="text-[10px] text-slate-500 mt-1">Sorted by health score</p>
          </div>
          <div className="p-3 space-y-2">
            {(snapshot?.attention || []).length === 0 ? (
              <div className="text-center py-8 text-slate-600 text-xs">
                <span className="material-icons-outlined text-2xl text-emerald-500/50 mb-2">verified</span>
                <p>All PDUs healthy</p>
              </div>
            ) : (
              snapshot.attention.map(pdu => {
                const si = statusIcon(pdu.status);
                return (
                  <div key={pdu.ip} className={`p-3 rounded-lg border ${healthBg(pdu.health_score)}`}>
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <span className="text-xs font-medium text-white truncate">{pdu.label}</span>
                      <span className={`text-xs font-mono font-bold ${healthColor(pdu.health_score)}`}>{pdu.health_score}</span>
                    </div>
                    <p className="text-[10px] font-mono text-slate-500 mb-1">{pdu.ip}</p>
                    <div className="flex items-center gap-1">
                      <span className={`material-icons-outlined text-xs ${si.color}`}>{si.icon}</span>
                      <span className={`text-[10px] ${si.color}`}>
                        {pdu.issues?.[0] || pdu.status}
                      </span>
                    </div>
                    {pdu.metrics?.power_w != null && (
                      <p className="text-[10px] text-slate-600 mt-1 font-mono">{pdu.metrics.power_w.toFixed(0)} W</p>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Full PDU list */}
          <div className="p-4 border-t border-[#233544]">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">All PDUs</h3>
            <div className="space-y-1">
              {(snapshot?.pdus || []).map(pdu => (
                <div key={pdu.ip} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-[#161E2E]">
                  <span className="text-[10px] text-slate-400 truncate flex-1">{pdu.label}</span>
                  <span className={`text-[10px] font-mono font-bold ml-2 ${healthColor(pdu.health_score)}`}>{pdu.health_score}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* 3D heatmap */}
        <main className="flex-1 min-w-0 relative">
          {hallId ? (
            <DataHallDesigner
              readOnly
              selectedHallId={hallId}
              alerts={alerts}
              heatmapByRack={heatmapByRack}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-slate-600 text-sm">No hall configured</div>
          )}
        </main>
      </div>

      <footer className="border-t border-[#233544] px-6 py-2 flex justify-between text-[10px] text-slate-600 font-mono">
        <span>Powered by Aility Pte Ltd</span>
        <span>Viewer mode — coordinator login at /</span>
      </footer>
    </div>
  );
}
