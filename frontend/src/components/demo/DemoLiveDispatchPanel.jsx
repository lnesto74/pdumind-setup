import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import IncidentHallMap from '../IncidentHallMap';

const API_BASE = import.meta.env.VITE_API_URL || '';
export const DISPATCH_REFRESH_EVENT = 'pdumind:dispatch-refresh';

function authHeaders() {
  const token = localStorage.getItem('pdumind_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function notifyDispatchRefresh() {
  window.dispatchEvent(new Event(DISPATCH_REFRESH_EVENT));
}

/** Poll live dispatch globally (Integrations test → Alarms tab stays in sync). */
export function useLiveDispatchPoll({ enabled = true, onOpenCountChange, apiPrefix = '/api/demo' } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);

  const fetchLive = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}${apiPrefix}/dispatch/live`, { headers: authHeaders(), cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load live dispatch');
      setData(json);
      setError(null);
      setLastFetch(new Date());
      onOpenCountChange?.(json.open_count ?? 0);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [onOpenCountChange, apiPrefix]);

  useEffect(() => {
    if (!enabled) return undefined;
    fetchLive();
    const interval = setInterval(fetchLive, 2000);
    const onRefresh = () => fetchLive();
    window.addEventListener(DISPATCH_REFRESH_EVENT, onRefresh);
    return () => {
      clearInterval(interval);
      window.removeEventListener(DISPATCH_REFRESH_EVENT, onRefresh);
    };
  }, [enabled, fetchLive]);

  return { data, loading, error, lastFetch, refresh: fetchLive };
}

function fmtDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return '—';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${s}s`;
}

function elapsedSince(iso, nowMs) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (nowMs - t) / 1000);
}

function EscBar({ label, thresholdSec, startIso, nowMs, color }) {
  const elapsed = elapsedSince(startIso, nowMs);
  const pct = thresholdSec > 0 ? Math.min(1, elapsed / thresholdSec) : 0;
  const fired = elapsed >= thresholdSec;
  const remaining = Math.max(0, thresholdSec - elapsed);
  return (
    <div className="flex-1 min-w-0">
      <div className="flex justify-between text-[9px] mb-0.5">
        <span className="text-slate-500 truncate">{label}</span>
        <span className={`font-mono flex-shrink-0 ml-1 ${fired ? 'text-amber-400' : 'text-slate-600'}`}>
          {fired ? 'fired' : fmtDuration(remaining)}
        </span>
      </div>
      <div className="h-1 rounded-full bg-[#0B1120] overflow-hidden">
        <div
          className={`h-full rounded-full ${color} ${fired ? 'opacity-100' : 'opacity-80'}`}
          style={{ width: `${pct * 100}%`, transition: 'width 1s linear' }}
        />
      </div>
    </div>
  );
}

function Stepper({ steps }) {
  const n = steps?.length || 0;
  if (n === 0) return null;

  const lastDone = steps.reduce((max, step, i) => (step.done ? i : max), -1);
  const fillRatio = n > 1 && lastDone > 0 ? lastDone / (n - 1) : 0;

  return (
    <div className="overflow-x-auto py-1">
      <div className="relative flex items-start w-full min-w-max">
        {/* Full track — first dot center → last dot center */}
        <div
          className="absolute h-0.5 bg-slate-700 rounded-full pointer-events-none"
          style={{
            top: 5,
            left: `calc(100% / ${n} / 2)`,
            right: `calc(100% / ${n} / 2)`,
          }}
        />
        {fillRatio > 0 && (
          <div
            className="absolute h-0.5 bg-emerald-500 rounded-full pointer-events-none transition-all duration-300"
            style={{
              top: 5,
              left: `calc(100% / ${n} / 2)`,
              width: `calc((100% - 100% / ${n}) * ${fillRatio})`,
            }}
          />
        )}

        {steps.map((step) => (
          <div key={step.id || step.step} className="relative z-10 flex flex-1 flex-col items-center min-w-[3.5rem]">
            <div
              className={`w-2.5 h-2.5 rounded-full ring-2 ring-[#161E2E] ${
                step.done ? 'bg-emerald-500' : step.current ? 'bg-[#00E5FF] animate-pulse' : 'bg-slate-600'
              }`}
            />
            <span
              className={`text-[8px] mt-1 text-center leading-tight uppercase ${
                step.current ? 'text-[#00E5FF] font-bold' : step.done ? 'text-slate-400' : 'text-slate-600'
              }`}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MemberChip({ m, isOwner, isPrimary, isHighlight, singleLivePulse }) {
  const presence = m.presence || (m.live_eligible ? 'live' : m.is_demo_seed ? 'demo_roster' : 'offline');
  return (
    <div
      className={`relative px-3 py-2 rounded-lg border text-center min-w-[5.5rem] transition-all duration-300 ${
        isOwner
          ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.35)]'
          : isHighlight
            ? 'border-[#00E5FF] bg-[#00E5FF]/15 text-[#00E5FF] scale-105 shadow-[0_0_14px_rgba(0,229,255,0.4)]'
            : singleLivePulse
              ? 'border-[#00E5FF] bg-[#00E5FF]/10 text-[#00E5FF] animate-pulse'
              : presence === 'live'
                ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-200'
                : presence === 'paused'
                  ? 'border-slate-700 bg-slate-800/30 text-slate-600 opacity-50'
                  : 'border-dashed border-slate-700 text-slate-600 opacity-45'
      }`}
    >
      {isHighlight && (
        <span className="absolute -top-1.5 left-1/2 -translate-x-1/2 text-[8px] font-bold uppercase text-[#00E5FF]">
          ◉ turn
        </span>
      )}
      <p className="text-[11px] font-medium truncate">{m.display_name}</p>
      {isOwner && <p className="text-[8px] font-bold uppercase text-emerald-400 mt-0.5">Owner</p>}
      {isPrimary && !isOwner && <p className="text-[8px] text-sky-400 mt-0.5">Primary DM</p>}
      {presence === 'live' && !isOwner && !isPrimary && (
        <p className="text-[8px] text-emerald-400/80 mt-0.5">Telegram live</p>
      )}
      {presence === 'demo_roster' && <p className="text-[8px] text-slate-600 mt-0.5">Demo roster</p>}
      {presence === 'offline' && <p className="text-[8px] text-slate-600 mt-0.5">Not subscribed</p>}
      {presence === 'paused' && <p className="text-[8px] text-slate-600 mt-0.5">Paused</p>}
    </div>
  );
}

function PoolLottery({ pool, lotteryActive, singleLivePrimary, owner, primary }) {
  const liveMembers = pool?.live_members || (pool?.members || []).filter((m) => m.live_eligible);
  const rosterOffline = (pool?.members || []).filter((m) => !m.live_eligible);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (!lotteryActive || liveMembers.length < 2) return undefined;
    const t = setInterval(() => setHighlight((h) => (h + 1) % liveMembers.length), 850);
    return () => clearInterval(t);
  }, [lotteryActive, liveMembers.length]);

  return (
    <div>
      <p className="text-[10px] uppercase text-slate-500 mb-2 tracking-wide">
        {pool?.discipline_label} pool · {pool?.live_count || 0} live on Telegram
        {lotteryActive && liveMembers.length > 1 ? ' · round-robin lottery' : singleLivePrimary ? ' · awaiting ack' : ''}
      </p>

      {liveMembers.length === 0 ? (
        <p className="text-[10px] text-amber-400/90 mb-2 py-2 px-2 rounded border border-amber-500/30 bg-amber-500/5">
          No live Telegram subscribers in this pool — share the hall subscribe link with your team.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2 mb-3">
          {liveMembers.map((m, idx) => (
            <MemberChip
              key={m.id}
              m={m}
              isOwner={owner?.id === m.id || m.is_owner}
              isPrimary={primary?.id === m.id || m.is_primary_target}
              isHighlight={lotteryActive && idx === highlight && !(owner?.id === m.id)}
              singleLivePulse={singleLivePrimary && (primary?.id === m.id || m.is_primary_target)}
            />
          ))}
        </div>
      )}

      {rosterOffline.length > 0 && (
        <>
          <p className="text-[9px] text-slate-600 uppercase mb-1.5">Offline / demo roster (not in lottery)</p>
          <div className="flex flex-wrap gap-2">
            {rosterOffline.map((m) => (
              <MemberChip key={m.id} m={m} isOwner={false} isPrimary={false} isHighlight={false} singleLivePulse={false} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function IncidentCard({ row, hallLayout, nowMs }) {
  const inc = row.incident || {};
  const sev = inc.severity === 'critical';
  const esc = row.escalation || {};
  const elapsed = elapsedSince(row.created_at, nowMs);
  const notifyAt = esc.notify_at || row.updated_at || row.created_at;
  const primaryRack = inc.rack || '';

  const mapRacks = useMemo(() => {
    const base = hallLayout?.racks || [];
    return base.map((rack) => ({
      ...rack,
      is_primary: rack.rack_code === primaryRack,
      severity: rack.rack_code === primaryRack
        ? (inc.severity || 'warning')
        : rack.severity,
    }));
  }, [hallLayout?.racks, primaryRack, inc.severity]);

  return (
    <article
      className={`rounded-xl border overflow-hidden ${
        row.phase === 'closed'
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : row.is_active_alarm || row.kind === 'test'
            ? 'border-[#00E5FF]/50 ring-1 ring-[#00E5FF]/20'
            : sev
              ? 'border-red-500/40 bg-[#161E2E]'
              : 'border-amber-500/30 bg-[#161E2E]/80'
      }`}
    >
      <header className="px-4 py-3 border-b border-[#233544]/80 flex flex-wrap items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded ${
              sev ? 'bg-red-500/20 text-red-300' : 'bg-amber-500/20 text-amber-300'
            }`}>
              {inc.severity || 'warning'}
            </span>
            {row.kind === 'test' && (
              <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded bg-[#00E5FF]/20 text-[#00E5FF]">Test</span>
            )}
            {row.is_active_alarm && (
              <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded bg-red-500/30 text-red-200 animate-pulse">Live alarm</span>
            )}
            {row.phase === 'closed' && (
              <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">Closed</span>
            )}
            <span className="text-[10px] font-mono text-[#00E5FF] uppercase tracking-wide">{row.phase_label}</span>
          </div>
          <h4 className="text-sm font-bold text-white truncate">
            {inc.label || inc.ip} <span className="text-slate-500 font-normal">@ {inc.rack || '—'}</span>
          </h4>
          {(inc.outlet_code || (inc.key || '').includes('_load')) ? (
            <p className="text-xs text-red-300 mt-0.5">
              <span className="font-bold uppercase tracking-wide">Cable unplugged</span>
              {inc.outlet_code && (
                <>
                  {' · '}
                  Outlet <span className="font-mono text-red-200">{inc.outlet_code}</span>
                </>
              )}
              {inc.detail && <span className="text-slate-400"> — {inc.detail}</span>}
            </p>
          ) : (
            <p className="text-xs text-slate-400 mt-0.5">
              {(inc.key || '').replace('alarm_', '').replace(/_/g, ' ')}:{' '}
              <span className="text-red-300 font-mono">{inc.value}</span>
            </p>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-lg font-mono font-bold text-white tabular-nums">{fmtDuration(elapsed)}</p>
          <p className="text-[9px] text-slate-600 uppercase">since open</p>
        </div>
      </header>

      <div className="flex flex-col lg:flex-row lg:items-stretch">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-4 py-3 border-b border-[#233544]/60 bg-[#0B1120]/40">
            <Stepper steps={row.steps || []} />
          </div>

          <div className="px-4 py-3 border-b border-[#233544]/60">
            <PoolLottery
              pool={row.pool}
              lotteryActive={row.lottery_active}
              singleLivePrimary={row.single_live_primary}
              owner={row.owner}
              primary={row.primary}
            />
          </div>

          {!row.acknowledged && esc.notify_at && (
            <div className="px-4 py-3 flex gap-3 border-b border-[#233544]/60">
              <EscBar label="Reminder" thresholdSec={esc.reminder_sec} startIso={notifyAt} nowMs={nowMs} color="bg-amber-500" />
              <EscBar label="Hall lead" thresholdSec={esc.lead_sec} startIso={notifyAt} nowMs={nowMs} color="bg-orange-500" />
              <EscBar label="Secondary" thresholdSec={esc.secondary_sec} startIso={notifyAt} nowMs={nowMs} color="bg-red-500" />
            </div>
          )}

          <div className="px-4 py-2 max-h-28 overflow-y-auto flex-1">
            <ol className="space-y-1">
              {(row.ledger || []).slice(-5).map((e, i) => (
                <li key={`${e.ts}-${i}`} className="text-[10px] text-slate-500 flex gap-2">
                  <span className="font-mono text-slate-600 flex-shrink-0">{e.ts?.slice(11, 19) || '—'}</span>
                  <span className="text-slate-400">{e.label || e.step}</span>
                  <span className="truncate">{e.detail}</span>
                </li>
              ))}
            </ol>
          </div>

          {row.mobile_url && (
            <footer className="px-4 py-2 border-t border-[#233544]/60 mt-auto">
              <a href={row.mobile_url} target="_blank" rel="noreferrer" className="text-[10px] text-[#00E5FF] hover:underline font-mono truncate block">
                Mobile incident map ↗
              </a>
            </footer>
          )}
        </div>

        {hallLayout?.hall && mapRacks.length > 0 && (
          <aside className="lg:w-72 xl:w-80 flex-shrink-0 border-t lg:border-t-0 lg:border-l border-[#233544]/60 bg-[#0B1120]/20">
            <div className="p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Navigate — {primaryRack || '—'}
                </p>
                <p className="text-[9px] font-mono text-slate-600">full cage · pan · zoom</p>
              </div>
              <div className="rounded-lg border border-[#233544] overflow-hidden">
                <IncidentHallMap
                  key={row.token}
                  hall={hallLayout.hall}
                  racks={mapRacks}
                  primaryRackCode={primaryRack}
                  autoFocusPrimary={false}
                />
              </div>
            </div>
          </aside>
        )}
      </div>
    </article>
  );
}

export default function DemoLiveDispatchPanel({
  compact = false,
  fillHeight = false,
  onOpenCountChange,
  visible = true,
  pollActive = true,
  liveData = null,
  liveLoading = null,
  liveError = null,
  liveLastFetch = null,
  onRefresh = null,
}) {
  const internal = useLiveDispatchPoll({
    enabled: pollActive && liveData == null,
    onOpenCountChange: liveData == null ? onOpenCountChange : undefined,
  });
  const data = liveData ?? internal.data;
  const loading = liveLoading ?? internal.loading;
  const error = liveError ?? internal.error;
  const lastFetch = liveLastFetch ?? internal.lastFetch;
  const fetchLive = onRefresh ?? internal.refresh;
  const [nowMs, setNowMs] = useState(Date.now());
  const listRef = useRef(null);

  useEffect(() => {
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const openCount = data?.open_count ?? 0;
  const incidents = useMemo(() => data?.incidents || [], [data]);
  const hallLayout = data?.hall_layout;

  if (!visible) return null;

  const rootClass = fillHeight
    ? 'flex flex-col flex-1 min-h-0 overflow-hidden'
    : compact
      ? ''
      : 'mb-8';

  return (
    <div className={rootClass}>
      <div className={`flex flex-wrap justify-between items-start gap-3 mb-4 ${fillHeight ? 'flex-shrink-0' : ''}`}>
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00E5FF] opacity-60" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#00E5FF]" />
            </span>
            Live Dispatch
          </h3>
          <p className="text-[11px] text-slate-500 mt-1">
            Open dispatches · interactive hall map per incident to guide ops on-site
          </p>
        </div>
        <div className="text-right">
          <button
            type="button"
            onClick={fetchLive}
            className="text-xs px-2 py-1 rounded border border-[#233544] text-slate-500 hover:text-white mb-1"
          >
            Refresh
          </button>
          {lastFetch && data?.updated_at && (
            <p className="text-[9px] font-mono text-slate-600">
              Sync {lastFetch.toLocaleTimeString()} · server {data.updated_at.slice(11, 19)}
            </p>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">{error}</div>
      )}

      {loading && !data ? (
        <div className="py-12 text-center text-slate-600 text-sm">Loading live dispatch…</div>
      ) : openCount === 0 ? (
        <div className="py-12 px-6 rounded-xl border border-dashed border-emerald-500/30 bg-emerald-500/5 text-center">
          <span className="material-icons-outlined text-3xl text-emerald-400 mb-2">verified</span>
          <p className="text-sm font-medium text-emerald-300">All clear — no active dispatches</p>
          <p className="text-xs text-slate-500 mt-1">Send a test from Integrations or wait for a fleet alarm.</p>
        </div>
      ) : (
        <>
          <p className={`text-[10px] text-slate-600 mb-3 uppercase tracking-wider ${fillHeight ? 'flex-shrink-0' : ''}`}>
            {openCount === 0
              ? 'No open dispatches'
              : `Showing ${incidents.length} of ${openCount} open dispatch${openCount === 1 ? '' : 'es'}${data?.truncated ? ' (newest first)' : ''}`}
            {incidents.length < openCount && (
              <span className="text-amber-400/90 normal-case ml-2">— scroll for more</span>
            )}
          </p>
          <div
            ref={listRef}
            className={`space-y-4 pr-1 dashboard2-scroll ${
              fillHeight ? 'flex-1 min-h-0 overflow-y-auto' : 'max-h-[min(70vh,720px)] overflow-y-auto'
            }`}
          >
            {incidents.map((row) => (
              <div
                key={row.token}
                data-active-alarm={row.is_active_alarm ? 'true' : undefined}
              >
                <IncidentCard row={row} hallLayout={hallLayout} nowMs={nowMs} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function DemoAlarmsSubNav({ section, onChange, openCount = 0, sticky = false }) {
  const tabs = [
    { id: 'dispatch', label: 'Live Dispatch', icon: 'sensors' },
    { id: 'reports', label: 'Stone Reports', icon: 'history_edu' },
    { id: 'analytics', label: 'Analytics', icon: 'analytics' },
  ];
  return (
    <div
      className={`flex gap-1 p-1 rounded-xl border border-[#233544] w-fit max-w-full overflow-x-auto ${
        sticky
          ? 'flex-shrink-0 relative z-10 mb-3 bg-[#161E2E] shadow-[0_8px_16px_-8px_rgba(0,0,0,0.85)]'
          : 'mb-6 bg-[#161E2E]/60'
      }`}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`relative flex items-center gap-1.5 px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wide whitespace-nowrap transition-all ${
            section === tab.id
              ? 'bg-[#161E2E] border border-[#00E5FF]/40 text-[#00E5FF]'
              : 'border border-transparent text-slate-500 hover:text-slate-300'
          }`}
        >
          <span className="material-icons-outlined text-sm">{tab.icon}</span>
          {tab.label}
          {tab.id === 'dispatch' && openCount > 0 && (
            <span className="min-w-[1rem] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-mono flex items-center justify-center animate-pulse">
              {openCount}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
