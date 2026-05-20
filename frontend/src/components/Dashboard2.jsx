import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import api from '../api';
import DataHallDesigner from './DataHallDesigner/DataHallDesigner';
import CommissioningWizard from './CommissioningWizard';
import PDUSettingsPanel from './PDUSettingsPanel';

// API base URL
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5002';

// Outlet Card Component matching reference design
const OutletCard = ({ number, data, pduIp, onToggleComplete, isWebAdmin }) => {
  const statusItem = data?.results?.find(r => r.name === `OutletStatus${number}` || r.name === `Output${number}Status`);
  const currentItem = data?.results?.find(r => r.name === `OutletCurrent${number}` || r.name === `Output${number}Current`);
  const energyItem = data?.results?.find(r => r.name === `OutletEnergy${number}` || r.name === `Output${number}Energy`);
  
  const status = statusItem?.value?.replace(/"/g, '').trim();
  const current = parseFloat(currentItem?.value?.replace(/"/g, '') || '0');
  const energy = parseFloat(energyItem?.value?.replace(/"/g, '') || '0') / 10;
  
  // Web admin returns "Normal"/"Off"/"-" for breakers; SNMP returns "ON"/"OFF"
  const statusLower = (status || '').toLowerCase();
  const isOn = statusLower === 'on' || statusLower === 'normal';
  const isUninstalled = !status || status === '-';
  const hasLoad = current > 0;
  const isHighLoad = current > 1.2;
  const isIdle = isOn && !hasLoad;
  
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    const newState = isOn ? 'off' : 'on';
    try {
      setLoading(true);
      await api.put(`/api/outlet/${number}/status`, { state: newState, ip: pduIp });
      // Trigger backend poll to get fresh data from PDU, then refresh UI
      if (pduIp) {
        setTimeout(async () => {
          try {
            await fetch(`/api/polling/device/${pduIp}/trigger`, { method: 'POST' });
            // Wait for poll to complete, then refresh
            setTimeout(() => {
              if (onToggleComplete) onToggleComplete();
            }, 1000);
          } catch (err) {
            console.error('Poll trigger failed:', err);
            if (onToggleComplete) onToggleComplete();
          }
        }, 500);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const getStatusLabel = () => {
    if (isUninstalled) return { text: 'N/A', color: 'text-slate-600', dot: 'bg-slate-600' };
    if (!isOn) return { text: 'Off', color: 'text-slate-500', dot: 'bg-slate-500' };
    if (isHighLoad) return { text: 'Alert', color: 'text-red-400', dot: 'bg-red-500' };
    if (isIdle && !isWebAdmin) return { text: 'Idle', color: 'text-amber-400', dot: 'bg-amber-500' };
    return { text: 'Normal', color: 'text-emerald-400', dot: 'bg-emerald-500' };
  };

  const statusInfo = getStatusLabel();

  if (isUninstalled) return null;

  return (
    <div className={`bg-[#161E2E] rounded-lg border ${isHighLoad ? 'border-red-500/50' : 'border-[#233544]'} p-4 ${!isOn ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-slate-500 uppercase tracking-wider">OUTLET</span>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] ${statusInfo.color}`}>{statusInfo.text}</span>
          <span className={`w-2 h-2 rounded-full ${statusInfo.dot}`}></span>
        </div>
      </div>
      
      <div className="text-2xl font-bold font-mono text-white mb-4">
        {isWebAdmin ? `B${String(number).padStart(2, '0')}` : `A${String(number).padStart(2, '0')}`}
      </div>
      
      {!isWebAdmin && (
        <div className="space-y-2 mb-4">
          <div className="flex justify-between items-baseline">
            <span className="text-[10px] text-slate-500 uppercase">Current</span>
            <span className={`text-lg font-mono font-bold ${isHighLoad ? 'text-red-400' : 'text-white'}`}>
              {current.toFixed(2)}<span className="text-xs text-slate-500 ml-1">A</span>
            </span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-[10px] text-slate-500 uppercase">Energy</span>
            <span className="text-sm font-mono text-slate-400">
              {energy.toFixed(1)}<span className="text-xs text-slate-500 ml-1">kWh</span>
            </span>
          </div>
        </div>
      )}

      {isWebAdmin && (
        <div className="mb-4">
          <span className={`text-xs font-mono ${isOn ? 'text-emerald-400' : 'text-slate-500'}`}>
            {status || '-'}
          </span>
        </div>
      )}
      
      {!isWebAdmin && (
        <button
          onClick={handleToggle}
          disabled={loading}
          className={`w-full py-2.5 text-xs font-bold uppercase tracking-wider rounded transition-all ${
            isOn 
              ? 'bg-[#334155] text-slate-300 hover:bg-[#475569] border border-[#475569]' 
              : 'bg-[#00E5FF]/20 text-[#00E5FF] hover:bg-[#00E5FF]/30 border border-[#00E5FF]/30'
          } ${loading ? 'opacity-50' : ''}`}
        >
          {loading ? '...' : isOn ? 'TURN OFF' : 'TURN ON'}
        </button>
      )}
    </div>
  );
};

// Specs Table Row
const SpecRow = ({ label, value }) => (
  <div className="flex justify-between py-3 border-b border-[#233544]">
    <span className="text-xs text-slate-500">{label}</span>
    <span className="text-xs font-mono text-slate-300">{value}</span>
  </div>
);

// Insight Card
const InsightCard = ({ icon, iconBg, title, description, actionLabel, actionStyle, severity }) => (
  <div className={`p-4 rounded-lg bg-[#161E2E] border ${severity === 'warning' ? 'border-red-500/30' : 'border-[#233544]'}`}>
    <div className="flex items-start gap-4">
      <div className={`w-10 h-10 rounded-full ${iconBg} flex items-center justify-center flex-shrink-0`}>
        <span className="material-icons-outlined text-sm">{icon}</span>
      </div>
      <div className="flex-1">
        <h4 className={`text-sm font-semibold mb-1 ${severity === 'warning' ? 'text-red-400' : 'text-white'}`}>{title}</h4>
        <p className="text-xs text-slate-500 leading-relaxed mb-3">{description}</p>
        <button className={`px-3 py-1.5 text-[10px] font-bold rounded uppercase tracking-tight transition-all ${actionStyle}`}>
          {actionLabel}
        </button>
      </div>
    </div>
  </div>
);

const Dashboard2 = () => {
  const [data, setData] = useState(null);
  const [activeTab, setActiveTab] = useState('datahall');
  const [expandedPdu, setExpandedPdu] = useState(null);
  const [selectedPdu, setSelectedPdu] = useState(null);
  
  // Real-time chart history (last 60 data points = 1 minute at 1s intervals)
  const [powerHistory, setPowerHistory] = useState([]);
  const [timeLabels, setTimeLabels] = useState([]);
  
  // Chart mode: 'realtime' or 'historical'
  const [chartMode, setChartMode] = useState('realtime');
  const [chartPeriod, setChartPeriod] = useState('day'); // day, week, month
  const [historicalData, setHistoricalData] = useState([]);
  const [historicalLabels, setHistoricalLabels] = useState([]);
  const [historicalRawData, setHistoricalRawData] = useState([]); // Full data with voltage, current, energy
  const [loadingHistory, setLoadingHistory] = useState(false);
  
  // Chart tooltip state
  const [chartTooltip, setChartTooltip] = useState({ visible: false, x: 0, y: 0, data: null });
  
  // Use local selectedPdu only — never fall back to the legacy context PDU
  const activePdu = useMemo(() => selectedPdu, [selectedPdu?.ip, selectedPdu?.port, selectedPdu?.remote_host]);

  // Hall management state
  const [halls, setHalls] = useState([]);
  const [selectedHallId, setSelectedHallId] = useState(null);
  const [selectedHall, setSelectedHall] = useState(null);
  const [hallPDUs, setHallPDUs] = useState([]);
  const [hallLoading, setHallLoading] = useState(true);
  const activePduFull = useMemo(() => hallPDUs.find(p => p.ip === activePdu?.ip) || activePdu, [hallPDUs, activePdu?.ip]);

  // PDU filter state: 'all', 'live', 'offline'
  const [pduFilter, setPduFilter] = useState('all');
  const [pduLiveStatus, setPduLiveStatus] = useState({}); // { ip: 'online'|'offline' }
  const [pduAlarms, setPduAlarms] = useState({}); // { ip: { count: N, flags: [...] } }
  const [ledgerExpandedPdu, setLedgerExpandedPdu] = useState(null); // IP of expanded PDU in ledger
  
  // Commissioning wizard state
  const [showWizard, setShowWizard] = useState(false);
  
  // PDU edit/delete state
  const [editingPduId, setEditingPduId] = useState(null);
  const [editingPduLabel, setEditingPduLabel] = useState('');
  const [deletingPduId, setDeletingPduId] = useState(null);
  
  // Fetch all halls
  const fetchHalls = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/halls`);
      if (response.ok) {
        const data = await response.json();
        return data.halls || [];
      }
    } catch (error) {
      console.log('[Dashboard2] Failed to fetch halls:', error);
    }
    return [];
  }, []);
  
  // Fetch hall state with PDUs (silent=true skips loading indicator to avoid blinking)
  const fetchHallState = useCallback(async (hallId, silent = false) => {
    try {
      if (!silent) setHallLoading(true);
      const response = await fetch(`${API_BASE}/api/halls/${hallId}/state`);
      if (response.ok) {
        const data = await response.json();
        setSelectedHall(data.hall);
        
        // Only show commissioned PDUs from DB — never generate phantom PDUs from layout
        if (data.pdus && data.pdus.length > 0) {
          const pdusWithStatus = data.pdus.map((pdu, idx) => ({
            id: pdu.id || `pdu-${pdu.ip_address}-${idx}`,
            label: pdu.hostname || pdu.label || pdu.device_name || `PDU-${String(idx + 1).padStart(2, '0')}`,
            ip: pdu.ip_address,
            port: pdu.snmp_port || '161',
            location: pdu.rack_code || 'Unknown',
            status: 'normal',
            dbId: pdu.id,
            mac_address: pdu.mac_address || '',
            remote_host: pdu.remote_host || '',
            web_admin_port: pdu.web_admin_port,
            web_admin_user: pdu.web_admin_user,
            web_admin_pass: pdu.web_admin_pass,
          }));
          setHallPDUs(pdusWithStatus);
          // Auto-select first PDU if nothing selected yet or selected PDU isn't in this hall
          if (!silent) {
            const first = pdusWithStatus[0];
            if (first) {
              setSelectedPdu({ ip: first.ip, port: first.port || '161', remote_host: first.remote_host });
              setExpandedPdu(first.id);
              setActiveTab('telemetry');
            }
          }
        } else {
          setHallPDUs([]);
          setSelectedPdu(null);
        }
      }
    } catch (error) {
      console.log('[Dashboard2] Failed to fetch hall state:', error);
      setHallPDUs([]);
    } finally {
      if (!silent) setHallLoading(false);
    }
  }, []);
  
  // Initialize halls on mount
  useEffect(() => {
    const init = async () => {
      const hallsList = await fetchHalls();
      setHalls(hallsList);
      if (hallsList.length > 0) {
        setSelectedHallId(hallsList[0].id);
        await fetchHallState(hallsList[0].id);
      } else {
        setHallLoading(false);
      }
    };
    init();
  }, [fetchHalls, fetchHallState]);
  
  // Fetch hall state when selection changes
  useEffect(() => {
    if (selectedHallId) {
      fetchHallState(selectedHallId);
    }
  }, [selectedHallId, fetchHallState]);
  
  // Fetch live status for all PDUs in the hall
  useEffect(() => {
    if (hallPDUs.length === 0) return;
    
    const fetchLiveStatus = async () => {
      const statusMap = {};
      const alarmMap = {};
      for (const pdu of hallPDUs) {
        if (!pdu.ip) continue;
        try {
          const rh = pdu.remote_host ? `?remote_host=${encodeURIComponent(pdu.remote_host)}` : '';
          const response = await fetch(`${API_BASE}/api/polling/device/${pdu.ip}${rh}`);
          if (response.ok) {
            const data = await response.json();
            statusMap[pdu.ip] = data.state?.includes('online') ? 'online' : 'offline';
          } else {
            statusMap[pdu.ip] = 'offline';
          }
          // Fetch alarm data from live telemetry
          if (statusMap[pdu.ip] === 'online') {
            try {
              const liveRes = await fetch(`${API_BASE}/api/pdus/by-ip/${pdu.ip}/live${rh}`);
              if (liveRes.ok) {
                const liveData = await liveRes.json();
                const flagsEntry = liveData.results?.find(r => r.name === '_alarm_flags');
                const countEntry = liveData.results?.find(r => r.name === '_alarm_count');
                const count = parseInt(countEntry?.value || '0', 10);
                let flags = [];
                try { flags = JSON.parse(flagsEntry?.value || '[]'); } catch {}
                const alarmEntries = (liveData.results || [])
                  .filter(r => r.name.startsWith('alarm_') && !r.name.endsWith('_color') && r.name !== 'alarm_status' && r.name !== 'alarm_color')
                  .map(r => ({ key: r.name, value: r.value?.replace?.(/"/g, '').trim() || r.value }));
                alarmMap[pdu.ip] = { count, flags, entries: alarmEntries, ts: new Date().toISOString() };
              }
            } catch {}
          }
        } catch {
          statusMap[pdu.ip] = 'offline';
        }
      }
      setPduLiveStatus(statusMap);
      setPduAlarms(alarmMap);
    };
    
    fetchLiveStatus();
    const interval = setInterval(fetchLiveStatus, 10000); // Check every 10 seconds
    return () => clearInterval(interval);
  }, [hallPDUs]);
  
  // Filter PDUs based on selected filter
  const filteredPDUs = hallPDUs.filter(pdu => {
    if (pduFilter === 'all') return true;
    const status = pduLiveStatus[pdu.ip] || 'offline';
    if (pduFilter === 'live') return status === 'online';
    if (pduFilter === 'offline') return status === 'offline';
    return true;
  });
  
  // Use filtered PDUs for the PDU list
  const generatedPDUs = filteredPDUs;

  // Global alarm computation
  const globalAlarmCount = useMemo(() => {
    return Object.values(pduAlarms).reduce((sum, a) => sum + (a.count || 0), 0);
  }, [pduAlarms]);
  const alarmedPduCount = useMemo(() => {
    return Object.values(pduAlarms).filter(a => a.count > 0).length;
  }, [pduAlarms]);

  // Build alerts array for 3D canvas
  const rackAlerts = useMemo(() => {
    const alerts = [];
    for (const pdu of hallPDUs) {
      const alarm = pduAlarms[pdu.ip];
      if (alarm && alarm.count > 0) {
        alerts.push({
          pduId: pdu.id,
          rackId: pdu.rack_id,
          severity: 'critical',
          title: `${alarm.count} Alarm${alarm.count > 1 ? 's' : ''}`,
          message: alarm.flags.map(f => f.param).join(', '),
        });
      }
    }
    return alerts;
  }, [hallPDUs, pduAlarms]);

  const renamePdu = useCallback(async (pduDbId, newLabel) => {
    if (!pduDbId || !newLabel.trim()) return;
    try {
      await fetch(`${API_BASE}/api/pdus/${pduDbId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newLabel.trim() })
      });
      if (selectedHallId) fetchHallState(selectedHallId, true);
    } catch (e) {
      console.error('Rename PDU failed:', e);
    }
    setEditingPduId(null);
  }, [selectedHallId, fetchHallState]);

  const deletePdu = useCallback(async (pduDbId) => {
    if (!pduDbId) return;
    try {
      await fetch(`${API_BASE}/api/pdus/${pduDbId}`, { method: 'DELETE' });
      if (selectedHallId) fetchHallState(selectedHallId, true);
    } catch (e) {
      console.error('Delete PDU failed:', e);
    }
    setDeletingPduId(null);
    setExpandedPdu(null);
  }, [selectedHallId, fetchHallState]);

  const lastGoodDataRef = useRef(null);
  const refreshData = useCallback(async () => {
    if (!activePdu?.ip) return;
    try {
      const rh = activePdu.remote_host ? `?remote_host=${encodeURIComponent(activePdu.remote_host)}` : '';
      const response = await fetch(`/api/pdus/by-ip/${activePdu.ip}/live${rh}`);
      const result = await response.json();
      const hasResults = result?.results?.length > 0;
      if (hasResults) {
        // Check if the new data contains any real telemetry values (not all zeros)
        const hasRealValues = result.results.some(r => {
          if (r.name?.startsWith('_') || r.name?.startsWith('Output')) return false;
          const v = parseFloat(r.value);
          return !isNaN(v) && v !== 0;
        });
        if (hasRealValues) {
          lastGoodDataRef.current = result;
        }
        setData(result);
      } else if (lastGoodDataRef.current) {
        // Empty poll — keep showing last known good data
        setData(lastGoodDataRef.current);
      }
    } catch (error) {
      console.error('Error fetching data:', error);
      // Network error — keep showing last good data
    }
  }, [activePdu?.ip, activePdu?.remote_host]);

  useEffect(() => {
    if (activePdu?.ip) {
      lastGoodDataRef.current = null;
      refreshData();
      const pollMs = activePdu.remote_host ? 10000 : 1000;
      const interval = setInterval(refreshData, pollMs);
      return () => clearInterval(interval);
    }
  }, [activePdu?.ip, activePdu?.remote_host, refreshData]);

  // Extract values from data — strips trailing unit suffixes (V, A, kW, kWh, Hz, etc.)
  const getValue = (name) => {
    const item = data?.results?.find(r => r.name === name);
    if (!item) return null;
    const raw = item.value?.replace(/"/g, '') || '0';
    return raw;
  };

  const parseNumeric = (raw) => {
    if (typeof raw === 'number') return raw;
    const str = String(raw).trim();
    const match = str.match(/^-?[\d.]+/);
    return match ? parseFloat(match[0]) : 0;
  };

  // Try SNMP name first, then web admin CGI field names
  const getNumericValue = (...names) => {
    for (const name of names) {
      const item = data?.results?.find(r => r.name === name);
      if (item) return parseNumeric(item.value?.replace(/"/g, ''));
    }
    return null;
  };

  // Map to NPDU MIB OID names first, fall back to web admin CGI field names
  const voltage = getNumericValue('MasterVoltageP1', 'l1_voltage') ?? 0;
  const current = getNumericValue('MasterCurrentP1', 'l1_current') ?? 0;
  const power = getNumericValue('MasterPowerP1', 'total_active_power', 'l1_active_power') ?? 0;
  const pf = getNumericValue('MasterPFP1', 'total_pf', 'l1_pf') ?? 0;
  const energy = getNumericValue('MasterEnergyP1', 'total_active_energy') ?? 0;
  const voltageL2 = getNumericValue('MasterVoltageP2', 'l2_voltage') ?? 0;
  const voltageL3 = getNumericValue('MasterVoltageP3', 'l3_voltage') ?? 0;

  // Update power history for real-time chart (keep last 60 points)
  const lastDataRef = React.useRef(null);
  useEffect(() => {
    if (!data || data === lastDataRef.current) return;
    lastDataRef.current = data;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setPowerHistory(prev => {
      const updated = [...prev, power || 0];
      return updated.slice(-60);
    });
    setTimeLabels(prev => {
      const updated = [...prev, timeStr];
      return updated.slice(-60);
    });
  }, [data]);

  // Fetch historical data when switching to historical mode or changing period
  useEffect(() => {
    if (chartMode === 'historical' && activePdu?.ip) {
      const fetchHistory = async () => {
        setLoadingHistory(true);
        try {
          const response = await fetch(`/api/pdus/by-ip/${activePdu.ip}/telemetry/chart?period=${chartPeriod}&limit=500`);
          const result = await response.json();
          if (result.data && result.data.length > 0) {
            setHistoricalData(result.data.map(d => d.power || 0));
            setHistoricalRawData(result.data); // Store full data for tooltip
            setHistoricalLabels(result.data.map(d => {
              const date = new Date(d.ts);
              if (chartPeriod === 'day') {
                return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
              } else {
                return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit' });
              }
            }));
          } else {
            setHistoricalData([]);
            setHistoricalRawData([]);
            setHistoricalLabels([]);
          }
        } catch (err) {
          console.error('Failed to fetch historical data:', err);
          setHistoricalData([]);
          setHistoricalRawData([]);
          setHistoricalLabels([]);
        } finally {
          setLoadingHistory(false);
        }
      };
      fetchHistory();
    }
  }, [chartMode, chartPeriod, activePdu?.ip]);
  
  // Handle chart mouse move for tooltip
  const handleChartMouseMove = (e, chartData, rawData) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Calculate which data point we're hovering over
    const chartWidth = rect.width;
    const dataLength = chartData.length;
    if (dataLength === 0) return;
    
    const index = Math.min(Math.floor((x / chartWidth) * dataLength), dataLength - 1);
    const dataPoint = rawData ? rawData[index] : null;
    
    if (dataPoint) {
      setChartTooltip({
        visible: true,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        data: dataPoint
      });
    }
  };
  
  const handleChartMouseLeave = () => {
    setChartTooltip({ visible: false, x: 0, y: 0, data: null });
  };

  const outlets = Array.from({ length: 24 }, (_, i) => i + 1);
  const isWebAdminPdu = !!(activePdu?.remote_host || activePdu?.web_admin_port);
  const activeOutlets = outlets.filter(n => {
    const status = (getValue(`OutletStatus${n}`) || getValue(`Output${n}Status`) || '').replace(/"/g, '').trim().toLowerCase();
    return status === 'on' || status === 'normal';
  }).length;
  const loadedOutlets = outlets.filter(n => {
    const status = (getValue(`OutletStatus${n}`) || getValue(`Output${n}Status`) || '').replace(/"/g, '').trim().toLowerCase();
    const curr = parseFloat(getValue(`OutletCurrent${n}`) || getValue(`Output${n}Current`) || 0);
    return (status === 'on' || status === 'normal') && curr > 0;
  }).length;
  const idleOutlets = activeOutlets - loadedOutlets;

  return (
    <div className="min-h-screen bg-[#0B1120] text-slate-100">
      {/* Global Alarm Banner */}
      {globalAlarmCount > 0 && (
        <div className="bg-red-500/15 border-b border-red-500/40 px-6 py-2 flex items-center gap-3 animate-pulse">
          <span className="material-icons-outlined text-red-400 text-xl">warning</span>
          <span className="text-red-300 text-sm font-bold">
            {globalAlarmCount} Active Alarm{globalAlarmCount > 1 ? 's' : ''} on {alarmedPduCount} PDU{alarmedPduCount > 1 ? 's' : ''}
          </span>
          <span className="text-red-400/60 text-xs font-mono ml-auto">
            {Object.entries(pduAlarms).filter(([,a]) => a.count > 0).map(([ip]) => {
              const pdu = hallPDUs.find(p => p.ip === ip);
              return pdu?.label || pdu?.ip || ip;
            }).join(' • ')}
          </span>
        </div>
      )}
      <div className="flex">
        {/* Sidebar */}
        <aside className="w-72 border-r border-[#233544] bg-[#0B1120] min-h-[calc(100vh-4rem)] p-4 overflow-y-auto">
          {/* Data Hall Designer - Top Section */}
          <div className="mb-6">
            <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-3">
              Infrastructure
            </h3>
            <button
              onClick={() => { setActiveTab('datahall'); setExpandedPdu(null); }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-left ${
                activeTab === 'datahall' 
                  ? 'bg-[#00E5FF]/10 text-[#00E5FF] border-l-2 border-[#00E5FF]' 
                  : 'text-slate-400 hover:bg-[#161E2E] hover:text-[#00E5FF]'
              }`}
            >
              <span className="material-icons-outlined text-lg">view_in_ar</span>
              <span className="text-sm font-medium">Data Hall Designer</span>
            </button>
            <button
              onClick={() => { setActiveTab('ledger'); setExpandedPdu(null); }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-left mt-1 ${
                activeTab === 'ledger'
                  ? 'bg-[#00E5FF]/10 text-[#00E5FF] border-l-2 border-[#00E5FF]'
                  : globalAlarmCount > 0
                    ? 'bg-red-500/10 text-red-400 border-l-2 border-red-500 hover:bg-red-500/15'
                    : 'text-slate-400 hover:bg-[#161E2E] hover:text-[#00E5FF]'
              }`}
            >
              <span className={`material-icons-outlined text-lg ${globalAlarmCount > 0 && activeTab !== 'ledger' ? 'animate-pulse' : ''}`}>
                {globalAlarmCount > 0 ? 'warning_amber' : 'history_edu'}
              </span>
              <span className="text-sm font-medium">Alarm Ledger</span>
              {globalAlarmCount > 0 && (
                <span className="ml-auto px-1.5 py-0.5 rounded bg-red-500 text-white text-[10px] font-mono font-bold">{globalAlarmCount}</span>
              )}
            </button>
          </div>

          {/* Hall Selector */}
          <div className="mb-6">
            <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-3">
              Data Hall
            </h3>
            <select
              value={selectedHallId || ''}
              onChange={(e) => setSelectedHallId(parseInt(e.target.value))}
              className="w-full bg-[#161E2E] border border-[#233544] rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-[#00E5FF]"
            >
              {halls.map(hall => (
                <option key={hall.id} value={hall.id}>{hall.name}</option>
              ))}
            </select>
            {selectedHall && (
              <p className="text-[9px] text-slate-600 mt-1 px-1">
                ID: {selectedHall.id} • {new Date(selectedHall.created_at).toLocaleDateString()}
              </p>
            )}
          </div>

          {/* PDU Tree Navigation */}
          <div className="mb-6 flex flex-col" style={{ maxHeight: '40vh' }}>
            <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2 flex items-center justify-between flex-shrink-0">
              <span>PDU Monitoring</span>
              <span className="text-[#00E5FF]">{generatedPDUs.length}/{hallPDUs.length}</span>
            </h3>
            
            {/* Live/Offline Filter Toggle */}
            <div className="flex gap-1 mb-3 flex-shrink-0">
              {[
                { id: 'all', label: 'All', count: hallPDUs.length },
                { id: 'live', label: 'Live', count: hallPDUs.filter(p => pduLiveStatus[p.ip] === 'online').length, color: 'emerald' },
                { id: 'offline', label: 'Offline', count: hallPDUs.filter(p => pduLiveStatus[p.ip] !== 'online').length, color: 'slate' },
              ].map(filter => (
                <button
                  key={filter.id}
                  onClick={() => setPduFilter(filter.id)}
                  className={`flex-1 py-1.5 px-2 text-[10px] rounded transition-all ${
                    pduFilter === filter.id
                      ? filter.color === 'emerald' 
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50'
                        : filter.color === 'slate'
                        ? 'bg-slate-500/20 text-slate-400 border border-slate-500/50'
                        : 'bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/50'
                      : 'bg-[#161E2E] text-slate-500 border border-transparent hover:border-[#233544]'
                  }`}
                >
                  {filter.label} ({filter.count})
                </button>
              ))}
            </div>
            
            {hallLoading ? (
              <div className="text-center py-4 text-slate-500 text-xs">Loading PDUs...</div>
            ) : generatedPDUs.length === 0 ? (
              <div className="text-center py-4 text-slate-600 text-xs">
                No PDUs configured.<br/>
                <span className="text-slate-500">Use Data Hall Designer to add PDUs.</span>
              </div>
            ) : (
            <div className="space-y-1 overflow-y-auto flex-1 pr-1" style={{ scrollbarWidth: 'thin', scrollbarColor: '#233544 transparent' }}>
              {generatedPDUs.map(pdu => (
                <div key={pdu.id} id={`pdu-item-${pdu.id}`}>
                  {/* PDU Header */}
                  <button
                    onClick={() => {
                      const isExpanding = expandedPdu !== pdu.id;
                      setExpandedPdu(isExpanding ? pdu.id : null);
                      // Set active PDU for telemetry when expanding
                      if (isExpanding && pdu.ip) {
                        setSelectedPdu({ ip: pdu.ip, port: pdu.port || '161', remote_host: pdu.remote_host });
                        setActiveTab('telemetry'); // Switch to telemetry view
                      }
                    }}
                    className={`w-full flex flex-col px-3 py-2 rounded-lg transition-colors text-left ${
                      expandedPdu === pdu.id 
                        ? 'bg-[#161E2E] text-white' 
                        : 'text-slate-400 hover:bg-[#161E2E]'
                    }`}
                  >
                    {/* Row 1: Chevron + Label */}
                    <div className="flex items-center gap-2">
                      <span className={`material-icons-outlined text-sm ${expandedPdu === pdu.id ? 'rotate-90' : ''} transition-transform`}>
                        chevron_right
                      </span>
                      <span className="text-sm font-medium">{pdu.label || pdu.id}</span>
                    </div>
                    {/* Row 2: Status dot + LIVE + IP */}
                    <div className="flex items-center gap-2 ml-6 mt-1">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        pduLiveStatus[pdu.ip] === 'online' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'
                      }`}></span>
                      <span className={`text-[8px] uppercase font-bold ${
                        pduLiveStatus[pdu.ip] === 'online' ? 'text-emerald-400' : 'text-slate-500'
                      }`}>
                        {pduLiveStatus[pdu.ip] === 'online' ? 'LIVE' : 'OFF'}
                      </span>
                      <span className="text-[10px] text-slate-500 font-mono">{pdu.ip}</span>
                    </div>
                  </button>
                  
                  {/* PDU Monitoring Options - Expanded */}
                  {expandedPdu === pdu.id && (
                    <div className="ml-6 mt-1 space-y-0.5 border-l border-[#233544] pl-2">
                      <p className="text-[9px] text-slate-600 px-2 py-1">{pdu.location}</p>
                      {pdu.mac_address && (
                        <p className="text-[9px] text-slate-600 px-2 pb-1">MAC: <span className="font-mono">{pdu.mac_address}</span></p>
                      )}
                      {[
                        { id: 'telemetry', icon: 'analytics', label: 'Telemetry' },
                        { id: 'warnings', icon: 'warning_amber', label: 'Warnings', alarmCount: pduAlarms[pdu.ip]?.count || 0 },
                        { id: 'outlets', icon: 'power', label: 'Outlets' },
                        { id: 'specs', icon: 'info', label: 'Specs', inactive: true },
                        { id: 'insights', icon: 'psychology', label: 'AI Insights', inactive: true },
                        ...(pdu.web_admin_port ? [{ id: 'pdu-settings', icon: 'settings', label: 'PDU Settings' }] : []),
                      ].map(item => (
                        <button
                          key={item.id}
                          onClick={() => !item.inactive && setActiveTab(item.id)}
                          disabled={item.inactive}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded transition-colors text-left text-xs ${
                            item.inactive
                              ? 'text-slate-600 opacity-40 cursor-not-allowed'
                              : item.alarmCount > 0
                                ? 'bg-red-500/15 text-red-400 border border-red-500/30'
                              : activeTab === item.id && expandedPdu === pdu.id
                                ? 'bg-[#00E5FF]/10 text-[#00E5FF]' 
                                : 'text-slate-500 hover:bg-[#161E2E] hover:text-slate-300'
                          }`}
                        >
                          <span className={`material-icons-outlined text-sm ${item.alarmCount > 0 ? 'text-red-400' : ''}`}>{item.icon}</span>
                          <span>{item.label}</span>
                          {item.alarmCount > 0 && (
                            <span className="ml-auto bg-red-500 text-white text-[9px] font-bold font-mono px-1.5 py-0.5 rounded-full animate-pulse">{item.alarmCount}</span>
                          )}
                          {item.id === 'warnings' && !item.alarmCount && (
                            <span className="ml-auto text-[9px] text-emerald-500">Normal</span>
                          )}
                          {item.inactive && <span className="ml-auto text-[8px] uppercase tracking-wider text-slate-600">inactive</span>}
                        </button>
                      ))}
                      
                      {/* Edit / Delete actions */}
                      {pdu.dbId && (
                        <div className="mt-1 pt-1 border-t border-[#233544]/50">
                          {/* Inline rename */}
                          {editingPduId === pdu.dbId ? (
                            <div className="px-2 py-1">
                              <input
                                type="text" value={editingPduLabel}
                                onChange={e => setEditingPduLabel(e.target.value)}
                                className="w-full bg-[#0B1120] border border-amber-500/50 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none"
                                autoFocus
                                onKeyDown={e => {
                                  if (e.key === 'Enter') renamePdu(pdu.dbId, editingPduLabel);
                                  if (e.key === 'Escape') setEditingPduId(null);
                                }}
                              />
                              <div className="flex gap-1 mt-1">
                                <button onClick={() => renamePdu(pdu.dbId, editingPduLabel)}
                                  className="flex-1 px-1.5 py-0.5 bg-amber-500/20 text-amber-400 text-[10px] rounded hover:bg-amber-500/30">Save</button>
                                <button onClick={() => setEditingPduId(null)}
                                  className="px-1.5 py-0.5 bg-slate-500/20 text-slate-400 text-[10px] rounded hover:bg-slate-500/30">Cancel</button>
                              </div>
                            </div>
                          ) : deletingPduId === pdu.dbId ? (
                            <div className="px-2 py-1">
                              <p className="text-[10px] text-red-400 mb-1">Delete this PDU permanently?</p>
                              <div className="flex gap-1">
                                <button onClick={() => deletePdu(pdu.dbId)}
                                  className="flex-1 px-1.5 py-0.5 bg-red-500/20 text-red-400 text-[10px] rounded hover:bg-red-500/30 font-bold">Delete</button>
                                <button onClick={() => setDeletingPduId(null)}
                                  className="px-1.5 py-0.5 bg-slate-500/20 text-slate-400 text-[10px] rounded hover:bg-slate-500/30">Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex gap-1 px-2 py-1">
                              <button
                                onClick={(e) => { e.stopPropagation(); setEditingPduId(pdu.dbId); setEditingPduLabel(pdu.label || ''); }}
                                className="flex-1 flex items-center justify-center gap-1 px-1.5 py-1 bg-amber-500/10 text-amber-400 text-[10px] rounded hover:bg-amber-500/20 transition-colors"
                              >
                                <span className="material-icons-outlined" style={{fontSize:'11px'}}>edit</span>
                                Rename
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); setDeletingPduId(pdu.dbId); }}
                                className="flex-1 flex items-center justify-center gap-1 px-1.5 py-1 bg-red-500/10 text-red-400 text-[10px] rounded hover:bg-red-500/20 transition-colors"
                              >
                                <span className="material-icons-outlined" style={{fontSize:'11px'}}>delete</span>
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            )}
            
            {/* Add PDU Button */}
            <button 
              onClick={() => setShowWizard(true)}
              className="w-full mt-3 py-2 bg-[#233544] hover:bg-[#2D4A5E] text-slate-400 hover:text-white font-medium text-xs uppercase tracking-wider rounded-lg flex items-center justify-center gap-2 transition-all">
              <span className="material-icons-outlined text-sm">add</span>
              Commission PDU
            </button>
          </div>

          {/* Quick Stats */}
          <div className="mt-auto pt-4 border-t border-[#233544]">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-[#161E2E] rounded-lg p-2">
                <p className="text-lg font-bold text-[#00E5FF] font-mono">{generatedPDUs.length}</p>
                <p className="text-[9px] text-slate-500 uppercase">PDUs</p>
              </div>
              <div className="bg-[#161E2E] rounded-lg p-2">
                <p className="text-lg font-bold text-red-400 font-mono">{generatedPDUs.filter(p => p.status === 'critical').length}</p>
                <p className="text-[9px] text-slate-500 uppercase">Critical</p>
              </div>
              <div className="bg-[#161E2E] rounded-lg p-2">
                <p className="text-lg font-bold text-amber-400 font-mono">{generatedPDUs.filter(p => p.status === 'warning').length}</p>
                <p className="text-[9px] text-slate-500 uppercase">Warning</p>
              </div>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 p-8 overflow-y-auto">
          {/* No PDU selected placeholder */}
          {!activePdu && activeTab === 'telemetry' && (
            <div className="flex items-center justify-center h-[60vh]">
              <div className="text-center">
                <span className="material-icons-outlined text-5xl text-slate-700 mb-4 block">electrical_services</span>
                <p className="text-slate-400 text-lg mb-2">No PDU selected</p>
                <p className="text-slate-600 text-sm">Use the Data Hall Designer to commission PDUs,<br/>or select one from the sidebar.</p>
              </div>
            </div>
          )}
          {/* Telemetry View */}
          {activeTab === 'telemetry' && activePdu && (
            <>
              {/* Active PDU Info Bar */}
              {activePduFull && (
                <div className="mb-4 p-3 rounded-xl bg-[#161E2E] border border-[#233544] flex items-center gap-4 flex-wrap">
                  {/* Label — only show if it differs from the IP */}
                  {activePduFull.label && activePduFull.label !== activePduFull.ip && (
                    <div className="flex items-center gap-2">
                      <span className="material-icons-outlined text-[#00E5FF] text-sm">dns</span>
                      <span className="text-sm font-bold text-white">{activePduFull.label}</span>
                    </div>
                  )}
                  {/* IP or Remote host */}
                  <div className="flex items-center gap-1.5">
                    {activePduFull.remote_host ? (
                      <>
                        <span className="material-icons-outlined text-amber-400 text-xs">cloud</span>
                        <span className="text-xs font-mono text-amber-300">Remote: {activePduFull.remote_host}:{activePduFull.web_admin_port || 6662}</span>
                      </>
                    ) : (
                      <>
                        <span className="material-icons-outlined text-slate-500 text-xs">lan</span>
                        <span className="text-xs font-mono text-slate-400">{activePduFull.ip}</span>
                      </>
                    )}
                  </div>
                  {activePduFull.mac_address && (
                    <div className="flex items-center gap-1.5">
                      <span className="material-icons-outlined text-slate-500 text-xs">fingerprint</span>
                      <span className="text-xs font-mono text-slate-400">{activePduFull.mac_address}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <span className="material-icons-outlined text-slate-500 text-xs">view_in_ar</span>
                    <span className="text-xs text-slate-400">Rack: <span className="text-white font-mono">{activePduFull.location || 'Unassigned'}</span></span>
                  </div>
                  <div className={`ml-auto flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                    pduLiveStatus[activePduFull.ip] === 'online' 
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
                      : 'bg-slate-500/20 text-slate-400 border border-slate-500/30'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${pduLiveStatus[activePduFull.ip] === 'online' ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
                    {pduLiveStatus[activePduFull.ip] === 'online' ? 'ONLINE' : 'OFFLINE'}
                  </div>
                </div>
              )}

              {/* Page Header */}
              <div className="flex justify-between items-start mb-8">
                <div>
                  <h1 className="text-2xl font-bold uppercase tracking-tight text-[#00E5FF]">
                    Telemetry & Predictive Analysis
                  </h1>
                  <p className="text-slate-500 text-sm mt-1">
                    Real-time monitoring with AI-powered forecasting and environmental correlation.
                  </p>
                </div>
                <div className="flex gap-2">
                  <span className="px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-medium border border-emerald-500/20 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    Real-time Active
                  </span>
                </div>
              </div>

              {/* Metrics Row */}
              <div className="grid grid-cols-5 gap-4 mb-6">
                <div className="bg-[#161E2E] p-5 rounded-xl border border-[#233544]">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Voltage</p>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold font-mono text-white">{voltage.toFixed(1)}</span>
                    <span className="text-slate-500 text-sm">V</span>
                  </div>
                </div>
                <div className="bg-[#161E2E] p-5 rounded-xl border border-[#233544]">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Current</p>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold font-mono text-[#00E5FF]">{current.toFixed(2)}</span>
                    <span className="text-slate-500 text-sm">A</span>
                  </div>
                </div>
                <div className="bg-[#161E2E] p-5 rounded-xl border border-[#233544]">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Active Power</p>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold font-mono text-white">{power.toFixed(1)}</span>
                    <span className="text-slate-500 text-sm">W</span>
                  </div>
                </div>
                <div className="bg-[#161E2E] p-5 rounded-xl border border-[#233544]">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Power Factor</p>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold font-mono text-white">{pf.toFixed(2)}</span>
                  </div>
                </div>
                <div className="bg-[#161E2E] p-5 rounded-xl border border-[#233544]">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Total Energy</p>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold font-mono text-white">{energy.toFixed(1)}</span>
                    <span className="text-slate-500 text-sm">kWh</span>
                  </div>
                </div>
                <div className="bg-[#161E2E] p-5 rounded-xl border border-[#233544] flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Phase Status</p>
                    <div className="flex gap-2">
                      {[voltage, voltageL2, voltageL3].map((v, i) => (
                        <div
                          key={i}
                          className={`w-3 h-3 rounded-full ${
                            v > 200
                              ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
                              : v > 0
                              ? 'bg-amber-500'
                              : 'bg-slate-600'
                          }`}
                          title={`L${i + 1}: ${v.toFixed(1)}V`}
                        />
                      ))}
                    </div>
                  </div>
                  <span className="material-icons-outlined text-slate-700 text-4xl">view_in_ar</span>
                </div>
              </div>

              {/* Charts Row */}
              <div className="grid grid-cols-1 gap-6 mb-6">
                {/* Load Trends Chart */}
                <div className="bg-[#161E2E] rounded-xl border border-[#233544] p-6">
                  <div className="flex justify-between items-center mb-6">
                    <h3 className="font-bold text-[#00E5FF] flex items-center gap-2 uppercase text-sm">
                      <span className="material-icons-outlined text-lg">trending_up</span>
                      Load Trends & Forecasting
                    </h3>
                    <div className="flex items-center gap-4 text-xs">
                      {/* Mode Toggle */}
                      <div className="flex items-center bg-[#0d1929] rounded-lg p-0.5">
                        <button 
                          onClick={() => setChartMode('realtime')}
                          className={`px-3 py-1 rounded-md text-[10px] uppercase transition-all ${
                            chartMode === 'realtime' 
                              ? 'bg-[#00E5FF] text-[#0B1120] font-bold' 
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          Real-time
                        </button>
                        <button 
                          onClick={() => setChartMode('historical')}
                          className={`px-3 py-1 rounded-md text-[10px] uppercase transition-all ${
                            chartMode === 'historical' 
                              ? 'bg-[#00E5FF] text-[#0B1120] font-bold' 
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          Historical
                        </button>
                      </div>
                      {/* Period Filter (only show in historical mode) */}
                      {chartMode === 'historical' && (
                        <div className="flex items-center gap-1 bg-[#0d1929] rounded-lg p-0.5">
                          {['day', 'week', 'month'].map(p => (
                            <button 
                              key={p}
                              onClick={() => setChartPeriod(p)}
                              className={`px-2 py-1 rounded text-[10px] uppercase transition-all ${
                                chartPeriod === p 
                                  ? 'bg-[#1e3a5f] text-[#00E5FF] font-bold' 
                                  : 'text-slate-500 hover:text-slate-300'
                              }`}
                            >
                              {p}
                            </button>
                          ))}
                        </div>
                      )}
                      {/* Legend */}
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full bg-[#00E5FF]"></span>
                        <span className="text-slate-400">Actual Power</span>
                      </div>
                    </div>
                  </div>
                  
                  {/* Chart Area */}
                  <div className="h-[200px] relative border-l border-b border-[#233544]">
                    {/* Y-axis labels */}
                    {(() => {
                      const chartData = chartMode === 'realtime' ? powerHistory : historicalData;
                      const maxVal = chartData.length > 0 ? Math.max(...chartData) * 1.1 : power * 1.1;
                      return (
                        <div className="absolute -left-12 top-0 h-full flex flex-col justify-between text-[9px] font-mono text-slate-500">
                          <span>{maxVal.toFixed(0)}W</span>
                          <span>{(maxVal * 0.5).toFixed(0)}W</span>
                          <span>0W</span>
                        </div>
                      );
                    })()}
                    <svg 
                      className="w-full h-full cursor-crosshair" 
                      viewBox="0 0 800 200" 
                      preserveAspectRatio="none"
                      onMouseMove={(e) => handleChartMouseMove(e, chartMode === 'realtime' ? powerHistory : historicalData, chartMode === 'historical' ? historicalRawData : null)}
                      onMouseLeave={handleChartMouseLeave}
                    >
                      <defs>
                        <linearGradient id="chartGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                          <stop offset="0%" stopColor="#00E5FF" stopOpacity="0.3"/>
                          <stop offset="100%" stopColor="#00E5FF" stopOpacity="0"/>
                        </linearGradient>
                        <linearGradient id="histGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                          <stop offset="0%" stopColor="#10B981" stopOpacity="0.3"/>
                          <stop offset="100%" stopColor="#10B981" stopOpacity="0"/>
                        </linearGradient>
                      </defs>
                      {/* Grid lines */}
                      <line x1="0" y1="50" x2="800" y2="50" stroke="#233544" strokeWidth="1"/>
                      <line x1="0" y1="100" x2="800" y2="100" stroke="#233544" strokeWidth="1"/>
                      <line x1="0" y1="150" x2="800" y2="150" stroke="#233544" strokeWidth="1"/>
                      
                      {/* Real-time chart with scrolling effect */}
                      {chartMode === 'realtime' && powerHistory.length > 1 && (() => {
                        const maxPower = Math.max(...powerHistory) * 1.1 || 1000;
                        // Always use 60 slots, data fills from right to left as it accumulates
                        const totalSlots = 60;
                        const slotWidth = 800 / (totalSlots - 1);
                        const startX = (totalSlots - powerHistory.length) * slotWidth;
                        
                        const points = powerHistory.map((p, i) => {
                          const x = startX + (i * slotWidth);
                          const y = 190 - (p / maxPower) * 180;
                          return `${x} ${y}`;
                        }).join(' L');
                        
                        const lastX = startX + ((powerHistory.length - 1) * slotWidth);
                        const lastY = 190 - (powerHistory[powerHistory.length - 1] / maxPower) * 180;
                        const firstX = startX;
                        const areaPath = `M${firstX} 190 L${points} L${lastX} 190 Z`;
                        const linePath = `M${points}`;
                        
                        return (
                          <g style={{ transition: 'transform 0.3s ease-out' }}>
                            <path d={areaPath} fill="url(#chartGradient)" style={{ transition: 'd 0.3s ease-out' }}/>
                            <path d={linePath} fill="none" stroke="#00E5FF" strokeWidth="2.5" style={{ transition: 'd 0.3s ease-out' }}/>
                            {/* Animated glow trail */}
                            <circle cx={lastX} cy={lastY} r="12" fill="#00E5FF" opacity="0.15">
                              <animate attributeName="r" values="8;16;8" dur="1.5s" repeatCount="indefinite"/>
                              <animate attributeName="opacity" values="0.2;0.05;0.2" dur="1.5s" repeatCount="indefinite"/>
                            </circle>
                            {/* Pulsing dot */}
                            <circle cx={lastX} cy={lastY} r="6" fill="#00E5FF" opacity="0.6">
                              <animate attributeName="r" values="6;10;6" dur="1s" repeatCount="indefinite"/>
                              <animate attributeName="opacity" values="0.6;0.2;0.6" dur="1s" repeatCount="indefinite"/>
                            </circle>
                            <circle cx={lastX} cy={lastY} r="4" fill="#00E5FF"/>
                            {/* Moving scan line effect */}
                            <line x1={lastX} y1="10" x2={lastX} y2="190" stroke="#00E5FF" strokeWidth="1" opacity="0.3">
                              <animate attributeName="opacity" values="0.4;0.1;0.4" dur="1s" repeatCount="indefinite"/>
                            </line>
                          </g>
                        );
                      })()}
                      
                      {/* Historical chart */}
                      {chartMode === 'historical' && !loadingHistory && historicalData.length > 1 && (() => {
                        const maxPower = Math.max(...historicalData) * 1.1 || 1000;
                        const points = historicalData.map((p, i) => {
                          const x = (i / (historicalData.length - 1)) * 800;
                          const y = 190 - (p / maxPower) * 180;
                          return `${x} ${y}`;
                        }).join(' L');
                        const areaPath = `M0 190 L${points} L800 190 Z`;
                        const linePath = `M${points}`;
                        return (
                          <>
                            <path d={areaPath} fill="url(#histGradient)"/>
                            <path d={linePath} fill="none" stroke="#10B981" strokeWidth="2"/>
                          </>
                        );
                      })()}
                      
                      {/* Loading/empty states */}
                      {chartMode === 'realtime' && powerHistory.length <= 1 && (
                        <text x="400" y="100" textAnchor="middle" fill="#475569" fontSize="14">Collecting data...</text>
                      )}
                      {chartMode === 'historical' && loadingHistory && (
                        <text x="400" y="100" textAnchor="middle" fill="#475569" fontSize="14">Loading historical data...</text>
                      )}
                      {chartMode === 'historical' && !loadingHistory && historicalData.length === 0 && (
                        <text x="400" y="100" textAnchor="middle" fill="#475569" fontSize="14">No historical data for this period</text>
                      )}
                    </svg>
                    
                    {/* Chart Tooltip */}
                    {chartTooltip.visible && chartTooltip.data && (
                      <div 
                        className="absolute pointer-events-none z-50 bg-slate-900/95 border border-cyan-500/30 rounded-lg px-3 py-2 shadow-lg shadow-cyan-500/10"
                        style={{
                          left: Math.min(chartTooltip.x + 10, 280),
                          top: Math.max(chartTooltip.y - 80, 10),
                        }}
                      >
                        <div className="text-[10px] text-slate-400 mb-1">
                          {new Date(chartTooltip.data.ts).toLocaleString()}
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                          <div className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-yellow-400"></span>
                            <span className="text-slate-400">Voltage:</span>
                            <span className="text-white font-medium">{chartTooltip.data.voltage?.toFixed(1) || '—'} V</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
                            <span className="text-slate-400">Current:</span>
                            <span className="text-white font-medium">{chartTooltip.data.current?.toFixed(2) || '—'} A</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-green-400"></span>
                            <span className="text-slate-400">Power:</span>
                            <span className="text-white font-medium">{chartTooltip.data.power?.toFixed(1) || '—'} W</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-purple-400"></span>
                            <span className="text-slate-400">Energy:</span>
                            <span className="text-white font-medium">{chartTooltip.data.energy?.toFixed(1) || '—'} kWh</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  
                  {/* Dynamic time labels - show relative time window */}
                  <div className="flex justify-between mt-4 text-[9px] font-mono text-slate-500">
                    {chartMode === 'realtime' ? (
                      <>
                        <span className="opacity-50">-60s</span>
                        <span className="opacity-60">-45s</span>
                        <span className="opacity-70">-30s</span>
                        <span className="opacity-80">-15s</span>
                        <span className="text-[#00E5FF] font-bold flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-[#00E5FF] animate-pulse"></span>
                          {timeLabels.length > 0 ? timeLabels[timeLabels.length - 1] : 'Now'}
                        </span>
                      </>
                    ) : chartMode === 'historical' && historicalLabels.length > 0 ? (
                      <>
                        <span>{historicalLabels[0] || ''}</span>
                        <span>{historicalLabels[Math.floor(historicalLabels.length * 0.25)] || ''}</span>
                        <span>{historicalLabels[Math.floor(historicalLabels.length * 0.5)] || ''}</span>
                        <span>{historicalLabels[Math.floor(historicalLabels.length * 0.75)] || ''}</span>
                        <span className="text-[#10B981] font-bold">{historicalLabels[historicalLabels.length - 1] || ''}</span>
                      </>
                    ) : (
                      <span className="text-slate-600">Waiting for data...</span>
                    )}
                  </div>
                  
                  <div className="mt-4 flex justify-between items-center text-sm border-t border-[#233544] pt-4">
                    <div className="text-slate-500">
                      Peak Demand Today: <span className="font-bold text-white font-mono ml-2">{Math.round(power * 1.03)} W</span>
                    </div>
                    <button className="text-[#00E5FF] hover:underline flex items-center gap-1 text-xs uppercase">
                      Download Report <span className="material-icons-outlined text-sm">download</span>
                    </button>
                  </div>
                </div>

                {/* Environmental — hidden until real sensor data is available from the PDU */}
                {/* TODO: Show this section when the PDU reports actual temperature/humidity readings */}
              </div>

              {/* Bottom Row */}
              <div className="grid grid-cols-1 gap-6">
                {/* AI Analysis — greyed out until connected to a live analysis engine */}
                <div className="bg-[#161E2E] rounded-xl border border-[#233544] p-6 opacity-40 pointer-events-none select-none">
                  <div className="flex items-center gap-2 mb-6">
                    <h3 className="font-bold text-slate-500 flex items-center gap-2 uppercase text-sm">
                      <span className="material-icons-outlined text-lg">insights</span>
                      AI Operational Analysis
                    </h3>
                    <span className="px-2 py-0.5 rounded bg-slate-600 text-slate-300 text-[10px] font-bold uppercase tracking-wider">Inactive</span>
                  </div>
                  <div className="space-y-3">
                    <div className="p-4 rounded-lg bg-[#0B1120] border border-[#233544] flex gap-4 items-start">
                      <span className="material-icons-outlined text-slate-600 mt-0.5">lightbulb</span>
                      <div>
                        <p className="text-sm font-medium text-slate-500">Efficiency Opportunity</p>
                        <p className="text-xs text-slate-600 mt-1">
                          AI analysis will appear here when the analysis engine is connected.
                        </p>
                      </div>
                    </div>
                    <div className="p-4 rounded-lg bg-[#0B1120] border border-[#233544] flex gap-4 items-start">
                      <span className="material-icons-outlined text-slate-600 mt-0.5">warning</span>
                      <div>
                        <p className="text-sm font-medium text-slate-500">Thermal Warning</p>
                        <p className="text-xs text-slate-600 mt-1">
                          Requires environmental sensor data to generate thermal insights.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Warnings View */}
          {activeTab === 'warnings' && (
            <>
              <div className="flex justify-between items-start mb-8">
                <div>
                  <h2 className="text-2xl font-bold uppercase tracking-tight text-white">
                    <span className="material-icons-outlined align-middle mr-2 text-amber-400">warning_amber</span>
                    Alarm Status
                  </h2>
                  <p className="text-xs text-slate-500 mt-1">
                    {activePdu?.label || activePdu?.ip || 'PDU'} — Real-time alarm flags from device
                  </p>
                </div>
              </div>

              {(() => {
                const alarm = pduAlarms[activePdu?.ip];
                const flags = alarm?.flags || [];
                const alarmEntries = activePdu?.ip ? Object.entries(
                  Object.fromEntries(
                    (data?.results || [])
                      .filter(r => r.name.startsWith('alarm_') && !r.name.endsWith('_color') && r.name !== 'alarm_status' && r.name !== 'alarm_color')
                      .map(r => [r.name, r.value])
                  )
                ) : [];

                const PARAM_LABELS = {
                  alarm_l1_voltage: 'Phase L1 Voltage', alarm_l1_current: 'Phase L1 Current',
                  alarm_l2_voltage: 'Phase L2 Voltage', alarm_l2_current: 'Phase L2 Current',
                  alarm_l3_voltage: 'Phase L3 Voltage', alarm_l3_current: 'Phase L3 Current',
                  alarm_neutral: 'Neutral Line', alarm_phase_unbalance: 'Phase Unbalance',
                  alarm_temp1: 'Temperature 1', alarm_hum1: 'Humidity 1',
                  alarm_temp2: 'Temperature 2', alarm_hum2: 'Humidity 2',
                  alarm_temp3: 'Temperature 3', alarm_hum3: 'Humidity 3',
                  alarm_temp4: 'Temperature 4', alarm_hum4: 'Humidity 4',
                  alarm_sensor1: 'IO Sensor 1', alarm_sensor2: 'IO Sensor 2',
                  alarm_sensor3: 'IO Sensor 3', alarm_sensor4: 'IO Sensor 4',
                };

                return (
                  <div className="space-y-4">
                    {/* Summary */}
                    <div className={`p-4 rounded-xl border ${flags.length > 0 ? 'bg-red-500/10 border-red-500/30' : 'bg-emerald-500/10 border-emerald-500/30'}`}>
                      <div className="flex items-center gap-3">
                        <span className={`material-icons-outlined text-3xl ${flags.length > 0 ? 'text-red-400 animate-pulse' : 'text-emerald-400'}`}>
                          {flags.length > 0 ? 'error' : 'check_circle'}
                        </span>
                        <div>
                          <p className={`text-lg font-bold font-mono ${flags.length > 0 ? 'text-red-300' : 'text-emerald-300'}`}>
                            {flags.length > 0 ? `${flags.length} ACTIVE ALARM${flags.length > 1 ? 'S' : ''}` : 'ALL NORMAL'}
                          </p>
                          <p className="text-xs text-slate-500">
                            {flags.length > 0 ? flags.map(f => f.param.replace(/_/g, ' ')).join(', ') : 'No alarms detected on this PDU'}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Device Alarms */}
                    <div className="p-5 rounded-xl bg-[#0B1120] border border-[#233544]">
                      <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                        <span className="material-icons-outlined text-[#00E5FF] text-sm">electric_bolt</span>
                        Device Alarms
                      </h3>
                      <div className="grid grid-cols-2 gap-2">
                        {['alarm_l1_voltage', 'alarm_l1_current', 'alarm_l2_voltage', 'alarm_l2_current',
                          'alarm_l3_voltage', 'alarm_l3_current', 'alarm_neutral', 'alarm_phase_unbalance'
                        ].map(key => {
                          const val = alarmEntries.find(([k]) => k === key)?.[1] || '-';
                          const isNormal = !val || val === '-' || val.toLowerCase() === 'normal';
                          return (
                            <div key={key} className={`flex items-center justify-between px-3 py-2 rounded-lg border ${
                              isNormal ? 'bg-[#161E2E] border-[#233544]' : 'bg-red-500/15 border-red-500/40'
                            }`}>
                              <span className="text-xs text-slate-400">{PARAM_LABELS[key] || key}</span>
                              <span className={`text-xs font-mono font-bold ${isNormal ? 'text-emerald-400' : 'text-red-400'}`}>
                                {isNormal ? 'Normal' : val}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Sensor Alarms */}
                    <div className="p-5 rounded-xl bg-[#0B1120] border border-[#233544]">
                      <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                        <span className="material-icons-outlined text-emerald-400 text-sm">thermostat</span>
                        Sensor Alarms
                      </h3>
                      <div className="grid grid-cols-2 gap-2">
                        {['alarm_temp1', 'alarm_hum1', 'alarm_temp2', 'alarm_hum2',
                          'alarm_temp3', 'alarm_hum3', 'alarm_temp4', 'alarm_hum4',
                          'alarm_sensor1', 'alarm_sensor2', 'alarm_sensor3', 'alarm_sensor4'
                        ].map(key => {
                          const val = alarmEntries.find(([k]) => k === key)?.[1] || '-';
                          const isNormal = !val || val === '-' || val.toLowerCase() === 'normal';
                          return (
                            <div key={key} className={`flex items-center justify-between px-3 py-2 rounded-lg border ${
                              isNormal ? 'bg-[#161E2E] border-[#233544]' : 'bg-red-500/15 border-red-500/40'
                            }`}>
                              <span className="text-xs text-slate-400">{PARAM_LABELS[key] || key}</span>
                              <span className={`text-xs font-mono font-bold ${isNormal ? 'text-emerald-400' : 'text-red-400'}`}>
                                {isNormal ? 'Normal' : val}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </>
          )}

          {/* Outlets View */}
          {activeTab === 'outlets' && (
            <>
              <div className="flex justify-between items-start mb-8">
                <div>
                  <h1 className="text-2xl font-bold uppercase tracking-tight text-white">
                    {isWebAdminPdu ? 'BREAKERS' : 'OUTPUTS'}
                  </h1>
                  <p className="text-slate-500 text-sm mt-1">
                    {isWebAdminPdu
                      ? `${activeOutlets} active breaker${activeOutlets !== 1 ? 's' : ''} detected`
                      : `Managing 24 individual outlets for PDU`}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button className="px-3 py-1.5 rounded bg-[#00E5FF] text-[#0B1120] text-xs font-bold">All</button>
                  <button className="px-3 py-1.5 rounded bg-[#233544] text-emerald-400 text-xs font-medium">Normal ({activeOutlets})</button>
                  {!isWebAdminPdu && <button className="px-3 py-1.5 rounded bg-[#233544] text-amber-400 text-xs font-medium">Idle ({idleOutlets})</button>}
                  <button className="px-3 py-1.5 rounded bg-[#233544] text-slate-400 text-xs font-medium">Off ({24 - activeOutlets})</button>
                </div>
              </div>
              
              <div className="grid grid-cols-6 gap-4">
                {outlets.map(number => (
                  <OutletCard key={number} number={number} data={data} pduIp={activePdu?.ip} onToggleComplete={refreshData} isWebAdmin={isWebAdminPdu} />
                ))}
              </div>

              <div className="mt-6 flex items-center gap-4">
                <span className="text-[10px] text-slate-500 uppercase">Total Power</span>
                <div className="flex-1 bg-[#233544] h-2 rounded-full overflow-hidden">
                  <div className="bg-[#00E5FF] h-full rounded-full transition-all" style={{ width: `${Math.min((power / 2400) * 100, 100)}%` }}></div>
                </div>
                <span className="text-sm font-mono font-bold text-[#00E5FF]">{(power / 1000).toFixed(1)} kW</span>
              </div>
            </>
          )}

          {/* Data Hall Designer View */}
          {activeTab === 'datahall' && (
            <DataHallDesigner 
              selectedHallId={selectedHallId}
              alerts={rackAlerts}
              onHallChange={(hallId) => setSelectedHallId(hallId)}
              onConfigSaved={() => {
                // Refresh PDU list silently (no loading indicator)
                if (selectedHallId) {
                  fetchHallState(selectedHallId, true);
                }
              }}
              onNavigateToPdu={(pdu) => {
                // Find matching PDU in sidebar by IP and expand it
                const matchingPdu = generatedPDUs.find(p => p.ip === pdu.ip);
                if (matchingPdu) {
                  setExpandedPdu(matchingPdu.id);
                  // Scroll to the PDU in the sidebar list
                  setTimeout(() => {
                    const pduElement = document.getElementById(`pdu-item-${matchingPdu.id}`);
                    if (pduElement) {
                      pduElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                  }, 100);
                }
                setActiveTab('telemetry');
              }}
            />
          )}

          {/* Global Alarm Ledger View */}
          {activeTab === 'ledger' && (
            <>
              {(() => {
                const PARAM_LABELS = {
                  alarm_l1_voltage: 'Phase L1 Voltage', alarm_l1_current: 'Phase L1 Current',
                  alarm_l2_voltage: 'Phase L2 Voltage', alarm_l2_current: 'Phase L2 Current',
                  alarm_l3_voltage: 'Phase L3 Voltage', alarm_l3_current: 'Phase L3 Current',
                  alarm_neutral: 'Neutral Line', alarm_phase_unbalance: 'Phase Unbalance',
                  alarm_temp1: 'Temperature Sensor 1', alarm_hum1: 'Humidity Sensor 1',
                  alarm_temp2: 'Temperature Sensor 2', alarm_hum2: 'Humidity Sensor 2',
                  alarm_temp3: 'Temperature Sensor 3', alarm_hum3: 'Humidity Sensor 3',
                  alarm_temp4: 'Temperature Sensor 4', alarm_hum4: 'Humidity Sensor 4',
                  alarm_sensor1: 'IO Sensor 1', alarm_sensor2: 'IO Sensor 2',
                  alarm_sensor3: 'IO Sensor 3', alarm_sensor4: 'IO Sensor 4',
                };
                const CATEGORY_MAP = {
                  alarm_l1_voltage: 'Voltage', alarm_l2_voltage: 'Voltage', alarm_l3_voltage: 'Voltage',
                  alarm_l1_current: 'Current', alarm_l2_current: 'Current', alarm_l3_current: 'Current',
                  alarm_neutral: 'Current', alarm_phase_unbalance: 'Power Quality',
                  alarm_temp1: 'Temperature', alarm_temp2: 'Temperature', alarm_temp3: 'Temperature', alarm_temp4: 'Temperature',
                  alarm_hum1: 'Humidity', alarm_hum2: 'Humidity', alarm_hum3: 'Humidity', alarm_hum4: 'Humidity',
                  alarm_sensor1: 'IO Sensor', alarm_sensor2: 'IO Sensor', alarm_sensor3: 'IO Sensor', alarm_sensor4: 'IO Sensor',
                };
                const CATEGORY_ICONS = {
                  Voltage: 'electric_bolt', Current: 'bolt', 'Power Quality': 'tune',
                  Temperature: 'thermostat', Humidity: 'water_drop', 'IO Sensor': 'sensors',
                };
                const CATEGORY_COLORS = {
                  Voltage: 'text-amber-400', Current: 'text-red-400', 'Power Quality': 'text-purple-400',
                  Temperature: 'text-orange-400', Humidity: 'text-blue-400', 'IO Sensor': 'text-cyan-400',
                };

                const allEntries = [];
                for (const pdu of hallPDUs) {
                  const alarmData = pduAlarms[pdu.ip];
                  if (!alarmData) continue;
                  const entries = alarmData.entries || [];
                  for (const entry of entries) {
                    const isNormal = !entry.value || entry.value === '-' || entry.value.toLowerCase() === 'normal';
                    allEntries.push({
                      key: entry.key,
                      value: entry.value,
                      isNormal,
                      label: PARAM_LABELS[entry.key] || entry.key.replace(/alarm_/g, '').replace(/_/g, ' '),
                      category: CATEGORY_MAP[entry.key] || 'Other',
                      pduLabel: pdu.label,
                      pduIp: pdu.ip,
                      pduMac: pdu.mac_address || '-',
                      rack: pdu.location || '-',
                      ts: alarmData.ts,
                      status: pduLiveStatus[pdu.ip] || 'offline',
                    });
                  }
                }

                const activeAlarms = allEntries.filter(e => !e.isNormal);
                const normalEntries = allEntries.filter(e => e.isNormal);
                const categoryCounts = {};
                for (const a of activeAlarms) {
                  categoryCounts[a.category] = (categoryCounts[a.category] || 0) + 1;
                }

                return (
                  <>
                    <div className="flex justify-between items-start mb-6">
                      <div>
                        <h2 className="text-2xl font-bold uppercase tracking-tight text-white">
                          <span className="material-icons-outlined align-middle mr-2 text-amber-400">history_edu</span>
                          Global Alarm Ledger
                        </h2>
                        <p className="text-xs text-slate-500 mt-1">
                          Aggregated alarm status across all {hallPDUs.length} PDUs in {selectedHall?.name || 'data hall'}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-xs uppercase tracking-wider flex items-center gap-1.5 ${activeAlarms.length > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                          <span className={`inline-block w-2 h-2 rounded-full ${activeAlarms.length > 0 ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'}`}></span>
                          {activeAlarms.length > 0 ? `${activeAlarms.length} Active` : 'All Clear'}
                        </span>
                      </div>
                    </div>

                    {/* Summary Cards */}
                    <div className="grid grid-cols-4 gap-3 mb-6">
                      <div className={`p-4 rounded-xl border ${activeAlarms.length > 0 ? 'bg-red-500/10 border-red-500/30' : 'bg-emerald-500/10 border-emerald-500/30'}`}>
                        <p className="text-[10px] text-slate-500 uppercase mb-1">Active Alarms</p>
                        <p className={`text-2xl font-mono font-bold ${activeAlarms.length > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{activeAlarms.length}</p>
                      </div>
                      <div className="p-4 rounded-xl bg-[#161E2E] border border-[#233544]">
                        <p className="text-[10px] text-slate-500 uppercase mb-1">PDUs Monitored</p>
                        <p className="text-2xl font-mono font-bold text-[#00E5FF]">{hallPDUs.length}</p>
                      </div>
                      <div className="p-4 rounded-xl bg-[#161E2E] border border-[#233544]">
                        <p className="text-[10px] text-slate-500 uppercase mb-1">Parameters Checked</p>
                        <p className="text-2xl font-mono font-bold text-slate-300">{allEntries.length}</p>
                      </div>
                      <div className="p-4 rounded-xl bg-[#161E2E] border border-[#233544]">
                        <p className="text-[10px] text-slate-500 uppercase mb-1">All Normal</p>
                        <p className="text-2xl font-mono font-bold text-emerald-400">{normalEntries.length}</p>
                      </div>
                    </div>

                    {/* Category Breakdown */}
                    {Object.keys(categoryCounts).length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-6">
                        {Object.entries(categoryCounts).map(([cat, count]) => (
                          <span key={cat} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs">
                            <span className={`material-icons-outlined text-sm ${CATEGORY_COLORS[cat] || 'text-red-400'}`}>{CATEGORY_ICONS[cat] || 'error'}</span>
                            <span className="text-slate-300">{cat}</span>
                            <span className="font-mono font-bold text-red-400">{count}</span>
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Active Alarms Table */}
                    {activeAlarms.length > 0 ? (
                      <div className="mb-8">
                        <h3 className="text-sm font-bold text-red-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                          <span className="material-icons-outlined text-sm">error</span>
                          Active Alarms
                        </h3>
                        <div className="bg-[#161E2E] rounded-xl border border-red-500/30 overflow-hidden">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-[#233544] text-[10px] text-slate-500 uppercase">
                                <th className="text-left px-4 py-3">Category</th>
                                <th className="text-left px-4 py-3">Parameter</th>
                                <th className="text-left px-4 py-3">Status</th>
                                <th className="text-left px-4 py-3">PDU</th>
                                <th className="text-left px-4 py-3">IP / MAC</th>
                                <th className="text-left px-4 py-3">Rack</th>
                                <th className="text-left px-4 py-3">Timestamp</th>
                              </tr>
                            </thead>
                            <tbody>
                              {activeAlarms.map((alarm, idx) => (
                                <tr key={`${alarm.pduIp}-${alarm.key}-${idx}`} className="border-b border-[#233544]/50 hover:bg-red-500/5 transition-colors">
                                  <td className="px-4 py-3">
                                    <span className="flex items-center gap-1.5">
                                      <span className={`material-icons-outlined text-sm ${CATEGORY_COLORS[alarm.category] || 'text-red-400'}`}>{CATEGORY_ICONS[alarm.category] || 'error'}</span>
                                      <span className="text-slate-400">{alarm.category}</span>
                                    </span>
                                  </td>
                                  <td className="px-4 py-3 text-white font-medium">{alarm.label}</td>
                                  <td className="px-4 py-3">
                                    <span className="px-2 py-0.5 rounded bg-red-500/20 text-red-400 font-mono font-bold text-[10px]">{alarm.value}</span>
                                  </td>
                                  <td className="px-4 py-3 text-slate-300">{alarm.pduLabel}</td>
                                  <td className="px-4 py-3">
                                    <span className="font-mono text-slate-400">{alarm.pduIp}</span>
                                    <br/>
                                    <span className="font-mono text-slate-600 text-[10px]">{alarm.pduMac}</span>
                                  </td>
                                  <td className="px-4 py-3 font-mono text-slate-400">{alarm.rack}</td>
                                  <td className="px-4 py-3 font-mono text-slate-500">{alarm.ts ? new Date(alarm.ts).toLocaleString() : '-'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ) : (
                      <div className="mb-8 p-8 rounded-xl bg-emerald-500/5 border border-emerald-500/20 text-center">
                        <span className="material-icons-outlined text-5xl text-emerald-400 mb-3 block">verified</span>
                        <p className="text-lg font-bold text-emerald-300">All Systems Normal</p>
                        <p className="text-xs text-slate-500 mt-2">
                          No active alarms across {hallPDUs.length} monitored PDU{hallPDUs.length !== 1 ? 's' : ''} in {selectedHall?.name || 'this data hall'}.
                          <br/>All {allEntries.length} parameters are within normal thresholds.
                        </p>
                      </div>
                    )}

                    {/* Full Parameter Status — Grouped by PDU with Accordions */}
                    {allEntries.length > 0 && (() => {
                      const grouped = {};
                      for (const entry of allEntries) {
                        const k = entry.pduIp;
                        if (!grouped[k]) grouped[k] = { pdu: entry, entries: [] };
                        grouped[k].entries.push(entry);
                      }
                      return (
                        <div>
                          <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                            <span className="material-icons-outlined text-sm text-slate-500">checklist</span>
                            Full Parameter Status ({allEntries.length})
                          </h3>
                          <div className="space-y-2">
                            {Object.entries(grouped).map(([ip, group]) => {
                              const pduAlarmCount = group.entries.filter(e => !e.isNormal).length;
                              return (
                                <div key={ip} className="rounded-xl border border-[#233544] overflow-hidden">
                                  <button
                                    onClick={() => setLedgerExpandedPdu(prev => prev === ip ? null : ip)}
                                    className="w-full flex items-center justify-between px-4 py-3 bg-[#161E2E] hover:bg-[#1a2535] transition-colors cursor-pointer"
                                  >
                                    <div className="flex items-center gap-3">
                                      <span className={`w-2 h-2 rounded-full ${pduAlarmCount > 0 ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'}`}></span>
                                      <span className="text-sm font-medium text-white">{group.pdu.pduLabel}</span>
                                      <span className="text-[10px] font-mono text-slate-500">{ip}</span>
                                      {group.pdu.pduMac && group.pdu.pduMac !== '-' && (
                                        <span className="text-[10px] font-mono text-slate-600">{group.pdu.pduMac}</span>
                                      )}
                                      <span className="text-[10px] text-slate-600">Rack: <span className="font-mono">{group.pdu.rack}</span></span>
                                    </div>
                                    <div className="flex items-center gap-3">
                                      {pduAlarmCount > 0 && (
                                        <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 text-[10px] font-mono font-bold">{pduAlarmCount} alarm{pduAlarmCount > 1 ? 's' : ''}</span>
                                      )}
                                      <span className="text-[10px] text-slate-500">{group.entries.length} params</span>
                                      <span className={`material-icons-outlined text-sm text-slate-500 transition-transform duration-200 ${ledgerExpandedPdu === ip ? 'rotate-180' : ''}`}>expand_more</span>
                                    </div>
                                  </button>
                                  {ledgerExpandedPdu === ip && (
                                    <div className="bg-[#0B1120]">
                                      <table className="w-full text-xs">
                                        <thead>
                                          <tr className="border-b border-[#233544] text-[10px] text-slate-500 uppercase">
                                            <th className="text-left px-4 py-2">Category</th>
                                            <th className="text-left px-4 py-2">Parameter</th>
                                            <th className="text-left px-4 py-2">Status</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {group.entries.map((entry, idx) => (
                                            <tr key={`${entry.key}-${idx}`} className={`border-b border-[#233544]/30 ${!entry.isNormal ? 'bg-red-500/5' : ''}`}>
                                              <td className="px-4 py-2">
                                                <span className="flex items-center gap-1.5">
                                                  <span className={`material-icons-outlined text-sm ${!entry.isNormal ? (CATEGORY_COLORS[entry.category] || 'text-red-400') : 'text-slate-600'}`}>{CATEGORY_ICONS[entry.category] || 'check'}</span>
                                                  <span className="text-slate-500">{entry.category}</span>
                                                </span>
                                              </td>
                                              <td className="px-4 py-2 text-slate-300">{entry.label}</td>
                                              <td className="px-4 py-2">
                                                <span className={`px-2 py-0.5 rounded font-mono font-bold text-[10px] ${entry.isNormal ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                                                  {entry.value || '-'}
                                                </span>
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {allEntries.length === 0 && hallPDUs.length === 0 && (
                      <div className="p-8 rounded-xl bg-[#161E2E] border border-[#233544] text-center">
                        <span className="material-icons-outlined text-5xl text-slate-600 mb-3 block">playlist_remove</span>
                        <p className="text-lg font-bold text-slate-400">No PDUs Configured</p>
                        <p className="text-xs text-slate-600 mt-2">Commission PDUs to see alarm data in this ledger.</p>
                      </div>
                    )}

                    {allEntries.length === 0 && hallPDUs.length > 0 && (
                      <div className="p-8 rounded-xl bg-[#161E2E] border border-[#233544] text-center">
                        <span className="material-icons-outlined text-5xl text-slate-600 mb-3 block animate-spin" style={{animationDuration: '3s'}}>sync</span>
                        <p className="text-lg font-bold text-slate-400">Collecting Data...</p>
                        <p className="text-xs text-slate-600 mt-2">Waiting for alarm data from {hallPDUs.length} PDU{hallPDUs.length !== 1 ? 's' : ''}. This updates every 10 seconds.</p>
                      </div>
                    )}
                  </>
                );
              })()}
            </>
          )}

          {/* Specs View */}
          {activeTab === 'specs' && (
            <>
              <div className="flex justify-between items-start mb-8">
                <div>
                  <h1 className="text-2xl font-bold uppercase tracking-tight text-[#00E5FF]">
                    <span className="material-icons-outlined align-middle mr-2">info</span>
                    PDU Design Specs
                  </h1>
                </div>
                <button className="px-4 py-2 bg-[#233544] text-slate-300 text-xs font-bold rounded uppercase hover:bg-[#2D3748]">
                  Show JSON
                </button>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="bg-[#161E2E] rounded-xl border border-[#233544] p-6">
                  <table className="w-full text-sm font-mono">
                    <thead>
                      <tr className="text-[#00E5FF]/70 border-b border-[#233544]">
                        <th className="py-3 text-left font-medium">Parameter</th>
                        <th className="py-3 text-left font-medium">Value / Description</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#233544]">
                      <tr><td className="py-3 text-slate-500">Model Number</td><td className="py-3 text-slate-300">DPDU-V3-C1308-10A</td></tr>
                      <tr><td className="py-3 text-slate-500">Shell Material</td><td className="py-3 text-slate-300">1.2mm SGCC, black powder</td></tr>
                      <tr><td className="py-3 text-slate-500">Input Voltage</td><td className="py-3 text-slate-300">220V – 250V, 50/60 Hz</td></tr>
                      <tr><td className="py-3 text-slate-500">Max Current</td><td className="py-3 text-slate-300">10A</td></tr>
                      <tr><td className="py-3 text-slate-500">Internal Wiring</td><td className="py-3 text-slate-300">1.5mm² main line</td></tr>
                      <tr><td className="py-3 text-slate-500">Dimensions</td><td className="py-3 text-slate-300">486 × 44.4 × 150 mm</td></tr>
                      <tr><td className="py-3 text-slate-500">Ports</td><td className="py-3 text-slate-300">TX, NET, IN, OUT, USB</td></tr>
                      <tr><td className="py-3 text-slate-500">Mounting</td><td className="py-3 text-slate-300">Horizontal (rear-input)</td></tr>
                    </tbody>
                  </table>
                </div>

                <div className="space-y-6">
                  {/* Load Trends Mini */}
                  <div className="bg-[#161E2E] rounded-xl border border-[#233544] p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-bold text-[#00E5FF] flex items-center gap-2 uppercase text-sm">
                        <span className="material-icons-outlined">trending_up</span>
                        Load Trends
                      </h3>
                      <div className="flex gap-4 text-[10px]">
                        <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[#00E5FF]"></span> Actual</div>
                        <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-blue-400/50"></span> Forecast</div>
                      </div>
                    </div>
                    <div className="h-32 relative">
                      <svg className="w-full h-full" viewBox="0 0 400 100">
                        <path d="M0 80 L50 60 L100 58 L150 62 L200 60 L250 58 L300 55 L350 58 L400 52" fill="none" stroke="#00E5FF" strokeWidth="2"/>
                        <path d="M0 82 L50 65 L100 62 L150 68 L200 65 L250 62 L300 60 L350 63 L400 58" fill="none" stroke="#60A5FA" strokeWidth="1.5" strokeDasharray="4" opacity="0.5"/>
                      </svg>
                    </div>
                    <div className="flex justify-end mt-2">
                      <span className="text-xs text-slate-500">Peak Demand: <strong className="text-white font-mono">{Math.round(power * 1.03)} W</strong></span>
                    </div>
                  </div>

                  {/* Environmental Mini */}
                  <div className="bg-[#161E2E] rounded-xl border border-[#233544] p-6">
                    <h3 className="font-bold text-[#00E5FF] flex items-center gap-2 uppercase text-sm mb-6">
                      <span className="material-icons-outlined">thermostat</span>
                      Environmental
                    </h3>
                    <div className="grid grid-cols-2 gap-8">
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Temperature 1</p>
                        <p className="text-2xl font-mono font-semibold">24.2°C</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Temperature 2</p>
                        <p className="text-2xl font-mono font-semibold">26.1°C</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Humidity</p>
                        <p className="text-2xl font-mono font-semibold">42.5%</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Rack Door</p>
                        <p className="text-lg font-mono font-semibold text-emerald-400 flex items-center gap-1">
                          <span className="material-icons-outlined text-sm">lock</span> CLOSED
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Insights View */}
          {activeTab === 'insights' && (
            <>
              <div className="flex justify-between items-start mb-8">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h1 className="text-2xl font-bold uppercase tracking-tight text-[#00E5FF]">
                      <span className="material-icons-outlined align-middle mr-2">psychology</span>
                      Analysis & Insights
                    </h1>
                    <span className="text-[10px] bg-[#00E5FF]/20 text-[#00E5FF] px-2 py-0.5 rounded-full font-bold uppercase">AI Powered</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <InsightCard
                  icon="build"
                  iconBg="bg-amber-500/10 text-amber-500"
                  title="Power Optimization"
                  description={`Optimize power distribution by disabling ${idleOutlets} idle outputs detected in section B.`}
                  actionLabel="Apply Change"
                  actionStyle="bg-[#233544] text-slate-300 hover:bg-[#00E5FF] hover:text-[#0B1120]"
                />
                <InsightCard
                  icon="ac_unit"
                  iconBg="bg-red-500/10 text-red-500"
                  title="Cooling Alert"
                  description="Check cooling system – abnormal temp values (+5°C spike) detected."
                  actionLabel="View Logs"
                  actionStyle="bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white"
                  severity="warning"
                />
                <InsightCard
                  icon="search"
                  iconBg="bg-slate-500/10 text-slate-500"
                  title="Consumption Drift"
                  description="Unusual idle consumption detected in output 3. Possible device phantom load."
                  actionLabel="Investigate"
                  actionStyle="bg-[#233544] text-slate-300 hover:bg-[#00E5FF] hover:text-[#0B1120]"
                />
              </div>
            </>
          )}

          {activeTab === 'pdu-settings' && (
            <PDUSettingsPanel pdu={(() => {
              const p = hallPDUs.find(p => expandedPdu && (p.id === expandedPdu || p.dbId === expandedPdu));
              return p ? { ip: p.ip, remote_host: p.remote_host, web_admin_port: p.web_admin_port, web_admin_user: p.web_admin_user, web_admin_pass: p.web_admin_pass } : null;
            })()} />
          )}
        </main>
      </div>

      {/* Commissioning Wizard Modal */}
      {showWizard && selectedHallId && (
        <CommissioningWizard
          hallId={selectedHallId}
          hallName={selectedHall?.name || 'Data Hall'}
          onComplete={() => {
            fetchHallState(selectedHallId);
          }}
          onClose={() => setShowWizard(false)}
        />
      )}
    </div>
  );
};

export default Dashboard2;
