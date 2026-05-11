import React, { useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

const NetworkScanner = ({ hallId, hallName, onPduAdded, onClose }) => {
  const [subnet, setSubnet] = useState('192.168.1.0/24');
  const [singleIp, setSingleIp] = useState('');
  const [community, setCommunity] = useState('public');
  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState([]);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState({});
  const [scanMode, setScanMode] = useState('single');

  const scanSubnet = async () => {
    setScanning(true);
    setError(null);
    setDiscovered([]);
    
    try {
      const response = await fetch(`${API_BASE}/api/network/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subnet, community, timeout: 1 })
      });
      
      const data = await response.json();
      
      if (data.error) {
        setError(data.error);
      } else {
        setDiscovered(data.discovered || []);
      }
    } catch (err) {
      setError(`Scan failed: ${err.message}`);
    } finally {
      setScanning(false);
    }
  };

  const scanSingleIp = async () => {
    if (!singleIp) {
      setError('Please enter an IP address');
      return;
    }
    
    setScanning(true);
    setError(null);
    setDiscovered([]);
    
    try {
      const response = await fetch(`${API_BASE}/api/network/scan/ip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: singleIp, community })
      });
      
      const data = await response.json();
      
      if (data.success) {
        setDiscovered([data]);
      } else {
        setError(data.error || 'Device not found or not responding to SNMP');
      }
    } catch (err) {
      setError(`Scan failed: ${err.message}`);
    } finally {
      setScanning(false);
    }
  };

  const addPduToHall = async (device) => {
    setAdding(prev => ({ ...prev, [device.ip]: true }));
    
    try {
      const response = await fetch(`${API_BASE}/api/halls/${hallId}/pdus/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip_address: device.ip,
          label: device.name || `PDU-${device.ip}`,
          mount_position: 'A'
        })
      });
      
      const data = await response.json();
      
      if (data.success) {
        setDiscovered(prev => 
          prev.map(d => d.ip === device.ip ? { ...d, added: true, pdu_id: data.pdu_id } : d)
        );
        if (onPduAdded) onPduAdded(data);
      } else {
        setError(data.error || 'Failed to add PDU');
      }
    } catch (err) {
      setError(`Failed to add PDU: ${err.message}`);
    } finally {
      setAdding(prev => ({ ...prev, [device.ip]: false }));
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0d1526] rounded-xl border border-[#233544] w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-[#233544] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="material-icons-outlined text-[#00E5FF]">wifi_find</span>
            <h2 className="text-lg font-semibold text-white">Network Scanner</h2>
            {hallName && (
              <span className="text-sm text-slate-400">→ {hallName}</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
          >
            <span className="material-icons-outlined">close</span>
          </button>
        </div>

        {/* Scan Mode Tabs */}
        <div className="flex border-b border-[#233544]">
          <button
            onClick={() => setScanMode('single')}
            className={`flex-1 py-2 px-4 text-sm font-medium transition-colors ${
              scanMode === 'single'
                ? 'text-[#00E5FF] border-b-2 border-[#00E5FF] bg-[#00E5FF]/10'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Single IP
          </button>
          <button
            onClick={() => setScanMode('subnet')}
            className={`flex-1 py-2 px-4 text-sm font-medium transition-colors ${
              scanMode === 'subnet'
                ? 'text-[#00E5FF] border-b-2 border-[#00E5FF] bg-[#00E5FF]/10'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Subnet Scan
          </button>
        </div>

        {/* Scan Form */}
        <div className="p-4 border-b border-[#233544]">
          {scanMode === 'single' ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={singleIp}
                onChange={(e) => setSingleIp(e.target.value)}
                placeholder="Enter IP address (e.g., 192.168.1.121)"
                className="flex-1 bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-[#00E5FF] font-mono text-sm"
              />
              <input
                type="text"
                value={community}
                onChange={(e) => setCommunity(e.target.value)}
                placeholder="Community"
                className="w-28 bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-[#00E5FF] font-mono text-sm"
              />
              <button
                onClick={scanSingleIp}
                disabled={scanning}
                className="px-4 py-2 bg-[#00E5FF]/20 border border-[#00E5FF]/50 hover:bg-[#00E5FF]/30 disabled:bg-slate-700 disabled:border-slate-600 text-[#00E5FF] disabled:text-slate-400 rounded-lg flex items-center gap-2 transition-colors"
              >
                {scanning ? (
                  <span className="material-icons-outlined text-sm animate-spin">sync</span>
                ) : (
                  <span className="material-icons-outlined text-sm">search</span>
                )}
                Scan
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="text"
                value={subnet}
                onChange={(e) => setSubnet(e.target.value)}
                placeholder="Subnet (e.g., 192.168.1.0/24)"
                className="flex-1 bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-[#00E5FF] font-mono text-sm"
              />
              <input
                type="text"
                value={community}
                onChange={(e) => setCommunity(e.target.value)}
                placeholder="Community"
                className="w-28 bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-[#00E5FF] font-mono text-sm"
              />
              <button
                onClick={scanSubnet}
                disabled={scanning}
                className="px-4 py-2 bg-[#00E5FF]/20 border border-[#00E5FF]/50 hover:bg-[#00E5FF]/30 disabled:bg-slate-700 disabled:border-slate-600 text-[#00E5FF] disabled:text-slate-400 rounded-lg flex items-center gap-2 transition-colors"
              >
                {scanning ? (
                  <span className="material-icons-outlined text-sm animate-spin">sync</span>
                ) : (
                  <span className="material-icons-outlined text-sm">search</span>
                )}
                Scan
              </button>
            </div>
          )}
          
          {scanMode === 'subnet' && (
            <p className="text-xs text-slate-500 mt-2">
              Scans up to 1024 addresses. Large subnets may take a few minutes.
            </p>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mx-4 mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm flex items-center gap-2">
            <span className="material-icons-outlined text-sm">error</span>
            {error}
          </div>
        )}

        {/* Results */}
        <div className="flex-1 overflow-y-auto p-4">
          {scanning && (
            <div className="flex flex-col items-center justify-center py-8 text-slate-400">
              <span className="material-icons-outlined text-3xl animate-spin mb-3">sync</span>
              <p>Scanning network...</p>
            </div>
          )}

          {!scanning && discovered.length === 0 && !error && (
            <div className="flex flex-col items-center justify-center py-8 text-slate-500">
              <span className="material-icons-outlined text-5xl opacity-50 mb-3">dns</span>
              <p>No devices discovered yet</p>
              <p className="text-sm">Enter an IP or subnet and click Scan</p>
            </div>
          )}

          {discovered.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm text-slate-400 mb-3">
                Found {discovered.length} device(s)
              </p>
              {discovered.map((device) => (
                <div
                  key={device.ip}
                  className={`p-3 rounded-lg border ${
                    device.added
                      ? 'bg-emerald-500/10 border-emerald-500/30'
                      : 'bg-[#0B1120] border-[#233544]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-white">{device.ip}</span>
                        {device.added && (
                          <span className="material-icons-outlined text-sm text-emerald-400">check_circle</span>
                        )}
                      </div>
                      <div className="text-sm text-slate-400 mt-1">
                        {device.name && device.name !== 'Unknown' && (
                          <span className="mr-3">Name: {device.name}</span>
                        )}
                        {device.description && (
                          <span className="text-slate-500">{device.description}</span>
                        )}
                      </div>
                    </div>
                    {!device.added && (
                      <button
                        onClick={() => addPduToHall(device)}
                        disabled={adding[device.ip]}
                        className="px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/50 hover:bg-emerald-500/30 disabled:bg-slate-700 disabled:border-slate-600 text-emerald-400 disabled:text-slate-400 text-sm rounded-lg flex items-center gap-1.5 transition-colors"
                      >
                        {adding[device.ip] ? (
                          <span className="material-icons-outlined text-xs animate-spin">sync</span>
                        ) : (
                          <span className="material-icons-outlined text-xs">add</span>
                        )}
                        Add to Hall
                      </button>
                    )}
                    {device.added && (
                      <span className="text-emerald-400 text-sm">Added!</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[#233544] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-500/20 border border-slate-500/30 hover:bg-slate-500/30 text-slate-300 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default NetworkScanner;
