import React, { useState, useEffect, useCallback } from 'react';
import PduSnmpSettingsForm from './PduSnmpSettingsForm';
import PduNtpSettingsForm from './PduNtpSettingsForm';
import PduWebAccessSettingsForm from './PduWebAccessSettingsForm';
import PasswordInput from './PasswordInput';
import {
  DEFAULT_SNMP_TEMPLATE,
  DEFAULT_NTP_TEMPLATE,
  DEFAULT_WEB_ACCESS_TEMPLATE,
  combineSntpServers,
  primarySntpServer,
  splitSntpServers,
} from '../constants/pduSettings';

const API_BASE = import.meta.env.VITE_API_URL || '';

/** Demo cage defaults — keep in sync with backend/demo/config.py */
const DEMO_SCAN_DEFAULTS = {
  scan_subnet: '10.99.1.206-213',
  scan_subnet_cidr: '10.99.1.192/27',
  factory_ip: '192.168.0.163',
  community: 'private',
  pdu_ip_range: '10.99.1.206 – 10.99.1.213',
};

function isDemoUserFromStorage() {
  try {
    const user = JSON.parse(localStorage.getItem('pdumind_user') || '{}');
    return !!user.demo_mode;
  } catch {
    return false;
  }
}

const demoUserOnMount = isDemoUserFromStorage();

const wizardPwClass =
  'bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF] pr-9';
const repairPwClass =
  'w-full bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF] pr-9';
const batchPwClass =
  'w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF] pr-9';

const STEPS = [
  { id: 'scan', label: 'Detect PDU', icon: 'wifi_find' },
  { id: 'configure', label: 'Configure', icon: 'settings' },
  { id: 'rack', label: 'Assign Rack', icon: 'view_in_ar' },
  { id: 'confirm', label: 'Confirm', icon: 'check_circle' },
];

// Resolve a hostname/device-name pattern for a specific PDU index. Mirrors
// the backend implementation in app.py:_resolve_hostname_pattern so the
// preview shown in the UI is byte-for-byte what the backend will apply.
//
// Supported placeholders:
//   {seq}    3-digit zero-padded sequence starting at 1 (001, 002, ...)
//   {idx}    zero-based index (0, 1, 2, ...)
//   {ip}     assigned IP address (full)
//   {mac}    last 6 chars of the MAC (any separators stripped)
//   {N}      start at N, padded to width(N): {10} -> 10, 11, 12, ...
//   {N-M}    start at N, padded to max(width(N), width(M)): {10-17} -> 10..17
//            M is informational; actual end depends on selected PDU count.
//            Leading zeros in N/M are preserved as padding width.
function resolveHostnamePattern(pattern, idx, ip, mac) {
  if (!pattern) return '';
  let result = pattern.replace(/\{(\d+)(?:-(\d+))?\}/g, (_match, startTok, endTok) => {
    const start = parseInt(startTok, 10);
    const width = endTok ? Math.max(startTok.length, endTok.length) : startTok.length;
    return String(start + idx).padStart(width, '0');
  });
  result = result.replace('{seq}', String(idx + 1).padStart(3, '0'));
  result = result.replace('{idx}', String(idx));
  result = result.replace('{ip}', ip || '');
  const macClean = (mac || '').replace(/[:.\-]/g, '');
  result = result.replace('{mac}', macClean ? macClean.slice(-6) : '');
  return result;
}

// Compare two IPv4 addresses as 32-bit integers. Invalid IPs sort to the end.
function compareIp(a, b) {
  const toInt = (ip) => {
    const parts = String(ip || '').split('.');
    if (parts.length !== 4) return Number.MAX_SAFE_INTEGER;
    let n = 0;
    for (const p of parts) {
      const v = parseInt(p, 10);
      if (Number.isNaN(v) || v < 0 || v > 255) return Number.MAX_SAFE_INTEGER;
      n = n * 256 + v;
    }
    return n;
  };
  return toInt(a) - toInt(b);
}

const CommissioningWizard = ({ hallId, hallName, onComplete, onClose }) => {
  const [step, setStep] = useState(0);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Step 1: Scan
  const [isDemoMode, setIsDemoMode] = useState(demoUserOnMount);
  const [scanMode, setScanMode] = useState(demoUserOnMount ? 'batch' : 'factory');
  const [factoryIp, setFactoryIp] = useState(demoUserOnMount ? DEMO_SCAN_DEFAULTS.factory_ip : '192.168.0.163');
  const [manualIp, setManualIp] = useState('');
  const [subnet, setSubnet] = useState(demoUserOnMount ? DEMO_SCAN_DEFAULTS.scan_subnet : '192.168.1.0/24');
  const [community, setCommunity] = useState(demoUserOnMount ? DEMO_SCAN_DEFAULTS.community : 'public');
  const [detectedDevice, setDetectedDevice] = useState(null);
  const [subnetDevices, setSubnetDevices] = useState([]);

  // Remote PDU (web admin)
  const [remoteHost, setRemoteHost] = useState('');
  const [remotePort, setRemotePort] = useState('80');
  const [remoteUseHttps, setRemoteUseHttps] = useState(false);
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
  const [editWebAccess, setEditWebAccess] = useState({ ...DEFAULT_WEB_ACCESS_TEMPLATE });
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

  // Batch commissioning
  const [batchDevices, setBatchDevices] = useState([]);
  const [batchSelected, setBatchSelected] = useState(new Set());
  const [batchTemplate, setBatchTemplate] = useState({
    network: { ip_start: '', mask: '255.255.255.0', gateway: '', dns1: '', dns2: '' },
    system: { device_name: '', router_hostname: 'PDU-{seq}', sync_device_name: true },
    users: { admin_username: '', admin_password: '' },
    snmp: { ...DEFAULT_SNMP_TEMPLATE },
    ntp: { ...DEFAULT_NTP_TEMPLATE },
    web_access: { ...DEFAULT_WEB_ACCESS_TEMPLATE },
    current_credentials: { username: 'admin', password: 'admin' },
  });
  const [batchStep, setBatchStep] = useState(0); // 0=scan, 1=template, 2=deploy, 3=report, 4=rack-assign
  const [batchScanMethod, setBatchScanMethod] = useState('snmp'); // 'snmp' | 'http' — HTTP is for VPN/firewalled networks where UDP/161 is blocked
  const [batchPreviewOpen, setBatchPreviewOpen] = useState(false); // shows the resolved-plan confirmation overlay before deploy
  const [batchSortByIp, setBatchSortByIp] = useState(true); // sort selected PDUs by IP before assigning sequence numbers
  const [batchOrder, setBatchOrder] = useState([]); // explicit IP order used in preview (overrides sort when user drags)
  const [batchJobId, setBatchJobId] = useState(null);
  const [batchProgress, setBatchProgress] = useState(null);
  const [batchRacks, setBatchRacks] = useState([]); // available racks for batch assignment
  const [batchRackMap, setBatchRackMap] = useState({}); // { pduKey: { rack_id, rack_code, slot } }
  const [dragPdu, setDragPdu] = useState(null); // currently dragged PDU key

  // Guided inventory commissioning (factory-default → assigned IP, one PDU at a time)
  const [invTargets, setInvTargets] = useState([]); // [{sr_no, hostname, ip, mask, gateway, site, rack, status}]
  const [invFileName, setInvFileName] = useState('');
  const [invSiteFilter, setInvSiteFilter] = useState('all');
  const [invFactoryIp, setInvFactoryIp] = useState('192.168.0.163');
  const [invDetected, setInvDetected] = useState(null); // factory PDU detected at invFactoryIp
  const [invBusy, setInvBusy] = useState(false);
  const [invStage, setInvStage] = useState('idle'); // idle | detecting | applying | rebooting | done
  const [invLastResult, setInvLastResult] = useState(null);
  const [invDiag, setInvDiag] = useState(null); // web-admin login diagnostic report
  const [invSelectedIp, setInvSelectedIp] = useState(null); // manually chosen target (overrides auto-next)

  // Web credential repair (uses hall DB + live probe — no manual curl)
  const [repairPdus, setRepairPdus] = useState([]);
  const [repairSelected, setRepairSelected] = useState(new Set());
  const [repairUser, setRepairUser] = useState('admin');
  const [repairPass, setRepairPass] = useState('admin');
  const [repairResults, setRepairResults] = useState(null);
  const [repairLoading, setRepairLoading] = useState(false);
  const [repairStatus, setRepairStatus] = useState(null); // last run summary for visible feedback
  const [probeResults, setProbeResults] = useState({}); // ip -> probe report

  const currentStep = STEPS[step];

  // Demo account: confirm pre-fill from API (subnet, factory IP, batch tab)
  useEffect(() => {
    const token = localStorage.getItem('pdumind_token');
    if (!token) return;
    fetch(`${API_BASE}/api/demo/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.demo_mode) return;
        setIsDemoMode(true);
        setScanMode('batch');
        setSubnet(data.scan_subnet || DEMO_SCAN_DEFAULTS.scan_subnet);
        setCommunity(DEMO_SCAN_DEFAULTS.community);
        setFactoryIp(data.factory_ip || DEMO_SCAN_DEFAULTS.factory_ip);
        setBatchTemplate((prev) => ({
          ...prev,
          current_credentials: { username: 'admin', password: 'demo' },
        }));
      })
      .catch(() => {});
  }, []);

  const resetDemoForCommissioning = async () => {
    if (!confirm('Factory reset? Clears commissioned PDUs so batch scan can find 8 devices on 10.99.1.206-213.')) return;
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('pdumind_token');
      const res = await fetch(`${API_BASE}/api/demo/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'factory' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reset failed');
      setBatchDevices([]);
      setBatchSelected(new Set());
      setBatchStep(0);
      setBatchJobId(null);
      setBatchProgress(null);
      setBatchRackMap({});
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

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
          dhcp: remoteSettings.network?.dhcp || 'OFF',
        });
        setEditSnmp({
          community_read: remoteSettings.snmp?.community_read || 'public',
          community_write: remoteSettings.snmp?.community_write || 'private',
          read_community: remoteSettings.snmp?.community_read || 'public',
          write_community: remoteSettings.snmp?.community_write || 'private',
          snmpv1: remoteSettings.snmp?.snmpv1_enabled || false,
          snmpv2: remoteSettings.snmp?.snmpv2_enabled || false,
          snmpv3: remoteSettings.snmp?.snmpv3_enabled || false,
          snmpv3_username: remoteSettings.snmp?.snmpv3_username || 'admin',
          verify_protocol: remoteSettings.snmp?.verify_protocol || '2',
          auth_key: '',
          encrypt_protocol: remoteSettings.snmp?.encrypt_protocol || '0',
          priv_key: '',
          trap_ip: remoteSettings.snmp?.trap_ip || '',
        });
        const sntpParts = splitSntpServers(remoteSettings.time?.sntp_server || '');
        setEditTime({
          year: remoteSettings.time?.year || '',
          month: remoteSettings.time?.month || '',
          day: remoteSettings.time?.day || '',
          hour: remoteSettings.time?.hour || '',
          minute: remoteSettings.time?.minute || '',
          second: remoteSettings.time?.second || '',
          sntp_enabled: remoteSettings.time?.sntp_enabled === 'true' || remoteSettings.time?.sntp_enabled === true,
          sntp_server: sntpParts.primary,
          sntp_server2: remoteSettings.time?.sntp_server2 || sntpParts.secondary,
          timezone: remoteSettings.time?.timezone || '79',
          update_interval: remoteSettings.time?.update_interval || '24',
          correction: remoteSettings.time?.correction ?? '0',
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

  const fetchRepairPdus = useCallback(async ({ preserveResults = false } = {}) => {
    if (!hallId) return;
    setRepairLoading(true);
    if (!preserveResults) setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/halls/${hallId}/state`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load hall PDUs');
      const pdus = (data.pdus || []).slice().sort((a, b) => compareIp(a.ip_address, b.ip_address));
      setRepairPdus(pdus);
      if (!preserveResults) {
        setRepairSelected(new Set(pdus.map(p => p.id)));
        const first = pdus[0];
        if (first?.web_admin_user) setRepairUser(first.web_admin_user);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setRepairLoading(false);
    }
  }, [hallId]);

  const findRepairResult = (pdu) => {
    if (!repairResults?.results) return null;
    return repairResults.results.find(r => r.id === pdu.id || r.ip === pdu.ip_address) || null;
  };

  const testProbeLogin = async (host) => {
    if (!host) return;
    setRepairLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/pdu-admin/probe-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host,
          web_admin_user: repairUser.trim(),
          web_admin_pass: repairPass,
        }),
      });
      const data = await res.json();
      setProbeResults(prev => ({ ...prev, [host]: data }));
      if (!data.success) {
        setError(`Probe failed for ${host}: ${data.error || 'login failed on all ports'}`);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setRepairLoading(false);
    }
  };

  const runRepairWebAccess = async (pduIds = null) => {
    if (!hallId) { setError('No data hall selected'); return; }
    const ids = pduIds || [...repairSelected];
    if (!ids.length) { setError('Select at least one PDU to repair'); return; }
    if (!repairUser.trim()) { setError('Enter the web admin username'); return; }
    if (!repairPass) { setError('Enter the web admin password that works in the browser'); return; }

    setRepairLoading(true);
    setError(null);
    setRepairStatus({ phase: 'running', message: `Repairing ${ids.length} PDU(s)...` });
    try {
      const res = await fetch(`${API_BASE}/api/halls/${hallId}/pdus/repair-web-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          web_admin_user: repairUser.trim(),
          web_admin_pass: repairPass,
          pdu_ids: ids,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Repair failed');
      setRepairResults(data);
      const failed = (data.results || []).filter(r => !r.success && !r.skipped);
      const ok = data.repaired || 0;
      const total = data.total || 0;
      setRepairStatus({
        phase: ok === total && total > 0 ? 'success' : (ok > 0 ? 'partial' : 'failed'),
        message: ok === total && total > 0
          ? `All ${ok} PDU(s) repaired successfully.`
          : ok > 0
            ? `Repaired ${ok} of ${total}. ${failed.length} failed — see errors below.`
            : `Repair failed for all ${total} PDU(s). Check password and close browser PDU tabs.`,
        data,
      });
      await fetchRepairPdus({ preserveResults: true });
      if (data.repaired > 0 && onComplete) onComplete();
    } catch (e) {
      setRepairStatus({ phase: 'failed', message: e.message });
      setError(e.message);
    } finally {
      setRepairLoading(false);
    }
  };

  useEffect(() => {
    if (step === 0 && scanMode === 'repair' && hallId) {
      fetchRepairPdus();
    }
  }, [step, scanMode, hallId, fetchRepairPdus]);

  const toggleRepairPdu = (pduId) => {
    setRepairSelected(prev => {
      const next = new Set(prev);
      if (next.has(pduId)) next.delete(pduId);
      else next.add(pduId);
      return next;
    });
  };

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
        // Auto-detect web admin on factory default too
        if (data.device.web_admin_port) {
          try {
            const waRes = await fetch(`${API_BASE}/api/pdu-admin/connect`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ host: data.device.ip, port: data.device.web_admin_port, username: 'admin', password: 'admin' })
            });
            const waData = await waRes.json();
            if (waData.success) {
              setIsRemoteMode(true);
              setRemoteHost(data.device.ip);
              setRemotePort(String(data.device.web_admin_port));
              setRemoteUser('admin');
              setRemotePass('admin');
              setRemoteSettings(waData);
              setDetectedDevice(prev => ({
                ...prev,
                name: waData.device?.name || prev.name,
                firmware: waData.device?.firmware || '',
                mac: waData.device?.mac || '',
                description: `${waData.device?.name || 'PDU'} (FW ${waData.device?.firmware || '?'}) — SNMP v${data.device.snmp_version} + Web Admin :${data.device.web_admin_port}`,
                web_admin_port: data.device.web_admin_port,
              }));
              if (waData.snmp?.community_read) setCommunity(waData.snmp.community_read);
            }
          } catch {}
        }
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
        // Auto-detect web admin: if found, connect to get full device info
        if (data.web_admin_port) {
          try {
            const waRes = await fetch(`${API_BASE}/api/pdu-admin/connect`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ host: manualIp, port: data.web_admin_port, username: 'admin', password: 'admin' })
            });
            const waData = await waRes.json();
            if (waData.success) {
              setIsRemoteMode(true);
              setRemoteHost(manualIp);
              setRemotePort(String(data.web_admin_port));
              setRemoteUser('admin');
              setRemotePass('admin');
              setRemoteSettings(waData);
              setDetectedDevice(prev => ({
                ...prev,
                name: waData.device?.name || prev.name,
                firmware: waData.device?.firmware || '',
                mac: waData.device?.mac || '',
                description: `${waData.device?.name || 'PDU'} (FW ${waData.device?.firmware || '?'}) — SNMP v${data.snmp_version} + Web Admin :${data.web_admin_port}`,
                web_admin_port: data.web_admin_port,
              }));
              if (waData.snmp?.community_read) setCommunity(waData.snmp.community_read);
            }
          } catch {}
        }
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

  // Batch: scan subnet for DHCP PDUs
  // Supports two methods:
  //   - 'snmp': classic SNMP UDP/161 sweep (fast, but blocked by many corporate VPNs/firewalls)
  //   - 'http': TCP port-80 web-admin probe (works wherever the web UI is reachable, e.g. over VPN)
  const batchScan = async () => {
    setLoading(true);
    setError(null);
    setBatchDevices([]);
    setBatchSelected(new Set());
    try {
      const credUser = batchTemplate.current_credentials?.username || 'admin';
      const credPass = batchTemplate.current_credentials?.password || 'admin';
      const endpoint = batchScanMethod === 'http'
        ? '/api/network/scan/http'
        : '/api/network/scan';
      const body = batchScanMethod === 'http'
        ? {
          subnet: subnet || '192.168.0.0/24',
          ports: [80, 6662, 8080, 443],
          connect_timeout: 1.5,
          http_timeout: 3,
          expand_chains: true,
          hall_id: hallId,
          community,
          current_credentials: { username: credUser, password: credPass },
        }
        : {
          subnet: subnet || '192.168.0.0/24',
          community,
          timeout: 2,
          expand_chains: true,
          hall_id: hallId,
          current_credentials: { username: credUser, password: credPass },
        };
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || `Scan failed (HTTP ${res.status})`);
        return;
      }
      if (data.discovered && data.discovered.length > 0) {
        // For each LAN-visible master, try to auto-detect web admin.
        // Daisy slaves have no NIC — do not HTTP-probe their inventory IPs.
        const enriched = [];
        for (const d of data.discovered) {
          const scanPort = d.web_admin_port || 80;
          const scanHttps = !!d.web_admin_https;
          const entry = { ...d, web_admin_port: scanPort, mac: d.mac || '', firmware: d.firmware || '' };
          if (d.chain_role === 'slave') {
            enriched.push(entry);
            continue;
          }
          try {
            const waRes = await fetch(`${API_BASE}/api/pdu-admin/connect`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                host: d.ip,
                port: scanPort,
                username: credUser,
                password: credPass,
                ...(scanHttps ? { use_https: 1 } : {}),
              }),
            });
            const waData = await waRes.json();
            if (waData.success) {
              entry.web_admin_port = waData.web_port || scanPort;
              entry.web_admin_https = waData.use_https ? 1 : 0;
              entry.mac = waData.device?.mac || entry.mac;
              entry.firmware = waData.device?.firmware || '';
              if (!entry.hostname) entry.hostname = waData.device?.name || d.name;
              entry.name = entry.hostname || waData.device?.name || d.name;
              entry.dhcp = waData.network?.dhcp || '';
            }
          } catch {}
          enriched.push(entry);
        }
        setBatchDevices(enriched);
        setBatchSelected(new Set(enriched.map(d => d.ip)));
      } else {
        setError(
          isDemoMode
            ? `No uncommissioned PDUs on ${subnet || DEMO_SCAN_DEFAULTS.scan_subnet}. The demo cage is already commissioned — use Factory reset below (header Reset Demo → Cancel on the dialog), then scan again.`
            : 'No PDUs found on this subnet'
        );
      }
    } catch (e) {
      setError(`Scan failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const toggleBatchDevice = (ip) => {
    setBatchSelected(prev => {
      const next = new Set(prev);
      if (next.has(ip)) next.delete(ip); else next.add(ip);
      return next;
    });
  };

  // Compute the final ordered list of selected PDUs used by the preview
  // and the actual deploy. Ordering rules:
  //   1. If `batchOrder` is set (user opened the preview), use it verbatim —
  //      this captures any manual drag-reorders.
  //   2. Otherwise, sort selected PDUs by IP when `batchSortByIp` is true,
  //      else fall back to scan-completion order.
  const getOrderedBatchPdus = () => {
    const selected = batchDevices.filter(d => batchSelected.has(d.ip));
    if (batchOrder && batchOrder.length > 0) {
      const byIp = Object.fromEntries(selected.map(d => [d.ip, d]));
      const ordered = batchOrder.map(ip => byIp[ip]).filter(Boolean);
      // Append any newly-selected PDUs that aren't yet in the explicit order.
      const seen = new Set(ordered.map(d => d.ip));
      for (const d of selected) if (!seen.has(d.ip)) ordered.push(d);
      return ordered;
    }
    if (batchSortByIp) return [...selected].sort((a, b) => compareIp(a.ip, b.ip));
    return selected;
  };

  // Open the preview overlay; initializes the explicit IP order from the
  // current sort preference so the user can then drag items if needed.
  const openBatchPreview = () => {
    if (batchSelected.size === 0) { setError('Select at least one PDU'); return; }
    const ordered = getOrderedBatchPdus();
    setBatchOrder(ordered.map(d => d.ip));
    setError(null);
    setBatchPreviewOpen(true);
  };

  const batchDeploy = async () => {
    if (batchSelected.size === 0) { setError('No PDUs selected'); return; }
    setLoading(true);
    setError(null);
    const orderedPdus = getOrderedBatchPdus();
    const selectedPdus = orderedPdus.map(d => ({
      ip: d.ip,
      mac: d.mac || '',
      web_admin_port: d.web_admin_port || 80,
      web_admin_https: d.web_admin_https ? 1 : 0,
      snmp_version: d.snmp_version || '1',
      hostname: d.hostname || d.name || '',
      chain_role: d.chain_role || 'standalone',
      master_ip: d.master_ip || '',
      slave_index: d.slave_index || 0,
      unit_index: d.unit_index || 1,
    }));
    // Tell the backend the order in the payload is authoritative — we already
    // sorted (or the user manually reordered) so the backend should not
    // re-sort and risk shuffling the hostname↔IP pairing.
    const templateForDeploy = { ...batchTemplate, ordering: 'manual' };
    // "Keep current device name" → never push a hostname/device-name to the PDU
    // (the full inventory hostname stays in PDUMind's DB regardless). This also
    // protects NPDU units whose 15-char name field can't hold long hostnames.
    if (batchTemplate.system?.keep_hostname) {
      templateForDeploy.system = {
        ...batchTemplate.system,
        router_hostname: '',
        device_name: '',
        sync_device_name: false,
      };
    }
    setBatchPreviewOpen(false);
    try {
      const res = await fetch(`${API_BASE}/api/batch/commission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: templateForDeploy, pdus: selectedPdus, hall_id: hallId })
      });
      const data = await res.json();
      if (data.success) {
        setBatchJobId(data.job_id);
        setBatchStep(2);
        // Start polling progress
        const pollInterval = setInterval(async () => {
          try {
            const pr = await fetch(`${API_BASE}/api/batch/commission/${data.job_id}`);
            const pd = await pr.json();
            setBatchProgress(pd);
            if (pd.status === 'completed') {
              clearInterval(pollInterval);
              setBatchStep(3);
              setLoading(false);
            }
          } catch {}
        }, 3000);
      } else {
        setError(data.error || 'Failed to start batch job');
        setLoading(false);
      }
    } catch (e) {
      setError(`Batch deploy failed: ${e.message}`);
      setLoading(false);
    }
  };

  // ---- Guided inventory commissioning -------------------------------------
  const invStorageKey = `pdumind_inventory_${hallId || 'default'}`;

  // Restore a saved inventory + progress for this hall.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(invStorageKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (Array.isArray(saved?.targets)) {
          setInvTargets(saved.targets);
          setInvFileName(saved.fileName || '');
        }
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invStorageKey]);

  const persistInventory = (targets, fileName) => {
    try {
      localStorage.setItem(invStorageKey, JSON.stringify({ targets, fileName, savedAt: Date.now() }));
    } catch {}
  };

  const updateInvTargets = (next, fileName) => {
    setInvTargets(next);
    persistInventory(next, fileName ?? invFileName);
  };

  const handleInventoryFile = async (file) => {
    if (!file) return;
    setInvBusy(true);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);
      const res = await fetch(`${API_BASE}/api/commission/inventory/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, content_b64: b64 }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || 'Could not parse the inventory file');
        return;
      }
      setInvFileName(file.name);
      updateInvTargets(data.targets, file.name);
      setInvSiteFilter('all');
    } catch (e) {
      setError(`Inventory upload failed: ${e.message}`);
    } finally {
      setInvBusy(false);
    }
  };

  const invFiltered = invTargets.filter(t => invSiteFilter === 'all' || t.site === invSiteFilter);
  const invSites = [...new Set(invTargets.map(t => t.site).filter(Boolean))];
  const invDone = invTargets.filter(t => t.status === 'done').length;
  // Auto next = first pending; but the operator can hand-pick any pending target.
  const invNext = invFiltered.find(t => t.status === 'pending') || null;
  const invSelected = invSelectedIp
    ? invFiltered.find(t => t.ip === invSelectedIp && t.status === 'pending') || null
    : null;
  const invActive = invSelected || invNext;

  const setTargetStatus = (ip, status, extra = {}) => {
    const next = invTargets.map(t => (t.ip === ip ? { ...t, status, ...extra } : t));
    updateInvTargets(next);
  };

  const detectFactoryPdu = async () => {
    setInvBusy(true);
    setInvStage('detecting');
    setError(null);
    setInvDetected(null);
    try {
      // NPDU-aware HTTP detect first (matches this firmware's /login flow).
      const res = await fetch(`${API_BASE}/api/commission/guided-detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          factory_ip: invFactoryIp,
          current_credentials: { username: 'admin', password: 'admin' },
        }),
      });
      const data = await res.json();
      if (data.success && data.login_ok) {
        setInvDetected({
          ip: data.current_ip || invFactoryIp,
          mac: data.mac || '',
          firmware: data.firmware || 'NPDU',
          name: '',
          mask: data.mask || '',
          gateway: data.gateway || '',
          web_admin_port: data.http_port || 80,
        });
        setInvStage('idle');
        return;
      }
      // Fall back to the SNMP factory-default scan for presence.
      const snmpRes = await fetch(`${API_BASE}/api/network/scan/factory-default`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factory_ip: invFactoryIp, community, scan_subnet: false }),
      });
      const snmp = await snmpRes.json();
      if (snmp.found && snmp.device) {
        setInvDetected({ ...snmp.device });
        setInvStage('idle');
        return;
      }
      setError(data.error || snmp.message || `No PDU found at ${invFactoryIp}. Connect one PDU and put your laptop on the 192.168.0.x subnet.`);
      setInvStage('idle');
    } catch (e) {
      setError(`Detect failed: ${e.message}`);
      setInvStage('idle');
    } finally {
      setInvBusy(false);
    }
  };

  const testGuidedLogin = async () => {
    setInvBusy(true);
    setError(null);
    setInvDiag(null);
    try {
      const res = await fetch(`${API_BASE}/api/commission/guided-detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          factory_ip: invFactoryIp,
          current_credentials: { username: 'admin', password: 'admin' },
        }),
      });
      const data = await res.json();
      setInvDiag(data);
      if (!data.success && !data.attempts) setError(data.error || 'Login test failed');
    } catch (e) {
      setError(`Login test failed: ${e.message}`);
    } finally {
      setInvBusy(false);
    }
  };

  const applyGuidedTarget = async (target) => {
    if (!target) return;
    setInvBusy(true);
    setInvStage('applying');
    setError(null);
    setInvLastResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/commission/guided-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          factory_ip: invFactoryIp,
          hall_id: hallId,
          current_credentials: { username: 'admin', password: 'admin' },
          web_admin_port: invDetected?.web_admin_port || 443,
          web_admin_https: (invDetected?.web_admin_port || 443) === 443 ? 1 : 0,
          target: {
            ip: target.ip,
            mask: target.mask,
            gateway: target.gateway,
            hostname: target.hostname,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setTargetStatus(target.ip, 'failed', { error: data.error || 'apply failed' });
        setError(data.error || `Failed to commission ${target.hostname || target.ip}`);
        if (data.attempts) setInvDiag({ success: false, attempts: data.attempts, host: invFactoryIp });
        setInvStage('idle');
        return;
      }
      setTargetStatus(target.ip, 'done', { mac: invDetected?.mac || '', applied_at: new Date().toISOString() });
      setInvLastResult({ ...data, target });
      setInvDetected(null);
      setInvSelectedIp(null);
      setInvStage('done');
    } catch (e) {
      setTargetStatus(target.ip, 'failed', { error: e.message });
      setError(`Apply failed: ${e.message}`);
      setInvStage('idle');
    } finally {
      setInvBusy(false);
    }
  };

  const fetchBatchRacks = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/halls/${hallId}/racks/available`);
      const data = await res.json();
      if (data.success) setBatchRacks(data.racks || []);
    } catch {}
  };

  const saveBatchRackAssignments = async () => {
    setLoading(true); setError(null);
    const assignments = Object.entries(batchRackMap)
      .filter(([, v]) => v.rack_id)
      .map(([pduKey, v]) => {
        const r = batchProgress?.results?.[pduKey];
        return { pdu_ip: r?.new_ip || r?.ip || pduKey, rack_id: v.rack_id, mount_position: v.slot || 'A' };
      });
    if (assignments.length === 0) { setLoading(false); return; }
    try {
      const res = await fetch(`${API_BASE}/api/halls/${hallId}/pdus/bulk-rack-assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments }),
      });
      const data = await res.json();
      if (data.success) {
        setBatchStep(0); setBatchDevices([]); setBatchSelected(new Set());
        setBatchJobId(null); setBatchProgress(null); setBatchRackMap({});
      } else {
        setError(data.error || 'Failed to assign racks');
      }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
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
      const port = parseInt(remotePort) || 80;
      const res = await fetch(`${API_BASE}/api/pdu-admin/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: cleanHost,
          port,
          username: remoteUser,
          password: remotePass,
          ...(remoteUseHttps ? { use_https: 1 } : {}),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setIsRemoteMode(true);
        setRemoteSettings(data);
        if (data.web_port) setRemotePort(String(data.web_port));
        if (data.use_https !== undefined) setRemoteUseHttps(!!data.use_https);
        setDetectedDevice({
          ip: data.device?.ip || remoteHost,
          name: data.device?.name || 'PDU',
          firmware: data.device?.firmware || '',
          mac: data.device?.mac || '',
          description: `${data.device?.name || 'PDU'} (FW ${data.device?.firmware || '?'}) via Web Admin`,
          snmp_version: '2c',
        });
        setCommunity(data.snmp?.community_read || 'public');
        if (data.web_access) {
          setEditWebAccess({
            https_http: data.web_access.https_http ?? '0',
            http_port: data.web_access.http_port ?? '80',
            https_port: data.web_access.https_port ?? '443',
          });
          const onHttps = String(data.web_access.https_http ?? '0') === '1';
          setRemoteUseHttps(onHttps);
          setRemotePort(String(onHttps ? (data.web_access.https_port ?? '443') : (data.web_access.http_port ?? remotePort)));
        }
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

  // Apply web access (HTTP/HTTPS) settings to remote PDU
  const applyWebAccessSettings = async () => {
    if (!isRemoteMode) return;
    setLoading(true);
    setError(null);
    setRebootStatus(null);
    try {
      const res = await fetch(`${API_BASE}/api/pdu-admin/${remoteHost}/settings/web-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...editWebAccess,
          web_port: parseInt(remotePort) || 80,
          use_https: remoteUseHttps ? 1 : 0,
          username: remoteUser,
          password: remotePass,
          reboot: true,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Failed to apply web access settings');
        setLoading(false);
        return;
      }

      const targetHttps = String(editWebAccess.https_http) === '1';
      const targetPort = targetHttps
        ? String(editWebAccess.https_port || '443')
        : String(editWebAccess.http_port || remotePort || '80');
      setRemoteUseHttps(targetHttps);
      setRemotePort(targetPort);

      if (data.rebooting) {
        setRebootStatus('rebooting');
        setLoading(false);
        const qp = `port=${targetPort}&use_https=${targetHttps ? '1' : '0'}&username=${encodeURIComponent(remoteUser)}&password=${encodeURIComponent(remotePass)}`;
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
            } catch {}
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
        body: JSON.stringify({
          community_read: editSnmp.read_community ?? editSnmp.community_read,
          community_write: editSnmp.write_community ?? editSnmp.community_write,
          snmpv1: editSnmp.snmpv1,
          snmpv2: editSnmp.snmpv2,
          snmpv3: editSnmp.snmpv3,
          snmpv3_username: editSnmp.snmpv3_username,
          verify_protocol: editSnmp.verify_protocol,
          auth_key: editSnmp.auth_key,
          encrypt_protocol: editSnmp.encrypt_protocol,
          priv_key: editSnmp.priv_key,
          trap_ip: editSnmp.trap_ip,
          web_port: parseInt(remotePort) || 6662,
          username: remoteUser,
          password: remotePass,
        })
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
        body: JSON.stringify({
          year: editTime.year,
          month: editTime.month,
          day: editTime.day,
          hour: editTime.hour,
          minute: editTime.minute,
          second: editTime.second,
          sntp_enabled: editTime.sntp_enabled ? 'true' : '',
          sntp_server: primarySntpServer(editTime.sntp_server, editTime.sntp_server2),
          sntp_server2: editTime.sntp_server2 || '',
          timezone: editTime.timezone,
          update_interval: editTime.update_interval,
          correction: editTime.correction,
          web_port: parseInt(remotePort) || 6662,
          username: remoteUser,
          password: remotePass,
        })
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
      snmp_version: detectedDevice?.snmp_version || '2c',
    };
    if (isRemoteMode) {
      payload.remote_host = remoteHost;
      payload.web_admin_port = parseInt(remotePort) || 80;
      payload.web_admin_https = remoteUseHttps ? 1 : 0;
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

  // Build the resolved deploy plan for the preview overlay. Hostnames and
  // device names are computed with the same logic the backend will use.
  const buildBatchPreviewRows = () => {
    const ordered = getOrderedBatchPdus();
    const hostnamePat = batchTemplate.system?.router_hostname || '';
    const namePat = batchTemplate.system?.device_name || '';
    const syncDevice = batchTemplate.system?.sync_device_name !== false;
    const ipStart = (batchTemplate.network?.ip_start || '').trim();
    const ipParts = ipStart.split('.');
    const networkChange = ipParts.length === 4 && ipParts.every(p => /^\d+$/.test(p));
    let netIdx = 0;
    return ordered.map((d) => {
      const isSlave = d.chain_role === 'slave';
      let assignedIp = d.ip;
      if (networkChange && !isSlave) {
        assignedIp = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.${parseInt(ipParts[3], 10) + netIdx}`;
        netIdx += 1;
      }
      const keepName = batchTemplate.system?.keep_hostname || isSlave;
      const hostname = keepName
        ? (d.hostname || d.name || '')
        : resolveHostnamePattern(hostnamePat, isSlave ? d.unit_index - 1 : netIdx - 1, assignedIp, d.mac || '');
      const deviceName = keepName
        ? hostname
        : (syncDevice ? hostname : resolveHostnamePattern(namePat, netIdx - 1, assignedIp, d.mac || ''));
      return {
        idx: netIdx,
        currentIp: d.ip,
        assignedIp,
        mac: d.mac || '',
        hostname,
        deviceName,
        webPort: d.web_admin_port || 80,
        chainRole: d.chain_role,
        masterIp: d.master_ip,
        unitIndex: d.unit_index,
      };
    });
  };

  // Move a row in the preview list (manual reordering before deploy).
  const moveBatchRow = (fromIdx, toIdx) => {
    setBatchOrder(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  return (
    <>
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
                  { id: 'inventory', label: 'Guided (Inventory)', icon: 'list_alt' },
                  { id: 'batch', label: 'Batch', icon: 'dynamic_feed' },
                  { id: 'repair', label: 'Repair', icon: 'healing' },
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
                      onChange={e => {
                        const next = e.target.value;
                        setRemotePort(next);
                        if (next === '443') setRemoteUseHttps(true);
                        else if (next === '80') setRemoteUseHttps(false);
                      }}
                      className="bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                      placeholder="Port (80 or 443)"
                    />
                    <label className="col-span-2 flex items-center gap-2 px-1 py-0.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={remoteUseHttps}
                        onChange={e => {
                          setRemoteUseHttps(e.target.checked);
                          if (e.target.checked && remotePort === '80') setRemotePort('443');
                          if (!e.target.checked && remotePort === '443') setRemotePort('80');
                        }}
                        className="rounded border-[#233544] bg-[#0B1120] text-[#00E5FF] focus:ring-[#00E5FF]"
                      />
                      <span className="text-xs text-slate-400">Use HTTPS (required if the PDU web UI is HTTPS-only)</span>
                    </label>
                    <input
                      type="text" value={remoteUser}
                      onChange={e => setRemoteUser(e.target.value)}
                      className="bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                      placeholder="Username"
                    />
                    <PasswordInput
                      value={remotePass}
                      onChange={e => setRemotePass(e.target.value)}
                      className="w-full"
                      inputClassName={wizardPwClass}
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

              {/* GUIDED INVENTORY — factory-default → assigned IP, one PDU at a time */}
              {scanMode === 'inventory' && (
                <div className="space-y-4">
                  <div className="p-3 rounded-lg bg-[#00E5FF]/10 border border-[#00E5FF]/30">
                    <p className="text-xs text-slate-200 leading-relaxed">
                      <span className="font-semibold text-[#00E5FF]">Guided commissioning.</span> Upload your PDU inventory, then for each
                      unit: plug your laptop's RJ45 into the PDU, click <span className="font-mono text-white">Detect</span>, then
                      <span className="font-mono text-white"> Assign</span>. PDUMind pushes the next IP + hostname and reboots the PDU.
                    </p>
                    <p className="text-[10px] text-amber-300/90 mt-2 flex items-start gap-1.5">
                      <span className="material-icons-outlined text-[12px] mt-0.5">info</span>
                      Keep your laptop on the <span className="font-mono">192.168.0.100 / 255.255.255.0</span> subnet while detecting factory PDUs.
                      After each reboot the PDU moves to its production IP — verify later with a Batch scan on the customer subnet.
                    </p>
                  </div>

                  {/* Upload */}
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="px-4 py-2.5 bg-[#00E5FF]/20 border border-[#00E5FF]/50 hover:bg-[#00E5FF]/30 text-[#00E5FF] rounded-lg text-sm flex items-center gap-2 cursor-pointer">
                      <span className="material-icons-outlined text-sm">upload_file</span>
                      {invTargets.length > 0 ? 'Replace inventory' : 'Upload inventory (.xlsx)'}
                      <input type="file" accept=".xlsx,.xls" className="hidden"
                        onChange={e => { handleInventoryFile(e.target.files?.[0]); e.target.value = ''; }} />
                    </label>
                    {invFileName && <span className="text-[11px] text-slate-400 font-mono truncate max-w-[16rem]">{invFileName}</span>}
                    {invTargets.length > 0 && (
                      <button onClick={() => { updateInvTargets([], ''); setInvFileName(''); setInvDetected(null); }}
                        className="text-[10px] text-slate-500 hover:text-red-300 ml-auto">Clear list</button>
                    )}
                  </div>

                  {invTargets.length > 0 && (
                    <>
                      {/* Progress + filters */}
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div className="text-xs text-slate-300">
                            <span className="font-mono text-emerald-400 font-bold">{invDone}</span>
                            <span className="text-slate-500"> / {invTargets.length} done</span>
                          </div>
                          <div className="h-1.5 w-40 rounded-full bg-[#0B1120] overflow-hidden">
                            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${invTargets.length ? (invDone / invTargets.length) * 100 : 0}%` }} />
                          </div>
                        </div>
                        {invSites.length > 1 && (
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-slate-500 uppercase">Site</span>
                            <select value={invSiteFilter} onChange={e => setInvSiteFilter(e.target.value)}
                              className="bg-[#0B1120] border border-[#233544] rounded px-2 py-1 text-xs text-white">
                              <option value="all">All</option>
                              {invSites.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                          </div>
                        )}
                      </div>

                      {/* Current target action card */}
                      <div className="p-3 rounded-lg bg-[#0B1120] border border-[#233544]">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[10px] text-[#00E5FF] uppercase tracking-wider flex items-center gap-1">
                            <span className="material-icons-outlined text-xs">bolt</span>
                            {invSelected ? 'Selected PDU to commission' : 'Next PDU to commission'}
                          </p>
                          <input value={invFactoryIp} onChange={e => setInvFactoryIp(e.target.value)}
                            className="w-36 bg-[#161E2E] border border-[#233544] rounded px-2 py-1 text-white font-mono text-[11px]"
                            placeholder="192.168.0.163" title="Factory default IP" />
                        </div>

                        {invActive ? (
                          <div className="space-y-3">
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                              <div><p className="text-[9px] text-slate-500 uppercase">Hostname</p><p className="font-mono text-white truncate" title={invActive.hostname}>{invActive.hostname || '—'}</p></div>
                              <div><p className="text-[9px] text-slate-500 uppercase">Assign IP</p><p className="font-mono text-[#00E5FF]">{invActive.ip}/{invActive.cidr}</p></div>
                              <div><p className="text-[9px] text-slate-500 uppercase">Gateway</p><p className="font-mono text-slate-300">{invActive.gateway}</p></div>
                              <div><p className="text-[9px] text-slate-500 uppercase">Rack</p><p className="font-mono text-slate-300">{invActive.rack || '—'}</p></div>
                            </div>

                            {invSelected ? (
                              <p className="text-[10px] text-[#00E5FF]/90 flex items-center gap-1.5">
                                <span className="material-icons-outlined text-[12px]">touch_app</span>
                                Hand-picked target — assigning to the connected PDU instead of the sequential next.
                                <button onClick={() => setInvSelectedIp(null)} className="ml-1 text-slate-500 hover:text-amber-300 underline">use sequential next</button>
                              </p>
                            ) : (
                              <p className="text-[10px] text-slate-500 flex items-center gap-1.5">
                                <span className="material-icons-outlined text-[12px]">info</span>
                                Sequential next. Pick any <span className="text-slate-300">Pending</span> row below to assign a different IP to this PDU.
                              </p>
                            )}

                            {invDetected && (
                              <div className="p-2 rounded bg-emerald-500/10 border border-emerald-500/30 text-[11px] text-emerald-200 flex items-center gap-2">
                                <span className="material-icons-outlined text-sm">check_circle</span>
                                Detected factory PDU at {invDetected.ip}
                                {invDetected.mac && <span className="font-mono text-slate-400">· {invDetected.mac}</span>}
                                {invDetected.firmware && <span className="text-slate-500">· FW {invDetected.firmware}</span>}
                              </div>
                            )}

                            <div className="flex flex-wrap gap-2">
                              <button onClick={detectFactoryPdu} disabled={invBusy}
                                className="px-4 py-2 bg-[#161E2E] border border-[#00E5FF]/40 hover:bg-[#00E5FF]/10 disabled:opacity-50 text-[#00E5FF] rounded-lg text-sm flex items-center gap-1.5">
                                {invBusy && invStage === 'detecting'
                                  ? <span className="material-icons-outlined text-sm animate-spin">sync</span>
                                  : <span className="material-icons-outlined text-sm">wifi_find</span>}
                                1. Detect
                              </button>
                              <button onClick={() => applyGuidedTarget(invActive)} disabled={invBusy || !invDetected}
                                className="px-4 py-2 bg-emerald-500/20 border border-emerald-500/50 hover:bg-emerald-500/30 disabled:opacity-40 text-emerald-300 rounded-lg text-sm flex items-center gap-1.5"
                                title={!invDetected ? 'Detect a factory PDU first' : ''}>
                                {invBusy && invStage === 'applying'
                                  ? <span className="material-icons-outlined text-sm animate-spin">sync</span>
                                  : <span className="material-icons-outlined text-sm">send</span>}
                                2. Assign {invActive.ip} &amp; reboot
                              </button>
                              <button onClick={testGuidedLogin} disabled={invBusy}
                                className="px-3 py-2 bg-[#161E2E] border border-[#233544] hover:border-amber-400/50 disabled:opacity-50 text-amber-300 rounded-lg text-xs flex items-center gap-1.5"
                                title="Probe web-admin login on ports 443/80/6662/8080 with admin/admin">
                                <span className="material-icons-outlined text-sm">vpn_key</span>
                                Test login
                              </button>
                              <button onClick={() => { setTargetStatus(invActive.ip, 'skipped'); setInvSelectedIp(null); }} disabled={invBusy}
                                className="px-3 py-2 text-slate-500 hover:text-amber-300 rounded-lg text-xs ml-auto">Skip</button>
                            </div>

                            {invDiag && (
                              <div className={`p-2 rounded border text-[11px] ${invDiag.success ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
                                <p className={`font-semibold mb-1 ${invDiag.success ? 'text-emerald-300' : 'text-red-300'}`}>
                                  {invDiag.success
                                    ? `Login OK on ${invDiag.url} (use admin/admin)`
                                    : `Login failed on all ports for ${invDiag.host || invFactoryIp}`}
                                </p>
                                <div className="space-y-0.5 font-mono text-[10px]">
                                  {(invDiag.attempts || []).map((a, i) => (
                                    <div key={i} className="flex items-center gap-2">
                                      <span className={a.success ? 'text-emerald-400' : a.tcp_reachable ? 'text-amber-400' : 'text-slate-600'}>
                                        {a.success ? '✓' : a.tcp_reachable ? '!' : '×'}
                                      </span>
                                      <span className="text-slate-400">{a.url}</span>
                                      <span className="text-slate-600 truncate">
                                        {a.success ? 'login OK' : a.tcp_reachable ? (a.error || 'login rejected') : 'no TCP (port closed/unreachable)'}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                                {!invDiag.success && (
                                  <p className="text-[10px] text-slate-400 mt-1.5 leading-relaxed">
                                    If all show <span className="text-slate-300">no TCP</span>: laptop not on the PDU subnet, or Docker can't reach it — check IP <span className="font-mono">192.168.0.100/24</span>.
                                    If a port is <span className="text-amber-300">reachable but login rejected</span>: the factory password isn't admin/admin — try the label/QR password.
                                  </p>
                                )}
                              </div>
                            )}

                            {invLastResult && (
                              <p className="text-[11px] text-emerald-300/90 flex items-center gap-1.5">
                                <span className="material-icons-outlined text-xs">task_alt</span>
                                {invLastResult.message}
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="text-sm text-emerald-300 py-2 flex items-center gap-2">
                            <span className="material-icons-outlined text-base">verified</span>
                            All PDUs in this view are commissioned. Switch your laptop to the production subnet and run a Batch scan to verify.
                          </p>
                        )}
                      </div>

                      {/* Inventory list */}
                      <div className="max-h-[320px] overflow-y-auto rounded-lg border border-[#233544]">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-[#0B1120] text-slate-500 text-[10px] uppercase">
                            <tr>
                              <th className="text-left px-2 py-1.5">#</th>
                              <th className="text-left px-2 py-1.5">Hostname</th>
                              <th className="text-left px-2 py-1.5">IP</th>
                              <th className="text-left px-2 py-1.5">Gateway</th>
                              <th className="text-left px-2 py-1.5">Rack</th>
                              <th className="text-left px-2 py-1.5">Status</th>
                              <th className="px-2 py-1.5"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {invFiltered.map((t, i) => {
                              const isActive = invActive && t.ip === invActive.ip;
                              const isPicked = invSelected && t.ip === invSelected.ip;
                              const selectable = t.status === 'pending' && !invBusy;
                              return (
                                <tr key={t.ip}
                                  onClick={selectable ? () => setInvSelectedIp(t.ip) : undefined}
                                  className={`border-t border-[#233544]/60 ${isActive ? 'bg-[#00E5FF]/10' : ''} ${selectable ? 'cursor-pointer hover:bg-[#00E5FF]/5' : ''}`}>
                                  <td className="px-2 py-1.5 text-slate-600">
                                    {isActive
                                      ? <span className="material-icons-outlined text-[14px] text-[#00E5FF]" title={isPicked ? 'Selected target' : 'Next target'}>{isPicked ? 'radio_button_checked' : 'play_arrow'}</span>
                                      : (t.sr_no || i + 1)}
                                  </td>
                                  <td className="px-2 py-1.5 font-mono text-slate-300 truncate max-w-[14rem]" title={t.hostname}>{t.hostname}</td>
                                  <td className="px-2 py-1.5 font-mono text-[#00E5FF]">{t.ip}</td>
                                  <td className="px-2 py-1.5 font-mono text-slate-500">{t.gateway}</td>
                                  <td className="px-2 py-1.5 font-mono text-slate-500">{t.rack || '—'}</td>
                                  <td className="px-2 py-1.5">
                                    {t.status === 'done' && <span className="text-emerald-400 flex items-center gap-1"><span className="material-icons-outlined text-[13px]">check_circle</span>Done</span>}
                                    {t.status === 'pending' && <span className={isPicked ? 'text-[#00E5FF] font-semibold' : 'text-slate-500'}>{isPicked ? 'Selected' : 'Pending'}</span>}
                                    {t.status === 'skipped' && <span className="text-amber-400">Skipped</span>}
                                    {t.status === 'failed' && <span className="text-red-400" title={t.error}>Failed</span>}
                                  </td>
                                  <td className="px-2 py-1.5 text-right whitespace-nowrap">
                                    {t.status === 'pending' && !isPicked && (
                                      <button onClick={(e) => { e.stopPropagation(); setInvSelectedIp(t.ip); }}
                                        className="text-[10px] text-slate-600 hover:text-[#00E5FF]" title="Assign this IP to the connected PDU">select</button>
                                    )}
                                    {isPicked && (
                                      <button onClick={(e) => { e.stopPropagation(); setInvSelectedIp(null); }}
                                        className="text-[10px] text-[#00E5FF] hover:text-amber-300" title="Clear selection (use sequential next)">clear</button>
                                    )}
                                    {t.status !== 'pending' && (
                                      <button onClick={(e) => { e.stopPropagation(); setTargetStatus(t.ip, 'pending'); }}
                                        className="text-[10px] text-slate-600 hover:text-[#00E5FF]" title="Reset to pending">redo</button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* REPAIR WEB ACCESS — uses this hall's PDUs from the app DB */}
              {scanMode === 'repair' && (
                <div className="space-y-3">
                  <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                    <p className="text-xs text-amber-200 leading-relaxed">
                      <span className="font-semibold text-white">Smart auto-repair</span> — diagnoses DB corruption, probes the network,
                      then tries credentials in order: your password → stored DB password → factory admin/admin.
                      Fixes wrong port, HTTPS flag, and wiped credentials automatically when the PDU responds.
                      <span className="block mt-1 text-amber-100/80">Close any open PDU tabs in Chrome before repairing — each PDU allows only one web session.</span>
                    </p>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-slate-400">
                      {repairPdus.length} active PDU(s) in {hallName || `Hall #${hallId}`}
                    </p>
                    <button
                      type="button"
                      onClick={fetchRepairPdus}
                      disabled={repairLoading}
                      className="text-[10px] text-[#00E5FF] hover:text-[#00E5FF]/80 flex items-center gap-1"
                    >
                      <span className={`material-icons-outlined text-xs ${repairLoading ? 'animate-spin' : ''}`}>refresh</span>
                      Reload from hall
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[9px] text-slate-500 uppercase">Username (try on each PDU)</label>
                      <input
                        type="text"
                        value={repairUser}
                        onChange={e => setRepairUser(e.target.value)}
                        className="w-full bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                        placeholder="admin"
                      />
                    </div>
                    <div>
                      <label className="text-[9px] text-slate-500 uppercase">Password (must work in Chrome now)</label>
                      <PasswordInput
                        value={repairPass}
                        onChange={e => setRepairPass(e.target.value)}
                        inputClassName={repairPwClass}
                        placeholder="admin"
                      />
                    </div>
                  </div>
                  {batchTemplate.current_credentials?.password && (
                    <button
                      type="button"
                      onClick={() => {
                        setRepairUser(batchTemplate.current_credentials.username || 'admin');
                        setRepairPass(batchTemplate.current_credentials.password);
                      }}
                      className="text-[10px] text-slate-400 hover:text-[#00E5FF]"
                    >
                      Use batch template password ({batchTemplate.current_credentials.username || 'admin'})
                    </button>
                  )}

                  {repairStatus && (
                    <div className={`p-3 rounded-lg border text-sm ${
                      repairStatus.phase === 'success'
                        ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-100'
                        : repairStatus.phase === 'partial'
                          ? 'bg-amber-500/15 border-amber-500/50 text-amber-100'
                          : repairStatus.phase === 'running'
                            ? 'bg-cyan-500/10 border-cyan-500/40 text-cyan-100'
                            : 'bg-red-500/15 border-red-500/50 text-red-100'
                    }`}>
                      <div className="flex items-start gap-2">
                        <span className="material-icons-outlined text-base mt-0.5">
                          {repairStatus.phase === 'success' ? 'check_circle'
                            : repairStatus.phase === 'partial' ? 'warning'
                            : repairStatus.phase === 'running' ? 'sync'
                            : 'error'}
                        </span>
                        <div>
                          <p className="font-semibold">{repairStatus.message}</p>
                          {repairResults && (
                            <p className="text-xs mt-1 opacity-90">
                              {repairResults.repaired} succeeded · {repairResults.total - repairResults.repaired} failed · hall {repairResults.hall_name || hallName}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {repairPdus.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] text-slate-500 uppercase tracking-wider">Active PDUs in hall</p>
                        <button
                          type="button"
                          onClick={() => {
                            const ids = repairPdus.map(p => p.id);
                            setRepairSelected(prev => (prev.size === ids.length ? new Set() : new Set(ids)));
                          }}
                          className="text-[10px] text-[#00E5FF] hover:text-[#00E5FF]/80"
                        >
                          {repairSelected.size === repairPdus.length ? 'Deselect all' : 'Select all'}
                        </button>
                      </div>
                      <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
                        {repairPdus.map(pdu => {
                          const result = findRepairResult(pdu);
                          const probe = probeResults[pdu.ip_address];
                          const storedScheme = pdu.web_admin_https ? 'https' : 'http';
                          const storedPort = pdu.web_admin_port || 'missing';
                          const dbIssues = [];
                          if (!pdu.web_admin_port) dbIssues.push('no port');
                          if (!pdu.web_admin_pass) dbIssues.push('no pass');
                          return (
                            <div
                              key={pdu.id}
                              className={`p-3 rounded-lg border ${
                                result?.success
                                  ? 'bg-emerald-500/10 border-emerald-500/40'
                                  : result
                                    ? 'bg-red-500/10 border-red-500/40'
                                    : repairSelected.has(pdu.id)
                                      ? 'bg-[#0B1120] border-[#00E5FF]/30'
                                      : 'bg-[#0B1120] border-[#233544]'
                              }`}
                            >
                              <div className="flex items-start gap-3">
                                <button
                                  type="button"
                                  onClick={() => toggleRepairPdu(pdu.id)}
                                  className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${
                                    repairSelected.has(pdu.id) ? 'border-emerald-400 bg-emerald-500/20' : 'border-slate-600'
                                  }`}
                                >
                                  {repairSelected.has(pdu.id) && (
                                    <span className="material-icons-outlined text-emerald-400 text-xs">check</span>
                                  )}
                                </button>
                                <div className="flex-1 min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-mono text-white text-sm">{pdu.ip_address}</span>
                                    {pdu.label && <span className="text-[10px] text-slate-500 truncate">{pdu.label}</span>}
                                    <span className={`text-[9px] px-1.5 py-0.5 rounded border ${
                                      dbIssues.length
                                        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                                        : 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30'
                                    }`}>
                                      DB: {storedScheme}:{storedPort} / {pdu.web_admin_user || 'admin'}
                                      {dbIssues.length ? ` (${dbIssues.join(', ')})` : ''}
                                    </span>
                                    {result && (
                                      <span className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold ${
                                        result.success
                                          ? 'bg-emerald-500/30 text-emerald-200 border-emerald-500/50'
                                          : 'bg-red-500/30 text-red-200 border-red-500/50'
                                      }`}>
                                        {result.success
                                          ? `OK → ${result.after?.web_admin_https ? 'https' : 'http'}:${result.after?.web_admin_port}`
                                          : result.code === 'NETWORK_UNREACHABLE' ? 'OFFLINE'
                                          : result.code === 'AUTH_FAILED' ? 'LOGIN FAILED'
                                          : 'FAILED'}
                                      </span>
                                    )}
                                  </div>
                                  {result?.message && (
                                    <p className={`text-[11px] mt-1.5 leading-relaxed ${result.success ? 'text-emerald-300' : 'text-red-300'}`}>
                                      {result.message}
                                    </p>
                                  )}
                                  {result?.recommendation && !result.success && (
                                    <p className="text-[10px] text-amber-200/90 mt-1 leading-relaxed">
                                      → {result.recommendation}
                                    </p>
                                  )}
                                  {result?.steps?.length > 0 && (
                                    <details className="mt-2">
                                      <summary className="text-[10px] text-slate-400 cursor-pointer hover:text-slate-300">
                                        Repair steps ({result.steps.length})
                                      </summary>
                                      <div className="mt-1 space-y-0.5 pl-2 border-l border-slate-700">
                                        {result.steps.map((step, i) => (
                                          <p key={i} className="text-[9px] font-mono text-slate-500 leading-relaxed">
                                            {step.label || step.phase}
                                            {step.source ? ` [${step.source}]` : ''}
                                            {step.code ? ` — ${step.code}` : ''}
                                            {step.open_ports ? ` — open: ${step.open_ports.join(',')}` : ''}
                                          </p>
                                        ))}
                                      </div>
                                    </details>
                                  )}
                                  {probe && !probe.success && (
                                    <div className="mt-2 space-y-1">
                                      {probe.attempts?.slice(0, 4).map((a) => (
                                        <p key={a.url} className="text-[10px] font-mono text-slate-400">
                                          {a.url}: {a.success ? 'OK' : (a.error || 'failed')}
                                        </p>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                <div className="flex flex-col gap-1 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => testProbeLogin(pdu.ip_address)}
                                    disabled={repairLoading}
                                    className="text-[10px] text-slate-400 hover:text-white disabled:opacity-40"
                                  >
                                    Test
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => runRepairWebAccess([pdu.id])}
                                    disabled={repairLoading}
                                    className="text-[10px] text-[#00E5FF] hover:text-[#00E5FF]/80 disabled:opacity-40"
                                  >
                                    Repair
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {repairPdus.length === 0 && !repairLoading && (
                    <p className="text-xs text-slate-500 text-center py-6">No active PDUs in this hall yet. Commission PDUs first, then use Repair if telemetry breaks.</p>
                  )}

                  <button
                    type="button"
                    onClick={() => runRepairWebAccess()}
                    disabled={repairLoading || repairSelected.size === 0}
                    className="w-full px-5 py-2.5 bg-emerald-500/20 border border-emerald-500/50 hover:bg-emerald-500/30 disabled:opacity-50 text-emerald-300 rounded-lg flex items-center justify-center gap-2 transition-all text-sm"
                  >
                    {repairLoading ? (
                      <span className="material-icons-outlined text-sm animate-spin">sync</span>
                    ) : (
                      <span className="material-icons-outlined text-sm">healing</span>
                    )}
                    Smart Repair {repairSelected.size || 0} selected PDU{repairSelected.size === 1 ? '' : 's'}
                  </button>

                  <p className="text-[10px] text-slate-600 leading-relaxed">
                    Tries: your password → DB stored password → factory admin/admin, on HTTPS:443 then HTTP:80.
                    If batch commissioning changed the password, enter that password above.
                    Use <span className="text-slate-400">Test</span> first to diagnose without changing the database.
                  </p>
                </div>
              )}

              {/* BATCH MODE */}
              {scanMode === 'batch' && (
                <div className="space-y-3">
                  {batchStep === 0 && (
                    <>
                      <p className="text-xs text-slate-400">Scan a subnet for all DHCP-connected PDUs, then configure them all at once.</p>
                      <p className="text-[10px] text-slate-500 leading-relaxed px-0.5">
                        Daisy-chain slaves have no Ethernet — the scan reads them through each master
                        (<span className="font-mono">getstatus</span> / SNMP <span className="font-mono">.3.2–.3.4</span>).
                        SNMP in the template is written on the master and applied to the whole chain.
                      </p>

                      {/* Discovery method selector — HTTP mode is for VPN/firewalled networks where SNMP UDP/161 is blocked */}
                      <div className="flex items-center gap-2 p-2 rounded-lg bg-[#0a1222] border border-[#233544]">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 px-2">Discovery</span>
                        <div className="flex gap-1 flex-1">
                          <button
                            onClick={() => setBatchScanMethod('snmp')}
                            className={`flex-1 py-1.5 px-2 text-[11px] rounded transition-all flex items-center justify-center gap-1.5 ${
                              batchScanMethod === 'snmp'
                                ? 'bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/40'
                                : 'text-slate-400 hover:text-white border border-transparent'
                            }`}
                            title="SNMP UDP/161 — fastest, requires SNMP to be reachable"
                          >
                            <span className="material-icons-outlined text-xs">router</span>
                            SNMP (UDP/161)
                          </button>
                          <button
                            onClick={() => setBatchScanMethod('http')}
                            className={`flex-1 py-1.5 px-2 text-[11px] rounded transition-all flex items-center justify-center gap-1.5 ${
                              batchScanMethod === 'http'
                                ? 'bg-amber-400/20 text-amber-300 border border-amber-400/40'
                                : 'text-slate-400 hover:text-white border border-transparent'
                            }`}
                            title="HTTP TCP/80 — use this when SNMP is blocked by VPN or corporate firewall"
                          >
                            <span className="material-icons-outlined text-xs">vpn_lock</span>
                            HTTP (TCP/80) — VPN-safe
                          </button>
                        </div>
                      </div>
                      {batchScanMethod === 'http' && (
                        <p className="text-[10px] text-amber-300/80 flex items-start gap-1.5 px-1">
                          <span className="material-icons-outlined text-[12px] mt-0.5">info</span>
                          HTTP mode probes port 80 (and 6662/8080/443) on each IP. Use this when single-IP scan works but subnet/range scan returns nothing — typically a sign that SNMP UDP/161 is blocked by the customer VPN or firewall.
                        </p>
                      )}

                      {isDemoMode && (
                        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-fuchsia-500/10 border border-fuchsia-500/30">
                          <span className="material-icons-outlined text-sm text-fuchsia-300 mt-0.5">science</span>
                          <div className="text-[11px] leading-relaxed flex-1 min-w-0">
                            <p className="font-medium text-fuchsia-200">Demo scan range</p>
                            <p className="font-mono text-fuchsia-300/90 mt-0.5">{DEMO_SCAN_DEFAULTS.scan_subnet}</p>
                            <p className="text-slate-500 mt-1">
                              PDUs {DEMO_SCAN_DEFAULTS.pdu_ip_range} · community <span className="font-mono">private</span>
                              {' · '}batch scan only finds <span className="text-fuchsia-300/90">uncommissioned</span> units.
                            </p>
                            <button
                              type="button"
                              onClick={resetDemoForCommissioning}
                              disabled={loading}
                              className="mt-2 px-2.5 py-1 rounded border border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/15 text-[10px] font-bold uppercase tracking-wide disabled:opacity-50"
                            >
                              Factory reset for commissioning
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="flex gap-2">
                        <input type="text" value={subnet} onChange={e => setSubnet(e.target.value)}
                          className="flex-1 bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                          placeholder={isDemoMode ? DEMO_SCAN_DEFAULTS.scan_subnet : '10.106.76.206-223 or 192.168.0.0/24'} />
                        {batchScanMethod === 'snmp' && (
                          <input type="text" value={community} onChange={e => setCommunity(e.target.value)}
                            className="w-24 bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00E5FF]"
                            placeholder="public" />
                        )}
                        <button onClick={batchScan} disabled={loading}
                          className="px-4 py-2.5 bg-[#00E5FF]/20 border border-[#00E5FF]/50 hover:bg-[#00E5FF]/30 disabled:opacity-50 text-[#00E5FF] rounded-lg text-sm flex items-center gap-1.5">
                          {loading ? <span className="material-icons-outlined text-sm animate-spin">sync</span> :
                            <span className="material-icons-outlined text-sm">radar</span>}
                          Scan
                        </button>
                      </div>
                      {batchDevices.length > 0 && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-xs text-slate-400">
                              Found {batchDevices.length} PDU(s)
                              {batchDevices.some(d => d.chain_role === 'slave') && (
                                <span className="text-slate-500">
                                  {' '}· {batchDevices.filter(d => d.chain_role !== 'slave').length} masters,{' '}
                                  {batchDevices.filter(d => d.chain_role === 'slave').length} daisy slaves
                                </span>
                              )}
                              {' '}— select which to commission:
                            </p>
                            <button onClick={() => setBatchSelected(prev => prev.size === batchDevices.length ? new Set() : new Set(batchDevices.map(d => d.ip)))}
                              className="text-[10px] text-[#00E5FF] hover:text-[#00E5FF]/80">
                              {batchSelected.size === batchDevices.length ? 'Deselect All' : 'Select All'}
                            </button>
                          </div>
                          <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                            {batchDevices.map(d => (
                              <div key={d.ip} onClick={() => toggleBatchDevice(d.ip)}
                                className={`p-3 rounded-lg border cursor-pointer transition-all ${
                                  d.chain_role === 'slave' ? 'ml-4 ' : ''
                                }${
                                  batchSelected.has(d.ip) ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-[#0B1120] border-[#233544] hover:border-slate-500'
                                }`}>
                                <div className="flex items-center gap-3">
                                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
                                    batchSelected.has(d.ip) ? 'border-emerald-400 bg-emerald-500/20' : 'border-slate-600'
                                  }`}>
                                    {batchSelected.has(d.ip) && <span className="material-icons-outlined text-emerald-400 text-xs">check</span>}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="font-mono text-white text-sm">{d.ip}</span>
                                      {d.mac && <span className="text-[10px] text-slate-500 font-mono">{d.mac}</span>}
                                      {d.chain_role === 'master' && (d.chain_size || 0) > 1 && (
                                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#00E5FF]/15 text-[#00E5FF] border border-[#00E5FF]/30">Chain master</span>
                                      )}
                                      {d.chain_role === 'slave' && (
                                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">
                                          Daisy -{d.unit_index} via {d.master_ip}
                                        </span>
                                      )}
                                      {d.chain_role === 'slave' && d.chain_live === false && (
                                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">0 V bus</span>
                                      )}
                                      {d.dhcp === 'ON' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">DHCP</span>}
                                      {d.web_admin_port && d.chain_role !== 'slave' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">Web:{d.web_admin_port}</span>}
                                    </div>
                                    {(d.hostname || d.name) && <p className="text-[10px] text-slate-500 truncate">{d.hostname || d.name} {d.firmware ? `(FW ${d.firmware})` : ''}</p>}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                          <button onClick={() => setBatchStep(1)} disabled={batchSelected.size === 0}
                            className="w-full py-2.5 bg-[#00E5FF]/20 border border-[#00E5FF]/50 text-[#00E5FF] rounded-lg text-sm disabled:opacity-30 hover:bg-[#00E5FF]/30 flex items-center justify-center gap-2">
                            <span className="material-icons-outlined text-sm">tune</span>
                            Configure Template ({batchSelected.size} PDUs)
                          </button>
                        </div>
                      )}
                    </>
                  )}

                  {batchStep === 1 && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-bold text-white">Batch Template</h4>
                        <button onClick={() => setBatchStep(0)} className="text-[10px] text-slate-400 hover:text-white">
                          <span className="material-icons-outlined text-xs mr-0.5">arrow_back</span> Back to scan
                        </button>
                      </div>
                      {/* Network */}
                      <div className={`p-3 rounded-lg border ${batchTemplate.network.ip_start ? 'bg-[#0B1120] border-[#233544]' : 'bg-[#0a1222] border-[#1f2a3a] opacity-90'}`}>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[10px] text-[#00E5FF] uppercase tracking-wider flex items-center gap-1">
                            <span className="material-icons-outlined text-xs">lan</span> Network
                            <span className="ml-2 text-[9px] text-slate-500 normal-case tracking-normal">(optional)</span>
                          </p>
                          {!batchTemplate.network.ip_start && (
                            <span className="text-[9px] text-emerald-400 flex items-center gap-1">
                              <span className="material-icons-outlined text-[10px]">check_circle</span>
                              Keeping current IPs (no reboot)
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-slate-400 mb-2 leading-relaxed">
                          Leave <span className="font-mono text-slate-300">Starting IP</span> empty to keep the IPs already assigned by your network administrator. Fill it in only if you want PDUMind to push new static IPs (will reboot each PDU).
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[9px] text-slate-500 uppercase">Starting IP</label>
                            <input type="text" value={batchTemplate.network.ip_start}
                              onChange={e => setBatchTemplate(p => ({ ...p, network: { ...p.network, ip_start: e.target.value } }))}
                              className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]"
                              placeholder="(empty = keep current IPs)" />
                            <p className="text-[9px] text-slate-600 mt-0.5">Auto-increments: .101, .102, .103...</p>
                          </div>
                          {['mask', 'gateway', 'dns1', 'dns2'].map(k => (
                            <div key={k}>
                              <label className="text-[9px] text-slate-500 uppercase">{k === 'mask' ? 'Subnet Mask' : k === 'dns1' ? 'DNS 1' : k === 'dns2' ? 'DNS 2' : 'Gateway'}</label>
                              <input type="text" value={batchTemplate.network[k] || ''}
                                onChange={e => setBatchTemplate(p => ({ ...p, network: { ...p.network, [k]: e.target.value } }))}
                                disabled={!batchTemplate.network.ip_start}
                                className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF] disabled:opacity-40 disabled:cursor-not-allowed" />
                            </div>
                          ))}
                        </div>
                      </div>
                      {/* System */}
                      <div className="p-3 rounded-lg bg-[#0B1120] border border-[#233544]">
                        <p className="text-[10px] text-[#00E5FF] uppercase tracking-wider mb-2 flex items-center gap-1">
                          <span className="material-icons-outlined text-xs">dns</span> System
                        </p>
                        <div className="space-y-2">
                          <label className="flex items-center gap-2 cursor-pointer p-2 rounded bg-[#161E2E] border border-[#233544] hover:border-[#00E5FF]/50 transition-colors">
                            <input type="checkbox"
                              checked={batchTemplate.system.keep_hostname === true}
                              onChange={e => setBatchTemplate(p => ({ ...p, system: { ...p.system, keep_hostname: e.target.checked } }))}
                              className="accent-[#00E5FF]" />
                            <span className="text-[11px] text-white">Keep current device name (don't change)</span>
                            <span className="text-[9px] text-slate-500 ml-1">— use when IPs/names were already set in Guided mode</span>
                          </label>
                          <div className={batchTemplate.system.keep_hostname ? 'opacity-40 pointer-events-none' : ''}>
                            <label className="text-[9px] text-slate-500 uppercase">Hostname Pattern</label>
                            <input type="text" value={batchTemplate.system.router_hostname}
                              onChange={e => setBatchTemplate(p => ({ ...p, system: { ...p.system, router_hostname: e.target.value } }))}
                              disabled={batchTemplate.system.keep_hostname === true}
                              className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]"
                              placeholder="SIN1-PDU-2NBS{10-17}-A" />
                            <div className="text-[9px] text-slate-600 mt-1 space-y-0.5">
                              <p className="text-slate-500 font-medium">Variables (auto-replaced per PDU):</p>
                              <p><span className="text-[#00E5FF] font-mono">{'{N}'}</span> — start at N (e.g. <span className="font-mono text-white">{'{10}'}</span> → 10, 11, 12...)</p>
                              <p><span className="text-[#00E5FF] font-mono">{'{N-M}'}</span> — start at N, width from M (e.g. <span className="font-mono text-white">{'{10-17}'}</span> → 10, 11, 12... 17)</p>
                              <p><span className="text-[#00E5FF] font-mono">{'{seq}'}</span> — 3-digit zero-padded sequence: 001, 002, 003...</p>
                              <p><span className="text-[#00E5FF] font-mono">{'{idx}'}</span> — zero-based index: 0, 1, 2...</p>
                              <p><span className="text-[#00E5FF] font-mono">{'{ip}'}</span> — assigned IP address</p>
                              <p><span className="text-[#00E5FF] font-mono">{'{mac}'}</span> — last 6 chars of MAC</p>
                              <p className="text-emerald-400 mt-1">
                                <span className="material-icons-outlined text-[10px] mr-0.5">lightbulb</span>
                                Example: <span className="font-mono text-white">SIN1-PDU-2NBS{'{10-17}'}-A</span>
                                {' '}with PDUs at 10.106.76.206-213 →
                                {' '}<span className="font-mono text-white">SIN1-PDU-2NBS10-A … SIN1-PDU-2NBS17-A</span>
                              </p>
                            </div>
                          </div>
                          <label className={`flex items-center gap-2 cursor-pointer p-2 rounded bg-[#161E2E] border border-[#233544] hover:border-[#00E5FF]/50 transition-colors ${batchTemplate.system.keep_hostname ? 'opacity-40 pointer-events-none' : ''}`}>
                            <input type="checkbox"
                              checked={batchTemplate.system.sync_device_name !== false}
                              disabled={batchTemplate.system.keep_hostname === true}
                              onChange={e => setBatchTemplate(p => ({ ...p, system: { ...p.system, sync_device_name: e.target.checked } }))}
                              className="accent-[#00E5FF]" />
                            <span className="text-[11px] text-white">Use hostname as device name</span>
                            <span className="text-[9px] text-slate-500 ml-1">— each PDU's device name will mirror its resolved hostname</span>
                          </label>
                          {batchTemplate.system.sync_device_name === false && !batchTemplate.system.keep_hostname && (
                            <div>
                              <label className="text-[9px] text-slate-500 uppercase">Device Name (or pattern)</label>
                              <input type="text" value={batchTemplate.system.device_name}
                                onChange={e => setBatchTemplate(p => ({ ...p, system: { ...p.system, device_name: e.target.value } }))}
                                className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]"
                                placeholder="Same placeholders as hostname pattern" />
                            </div>
                          )}
                        </div>
                      </div>
                      {/* Credentials */}
                      <div className="p-3 rounded-lg bg-[#0B1120] border border-[#233544]">
                        <p className="text-[10px] text-[#00E5FF] uppercase tracking-wider mb-2 flex items-center gap-1">
                          <span className="material-icons-outlined text-xs">manage_accounts</span> PDU Web Login
                        </p>
                        <p className="text-[9px] text-slate-600 mb-2">
                          Current credentials are used to connect during batch deploy. New values are written to each PDU.
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[9px] text-slate-500 uppercase">Current Username</label>
                            <input
                              type="text"
                              value={batchTemplate.current_credentials.username}
                              onChange={e => setBatchTemplate(p => ({
                                ...p,
                                current_credentials: { ...p.current_credentials, username: e.target.value },
                              }))}
                              className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]"
                              placeholder="admin"
                            />
                          </div>
                          <div>
                            <label className="text-[9px] text-slate-500 uppercase">Current Password</label>
                            <PasswordInput
                              value={batchTemplate.current_credentials.password}
                              onChange={e => setBatchTemplate(p => ({ ...p, current_credentials: { ...p.current_credentials, password: e.target.value } }))}
                              inputClassName={batchPwClass}
                              placeholder="Password on PDU now"
                            />
                          </div>
                          <div>
                            <label className="text-[9px] text-slate-500 uppercase">New Admin Username</label>
                            <input
                              type="text"
                              value={batchTemplate.users.admin_username}
                              onChange={e => setBatchTemplate(p => ({ ...p, users: { ...p.users, admin_username: e.target.value } }))}
                              className="w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]"
                              placeholder="Leave blank to keep current"
                            />
                          </div>
                          <div>
                            <label className="text-[9px] text-slate-500 uppercase">New Admin Password</label>
                            <PasswordInput
                              value={batchTemplate.users.admin_password}
                              onChange={e => setBatchTemplate(p => ({ ...p, users: { ...p.users, admin_password: e.target.value } }))}
                              inputClassName={batchPwClass}
                              placeholder="Leave blank to keep current"
                            />
                          </div>
                        </div>
                      </div>
                      {/* SNMP */}
                      <div className="p-3 rounded-lg bg-[#0B1120] border border-[#233544]">
                        <p className="text-[10px] text-[#00E5FF] uppercase tracking-wider mb-2 flex items-center gap-1">
                          <span className="material-icons-outlined text-xs">vpn_key</span> SNMP
                        </p>
                        <PduSnmpSettingsForm
                          compact
                          value={batchTemplate.snmp}
                          onChange={snmp => setBatchTemplate(p => ({ ...p, snmp }))}
                        />
                        <p className="text-[9px] text-slate-500 mt-2 leading-relaxed">
                          Daisy slaves have no SNMP agent of their own. This write goes to each chain master;
                          PDUMind stores the same community on every slave and polls them on the master
                          (<span className="font-mono">.3.2 / .3.3 / .3.4</span>).
                        </p>
                      </div>
                      {/* NTP */}
                      <div className="p-3 rounded-lg bg-[#0B1120] border border-[#233544]">
                        <p className="text-[10px] text-[#00E5FF] uppercase tracking-wider mb-2 flex items-center gap-1">
                          <span className="material-icons-outlined text-xs">schedule</span> Time &amp; SNTP
                        </p>
                        <PduNtpSettingsForm
                          compact
                          value={batchTemplate.ntp}
                          onChange={ntp => setBatchTemplate(p => ({ ...p, ntp }))}
                        />
                      </div>
                      {/* Web Access */}
                      <div className="p-3 rounded-lg bg-[#0B1120] border border-[#233544]">
                        <p className="text-[10px] text-[#00E5FF] uppercase tracking-wider mb-2 flex items-center gap-1">
                          <span className="material-icons-outlined text-xs">lock</span> Web Access
                        </p>
                        <PduWebAccessSettingsForm
                          compact
                          value={batchTemplate.web_access}
                          onChange={web_access => setBatchTemplate(p => ({ ...p, web_access }))}
                        />
                      </div>
                      {/* Preview button */}
                      <button onClick={openBatchPreview} disabled={loading || batchSelected.size === 0}
                        className="w-full py-3 bg-emerald-500/20 border border-emerald-500/50 text-emerald-400 rounded-lg text-sm font-bold hover:bg-emerald-500/30 disabled:opacity-50 flex items-center justify-center gap-2">
                        <span className="material-icons-outlined text-sm">visibility</span>
                        Preview &amp; Commission {batchSelected.size} PDUs
                      </button>
                    </div>
                  )}

                  {/* Batch Deploy Progress */}
                  {batchStep === 2 && batchProgress && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-bold text-white">Deploying...</h4>
                        <span className="text-xs text-slate-400 font-mono">{batchProgress.completed}/{batchProgress.total}</span>
                      </div>
                      <div className="w-full h-2 bg-[#0B1120] rounded-full overflow-hidden">
                        <div className="h-full bg-[#00E5FF] transition-all rounded-full"
                          style={{ width: `${(batchProgress.completed / batchProgress.total) * 100}%` }} />
                      </div>
                      <div className="max-h-48 overflow-y-auto space-y-1">
                        {Object.entries(batchProgress.results || {}).map(([key, r]) => (
                          <div key={key} className={`p-2 rounded text-xs flex items-center gap-2 ${
                            r.step === 'done' ? 'bg-emerald-500/10 text-emerald-400' :
                            r.step === 'error' || r.step === 'reboot_timeout' || r.step === 'snmp_failed' ? 'bg-red-500/10 text-red-400' :
                            'bg-amber-500/10 text-amber-300'
                          }`}>
                            <span className="material-icons-outlined text-sm">
                              {r.step === 'done' ? 'check_circle' : r.step === 'error' || r.step === 'reboot_timeout' || r.step === 'snmp_failed' ? 'error' : 'sync'}
                            </span>
                            <span className="font-mono">{r.ip}</span>
                            {r.new_ip && r.new_ip !== r.ip && <span className="text-slate-500">→ {r.new_ip}</span>}
                            <span className="text-slate-500">{r.step}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Batch Report */}
                  {batchStep === 3 && batchProgress && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center">
                          <span className="material-icons-outlined text-emerald-400 text-2xl">task_alt</span>
                        </div>
                        <div>
                          <h4 className="text-sm font-bold text-white">Batch Commissioning Complete</h4>
                          <p className="text-xs text-slate-400">
                            {Object.values(batchProgress.results || {}).filter(r => r.success).length} succeeded,
                            {' '}{Object.values(batchProgress.results || {}).filter(r => !r.success).length} failed
                            {' '}of {batchProgress.total} PDUs
                          </p>
                        </div>
                      </div>
                      <div className="max-h-60 overflow-y-auto space-y-1.5">
                        {Object.entries(batchProgress.results || {}).map(([key, r]) => (
                          <div key={key} className={`p-3 rounded-lg border ${
                            r.success ? 'bg-emerald-500/5 border-emerald-500/30' : 'bg-red-500/5 border-red-500/30'
                          }`}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className={`material-icons-outlined text-sm ${r.success ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {r.success ? 'check_circle' : 'error'}
                                </span>
                                <span className="font-mono text-white text-xs">{r.ip}</span>
                                {r.new_ip && r.new_ip !== r.ip && (
                                  <span className="text-slate-500 text-xs">→ <span className="text-[#00E5FF] font-mono">{r.new_ip}</span></span>
                                )}
                                {r.mac && <span className="text-[10px] text-slate-600 font-mono">{r.mac}</span>}
                              </div>
                            </div>
                            {r.error && <p className="text-[10px] text-red-400 mt-1">{r.error}</p>}
                            {r.sections && Object.keys(r.sections).length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1.5">
                                {Object.entries(r.sections).map(([sec, res]) => (
                                  <span key={sec} title={res.error || ''} className={`text-[9px] px-1.5 py-0.5 rounded ${
                                    res.success ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                                  }`}>{sec}{res.success ? '' : ' ✗'}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => { setBatchStep(0); setBatchDevices([]); setBatchSelected(new Set()); setBatchJobId(null); setBatchProgress(null); }}
                          className="flex-1 py-2.5 bg-[#0B1120] border border-[#233544] text-slate-400 rounded-lg text-sm hover:text-white">
                          Start New Batch
                        </button>
                        <button onClick={() => { fetchBatchRacks(); setBatchStep(4); }}
                          className="flex-1 py-2.5 bg-[#00E5FF]/20 border border-[#00E5FF]/50 text-[#00E5FF] rounded-lg text-sm font-bold hover:bg-[#00E5FF]/30 flex items-center justify-center gap-2">
                          <span className="material-icons-outlined text-sm">view_in_ar</span>
                          Assign to Racks
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Batch Rack Assignment — same pattern as single commissioning step 2 */}
                  {batchStep === 4 && batchProgress && (() => {
                    const successPdus = Object.entries(batchProgress.results || {}).filter(([, r]) => r.success);
                    const activePduKey = dragPdu || successPdus.find(([k]) => !batchRackMap[k])?.[0] || null;
                    return (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-bold text-white flex items-center gap-2">
                          <span className="material-icons-outlined text-[#00E5FF] text-sm">view_in_ar</span>
                          Assign PDUs to Racks
                        </h4>
                        <button onClick={() => setBatchStep(3)} className="text-[10px] text-slate-400 hover:text-white flex items-center gap-0.5">
                          <span className="material-icons-outlined text-xs">arrow_back</span> Back to report
                        </button>
                      </div>
                      <p className="text-[10px] text-slate-500">
                        Select a PDU, then click a rack slot to assign. Click the <span className="text-red-400">X</span> to unassign.
                      </p>

                      {/* PDU list — click to select which one to place */}
                      <div>
                        <p className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">
                          Commissioned PDUs ({successPdus.length})
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {successPdus.map(([key, r]) => {
                            const assigned = batchRackMap[key];
                            const isActive = dragPdu === key;
                            return (
                              <button key={key}
                                onClick={() => setDragPdu(isActive ? null : key)}
                                className={`px-2.5 py-1.5 rounded-lg border text-left transition-all flex items-center gap-1.5 ${
                                  isActive
                                    ? 'bg-[#00E5FF]/15 border-[#00E5FF]/60 ring-1 ring-[#00E5FF]/30'
                                    : assigned
                                      ? 'bg-emerald-500/10 border-emerald-500/30'
                                      : 'bg-[#0B1120] border-[#233544] hover:border-slate-500'
                                }`}>
                                <span className="font-mono text-white text-[11px]">{r.new_ip || r.ip}</span>
                                {assigned && (
                                  <>
                                    <span className="text-[9px] text-emerald-400">→ {assigned.rack_code}/{assigned.slot}</span>
                                    <span onClick={(e) => { e.stopPropagation(); setBatchRackMap(p => { const n = { ...p }; delete n[key]; return n; }); }}
                                      className="text-slate-600 hover:text-red-400 cursor-pointer ml-0.5">
                                      <span className="material-icons-outlined" style={{ fontSize: '11px' }}>close</span>
                                    </span>
                                  </>
                                )}
                                {!assigned && !isActive && (
                                  <span className="text-[9px] text-slate-600">unassigned</span>
                                )}
                                {isActive && !assigned && (
                                  <span className="text-[9px] text-[#00E5FF] animate-pulse">selecting…</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Rack grid — same layout as single commissioning */}
                      <div>
                        <p className="text-[9px] text-slate-500 uppercase tracking-wider mb-2">
                          Available Racks ({batchRacks.length})
                        </p>
                        {batchRacks.length === 0 ? (
                          <div className="text-center py-6 text-slate-500">
                            <span className="material-icons-outlined text-3xl opacity-50 mb-2 block">view_in_ar</span>
                            <p className="text-sm">No racks with open slots</p>
                            <p className="text-xs mt-1">Save a hall layout in the Data Hall Designer first.</p>
                          </div>
                        ) : (
                          <div className="grid grid-cols-4 gap-2 max-h-[300px] overflow-y-auto pr-1">
                            {batchRacks.map(rack => {
                              const slotsUsedByBatch = Object.entries(batchRackMap)
                                .filter(([, v]) => v.rack_id === rack.rack_id)
                                .map(([pduKey, v]) => ({ pduKey, slot: v.slot }));
                              const takenSlots = slotsUsedByBatch.map(s => s.slot);

                              return (
                                <div key={rack.rack_code} className={`p-3 rounded-lg border text-left transition-all min-w-0 overflow-hidden ${
                                  slotsUsedByBatch.length > 0
                                    ? 'bg-emerald-500/5 border-emerald-500/30'
                                    : 'bg-[#0B1120] border-[#233544]'
                                }`}>
                                  <p className="text-xs font-mono font-bold text-white truncate">{rack.rack_code}</p>
                                  <p className="text-[10px] text-slate-500 mt-0.5">
                                    Row {rack.row_index + 1}, Pos {rack.position_index + 1}
                                  </p>

                                  {/* Slot buttons — show both mount positions (A/B or Left/Right) */}
                                  <div className="flex flex-col gap-1.5 mt-2 min-w-0">
                                    {(() => {
                                      const open = rack.open_slots || [];
                                      const isLeftRight = open.some(s => s === 'Left' || s === 'Right')
                                        || takenSlots.some(s => s === 'Left' || s === 'Right');
                                      const slotOrder = isLeftRight ? ['Left', 'Right'] : ['A', 'B'];
                                      return slotOrder.slice(0, rack.total_slots || 2);
                                    })().map(slot => {
                                      const isOpen = (rack.open_slots || []).includes(slot);
                                      if (!isOpen && !slotsUsedByBatch.find(s => s.slot === slot)) return null;
                                      const usedBy = slotsUsedByBatch.find(s => s.slot === slot);
                                      const pduResult = usedBy ? batchProgress.results[usedBy.pduKey] : null;
                                      const ip = pduResult?.new_ip || pduResult?.ip || '';

                                      if (usedBy) {
                                        return (
                                          <div key={slot}
                                            className="w-full min-w-0 rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-1">
                                            <div className="flex items-center justify-between gap-1 min-w-0">
                                              <span className="text-[9px] font-bold text-emerald-300 shrink-0">{slot}</span>
                                              <button type="button"
                                                title="Unassign"
                                                onClick={() => setBatchRackMap(p => { const n = { ...p }; delete n[usedBy.pduKey]; return n; })}
                                                className="shrink-0 w-4 h-4 flex items-center justify-center rounded hover:bg-red-500/20 text-slate-400 hover:text-red-400">
                                                <span className="material-icons-outlined" style={{ fontSize: '12px' }}>close</span>
                                              </button>
                                            </div>
                                            <p className="text-[8px] font-mono text-emerald-200 truncate" title={ip}>{ip}</p>
                                          </div>
                                        );
                                      }

                                      return (
                                        <button key={slot} type="button"
                                          disabled={!dragPdu || !!batchRackMap[dragPdu]}
                                          onClick={() => {
                                            if (dragPdu && !batchRackMap[dragPdu]) {
                                              setBatchRackMap(p => ({ ...p, [dragPdu]: { rack_id: rack.rack_id, rack_code: rack.rack_code, slot } }));
                                              setDragPdu(null);
                                            }
                                          }}
                                          className={`w-full px-1.5 py-1.5 rounded text-[9px] font-mono transition-all ${
                                            dragPdu && !batchRackMap[dragPdu]
                                              ? 'bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/50 cursor-pointer hover:bg-[#00E5FF]/30'
                                              : 'bg-[#161E2E] text-slate-500 border border-[#233544]'
                                          }`}>
                                          <span className="font-bold text-[10px]">Pos {slot}</span>
                                          <span className="block text-[8px] opacity-80">empty — click to assign</span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                  <p className="text-[9px] text-slate-600 mt-1">
                                    {rack.occupied + takenSlots.length}/{rack.total_slots} filled
                                  </p>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2">
                        <button onClick={() => { setBatchStep(0); setBatchDevices([]); setBatchSelected(new Set()); setBatchJobId(null); setBatchProgress(null); setBatchRackMap({}); setDragPdu(null); }}
                          className="flex-1 py-2.5 bg-[#0B1120] border border-[#233544] text-slate-400 rounded-lg text-sm hover:text-white">
                          Skip
                        </button>
                        <button onClick={saveBatchRackAssignments}
                          disabled={loading || Object.keys(batchRackMap).length === 0}
                          className="flex-1 py-2.5 bg-emerald-500/20 border border-emerald-500/50 text-emerald-400 rounded-lg text-sm font-bold hover:bg-emerald-500/30 disabled:opacity-30 flex items-center justify-center gap-2">
                          {loading ? <span className="material-icons-outlined text-sm animate-spin">sync</span> :
                            <span className="material-icons-outlined text-sm">save</span>}
                          Save Assignments ({Object.keys(batchRackMap).length})
                        </button>
                      </div>
                    </div>
                    );
                  })()}
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
                    {detectedDevice.web_admin_port && (
                      <span className="px-2 py-0.5 rounded-full bg-cyan-500/20 border border-cyan-500/40 text-[10px] text-cyan-300 whitespace-nowrap">
                        Web Admin :{detectedDevice.web_admin_port}
                      </span>
                    )}
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

                    {/* DHCP / Static toggle */}
                    <div className="mb-3 p-3 rounded-lg bg-[#161E2E] border border-[#233544]">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="material-icons-outlined text-sm text-slate-400">settings_ethernet</span>
                          <span className="text-xs text-slate-300">IP Assignment</span>
                        </div>
                        <div className="flex rounded-lg overflow-hidden border border-[#233544]">
                          <button
                            onClick={() => setEditNetwork(prev => ({ ...prev, dhcp: 'OFF' }))}
                            className={`px-3 py-1 text-[10px] font-bold transition-all ${
                              editNetwork.dhcp !== 'ON'
                                ? 'bg-[#00E5FF]/20 text-[#00E5FF] border-r border-[#00E5FF]/30'
                                : 'bg-[#0B1120] text-slate-500 border-r border-[#233544] hover:text-slate-300'
                            }`}
                          >STATIC IP</button>
                          <button
                            onClick={() => setEditNetwork(prev => ({ ...prev, dhcp: 'ON' }))}
                            className={`px-3 py-1 text-[10px] font-bold transition-all ${
                              editNetwork.dhcp === 'ON'
                                ? 'bg-amber-500/20 text-amber-400'
                                : 'bg-[#0B1120] text-slate-500 hover:text-slate-300'
                            }`}
                          >DHCP</button>
                        </div>
                      </div>
                      {editNetwork.dhcp === 'ON' && (
                        <p className="text-[10px] text-amber-400 mt-2 flex items-center gap-1">
                          <span className="material-icons-outlined text-xs">warning</span>
                          DHCP is active — the PDU will get its IP from a DHCP server. Switch to Static to assign a fixed IP.
                        </p>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[9px] text-slate-500 uppercase">IP Address</label>
                        <input type="text" value={editNetwork.ip || ''}
                          onChange={e => setEditNetwork(prev => ({ ...prev, ip: e.target.value }))}
                          disabled={editNetwork.dhcp === 'ON'}
                          className={`w-full bg-[#161E2E] border rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none ${
                            ipConflict ? 'border-red-500/60 focus:border-red-500' : 'border-[#233544] focus:border-[#00E5FF]'
                          } ${editNetwork.dhcp === 'ON' ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                            disabled={editNetwork.dhcp === 'ON'}
                            className={`w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF] ${editNetwork.dhcp === 'ON' ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                    <PduSnmpSettingsForm value={editSnmp} onChange={setEditSnmp} />
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
                    <PduNtpSettingsForm value={editTime} onChange={setEditTime} showManualTime />
                  </div>

                  {/* Web Access */}
                  <div className="p-4 rounded-xl bg-[#0B1120] border border-[#233544]">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-bold text-[#00E5FF] uppercase tracking-wider flex items-center gap-1.5">
                        <span className="material-icons-outlined text-sm">lock</span> Web Access
                      </p>
                      <button onClick={applyWebAccessSettings} disabled={loading}
                        className="px-3 py-1 bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 rounded text-[10px] hover:bg-emerald-500/30 disabled:opacity-50 transition-all">
                        {loading ? 'Applying...' : 'Apply & Reboot'}
                      </button>
                    </div>
                    <PduWebAccessSettingsForm value={editWebAccess} onChange={setEditWebAccess} />
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
                  <SummaryRow label="Web Admin" value={`${remoteHost}:${remotePort}`} icon="cloud" />
                )}
                {detectedDevice?.web_admin_port && (
                  <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-xs text-cyan-300 flex items-center gap-2">
                    <span className="material-icons-outlined text-sm">auto_fix_high</span>
                    <span>Web admin auto-detected on port {detectedDevice.web_admin_port} — IP changes will be applied directly to the device</span>
                  </div>
                )}
                <SummaryRow label="Detected IP" value={detectedDevice?.ip || 'N/A'} icon="wifi_find" />
                <SummaryRow label="Production IP" value={isRemoteMode ? (editNetwork.ip || remoteHost) : finalIp} icon="lan" highlight />
                <SummaryRow label="Label" value={pduLabel || `PDU-${isRemoteMode ? (editNetwork.ip || remoteHost) : finalIp}`} icon="label" />
                <SummaryRow label="Rack" value={selectedRack?.rack_code || 'Unassigned'} icon="view_in_ar" />
                <SummaryRow label="Mount Position" value={selectedSlot || 'A'} icon="height" />
                <SummaryRow label="SNMP Version" value={detectedDevice?.snmp_version || '2c'} icon="swap_vert" />
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

        {/* Footer Navigation (hidden in batch mode) */}
        {scanMode !== 'batch' && <div className="p-5 border-t border-[#233544] flex items-center justify-between bg-[#0a1222]">
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
        </div>}
      </div>
    </div>

    {/* Batch Commission Preview & Confirmation overlay */}
    {batchPreviewOpen && (
      <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[60] flex items-center justify-center p-4">
        <div className="bg-[#0B1120] border border-[#233544] rounded-xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-[#233544]">
            <div>
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <span className="material-icons-outlined text-emerald-400">fact_check</span>
                Review Batch Plan
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                {batchSelected.size} PDU{batchSelected.size === 1 ? '' : 's'} will be configured with the following resolved hostnames and settings. Drag rows to reorder.
              </p>
            </div>
            <button onClick={() => setBatchPreviewOpen(false)}
              className="text-slate-400 hover:text-white p-1 rounded transition-colors">
              <span className="material-icons-outlined">close</span>
            </button>
          </div>

          {/* Toolbar */}
          <div className="px-4 py-2 border-b border-[#1a2638] flex items-center gap-3 text-[11px]">
            <label className="flex items-center gap-1.5 cursor-pointer text-slate-300 hover:text-white">
              <input type="checkbox" checked={batchSortByIp}
                onChange={e => {
                  setBatchSortByIp(e.target.checked);
                  if (e.target.checked) {
                    const sorted = [...getOrderedBatchPdus()].sort((a, b) => compareIp(a.ip, b.ip));
                    setBatchOrder(sorted.map(d => d.ip));
                  }
                }}
                className="accent-[#00E5FF]" />
              Sort by IP
            </label>
            <button
              onClick={() => {
                const sorted = [...batchDevices.filter(d => batchSelected.has(d.ip))].sort((a, b) => compareIp(a.ip, b.ip));
                setBatchOrder(sorted.map(d => d.ip));
                setBatchSortByIp(true);
              }}
              className="text-[#00E5FF] hover:text-[#00E5FF]/80 flex items-center gap-1">
              <span className="material-icons-outlined text-xs">refresh</span>
              Reset Order
            </button>
            <div className="ml-auto text-slate-500">
              Hostnames are resolved using <span className="font-mono text-[#00E5FF]">{batchTemplate.system?.router_hostname || '(empty)'}</span>
            </div>
          </div>

          {/* Preview table */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#0a1222] border-b border-[#233544] text-slate-400 uppercase text-[9px] tracking-wider">
                <tr>
                  <th className="px-3 py-2 text-left w-10">#</th>
                  <th className="px-3 py-2 text-center w-16">Move</th>
                  <th className="px-3 py-2 text-left">IP Address</th>
                  <th className="px-3 py-2 text-left">Chain</th>
                  <th className="px-3 py-2 text-left">Hostname</th>
                  <th className="px-3 py-2 text-left">Device Name</th>
                  <th className="px-3 py-2 text-left">MAC</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const rows = buildBatchPreviewRows();
                  if (rows.length === 0) {
                    return (
                      <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-500">No PDUs selected.</td></tr>
                    );
                  }
                  return rows.map((row, i) => (
                    <tr key={row.currentIp} className="border-b border-[#1a2638] hover:bg-[#0F1A2E] transition-colors">
                      <td className="px-3 py-2 text-slate-500 font-mono">{i + 1}</td>
                      <td className="px-3 py-2 text-center">
                        <div className="inline-flex gap-0.5">
                          <button
                            disabled={i === 0}
                            onClick={() => moveBatchRow(i, i - 1)}
                            className="p-0.5 text-slate-500 hover:text-[#00E5FF] disabled:opacity-20 disabled:hover:text-slate-500"
                            title="Move up">
                            <span className="material-icons-outlined text-xs">arrow_upward</span>
                          </button>
                          <button
                            disabled={i === rows.length - 1}
                            onClick={() => moveBatchRow(i, i + 1)}
                            className="p-0.5 text-slate-500 hover:text-[#00E5FF] disabled:opacity-20 disabled:hover:text-slate-500"
                            title="Move down">
                            <span className="material-icons-outlined text-xs">arrow_downward</span>
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono">
                        <span className="text-white">{row.assignedIp}</span>
                        {row.assignedIp !== row.currentIp && (
                          <span className="ml-2 text-[10px] text-amber-300">
                            was {row.currentIp}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row.chainRole === 'slave' ? (
                          <span className="text-[10px] text-violet-300">Daisy via {row.masterIp}</span>
                        ) : row.chainRole === 'master' ? (
                          <span className="text-[10px] text-[#00E5FF]">Master</span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-emerald-300">{row.hostname || <span className="text-slate-600">(empty)</span>}</td>
                      <td className="px-3 py-2 font-mono text-cyan-300">{row.deviceName || <span className="text-slate-600">(empty)</span>}</td>
                      <td className="px-3 py-2 font-mono text-slate-400">{row.mac || <span className="text-slate-600">—</span>}</td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>

          {/* Settings summary */}
          <div className="px-4 py-3 border-t border-[#233544] bg-[#0a1222]">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Other settings applied to all PDUs</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
              <div className="p-2 rounded bg-[#0B1120] border border-[#1a2638]">
                <p className="text-slate-500 text-[9px] uppercase">Network IPs</p>
                <p className={`font-mono ${batchTemplate.network?.ip_start ? 'text-amber-300' : 'text-emerald-300'}`}>
                  {batchTemplate.network?.ip_start
                    ? `Static, from ${batchTemplate.network.ip_start}`
                    : 'Kept as-is (no reboot)'}
                </p>
              </div>
              <div className="p-2 rounded bg-[#0B1120] border border-[#1a2638]">
                <p className="text-slate-500 text-[9px] uppercase">SNMP</p>
                <p className="font-mono text-white truncate">
                  R:{batchTemplate.snmp?.read_community || '—'} / W:{batchTemplate.snmp?.write_community || '—'}
                </p>
              </div>
              <div className="p-2 rounded bg-[#0B1120] border border-[#1a2638]">
                <p className="text-slate-500 text-[9px] uppercase">NTP</p>
                <p className="font-mono text-white truncate">
                  {combineSntpServers(batchTemplate.ntp?.sntp_server, batchTemplate.ntp?.sntp_server2) || '—'}
                </p>
              </div>
              <div className="p-2 rounded bg-[#0B1120] border border-[#1a2638]">
                <p className="text-slate-500 text-[9px] uppercase">Web Access</p>
                <p className="font-mono text-white">
                  {String(batchTemplate.web_access?.https_http) === '1'
                    ? `HTTPS :${batchTemplate.web_access?.https_port || '443'} (reboot)`
                    : `HTTP :${batchTemplate.web_access?.http_port || '80'}`}
                </p>
              </div>
              <div className="p-2 rounded bg-[#0B1120] border border-[#1a2638]">
                <p className="text-slate-500 text-[9px] uppercase">PDU Login</p>
                <p className="font-mono text-white text-[11px]">
                  {batchTemplate.users?.admin_username &&
                   batchTemplate.users.admin_username !== batchTemplate.current_credentials?.username
                    ? `${batchTemplate.current_credentials?.username || 'admin'} → ${batchTemplate.users.admin_username}`
                    : batchTemplate.current_credentials?.username || 'admin'}
                  {' · '}
                  {batchTemplate.users?.admin_password ? 'password will change' : 'password unchanged'}
                </p>
              </div>
            </div>
          </div>

          {/* Footer actions */}
          <div className="flex items-center justify-between p-4 border-t border-[#233544]">
            <button onClick={() => setBatchPreviewOpen(false)}
              className="px-4 py-2 text-slate-300 hover:text-white text-sm flex items-center gap-1.5">
              <span className="material-icons-outlined text-sm">arrow_back</span>
              Back to Template
            </button>
            <button onClick={batchDeploy} disabled={loading || batchSelected.size === 0}
              className="px-5 py-2.5 bg-emerald-500/20 border border-emerald-500/50 hover:bg-emerald-500/30 disabled:opacity-50 text-emerald-300 rounded-lg font-bold text-sm flex items-center gap-2 transition-all">
              <span className="material-icons-outlined text-sm">rocket_launch</span>
              Confirm &amp; Commission {batchSelected.size} PDU{batchSelected.size === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
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
