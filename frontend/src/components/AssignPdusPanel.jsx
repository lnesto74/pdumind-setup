import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

/**
 * AssignPdusPanel — 2D drag-and-drop workspace for placing PDUs into racks.
 *
 * Two stages:
 *   A) Top-down hall map — locate the rack by row/position (no 3D, no orbit).
 *   B) Frontal rack elevation — drag PDUs from the tray onto slot A / B.
 *
 * Backend is untouched: uses /api/halls/<id>/state to read and
 * /api/halls/<id>/pdus/bulk-rack-assign to write (rack_id: null unassigns).
 */
const AssignPdusPanel = ({ selectedHallId, pduLiveStatus = {}, refreshKey = 0, onAssigned }) => {
  const [data, setData] = useState({ config: null, racks: [], pdus: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedRowIndex, setSelectedRowIndex] = useState(null); // null => Stage A (map)
  const [selectedRackCode, setSelectedRackCode] = useState(null);
  const [pickedPduIp, setPickedPduIp] = useState(null); // click-to-place fallback
  const [dragPduIp, setDragPduIp] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const showToast = useCallback((msg, ok = true) => {
    setToast({ msg, ok });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const fetchState = useCallback(async (silent = false) => {
    if (!selectedHallId) { setLoading(false); return; }
    try {
      if (!silent) setLoading(true);
      const res = await fetch(`${API_BASE}/api/halls/${selectedHallId}/state`);
      if (res.ok) {
        const json = await res.json();
        setData({
          config: json.config || null,
          racks: json.racks || [],
          pdus: json.pdus || [],
        });
      }
    } catch (e) {
      console.error('[AssignPdusPanel] fetch failed', e);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [selectedHallId]);

  useEffect(() => { fetchState(); }, [fetchState, refreshKey]);

  // Reset navigation when the hall changes
  useEffect(() => {
    setSelectedRowIndex(null);
    setSelectedRackCode(null);
    setPickedPduIp(null);
  }, [selectedHallId]);

  const { config, racks, pdus } = data;

  // Slot positions derived from hall PDU config — one slot per PDU.
  // A/B mounting => letters (A, B, C, D…); otherwise => numbers (1, 2, 3, 4…).
  const positions = useMemo(() => {
    const mounting = config?.pdu?.mounting || 'A/B';
    const perRack = Math.max(1, config?.pdu?.pdusPerRack ?? 2);
    if (mounting === 'A/B') {
      return Array.from({ length: perRack }, (_, i) => String.fromCharCode(65 + i));
    }
    return Array.from({ length: perRack }, (_, i) => String(i + 1));
  }, [config]);

  // rack_code -> db rack
  const rackByCode = useMemo(() => {
    const m = {};
    racks.forEach((r) => { if (r.rack_code) m[r.rack_code] = r; });
    return m;
  }, [racks]);

  // rack_code -> { position: pdu }
  const occByRack = useMemo(() => {
    const m = {};
    pdus.forEach((p) => {
      if (p.rack_code) {
        if (!m[p.rack_code]) m[p.rack_code] = {};
        m[p.rack_code][p.mount_position || 'A'] = p;
      }
    });
    return m;
  }, [pdus]);

  // Rows grouped from db racks
  const rows = useMemo(() => {
    const m = new Map();
    racks.forEach((r) => {
      const ri = r.row_index ?? 0;
      if (!m.has(ri)) m.set(ri, []);
      m.get(ri).push(r);
    });
    return [...m.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([rowIndex, list]) => ({
        rowIndex,
        racks: list.sort((a, b) => (a.position_index ?? 0) - (b.position_index ?? 0)),
      }));
  }, [racks]);

  // Tray PDUs — unassigned first, then assigned (movable)
  const trayPdus = useMemo(() => {
    return [...pdus].sort((a, b) => {
      const aAssigned = a.rack_code ? 1 : 0;
      const bAssigned = b.rack_code ? 1 : 0;
      if (aAssigned !== bAssigned) return aAssigned - bAssigned;
      return (a.ip_address || '').localeCompare(b.ip_address || '');
    });
  }, [pdus]);

  const unassignedCount = useMemo(
    () => pdus.filter((p) => !p.rack_code).length,
    [pdus]
  );

  const selectedRow = useMemo(
    () => rows.find((r) => r.rowIndex === selectedRowIndex) || null,
    [rows, selectedRowIndex]
  );

  // --- Assignment actions -------------------------------------------------
  const assign = useCallback(async (pduIp, rackId, position) => {
    if (!selectedHallId || !pduIp) return;
    setSaving(true);
    // Optimistic local update
    setData((prev) => ({
      ...prev,
      pdus: prev.pdus.map((p) =>
        p.ip_address === pduIp
          ? {
              ...p,
              rack_id: rackId,
              rack_code: rackId == null
                ? null
                : (racks.find((r) => r.id === rackId)?.rack_code || p.rack_code),
              mount_position: rackId == null ? p.mount_position : position,
            }
          : p
      ),
    }));
    try {
      const res = await fetch(`${API_BASE}/api/halls/${selectedHallId}/pdus/bulk-rack-assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignments: [{ pdu_ip: pduIp, rack_id: rackId, mount_position: position || 'A' }],
        }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        showToast(rackId == null ? `Unassigned ${pduIp}` : `Assigned ${pduIp} → slot ${position}`);
        if (onAssigned) onAssigned();
      } else {
        showToast(json.error || 'Assignment failed', false);
      }
    } catch (e) {
      showToast('Assignment failed', false);
    } finally {
      setSaving(false);
      fetchState(true);
    }
  }, [selectedHallId, racks, fetchState, onAssigned, showToast]);

  const handleDropOnSlot = useCallback((rack, position) => {
    const ip = dragPduIp || pickedPduIp;
    if (!ip) return;
    const occupant = occByRack[rack.rack_code]?.[position];
    if (occupant && occupant.ip_address !== ip) {
      showToast(`Slot ${position} on ${rack.rack_code} is occupied`, false);
      return;
    }
    assign(ip, rack.id, position);
    setPickedPduIp(null);
    setDragPduIp(null);
  }, [dragPduIp, pickedPduIp, occByRack, assign, showToast]);

  const openRack = useCallback((rack) => {
    setSelectedRowIndex(rack.row_index ?? 0);
    setSelectedRackCode(rack.rack_code);
  }, []);

  const backToMap = useCallback(() => {
    setSelectedRowIndex(null);
    setSelectedRackCode(null);
  }, []);

  // --- Render helpers -----------------------------------------------------
  const liveDot = (ip) => {
    const online = pduLiveStatus[ip] === 'online';
    return (
      <span
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
          online ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' : 'bg-slate-600'
        }`}
      />
    );
  };

  const rackFill = (rack) => {
    const occ = occByRack[rack.rack_code] || {};
    const filled = positions.filter((p) => occ[p]).length;
    return { filled, total: positions.length };
  };

  // --- Empty / loading states --------------------------------------------
  if (!selectedHallId) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 text-sm">
        Select a data hall to assign PDUs.
      </div>
    );
  }

  return (
    <div className="h-full flex bg-[#0B1120] min-h-0">
      {/* Main workspace */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Header */}
        <div className="flex-shrink-0 h-12 border-b border-[#233544] px-4 flex items-center justify-between bg-[#0B1120]">
          {selectedRackCode ? (
            <button
              onClick={backToMap}
              className="flex items-center gap-1.5 text-xs font-mono text-slate-400 hover:text-[#00E5FF] transition-colors"
            >
              <span className="material-icons-outlined text-base">arrow_back</span>
              Back to map
            </button>
          ) : (
            <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-wider">
              <span className="material-icons-outlined text-base text-[#00E5FF]">grid_on</span>
              Assign PDUs — locate a rack
            </div>
          )}
          <div className="flex items-center gap-3 text-[10px] font-mono">
            {saving && (
              <span className="text-amber-400 flex items-center gap-1">
                <span className="animate-spin">⟳</span> Saving
              </span>
            )}
            <span className="text-slate-500">
              {selectedRackCode
                ? `Row ${(selectedRowIndex ?? 0) + 1} · drag PDUs into a slot`
                : `${unassignedCount} unassigned · ${pdus.length} total`}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4 min-h-0">
          {loading ? (
            <div className="h-full flex items-center justify-center text-slate-500 text-sm">
              <span className="animate-pulse">Loading layout…</span>
            </div>
          ) : racks.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center gap-2">
              <span className="material-icons-outlined text-4xl text-slate-700">view_in_ar</span>
              <p className="text-slate-400 text-sm">No racks in this hall yet.</p>
              <p className="text-slate-600 text-xs">Use the Data Hall Designer to create racks first.</p>
            </div>
          ) : selectedRackCode ? (
            /* ---------- Stage B: frontal elevation ---------- */
            <div className="flex gap-4 items-start">
              {(selectedRow?.racks || []).map((rack) => {
                const isSelected = rack.rack_code === selectedRackCode;
                const occ = occByRack[rack.rack_code] || {};
                const { filled, total } = rackFill(rack);
                return (
                  <div
                    key={rack.rack_code}
                    onClick={() => { if (!isSelected) setSelectedRackCode(rack.rack_code); }}
                    style={{ width: Math.max(176, positions.length * 72 + 24) }}
                    className={`flex-shrink-0 rounded-xl border transition-all cursor-pointer ${
                      isSelected
                        ? 'border-[#00E5FF] shadow-[0_0_0_1px_rgba(0,229,255,0.3)] bg-[#0d1830]'
                        : 'border-[#233544] bg-[#0d1424] hover:border-[#00E5FF]/40'
                    }`}
                  >
                    {/* Rack header */}
                    <div className="px-3 py-2 border-b border-[#233544] flex items-center justify-between">
                      <span className={`text-xs font-bold font-mono ${isSelected ? 'text-[#00E5FF]' : 'text-slate-300'}`}>
                        {rack.rack_code}
                      </span>
                      <span className="text-[9px] font-mono text-slate-500">{filled}/{total}</span>
                    </div>
                    {/* Rack body — frontal with side rails (slots) */}
                    <div className="relative p-3" style={{ height: 320 }}>
                      {/* faux U-grid */}
                      <div className="absolute inset-3 rounded bg-[#070d18] overflow-hidden">
                        {Array.from({ length: 14 }).map((_, i) => (
                          <div key={i} className="h-[7.14%] border-b border-[#111c2e]" />
                        ))}
                      </div>
                      {/* Slot columns */}
                      <div className="relative h-full flex gap-2">
                        {positions.map((pos) => {
                          const occupant = occ[pos];
                          return (
                            <div
                              key={pos}
                              onDragOver={(e) => { e.preventDefault(); }}
                              onDrop={(e) => { e.preventDefault(); handleDropOnSlot(rack, pos); }}
                              onClick={(e) => { e.stopPropagation(); if (!occupant && (pickedPduIp || dragPduIp)) handleDropOnSlot(rack, pos); }}
                              className={`flex-1 min-w-[56px] rounded-lg flex flex-col items-center justify-center text-center transition-all ${
                                occupant
                                  ? 'bg-[#13233a] border border-[#00E5FF]/30'
                                  : (pickedPduIp || dragPduIp)
                                    ? 'border-2 border-dashed border-[#00E5FF]/60 bg-[#00E5FF]/5 cursor-pointer'
                                    : 'border-2 border-dashed border-[#233544]'
                              }`}
                            >
                              {occupant ? (
                                <div className="flex flex-col items-center gap-1.5 px-1 w-full">
                                  {liveDot(occupant.ip_address)}
                                  <span className="text-[10px] font-mono text-[#00E5FF] break-all leading-tight">
                                    {occupant.ip_address}
                                  </span>
                                  <span className="text-[8px] text-slate-500 break-all leading-tight">
                                    {occupant.model || occupant.label || 'PDU'}
                                  </span>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); assign(occupant.ip_address, null, pos); }}
                                    className="mt-1 text-[8px] text-red-400 hover:text-red-300 flex items-center gap-0.5"
                                    title="Remove from rack"
                                  >
                                    <span className="material-icons-outlined text-[11px]">close</span>
                                    remove
                                  </button>
                                </div>
                              ) : (
                                <span className="text-[10px] font-bold text-slate-600 tracking-wider">
                                  {pos}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* ---------- Stage A: top-down map ---------- */
            <div className="space-y-5">
              {rows.map((row) => (
                <div key={row.rowIndex}>
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
                    Row {row.rowIndex + 1}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {row.racks.map((rack) => {
                      const { filled, total } = rackFill(rack);
                      const full = filled >= total && total > 0;
                      const empty = filled === 0;
                      return (
                        <button
                          key={rack.rack_code}
                          onClick={() => openRack(rack)}
                          title={`${rack.rack_code} — ${filled}/${total} slots filled`}
                          className={`group relative w-20 h-16 rounded-lg border flex flex-col items-center justify-center gap-1 transition-all ${
                            full
                              ? 'border-emerald-500/40 bg-emerald-500/5 hover:border-emerald-400'
                              : empty
                                ? 'border-[#233544] bg-[#0d1424] hover:border-[#00E5FF]/50'
                                : 'border-amber-500/40 bg-amber-500/5 hover:border-amber-400'
                          }`}
                        >
                          <span className="text-[10px] font-mono font-bold text-slate-300 group-hover:text-[#00E5FF] truncate max-w-full px-1">
                            {rack.rack_code}
                          </span>
                          <div className="flex flex-wrap justify-center gap-1 max-w-full px-1">
                            {positions.map((pos) => {
                              const on = !!occByRack[rack.rack_code]?.[pos];
                              return (
                                <span
                                  key={pos}
                                  className={`text-[8px] font-mono px-1 rounded ${
                                    on ? 'bg-[#00E5FF]/20 text-[#00E5FF]' : 'bg-[#1a2535] text-slate-600'
                                  }`}
                                >
                                  {pos}
                                </span>
                              );
                            })}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* PDU tray */}
      <div className="w-72 flex-shrink-0 border-l border-[#233544] bg-[#0B1120] flex flex-col min-h-0">
        <div className="flex-shrink-0 px-4 py-3 border-b border-[#233544]">
          <h3 className="text-xs font-bold text-[#00E5FF] uppercase tracking-wider flex items-center gap-2">
            <span className="material-icons-outlined text-sm">electrical_services</span>
            PDU Tray
          </h3>
          <p className="text-[10px] text-slate-500 mt-1">
            Drag a PDU onto a rack slot, or click to select then click a slot.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
          {trayPdus.length === 0 ? (
            <div className="text-center py-6 text-slate-600 text-xs">No PDUs in this hall.</div>
          ) : (
            trayPdus.map((pdu) => {
              const assigned = !!pdu.rack_code;
              const picked = pickedPduIp === pdu.ip_address;
              return (
                <div
                  key={pdu.ip_address || pdu.id}
                  draggable
                  onDragStart={() => setDragPduIp(pdu.ip_address)}
                  onDragEnd={() => setDragPduIp(null)}
                  onClick={() => setPickedPduIp(picked ? null : pdu.ip_address)}
                  className={`p-2.5 rounded-lg border cursor-grab active:cursor-grabbing transition-all ${
                    picked
                      ? 'border-[#00E5FF] bg-[#00E5FF]/10 ring-1 ring-[#00E5FF]/40'
                      : assigned
                        ? 'border-[#233544] bg-[#0d1424] hover:border-[#00E5FF]/40'
                        : 'border-[#00E5FF]/25 bg-[#0d1830] hover:border-[#00E5FF]/60'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {liveDot(pdu.ip_address)}
                    <span className="text-xs font-mono text-slate-200 flex-1 truncate">{pdu.ip_address}</span>
                    <span className="material-icons-outlined text-slate-600 text-sm">drag_indicator</span>
                  </div>
                  <div className="flex items-center justify-between mt-1 pl-3.5">
                    <span className="text-[10px] text-slate-500 truncate">{pdu.model || pdu.label || 'PDU'}</span>
                    {assigned ? (
                      <span className="text-[9px] font-mono text-amber-400 flex items-center gap-0.5">
                        <span className="material-icons-outlined text-[11px]">place</span>
                        {pdu.rack_code}/{pdu.mount_position || 'A'}
                      </span>
                    ) : (
                      <span className="text-[9px] font-mono text-emerald-400">unassigned</span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-xs font-mono flex items-center gap-2 shadow-xl ${
            toast.ok
              ? 'bg-emerald-500/15 border border-emerald-500/40 text-emerald-300'
              : 'bg-red-500/15 border border-red-500/40 text-red-300'
          }`}
        >
          <span className="material-icons-outlined text-sm">{toast.ok ? 'check_circle' : 'error'}</span>
          {toast.msg}
        </div>
      )}
    </div>
  );
};

export default AssignPdusPanel;
