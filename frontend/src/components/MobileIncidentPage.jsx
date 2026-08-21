import React, { useCallback, useEffect, useMemo, useState } from 'react';
import IncidentHallMap from './IncidentHallMap';
import { publicApiFetch, resolveLayerJson } from '../publicApi';

function severityBadge(sev) {
  if (sev === 'critical') return 'bg-red-500/20 text-red-300 border-red-500/40';
  if (sev === 'warning') return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
  return 'bg-slate-500/20 text-slate-400 border-slate-500/40';
}

function fmtResolution(sec) {
  if (sec == null || Number.isNaN(sec)) return null;
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m > 0) return `${m}m ${r}s`;
  return `${s}s`;
}

export default function MobileIncidentPage({ token }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [acking, setAcking] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [acked, setAcked] = useState(false);
  const [resolved, setResolved] = useState(false);
  // Which layer (production /api/ops vs demo /api/demo) owns this token.
  const [layerPrefix, setLayerPrefix] = useState(null);

  const fetchIncident = useCallback(async (recordView = true) => {
    try {
      const q = recordView ? '' : '?view=0';
      if (layerPrefix) {
        const res = await publicApiFetch(`${layerPrefix}/incident/${encodeURIComponent(token)}${q}`);
        const json = await res.json();
        if (!res.ok) {
          setError(json.error || 'Incident unavailable');
          setData(null);
          return;
        }
        setData(json);
        setAcked(!!json.acknowledged);
        setResolved(!!json.resolved);
        setError(null);
      } else {
        const { json, prefix } = await resolveLayerJson(`/incident/${encodeURIComponent(token)}${q}`);
        setLayerPrefix(prefix);
        setData(json);
        setAcked(!!json.acknowledged);
        setResolved(!!json.resolved);
        setError(null);
      }
    } catch (e) {
      setError(e?.message || 'Cannot reach PDUMind');
    } finally {
      setLoading(false);
    }
  }, [token, layerPrefix]);

  useEffect(() => {
    fetchIncident(true);
    const interval = setInterval(() => fetchIncident(false), 10000);
    return () => clearInterval(interval);
  }, [fetchIncident]);

  const handleAck = async () => {
    setAcking(true);
    try {
      const res = await publicApiFetch(`${layerPrefix || '/api/ops'}/incident/${encodeURIComponent(token)}/ack`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setAcked(true);
        fetchIncident(false);
      }
    } finally {
      setAcking(false);
    }
  };

  const handleResolve = async () => {
    setResolving(true);
    try {
      const res = await publicApiFetch(`${layerPrefix || '/api/ops'}/incident/${encodeURIComponent(token)}/resolve`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setResolved(true);
        setData((prev) => (prev ? {
          ...prev,
          resolved: true,
          resolved_at: json.resolved_at ?? prev.resolved_at,
          acknowledged_at: json.acknowledged_at ?? prev.acknowledged_at,
          resolution_duration_sec: json.resolution_duration_sec ?? prev.resolution_duration_sec,
          closed: json.closed ?? prev.closed,
          cleared: json.cleared ?? prev.cleared,
          stone_report: json.stone_report ?? prev.stone_report,
          ledger: json.ledger ?? prev.ledger,
        } : prev));
        fetchIncident(false);
      }
    } finally {
      setResolving(false);
    }
  };

  const primary = data?.primary;
  const issues = data?.issues || [];

  const headline = useMemo(() => {
    if (!primary) return 'Incident Response';
    return primary.severity === 'critical' ? 'Critical incident' : 'Active alarm';
  }, [primary]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#050a12] flex items-center justify-center text-slate-500 text-sm">
        <span className="material-icons-outlined animate-spin mr-2">sync</span>
        Loading incident…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-[#050a12] flex flex-col items-center justify-center p-6 text-center">
        <span className="material-icons-outlined text-4xl text-red-400 mb-3">link_off</span>
        <h1 className="text-lg font-semibold text-white mb-1">Incident link invalid</h1>
        <p className="text-sm text-slate-500 max-w-xs">{error || 'No incident data returned'}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050a12] text-slate-100 flex flex-col max-w-lg mx-auto">
      {/* Header strip */}
      <header className="sticky top-0 z-20 bg-[#0B1120]/95 backdrop-blur border-b border-[#233544] px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#00E5FF] mb-0.5">PDUMind Switchboard</p>
            <h1 className="text-base font-bold text-white truncate">{headline}</h1>
            <p className="text-xs text-slate-500 truncate">{data.hall?.name}</p>
          </div>
          {primary && (
            <span className={`flex-shrink-0 text-[10px] font-bold uppercase px-2 py-1 rounded border ${severityBadge(primary.severity)}`}>
              {primary.severity}
            </span>
          )}
        </div>
        {data.summary?.total > 0 && (
          <div className="flex gap-3 mt-2 text-[10px] font-mono">
            <span className="text-red-400">{data.summary.critical} critical</span>
            <span className="text-amber-400">{data.summary.warning} warning</span>
            <span className="text-slate-600 ml-auto">{issues.length} open</span>
          </div>
        )}
      </header>

      {data.closed && !data.resolved && (
        <div className="mx-4 mt-4 p-4 rounded-xl border border-slate-600/50 bg-slate-800/40 text-center">
          <span className="material-icons-outlined text-3xl text-slate-400 mb-2">info</span>
          <h2 className="text-sm font-bold text-slate-200">Incident closed</h2>
          <p className="text-xs text-slate-500 mt-1">
            Telemetry returned to normal. Ledger and hall map are shown below for reference.
          </p>
        </div>
      )}

      {data.resolved && (
        <div className="mx-4 mt-4 p-5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-center">
          <span className="material-icons-outlined text-4xl text-emerald-400 mb-2">celebration</span>
          <h2 className="text-lg font-bold text-emerald-300">Thanks — well done!</h2>
          {data.resolution_duration_sec != null && (
            <p className="text-sm text-emerald-200/90 mt-2">
              Time on site:{' '}
              <span className="font-mono font-bold">{fmtResolution(data.resolution_duration_sec)}</span>
            </p>
          )}
          <p className="text-[10px] text-slate-500 mt-1">From acknowledge to resolved on-site</p>
          {data.closed && (
            <p className="text-xs text-emerald-400/90 mt-3 flex items-center justify-center gap-1">
              <span className="material-icons-outlined text-sm">verified</span>
              System verified — stone report saved
            </p>
          )}
        </div>
      )}

      {/* Primary alert card */}
      {primary && (
        <div className={`mx-4 mt-4 p-4 rounded-xl border ${
          primary.severity === 'critical'
            ? 'bg-red-500/10 border-red-500/40'
            : 'bg-amber-500/10 border-amber-500/40'
        }`}>
          <div className="flex items-start gap-3">
            <span className={`material-icons-outlined text-2xl ${primary.severity === 'critical' ? 'text-red-400 animate-pulse' : 'text-amber-400'}`}>
              {primary.severity === 'critical' ? 'error' : 'warning_amber'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white">{primary.message}</p>
              <p className="text-xs text-slate-400 mt-1">
                <span className="font-mono">{primary.label}</span>
                {primary.rack_code && <> · Rack <span className="text-[#00E5FF]">{primary.rack_code}</span></>}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 2D wireframe map */}
      <div className="mx-4 mt-4 rounded-xl border border-[#233544] bg-[#0B1120] overflow-hidden">
        <div className="px-3 py-2 border-b border-[#233544]/80 flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Data hall — top view</span>
          <span className="text-[9px] font-mono text-slate-600">pinch · drag · focus</span>
        </div>
        <IncidentHallMap
          hall={data.hall}
          racks={data.racks}
          primaryRackCode={primary?.rack_code}
        />
      </div>

      {/* Workflow ledger — stone report timeline */}
      {data.ledger?.length > 0 && (
        <div className="mx-4 mt-4 rounded-xl border border-[#233544] bg-[#161E2E] p-4">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3 flex items-center gap-2">
            <span className="material-icons-outlined text-sm text-[#00E5FF]">history_edu</span>
            Incident ledger
          </h2>
          <ol className="space-y-0 border-l border-[#233544] ml-2 pl-4">
            {[...data.ledger].reverse().map((entry, i) => (
              <li key={`${entry.ts}-${entry.step}-${i}`} className="relative pb-3 last:pb-0">
                <span className="absolute -left-[1.28rem] top-1 w-2 h-2 rounded-full bg-[#00E5FF] ring-2 ring-[#161E2E]" />
                <p className="text-xs font-medium text-slate-200">{entry.label || entry.step}</p>
                <p className="text-[10px] text-slate-500 mt-0.5">{entry.detail}</p>
                <p className="text-[9px] font-mono text-slate-600 mt-0.5">
                  {entry.ts?.slice(11, 19)} · {entry.actor || 'system'}
                </p>
              </li>
            ))}
          </ol>
          {data.closed && (
            <div className="mt-3 pt-3 border-t border-[#233544] text-[10px] text-emerald-400/90">
              <span className="material-icons-outlined text-xs align-middle mr-1">verified</span>
              Stone report archived — system verified fix
            </div>
          )}
        </div>
      )}

      {/* Issue list */}
      <div className="flex-1 px-4 py-4 pb-32">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">Open issues</h2>
        {issues.length === 0 ? (
          <p className="text-sm text-emerald-400/80 py-4 text-center">No active alarms — all clear</p>
        ) : (
          <ul className="space-y-2">
            {issues.map((issue) => (
              <li
                key={issue.fingerprint || `${issue.pdu_ip}-${issue.title}`}
                className={`p-3 rounded-lg border bg-[#161E2E] ${
                  issue.fingerprint === data.primary?.fingerprint
                    ? 'border-[#00E5FF]/40 ring-1 ring-[#00E5FF]/20'
                    : 'border-[#233544]'
                } ${issue.severity === 'critical' ? 'border-l-2 border-l-red-500' : 'border-l-2 border-l-amber-500'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white">{issue.message}</p>
                    <p className="text-[10px] text-slate-500 mt-1">
                      {issue.pdu_label || issue.pdu_ip}
                      {issue.rack_code && <> · {issue.rack_code}</>}
                    </p>
                  </div>
                  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 ${severityBadge(issue.severity)}`}>
                    {issue.category}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Sticky action bar */}
      <div className="fixed bottom-0 left-0 right-0 max-w-lg mx-auto p-4 bg-[#0B1120]/95 backdrop-blur border-t border-[#233544] space-y-2">
        {!data.closed && !acked && (
          <button
            type="button"
            onClick={handleAck}
            disabled={acking}
            className="w-full py-3.5 rounded-xl bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/50 text-sm font-bold uppercase tracking-wider hover:bg-[#00E5FF]/30 disabled:opacity-50"
          >
            {acking ? 'Acknowledging…' : 'Acknowledge — on my way'}
          </button>
        )}
        {!data.closed && acked && !resolved && (
          <button
            type="button"
            onClick={handleResolve}
            disabled={resolving}
            className="w-full py-3.5 rounded-xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/40 text-sm font-bold uppercase tracking-wider hover:bg-emerald-500/25 disabled:opacity-50"
          >
            {resolving ? 'Saving…' : 'Mark resolved on-site'}
          </button>
        )}
        {resolved && (
          <div className="flex flex-col items-center gap-1 py-2 text-emerald-400 text-sm text-center">
            <div className="flex items-center gap-2">
              <span className="material-icons-outlined text-lg">check_circle</span>
              {data.closed ? 'Closed & verified' : 'Resolved — awaiting system verification'}
            </div>
            {data.resolution_duration_sec != null && (
              <p className="text-[10px] font-mono text-emerald-300/80">
                On-site time {fmtResolution(data.resolution_duration_sec)}
              </p>
            )}
          </div>
        )}
        {!resolved && data.closed && (
          <div className="flex items-center justify-center gap-2 py-3 text-emerald-400 text-sm">
            <span className="material-icons-outlined text-lg">check_circle</span>
            Closed & verified
          </div>
        )}
        {acked && !resolved && !data.closed && (
          <div className="flex items-center justify-center gap-2 py-1 text-[#00E5FF]/80 text-xs">
            <span className="material-icons-outlined text-sm">check</span>
            Dispatched {data.acknowledged_at ? new Date(data.acknowledged_at).toLocaleTimeString() : ''}
          </div>
        )}
        {!resolved && acked && !data.closed && (
          <p className="text-[10px] text-center text-slate-500">Waiting for system to verify telemetry…</p>
        )}
        <p className="text-[9px] text-center text-slate-600 font-mono">Secured link · auto-refresh 10s</p>
      </div>
    </div>
  );
}
