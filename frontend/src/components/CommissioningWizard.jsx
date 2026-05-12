import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

const STEPS = [
  { id: 'scan', label: 'Detect PDU', icon: 'wifi_find' },
  { id: 'configure', label: 'Configure', icon: 'settings' },
  { id: 'rack', label: 'Assign Rack', icon: 'view_in_ar' },
  { id: 'confirm', label: 'Confirm', icon: 'check_circle' },
];

const CommissioningWizard = ({ hallId, hallName, onComplete, onClose }) => {
  const [step, setStep] = useState(0);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Step 1: Scan
  const [scanMode, setScanMode] = useState('factory');
  const [factoryIp, setFactoryIp] = useState('192.168.0.163');
  const [manualIp, setManualIp] = useState('');
  const [subnet, setSubnet] = useState('192.168.1.0/24');
  const [community, setCommunity] = useState('public');
  const [detectedDevice, setDetectedDevice] = useState(null);
  const [subnetDevices, setSubnetDevices] = useState([]);

  // Remote PDU (web admin)
  const [remoteHost, setRemoteHost] = useState('');
  const [remotePort, setRemotePort] = useState('6662');
  const [remoteUser, setRemoteUser] = useState('admin');
  const [remotePass, setRemotePass] = useState('admin');
  const [remoteSettings, setRemoteSettings] = useState(null); // full settings from PDU
  const [isRemoteMode, setIsRemoteMode] = useState(false);

  // Step 2: Configure (network + SNMP from web admin, or IP assignment for SNMP-only)
  const [suggestedIp, setSuggestedIp] = useState('');
  const [customIp, setCustomIp] = useState('');
  const [useCustomIp, setUseCustomIp] = useState(false);
  const [usedIps, setUsedIps] = useState([]);
  const [ipSubnet, setIpSubnet] = useState('');
  // Editable settings for remote PDU
  const [editNetwork, setEditNetwork] = useState({});
  const [editSnmp, setEditSnmp] = useState({});
  const [editTime, setEditTime] = useState({});
  const [ipConflict, setIpConflict] = useState(false);
  const [rebootStatus, setRebootStatus] = useState(null); // null | 'rebooting' | 'online' | 'failed'

  // Step 3: Rack Assignment
  const [availableRacks, setAvailableRacks] = useState([]);
  const [selectedRack, setSelectedRack] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [pduLabel, setPduLabel] = useState('');

  // Step 4: Confirm result
  const [commissioned, setCommissioned] = useState(false);
  const [commissionResult, setCommissionResult] = useState(null);

  const currentStep = STEPS[step];

  // Fetch data when entering step 1 (Configure)
  useEffect(() => {
    if (step === 1 && hallId) {
      fetchNextIp();
      if (isRemoteMode && remoteSettings) {
        setEditNetwork({
          ip: remoteSettings.network?.current_ip || '',
          mask: remoteSettings.network?.current_mask || '255.255.255.0',
          gateway: remoteSettings.network?.current_gateway || '',
          dns1: remoteSettings.network?.current_dns1 || '',
          dns2: remoteSettings.network?.current_dns2 || '',
        });
        setEditSnmp({
          community_read: remoteSettings.snmp?.community_read || 'public',
          community_write: remoteSettings.snmp?.community_write || 'private',
          snmpv1: remoteSettings.snmp?.snmpv1_enabled || false,
          snmpv2: remoteSettings.snmp?.snmpv2_enabled || false,
          trap_ip: remoteSettings.snmp?.trap_ip || '',
        });
        setEditTime({
          year: remoteSettings.time?.year || '',
          month: remoteSettings.time?.month || '',
          day: remoteSettings.time?.day || '',
          hour: remoteSettings.time?.hour || '',
          minute: remoteSettings.time?.minute || '',
          second: remoteSettings.time?.second || '',
          sntp_enabled: remoteSettings.time?.sntp_enabled || '',
          sntp_server: remoteSettings.time?.sntp_server || '',
          timezone: remoteSettings.time?.timezone || '',
          update_interval: remoteSettings.time?.update_interval || '',
          correction: remoteSettings.time?.correction || '',
        });
      }
    }
  }, [step, hallId, isRemoteMode, remoteSettings]);

  // Check for IP conflicts whenever the network IP changes
  useEffect(() => {
    if (isRemoteMode && editNetwork.ip) {
      setIpConflict(usedIps.includes(editNetwork.ip));
    } else {
      setIpConflict(false);
    }
  }, [editNetwork.ip, usedIps, isRemoteMode]);

  // Fetch available racks when we move to step 2 (Rack)
  useEffect(() => {
    if (step === 2 && hallId) {
      fetchAvailableRacks();
    }
  }, [step, hallId]);

  const fetchNextIp = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/halls/${hallId}/pdus/next-ip`);
      const data = await res.json();
      if (data.success) {
        setSuggestedIp(data.next_ip);
        setUsedIps(data.used_ips || []);
        setIpSubnet(data.subnet || '');
      }
    } catch (e) {
      console.error('Failed to fetch next IP:', e);
    }
  };

  const fetchAvailableRacks = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/halls/${hallId}/racks/available`);
      const data = await res.json();
      if (data.success) {
        setAvailableRacks(data.racks || []);
      }
    } catch (e) {
      console.error('Failed to fetch racks:', e);
    }
  };

  // Step 1 handlers
  const scanFactory = async () => {
    setLoading(true);
    setError(null);
    setDetectedDevice(null);
    try {
      const res = await fetch(`${API_BASE}/api/network/scan/factory-default`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factory_ip: factoryIp, community, scan_subnet: false })
      });
      const data = await res.json();
      if (data.found && data.device) {
        setDetectedDevice(data.device);
      } else {
        setError(data.message || 'No PDU found at factory default IP');
      }
    } catch (e) {
      setError(`Scan failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const scanManual = async () => {
    if (!manualIp) { setError('Enter an IP address'); return; }
    setLoading(true);
    setError(null);
    setDetectedDevice(null);
    try {
      const res = await fetch(`${API_BASE}/api/network/scan/ip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: manualIp, community })
      });
      const data = await res.json();
      if (data.success) {
        setDetectedDevice(data);
      } else {
        setError(data.error || 'No SNMP response');
      }
    } catch (e) {
      setError(`Scan failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const scanSubnet = async () => {
    setLoading(true);
    setError(null);
    setSubnetDevices([]);
    try {
      const res = await fetch(`${API_BASE}/api/network/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subnet, community, timeout: 1 })
      });
      const data = await res.json();
      if (data.discovered && data.discovered.length > 0) {
        setSubnetDevices(data.discovered);
      } else {
        setError('No devices found on this subnet');
      }
    } catch (e) {
      setError(`Scan failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const selectSubnetDevice = (device) => {
    setDetectedDevice(device);
    setSubnetDevices([]);
  };

  // Remote PDU connect via web admin
  const connectRemotePdu = async () => {
    if (!remoteHost) { setError('Enter the PDU host/IP address'); return; }
    // Strip protocol, trailing slashes/paths, and port from the host field
    let cleanHost = remoteHost.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    // If user pasted host:port, extract the port
    if (cleanHost.includes(':')) {
      const [h, p] = cleanHost.split(':');
      cleanHost = h;
      if (p && !remotePort) setRemotePort(p);
    }
    setRemoteHost(cleanHost);
    setLoading(true);
    setError(null);
    setDetectedDevice(null);
    setRemoteSettings(null);
    try {
      const res = await fetch(`${API_BASE}/api/pdu-admin/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: cleanHost, port: parseInt(remotePort) || 6662, username: remoteUser, password: remotePass })
      });
      const data = await res.json();
      if (data.success) {
        setIsRemoteMode(true);
        setRemoteSettings(data);
        setDetectedDevice({
          ip: data.device?.ip || remoteHost,
          name: data.device?.name || 'PDU',
          firmware: data.device?.firmware || '',
          mac: data.device?.mac || '',
          description: `${data.device?.name || 'PDU'} (FW ${data.device?.firmware || '?'}) via Web Admin`,
          snmp_version: '2c',
        });
        setCommunity(data.snmp?.community_read || 'public');
      } else {
        setError(data.error || 'Connection failed');
      }
    } catch (e) {
      setError(`Connection failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Apply network settings to remote PDU, then reboot so changes take effect
  const applyNetworkSettings = async () => {
    if (!isRemoteMode) return;
    setLoading(true);
    setError(null);
    setRebootStatus(null);
    try {
      const res = await fetch(`${API_BASE}/api/pdu-admin/${remoteHost}/settings/network`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...editNetwork,
          web_port: parseInt(remotePort) || 6662,
          username: remoteUser,
          password: remotePass,
          reboot: true,
        })
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Failed to apply network settings');
        setLoading(false);
        return;
      }

      if (data.rebooting) {
        setRebootStatus('rebooting');
        setLoading(false);
        const qp = `port=${parseInt(remotePort) || 6662}&username=${encodeURIComponent(remoteUser)}&password=${encodeURIComponent(remotePass)}`;
        const deadline = Date.now() + 90_000;
        const poll = async () => {
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 5000));
            try {
              const pr = await fetch(`${API_BASE}/api/pdu-admin/${remoteHost}/ping?${qp}`);
              const pd = await pr.json();
              if (pd.online) {
                setRebootStatus('online');
                return;
              }
            } catch { /* still offline */ }
          }
          setRebootStatus('failed');
        };
        poll();
      } else {
        setLoading(false);
      }
    } catch (e) {
      setError(`Failed: ${e.message}`);
      setLoading(false);
    }
  };

  // Apply SNMP settings to remote PDU
  const applySnmpSettings = async () => {
    if (!isRemoteMode) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/pdu-admin/${remoteHost}/settings/snmp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...editSnmp, web_port: parseInt(remotePort) || 6662, username: remoteUser, password: remotePass })
      });
      const data = await res.json();
      if (!data.success) setError(data.error || 'Failed to apply SNMP settings');
    } catch (e) {
      setError(`Failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Apply time settings to remote PDU
  const applyTimeSettings = async () => {
    if (!isRemoteMode) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/pdu-admin/${remoteHost}/settings/time`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...editTime, web_port: parseInt(remotePort) || 6662, username: remoteUser, password: remotePass })
      });
      const data = await res.json();
      if (!data.success) setError(data.error || 'Failed to apply time settings');
    } catch (e) {
      setError(`Failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Final commission
  const handleCommission = async () => {
    setLoading(true);
    setError(null);
    const finalIp = isRemoteMode
      ? (editNetwork.ip || remoteHost)
      : (useCustomIp ? customIp : suggestedIp);
    const label = pduLabel || `PDU-${finalIp}`;
    const rackCode = selectedRack?.rack_code || null;
    const mountPosition = selectedSlot || 'A';

    const payload = {
      ip_address: finalIp,
      label,
      rack_code: rackCode,
      mount_position: mountPosition,
      snmp_community: isRemoteMode ? (editSnmp.community_read || community) : community,
      snmp_port: 161,
    };
    if (isRemoteMode) {
      payload.remote_host = remoteHost;
      payload.web_admin_port = parseInt(remotePort) || 6662;
      payload.web_admin_user = remoteUser;
      payload.web_admin_pass = remotePass;
      payload.mac_address = detectedDevice?.mac || '';
      payload.hostname = detectedDevice?.name || '';
    }

    try {
      const res = await fetch(`${API_BASE}/api/halls/${hallId}/pdus/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        setCommissioned(true);
        setCommissionResult(data);
      } else {
        setError(data.error || 'Failed to commission PDU');
      }
    } catch (e) {
      setError(`Commission failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const goNext = () => {
    setError(null);
    setStep(s => Math.min(s + 1, STEPS.length - 1));
  };
  const goBack = () => {
    setError(null);
    setStep(s => Math.max(s - 1, 0));
  };

  const finalIp = useCustomIp ? customIp : suggestedIp;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-[#0d1526] rounded-2xl border border-[#233544] w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col shadow-2xl shadow-cyan-500/10">

        {/* Header */}
        <div className="p-5 border-b border-[#233544] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#00E5FF]/20 flex items-center justify-center">
              <span className="material-icons-outlined text-[#00E5FF]">bolt</span>
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Commission PDU</h2>
              <p className="text-xs text-slate-500">{hallName || 'Data Hall'}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors p-1">
            <span className="material-icons-outlined">close</span>
          </button>
        </div>

        {/* Progress Steps */}
        <div className="px-5 py-4 border-b border-[#1a2744] bg-[#0a1222]">
          <div className="flex items-center justify-between">
            {STEPS.map((s, i) => (
              <div key={s.id} className="flex items-center flex-1">
                <div className={`flex items-center gap-2 ${i <= step ? 'text-[#00E5FF]' : 'text-slate-600'}`}>
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                    i < step ? 'bg-[#00E5FF] text-[#0B1120]' :
                    i === step ? 'bg-[#00E5FF]/20 border-2 border-[#00E5FF] text-[#00E5FF]' :
                    'bg-[#161E2E] border border-[#233544] text-slate-600'
                  }`}>
                    {i < step ? (
                      <span className="material-icons-outlined text-sm">check</span>
                    ) : (
                      <span className="material-icons-outlined text-sm">{s.icon}</span>
                    )}
                  </div>
                  <span className={`text-xs uppercase tracking-wider hidden sm:inline ${
                    i <= step ? 'text-slate-300' : 'text-slate-600'
                  }`}>{s.label}</span>
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`flex-1 h-px mx-3 ${i < step ? 'bg-[#00E5FF]' : 'bg-[#233544]'}`} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mx-5 mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm flex items-center gap-2">
            <span className="material-icons-outlined text-sm">error</span>
            {error}
            <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-300">
              <span className="material-icons-outlined text-sm">close</span>
            </button>
          </div>
        )}

        {/* Step Content */}
        <div className="flex-1 overflow-y-auto p-5">

          {/* STEP 1: Detect PDU */}
          {step === 0 && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-bold text-white mb-1">Detect New PDU</h3>
                <p className="text-xs text-slate-500">Find a PDU on the network via SNMP to begin commissioning.</p>
              </div>

              {/* Scan Mode Tabs */}
              <div className="flex gap-1 bg-[#0a1222] rounded-lg p-1">
                {[
                  { id: 'factory', label: 'Factory Default', icon: 'settings_ethernet' },
                  { id: 'manual', label: 'Manual IP', icon: 'edit' },
                  { id: 'subnet', label: 'Subnet Scan', icon: 'lan' },
                  { id: 'remote', label: 'Remote PDU', icon: 'cloud' },
                ].map(m => (
                  <button
                    key={m.id}
                    onClick={() => { setScanMode(m.id); setError(null); setDetectedDevice(null); setSubnetDevices([]); setRemoteSettings(null); setIsRemoteMode(false); }}
                    className={`flex-1 py-2 px-3 text-xs uppercase rounded-md flex items-center justify-center gap-1.5 transition-all ${
                      scanMode === m.id
                        ? 'bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/40'
                        : 'text-slate-500 hover:text-slate-300 border border-transparent'
                    }`}
                  >
                    <span className="material-icons-outlined text-sm">{m.icon}</span>
                    {m.label}
                  </button>
                ))}
              </div>

              {/* Factory Default Mode */}
              {scanMode === 'factory' && (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <input
                      type="text" value={factoryIp}
                      onChange={e => setFactoryIp(e.target.value)}
                      className="flex-1 bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                      placeholder="192.168.0.163"
                    />
                    <input
                      type="text" value={community}
                      onChange={e => setCommunity(e.target.value)}
                      className="w-28 bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                      placeholder="Community"
                    />
                    <button onClick={scanFactory} disabled={loading}
                      className="px-5 py-2.5 bg-[#00E5FF]/20 border border-[#00E5FF]/50 hover:bg-[#00E5FF]/30 disabled:opacity-50 text-[#00E5FF] rounded-lg flex items-center gap-2 transition-all text-sm">
                      {loading ? <span className="material-icons-outlined text-sm animate-spin">sync</span> :
                        <span className="material-icons-outlined text-sm">wifi_find</span>}
                      Detect
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-600">
                    Probes the factory default IP for a new unboxed PDU.
                  </p>
                </div>
              )}

              {/* Manual IP Mode */}
              {scanMode === 'manual' && (
                <div className="flex gap-2">
                  <input
                    type="text" value={manualIp}
                    onChange={e => setManualIp(e.target.value)}
                    className="flex-1 bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                    placeholder="e.g. 10.20.0.50"
                  />
                  <input
                    type="text" value={community}
                    onChange={e => setCommunity(e.target.value)}
                    className="w-28 bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                    placeholder="Community"
                  />
                  <button onClick={scanManual} disabled={loading}
                    className="px-5 py-2.5 bg-[#00E5FF]/20 border border-[#00E5FF]/50 hover:bg-[#00E5FF]/30 disabled:opacity-50 text-[#00E5FF] rounded-lg flex items-center gap-2 transition-all text-sm">
                    {loading ? <span className="material-icons-outlined text-sm animate-spin">sync</span> :
                      <span className="material-icons-outlined text-sm">search</span>}
                    Scan
                  </button>
                </div>
              )}

              {/* Subnet Scan Mode */}
              {scanMode === 'subnet' && (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <input
                      type="text" value={subnet}
                      onChange={e => setSubnet(e.target.value)}
                      className="flex-1 bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                      placeholder="192.168.1.0/24"
                    />
                    <input
                      type="text" value={community}
                      onChange={e => setCommunity(e.target.value)}
                      className="w-28 bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                      placeholder="Community"
                    />
                    <button onClick={scanSubnet} disabled={loading}
                      className="px-5 py-2.5 bg-[#00E5FF]/20 border border-[#00E5FF]/50 hover:bg-[#00E5FF]/30 disabled:opacity-50 text-[#00E5FF] rounded-lg flex items-center gap-2 transition-all text-sm">
                      {loading ? <span className="material-icons-outlined text-sm animate-spin">sync</span> :
                        <span className="material-icons-outlined text-sm">radar</span>}
                      Scan
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-600">Scans up to 1024 addresses via SNMP. May take a minute.</p>
                </div>
              )}

              {/* Remote PDU Mode (Web Admin) */}
              {scanMode === 'remote' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text" value={remoteHost}
                      onChange={e => setRemoteHost(e.target.value)}
                      className="bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                      placeholder="IP address (e.g. 218.16.58.43)"
                    />
                    <input
                      type="text" value={remotePort}
                      onChange={e => setRemotePort(e.target.value)}
                      className="bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                      placeholder="Port (default: 6662)"
                    />
                    <input
                      type="text" value={remoteUser}
                      onChange={e => setRemoteUser(e.target.value)}
                      className="bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                      placeholder="Username"
                    />
                    <input
                      type="password" value={remotePass}
                      onChange={e => setRemotePass(e.target.value)}
                      className="bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                      placeholder="Password"
                    />
                  </div>
                  <button onClick={connectRemotePdu} disabled={loading}
                    className="w-full px-5 py-2.5 bg-[#00E5FF]/20 border border-[#00E5FF]/50 hover:bg-[#00E5FF]/30 disabled:opacity-50 text-[#00E5FF] rounded-lg flex items-center justify-center gap-2 transition-all text-sm">
                    {loading ? <span className="material-icons-outlined text-sm animate-spin">sync</span> :
                      <span className="material-icons-outlined text-sm">cloud_sync</span>}
                    Connect via Web Admin
                  </button>
                  <p className="text-[10px] text-slate-600">
                    Connects to the PDU's web admin panel (CGI interface) using HMAC-SHA1 authentication.
                    Reads device info, network config, and SNMP settings.
                  </p>
                </div>
              )}

              {/* Subnet results list */}
              {subnetDevices.length > 0 && (
                <div className="space-y-2 mt-3">
                  <p className="text-xs text-slate-400">Found {subnetDevices.length} device(s) — select one:</p>
                  <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1">
                    {subnetDevices.map(d => (
                      <button key={d.ip} onClick={() => selectSubnetDevice(d)}
                        className="w-full text-left p-3 rounded-lg bg-[#0B1120] border border-[#233544] hover:border-[#00E5FF]/50 transition-all">
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="font-mono text-white text-sm">{d.ip}</span>
                            {d.name && d.name !== 'Unknown' && <span className="text-slate-400 text-xs ml-2">{d.name}</span>}
                          </div>
                          <span className="material-icons-outlined text-slate-500 text-sm">arrow_forward</span>
                        </div>
                        {d.description && <p className="text-[10px] text-slate-600 mt-1 truncate">{d.description}</p>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Detected Device Card */}
              {detectedDevice && (
                <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 mt-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
                      <span className="material-icons-outlined text-emerald-400">check_circle</span>
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-bold text-emerald-300">PDU Detected</p>
                      <p className="text-xs text-slate-400 font-mono">{detectedDevice.ip}</p>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-[#0B1120]/50 rounded-lg p-2">
                      <span className="text-slate-500">Name</span>
                      <p className="text-white font-mono mt-0.5">{detectedDevice.name || 'Unknown'}</p>
                    </div>
                    <div className="bg-[#0B1120]/50 rounded-lg p-2">
                      <span className="text-slate-500">{isRemoteMode ? 'Firmware' : 'SNMP'}</span>
                      <p className="text-white font-mono mt-0.5">
                        {isRemoteMode ? (detectedDevice.firmware || '?') : `${detectedDevice.snmp_version || '2c'} / ${community}`}
                      </p>
                    </div>
                    {isRemoteMode && detectedDevice.mac && (
                      <div className="bg-[#0B1120]/50 rounded-lg p-2">
                        <span className="text-slate-500">MAC</span>
                        <p className="text-white font-mono mt-0.5">{detectedDevice.mac}</p>
                      </div>
                    )}
                    {isRemoteMode && remoteSettings?.network && (
                      <div className="bg-[#0B1120]/50 rounded-lg p-2">
                        <span className="text-slate-500">Current IP</span>
                        <p className="text-white font-mono mt-0.5">{remoteSettings.network.current_ip}</p>
                      </div>
                    )}
                    {detectedDevice.description && (
                      <div className="bg-[#0B1120]/50 rounded-lg p-2 col-span-2">
                        <span className="text-slate-500">Description</span>
                        <p className="text-white font-mono mt-0.5 text-[10px] break-all">{detectedDevice.description}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP 2: Configure */}
          {step === 1 && (
            <div className="space-y-5">
              {isRemoteMode ? (
                <>
                  {/* Remote PDU: Network + SNMP + Time Configuration */}
                  <div>
                    <h3 className="text-sm font-bold text-white mb-1">Configure PDU Settings</h3>
                    <p className="text-xs text-slate-500">Review and modify network, SNMP, and time settings. Changes are applied directly to the PDU.</p>
                  </div>

                  {/* Network Settings */}
                  <div className={`p-4 rounded-xl bg-[#0B1120] border ${ipConflict ? 'border-red-500/60' : 'border-[#233544]'}`}>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-bold text-[#00E5FF] uppercase tracking-wider flex items-center gap-1.5">
                        <span className="material-icons-outlined text-sm">lan</span> Network (IPv4)
                      </p>
                      <button onClick={applyNetworkSettings} disabled={loading || rebootStatus === 'rebooting'}
                        className="px-3 py-1 bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 rounded text-[10px] hover:bg-emerald-500/30 disabled:opacity-50 transition-all">
                        {loading ? 'Applying...' : rebootStatus === 'rebooting' ? 'Rebooting...' : 'Apply & Reboot PDU'}
                      </button>
                    </div>

                    {/* Reboot status banner */}
                    {rebootStatus && (
                      <div className={`mb-3 p-3 rounded-lg border flex items-center gap-2 ${
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
                          {rebootStatus === 'rebooting' && 'PDU is rebooting to apply new network settings... (~60 s)'}
                          {rebootStatus === 'online' && 'PDU is back online. New network settings are now active.'}
                          {rebootStatus === 'failed' && 'PDU did not come back within 90 s. Check the device manually.'}
                        </span>
                      </div>
                    )}

                    {/* Suggested next IP */}
                    {suggestedIp && (
                      <div className="mb-3 p-2 rounded-lg bg-[#00E5FF]/5 border border-[#00E5FF]/20 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="material-icons-outlined text-[#00E5FF] text-sm">auto_awesome</span>
                          <span className="text-[10px] text-slate-400">Next available IP for this hall:</span>
                          <span className="text-xs font-mono font-bold text-[#00E5FF]">{suggestedIp}</span>
                        </div>
                        <button onClick={() => setEditNetwork(prev => ({ ...prev, ip: suggestedIp }))}
                          className="px-2 py-0.5 bg-[#00E5FF]/20 text-[#00E5FF] rounded text-[9px] font-mono hover:bg-[#00E5FF]/30 transition-all">
                          Use this
                        </button>
                      </div>
                    )}

                    {/* IP Conflict Warning */}
                    {ipConflict && (
                      <div className="mb-3 p-2 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center gap-2">
                        <span className="material-icons-outlined text-red-400 text-sm">warning</span>
                        <span className="text-xs text-red-400">
                          IP <span className="font-mono font-bold">{editNetwork.ip}</span> is already commissioned in this data hall. Each PDU must have a unique IP address.
                        </span>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[9px] text-slate-500 uppercase">IP Address</label>
                        <input type="text" value={editNetwork.ip || ''}
                          onChange={e => setEditNetwork(prev => ({ ...prev, ip: e.target.value }))}
                          className={`w-full bg-[#161E2E] border rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none ${
                            ipConflict ? 'border-red-500/60 focus:border-red-500' : 'border-[#233544] focus:border-[#00E5FF]'
                          }`}
                        />
                      </div>
                      {[
                        { key: 'mask', label: 'Subnet Mask' },
                        { key: 'gateway', label: 'Gateway' },
                        { key: 'dns1', label: 'DNS 1' },
                        { key: 'dns2', label: 'DNS 2' },
                      ].map(f => (
                        <div key={f.key}>
                          <label className="text-[9px] text-slate-500 uppercase">{f.label}</label>
                          <input type="text" value={editNetwork[f.key] || ''}
                            onChange={e => setEditNetwork(prev => ({ ...prev, [f.key]: e.target.value }))}
                            className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]"
                          />
                        </div>
                      ))}
                    </div>

                    {/* Already commissioned IPs */}
                    {usedIps.length > 0 && (
                      <div className="mt-3 pt-2 border-t border-[#233544]/50">
                        <p className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">Commissioned IPs in this hall ({usedIps.length})</p>
                        <div className="flex flex-wrap gap-1">
                          {usedIps.map(ip => (
                            <span key={ip} className={`px-1.5 py-0.5 rounded text-[9px] font-mono border ${
                              ip === editNetwork.ip ? 'bg-red-500/20 text-red-400 border-red-500/40' : 'bg-[#161E2E] text-slate-500 border-[#233544]'
                            }`}>{ip}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* SNMP Settings */}
                  <div className="p-4 rounded-xl bg-[#0B1120] border border-[#233544]">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-bold text-[#00E5FF] uppercase tracking-wider flex items-center gap-1.5">
                        <span className="material-icons-outlined text-sm">vpn_key</span> SNMP
                      </p>
                      <button onClick={applySnmpSettings} disabled={loading}
                        className="px-3 py-1 bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 rounded text-[10px] hover:bg-emerald-500/30 disabled:opacity-50 transition-all">
                        {loading ? 'Applying...' : 'Apply to PDU'}
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[9px] text-slate-500 uppercase">Read Community</label>
                        <input type="text" value={editSnmp.community_read || ''}
                          onChange={e => setEditSnmp(prev => ({ ...prev, community_read: e.target.value }))}
                          className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-500 uppercase">Write Community</label>
                        <input type="text" value={editSnmp.community_write || ''}
                          onChange={e => setEditSnmp(prev => ({ ...prev, community_write: e.target.value }))}
                          className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-500 uppercase">Trap Destination IP</label>
                        <input type="text" value={editSnmp.trap_ip || ''}
                          onChange={e => setEditSnmp(prev => ({ ...prev, trap_ip: e.target.value }))}
                          className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]"
                        />
                      </div>
                      <div className="flex items-end gap-3 pb-1">
                        <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer">
                          <input type="checkbox" checked={editSnmp.snmpv1 || false}
                            onChange={e => setEditSnmp(prev => ({ ...prev, snmpv1: e.target.checked }))}
                            className="accent-[#00E5FF]" /> v1
                        </label>
                        <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer">
                          <input type="checkbox" checked={editSnmp.snmpv2 || false}
                            onChange={e => setEditSnmp(prev => ({ ...prev, snmpv2: e.target.checked }))}
                            className="accent-[#00E5FF]" /> v2c
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* Time / SNTP Settings */}
                  <div className="p-4 rounded-xl bg-[#0B1120] border border-[#233544]">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-bold text-[#00E5FF] uppercase tracking-wider flex items-center gap-1.5">
                        <span className="material-icons-outlined text-sm">schedule</span> Time & SNTP
                      </p>
                      <button onClick={applyTimeSettings} disabled={loading}
                        className="px-3 py-1 bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 rounded text-[10px] hover:bg-emerald-500/30 disabled:opacity-50 transition-all">
                        {loading ? 'Applying...' : 'Apply to PDU'}
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mb-2">
                      {[
                        { key: 'year', label: 'Year' }, { key: 'month', label: 'Month' }, { key: 'day', label: 'Day' },
                        { key: 'hour', label: 'Hour' }, { key: 'minute', label: 'Min' }, { key: 'second', label: 'Sec' },
                      ].map(f => (
                        <div key={f.key}>
                          <label className="text-[9px] text-slate-500 uppercase">{f.label}</label>
                          <input type="text" value={editTime[f.key] || ''}
                            onChange={e => setEditTime(prev => ({ ...prev, [f.key]: e.target.value }))}
                            className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]"
                          />
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[9px] text-slate-500 uppercase">SNTP Server</label>
                        <input type="text" value={editTime.sntp_server || ''}
                          onChange={e => setEditTime(prev => ({ ...prev, sntp_server: e.target.value }))}
                          className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-500 uppercase">Timezone</label>
                        <input type="text" value={editTime.timezone || ''}
                          onChange={e => setEditTime(prev => ({ ...prev, timezone: e.target.value }))}
                          className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-500 uppercase">Update Interval (h)</label>
                        <input type="text" value={editTime.update_interval || ''}
                          onChange={e => setEditTime(prev => ({ ...prev, update_interval: e.target.value }))}
                          className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-500 uppercase">Correction</label>
                        <input type="text" value={editTime.correction || ''}
                          onChange={e => setEditTime(prev => ({ ...prev, correction: e.target.value }))}
                          className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]"
                        />
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* SNMP-only: Assign IP */}
                  <div>
                    <h3 className="text-sm font-bold text-white mb-1">Assign Production IP</h3>
                    <p className="text-xs text-slate-500">
                      Choose the IP address this PDU will use in your data hall network.
                      {ipSubnet && <span className="text-[#00E5FF]"> Subnet: {ipSubnet}</span>}
                    </p>
                  </div>

                  <div className={`p-4 rounded-xl border transition-all cursor-pointer ${
                    !useCustomIp ? 'bg-[#00E5FF]/10 border-[#00E5FF]/50' : 'bg-[#0B1120] border-[#233544]'
                  }`} onClick={() => setUseCustomIp(false)}>
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${!useCustomIp ? 'border-[#00E5FF]' : 'border-slate-600'}`}>
                        {!useCustomIp && <div className="w-2.5 h-2.5 rounded-full bg-[#00E5FF]" />}
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-bold text-white">Suggested (Next Sequential)</p>
                        <p className="text-2xl font-mono font-bold text-[#00E5FF] mt-1">{suggestedIp || 'Loading...'}</p>
                      </div>
                      <span className="material-icons-outlined text-[#00E5FF] text-xl">auto_awesome</span>
                    </div>
                  </div>

                  <div className={`p-4 rounded-xl border transition-all cursor-pointer ${
                    useCustomIp ? 'bg-amber-500/10 border-amber-500/50' : 'bg-[#0B1120] border-[#233544]'
                  }`} onClick={() => setUseCustomIp(true)}>
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${useCustomIp ? 'border-amber-500' : 'border-slate-600'}`}>
                        {useCustomIp && <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />}
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-bold text-white">Custom IP</p>
                        {useCustomIp && (
                          <>
                            <input type="text" value={customIp}
                              onChange={e => setCustomIp(e.target.value)}
                              onClick={e => e.stopPropagation()}
                              className={`mt-2 w-full bg-[#0B1120] border rounded-lg px-3 py-2 text-white font-mono text-lg focus:outline-none ${
                                usedIps.includes(customIp) ? 'border-red-500/60 focus:border-red-500' : 'border-[#233544] focus:border-amber-500'
                              }`}
                              placeholder="e.g. 10.20.0.100" autoFocus />
                            {usedIps.includes(customIp) && (
                              <div className="mt-2 p-2 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center gap-2">
                                <span className="material-icons-outlined text-red-400 text-sm">warning</span>
                                <span className="text-[10px] text-red-400">This IP is already commissioned in this data hall.</span>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {usedIps.length > 0 && (
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Already Commissioned ({usedIps.length})</p>
                      <div className="flex flex-wrap gap-1.5">
                        {usedIps.map(ip => (
                          <span key={ip} className="px-2 py-0.5 bg-[#161E2E] rounded text-[10px] font-mono text-slate-500 border border-[#233544]">{ip}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* STEP 3: Assign Rack */}
          {step === 2 && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-bold text-white mb-1">Assign to Rack</h3>
                <p className="text-xs text-slate-500">Place this PDU in a specific rack and mount position.</p>
              </div>

              {/* PDU Label */}
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block">PDU Label</label>
                <input type="text" value={pduLabel}
                  onChange={e => setPduLabel(e.target.value)}
                  className="w-full bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                  placeholder={`PDU-${finalIp}`} />
              </div>

              {/* Rack Grid */}
              {availableRacks.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <span className="material-icons-outlined text-3xl opacity-50 mb-2 block">view_in_ar</span>
                  <p className="text-sm">No racks with open slots</p>
                  <p className="text-xs mt-1">Save a hall layout in the Data Hall Designer first, then re-open this wizard.</p>
                </div>
              ) : (
                <div>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">
                    Available Racks ({availableRacks.length})
                  </p>
                  <div className="grid grid-cols-4 gap-2 max-h-[300px] overflow-y-auto pr-1">
                    {availableRacks.map(rack => (
                      <button key={rack.rack_code}
                        onClick={() => {
                          setSelectedRack(rack);
                          setSelectedSlot(rack.open_slots[0] || 'A');
                        }}
                        className={`p-3 rounded-lg border text-left transition-all ${
                          selectedRack?.rack_code === rack.rack_code
                            ? 'bg-[#00E5FF]/10 border-[#00E5FF]/50'
                            : 'bg-[#0B1120] border-[#233544] hover:border-[#00E5FF]/30'
                        }`}>
                        <p className="text-xs font-mono font-bold text-white">{rack.rack_code}</p>
                        <p className="text-[10px] text-slate-500 mt-0.5">
                          Row {rack.row_index + 1}, Pos {rack.position_index + 1}
                        </p>
                        <div className="flex gap-1 mt-2">
                          {rack.open_slots.map(slot => (
                            <span key={slot} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${
                              selectedRack?.rack_code === rack.rack_code && selectedSlot === slot
                                ? 'bg-[#00E5FF] text-[#0B1120] font-bold'
                                : 'bg-[#161E2E] text-slate-400 border border-[#233544]'
                            }`}>{slot}</span>
                          ))}
                        </div>
                        <p className="text-[9px] text-slate-600 mt-1">{rack.occupied}/{rack.total_slots} filled</p>
                      </button>
                    ))}
                  </div>

                  {/* Slot selector when rack is selected */}
                  {selectedRack && selectedRack.open_slots.length > 1 && (
                    <div className="mt-3 p-3 rounded-lg bg-[#0a1222] border border-[#1a2744]">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Mount Position</p>
                      <div className="flex gap-2">
                        {selectedRack.open_slots.map(slot => (
                          <button key={slot}
                            onClick={() => setSelectedSlot(slot)}
                            className={`px-4 py-2 rounded-lg text-sm font-mono font-bold transition-all ${
                              selectedSlot === slot
                                ? 'bg-[#00E5FF] text-[#0B1120]'
                                : 'bg-[#161E2E] text-slate-400 border border-[#233544] hover:border-[#00E5FF]/30'
                            }`}>{slot}</button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* STEP 4: Confirm */}
          {step === 3 && !commissioned && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-bold text-white mb-1">Review & Commission</h3>
                <p className="text-xs text-slate-500">Verify the details below and confirm to save this PDU to the database.</p>
              </div>

              <div className="space-y-3">
                {isRemoteMode && (
                  <SummaryRow label="Remote Host" value={`${remoteHost}:${remotePort}`} icon="cloud" />
                )}
                <SummaryRow label="Detected IP" value={detectedDevice?.ip || 'N/A'} icon="wifi_find" />
                <SummaryRow label="Production IP" value={isRemoteMode ? (editNetwork.ip || remoteHost) : finalIp} icon="lan" highlight />
                <SummaryRow label="Label" value={pduLabel || `PDU-${isRemoteMode ? (editNetwork.ip || remoteHost) : finalIp}`} icon="label" />
                <SummaryRow label="Rack" value={selectedRack?.rack_code || 'Unassigned'} icon="view_in_ar" />
                <SummaryRow label="Mount Position" value={selectedSlot || 'A'} icon="height" />
                <SummaryRow label="SNMP Community" value={isRemoteMode ? (editSnmp.community_read || community) : community} icon="vpn_key" />
                <SummaryRow label="Data Hall" value={hallName || `Hall #${hallId}`} icon="domain" />
                {isRemoteMode && detectedDevice?.mac && (
                  <SummaryRow label="MAC Address" value={detectedDevice.mac} icon="fingerprint" />
                )}
              </div>

              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-start gap-2">
                <span className="material-icons-outlined text-sm mt-0.5">info</span>
                <span>{isRemoteMode
                  ? 'This will persist the PDU configuration (including web admin credentials) to the database. Telemetry will be polled via the web admin CGI interface.'
                  : 'This will persist the PDU configuration to the database and start SNMP polling automatically.'}
                </span>
              </div>
            </div>
          )}

          {/* STEP 4: Success */}
          {step === 3 && commissioned && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center mb-4">
                <span className="material-icons-outlined text-emerald-400 text-4xl">check_circle</span>
              </div>
              <h3 className="text-xl font-bold text-white mb-2">PDU Commissioned</h3>
              <p className="text-sm text-slate-400 mb-1">
                <span className="text-[#00E5FF] font-mono">{finalIp}</span> has been added to <span className="text-white">{hallName || `Hall #${hallId}`}</span>
              </p>
              {selectedRack && (
                <p className="text-sm text-slate-500">
                  Mounted at <span className="text-white font-mono">{selectedRack.rack_code}</span> position <span className="text-white font-mono">{selectedSlot}</span>
                </p>
              )}
              <p className="text-xs text-slate-600 mt-4">SNMP polling has been activated.</p>
            </div>
          )}
        </div>

        {/* Footer Navigation */}
        <div className="p-5 border-t border-[#233544] flex items-center justify-between bg-[#0a1222]">
          {step > 0 && !commissioned ? (
            <button onClick={goBack}
              className="px-4 py-2.5 bg-[#161E2E] border border-[#233544] hover:border-[#00E5FF]/30 text-slate-300 rounded-lg flex items-center gap-2 transition-all text-sm">
              <span className="material-icons-outlined text-sm">arrow_back</span>
              Back
            </button>
          ) : <div />}

          <div className="flex gap-2">
            {commissioned ? (
              <>
                <button onClick={() => {
                  setStep(0);
                  setDetectedDevice(null);
                  setSubnetDevices([]);
                  setCommissioned(false);
                  setCommissionResult(null);
                  setSuggestedIp('');
                  setCustomIp('');
                  setUseCustomIp(false);
                  setSelectedRack(null);
                  setSelectedSlot(null);
                  setPduLabel('');
                  setError(null);
                  setIsRemoteMode(false);
                  setRemoteSettings(null);
                  setEditNetwork({});
                  setEditSnmp({});
                  setEditTime({});
                  setIpConflict(false);
                  setRebootStatus(null);
                }}
                  className="px-4 py-2.5 bg-[#00E5FF]/20 border border-[#00E5FF]/50 hover:bg-[#00E5FF]/30 text-[#00E5FF] rounded-lg flex items-center gap-2 transition-all text-sm">
                  <span className="material-icons-outlined text-sm">add</span>
                  Commission Another
                </button>
                <button onClick={() => { if (onComplete) onComplete(); onClose(); }}
                  className="px-5 py-2.5 bg-[#00E5FF] hover:bg-[#00E5FF]/80 text-[#0B1120] rounded-lg font-bold text-sm transition-all">
                  Done
                </button>
              </>
            ) : step === 3 ? (
              <button onClick={handleCommission} disabled={loading}
                className="px-6 py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-white rounded-lg font-bold text-sm flex items-center gap-2 transition-all">
                {loading ? <span className="material-icons-outlined text-sm animate-spin">sync</span> :
                  <span className="material-icons-outlined text-sm">bolt</span>}
                Commission PDU
              </button>
            ) : (
              <button onClick={goNext}
                disabled={(step === 0 && !detectedDevice)}
                className="px-5 py-2.5 bg-[#00E5FF] hover:bg-[#00E5FF]/80 disabled:opacity-30 disabled:cursor-not-allowed text-[#0B1120] rounded-lg font-bold text-sm flex items-center gap-2 transition-all">
                Next
                <span className="material-icons-outlined text-sm">arrow_forward</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const SummaryRow = ({ label, value, icon, highlight }) => (
  <div className="flex items-center gap-3 p-3 rounded-lg bg-[#0B1120] border border-[#233544]">
    <div className="w-8 h-8 rounded-lg bg-[#161E2E] flex items-center justify-center">
      <span className={`material-icons-outlined text-sm ${highlight ? 'text-[#00E5FF]' : 'text-slate-500'}`}>{icon}</span>
    </div>
    <div className="flex-1">
      <p className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`text-sm font-mono ${highlight ? 'text-[#00E5FF] font-bold' : 'text-white'}`}>{value}</p>
    </div>
  </div>
);

export default CommissioningWizard;
