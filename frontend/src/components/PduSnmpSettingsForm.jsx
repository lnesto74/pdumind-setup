import React from 'react';
import {
  SNMP_AUTH_PROTOCOLS,
  SNMP_PRIV_PROTOCOLS,
} from '../constants/pduSettings';

const fieldClass =
  'w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]';

/**
 * SNMP settings form matching sys_snmp.html (V1/V2c/V3, communities, v3 creds, trap).
 * `value` keys match the batch template / backend set_snmp() kwargs.
 */
export default function PduSnmpSettingsForm({ value, onChange, compact = false }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });

  return (
    <div className={`space-y-3 ${compact ? '' : ''}`}>
      {/* Version toggles — same as PDU web admin */}
      <div>
        <label className="text-[9px] text-slate-500 uppercase block mb-1.5">Version</label>
        <div className="flex flex-wrap gap-4">
          {[
            { key: 'snmpv1', label: 'V1' },
            { key: 'snmpv2', label: 'V2c' },
            { key: 'snmpv3', label: 'V3' },
          ].map(({ key, label }) => (
            <label key={key} className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={!!v[key]}
                onChange={e => set({ [key]: e.target.checked })}
                className="accent-[#00E5FF]"
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[9px] text-slate-500 uppercase">Read Community</label>
          <input type="text" value={v.read_community ?? v.community_read ?? ''}
            onChange={e => set({ read_community: e.target.value, community_read: e.target.value })}
            className={fieldClass} maxLength={20} />
        </div>
        <div>
          <label className="text-[9px] text-slate-500 uppercase">Write Community</label>
          <input type="text" value={v.write_community ?? v.community_write ?? ''}
            onChange={e => set({ write_community: e.target.value, community_write: e.target.value })}
            className={fieldClass} maxLength={20} />
        </div>
        <div className="col-span-2">
          <label className="text-[9px] text-slate-500 uppercase">Trap Proxy Server</label>
          <input type="text" value={v.trap_ip || ''} placeholder="Leave blank if unused"
            onChange={e => set({ trap_ip: e.target.value })}
            className={fieldClass} />
        </div>
      </div>

      {/* SNMPv3 section — visible when V3 enabled (matches snmphide() on PDU) */}
      {v.snmpv3 && (
        <div className="p-2 rounded-lg bg-[#161E2E] border border-[#233544] space-y-2">
          <p className="text-[9px] text-amber-400 uppercase tracking-wider">SNMPv3</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[9px] text-slate-500 uppercase">SNMPv3 User Name</label>
              <input type="text" value={v.snmpv3_username || ''}
                onChange={e => set({ snmpv3_username: e.target.value })}
                className={fieldClass} />
            </div>
            <div>
              <label className="text-[9px] text-slate-500 uppercase">Authentication Protocol</label>
              <select value={v.verify_protocol ?? '2'}
                onChange={e => set({ verify_protocol: e.target.value })}
                className={fieldClass}>
                {SNMP_AUTH_PROTOCOLS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[9px] text-slate-500 uppercase">Authentication Key</label>
              <input type="password" value={v.auth_key || ''} placeholder="Min 8 chars if V3 enabled"
                onChange={e => set({ auth_key: e.target.value })}
                className={fieldClass} />
            </div>
            <div>
              <label className="text-[9px] text-slate-500 uppercase">Private Protocol</label>
              <select value={v.encrypt_protocol ?? '0'}
                onChange={e => set({ encrypt_protocol: e.target.value })}
                className={fieldClass}>
                {SNMP_PRIV_PROTOCOLS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="text-[9px] text-slate-500 uppercase">Private Key</label>
              <input type="password" value={v.priv_key || ''} placeholder="Min 8 chars if encryption enabled"
                onChange={e => set({ priv_key: e.target.value })}
                className={fieldClass} />
            </div>
          </div>
          <p className="text-[9px] text-slate-600">
            Note: the PDU web UI requires auth/private keys of at least 8 characters when SNMPv3 is enabled.
          </p>
        </div>
      )}
    </div>
  );
}
