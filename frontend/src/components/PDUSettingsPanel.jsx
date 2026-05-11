import React, { useState, useEffect, useCallback, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

const TABS = [
  { id: 'network', label: 'Network', icon: 'lan' },
  { id: 'snmp', label: 'SNMP', icon: 'vpn_key' },
  { id: 'time', label: 'Time', icon: 'schedule' },
  { id: 'telemetry', label: 'Live Telemetry', icon: 'electric_bolt' },
  { id: 'logs', label: 'Event Logs', icon: 'history' },
];

const InputField = ({ label, value, onChange, disabled, mono = true }) => (
  <div>
    <label className="text-[9px] text-slate-500 uppercase tracking-wider block mb-1">{label}</label>
    <input
      type="text"
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      className={`w-full bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#00E5FF] disabled:opacity-50 ${mono ? 'font-mono' : ''}`}
    />
  </div>
);

const StatusBadge = ({ ok, label }) => (
  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono ${
    ok ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-500/20 text-slate-400 border border-slate-500/30'
  }`}>
    <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-400' : 'bg-slate-500'}`} />
    {label}
  </span>
);

const PDUSettingsPanel = ({ pdu }) => {
  const host = pdu?.remote_host || pdu?.ip;
  const port = pdu?.web_admin_port || 6662;
  const username = pdu?.web_admin_user || 'admin';
  const password = pdu?.web_admin_pass || 'admin';

  const [tab, setTab] = useState('network');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  // Settings state
  const [network, setNetwork] = useState({});
  const [snmp, setSnmp] = useState({});
  const [timeConfig, setTimeConfig] = useState({});
  const [telemetry, setTelemetry] = useState(null);
  const [logs, setLogs] = useState([]);
  const [deviceInfo, setDeviceInfo] = useState({});
  const [rebootStatus, setRebootStatus] = useState(null);

  const telemetryTimer = useRef(null);

  const queryParams = `port=${port}&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

  const fetchSettings = useCallback(async () => {
    if (!host) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/pdu-admin/${host}/settings?${queryParams}`);
      const data = await res.json();
      if (data.success || data.network) {
        setNetwork(data.network || {});
        setSnmp(data.snmp || {});
        setTimeConfig(data.time || {});
        setDeviceInfo(data.device || {});
      } else {
        setError(data.error || 'Failed to read settings');
      }
    } catch (e) {
      setError(`Connection failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [host, queryParams]);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  // Auto-poll telemetry from the cached background poller (no direct PDU login)
  useEffect(() => {
    if (tab !== 'telemetry' || !pdu?.ip) {
      clearInterval(telemetryTimer.current);
      return;
    }
    const REVERSE_MAP = {
      L1Voltage: 'l1_voltage', L1Current: 'l1_current', L1Power: 'l1_active_power',
      L2Voltage: 'l2_voltage', L2Current: 'l2_current', L2Power: 'l2_active_power',
      L3Voltage: 'l3_voltage', L3Current: 'l3_current', L3Power: 'l3_active_power',
      TotalCurrent: 'neutral_current', TotalPower: 'total_active_power',
      TotalEnergy: 'total_active_energy', Frequency: 'frequency',
    };
    const poll = async () => {
      try {
        const rh = host !== pdu.ip ? `?remote_host=${encodeURIComponent(host)}` : '';
        const res = await fetch(`${API_BASE}/api/pdus/by-ip/${pdu.ip}/live${rh}`);
        const data = await res.json();
        if (data.results) {
          const tele = {};
          for (const r of data.results) {
            tele[r.name] = r.value;
            const alt = REVERSE_MAP[r.name];
            if (alt) tele[alt] = r.value;
          }
          setTelemetry(tele);
        }
      } catch {}
    };
    poll();
    telemetryTimer.current = setInterval(poll, 10000);
    return () => clearInterval(telemetryTimer.current);
  }, [tab, pdu?.ip, host]);

  // Fetch logs when switching to logs tab
  useEffect(() => {
    if (tab !== 'logs' || !host) return;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/pdu-admin/${host}/logs?${queryParams}`);
        const data = await res.json();
        if (data.success) setLogs(data.logs || []);
      } catch {}
    })();
  }, [tab, host, queryParams]);

  const saveNetwork = async () => {
    setSaving(true); setError(null); setSuccess(null); setRebootStatus(null);
    try {
      const res = await fetch(`${API_BASE}/api/pdu-admin/${host}/settings/network`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: network.set_ip || network.current_ip,
          mask: network.set_mask || network.current_mask,
          gateway: network.set_gateway || network.current_gateway,
          dns1: network.set_dns1 || network.current_dns1,
          dns2: network.set_dns2 || network.current_dns2,
          web_port: port, username, password,
          reboot: true,
        }),
      });
      const data = await res.json();
      if (!data.success) { setError(data.error); setSaving(false); return; }

      if (data.rebooting) {
        setRebootStatus('rebooting');
        setSaving(false);
        const deadline = Date.now() + 90_000;
        const poll = async () => {
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 5000));
            try {
              const pr = await fetch(`${API_BASE}/api/pdu-admin/${host}/ping?${queryParams}`);
              const pd = await pr.json();
              if (pd.online) { setRebootStatus('online'); fetchSettings(); return; }
            } catch { /* still offline */ }
          }
          setRebootStatus('failed');
        };
        poll();
      } else {
        setSuccess('Network settings saved (pending reboot)');
        setTimeout(() => setSuccess(null), 3000);
        setSaving(false);
      }
    } catch (e) { setError(e.message); setSaving(false); }
  };

  const saveSnmp = async () => {
    setSaving(true); setError(null); setSuccess(null);
    try {
      const res = await fetch(`${API_BASE}/api/pdu-admin/${host}/settings/snmp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          community_read: snmp.community_read,
          community_write: snmp.community_write,
          snmpv1: snmp.snmpv1_enabled,
          snmpv2: snmp.snmpv2_enabled,
          snmpv3: snmp.snmpv3_enabled,
          trap_ip: snmp.trap_ip,
          snmpv3_username: snmp.snmpv3_username,
          verify_protocol: snmp.verify_protocol,
          auth_key: snmp.auth_key,
          encrypt_protocol: snmp.encrypt_protocol,
          priv_key: snmp.priv_key,
          web_port: port, username, password,
        }),
      });
      const data = await res.json();
      if (data.success) { setSuccess('SNMP settings applied'); setTimeout(() => setSuccess(null), 3000); }
      else setError(data.error);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const saveTime = async () => {
    setSaving(true); setError(null); setSuccess(null);
    try {
      const res = await fetch(`${API_BASE}/api/pdu-admin/${host}/settings/time`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...timeConfig,
          web_port: port, username, password,
        }),
      });
      const data = await res.json();
      if (data.success) { setSuccess('Time settings applied'); setTimeout(() => setSuccess(null), 3000); }
      else setError(data.error);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  if (!host) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 text-sm">
        <span className="material-icons-outlined mr-2">info</span>
        Select a PDU with web admin capabilities to view settings.
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl font-bold font-mono uppercase tracking-tight text-[#00E5FF]">
              <span className="material-icons-outlined align-middle mr-2">settings</span>
              PDU Settings
            </h1>
          </div>
          <p className="text-sm text-slate-500">
            {deviceInfo.name || host} &middot; FW {deviceInfo.firmware || '?'} &middot; MAC {deviceInfo.mac || '?'}
          </p>
        </div>
        <button onClick={fetchSettings} disabled={loading}
          className="px-3 py-1.5 bg-[#161E2E] border border-[#233544] hover:border-[#00E5FF]/30 text-slate-300 rounded-lg text-xs flex items-center gap-1.5 transition-all">
          <span className={`material-icons-outlined text-sm ${loading ? 'animate-spin' : ''}`}>refresh</span>
          Refresh
        </button>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-1 mb-6 bg-[#0a1222] rounded-lg p-1">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex-1 py-2 px-3 text-xs font-mono uppercase rounded-md flex items-center justify-center gap-1.5 transition-all ${
              tab === t.id
                ? 'bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/40'
                : 'text-slate-500 hover:text-slate-300 border border-transparent'
            }`}>
            <span className="material-icons-outlined text-sm">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* Banners */}
      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm flex items-center gap-2">
          <span className="material-icons-outlined text-sm">error</span>
          {error}
          <button onClick={() => setError(null)} className="ml-auto"><span className="material-icons-outlined text-sm">close</span></button>
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-emerald-400 text-sm flex items-center gap-2">
          <span className="material-icons-outlined text-sm">check_circle</span>
          {success}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-40 text-slate-500">
          <span className="material-icons-outlined animate-spin mr-2">sync</span> Loading settings...
        </div>
      ) : (
        <>
          {/* NETWORK TAB */}
          {tab === 'network' && (
            <div className="space-y-4">
              <div className="p-5 rounded-xl bg-[#0B1120] border border-[#233544]">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <span className="material-icons-outlined text-[#00E5FF] text-sm">lan</span>
                    IPv4 Configuration
                  </h3>
                  <button onClick={saveNetwork} disabled={saving || rebootStatus === 'rebooting'}
                    className="px-4 py-1.5 bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 rounded-lg text-xs font-mono hover:bg-emerald-500/30 disabled:opacity-50 transition-all flex items-center gap-1.5">
                    {saving ? <span className="material-icons-outlined text-sm animate-spin">sync</span> : <span className="material-icons-outlined text-sm">save</span>}
                    {rebootStatus === 'rebooting' ? 'Rebooting...' : 'Apply & Reboot'}
                  </button>
                </div>

                {rebootStatus && (
                  <div className={`mb-4 p-3 rounded-lg border flex items-center gap-2 ${
                    rebootStatus === 'rebooting' ? 'bg-amber-500/10 border-amber-500/30' :
                    rebootStatus === 'online' ? 'bg-emerald-500/10 border-emerald-500/30' :
                    'bg-red-500/10 border-red-500/30'
                  }`}>
                    <span className={`material-icons-outlined text-base ${
                      rebootStatus === 'rebooting' ? 'text-amber-400 animate-spin' :
                      rebootStatus === 'online' ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {rebootStatus === 'rebooting' ? 'sync' : rebootStatus === 'online' ? 'check_circle' : 'error'}
                    </span>
                    <span className={`text-xs font-mono ${
                      rebootStatus === 'rebooting' ? 'text-amber-300' :
                      rebootStatus === 'online' ? 'text-emerald-300' : 'text-red-300'
                    }`}>
                      {rebootStatus === 'rebooting' && 'PDU is rebooting to apply network changes... (~60 s)'}
                      {rebootStatus === 'online' && 'PDU is back online. New settings are now active.'}
                      {rebootStatus === 'failed' && 'PDU did not respond within 90 s. Check the device.'}
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <InputField label="IP Address" value={network.set_ip || network.current_ip}
                    onChange={v => setNetwork(p => ({ ...p, set_ip: v }))} />
                  <InputField label="Subnet Mask" value={network.set_mask || network.current_mask}
                    onChange={v => setNetwork(p => ({ ...p, set_mask: v }))} />
                  <InputField label="Gateway" value={network.set_gateway || network.current_gateway}
                    onChange={v => setNetwork(p => ({ ...p, set_gateway: v }))} />
                  <InputField label="DNS 1" value={network.set_dns1 || network.current_dns1}
                    onChange={v => setNetwork(p => ({ ...p, set_dns1: v }))} />
                  <InputField label="DNS 2" value={network.set_dns2 || network.current_dns2}
                    onChange={v => setNetwork(p => ({ ...p, set_dns2: v }))} />
                  <InputField label="DHCP" value={network.dhcp || 'OFF'} disabled />
                </div>
              </div>

              {/* Read-only current values */}
              <div className="p-5 rounded-xl bg-[#0B1120] border border-[#233544]">
                <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                  <span className="material-icons-outlined text-slate-500 text-sm">info</span>
                  Current Active Values (read-only)
                </h3>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { l: 'MAC', v: network.mac },
                    { l: 'IP', v: network.current_ip },
                    { l: 'Mask', v: network.current_mask },
                    { l: 'Gateway', v: network.current_gateway },
                    { l: 'DNS 1', v: network.current_dns1 },
                    { l: 'DNS 2', v: network.current_dns2 },
                  ].map(f => (
                    <div key={f.l} className="bg-[#161E2E] rounded-lg p-2">
                      <p className="text-[9px] text-slate-500 uppercase">{f.l}</p>
                      <p className="text-xs font-mono text-white mt-0.5">{f.v || '-'}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* SNMP TAB */}
          {tab === 'snmp' && (
            <div className="space-y-4">
              <div className="p-5 rounded-xl bg-[#0B1120] border border-[#233544]">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <span className="material-icons-outlined text-[#00E5FF] text-sm">vpn_key</span>
                    SNMP Configuration
                  </h3>
                  <button onClick={saveSnmp} disabled={saving}
                    className="px-4 py-1.5 bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 rounded-lg text-xs font-mono hover:bg-emerald-500/30 disabled:opacity-50 transition-all flex items-center gap-1.5">
                    {saving ? <span className="material-icons-outlined text-sm animate-spin">sync</span> : <span className="material-icons-outlined text-sm">save</span>}
                    Apply to PDU
                  </button>
                </div>

                {/* Version toggles */}
                <div className="flex gap-4 mb-4">
                  {[
                    { key: 'snmpv1_enabled', label: 'SNMPv1' },
                    { key: 'snmpv2_enabled', label: 'SNMPv2c' },
                    { key: 'snmpv3_enabled', label: 'SNMPv3' },
                  ].map(v => (
                    <label key={v.key} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={snmp[v.key] || false}
                        onChange={e => setSnmp(p => ({ ...p, [v.key]: e.target.checked }))}
                        className="accent-[#00E5FF]" />
                      <StatusBadge ok={snmp[v.key]} label={v.label} />
                    </label>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <InputField label="Read Community" value={snmp.community_read}
                    onChange={v => setSnmp(p => ({ ...p, community_read: v }))} />
                  <InputField label="Write Community" value={snmp.community_write}
                    onChange={v => setSnmp(p => ({ ...p, community_write: v }))} />
                  <InputField label="Trap Destination IP" value={snmp.trap_ip}
                    onChange={v => setSnmp(p => ({ ...p, trap_ip: v }))} />
                </div>
              </div>

              {/* SNMPv3 section */}
              {snmp.snmpv3_enabled && (
                <div className="p-5 rounded-xl bg-[#0B1120] border border-[#233544]">
                  <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                    <span className="material-icons-outlined text-amber-400 text-sm">security</span>
                    SNMPv3 Credentials
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    <InputField label="Username" value={snmp.snmpv3_username}
                      onChange={v => setSnmp(p => ({ ...p, snmpv3_username: v }))} />
                    <InputField label="Auth Protocol" value={snmp.verify_protocol}
                      onChange={v => setSnmp(p => ({ ...p, verify_protocol: v }))} />
                    <InputField label="Auth Key" value={snmp.auth_key}
                      onChange={v => setSnmp(p => ({ ...p, auth_key: v }))} />
                    <InputField label="Privacy Protocol" value={snmp.encrypt_protocol}
                      onChange={v => setSnmp(p => ({ ...p, encrypt_protocol: v }))} />
                    <InputField label="Privacy Key" value={snmp.priv_key}
                      onChange={v => setSnmp(p => ({ ...p, priv_key: v }))} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TIME TAB */}
          {tab === 'time' && (
            <div className="p-5 rounded-xl bg-[#0B1120] border border-[#233544]">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <span className="material-icons-outlined text-[#00E5FF] text-sm">schedule</span>
                  Time & SNTP Settings
                </h3>
                <button onClick={saveTime} disabled={saving}
                  className="px-4 py-1.5 bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 rounded-lg text-xs font-mono hover:bg-emerald-500/30 disabled:opacity-50 transition-all flex items-center gap-1.5">
                  {saving ? <span className="material-icons-outlined text-sm animate-spin">sync</span> : <span className="material-icons-outlined text-sm">save</span>}
                  Apply to PDU
                </button>
              </div>

              <div className="grid grid-cols-3 gap-3 mb-4">
                <InputField label="Year" value={timeConfig.year}
                  onChange={v => setTimeConfig(p => ({ ...p, year: v }))} />
                <InputField label="Month" value={timeConfig.month}
                  onChange={v => setTimeConfig(p => ({ ...p, month: v }))} />
                <InputField label="Day" value={timeConfig.day}
                  onChange={v => setTimeConfig(p => ({ ...p, day: v }))} />
                <InputField label="Hour" value={timeConfig.hour}
                  onChange={v => setTimeConfig(p => ({ ...p, hour: v }))} />
                <InputField label="Minute" value={timeConfig.minute}
                  onChange={v => setTimeConfig(p => ({ ...p, minute: v }))} />
                <InputField label="Second" value={timeConfig.second}
                  onChange={v => setTimeConfig(p => ({ ...p, second: v }))} />
              </div>

              <div className="border-t border-[#233544] pt-4 mt-4">
                <h4 className="text-xs font-bold text-slate-400 mb-3 uppercase">SNTP</h4>
                <div className="grid grid-cols-2 gap-3">
                  <InputField label="SNTP Server" value={timeConfig.sntp_server}
                    onChange={v => setTimeConfig(p => ({ ...p, sntp_server: v }))} />
                  <InputField label="Timezone" value={timeConfig.timezone}
                    onChange={v => setTimeConfig(p => ({ ...p, timezone: v }))} />
                  <InputField label="Update Interval" value={timeConfig.update_interval}
                    onChange={v => setTimeConfig(p => ({ ...p, update_interval: v }))} />
                  <InputField label="Correction" value={timeConfig.correction}
                    onChange={v => setTimeConfig(p => ({ ...p, correction: v }))} />
                </div>
              </div>
            </div>
          )}

          {/* TELEMETRY TAB */}
          {tab === 'telemetry' && (
            <div className="space-y-4">
              {!telemetry ? (
                <div className="flex items-center justify-center h-40 text-slate-500">
                  <span className="material-icons-outlined animate-spin mr-2">sync</span> Connecting to PDU...
                </div>
              ) : (
                <>
                  {/* System stats */}
                  <div className="grid grid-cols-3 gap-3">
                    <TeleCard label="Frequency" value={telemetry.frequency} unit="Hz" icon="speed" />
                    <TeleCard label="Neutral Current" value={telemetry.neutral_current} unit="A" icon="electric_bolt" />
                    <TeleCard label="Neutral Load" value={telemetry.neutral_load_pct} unit="%" icon="monitor_heart" />
                  </div>

                  {/* Per-phase */}
                  <div className="grid grid-cols-3 gap-4">
                    {['l1', 'l2', 'l3'].map((phase, i) => (
                      <div key={phase} className="p-4 rounded-xl bg-[#0B1120] border border-[#233544]">
                        <h4 className={`text-sm font-bold mb-3 ${['text-red-400', 'text-amber-400', 'text-blue-400'][i]}`}>
                          Phase {phase.toUpperCase()}
                        </h4>
                        <div className="space-y-2">
                          {[
                            { l: 'Voltage', k: `${phase}_voltage`, u: 'V' },
                            { l: 'Current', k: `${phase}_current`, u: 'A' },
                            { l: 'Load', k: `${phase}_load_pct`, u: '%' },
                            { l: 'Active Power', k: `${phase}_active_power`, u: 'W' },
                            { l: 'Reactive Power', k: `${phase}_reactive_power`, u: 'VAR' },
                            { l: 'Apparent Power', k: `${phase}_apparent_power`, u: 'VA' },
                            { l: 'Power Factor', k: `${phase}_pf`, u: '' },
                            { l: 'Active Energy', k: `${phase}_active_energy`, u: 'kWh' },
                          ].map(m => (
                            <div key={m.k} className="flex justify-between items-baseline">
                              <span className="text-[10px] text-slate-500">{m.l}</span>
                              <span className="text-sm font-mono text-white">
                                {telemetry[m.k] ?? '-'}
                                {m.u && <span className="text-[10px] text-slate-500 ml-1">{m.u}</span>}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Totals */}
                  <div className="p-4 rounded-xl bg-[#0B1120] border border-[#233544]">
                    <h4 className="text-sm font-bold text-[#00E5FF] mb-3">Totals</h4>
                    <div className="grid grid-cols-3 gap-4">
                      {[
                        { l: 'Active Power', k: 'total_active_power', u: 'W' },
                        { l: 'Reactive Power', k: 'total_reactive_power', u: 'VAR' },
                        { l: 'Apparent Power', k: 'total_apparent_power', u: 'VA' },
                        { l: 'Power Factor', k: 'total_pf', u: '' },
                        { l: 'Active Energy', k: 'total_active_energy', u: 'kWh' },
                        { l: 'Reactive Energy', k: 'total_reactive_energy', u: 'kVARh' },
                      ].map(m => (
                        <div key={m.k} className="flex justify-between items-baseline">
                          <span className="text-xs text-slate-500">{m.l}</span>
                          <span className="text-lg font-mono font-bold text-white">
                            {telemetry[m.k] ?? '-'}
                            {m.u && <span className="text-xs text-slate-500 ml-1">{m.u}</span>}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Breakers */}
                  {telemetry.breakers && telemetry.breakers.length > 0 && (
                    <div className="p-4 rounded-xl bg-[#0B1120] border border-[#233544]">
                      <h4 className="text-sm font-bold text-white mb-3">Breakers</h4>
                      <div className="flex flex-wrap gap-2">
                        {telemetry.breakers.map((b, i) => (
                          <div key={i} className={`px-3 py-1.5 rounded-lg text-xs font-mono border ${
                            b.color === 'green' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' :
                            b.color === 'red' ? 'bg-red-500/10 border-red-500/30 text-red-400' :
                            'bg-slate-500/10 border-slate-500/30 text-slate-400'
                          }`}>
                            B{i + 1}: {b.status}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* LOGS TAB */}
          {tab === 'logs' && (
            <div className="p-5 rounded-xl bg-[#0B1120] border border-[#233544]">
              <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                <span className="material-icons-outlined text-[#00E5FF] text-sm">history</span>
                Event Log ({logs.length} entries)
              </h3>
              {logs.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-8">No log entries available.</p>
              ) : (
                <div className="max-h-[500px] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-slate-500 uppercase text-[10px] border-b border-[#233544]">
                        <th className="text-left py-2 px-2">Date</th>
                        <th className="text-left py-2 px-2">Time</th>
                        <th className="text-left py-2 px-2">Category</th>
                        <th className="text-left py-2 px-2">Event</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((log, i) => (
                        <tr key={i} className="border-b border-[#233544]/50 hover:bg-[#161E2E]">
                          <td className="py-1.5 px-2 font-mono text-slate-300">{log.date}</td>
                          <td className="py-1.5 px-2 font-mono text-slate-300">{log.time}</td>
                          <td className="py-1.5 px-2">
                            <span className={`px-1.5 py-0.5 rounded text-[9px] ${
                              log.color === 'red' ? 'bg-red-500/20 text-red-400' :
                              log.color === 'green' ? 'bg-emerald-500/20 text-emerald-400' :
                              'bg-slate-500/20 text-slate-400'
                            }`}>{log.category}</span>
                          </td>
                          <td className="py-1.5 px-2 text-white">{log.event}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

const TeleCard = ({ label, value, unit, icon }) => (
  <div className="p-4 rounded-xl bg-[#0B1120] border border-[#233544] flex items-center gap-3">
    <div className="w-10 h-10 rounded-lg bg-[#161E2E] flex items-center justify-center">
      <span className="material-icons-outlined text-[#00E5FF]">{icon}</span>
    </div>
    <div>
      <p className="text-[10px] text-slate-500 uppercase">{label}</p>
      <p className="text-xl font-mono font-bold text-white">
        {value ?? '-'}
        {unit && <span className="text-xs text-slate-500 ml-1">{unit}</span>}
      </p>
    </div>
  </div>
);

export default PDUSettingsPanel;
