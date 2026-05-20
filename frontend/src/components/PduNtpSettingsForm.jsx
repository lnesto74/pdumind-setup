import React from 'react';
import {
  PDU_TIMEZONES,
  SNTP_CORRECTIONS,
} from '../constants/pduSettings';

const fieldClass =
  'w-full bg-[#161E2E] border border-[#233544] rounded px-2 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[#00E5FF]';

/**
 * Time / SNTP settings form matching sys_time.html.
 * Supports two redundant NTP server fields (combined into SNTPStatu_Server on apply).
 */
export default function PduNtpSettingsForm({ value, onChange, showManualTime = false, compact = false }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });

  return (
    <div className="space-y-3">
      {showManualTime && (
        <div className="grid grid-cols-3 gap-2">
          {[
            { key: 'year', label: 'Year' }, { key: 'month', label: 'Month' }, { key: 'day', label: 'Day' },
            { key: 'hour', label: 'Hour' }, { key: 'minute', label: 'Min' }, { key: 'second', label: 'Sec' },
          ].map(f => (
            <div key={f.key}>
              <label className="text-[9px] text-slate-500 uppercase">{f.label}</label>
              <input type="text" value={v[f.key] || ''}
                onChange={e => set({ [f.key]: e.target.value })}
                className={fieldClass} />
            </div>
          ))}
        </div>
      )}

      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox"
          checked={v.sntp_enabled === true || v.sntp_enabled === 'true'}
          onChange={e => set({ sntp_enabled: e.target.checked })}
          className="accent-[#00E5FF]" />
        <span className="text-[11px] text-slate-300">SNTP Enable</span>
      </label>

      <div className={`grid ${compact ? 'grid-cols-1' : 'grid-cols-2'} gap-2`}>
        <div>
          <label className="text-[9px] text-slate-500 uppercase">SNTP Server (primary)</label>
          <input type="text" value={v.sntp_server || ''} placeholder="pool.ntp.org"
            onChange={e => set({ sntp_server: e.target.value })}
            className={fieldClass} />
        </div>
        <div>
          <label className="text-[9px] text-slate-500 uppercase">SNTP Server (secondary)</label>
          <input type="text" value={v.sntp_server2 || ''} placeholder="time.google.com (optional redundancy)"
            onChange={e => set({ sntp_server2: e.target.value })}
            className={fieldClass} />
        </div>
        <p className={`text-[9px] text-slate-600 ${compact ? '' : 'col-span-2'}`}>
          Both servers are sent to the PDU as a comma-separated list in the single SNTP Server field.
        </p>
        <div className={compact ? '' : 'col-span-2'}>
          <label className="text-[9px] text-slate-500 uppercase">SNTP Time Zone</label>
          <select value={String(v.timezone ?? '79')}
            onChange={e => set({ timezone: e.target.value })}
            className={fieldClass}>
            {PDU_TIMEZONES.map(tz => (
              <option key={tz.value} value={tz.value}>{tz.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[9px] text-slate-500 uppercase">SNTP Update Interval (hours)</label>
          <input type="number" min="1" max="743" value={v.update_interval || '24'}
            onChange={e => set({ update_interval: e.target.value })}
            className={fieldClass} />
        </div>
        <div>
          <label className="text-[9px] text-slate-500 uppercase">SNTP Correction</label>
          <select value={String(v.correction ?? '0')}
            onChange={e => set({ correction: e.target.value })}
            className={fieldClass}>
            {SNTP_CORRECTIONS.map(c => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
