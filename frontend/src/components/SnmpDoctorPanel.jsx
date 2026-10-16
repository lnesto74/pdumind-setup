import Icon from './presentation/Icon';
import React, { useEffect, useMemo, useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

const VERDICT = {
  pass: { label: 'SNMP OK', cls: 'text-emerald-400', icon: 'check_circle' },
  fixed: { label: 'Fixed', cls: 'text-emerald-300', icon: 'build' },
  failed: { label: 'Failed', cls: 'text-red-400', icon: 'error' },
  not_tested: { label: 'OK last time', cls: 'text-slate-400', icon: 'history' },
};

const subnetOf = (ip) => (ip || '').split('.').slice(0, 3).join('.');

/**
 * One button: scan the hall (max 60 s), then SNMPv3-test and fix every PDU it reaches.
 * Batch when several answer (customer VPN / switch), one at a time on a local cable.
 */
const SnmpDoctorPanel = ({ hallId, hallName, targets = [], https = false, consoleUser = '', consolePass = '' }) => {
  const gwKey = `pdumind_doctor_gw_${hallId || 'default'}`;
  const [gateways, setGateways] = useState(() => {
    try { return JSON.parse(localStorage.getItem(gwKey) || '{}'); } catch { return {}; }
  });
  const [allowReboot, setAllowReboot] = useState(true);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const pollRef = useRef(null);

  const subnets = useMemo(() => {
    const ips = [...targets.map(t => t.ip), ...(job?.items || []).map(i => i.ip)];
    return [...new Set(ips.filter(Boolean).map(subnetOf))].sort();
  }, [targets, job]);

  const [learned, setLearned] = useState({});

  const loadLearned = async () => {
    if (!hallId) return;
    try {
      const r = await fetch(`${API_BASE}/api/commission/snmp-doctor/gateways?hall_id=${hallId}`);
      const d = await r.json();
      if (!r.ok) return;
      const lg = d.gateways || {};
      setLearned(lg);
      setGateways(g => {
        const next = { ...g };
        for (const [sn, info] of Object.entries(lg)) {
          if (!next[sn] || !next[sn].startsWith(`${sn}.`)) next[sn] = info.gateway;
        }
        return next;
      });
    } catch {}
  };

  useEffect(() => { loadLearned(); }, [hallId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (job?.status === 'done') loadLearned(); }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearInterval(pollRef.current), []);

  const running = job && job.status !== 'done';
  const badGateway = subnets.find(sn => gateways[sn] && !gateways[sn].startsWith(`${sn}.`));

  const start = async (onlyIp = null) => {
    setError(null);
    if (badGateway) {
      setError(`Gateway ${gateways[badGateway]} is not on ${badGateway}.x — fix it before running.`);
      return;
    }
    try { localStorage.setItem(gwKey, JSON.stringify(gateways)); } catch {}
    try {
      const res = await fetch(`${API_BASE}/api/commission/snmp-doctor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hall_id: hallId,
          targets,
          gateways,
          allow_reboot: allowReboot,
          only_ip: onlyIp,
          https,
          console_user: consoleUser,
          console_pass: consolePass,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.job_id) throw new Error(data.error || `HTTP ${res.status}`);
      setJob({ status: 'running', phase: 'scan', total: data.total, scanned: 0, items: [] });
      clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`${API_BASE}/api/commission/snmp-doctor/${data.job_id}`);
          const st = await r.json();
          if (!r.ok) throw new Error(st.error || `HTTP ${r.status}`);
          setJob(st);
          if (st.status === 'done') clearInterval(pollRef.current);
        } catch (e) {
          clearInterval(pollRef.current);
          setError(e.message);
        }
      }, 1500);
    } catch (e) {
      setError(e.message);
    }
  };

  const items = job?.items || [];
  const good = items.filter(i => i.verdict === 'pass' || i.verdict === 'fixed').length;
  const phaseText = !job ? '' : job.phase === 'scan'
    ? `Looking for PDUs (max ${job.scan_seconds || 60} s) — ${job.scanned || 0}/${job.total || 0} checked`
    : job.phase === 'fixing'
      ? `${job.mode === 'batch' ? 'Batch' : 'Local'}: testing and fixing ${job.found} PDU(s)`
      : job.phase === 'done' ? `${good}/${job.total} PDUs SNMP OK` : 'Starting…';

  return (
    <div className="p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <p className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
            <Icon className="material-icons-outlined text-sm">verified</Icon>
            SNMP test &amp; fix — {hallName || `Hall #${hallId}`}
          </p>
          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
            Sends the same SNMPv3 query the customer's NMS sends (user, SHA, AES, authPriv) to every PDU of this hall.
            Anything that differs from the inventory — SNMPv3, gateway, DNS, SNTP, hostname{https ? ', HTTPS' : ''}{consoleUser ? `, console user ${consoleUser}` : ''} — is rewritten
            with one reboot at most, and the PDU only passes when SNMPv3 answers with telemetry.
            On the customer VPN it does all PDUs at once; on a local cable, the one you are plugged into.
          </p>
          {consoleUser && !consolePass && (
            <p className="text-[11px] text-amber-300 mt-1">Type the console password below so a missing {consoleUser} user can be added.</p>
          )}
        </div>
        <button
          onClick={() => start()}
          disabled={running || !hallId}
          className="px-4 py-2.5 bg-emerald-500/20 border border-emerald-500/50 hover:bg-emerald-500/30 disabled:opacity-50 text-emerald-200 rounded-lg text-sm flex items-center gap-2"
        >
          <Icon className={`material-icons-outlined text-sm ${running ? 'animate-spin' : ''}`}>{running ? 'sync' : 'play_arrow'}</Icon>
          {running ? 'Working…' : 'Test & fix SNMP'}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {subnets.map(sn => {
          const val = gateways[sn] || '';
          const wrong = val && !val.startsWith(`${sn}.`);
          const info = learned[sn];
          return (
            <div key={sn}>
              <label className="text-[10px] text-slate-500 uppercase">Gateway {sn}.x</label>
              <input
                value={val}
                placeholder={info ? info.gateway : 'learned from a working PDU'}
                onChange={e => setGateways(g => ({ ...g, [sn]: e.target.value.trim() }))}
                className={`block w-36 bg-app-bg border rounded px-2 py-1.5 text-white font-mono text-xs ${wrong ? 'border-red-500' : 'border-px-stroke'}`}
              />
              <p className={`text-[10px] mt-0.5 max-w-[9rem] truncate ${wrong ? 'text-red-400' : 'text-slate-500'}`}
                title={info ? `Learned from ${info.from.join(', ')}` : ''}>
                {wrong ? `not on ${sn}.x` : info && val === info.gateway ? `from ${info.from[0]}` : info ? `learned: ${info.gateway}` : 'not learned yet'}
              </p>
            </div>
          );
        })}
        <label className="flex items-center gap-2 text-[11px] text-amber-200 pb-1.5">
          <input type="checkbox" checked={allowReboot} onChange={e => setAllowReboot(e.target.checked)} />
          Reboot the PDU controller if still failing
        </label>
      </div>

      {error && <p className="text-[11px] text-red-300">{error}</p>}

      {job && (
        <div className="space-y-2">
          <p className="text-[11px] text-slate-300">{phaseText}</p>
          {job.message && (
            <div className={`p-2 rounded border text-[11px] leading-relaxed ${job.mode === 'none' ? 'border-amber-500/40 bg-amber-500/10 text-amber-200' : 'border-px-stroke bg-app-bg text-slate-200'}`}>
              {job.message}
            </div>
          )}
          {items.length > 0 && (
            <div className="max-h-[320px] overflow-y-auto rounded-lg border border-px-stroke">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-app-bg text-slate-500 text-[11px] uppercase">
                  <tr>
                    <th className="text-left px-2 py-1.5">Hostname</th>
                    <th className="text-left px-2 py-1.5">IP</th>
                    <th className="text-left px-2 py-1.5">Result</th>
                    <th className="text-left px-2 py-1.5">Cause / action</th>
                    <th className="px-2 py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(i => {
                    const v = VERDICT[i.verdict];
                    const isNext = job.next && job.next.ip === i.ip;
                    return (
                      <React.Fragment key={i.ip}>
                        <tr
                          onClick={() => setOpen(open === i.ip ? null : i.ip)}
                          className={`border-t border-px-stroke/60 cursor-pointer hover:bg-px-accent/5 ${isNext ? 'bg-amber-500/10' : ''}`}
                        >
                          <td className="px-2 py-1.5 font-mono text-slate-300">
                            {isNext && <Icon className="material-icons-outlined text-[13px] text-amber-300 mr-1 align-middle" title="Plug in here next">cable</Icon>}
                            {i.hostname}{!i.in_db && <span className="text-amber-400 ml-1" title="In the inventory but not in the hall">·sheet</span>}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-px-accent">{i.ip}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap">
                            {v
                              ? <span className={`${v.cls} flex items-center gap-1`}><Icon className="material-icons-outlined text-[13px]">{v.icon}</Icon>{v.label}</span>
                              : <span className="text-slate-500">{i.step || '…'}</span>}
                          </td>
                          <td className="px-2 py-1.5 text-slate-400">
                            {i.cause}
                            {i.advice && <span className="block text-amber-200/90">{i.advice}</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            {!running && i.verdict !== 'pass' && (
                              <button
                                onClick={(e) => { e.stopPropagation(); start(i.ip); }}
                                className="text-[11px] text-slate-500 hover:text-emerald-300"
                                title="Test and fix only this PDU"
                              >retry</button>
                            )}
                          </td>
                        </tr>
                        {open === i.ip && (i.checks || []).length > 0 && (
                          <tr className="bg-app-bg/60">
                            <td colSpan={5} className="px-3 py-2">
                              {(i.checks || []).map(c => (
                                <div key={c.id} className="flex gap-2 text-[11px]">
                                  <span className={c.status === 'pass' ? 'text-emerald-400' : 'text-red-400'}>{c.status === 'pass' ? '✓' : '✗'}</span>
                                  <span className="text-slate-300 w-48 shrink-0">{c.label}</span>
                                  <span className="text-slate-500">{c.detail}</span>
                                </div>
                              ))}
                              {(i.fixes || []).length > 0 && (
                                <p className="text-[11px] text-emerald-300 mt-1">Applied: {i.fixes.join(', ')}</p>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SnmpDoctorPanel;
