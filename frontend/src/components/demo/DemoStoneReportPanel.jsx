import React, { useCallback, useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

function authHeaders() {
  const token = localStorage.getItem('pdumind_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const STATUS_STYLE = {
  ALARM_DETECTED: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  ASSIGNED_PRIMARY: 'text-sky-400 bg-sky-500/10 border-sky-500/30',
  NOTIFY_TELEGRAM: 'text-sky-400 bg-sky-500/10 border-sky-500/30',
  REMINDER_SENT: 'text-orange-400 bg-orange-500/10 border-orange-500/30',
  ESCALATED_LEAD: 'text-red-400 bg-red-500/10 border-red-500/30',
  ESCALATED_SECONDARY: 'text-red-400 bg-red-500/10 border-red-500/30',
  ESCALATED_ADMIN: 'text-red-400 bg-red-500/10 border-red-500/30',
  LINK_OPENED: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
  ACK_DISPATCH: 'text-[#00E5FF] bg-[#00E5FF]/10 border-[#00E5FF]/30',
  RESOLVED_CLAIMED: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  SYSTEM_VERIFIED: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  INCIDENT_CLOSED: 'text-slate-400 bg-slate-500/10 border-slate-500/30',
  TELEMETRY_CLEAR: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  AWAITING_ACK: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  AWAITING_RESOLVE: 'text-orange-400 bg-orange-500/10 border-orange-500/30',
};

function fmtTs(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function IncidentCard({ row, expanded, onToggle, apiPrefix = '/api/demo' }) {
  const inc = row.incident || {};
  const ledger = row.ledger || [];
  const statusClass = STATUS_STYLE[row.status] || 'text-slate-400 bg-slate-500/10 border-slate-500/30';
  const isClosed = row.closed || row.status === 'INCIDENT_CLOSED';

  return (
    <div className={`rounded-xl border overflow-hidden ${isClosed ? 'border-[#233544] bg-[#161E2E]/40' : 'border-red-500/30 bg-[#161E2E]'}`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-[#0B1120]/40 transition-colors"
      >
        <span className={`material-icons-outlined text-lg flex-shrink-0 mt-0.5 ${inc.severity === 'critical' ? 'text-red-400' : 'text-amber-400'}`}>
          {isClosed ? 'inventory_2' : 'warning_amber'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="text-sm font-bold text-white">{inc.label || inc.ip}</span>
            <span className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded border ${statusClass}`}>
              {(row.status || 'open').replace(/_/g, ' ')}
            </span>
            {row.kind === 'test' && (
              <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-[#233544] text-slate-500">Test</span>
            )}
          </div>
          <p className="text-xs text-slate-400">
            {inc.rack || '—'}
            {inc.outlet_code && (
              <> · Outlet <span className="font-mono text-red-200">{inc.outlet_code}</span></>
            )}
            {' · '}
            {(inc.key || '').includes('_load') ? 'Cable unplugged' : (inc.key?.replace('alarm_', '').replace(/_/g, ' ') || 'alarm')}
            : <span className="text-red-300 font-mono">{inc.value}</span>
          </p>
          {!isClosed && !row.acknowledged && (
            <p className="text-[10px] text-amber-400/90 mt-1">Awaiting technician acknowledge</p>
          )}
          <p className="text-[10px] text-slate-600 mt-1 font-mono">
            Opened {fmtTs(row.created_at)} · {ledger.length} step{ledger.length !== 1 ? 's' : ''} recorded
          </p>
        </div>
        <span className={`material-icons-outlined text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`}>expand_more</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-[#233544]/80">
          {row.mobile_url && (
            <p className="text-[10px] text-slate-500 mt-3 mb-2 font-mono truncate">
              Mobile: <a href={row.mobile_url} target="_blank" rel="noreferrer" className="text-[#00E5FF] hover:underline">{row.mobile_url}</a>
            </p>
          )}
          <ol className="mt-2 space-y-0 border-l border-[#233544] ml-2 pl-4">
            {ledger.map((entry, i) => (
              <li key={`${entry.ts}-${entry.step}-${i}`} className="relative pb-3 last:pb-0">
                <span className={`absolute -left-[1.28rem] top-1 w-2 h-2 rounded-full ring-2 ring-[#161E2E] ${
                  entry.step === 'INCIDENT_CLOSED' ? 'bg-slate-500' : 'bg-[#00E5FF]'
                }`} />
                <p className="text-xs font-medium text-slate-200">{entry.label || entry.step}</p>
                <p className="text-[10px] text-slate-500 mt-0.5">{entry.detail}</p>
                <p className="text-[9px] font-mono text-slate-600 mt-0.5">
                  {fmtTs(entry.ts)} · {entry.actor || 'system'}
                </p>
              </li>
            ))}
          </ol>
          {isClosed && row.closed_at && (
            <p className="text-[10px] text-emerald-400/90 mt-3 pt-2 border-t border-[#233544]">
              <span className="material-icons-outlined text-xs align-middle mr-1">verified</span>
              Closed {fmtTs(row.closed_at)} — stone report archived
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <a
              href={`${API_BASE}${apiPrefix}/incident/${row.token}/report`}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] px-2 py-1 rounded border border-[#233544] text-slate-400 hover:text-white hover:border-[#475569] inline-flex items-center gap-1"
            >
              <span className="material-icons-outlined text-xs">picture_as_pdf</span>
              Export PDF
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DemoStoneReportPanel({ apiPrefix = '/api/demo', fillHeight = false }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [expandedToken, setExpandedToken] = useState(null);

  const fetchIncidents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}${apiPrefix}/incidents`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load incident ledger');
      setIncidents(data.incidents || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchIncidents();
    const interval = setInterval(fetchIncidents, 15000);
    return () => clearInterval(interval);
  }, [fetchIncidents]);

  const sorted = [...incidents].sort((a, b) => {
    if (a.closed !== b.closed) return a.closed ? 1 : -1;
    return (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || '');
  });
  const openCount = incidents.filter((i) => !i.closed).length;

  const rootClass = fillHeight
    ? 'flex flex-col flex-1 min-h-0 overflow-hidden'
    : 'mb-8';

  return (
    <div className={rootClass}>
      <div className={`flex justify-between items-start mb-4 gap-3 flex-wrap ${fillHeight ? 'flex-shrink-0' : ''}`}>
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
            <span className="material-icons-outlined text-[#00E5FF] text-base">history_edu</span>
            Incident stone reports
          </h3>
          <p className="text-[11px] text-slate-500 mt-1 max-w-xl">
            Full lifecycle ledger per alarm — from detection through Telegram notify, mobile ack, on-site resolve, to system verification.
          </p>
        </div>
        <button
          type="button"
          onClick={fetchIncidents}
          className="px-3 py-1.5 rounded-lg border border-[#233544] text-xs text-slate-400 hover:text-white hover:border-[#475569] flex items-center gap-1"
        >
          <span className="material-icons-outlined text-sm">refresh</span>
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">{error}</div>
      )}

      {loading && incidents.length === 0 ? (
        <div className="py-8 text-center text-slate-600 text-sm">Loading incident ledger…</div>
      ) : incidents.length === 0 ? (
        <div className="py-8 px-4 rounded-xl border border-dashed border-[#233544] text-center text-slate-600 text-sm">
          No incidents recorded yet. Enable Telegram and trigger a demo alarm, or use <strong className="text-slate-400">Save &amp; send test</strong> in Integrations.
        </div>
      ) : (
        <>
          <p className={`text-[10px] text-slate-600 mb-3 uppercase tracking-wider ${fillHeight ? 'flex-shrink-0' : ''}`}>
            {incidents.length} report{incidents.length !== 1 ? 's' : ''} · {openCount} open
            {openCount > 0 && <span className="text-amber-400/90 normal-case ml-2">— open incidents listed first</span>}
          </p>
          <div className={`space-y-2 pr-1 dashboard2-scroll ${fillHeight ? 'flex-1 min-h-0 overflow-y-auto' : 'max-h-[min(520px,50vh)] overflow-y-auto'}`}>
            {sorted.map((row) => (
              <IncidentCard
                key={row.token}
                row={{ ...row, acknowledged: row.acknowledged ?? !!row.acknowledged_at }}
                apiPrefix={apiPrefix}
                expanded={expandedToken === row.token}
                onToggle={() => setExpandedToken(expandedToken === row.token ? null : row.token)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
