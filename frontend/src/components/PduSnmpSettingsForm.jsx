import React from 'react';
import PasswordInput from './PasswordInput';

const fieldClass =
  'w-full bg-px-panel border border-px-stroke rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-px-accent';
const pwFieldClass = `${fieldClass} pr-9`;

/**
 * SNMP settings form matching sys_snmp.html (V1/V2c/V3, communities, v3 creds, trap).
 * `value` keys match the batch template / backend set_snmp() kwargs.
 */
export default function PduSnmpSettingsForm({ value, onChange, compact = false }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });

  return (
    <div className={`space-y-3 ${compact ? '' : ''}`}>
      {/* Exclusive mode — same dropdown as NPDU /snmp.html (0/1/2). */}
      <div>
        <label className="text-[9px] text-slate-500 uppercase block mb-1.5">SNMP Mode</label>
        <select
          value={v.snmpv3 ? '2' : ((v.snmpv1 || v.snmpv2) ? '1' : '0')}
          onChange={e => {
            const mode = e.target.value;
            set({
              snmpv1: mode === '1',
              snmpv2: mode === '1',
              snmpv3: mode === '2',
            });
          }}
          className={fieldClass}
        >
          <option value="0">Disable</option>
          <option value="1">SNMP V1/V2c</option>
          <option value="2">SNMP V3</option>
        </select>
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

      {/* NPDU snmp.html has no auth/priv protocol pickers — firmware is MD5+DES. */}
      {v.snmpv3 && (
        <div className="p-2 rounded-lg bg-px-panel border border-px-stroke space-y-2">
          <p className="text-[9px] text-amber-400 uppercase tracking-wider">SNMPv3 (MD5 + DES only)</p>
          <p className="text-[10px] text-slate-400">
            SHA / SHA-512 / AES / AES-256 are not on this firmware. Customer NMS must use MD5 + DES.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[9px] text-slate-500 uppercase">SNMP V3 Account</label>
              <input type="text" value={v.snmpv3_username || ''}
                onChange={e => set({ snmpv3_username: e.target.value })}
                className={fieldClass} />
            </div>
            <div>
              <label className="text-[9px] text-slate-500 uppercase">Auth / Privacy (fixed)</label>
              <input type="text" value="MD5 + DES" readOnly className={`${fieldClass} opacity-70`} />
            </div>
            <div>
              <label className="text-[9px] text-slate-500 uppercase">SNMP V3 Password</label>
              <PasswordInput
                value={v.auth_key || ''}
                placeholder="8–16 chars (10 kept after reboot)"
                onChange={e => set({ auth_key: e.target.value })}
                inputClassName={pwFieldClass}
              />
            </div>
            <div>
              <label className="text-[9px] text-slate-500 uppercase">SNMP V3 Private key</label>
              <PasswordInput
                value={v.priv_key || ''}
                placeholder="8–16 chars (10 kept after reboot)"
                onChange={e => set({ priv_key: e.target.value })}
                inputClassName={pwFieldClass}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
