import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

const authHeaders = () => {
  const token = localStorage.getItem('pdumind_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/**
 * RecordReplayControls
 *
 * - Admin / real session (isDemoSession=false): "Record this hall for demo"
 *   captures layout + recorded telemetry into a snapshot file.
 * - Demo session (isDemoSession=true): list saved snapshots and replay one
 *   (restores the recorded hall into the demo db and loops its telemetry).
 */
const RecordReplayControls = ({ isDemoSession = false, selectedHallId, onReplayLoaded, onReplayStopped }) => {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [replayStatus, setReplayStatus] = useState({ active: false });

  const flash = (text, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3500);
  };

  const recordHall = useCallback(async () => {
    if (!selectedHallId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/halls/${selectedHallId}/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ window_hours: 24 }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        flash(`Recorded ${json.pdu_count} PDUs · ${json.frame_count} samples`);
      } else {
        flash(json.error || 'Recording failed', false);
      }
    } catch (e) {
      flash('Recording failed', false);
    } finally {
      setBusy(false);
    }
  }, [selectedHallId, busy]);

  const loadSnapshots = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/demo/snapshots`, { headers: authHeaders() });
      const json = await res.json();
      if (res.ok) {
        setSnapshots(json.snapshots || []);
        setReplayStatus(json.replay || { active: false });
      }
    } catch (e) { /* ignore */ }
  }, []);

  useEffect(() => {
    if (isDemoSession && open) loadSnapshots();
  }, [isDemoSession, open, loadSnapshots]);

  const playSnapshot = useCallback(async (filename) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/demo/replay/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ filename }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        flash(`Replaying ${json.hall_name} — recorded loop, not live cage`);
        loadSnapshots();
        if (onReplayLoaded) onReplayLoaded(json.hall_id);
      } else {
        flash(json.error || 'Replay failed', false);
      }
    } catch (e) {
      flash('Replay failed', false);
    } finally {
      setBusy(false);
    }
  }, [busy, loadSnapshots, onReplayLoaded]);

  const stopReplay = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`${API_BASE}/api/demo/replay/stop`, { method: 'POST', headers: authHeaders() });
      flash('Replay stopped — polling live cage SNMP');
      setReplayStatus({ active: false });
      if (onReplayStopped) onReplayStopped();
      loadSnapshots();
    } catch (e) { /* ignore */ } finally {
      setBusy(false);
    }
  }, [loadSnapshots, onReplayStopped]);

  // --- Admin / real session: record button -------------------------------
  if (!isDemoSession) {
    return (
      <div className="pt-3 mt-3 border-t border-[#233544]">
        <button
          type="button"
          onClick={recordHall}
          disabled={busy || !selectedHallId}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[11px] font-bold uppercase tracking-wide bg-[#161E2E] border border-[#00E5FF]/30 text-[#00E5FF] hover:bg-[#00E5FF]/10 disabled:opacity-50 transition-all"
          title="Capture this hall's layout + last 24h telemetry for a future demo"
        >
          <span className={`material-icons-outlined text-sm ${busy ? 'animate-pulse' : ''}`}>fiber_manual_record</span>
          {busy ? 'Recording…' : 'Record hall for demo'}
        </button>
        {msg && (
          <p className={`text-[9px] mt-1.5 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</p>
        )}
      </div>
    );
  }

  // --- Demo session: replay picker ---------------------------------------
  return (
    <div className="pt-3 mt-3 border-t border-[#233544]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between py-2 px-2 rounded-lg text-[11px] font-bold uppercase tracking-wide text-slate-400 hover:text-[#00E5FF] hover:bg-[#161E2E] transition-all"
      >
        <span className="flex items-center gap-2">
          <span className="material-icons-outlined text-sm">smart_display</span>
          Recorded halls
        </span>
        <span className={`material-icons-outlined text-sm transition-transform ${open ? 'rotate-180' : ''}`}>expand_more</span>
      </button>

      {replayStatus.active && (
        <div className="mt-1.5 px-2 py-2 rounded bg-amber-500/10 border border-amber-500/35">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[9px] text-amber-300 truncate flex items-center gap-1 font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              {replayStatus.hall_name || 'Replay'} — not live
            </span>
            <button type="button" onClick={stopReplay} className="text-[9px] text-emerald-400 hover:text-emerald-300 flex-shrink-0 font-bold uppercase">
              Live cage
            </button>
          </div>
          <p className="text-[8px] text-slate-500 mt-1 leading-snug">
            Telemetry is a recorded loop. Tap <strong className="text-slate-400">Live cage</strong> for real-time SNMP.
          </p>
        </div>
      )}

      {open && (
        <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
          {snapshots.length === 0 ? (
            <p className="text-[9px] text-slate-600 px-2 py-2 leading-relaxed">
              No recordings yet. Log in as admin and use “Record hall for demo” on a live hall.
            </p>
          ) : (
            snapshots.map((s) => (
              <button
                key={s.filename}
                type="button"
                onClick={() => playSnapshot(s.filename)}
                disabled={busy}
                className="w-full text-left p-2 rounded-lg border border-[#233544] bg-[#161E2E]/50 hover:border-[#00E5FF]/40 hover:bg-[#161E2E] transition-all disabled:opacity-50"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-slate-200 truncate">{s.source_hall || s.hall_name}</span>
                  <span className="material-icons-outlined text-[#00E5FF] text-sm flex-shrink-0">play_arrow</span>
                </div>
                <p className="text-[9px] text-slate-500 mt-0.5">
                  {s.pdu_count} PDUs · {s.frame_count} samples · {s.captured_at ? new Date(s.captured_at).toLocaleString() : ''}
                </p>
              </button>
            ))
          )}
        </div>
      )}

      {msg && (
        <p className={`text-[9px] mt-1.5 px-2 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</p>
      )}
    </div>
  );
};

export default RecordReplayControls;
