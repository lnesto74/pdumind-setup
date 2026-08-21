import React, { useCallback, useEffect, useRef, useState } from 'react';
import RecordReplayControls from '../RecordReplayControls';
import PduMonitoringTree from './PduMonitoringTree';

const PRIMARY = [
  { id: 'stencil', label: 'Stencil', icon: 'architecture' },
  { id: 'switchboard', label: 'Switchboard', icon: 'dashboard' },
];

const STENCIL_SUB = [
  { id: 'designer', label: 'Designer', icon: 'view_in_ar' },
  { id: 'assign', label: 'Assign', icon: 'drag_indicator' },
  { id: 'commission', label: 'Commission', icon: 'rocket_launch' },
  { id: 'teams', label: 'Teams', icon: 'groups' },
  { id: 'integrations', label: 'Integrations', icon: 'settings_input_antenna' },
];

const SWITCHBOARD_SUB = [
  { id: 'overview', label: 'Overview', icon: 'hub' },
  { id: 'alarms', label: 'Alarms', icon: 'warning_amber' },
  { id: 'fleet', label: 'Fleet', icon: 'electrical_services' },
];

function SubPill({ item, active, onClick, badge, dot, pillRef }) {
  return (
    <button
      ref={pillRef}
      type="button"
      onClick={onClick}
      title={item.label}
      className={`relative flex-shrink-0 min-w-max flex flex-col items-center gap-1 py-2 px-2.5 rounded-lg border text-[10px] font-bold uppercase tracking-wide transition-all whitespace-nowrap ${
        active
          ? 'bg-[#161E2E] border-[#00E5FF]/45 text-[#00E5FF]'
          : 'border-transparent text-slate-500 hover:text-slate-300 hover:bg-[#161E2E]/50'
      }`}
    >
      <span className="material-icons-outlined text-base">{item.icon}</span>
      <span className="leading-tight">{item.label}</span>
      {badge != null && badge > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[1rem] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-mono flex items-center justify-center">
          {badge}
        </span>
      )}
      {dot && (
        <span className="absolute top-1 right-2 w-1.5 h-1.5 rounded-full bg-emerald-400" title="Connected" />
      )}
    </button>
  );
}

function ScrollableSubNav({ items, activeId, onSelect, getBadge, getDot }) {
  const scrollRef = useRef(null);
  const pillRefs = useRef({});
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanScrollLeft(scrollLeft > 2);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 2);
  }, []);

  const scrollBy = (delta) => {
    scrollRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

  useEffect(() => {
    updateScrollState();
    const el = scrollRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items, updateScrollState]);

  useEffect(() => {
    const node = pillRefs.current[activeId];
    if (node && scrollRef.current) {
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
    const t = setTimeout(updateScrollState, 300);
    return () => clearTimeout(t);
  }, [activeId, items, updateScrollState]);

  return (
    <div className="relative flex items-stretch">
      {canScrollLeft && (
        <button
          type="button"
          aria-label="Scroll tabs left"
          onClick={() => scrollBy(-120)}
          className="absolute left-0 top-0 bottom-0 z-10 w-7 flex items-center justify-center rounded-l-lg bg-gradient-to-r from-[#0B1120] via-[#0B1120]/95 to-transparent text-slate-400 hover:text-[#00E5FF] transition-colors"
        >
          <span className="material-icons-outlined text-lg">chevron_left</span>
        </button>
      )}

      <div
        ref={scrollRef}
        onScroll={updateScrollState}
        className={`flex gap-1 overflow-x-auto scroll-smooth ${canScrollLeft ? 'pl-6' : ''} ${canScrollRight ? 'pr-6' : ''}`}
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {items.map((item) => (
          <SubPill
            key={item.id}
            item={item}
            active={activeId === item.id}
            onClick={() => onSelect(item.id)}
            badge={getBadge?.(item)}
            dot={getDot?.(item)}
            pillRef={(el) => {
              if (el) pillRefs.current[item.id] = el;
              else delete pillRefs.current[item.id];
            }}
          />
        ))}
      </div>

      {canScrollRight && (
        <button
          type="button"
          aria-label="Scroll tabs right"
          onClick={() => scrollBy(120)}
          className="absolute right-0 top-0 bottom-0 z-10 w-7 flex items-center justify-center rounded-r-lg bg-gradient-to-l from-[#0B1120] via-[#0B1120]/95 to-transparent text-slate-400 hover:text-[#00E5FF] transition-colors"
        >
          <span className="material-icons-outlined text-lg">chevron_right</span>
        </button>
      )}

      <style>{`.scroll-smooth::-webkit-scrollbar { display: none; }`}</style>
    </div>
  );
}

export default function DemoNavSidebar({
  primaryMode,
  onPrimaryModeChange,
  stencilSection,
  onStencilSectionChange,
  switchboardSection,
  onSwitchboardSectionChange,
  integrationsConnected,
  globalAlarmCount,
  halls,
  selectedHallId,
  onHallChange,
  selectedHall,
  hallPduCount,
  livePduCount,
  pdus = [],
  pduFilter = 'all',
  onPduFilterChange,
  selectedPduId,
  onSelectPdu,
  pduLiveStatus = {},
  pduAlarms = {},
  pduEnv = {},
  hallLoading = false,
  compact = false,
  isDemoSession = false,
  onReplayLoaded,
  onReplayStopped,
}) {
  const isSwitchboard = primaryMode === 'switchboard';
  // PDU list in Stencil sidebar only — Switchboard Overview needs canvas width; Fleet has its own list
  const showSidebarPduList = !compact && !isSwitchboard;

  if (compact) {
    const subItems = isSwitchboard ? SWITCHBOARD_SUB : STENCIL_SUB;
    const activeSection = isSwitchboard ? switchboardSection : stencilSection;
    const onSubChange = isSwitchboard ? onSwitchboardSectionChange : onStencilSectionChange;

    return (
      <aside className="w-[4.5rem] flex-shrink-0 border-r border-[#233544] bg-[#0B1120] flex flex-col items-center py-3 gap-2 min-h-0">
        {PRIMARY.map((tab) => {
          const active = (tab.id === 'switchboard') === isSwitchboard;
          return (
            <button
              key={tab.id}
              type="button"
              title={tab.label}
              onClick={() => onPrimaryModeChange(tab.id)}
              className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                active
                  ? tab.id === 'switchboard'
                    ? 'bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/40'
                    : 'bg-[#233544] text-white border border-[#475569]'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-[#161E2E]'
              }`}
            >
              <span className="material-icons-outlined text-lg">{tab.icon}</span>
            </button>
          );
        })}

        <div className="w-8 border-t border-[#233544] my-1" />

        {subItems.map((item) => {
          const badge = item.id === 'alarms' ? globalAlarmCount : 0;
          const dot = item.id === 'integrations' && integrationsConnected;
          return (
            <button
              key={item.id}
              type="button"
              title={item.label}
              onClick={() => onSubChange(item.id)}
              className={`relative w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                activeSection === item.id
                  ? 'bg-[#161E2E] text-[#00E5FF] border border-[#00E5FF]/40'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-[#161E2E]/60 border border-transparent'
              }`}
            >
              <span className="material-icons-outlined text-lg">{item.icon}</span>
              {badge > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[1rem] h-4 px-0.5 rounded-full bg-red-500 text-white text-[8px] font-mono flex items-center justify-center">
                  {badge}
                </span>
              )}
              {dot && <span className="absolute bottom-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400" />}
            </button>
          );
        })}
      </aside>
    );
  }

  return (
    <aside className="w-72 flex-shrink-0 border-r border-[#233544] bg-[#0B1120] flex flex-col min-h-0 p-4">
      {/* Primary mode tabs */}
      <div className="flex gap-1 p-1 mb-4 rounded-xl bg-[#161E2E]/60 border border-[#233544]">
        {PRIMARY.map((tab) => {
          const active = (tab.id === 'switchboard') === isSwitchboard;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onPrimaryModeChange(tab.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${
                active
                  ? tab.id === 'switchboard'
                    ? 'bg-gradient-to-r from-[#00E5FF]/25 to-purple-500/20 text-[#00E5FF] border border-[#00E5FF]/30'
                    : 'bg-[#233544] text-white border border-[#475569]'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              <span className="material-icons-outlined text-sm">{tab.icon}</span>
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Sub-navigation */}
      <div className="mb-4">
        <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2">
          {isSwitchboard ? 'Operations' : 'Provisioning'}
        </h3>
        <ScrollableSubNav
          items={isSwitchboard ? SWITCHBOARD_SUB : STENCIL_SUB}
          activeId={isSwitchboard ? switchboardSection : stencilSection}
          onSelect={isSwitchboard ? onSwitchboardSectionChange : onStencilSectionChange}
          getBadge={(item) => (item.id === 'alarms' ? globalAlarmCount : undefined)}
          getDot={(item) => item.id === 'integrations' && integrationsConnected}
        />
      </div>

      {/* Hall selector */}
      <div className="mb-4">
        <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2">Data Hall</h3>
        <select
          value={selectedHallId || ''}
          onChange={(e) => onHallChange(parseInt(e.target.value, 10))}
          className="w-full bg-[#161E2E] border border-[#233544] rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-[#00E5FF]"
        >
          {halls.map((hall) => (
            <option key={hall.id} value={hall.id}>{hall.name}</option>
          ))}
        </select>
        {selectedHall && (
          <p className="text-[9px] text-slate-600 mt-1.5 px-1">
            {livePduCount}/{hallPduCount} live
            {globalAlarmCount > 0 && (
              <span className="text-red-400 ml-2">· {globalAlarmCount} alarm{globalAlarmCount > 1 ? 's' : ''}</span>
            )}
          </p>
        )}
      </div>

      {/* PDU Monitoring — always visible except when Fleet split view owns the list */}
      {showSidebarPduList && (
        <div className="flex-1 flex flex-col min-h-0 mb-4">
          <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2 flex items-center justify-between flex-shrink-0">
            <span>PDU Monitoring</span>
            <span className="text-[#00E5FF] font-mono">{pdus.length}</span>
          </h3>

          <div className="flex gap-1 mb-2 flex-shrink-0">
            {[
              { id: 'all', label: 'All' },
              { id: 'live', label: 'Live' },
              { id: 'offline', label: 'Off' },
            ].map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => onPduFilterChange?.(f.id)}
                className={`flex-1 py-1 text-[9px] rounded uppercase font-bold ${
                  pduFilter === f.id ? 'bg-[#00E5FF]/20 text-[#00E5FF]' : 'text-slate-500 hover:bg-[#161E2E]'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto space-y-1 min-h-0 pr-0.5" style={{ scrollbarWidth: 'thin' }}>
            {hallLoading ? (
              <p className="text-xs text-slate-600 text-center py-4">Loading…</p>
            ) : pdus.length === 0 ? (
              <p className="text-xs text-slate-600 text-center py-4 leading-relaxed">
                No PDUs yet.<br />
                <span className="text-slate-500">Commission via Stencil → Commission</span>
              </p>
            ) : (
              <PduMonitoringTree
                pdus={pdus}
                selectedPduId={selectedPduId}
                onSelectPdu={onSelectPdu}
                pduLiveStatus={pduLiveStatus}
                pduAlarms={pduAlarms}
                pduEnv={pduEnv}
              />
            )}
          </div>

          {!isSwitchboard && pdus.length > 0 && (
            <p className="text-[9px] text-slate-600 mt-2 flex-shrink-0 leading-relaxed">
              Click a PDU to open <span className="text-slate-400">Switchboard → Fleet</span> monitoring.
            </p>
          )}
        </div>
      )}

      {/* Record / Replay controls */}
      <div className="flex-shrink-0">
        <RecordReplayControls
          isDemoSession={isDemoSession}
          selectedHallId={selectedHallId}
          onReplayLoaded={onReplayLoaded}
          onReplayStopped={onReplayStopped}
        />
      </div>

      {/* Context hint */}
      <div className="flex-shrink-0 pt-4 border-t border-[#233544] text-[10px] text-slate-600 leading-relaxed">
        {isSwitchboard ? (
          <>
            <span className="text-slate-400 font-medium">Switchboard</span> — live ops, alarms, fleet PDU detail.
          </>
        ) : (
          <>
            <span className="text-slate-400 font-medium">Stencil</span> — layout, commissioning, ops teams, Telegram.
          </>
        )}
      </div>
    </aside>
  );
}
