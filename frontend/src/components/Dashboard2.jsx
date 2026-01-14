import React, { useEffect, useState } from 'react';
import { usePDUContext } from '../context/PDUContext';
import api from '../api';
import DataHallDesigner from './DataHallDesigner/DataHallDesigner';

// Outlet Card Component matching reference design
const OutletCard = ({ number, data }) => {
  const status = data?.results?.find(r => r.name === `Output${number}Status`)?.value?.replace(/"/g, '');
  const current = parseFloat(data?.results?.find(r => r.name === `Output${number}Current`)?.value?.replace(/"/g, '') || '0');
  const energy = parseFloat(data?.results?.find(r => r.name === `Output${number}Energy`)?.value?.replace(/"/g, '') || '0');
  
  const isOn = status?.toLowerCase() === 'on';
  const hasLoad = current > 0;
  const isHighLoad = current > 1.2;
  const isIdle = isOn && !hasLoad;
  
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    const newState = isOn ? 'off' : 'on';
    try {
      setLoading(true);
      await api.put(`/api/outlet/${number}/status`, { state: newState });
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const getStatusLabel = () => {
    if (!isOn) return { text: 'Off', color: 'text-slate-500', dot: 'bg-slate-500' };
    if (isHighLoad) return { text: 'Alert', color: 'text-red-400', dot: 'bg-red-500' };
    if (isIdle) return { text: 'Idle', color: 'text-amber-400', dot: 'bg-amber-500' };
    return { text: 'Normal', color: 'text-emerald-400', dot: 'bg-emerald-500' };
  };

  const statusInfo = getStatusLabel();

  return (
    <div className={`bg-[#161E2E] rounded-lg border ${isHighLoad ? 'border-red-500/50' : 'border-[#233544]'} p-4 ${!isOn ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-slate-500 uppercase tracking-wider font-mono">OUTLET</span>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] ${statusInfo.color}`}>{statusInfo.text}</span>
          <span className={`w-2 h-2 rounded-full ${statusInfo.dot}`}></span>
        </div>
      </div>
      
      <div className="text-2xl font-bold font-mono text-white mb-4">A{String(number).padStart(2, '0')}</div>
      
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
    </div>
  );
};

// Specs Table Row
const SpecRow = ({ label, value }) => (
  <div className="flex justify-between py-3 border-b border-[#233544]">
    <span className="text-xs text-slate-500 font-mono">{label}</span>
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
  const { activePdu } = usePDUContext();
  
  // Mock PDU list from Data Hall Designer - in production this would come from the designer
  const generatedPDUs = [
    { id: 'PDU-01', ip: '192.168.10.106', port: '161', location: 'Row-01/Rack-03', status: 'critical' },
    { id: 'PDU-02', ip: '192.168.10.107', port: '161', location: 'Row-01/Rack-08', status: 'warning' },
    { id: 'PDU-03', ip: '192.168.10.108', port: '161', location: 'Row-02/Rack-05', status: 'normal' },
    { id: 'PDU-04', ip: '192.168.10.109', port: '161', location: 'Row-02/Rack-10', status: 'normal' },
  ];

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch('/api/data');
        const result = await response.json();
        setData(result);
      } catch (error) {
        console.error('Error fetching data:', error);
      }
    };

    if (activePdu?.ip) {
      fetchData();
      const interval = setInterval(fetchData, 5000);
      return () => clearInterval(interval);
    }
  }, [activePdu]);

  // Extract values from data
  const getValue = (name) => {
    const item = data?.results?.find(r => r.name === name);
    return item?.value?.replace(/"/g, '') || '0';
  };

  const voltage = parseFloat(getValue('VoltageP1')) || 0;
  const current = parseFloat(getValue('CurrentP1')) || 0;
  const power = parseFloat(getValue('PowerP1')) || 0;
  const pf = parseFloat(getValue('PFP1')) || 0;
  const energy = parseFloat(getValue('EnergyP1')) || 0;

  const outlets = Array.from({ length: 24 }, (_, i) => i + 1);
  const activeOutlets = outlets.filter(n => getValue(`Output${n}Status`)?.toLowerCase() === 'on').length;
  const loadedOutlets = outlets.filter(n => {
    const status = getValue(`Output${n}Status`)?.toLowerCase();
    const curr = parseFloat(getValue(`Output${n}Current`) || 0);
    return status === 'on' && curr > 0;
  }).length;
  const idleOutlets = activeOutlets - loadedOutlets;

  if (!activePdu) {
    return (
      <div className="min-h-screen bg-[#0B1120] flex items-center justify-center">
        <p className="text-slate-400 font-mono">Please add a PDU using the sidebar</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B1120] text-slate-100">
      <div className="flex">
        {/* Sidebar */}
        <aside className="w-72 border-r border-[#233544] bg-[#0B1120] min-h-[calc(100vh-4rem)] p-4 overflow-y-auto">
          {/* Data Hall Designer - Top Section */}
          <div className="mb-6">
            <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-3 font-mono">
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
          </div>

          {/* PDU Tree Navigation */}
          <div className="mb-6">
            <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-3 font-mono">
              PDU Monitoring
            </h3>
            <div className="space-y-1">
              {generatedPDUs.map(pdu => (
                <div key={pdu.id}>
                  {/* PDU Header */}
                  <button
                    onClick={() => setExpandedPdu(expandedPdu === pdu.id ? null : pdu.id)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition-colors text-left ${
                      expandedPdu === pdu.id 
                        ? 'bg-[#161E2E] text-white' 
                        : 'text-slate-400 hover:bg-[#161E2E]'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`material-icons-outlined text-sm ${expandedPdu === pdu.id ? 'rotate-90' : ''} transition-transform`}>
                        chevron_right
                      </span>
                      <span className={`w-2 h-2 rounded-full ${
                        pdu.status === 'critical' ? 'bg-red-500' : 
                        pdu.status === 'warning' ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}></span>
                      <span className="text-sm font-mono">{pdu.id}</span>
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono">{pdu.ip}</span>
                  </button>
                  
                  {/* PDU Monitoring Options - Expanded */}
                  {expandedPdu === pdu.id && (
                    <div className="ml-6 mt-1 space-y-0.5 border-l border-[#233544] pl-2">
                      <p className="text-[9px] text-slate-600 font-mono px-2 py-1">{pdu.location}</p>
                      {[
                        { id: 'telemetry', icon: 'analytics', label: 'Telemetry' },
                        { id: 'outlets', icon: 'power', label: 'Outlets' },
                        { id: 'ledger', icon: 'history_edu', label: 'Activity Ledger' },
                        { id: 'specs', icon: 'info', label: 'Specs' },
                        { id: 'insights', icon: 'psychology', label: 'AI Insights' },
                      ].map(item => (
                        <button
                          key={item.id}
                          onClick={() => setActiveTab(item.id)}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded transition-colors text-left text-xs ${
                            activeTab === item.id && expandedPdu === pdu.id
                              ? 'bg-[#00E5FF]/10 text-[#00E5FF]' 
                              : 'text-slate-500 hover:bg-[#161E2E] hover:text-slate-300'
                          }`}
                        >
                          <span className="material-icons-outlined text-sm">{item.icon}</span>
                          <span>{item.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            
            {/* Add PDU Button */}
            <button className="w-full mt-3 py-2 bg-[#233544] hover:bg-[#2D4A5E] text-slate-400 hover:text-white font-medium text-xs uppercase tracking-wider rounded-lg flex items-center justify-center gap-2 transition-all">
              <span className="material-icons-outlined text-sm">add</span>
              Add PDU
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
          {/* Telemetry View */}
          {activeTab === 'telemetry' && (
            <>
              {/* Page Header */}
              <div className="flex justify-between items-start mb-8">
                <div>
                  <h1 className="text-2xl font-bold font-mono uppercase tracking-tight text-[#00E5FF]">
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
                  <span className="px-3 py-1 rounded-full bg-[#00E5FF]/10 text-[#00E5FF] text-xs font-medium border border-[#00E5FF]/20 flex items-center gap-1">
                    <span className="material-icons-outlined text-xs">auto_awesome</span>
                    AI Forecast Enabled
                  </span>
                </div>
              </div>

              {/* Metrics Row */}
              <div className="grid grid-cols-4 gap-4 mb-6">
                <div className="bg-[#161E2E] p-5 rounded-xl border border-[#233544]">
                  <p className="text-[10px] text-slate-500 uppercase font-bold font-mono mb-2">Active Power</p>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold font-mono text-white">{power.toFixed(1)}</span>
                    <span className="text-slate-500 text-sm">W</span>
                  </div>
                </div>
                <div className="bg-[#161E2E] p-5 rounded-xl border border-[#233544]">
                  <p className="text-[10px] text-slate-500 uppercase font-bold font-mono mb-2">Power Factor</p>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold font-mono text-white">{pf.toFixed(2)}</span>
                  </div>
                </div>
                <div className="bg-[#161E2E] p-5 rounded-xl border border-[#233544]">
                  <p className="text-[10px] text-slate-500 uppercase font-bold font-mono mb-2">Total Energy</p>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold font-mono text-white">{energy.toFixed(1)}</span>
                    <span className="text-slate-500 text-sm">kWh</span>
                  </div>
                </div>
                <div className="bg-[#161E2E] p-5 rounded-xl border border-[#233544] flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase font-bold font-mono mb-2">Phase Status</p>
                    <div className="flex gap-2">
                      <div className="w-3 h-3 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>
                      <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                      <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                    </div>
                  </div>
                  <span className="material-icons-outlined text-slate-700 text-4xl">view_in_ar</span>
                </div>
              </div>

              {/* Charts Row */}
              <div className="grid grid-cols-3 gap-6 mb-6">
                {/* Load Trends Chart */}
                <div className="col-span-2 bg-[#161E2E] rounded-xl border border-[#233544] p-6">
                  <div className="flex justify-between items-center mb-6">
                    <h3 className="font-mono font-bold text-[#00E5FF] flex items-center gap-2 uppercase text-sm">
                      <span className="material-icons-outlined text-lg">trending_up</span>
                      Load Trends & Forecasting
                    </h3>
                    <div className="flex items-center gap-6 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full bg-[#00E5FF]"></span>
                        <span className="text-slate-400">Actual Power</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full border-2 border-[#00E5FF] border-dashed"></span>
                        <span className="text-slate-400">AI Forecast</span>
                      </div>
                    </div>
                  </div>
                  
                  {/* Chart Area */}
                  <div className="h-[200px] relative border-l border-b border-[#233544]">
                    <svg className="w-full h-full" viewBox="0 0 800 200" preserveAspectRatio="none">
                      <defs>
                        <linearGradient id="chartGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                          <stop offset="0%" stopColor="#00E5FF" stopOpacity="0.3"/>
                          <stop offset="100%" stopColor="#00E5FF" stopOpacity="0"/>
                        </linearGradient>
                      </defs>
                      {/* Grid lines */}
                      <line x1="0" y1="50" x2="800" y2="50" stroke="#233544" strokeWidth="1"/>
                      <line x1="0" y1="100" x2="800" y2="100" stroke="#233544" strokeWidth="1"/>
                      <line x1="0" y1="150" x2="800" y2="150" stroke="#233544" strokeWidth="1"/>
                      {/* Area fill */}
                      <path d="M0 180 L50 60 L100 58 L150 62 L200 60 L250 58 L300 62 L350 60 L400 58 L450 62 L500 60 L550 58 L600 60 L600 200 L0 200 Z" fill="url(#chartGradient)"/>
                      {/* Main line */}
                      <path d="M0 180 L50 60 L100 58 L150 62 L200 60 L250 58 L300 62 L350 60 L400 58 L450 62 L500 60 L550 58 L600 60" fill="none" stroke="#00E5FF" strokeWidth="2"/>
                      {/* Forecast line */}
                      <path d="M600 60 L650 62 L700 58 L750 64 L800 60" fill="none" stroke="#00E5FF" strokeWidth="2" strokeDasharray="8 4" opacity="0.6"/>
                    </svg>
                  </div>
                  
                  {/* Time labels */}
                  <div className="flex justify-between mt-4 text-[10px] font-mono text-slate-500">
                    <span>05:59</span>
                    <span>06:02</span>
                    <span>06:03</span>
                    <span>06:04</span>
                    <span>06:05</span>
                    <span className="text-[#00E5FF] font-bold">Forecast</span>
                  </div>
                  
                  <div className="mt-4 flex justify-between items-center text-sm border-t border-[#233544] pt-4">
                    <div className="text-slate-500">
                      Peak Demand Today: <span className="font-bold text-white font-mono ml-2">{Math.round(power * 1.03)} W</span>
                    </div>
                    <button className="text-[#00E5FF] hover:underline flex items-center gap-1 font-mono text-xs uppercase">
                      Download Report <span className="material-icons-outlined text-sm">download</span>
                    </button>
                  </div>
                </div>

                {/* Environmental */}
                <div className="bg-[#161E2E] rounded-xl border border-[#233544] p-6">
                  <h3 className="font-mono font-bold text-[#00E5FF] flex items-center gap-2 uppercase text-sm mb-6">
                    <span className="material-icons-outlined text-lg">thermostat</span>
                    Environmental
                  </h3>
                  <div className="space-y-6">
                    <div className="grid grid-cols-2 gap-6">
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase font-bold font-mono mb-1">Internal Temp</p>
                        <div className="flex items-baseline gap-1">
                          <span className="text-2xl font-bold font-mono text-white">24.5</span>
                          <span className="text-slate-500">°C</span>
                        </div>
                        <div className="w-full bg-[#233544] h-1.5 rounded-full mt-2 overflow-hidden">
                          <div className="bg-[#00E5FF] h-full rounded-full" style={{ width: '45%' }}></div>
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase font-bold font-mono mb-1">Exhaust Temp</p>
                        <div className="flex items-baseline gap-1">
                          <span className="text-2xl font-bold font-mono text-white">28.2</span>
                          <span className="text-slate-500">°C</span>
                        </div>
                        <div className="w-full bg-[#233544] h-1.5 rounded-full mt-2 overflow-hidden">
                          <div className="bg-amber-500 h-full rounded-full" style={{ width: '60%' }}></div>
                        </div>
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase font-bold font-mono mb-1">Humidity</p>
                      <div className="flex items-baseline gap-1">
                        <span className="text-4xl font-bold font-mono text-white">42.0</span>
                        <span className="text-slate-500 text-lg">%</span>
                      </div>
                    </div>
                    <div className="pt-4 border-t border-[#233544]">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-[#233544] flex items-center justify-center text-slate-500">
                            <span className="material-icons-outlined">door_sliding</span>
                          </div>
                          <div>
                            <p className="text-[10px] text-slate-500 uppercase font-bold font-mono">Cabinet Door</p>
                            <p className="text-sm font-bold font-mono uppercase text-emerald-400">CLOSED</p>
                          </div>
                        </div>
                        <span className="material-icons-outlined text-emerald-400">lock</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Bottom Row */}
              <div className="grid grid-cols-2 gap-6">
                {/* AI Analysis */}
                <div className="bg-[#161E2E] rounded-xl border border-[#233544] p-6">
                  <div className="flex items-center gap-2 mb-6">
                    <h3 className="font-mono font-bold text-[#00E5FF] flex items-center gap-2 uppercase text-sm">
                      <span className="material-icons-outlined text-lg">insights</span>
                      AI Operational Analysis
                    </h3>
                  </div>
                  <div className="space-y-3">
                    <div className="p-4 rounded-lg bg-[#0B1120] border border-[#233544] flex gap-4 items-start">
                      <span className="material-icons-outlined text-[#00E5FF] mt-0.5">lightbulb</span>
                      <div>
                        <p className="text-sm font-medium text-white">Efficiency Opportunity</p>
                        <p className="text-xs text-slate-500 mt-1">
                          Optimize power distribution by disabling {idleOutlets} idle outputs detected in the last 24h.
                        </p>
                      </div>
                    </div>
                    <div className="p-4 rounded-lg bg-amber-500/5 border border-amber-500/20 flex gap-4 items-start">
                      <span className="material-icons-outlined text-amber-500 mt-0.5">warning</span>
                      <div>
                        <p className="text-sm font-medium text-amber-400">Thermal Warning</p>
                        <p className="text-xs text-slate-500 mt-1">
                          Check cooling system - abnormal exhaust temp values detected between 02:00-04:00.
                        </p>
                      </div>
                    </div>
                    <div className="p-4 rounded-lg bg-[#0B1120] border border-[#233544] flex gap-4 items-start">
                      <span className="material-icons-outlined text-slate-500 mt-0.5">search</span>
                      <div>
                        <p className="text-sm font-medium text-white">Anomaly Detected</p>
                        <p className="text-xs text-slate-500 mt-1">
                          Unusual idle consumption detected in output 7. Current baseline shifted by +12%.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* PDU Specifications */}
                <div className="bg-[#161E2E] rounded-xl border border-[#233544] p-6">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="font-mono font-bold text-[#00E5FF] flex items-center gap-2 uppercase text-sm">
                      <span className="material-icons-outlined text-lg">description</span>
                      PDU Specifications
                    </h3>
                    <button className="text-[10px] px-2 py-1 bg-[#233544] text-slate-400 rounded uppercase font-bold hover:bg-[#2D3748]">
                      Show JSON
                    </button>
                  </div>
                  <div className="space-y-0">
                    <SpecRow label="Model Number" value="DPDU-V3-C1308-10A" />
                    <SpecRow label="Input Voltage" value="220V – 250V, 50/60 Hz" />
                    <SpecRow label="Max Current" value="10A" />
                    <SpecRow label="Internal Wiring" value="1.5mm² main line" />
                    <SpecRow label="Intelligent Control" value="DPDU V3 meter" />
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Outlets View */}
          {activeTab === 'outlets' && (
            <>
              <div className="flex justify-between items-start mb-8">
                <div>
                  <h1 className="text-2xl font-bold font-mono uppercase tracking-tight text-white">OUTPUTS</h1>
                  <p className="text-slate-500 text-sm mt-1">Managing 24 individual outlets for PDU</p>
                </div>
                <div className="flex gap-2">
                  <button className="px-3 py-1.5 rounded bg-[#00E5FF] text-[#0B1120] text-xs font-bold">All</button>
                  <button className="px-3 py-1.5 rounded bg-[#233544] text-slate-400 text-xs font-medium">Normal ({loadedOutlets})</button>
                  <button className="px-3 py-1.5 rounded bg-[#233544] text-slate-400 text-xs font-medium">Idle ({idleOutlets})</button>
                  <button className="px-3 py-1.5 rounded bg-[#233544] text-slate-400 text-xs font-medium">Off ({24 - activeOutlets})</button>
                </div>
              </div>
              
              <div className="grid grid-cols-6 gap-4">
                {outlets.map(number => (
                  <OutletCard key={number} number={number} data={data} />
                ))}
              </div>

              <div className="mt-6 flex items-center gap-4">
                <span className="text-[10px] text-slate-500 uppercase font-mono">Total Power</span>
                <div className="flex-1 bg-[#233544] h-2 rounded-full overflow-hidden">
                  <div className="bg-[#00E5FF] h-full rounded-full transition-all" style={{ width: `${Math.min((power / 2400) * 100, 100)}%` }}></div>
                </div>
                <span className="text-sm font-mono font-bold text-[#00E5FF]">{(power / 1000).toFixed(1)} kW</span>
              </div>
            </>
          )}

          {/* Data Hall Designer View */}
          {activeTab === 'datahall' && (
            <DataHallDesigner />
          )}

          {/* Activity Ledger View */}
          {activeTab === 'ledger' && (
            <>
              <div className="flex justify-between items-start mb-8">
                <div>
                  <h1 className="text-2xl font-bold font-mono uppercase tracking-tight text-white">
                    Alerts & Incident Response
                  </h1>
                  <p className="text-slate-500 text-sm mt-1">
                    Real-time monitoring and anomaly detection for power infrastructure.
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-slate-500 uppercase tracking-wider">
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-2"></span>
                    System Health: Nominal
                  </span>
                  <button className="text-[#00E5FF] text-xs font-mono uppercase flex items-center gap-1 hover:underline">
                    <span className="material-icons-outlined text-sm">history</span>
                    View History
                  </button>
                </div>
              </div>

              {/* Alert Cards */}
              <div className="space-y-4">
                {/* Critical Alert */}
                <div className="bg-[#161E2E] rounded-xl border-l-4 border-l-red-500 border border-[#233544] p-5">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                        <span className="material-icons-outlined text-red-500">error</span>
                      </div>
                      <div>
                        <div className="flex items-center gap-3 mb-1">
                          <span className="text-[10px] bg-red-500 text-white px-2 py-0.5 rounded font-bold uppercase">Critical</span>
                          <span className="text-sm font-semibold text-white">Over-current Detection: Phase L2</span>
                          <span className="text-xs text-slate-500 font-mono">PDU: {activePdu?.ip}:{activePdu?.port}</span>
                        </div>
                        <p className="text-xs text-slate-400 mt-1">
                          Current reached 16.4A on phase L2, exceeding the safety threshold of 15.0A. High risk of circuit breaker tripping.
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-slate-500 uppercase mb-1">Duration</p>
                      <p className="text-lg font-mono font-bold text-red-400">00:04:12</p>
                    </div>
                    <button className="ml-6 px-4 py-2 bg-[#00E5FF] text-[#0B1120] text-xs font-bold rounded uppercase hover:bg-[#00E5FF]/80">
                      Resolve →
                    </button>
                  </div>
                </div>

                {/* Warning Alert */}
                <div className="bg-[#161E2E] rounded-xl border-l-4 border-l-amber-500 border border-[#233544] p-5">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
                        <span className="material-icons-outlined text-amber-500">warning</span>
                      </div>
                      <div>
                        <div className="flex items-center gap-3 mb-1">
                          <span className="text-[10px] bg-amber-500 text-white px-2 py-0.5 rounded font-bold uppercase">Warning</span>
                          <span className="text-sm font-semibold text-white">Temperature Threshold Exceeded</span>
                          <span className="text-xs text-slate-500 font-mono">PDU: {activePdu?.ip}:{activePdu?.port}</span>
                        </div>
                        <p className="text-xs text-slate-400 mt-1">
                          External sensor #1 reported 42.5°C. Cooling systems should be inspected at Rack 12B.
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-slate-500 uppercase mb-1">Duration</p>
                      <p className="text-lg font-mono font-bold text-amber-400">00:22:45</p>
                    </div>
                    <button className="ml-6 px-4 py-2 bg-[#233544] text-slate-300 text-xs font-bold rounded uppercase hover:bg-[#2D3748]">
                      Acknowledge
                    </button>
                  </div>
                </div>

                {/* Info Alert */}
                <div className="bg-[#161E2E] rounded-xl border-l-4 border-l-[#00E5FF] border border-[#233544] p-5">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-full bg-[#00E5FF]/20 flex items-center justify-center">
                        <span className="material-icons-outlined text-[#00E5FF]">info</span>
                      </div>
                      <div>
                        <div className="flex items-center gap-3 mb-1">
                          <span className="text-[10px] bg-[#00E5FF] text-[#0B1120] px-2 py-0.5 rounded font-bold uppercase">Info</span>
                          <span className="text-sm font-semibold text-white">Unusual Idle Consumption Detected</span>
                          <span className="text-xs text-slate-500 font-mono">Outlet: PDU-04-OUT-18</span>
                        </div>
                        <p className="text-xs text-slate-400 mt-1">
                          Outlet 18 is showing a baseline consumption of 0.8A while marked as 'IDLE' in the scheduling system.
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-slate-500 uppercase mb-1">Duration</p>
                      <p className="text-lg font-mono font-bold text-[#00E5FF]">01:45:00</p>
                    </div>
                    <button className="ml-6 px-4 py-2 bg-[#233544] text-slate-300 text-xs font-bold rounded uppercase hover:bg-[#2D3748]">
                      Dismiss
                    </button>
                  </div>
                </div>

                {/* Another Warning */}
                <div className="bg-[#161E2E] rounded-xl border-l-4 border-l-amber-500 border border-[#233544] p-5">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
                        <span className="material-icons-outlined text-amber-500">bolt</span>
                      </div>
                      <div>
                        <div className="flex items-center gap-3 mb-1">
                          <span className="text-[10px] bg-amber-500 text-white px-2 py-0.5 rounded font-bold uppercase">Warning</span>
                          <span className="text-sm font-semibold text-white">Voltage Fluctuation Observed</span>
                          <span className="text-xs text-slate-500 font-mono">PDU: 10.0.4.155</span>
                        </div>
                        <p className="text-xs text-slate-400 mt-1">
                          Phase L1 voltage dipped to 208V. Monitoring for stability before escalation.
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-slate-500 uppercase mb-1">Duration</p>
                      <p className="text-lg font-mono font-bold text-amber-400">03:12:11</p>
                    </div>
                    <button className="ml-6 px-4 py-2 bg-[#233544] text-slate-300 text-xs font-bold rounded uppercase hover:bg-[#2D3748]">
                      Acknowledge
                    </button>
                  </div>
                </div>
              </div>

              {/* Predictive Analysis Section */}
              <div className="mt-8">
                <h2 className="text-sm font-mono font-bold text-red-400 uppercase tracking-wider mb-4">
                  Predictive Analysis & Insights
                </h2>
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-[#161E2E] rounded-xl border border-[#233544] p-5">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-full bg-[#00E5FF]/20 flex items-center justify-center">
                        <span className="material-icons-outlined text-[#00E5FF]">auto_awesome</span>
                      </div>
                      <div className="flex-1">
                        <h4 className="text-sm font-semibold text-white mb-1">Efficiency Opportunity</h4>
                        <p className="text-xs text-slate-500 mb-1">Found {idleOutlets} outlets with sustained low load.</p>
                        <p className="text-xs text-slate-400 mt-2">
                          PDUMind Assistant suggests consolidating workloads from Rack 05 to Rack 02 to disable idle equipment and reduce thermal waste.
                        </p>
                        <button className="mt-3 text-[#00E5FF] text-xs font-mono uppercase flex items-center gap-1 hover:underline">
                          Generate Consolidation Plan
                          <span className="material-icons-outlined text-xs">open_in_new</span>
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="bg-[#161E2E] rounded-xl border border-amber-500/30 p-5">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
                        <span className="material-icons-outlined text-amber-500">warning</span>
                      </div>
                      <div className="flex-1">
                        <h4 className="text-sm font-semibold text-white mb-1">Forecast: Capacity Limit</h4>
                        <p className="text-xs text-slate-500 mb-1">Projected breach in 14 days.</p>
                        <p className="text-xs text-slate-400 mt-2">
                          Based on current growth rate, "Main-Switch-A" will exceed 80% capacity threshold by end of month.
                        </p>
                        <button className="mt-3 text-amber-400 text-xs font-mono uppercase flex items-center gap-1 hover:underline">
                          View Capacity Forecast
                          <span className="material-icons-outlined text-xs">open_in_new</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Specs View */}
          {activeTab === 'specs' && (
            <>
              <div className="flex justify-between items-start mb-8">
                <div>
                  <h1 className="text-2xl font-bold font-mono uppercase tracking-tight text-[#00E5FF]">
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
                      <h3 className="font-mono font-bold text-[#00E5FF] flex items-center gap-2 uppercase text-sm">
                        <span className="material-icons-outlined">trending_up</span>
                        Load Trends
                      </h3>
                      <div className="flex gap-4 text-[10px] font-mono">
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
                      <span className="text-xs font-mono text-slate-500">Peak Demand: <strong className="text-white">{Math.round(power * 1.03)} W</strong></span>
                    </div>
                  </div>

                  {/* Environmental Mini */}
                  <div className="bg-[#161E2E] rounded-xl border border-[#233544] p-6">
                    <h3 className="font-mono font-bold text-[#00E5FF] flex items-center gap-2 uppercase text-sm mb-6">
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
                    <h1 className="text-2xl font-bold font-mono uppercase tracking-tight text-[#00E5FF]">
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
        </main>
      </div>
    </div>
  );
};

export default Dashboard2;
