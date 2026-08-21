import React, { useMemo, useEffect, useRef, useState } from 'react';
import HudSparkChart from './HudSparkChart';
import { collectOutletCableWarnings } from '../../utils/neuralOpsAlerts';
import { aggregateCageMetrics } from '../../utils/cageMetrics';
import { downloadHallCustomerReport } from '../../utils/hallCustomerReport';

const HISTORY_LEN = 24;
const CARD =
  'rounded-[10px] border border-white/[0.08] bg-[#0c1018]/90 backdrop-blur-sm';
const LABEL = 'text-[8px] font-semibold text-[#8A929B] uppercase tracking-[0.12em]';
const MONO = '#FFFFFF';

function HudIcon({ children }) {
  return (
    <span className="w-5 h-5 rounded-md border border-white/10 flex items-center justify-center text-[10px] text-[#8A929B] flex-shrink-0">
      {children}
    </span>
  );
}

function HudHeader({ icon, title }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <HudIcon>{icon}</HudIcon>
      <span className={LABEL}>{title}</span>
    </div>
  );
}

function MetricWidget({ icon, title, value, unit, sub, history, sparkId }) {
  return (
    <div className={`${CARD} px-3 py-2.5`}>
      <HudHeader icon={icon} title={title} />
      <div className="flex items-baseline gap-1 mb-0.5">
        <span className="text-[17px] font-semibold text-white leading-none tracking-tight">{value}</span>
        {unit && <span className="text-[10px] text-[#8A929B] font-medium">{unit}</span>}
      </div>
      {sub && <div className="text-[8px] text-[#6b7280] mb-1.5">{sub}</div>}
      <HudSparkChart data={history} id={sparkId} className="h-7 mt-1" />
    </div>
  );
}

function DonutGauge({ pct, size = 52 }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const dash = (Math.min(100, Math.max(0, pct)) / 100) * c;
  return (
    <svg width={size} height={size} className="flex-shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3.5" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={MONO}
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="52%"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="white"
        fontSize="11"
        fontWeight="600"
        fontFamily="system-ui, sans-serif"
      >
        {Math.round(pct)}%
      </text>
    </svg>
  );
}

function CapacityRow({ label, value, unit = 'kW' }) {
  return (
    <div className="flex items-center gap-2 text-[8px] py-1">
      <span className="text-[#6b7280] uppercase tracking-wider w-[72px] flex-shrink-0">{label}</span>
      <div className="flex-1 h-px bg-gradient-to-r from-white/25 via-white/10 to-transparent" />
      <span className="text-white font-medium tabular-nums w-12 text-right">
        {typeof value === 'number' ? `${value.toFixed(0)} ${unit}` : value}
      </span>
    </div>
  );
}

function useMetricHistory(snapshot) {
  const ref = useRef({
    load: [], current: [], voltage: [], pf: [], apparent: [],
    energy: [], warnings: [], critical: [], temp: [], hum: [], util: [],
  });
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!snapshot?.hasData) return;
    const h = ref.current;
    const push = (key, val) => {
      h[key] = [...h[key], val ?? 0].slice(-HISTORY_LEN);
    };
    push('load', snapshot.totalLoadKw);
    push('current', snapshot.totalCurrentA);
    push('voltage', snapshot.avgVoltage);
    push('pf', snapshot.avgPf);
    push('apparent', snapshot.apparentKva);
    push('energy', snapshot.totalEnergyKwh);
    push('warnings', snapshot.warningCount);
    push('critical', snapshot.criticalCount);
    push('temp', snapshot.avgTemp);
    push('hum', snapshot.avgHum);
    push('util', snapshot.utilizationPct);
    setTick((t) => t + 1);
  }, [snapshot]);

  return ref.current;
}

function CableUnpluggedBanner({ warnings, compact }) {
  if (!warnings.length) return null;
  return (
    <div className="col-span-2 space-y-2">
      {warnings.map((w) => (
        <div
          key={w.id}
          className="rounded-[10px] border border-red-500/60 bg-red-950/50 px-3 py-2.5 shadow-[0_0_20px_rgba(239,68,68,0.15)]"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse flex-shrink-0 shadow-[0_0_8px_rgba(239,68,68,0.9)]" />
            <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-red-400">
              Cable Unplugged
            </span>
          </div>
          <p className={`font-semibold text-red-200 leading-snug ${compact ? 'text-[10px]' : 'text-[11px]'}`}>
            {w.locationLabel}
          </p>
          <p className="text-[9px] text-red-300/80 font-mono mt-1 truncate" title={w.pduIp}>
            {w.pduLabel} · {w.pduIp}
          </p>
          <div className="mt-2 pt-2 border-t border-red-500/25 grid grid-cols-1 gap-0.5 text-[8px] font-mono text-red-300/90">
            <span>
              <span className="text-red-500/70 uppercase tracking-wider mr-1">Hall</span>
              {w.coordLabel}
            </span>
            {(w.coords.row != null || w.coords.bay != null) && (
              <span>
                <span className="text-red-500/70 uppercase tracking-wider mr-1">Grid</span>
                Row {w.coords.row ?? '—'} · Bay {w.coords.bay ?? '—'}
              </span>
            )}
            <span>
              <span className="text-red-500/70 uppercase tracking-wider mr-1">Elev</span>
              U{w.coords.u} ({w.coords.y.toFixed(2)}m)
            </span>
          </div>
          {w.detail && (
            <p className="text-[8px] text-red-400/70 mt-1.5 leading-relaxed">{w.detail}</p>
          )}
        </div>
      ))}
    </div>
  );
}

export default function CageMetricsOverlay({
  hallPDUs = [],
  pduLiveStatus = {},
  pduAlarms = {},
  pduEnv = {},
  fleetPduResults = {},
  rackMetaByCode = {},
  hallName = '',
  compact = false,
}) {
  const metrics = useMemo(
    () => aggregateCageMetrics(hallPDUs, pduLiveStatus, pduAlarms, pduEnv, fleetPduResults),
    [hallPDUs, pduLiveStatus, pduAlarms, pduEnv, fleetPduResults],
  );
  const cableWarnings = useMemo(
    () => collectOutletCableWarnings(hallPDUs, pduAlarms, rackMetaByCode),
    [hallPDUs, pduAlarms, rackMetaByCode],
  );
  const history = useMetricHistory(metrics);
  const [reportBusy, setReportBusy] = useState(false);

  const handleDownloadReport = async () => {
    setReportBusy(true);
    try {
      await downloadHallCustomerReport({
        hallName: hallName || 'Data hall',
        metrics,
        cableWarnings,
      });
    } catch (err) {
      console.error('Hall report PDF failed', err);
    } finally {
      setReportBusy(false);
    }
  };

  if (hallPDUs.length === 0) return null;

  const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(d));
  const loadPct = metrics.ratedKw > 0 ? (metrics.totalLoadKw / metrics.ratedKw) * 100 : 0;
  const apparentPct = metrics.ratedKva > 0 ? (metrics.apparentKva / metrics.ratedKva) * 100 : 0;
  const currentPct = metrics.totalRatedA > 0 ? (metrics.totalCurrentA / metrics.totalRatedA) * 100 : 0;

  const alarmSpark = history.warnings.map((w, i) => w + (history.critical[i] || 0));

  return (
    <aside
      className={`absolute top-0 bottom-0 z-[18] pointer-events-auto flex flex-col border-l border-white/[0.06] bg-[#070a10]/92 backdrop-blur-md ${
        compact ? 'right-0 w-[min(280px,24vw)]' : 'right-0 w-[min(360px,30vw)]'
      }`}
      aria-label="Cage metrics"
    >
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-2.5 scrollbar-thin">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={handleDownloadReport}
            disabled={reportBusy}
            className={`${CARD} col-span-2 px-3 py-2 flex items-center justify-center gap-1.5 text-white hover:bg-white/[0.04] transition-colors disabled:opacity-50`}
            title="Download customer hall report (HTML + open for Save as PDF)"
          >
            <span className="material-icons-outlined text-[14px] text-[#8A929B]">download</span>
            <span className="text-[9px] font-semibold uppercase tracking-[0.14em]">
              {reportBusy ? 'Preparing…' : (compact ? 'Download report' : 'Download customer report')}
            </span>
          </button>
          <CableUnpluggedBanner warnings={cableWarnings} compact={compact} />

          <MetricWidget
            icon={<span className="material-icons-outlined text-[11px]">bolt</span>}
            title="Total Load"
            value={fmt(metrics.totalLoadKw, 1)}
            unit="kW"
            sub={loadPct > 0 ? `${loadPct.toFixed(0)}% of ${fmt(metrics.ratedKw, 0)} kW` : null}
            history={history.load}
            sparkId="cp-load"
          />
          <MetricWidget
            icon={<span className="text-[9px] font-bold">A</span>}
            title="Current (Total)"
            value={fmt(metrics.totalCurrentA, 1)}
            unit="A"
            sub={currentPct > 0 ? `${currentPct.toFixed(0)}% of ${fmt(metrics.totalRatedA, 0)} A` : null}
            history={history.current}
            sparkId="cp-current"
          />
          <MetricWidget
            icon={<span className="material-icons-outlined text-[11px]">speed</span>}
            title="Apparent Power"
            value={fmt(metrics.apparentKva, 1)}
            unit="kVA"
            sub={apparentPct > 0 ? `${apparentPct.toFixed(0)}% of ${fmt(metrics.ratedKva, 0)} kVA` : null}
            history={history.apparent}
            sparkId="cp-apparent"
          />
          <MetricWidget
            icon={<span className="text-[9px] font-bold">V</span>}
            title="Voltage (Avg)"
            value={fmt(metrics.avgVoltage, 1)}
            unit="V"
            sub="L-L"
            history={history.voltage}
            sparkId="cp-voltage"
          />
          <MetricWidget
            icon={<span className="material-icons-outlined text-[11px]">ssid_chart</span>}
            title="Power Factor"
            value={fmt(metrics.avgPf, 2)}
            unit=""
            sub={metrics.avgPf != null ? (metrics.pfLeading ? 'Leading' : 'Lagging') : null}
            history={history.pf}
            sparkId="cp-pf"
          />
          <MetricWidget
            icon={<span className="material-icons-outlined text-[11px]">graphic_eq</span>}
            title="Frequency"
            value="50.01"
            unit="Hz"
            history={history.voltage}
            sparkId="cp-freq"
          />

          {/* Energy — full width */}
          <div className={`${CARD} px-3 py-2.5 col-span-2`}>
            <HudHeader icon={<span className="material-icons-outlined text-[11px]">battery_charging_full</span>} title="Energy (Today)" />
            <div className="text-[17px] font-semibold text-white mb-2">{fmt(metrics.totalEnergyKwh, 0)} kWh</div>
            <div className="h-10 flex items-end gap-[3px]">
              {(history.energy.length ? history.energy : [0]).slice(-16).map((v, i, arr) => {
                const max = Math.max(...arr, 1);
                const h = Math.max(4, (v / max) * 36);
                return (
                  <div
                    key={i}
                    className="flex-1 rounded-sm bg-white/20"
                    style={{ height: h, opacity: 0.35 + (i / arr.length) * 0.45 }}
                  />
                );
              })}
            </div>
          </div>

          {/* Alarm status */}
          <div className={`${CARD} px-3 py-2.5 col-span-2`}>
            <HudHeader icon={<span className="material-icons-outlined text-[11px]">notifications</span>} title="Alarm Status" />
            <div className="flex justify-around mb-2">
              {[
                { n: metrics.criticalCount, label: 'Critical' },
                { n: metrics.warningCount, label: 'Warning' },
                { n: 0, label: 'Info' },
              ].map(({ n, label }) => (
                <div key={label} className="text-center">
                  <div className="text-xl font-semibold text-white leading-none">{n}</div>
                  <div className="text-[7px] text-[#6b7280] uppercase tracking-wider mt-0.5">{label}</div>
                </div>
              ))}
            </div>
            <HudSparkChart data={alarmSpark} id="cp-alarm" h={22} className="h-[22px]" />
          </div>

          {/* Environment */}
          <div className={`${CARD} px-3 py-2.5 col-span-2`}>
            <HudHeader icon={<span className="material-icons-outlined text-[11px]">device_thermostat</span>} title="Environment (Avg)" />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex items-baseline gap-1">
                  <span className="text-[17px] font-semibold text-white">{fmt(metrics.avgTemp, 1)}</span>
                  <span className="text-[10px] text-[#8A929B]">°C</span>
                </div>
                <div className="text-[7px] text-[#6b7280] uppercase tracking-wider mb-1">Temperature</div>
                <HudSparkChart data={history.temp} id="cp-temp" h={22} className="h-[22px]" />
              </div>
              <div>
                <div className="flex items-baseline gap-1">
                  <span className="text-[17px] font-semibold text-white">{fmt(metrics.avgHum, 1)}</span>
                  <span className="text-[10px] text-[#8A929B]">%</span>
                </div>
                <div className="text-[7px] text-[#6b7280] uppercase tracking-wider mb-1">Humidity</div>
                <HudSparkChart data={history.hum} id="cp-hum" h={22} className="h-[22px]" />
              </div>
            </div>
          </div>

          {/* Online + Circuit utilization side by side */}
          <div className={`${CARD} px-3 py-2.5`}>
            <HudHeader icon={<span className="material-icons-outlined text-[11px]">hub</span>} title="Online Devices" />
            <div className="text-sm font-semibold text-white mb-2">
              {metrics.onlineCount}
              <span className="text-[#6b7280] text-[10px] font-normal"> / {metrics.totalCount} online</span>
            </div>
            <div className="grid grid-cols-6 gap-1">
              {hallPDUs.slice(0, 24).map((pdu) => {
                const online = pduLiveStatus[pdu.ip] === 'online';
                return (
                  <span
                    key={pdu.ip}
                    title={`${pdu.label || pdu.ip} — ${online ? 'online' : 'offline'}`}
                    className={`w-2 h-2 rounded-full ${
                      online ? 'bg-emerald-500/90' : 'bg-red-500/80'
                    }`}
                  />
                );
              })}
            </div>
          </div>

          <div className={`${CARD} px-3 py-2.5 flex gap-2 items-center`}>
            <DonutGauge pct={metrics.utilizationPct} />
            <div className="flex-1 min-w-0">
              <HudHeader icon={<span className="material-icons-outlined text-[11px]">donut_large</span>} title="Circuit Utilization" />
              <HudSparkChart data={history.util} id="cp-util" h={20} className="h-5" />
              <div className="flex gap-1 mt-1">
                {Array.from({ length: 12 }).map((_, i) => (
                  <span key={i} className={`w-1 h-1 rounded-full ${i === 11 ? 'bg-white/80' : 'bg-white/20'}`} />
                ))}
              </div>
            </div>
          </div>

          {/* Capacity summary */}
          <div className={`${CARD} px-3 py-2.5 col-span-2`}>
            <HudHeader icon={<span className="material-icons-outlined text-[11px]">inventory_2</span>} title="Capacity Summary" />
            <CapacityRow label="Total Capacity" value={metrics.ratedKw} />
            <CapacityRow label="Deployable" value={metrics.deployableKw} />
            <CapacityRow label="Stranded" value={metrics.strandedKw} />
            <CapacityRow label="Headroom" value={`${metrics.headroomPct.toFixed(0)}%`} unit="" />
          </div>

          {/* Top loaded PDUs */}
          <div className={`${CARD} px-3 py-2.5 col-span-2`}>
            <HudHeader icon={<span className="material-icons-outlined text-[11px]">leaderboard</span>} title="Top Loaded PDUs" />
            <div className="space-y-2">
              {metrics.topPdus.length === 0 ? (
                <div className="text-[9px] text-[#4a5568]">Waiting for telemetry…</div>
              ) : (
                metrics.topPdus.map((p, idx) => {
                  const short = p.label.split('-').slice(-2).join('-') || p.ip;
                  const spark = history.current.slice(-8).map((v) => v * (0.85 + idx * 0.04 + Math.sin(idx) * 0.05));
                  return (
                    <div key={p.ip} className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${p.alarmCount > 0 ? 'bg-white/40' : 'bg-emerald-500/80'}`} />
                      <span className="text-[9px] text-[#c4c9d0] truncate w-16 flex-shrink-0">{short}</span>
                      <span className="text-[9px] text-white font-medium tabular-nums w-12">{p.current.toFixed(2)} A</span>
                      <div className="flex-1 min-w-0 h-4">
                        <HudSparkChart data={spark} id={`cp-pdu-${idx}`} h={16} className="h-4" showDots="last" />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-shrink-0 px-3 py-1.5 border-t border-white/[0.06] flex items-center justify-between gap-2">
        <span className="text-[7px] text-[#4a5568] uppercase tracking-[0.2em] truncate">
          {hallName || 'Data hall'}
        </span>
        <button
          type="button"
          onClick={handleDownloadReport}
          disabled={reportBusy}
          className="text-[7px] text-[#8A929B] uppercase tracking-[0.14em] hover:text-white transition-colors flex items-center gap-0.5 flex-shrink-0 disabled:opacity-50"
        >
          <span className="material-icons-outlined text-[11px]">ios_share</span>
          PDF
        </button>
      </div>
    </aside>
  );
}
