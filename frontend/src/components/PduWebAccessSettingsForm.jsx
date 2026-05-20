import React from 'react';
import { WEB_ACCESS_MODES } from '../constants/pduSettings';

const fieldClass =
  'w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]';

/**
 * Web access settings matching sys_http.html (HTTP/HTTPS select + ports).
 */
export default function PduWebAccessSettingsForm({ value, onChange, compact = false }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  const isHttps = String(v.https_http || '0') === '1';

  return (
    <div className={`space-y-3 ${compact ? '' : ''}`}>
      <div>
        <label className="text-[9px] text-slate-500 uppercase block mb-1.5">HTTP/HTTPS Select</label>
        <select
          value={v.https_http ?? '0'}
          onChange={e => set({ https_http: e.target.value })}
          className={fieldClass}
        >
          {WEB_ACCESS_MODES.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {!isHttps ? (
        <div>
          <label className="text-[9px] text-slate-500 uppercase">HTTP Port</label>
          <input
            type="number"
            min="1"
            max="65535"
            value={v.http_port ?? '80'}
            onChange={e => set({ http_port: e.target.value })}
            className={fieldClass}
          />
        </div>
      ) : (
        <div>
          <label className="text-[9px] text-slate-500 uppercase">HTTPS Port</label>
          <input
            type="number"
            min="1"
            max="65535"
            value={v.https_port ?? '443'}
            onChange={e => set({ https_port: e.target.value })}
            className={fieldClass}
          />
        </div>
      )}

      {isHttps && (
        <p className="text-[10px] text-amber-300/90 leading-relaxed">
          HTTPS uses the PDU default self-signed certificate. PDUMind will switch to HTTPS
          automatically after apply and reboot. SNMP telemetry is unaffected.
        </p>
      )}
    </div>
  );
}
