import React, { useEffect, useMemo, useState } from 'react';
import { displayPduLabel, groupPdusByChain } from '../../utils/pduChainTree';

function RoleBadge({ role, idx }) {
  if (role === 'master') {
    return (
      <span className="flex-shrink-0 text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#00E5FF]/15 text-[#00E5FF] border border-[#00E5FF]/35">
        Master
      </span>
    );
  }
  if (role === 'slave') {
    return (
      <span className="flex-shrink-0 text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/35">
        Slave{idx ? ` ${idx}` : ''}
      </span>
    );
  }
  return (
    <span className="flex-shrink-0 text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#233544] text-slate-400 border border-[#334155]">
      Unit
    </span>
  );
}

function rowClass(active, alarms) {
  if (active) return 'bg-[#161E2E] border-[#00E5FF]/50 ring-1 ring-[#00E5FF]/20';
  if (alarms > 0) return 'border-red-500/30 bg-red-500/5 hover:bg-red-500/10';
  return 'border-[#233544] hover:border-[#475569] bg-[#161E2E]/40';
}

function PduRow({
  pdu,
  role,
  unitIndex,
  indent = false,
  selectedPduId,
  onSelectPdu,
  pduLiveStatus,
  pduAlarms,
  pduEnv,
  dense,
}) {
  const online = pduLiveStatus[pdu.ip] === 'online';
  const alarms = pduAlarms[pdu.ip]?.count || 0;
  const active = selectedPduId === pdu.id;
  const env = pduEnv[pdu.ip];

  return (
    <button
      type="button"
      onClick={() => onSelectPdu?.(pdu)}
      className={`w-full text-left rounded-lg border transition-all ${
        indent ? 'ml-5 w-[calc(100%-1.25rem)]' : ''
      } ${dense ? 'p-2' : 'p-2.5'} ${rowClass(active, alarms)}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${online ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'}`} />
        <span className="text-xs font-medium text-white truncate flex-1" title={displayPduLabel(pdu)}>
          {displayPduLabel(pdu)}
        </span>
        <RoleBadge role={role} idx={unitIndex} />
        {alarms > 0 && (
          <span className="text-[9px] font-mono font-bold text-red-400 bg-red-500/20 px-1 rounded">{alarms}</span>
        )}
      </div>
      <p className="text-[10px] font-mono text-slate-500 truncate mt-0.5 ml-4">{pdu.ip}</p>
      {env && env.temp != null && env.hum != null && (
        <p className="text-[9px] text-slate-600 truncate ml-4">
          {env.temp}° · {env.hum}%
        </p>
      )}
    </button>
  );
}

export default function PduMonitoringTree({
  pdus = [],
  selectedPduId,
  onSelectPdu,
  pduLiveStatus = {},
  pduAlarms = {},
  pduEnv = {},
  dense = false,
}) {
  const { chains, standalone } = useMemo(() => groupPdusByChain(pdus), [pdus]);
  const [collapsed, setCollapsed] = useState(() => new Set());

  useEffect(() => {
    if (!selectedPduId) return;
    const chain = chains.find(
      (c) =>
        c.master?.id === selectedPduId ||
        c.slaves.some((s) => s.pdu.id === selectedPduId),
    );
    if (!chain) return;
    setCollapsed((prev) => {
      if (!prev.has(chain.stem)) return prev;
      const next = new Set(prev);
      next.delete(chain.stem);
      return next;
    });
  }, [selectedPduId, chains]);

  const allExpanded = chains.length === 0 || chains.every((c) => !collapsed.has(c.stem));

  const toggleStem = (stem, e) => {
    e?.stopPropagation();
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(stem)) next.delete(stem);
      else next.add(stem);
      return next;
    });
  };

  const toggleAll = () => {
    setCollapsed(allExpanded ? new Set(chains.map((c) => c.stem)) : new Set());
  };

  if (pdus.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {chains.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={toggleAll}
            className="text-[9px] font-bold uppercase tracking-wider text-slate-500 hover:text-[#00E5FF] px-1 py-0.5"
          >
            {allExpanded ? 'Collapse all' : 'Expand all'}
          </button>
        </div>
      )}

      {chains.map((chain) => {
        const open = !collapsed.has(chain.stem);
        const master = chain.master;
        const liveSlaves = chain.slaves.filter((s) => pduLiveStatus[s.pdu.ip] === 'online').length;
        const masterOnline = master ? pduLiveStatus[master.ip] === 'online' : false;
        const masterAlarms = master ? pduAlarms[master.ip]?.count || 0 : 0;
        const slaveAlarms = chain.slaves.reduce((n, s) => n + (pduAlarms[s.pdu.ip]?.count || 0), 0);
        const chainAlarms = masterAlarms + slaveAlarms;
        const selectedInChain =
          master?.id === selectedPduId || chain.slaves.some((s) => s.pdu.id === selectedPduId);
        const masterActive = master?.id === selectedPduId;
        const env = master ? pduEnv[master.ip] : null;

        return (
          <div
            key={chain.stem}
            className={`rounded-lg border overflow-hidden ${
              selectedInChain && !masterActive
                ? 'border-[#00E5FF]/25 bg-[#161E2E]/30'
                : 'border-[#233544] bg-[#0B1120]/40'
            }`}
          >
            <div className="flex items-stretch">
              <button
                type="button"
                onClick={(e) => toggleStem(chain.stem, e)}
                className="flex-shrink-0 w-7 flex items-center justify-center text-slate-500 hover:text-[#00E5FF] hover:bg-[#161E2E]"
                title={open ? 'Collapse chain' : 'Expand chain'}
                aria-expanded={open}
              >
                <span className={`material-icons-outlined text-base transition-transform ${open ? 'rotate-90' : ''}`}>
                  chevron_right
                </span>
              </button>

              {master ? (
                <button
                  type="button"
                  onClick={() => onSelectPdu?.(master)}
                  className={`flex-1 min-w-0 text-left ${dense ? 'py-1.5 pr-2' : 'py-2 pr-2.5'} ${
                    masterActive ? 'bg-[#161E2E]' : 'hover:bg-[#161E2E]/60'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${masterOnline ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'}`} />
                    <span className="text-xs font-medium text-white truncate flex-1" title={displayPduLabel(master)}>
                      {displayPduLabel(master)}
                    </span>
                    <RoleBadge role="master" />
                    {chainAlarms > 0 && (
                      <span className="text-[9px] font-mono font-bold text-red-400 bg-red-500/20 px-1 rounded">
                        {chainAlarms}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] font-mono text-slate-500 truncate mt-0.5 ml-4">{master.ip}</p>
                  <p className="text-[9px] text-slate-600 font-mono truncate ml-4">
                    {liveSlaves}/{chain.slaves.length} slaves live
                    {env?.temp != null && env?.hum != null ? ` · ${env.temp}° · ${env.hum}%` : ''}
                  </p>
                </button>
              ) : (
                <div className="flex-1 min-w-0 py-2 pr-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full flex-shrink-0 bg-slate-500" />
                    <span className="text-xs font-medium text-slate-300 truncate flex-1">
                      {chain.stem}
                    </span>
                    <RoleBadge role="master" />
                  </div>
                  <p className="text-[9px] text-slate-600 font-mono truncate ml-4">
                    {liveSlaves}/{chain.slaves.length} slaves live
                  </p>
                </div>
              )}
            </div>

            {open && chain.slaves.length > 0 && (
              <div className="relative pb-1.5 pr-1 space-y-1 border-t border-[#233544]/70 pt-1.5">
                <span className="absolute left-[13px] top-0 bottom-2 w-px bg-[#233544]" aria-hidden />
                {chain.slaves.map(({ pdu, idx }) => (
                  <PduRow
                    key={pdu.id}
                    pdu={pdu}
                    role="slave"
                    unitIndex={idx}
                    indent
                    selectedPduId={selectedPduId}
                    onSelectPdu={onSelectPdu}
                    pduLiveStatus={pduLiveStatus}
                    pduAlarms={pduAlarms}
                    pduEnv={pduEnv}
                    dense={dense}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {standalone.map((pdu) => (
        <PduRow
          key={pdu.id}
          pdu={pdu}
          role="unit"
          selectedPduId={selectedPduId}
          onSelectPdu={onSelectPdu}
          pduLiveStatus={pduLiveStatus}
          pduAlarms={pduAlarms}
          pduEnv={pduEnv}
          dense={dense}
        />
      ))}
    </div>
  );
}
