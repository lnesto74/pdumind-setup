import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = '';

function getToken() {
  return localStorage.getItem('pdumind_token') || '';
}

function authHeaders() {
  return { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' };
}

export default function HubSharePanel() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/hub/settings`, { headers: authHeaders() });
      if (res.ok) {
        setSettings(await res.json());
        setError('');
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to load hub settings');
      }
    } catch {
      setError('Cannot reach backend');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const copyLink = async () => {
    if (!settings?.share_url) return;
    try {
      await navigator.clipboard.writeText(settings.share_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copy failed — select the URL manually');
    }
  };

  const toggleViewer = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/hub/settings`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ viewer_enabled: !settings.viewer_enabled }),
      });
      if (res.ok) {
        setSettings(await res.json());
      }
    } catch {}
    setSaving(false);
  };

  if (loading) {
    return <div className="text-xs text-slate-500 animate-pulse py-8 text-center">Loading hub info...</div>;
  }

  if (error && !settings) {
    return <div className="text-xs text-red-400 py-4">{error}</div>;
  }

  const shareUrl = settings?.share_url;

  return (
    <div className="space-y-5">
      <div className="p-4 rounded-xl bg-[#0B1120] border border-[#233544]">
        <h3 className="text-xs font-bold text-[#00E5FF] uppercase tracking-wider mb-1 flex items-center gap-2">
          <span className="material-icons-outlined text-sm">hub</span>
          Coordinator Hub
        </h3>
        <p className="text-[10px] text-slate-500 mb-4">
          Share this link with colleagues on the same network. They get a read-only fleet dashboard — no install needed.
        </p>

        {shareUrl ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 p-3 rounded-lg bg-[#161E2E] border border-[#00E5FF]/30">
              <span className="material-icons-outlined text-[#00E5FF] text-sm shrink-0">link</span>
              <code className="text-xs text-white font-mono flex-1 truncate">{shareUrl}</code>
              <button
                onClick={copyLink}
                className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/40 hover:bg-[#00E5FF]/30 transition-colors"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className="text-[10px] text-slate-600">
              LAN IP: <span className="text-slate-400 font-mono">{settings.lan_ip || 'unknown'}</span>
              {' · '}Host: <span className="text-slate-400 font-mono">{settings.hostname || '—'}</span>
            </p>
          </div>
        ) : (
          <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-400">
            Could not detect LAN IP. Set <code className="font-mono">HUB_LAN_IP</code> in <code className="font-mono">.env</code> and restart Docker.
          </div>
        )}
      </div>

      <div className="flex items-center justify-between p-4 rounded-xl bg-[#0B1120] border border-[#233544]">
        <div>
          <p className="text-xs text-white font-medium">Viewer link enabled</p>
          <p className="text-[10px] text-slate-500 mt-0.5">When off, /view shows access denied</p>
        </div>
        <button
          onClick={toggleViewer}
          disabled={saving}
          className={`relative w-11 h-6 rounded-full transition-colors ${settings?.viewer_enabled ? 'bg-emerald-500/80' : 'bg-slate-600'}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${settings?.viewer_enabled ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      </div>

      <div className="p-4 rounded-xl bg-[#0B1120] border border-[#233544]">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Setup checklist</p>
        <ul className="space-y-2 text-[10px] text-slate-400">
          <li className="flex items-start gap-2">
            <span className="material-icons-outlined text-emerald-400 text-xs mt-0.5">check_circle</span>
            Keep PDUMind running on this laptop while colleagues view
          </li>
          <li className="flex items-start gap-2">
            <span className="material-icons-outlined text-emerald-400 text-xs mt-0.5">check_circle</span>
            Allow inbound TCP 3000 on Windows Firewall (Private network)
          </li>
          <li className="flex items-start gap-2">
            <span className="material-icons-outlined text-emerald-400 text-xs mt-0.5">check_circle</span>
            Colleagues open the link in Chrome — bookmark it
          </li>
        </ul>
      </div>
    </div>
  );
}
