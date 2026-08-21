import React, { useEffect, useMemo, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

const compareIp = (a, b) => {
  const pa = (a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = (b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 4; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
};

const hasWebCredentials = (pdu) => !!(pdu.web_admin_port && pdu.web_admin_user && pdu.web_admin_pass);

const PduBulkRebootModal = ({ hallId, hallName, pdus, onClose, onComplete }) => {
  const sortedPdus = useMemo(
    () => [...(pdus || [])].sort((a, b) => compareIp(a.ip, b.ip)),
    [pdus],
  );

  const rebootableIds = useMemo(
    () => sortedPdus.filter(hasWebCredentials).map(p => p.dbId || p.id),
    [sortedPdus],
  );

  const [selected, setSelected] = useState(() => new Set(rebootableIds));
  const [phase, setPhase] = useState('select'); // select | confirm | running | done
  const [waitForOnline, setWaitForOnline] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    setSelected(new Set(rebootableIds));
  }, [rebootableIds]);

  const togglePdu = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(rebootableIds));
  const deselectAll = () => setSelected(new Set());

  const selectedCount = selected.size;

  const runReboot = async () => {
    setPhase('running');
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/halls/${hallId}/pdus/bulk-reboot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdu_ids: [...selected],
          wait: waitForOnline,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bulk reboot failed');
      setResult(data);
      setPhase('done');
      onComplete?.();
    } catch (e) {
      setError(e.message);
      setPhase('confirm');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg bg-[#0B1120] border border-[#233544] rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#233544]">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span className="material-icons-outlined text-amber-400">restart_alt</span>
              Reboot PDUs
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">{hallName || `Hall ${hallId}`}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={phase === 'running'}
            className="text-slate-500 hover:text-white disabled:opacity-40"
          >
            <span className="material-icons-outlined">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {phase === 'select' && (
            <>
              <p className="text-xs text-slate-400">
                Uses the same <span className="font-mono text-slate-300">reboot.cgi</span> path as
                PDU Settings → Network → Apply &amp; Reboot. Each PDU reboots sequentially (~60 s offline).
              </p>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={selectAll}
                  className="px-2.5 py-1 text-[10px] uppercase tracking-wider rounded bg-[#161E2E] border border-[#233544] text-slate-400 hover:text-white"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={deselectAll}
                  className="px-2.5 py-1 text-[10px] uppercase tracking-wider rounded bg-[#161E2E] border border-[#233544] text-slate-400 hover:text-white"
                >
                  Deselect all
                </button>
                <span className="ml-auto text-[10px] text-slate-500 font-mono">
                  {selectedCount} selected
                </span>
              </div>

              <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                {sortedPdus.map(pdu => {
                  const id = pdu.dbId || pdu.id;
                  const canReboot = hasWebCredentials(pdu);
                  const checked = selected.has(id);
                  return (
                    <label
                      key={id}
                      className={`flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                        canReboot
                          ? checked
                            ? 'bg-amber-500/10 border-amber-500/40'
                            : 'bg-[#0a1222] border-[#233544] hover:border-[#334155]'
                          : 'bg-[#0a1222] border-[#1a2638] opacity-50 cursor-not-allowed'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canReboot}
                        onChange={() => canReboot && togglePdu(id)}
                        className="rounded border-[#233544] bg-[#0B1120] text-amber-400 focus:ring-amber-500/50"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{pdu.label || pdu.ip}</p>
                        <p className="text-[10px] font-mono text-slate-500">{pdu.ip}</p>
                      </div>
                      {!canReboot && (
                        <span className="text-[9px] text-red-400/80 uppercase">no web creds</span>
                      )}
                    </label>
                  );
                })}
              </div>

              {rebootableIds.length === 0 && (
                <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                  No PDUs have complete web credentials in the database. Run Commissioning → Repair first.
                </p>
              )}
            </>
          )}

          {phase === 'confirm' && (
            <div className="space-y-3">
              <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/40">
                <p className="text-sm text-red-300 font-medium flex items-center gap-2">
                  <span className="material-icons-outlined text-base">warning</span>
                  Are you sure?
                </p>
                <p className="text-xs text-red-200/80 mt-2">
                  You are about to reboot <strong>{selectedCount}</strong> PDU{selectedCount === 1 ? '' : 's'}.
                  Each device will be offline for approximately 60 seconds. Connected loads may be affected
                  depending on PDU outlet configuration.
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={waitForOnline}
                  onChange={e => setWaitForOnline(e.target.checked)}
                  className="rounded border-[#233544]"
                />
                Wait for each PDU to come back online before continuing (slower, safer)
              </label>
              {error && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded p-2">{error}</p>
              )}
            </div>
          )}

          {phase === 'running' && (
            <div className="flex flex-col items-center justify-center py-10 text-slate-400">
              <span className="material-icons-outlined text-4xl animate-spin text-amber-400 mb-3">sync</span>
              <p className="text-sm">Rebooting {selectedCount} PDU{selectedCount === 1 ? '' : 's'}…</p>
              <p className="text-xs text-slate-600 mt-1">Do not close this window</p>
            </div>
          )}

          {phase === 'done' && result && (
            <div className="space-y-3">
              <div className={`p-3 rounded-lg border text-sm ${
                result.failed === 0
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
              }`}>
                {result.rebooted} rebooted, {result.failed} failed
                {result.skipped ? `, ${result.skipped} skipped` : ''} of {result.total}
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {(result.results || []).map(r => (
                  <div
                    key={r.id || r.ip}
                    className={`px-3 py-2 rounded text-xs font-mono border ${
                      r.success
                        ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400'
                        : r.skipped
                          ? 'bg-slate-500/5 border-slate-500/20 text-slate-500'
                          : 'bg-red-500/5 border-red-500/20 text-red-400'
                    }`}
                  >
                    {r.ip} — {r.success ? (r.message || 'OK') : (r.error || 'Failed')}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-[#233544]">
          {phase === 'select' && (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={selectedCount === 0}
                onClick={() => { setPhase('confirm'); setError(null); }}
                className="px-4 py-2 bg-amber-500/20 border border-amber-500/50 text-amber-300 rounded-lg text-sm font-bold hover:bg-amber-500/30 disabled:opacity-40 flex items-center gap-2"
              >
                <span className="material-icons-outlined text-sm">restart_alt</span>
                Reboot selected ({selectedCount})
              </button>
            </>
          )}

          {phase === 'confirm' && (
            <>
              <button
                type="button"
                onClick={() => setPhase('select')}
                className="px-4 py-2 text-sm text-slate-400 hover:text-white"
              >
                Back
              </button>
              <button
                type="button"
                onClick={runReboot}
                className="px-4 py-2 bg-red-500/20 border border-red-500/50 text-red-300 rounded-lg text-sm font-bold hover:bg-red-500/30 flex items-center gap-2"
              >
                <span className="material-icons-outlined text-sm">warning</span>
                Yes, reboot now
              </button>
            </>
          )}

          {phase === 'done' && (
            <button
              type="button"
              onClick={onClose}
              className="ml-auto px-4 py-2 bg-[#233544] text-white rounded-lg text-sm hover:bg-[#2D4A5E]"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PduBulkRebootModal;
