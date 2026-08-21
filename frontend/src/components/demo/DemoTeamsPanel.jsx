import React, { useCallback, useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

function authHeaders(jsonBody = false) {
  const token = localStorage.getItem('pdumind_token');
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (jsonBody) headers['Content-Type'] = 'application/json';
  return headers;
}

function fmtSec(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

function DisciplineColumn({ hall, discipline, subscribers, onMove }) {
  const members = (discipline.member_ids || [])
    .map((id) => subscribers.find((s) => s.id === id))
    .filter(Boolean);

  return (
    <div className="rounded-xl border border-[#233544] bg-[#161E2E]/60 p-3 min-w-[140px] flex-shrink-0">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wide">{discipline.label}</span>
        <span className="text-[9px] font-mono text-[#00E5FF]">{members.length}</span>
      </div>
      {discipline.next_primary_name && (
        <p className="text-[9px] text-emerald-400/90 mb-2 truncate" title="Next round-robin primary">
          Next: {discipline.next_primary_name}
        </p>
      )}
      <ul className="space-y-1">
        {members.map((m, idx) => (
          <li
            key={m.id}
            className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded border ${
              m.is_demo_seed
                ? 'border-dashed border-slate-600 text-slate-500'
                : m.telegram_linked
                  ? 'border-emerald-500/30 text-slate-200 bg-emerald-500/5'
                  : 'border-[#233544] text-slate-400'
            }`}
          >
            <span className="truncate flex-1">{m.display_name}</span>
            <span className="flex gap-0.5 flex-shrink-0">
              <button
                type="button"
                disabled={idx === 0}
                onClick={() => onMove(hall.id, discipline.id, m.id, -1)}
                className="text-slate-600 hover:text-white disabled:opacity-30"
                title="Move up in rotation"
              >
                ↑
              </button>
              <button
                type="button"
                disabled={idx === members.length - 1}
                onClick={() => onMove(hall.id, discipline.id, m.id, 1)}
                className="text-slate-600 hover:text-white disabled:opacity-30"
                title="Move down in rotation"
              >
                ↓
              </button>
            </span>
          </li>
        ))}
        {members.length === 0 && (
          <li className="text-[9px] text-slate-600 italic px-1">No members — share invite link</li>
        )}
      </ul>
    </div>
  );
}

export default function DemoTeamsPanel({ apiPrefix = '/api/demo' }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [policyDraft, setPolicyDraft] = useState(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [copiedToken, setCopiedToken] = useState(null);

  const fetchTeams = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}${apiPrefix}/teams`, { headers: authHeaders() });
      let json;
      try {
        json = await res.json();
      } catch {
        throw new Error(res.ok ? 'Invalid response from server' : `Server error (${res.status}) — try refreshing or restart backend`);
      }
      if (!res.ok) throw new Error(json.error || `Failed to load teams (${res.status})`);
      setData(json);
      setPolicyDraft(json.escalation_policy || {});
    } catch (e) {
      setError(e.message || 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchTeams();
  }, [fetchTeams]);

  const moveMember = async (hallId, discipline, memberId, direction) => {
    const hall = data?.org?.halls?.find((h) => h.id === hallId);
    const disc = hall?.disciplines?.find((d) => d.id === discipline);
    if (!disc) return;
    const ids = [...(disc.member_ids || [])];
    const idx = ids.indexOf(memberId);
    const swap = idx + direction;
    if (swap < 0 || swap >= ids.length) return;
    [ids[idx], ids[swap]] = [ids[swap], ids[idx]];
    const res = await fetch(`${API_BASE}${apiPrefix}/teams/pools`, {
      method: 'PUT',
      headers: authHeaders(true),
      body: JSON.stringify({ hall_id: hallId, discipline, member_ids: ids }),
    });
    const json = await res.json();
    if (res.ok) setData(json);
  };

  const savePolicy = async () => {
    setSavingPolicy(true);
    try {
      const res = await fetch(`${API_BASE}${apiPrefix}/teams/escalation`, {
        method: 'PUT',
        headers: authHeaders(true),
        body: JSON.stringify(policyDraft),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Save failed');
      setData(json);
      setPolicyDraft(json.escalation_policy || {});
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingPolicy(false);
    }
  };

  const copyInvite = (hall) => {
    const url = hall.subscribe_url
      || `${(data?.frontend_base_url || '').replace(/\/$/, '')}/subscribe/${hall.invite_url_token || hall.invite_token}`;
    navigator.clipboard?.writeText(url);
    setCopiedToken(hall.id);
    setTimeout(() => setCopiedToken(null), 2000);
  };

  if (loading && !data) {
    return <div className="py-12 text-center text-slate-600 text-sm">Loading ops teams…</div>;
  }

  const org = data?.org || {};
  const subscribers = data?.subscribers || [];
  const activeCount = subscribers.filter((s) => s.status === 'active' && s.telegram_linked).length;

  return (
    <div className="h-full overflow-y-auto p-6 max-w-6xl">
      <div className="mb-6">
        <h2 className="text-lg font-bold text-white flex items-center gap-2">
          <span className="material-icons-outlined text-[#00E5FF]">groups</span>
          Ops Teams
        </h2>
        <p className="text-sm text-slate-500 mt-1 max-w-2xl">
          Round-robin primary assignment per hall × discipline. Technicians self-subscribe via Telegram invite links.
          Escalation runs automatically when primary does not ack in time.
          {data?.frontend_base_url && (
            <span className="block mt-1 text-[10px] font-mono text-slate-600">
              Public links (Tailscale): {data.frontend_base_url}
            </span>
          )}
        </p>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">{error}</div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {[
          { label: 'Site', value: org.site_name || org.name || '—', icon: 'domain' },
          { label: 'Halls', value: (org.halls || []).length, icon: 'meeting_room' },
          { label: 'Roster', value: subscribers.length, icon: 'badge' },
          { label: 'Live Telegram', value: activeCount, icon: 'send' },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-[#233544] bg-[#161E2E] p-4">
            <span className="material-icons-outlined text-slate-500 text-sm">{s.icon}</span>
            <p className="text-2xl font-mono font-bold text-white mt-1">{s.value}</p>
            <p className="text-[10px] uppercase text-slate-500 tracking-wider">{s.label}</p>
          </div>
        ))}
      </div>

      {(org.halls || []).map((hall) => (
        <section key={hall.id} className="mb-8">
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <h3 className="text-sm font-bold text-white">{hall.name}</h3>
            <span className="text-[10px] font-mono text-slate-600">{hall.id}</span>
            <button
              type="button"
              onClick={() => copyInvite(hall)}
              className="ml-auto text-xs px-3 py-1.5 rounded-lg border border-[#00E5FF]/30 text-[#00E5FF] hover:bg-[#00E5FF]/10 flex items-center gap-1"
            >
              <span className="material-icons-outlined text-sm">link</span>
              {copiedToken === hall.id ? 'Copied!' : 'Copy subscribe link'}
            </button>
          </div>
          {hall.subscribe_url && (
            <p className="text-[10px] font-mono text-slate-500 mb-2 truncate" title={hall.subscribe_url}>
              {hall.subscribe_url}
            </p>
          )}
          <div className="flex gap-2 overflow-x-auto pb-2">
            {(hall.disciplines || []).map((disc) => (
              <DisciplineColumn
                key={disc.id}
                hall={hall}
                discipline={disc}
                subscribers={subscribers}
                onMove={moveMember}
              />
            ))}
          </div>
        </section>
      ))}

      <section className="mb-8 rounded-xl border border-[#233544] bg-[#161E2E] p-5">
        <h3 className="text-sm font-bold text-white mb-1 flex items-center gap-2">
          <span className="material-icons-outlined text-amber-400 text-base">schedule</span>
          Escalation policy
        </h3>
        <p className="text-[11px] text-slate-500 mb-4">Agoda defaults — reminder → hall lead → secondary pool → all ops</p>
        {policyDraft && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { key: 'reminder_sec', label: 'Reminder' },
              { key: 'lead_sec', label: 'Hall lead' },
              { key: 'secondary_sec', label: 'Secondary' },
              { key: 'admin_sec', label: 'All ops' },
            ].map(({ key, label }) => (
              <label key={key} className="block">
                <span className="text-[10px] uppercase text-slate-500">{label}</span>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="number"
                    min={30}
                    step={30}
                    value={policyDraft[key] ?? ''}
                    onChange={(e) => setPolicyDraft({ ...policyDraft, [key]: parseInt(e.target.value, 10) || 0 })}
                    className="w-full bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2 text-sm font-mono text-white"
                  />
                  <span className="text-[10px] text-slate-600 whitespace-nowrap">{fmtSec(policyDraft[key])}</span>
                </div>
              </label>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={savePolicy}
          disabled={savingPolicy}
          className="mt-4 px-4 py-2 rounded-lg bg-[#00E5FF]/20 border border-[#00E5FF]/40 text-[#00E5FF] text-sm font-medium hover:bg-[#00E5FF]/30 disabled:opacity-50"
        >
          {savingPolicy ? 'Saving…' : 'Save escalation policy'}
        </button>
      </section>

      <section className="rounded-xl border border-[#233544] bg-[#161E2E]/40 p-5">
        <h3 className="text-sm font-bold text-white mb-3">Subscriber roster</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500 border-b border-[#233544]">
                <th className="pb-2 pr-4">Name</th>
                <th className="pb-2 pr-4">Discipline</th>
                <th className="pb-2 pr-4">Halls</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {subscribers.map((s) => (
                <tr key={s.id} className="border-b border-[#233544]/50 text-slate-300">
                  <td className="py-2 pr-4">{s.display_name}</td>
                  <td className="py-2 pr-4">{s.discipline_label || s.discipline}</td>
                  <td className="py-2 pr-4 font-mono text-[10px]">{(s.hall_ids || []).join(', ')}</td>
                  <td className="py-2">
                    <span className={`px-2 py-0.5 rounded text-[9px] uppercase font-bold ${
                      s.status === 'active' && s.telegram_linked
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : s.is_demo_seed
                          ? 'bg-slate-500/20 text-slate-500'
                          : 'bg-amber-500/20 text-amber-400'
                    }`}>
                      {s.is_demo_seed ? 'demo seed' : s.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-slate-600 mt-3">
          Demo seed members appear in rotation UI only. Live Telegram subscribers replace them when they ack via the bot.
        </p>
      </section>
    </div>
  );
}
