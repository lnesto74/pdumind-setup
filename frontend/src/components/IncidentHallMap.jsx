import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

/**
 * Top-down 2D wireframe with pinch/wheel zoom and pan.
 * Defaults to full-hall view; optional one-tap focus on alert rack.
 */
export default function IncidentHallMap({
  hall,
  racks,
  primaryRackCode,
  autoFocusPrimary = false,
}) {
  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const pinchRef = useRef(null);
  const userAdjustedRef = useRef(false);
  const viewInitRef = useRef(null);

  const gridId = useId().replace(/:/g, '');
  const glowId = `glow-red-${gridId}`;

  const hallW = hall?.length_m || 20;
  const hallH = hall?.width_m || 12;
  const pad = 0.8;

  const shapes = useMemo(() => {
    return (racks || []).map((rack) => {
      const w = (rack.width_mm || 600) / 1000;
      const d = (rack.depth_mm || 1000) / 1000;
      const cx = rack.x_m ?? 0;
      const cz = rack.z_m ?? 0;
      return {
        id: rack.rack_code,
        x: cx - w / 2,
        z: cz - d / 2,
        cx,
        cz,
        w,
        d,
        label: rack.label || rack.rack_code?.split('/').pop() || '',
        severity: rack.severity,
        isPrimary: rack.rack_code === primaryRackCode || rack.is_primary,
      };
    });
  }, [racks, primaryRackCode]);

  const primaryShape = shapes.find((s) => s.isPrimary && s.severity) || shapes.find((s) => s.isPrimary);

  const hallCenter = useMemo(() => ({ x: hallW / 2, z: hallH / 2 }), [hallW, hallH]);

  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState(hallCenter);

  const markAdjusted = useCallback(() => {
    userAdjustedRef.current = true;
  }, []);

  const fitHall = useCallback(() => {
    setCenter(hallCenter);
    setZoom(1);
    markAdjusted();
  }, [hallCenter, markAdjusted]);

  const focusPrimary = useCallback(() => {
    if (primaryShape) {
      setCenter({ x: primaryShape.cx, z: primaryShape.cz });
      setZoom(2.5);
    } else {
      fitHall();
    }
    markAdjusted();
  }, [primaryShape, fitHall, markAdjusted]);

  // Initial view once per incident rack — never reset on poll/re-render after user pans/zooms.
  useEffect(() => {
    const initKey = primaryRackCode || '__hall__';
    if (viewInitRef.current === initKey && userAdjustedRef.current) return;
    if (viewInitRef.current === initKey) return;

    viewInitRef.current = initKey;
    userAdjustedRef.current = false;

    if (autoFocusPrimary && primaryShape) {
      setCenter({ x: primaryShape.cx, z: primaryShape.cz });
      setZoom(2.5);
    } else {
      setCenter(hallCenter);
      setZoom(1);
    }
  }, [primaryRackCode, autoFocusPrimary, hallCenter]);

  const viewBox = useMemo(() => {
    const fullW = hallW + pad * 2;
    const fullH = hallH + pad * 2;
    const vbW = fullW / zoom;
    const vbH = fullH / zoom;
    const vbX = center.x + pad - vbW / 2;
    const vbY = center.z + pad - vbH / 2;
    return `${vbX} ${vbY} ${vbW} ${vbH}`;
  }, [hallW, hallH, pad, zoom, center]);

  const clampCenter = useCallback((x, z, zLevel) => {
    const fullW = hallW + pad * 2;
    const fullH = hallH + pad * 2;
    const vbW = fullW / zLevel;
    const vbH = fullH / zLevel;
    const minX = vbW / 2 - pad;
    const maxX = hallW + pad - vbW / 2;
    const minZ = vbH / 2 - pad;
    const maxZ = hallH + pad - vbH / 2;
    return {
      x: Math.max(minX, Math.min(maxX, x)),
      z: Math.max(minZ, Math.min(maxZ, z)),
    };
  }, [hallW, hallH, pad]);

  const onWheel = (e) => {
    e.preventDefault();
    markAdjusted();
    const delta = e.deltaY > 0 ? -0.25 : 0.25;
    setZoom((z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z + delta)));
  };

  const onPointerDown = (e) => {
    if (e.pointerType === 'touch' && pinchRef.current) return;
    markAdjusted();
    dragRef.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startCenter: { ...center },
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scaleX = (hallW + pad * 2) / zoom / rect.width;
    const scaleZ = (hallH + pad * 2) / zoom / rect.height;
    const dx = (e.clientX - drag.startX) * scaleX;
    const dz = (e.clientY - drag.startY) * scaleZ;
    setCenter(clampCenter(drag.startCenter.x - dx, drag.startCenter.z - dz, zoom));
  };

  const onPointerUp = (e) => {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null;
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        markAdjusted();
        const [a, b] = e.touches;
        pinchRef.current = {
          dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
          zoom,
        };
        dragRef.current = null;
      }
    };

    const onTouchMove = (e) => {
      if (e.touches.length === 2 && pinchRef.current) {
        e.preventDefault();
        const [a, b] = e.touches;
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const ratio = dist / pinchRef.current.dist;
        setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchRef.current.zoom * ratio)));
      }
    };

    const onTouchEnd = () => {
      pinchRef.current = null;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [zoom, markAdjusted]);

  return (
    <div className="relative w-full bg-[#060d14]">
      <div
        ref={containerRef}
        className="relative w-full aspect-[5/3] touch-none cursor-grab active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <svg
          viewBox={viewBox}
          className="w-full h-full select-none"
          preserveAspectRatio="xMidYMid meet"
          aria-label="Data hall wireframe map"
        >
          <defs>
            <pattern id={gridId} width="1" height="1" patternUnits="userSpaceOnUse">
              <path d="M 1 0 L 0 0 0 1" fill="none" stroke="#1a2a38" strokeWidth="0.03" />
            </pattern>
            <filter id={glowId}>
              <feGaussianBlur stdDeviation="0.08" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <rect x="0" y="0" width={hallW} height={hallH} fill={`url(#${gridId})`} stroke="#00E5FF" strokeWidth="0.06" strokeDasharray="0.2 0.15" rx="0.1" />
          <line x1="0" y1={hallH / 2} x2={hallW} y2={hallH / 2} stroke="#233544" strokeWidth="0.04" strokeDasharray="0.15 0.2" opacity="0.5" />

          {shapes.map((rack) => {
            const isAlert = !!rack.severity;
            const isCrit = rack.severity === 'critical';
            const fill = isAlert ? (isCrit ? 'rgba(239,68,68,0.35)' : 'rgba(245,158,11,0.3)') : 'rgba(45,74,94,0.25)';
            const stroke = isAlert ? (isCrit ? '#ef4444' : '#f59e0b') : '#2d4a5e';
            const cls = rack.isPrimary && isAlert ? 'incident-rack-blink' : '';

            return (
              <g key={rack.id} className={cls} filter={rack.isPrimary && isCrit ? `url(#${glowId})` : undefined}>
                <rect x={rack.x} y={rack.z} width={rack.w} height={rack.d} fill={fill} stroke={stroke} strokeWidth={rack.isPrimary ? 0.12 : 0.05} rx="0.04" />
                {(zoom >= 1.8 || rack.isPrimary) && rack.label && (
                  <text x={rack.x + rack.w / 2} y={rack.z + rack.d / 2} textAnchor="middle" dominantBaseline="middle" fill={isAlert ? '#fff' : '#64748b'} fontSize={rack.isPrimary ? 0.28 : 0.22} fontFamily="ui-monospace, monospace">
                    {rack.label.replace('Rack-', 'R')}
                  </text>
                )}
                {rack.isPrimary && isAlert && (
                  <text x={rack.x + rack.w / 2} y={rack.z - 0.15} textAnchor="middle" fill="#00E5FF" fontSize="0.2" fontFamily="ui-monospace, monospace">▲ ISSUE</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="absolute top-2 right-2 flex flex-col gap-1 z-10">
        <button type="button" onClick={() => { markAdjusted(); setZoom((z) => Math.min(MAX_ZOOM, z + 0.5)); }} className="w-8 h-8 rounded-lg bg-[#161E2E]/95 border border-[#233544] text-slate-300 text-lg leading-none">+</button>
        <button type="button" onClick={() => { markAdjusted(); setZoom((z) => Math.max(MIN_ZOOM, z - 0.5)); }} className="w-8 h-8 rounded-lg bg-[#161E2E]/95 border border-[#233544] text-slate-300 text-lg leading-none">−</button>
        <button type="button" onClick={fitHall} className="w-8 h-8 rounded-lg bg-[#161E2E]/95 border border-[#233544] text-slate-300 flex items-center justify-center" title="Fit full cage">
          <span className="material-icons-outlined text-sm">fit_screen</span>
        </button>
        {primaryShape && (
          <button type="button" onClick={focusPrimary} className="w-8 h-8 rounded-lg bg-[#00E5FF]/15 border border-[#00E5FF]/40 text-[#00E5FF] flex items-center justify-center" title="Focus alert rack">
            <span className="material-icons-outlined text-sm">my_location</span>
          </button>
        )}
      </div>

      <div className="absolute bottom-2 left-2 right-2 flex items-end justify-between gap-2 pointer-events-none">
        <div className="flex gap-2 text-[8px] font-mono">
          <span className="flex items-center gap-1 text-slate-500"><span className="w-2 h-2 rounded-sm border border-[#2d4a5e] bg-[#2d4a5e]/30" /> OK</span>
          <span className="flex items-center gap-1 text-amber-400"><span className="w-2 h-2 rounded-sm bg-amber-500/40 border border-amber-500" /> Warn</span>
          <span className="flex items-center gap-1 text-red-400"><span className="w-2 h-2 rounded-sm bg-red-500/40 border border-red-500 incident-rack-blink" /> Critical</span>
        </div>
        <span className="text-[8px] font-mono text-slate-600">{Math.round(zoom * 100)}% · drag to pan</span>
      </div>

      <style>{`
        @keyframes incident-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        .incident-rack-blink { animation: incident-blink 1s ease-in-out infinite; }
      `}</style>
    </div>
  );
}
