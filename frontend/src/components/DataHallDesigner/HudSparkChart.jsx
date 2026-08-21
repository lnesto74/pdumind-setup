import React, { useRef, useState, useEffect } from 'react';

export function sparkPath(data, w = 100, h = 28) {
  if (!data?.length) return { line: '', pts: [] };
  const vals = data.filter((v) => v != null && !Number.isNaN(v));
  if (vals.length < 2) return { line: '', pts: [] };
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * w;
    const y = h - 4 - ((v - min) / range) * (h - 8);
    return { x, y };
  });
  const line = `M${pts.map((p) => `${p.x},${p.y}`).join(' L')}`;
  return { line, pts };
}

function sparkArea(data, w, h) {
  const { line } = sparkPath(data, w, h);
  if (!line) return '';
  return `${line} L${w},${h} L0,${h} Z`;
}

export default function HudSparkChart({
  data,
  id,
  h = 28,
  className = '',
  color = '#FFFFFF',
  strokeWidth = 1.2,
  dotRadius = 1.5,
  showDots = 'all', // 'all' | 'last' | 'none'
}) {
  const wrapRef = useRef(null);
  const [w, setW] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setW(Math.max(1, Math.round(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { line, pts } = w > 0 ? sparkPath(data, w, h) : { line: '', pts: [] };
  const area = w > 0 ? sparkArea(data, w, h) : '';

  const dotPts =
    showDots === 'all' ? pts
    : showDots === 'last' && pts.length ? [pts[pts.length - 1]]
    : [];

  if (!line) {
    return (
      <div ref={wrapRef} className={`w-full ${className}`} style={{ height: h }}>
        <div className="h-full flex items-center justify-center text-[8px] text-[#4a5568]">—</div>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={`w-full ${className}`} style={{ height: h }}>
      {w > 0 && (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block">
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${id})`} />
          <path
            d={line}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeOpacity="0.85"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {dotPts.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={dotRadius} fill={color} fillOpacity="0.9" />
          ))}
        </svg>
      )}
    </div>
  );
}
