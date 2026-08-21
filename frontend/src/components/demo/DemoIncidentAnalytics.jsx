import React, { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

function authHeaders() {
  const token = localStorage.getItem('pdumind_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const PHASES = [
  { id: 'detect', label: 'Detect', color: 'bg-amber-500' },
  { id: 'assign', label: 'Assign', color: 'bg-sky-500' },
  { id: 'notify', label: 'Notify', color: 'bg-blue-500' },
  { id: 'ack', label: 'Ack', color: 'bg-[#00E5FF]' },
  { id: 'resolve', label: 'Resolve', color: 'bg-emerald-500' },
  { id: 'verify', label: 'Verify', color: 'bg-emerald-600' },
  { id: 'close', label: 'Close', color: 'bg-slate-500' },
];

const MIN_VISUAL_SPAN_SEC = 90;
const MARKER_GAP_PCT = 4.5;

function fmtDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  return `${(sec / 60).toFixed(1)}m`;
}

function phaseOffset(created, phaseTs) {
  if (!created || !phaseTs) return null;
  try {
    const c = Date.parse(created);
    const p = Date.parse(phaseTs);
    if (Number.isNaN(c) || Number.isNaN(p)) return null;
    return (p - c) / 1000;
  } catch {
    return null;
  }
}

/** Full forensic timestamp — always includes calendar date + time. */
function fmtForensic(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${y}-${mo}-${da} ${h}:${mi}:${s}`;
  } catch {
    return '—';
  }
}

function computeMarkerLayouts(row) {
  const created = row.created_at;
  const entries = PHASES.map((ph) => ({
    ph,
    ts: row.phases?.[ph.id],
    offset: phaseOffset(created, row.phases?.[ph.id]),
  })).filter((e) => e.offset != null && e.offset >= 0);

  if (entries.length === 0) return { markers: [], spanSec: 0 };

  const rawLast = Math.max(...entries.map((e) => e.offset));
  const spanSec = Math.max(rawLast, MIN_VISUAL_SPAN_SEC);

  let markers = entries.map((e) => ({
    ...e,
    leftPct: 2 + (e.offset / spanSec) * 91,
  }));

  markers.sort((a, b) => a.leftPct - b.leftPct);
  for (let i = 1; i < markers.length; i += 1) {
    const minLeft = markers[i - 1].leftPct + MARKER_GAP_PCT;
    if (markers[i].leftPct < minLeft) markers[i].leftPct = minLeft;
  }

  const last = markers[markers.length - 1];
  if (last && last.leftPct > 97) {
    const first = markers[0].leftPct;
    const range = last.leftPct - first || 1;
    markers = markers.map((m) => ({
      ...m,
      leftPct: first + ((m.leftPct - first) / range) * (97 - first),
    }));
  }

  return { markers, spanSec: rawLast };
}

function SwimlaneRow({ row }) {
  const isPending = row.pending || (!row.closed && !row.phases?.resolve);
  const lastPhaseId = PHASES.reduce((last, ph) => (row.phases?.[ph.id] ? ph.id : last), null);
  const { markers, spanSec } = useMemo(() => computeMarkerLayouts(row), [row]);

  const openedAt = row.created_at;
  const closedAt = row.closed_at || row.phases?.close;

  return (
    <div className={`flex items-stretch gap-2 py-2 border-b border-[#233544]/60 min-h-[3.25rem] ${isPending ? 'bg-[#00E5FF]/[0.03]' : ''}`}>
      <div className="w-[11.5rem] flex-shrink-0 min-w-0">
        <p className="text-[8px] font-mono text-slate-500 tabular-nums leading-tight truncate" title={fmtForensic(openedAt)}>
          {fmtForensic(openedAt)}
        </p>
        {closedAt && (
          <p className="text-[8px] font-mono text-emerald-600/80 tabular-nums leading-tight truncate" title={fmtForensic(closedAt)}>
            → {fmtForensic(closedAt)}
          </p>
        )}
        <p className="text-[10px] font-medium text-white truncate flex items-center gap-1 mt-0.5">
          {isPending && (
            <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-[#00E5FF] animate-pulse" title="Awaiting resolve" />
          )}
          <span className="truncate">{row.label}</span>
        </p>
        <p className="text-[9px] text-slate-600 truncate">{row.rack}</p>
      </div>

      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <div className="relative h-7 bg-[#0B1120] rounded border border-[#233544] overflow-visible">
          {markers.map(({ ph, ts, offset, leftPct }) => {
            const isLastReached = ph.id === lastPhaseId;
            const pulse = isPending && isLastReached;
            return (
              <span
                key={ph.id}
                title={`${ph.label}\n${fmtForensic(ts)}\n+${fmtDuration(offset)} from open`}
                className={`absolute top-1 bottom-1 w-2.5 rounded-sm ${ph.color} z-10 ${
                  pulse ? 'animate-pulse ring-2 ring-[#00E5FF]/60 shadow-[0_0_8px_rgba(0,229,255,0.5)]' : 'opacity-95'
                }`}
                style={{ left: `calc(${leftPct}% - 5px)` }}
              />
            );
          })}
          {isPending && markers.length === 0 && (
            <span className="absolute left-1 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-amber-500 animate-pulse" title="Open — no phases yet" />
          )}
          {row.escalated && (
            <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[8px] font-bold uppercase text-red-400 bg-red-500/20 px-1 rounded z-20">
              ESC
            </span>
          )}
        </div>
        <p className="text-[8px] font-mono text-slate-600 mt-0.5 text-right tabular-nums">
          lifecycle {fmtDuration(spanSec)}
          {markers.length > 1 ? ` · ${markers.length} events spaced` : ''}
        </p>
      </div>
    </div>
  );
}

export default function DemoIncidentAnalytics({ apiPrefix = '/api/demo' }) {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  const fetchAnalytics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}${apiPrefix}/teams/analytics`, { headers: authHeaders() });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load analytics');
      setStats(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchAnalytics();
    const interval = setInterval(fetchAnalytics, 30000);
    return () => clearInterval(interval);
  }, [fetchAnalytics]);

  const swimlane = useMemo(() => {
    const rows = stats?.swimlane || [];
    return [...rows].sort((a, b) => {
      const ta = Date.parse(a.updated_at || a.created_at || '') || 0;
      const tb = Date.parse(b.updated_at || b.created_at || '') || 0;
      return tb - ta;
    });
  }, [stats?.swimlane]);

  return (
    <div className="mb-8 rounded-xl border border-[#233544] bg-[#161E2E]/40 p-5">
      <div className="flex flex-wrap justify-between items-start gap-3 mb-4">
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
            <span className="material-icons-outlined text-purple-400 text-base">analytics</span>
            Incident analytics
          </h3>
          <p className="text-[11px] text-slate-500 mt-1">Forensic swimlane · per-incident timeline scale</p>
        </div>
        <button
          type="button"
          onClick={fetchAnalytics}
          className="text-xs px-2 py-1 rounded border border-[#233544] text-slate-500 hover:text-white"
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="text-red-400 text-sm mb-3">{error}</p>
      )}

      {loading && !stats ? (
        <p className="text-slate-600 text-sm py-4">Loading analytics…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
            {[
              { label: 'Incidents', value: stats?.incident_count ?? 0 },
              { label: 'Open', value: stats?.open_count ?? 0 },
              { label: 'Escalations', value: stats?.escalation_count ?? 0 },
              { label: 'Median ack', value: fmtDuration(stats?.median_ack_sec) },
              { label: 'Median resolve', value: fmtDuration(stats?.median_resolve_sec) },
            ].map((m) => (
              <div key={m.label} className="rounded-lg border border-[#233544] bg-[#0B1120] px-3 py-2">
                <p className="text-lg font-mono font-bold text-white">{m.value}</p>
                <p className="text-[9px] uppercase text-slate-500">{m.label}</p>
              </div>
            ))}
          </div>

          <div className="flex gap-2 mb-2 flex-wrap">
            {PHASES.map((ph) => (
              <span key={ph.id} className="flex items-center gap-1 text-[9px] text-slate-500">
                <span className={`w-2 h-2 rounded-sm ${ph.color}`} />
                {ph.label}
              </span>
            ))}
          </div>

          {swimlane.length === 0 ? (
            <p className="text-slate-600 text-sm py-4 text-center border border-dashed border-[#233544] rounded-lg">
              No incidents yet — trigger a demo alarm to populate the swimlane.
            </p>
          ) : (
            <div className="max-h-[360px] overflow-y-auto pr-1">
              <div className="flex gap-2 pb-1 mb-1 border-b border-[#233544]/40 text-[8px] uppercase text-slate-600 tracking-wide">
                <span className="w-[11.5rem] flex-shrink-0">Forensic time · PDU</span>
                <span className="flex-1 text-right">Lifecycle (scaled per row)</span>
              </div>
              {swimlane.map((row) => (
                <SwimlaneRow key={row.token} row={row} />
              ))}
            </div>
          )}

          <p className="text-[9px] text-slate-600 mt-3">
            Newest first · timestamps UTC-local · markers spaced per incident duration · pulsing = awaiting resolve
          </p>
        </>
      )}
    </div>
  );
}
