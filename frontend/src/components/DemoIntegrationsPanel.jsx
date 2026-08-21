import React, { useCallback, useEffect, useState } from 'react';
import { notifyDispatchRefresh } from './demo/DemoLiveDispatchPanel';

const API_BASE = import.meta.env.VITE_API_URL || '';

function authHeaders() {
  const token = localStorage.getItem('pdumind_token');
  return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

const INTEGRATION_META = {
  telegram: {
    name: 'Telegram',
    subtitle: 'Instant push alerts via Bot API',
    color: '#229ED9',
    icon: (
      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="currentColor" aria-hidden="true">
        <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.16l-1.89 8.905c-.145.658-.537.818-1.084.508l-3-2.21-1.446 1.394c-.16.16-.295.295-.605.295l.213-3.01 5.562-5.022c.242-.213-.054-.333-.373-.12l-6.87 4.326-2.962-.924c-.64-.203-.654-.64.135-.954l11.566-4.458c.537-.194 1.006.131.832.94z" />
      </svg>
    ),
  },
  email: {
    name: 'Email',
    subtitle: 'SMTP / SendGrid notifications',
    color: '#EA4335',
    icon: (
      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="currentColor" aria-hidden="true">
        <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z" />
      </svg>
    ),
  },
  whatsapp: {
    name: 'WhatsApp',
    subtitle: 'Business API messaging',
    color: '#25D366',
    icon: (
      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="currentColor" aria-hidden="true">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
      </svg>
    ),
  },
};

const STEP_LABELS = {
  CONFIG_UPDATED: 'Settings saved',
  TELEGRAM_TEST: 'Test message sent',
  TELEGRAM_TEST_FAILED: 'Test failed',
  ALARM_NOTIFIED: 'Alarm pushed',
  ALARM_NOTIFY_FAILED: 'Notify failed',
  ALARM_CLEARED: 'Alarm cleared',
  INCIDENT_ACK: 'Mobile ack',
  RESOLVED_CLAIMED: 'Marked resolved',
  SYSTEM_VERIFIED: 'System verified',
};

export default function DemoIntegrationsPanel({ open, onClose, embedded = false, onConnectionChange, apiPrefix = '/api/demo' }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [config, setConfig] = useState(null);
  const [botToken, setBotToken] = useState('');
  const [tokenDirty, setTokenDirty] = useState(false);
  const [chatId, setChatId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [notifyOnAlarm, setNotifyOnAlarm] = useState(true);
  const [frontendBaseUrl, setFrontendBaseUrl] = useState('');

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}${apiPrefix}/integrations`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Failed to load integrations');
      const data = await res.json();
      setConfig(data);
      setChatId(data.telegram?.chat_id || '');
      setEnabled(!!data.telegram?.enabled);
      setNotifyOnAlarm(data.notify_on_alarm !== false);
      setFrontendBaseUrl(data.frontend_base_url || '');
      setBotToken('');
      setTokenDirty(false);
      onConnectionChange?.(!!data?.telegram?.enabled && !!data?.telegram?.configured);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [onConnectionChange, apiPrefix]);

  const buildSaveBody = useCallback(() => {
    const body = {
      telegram: { enabled, chat_id: chatId },
      notify_on_alarm: notifyOnAlarm,
      frontend_base_url: frontendBaseUrl.trim() || undefined,
    };
    if (tokenDirty && botToken.trim()) body.telegram.bot_token = botToken.trim();
    return body;
  }, [enabled, chatId, notifyOnAlarm, frontendBaseUrl, botToken, tokenDirty]);

  const saveConfig = useCallback(async (silent = false) => {
    if (!silent) {
      setSaving(true);
      setError(null);
      setSuccess(null);
    }
    try {
      const res = await fetch(`${API_BASE}${apiPrefix}/integrations`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(buildSaveBody()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setConfig(data);
      setChatId(data.telegram?.chat_id || chatId);
      setBotToken('');
      setTokenDirty(false);
      if (!silent) {
        setSuccess('Integration settings saved to disk');
        setTimeout(() => setSuccess(null), 4000);
      }
      onConnectionChange?.(!!data?.telegram?.enabled && !!data?.telegram?.configured);
      return data;
    } catch (e) {
      if (!silent) setError(e.message);
      throw e;
    } finally {
      if (!silent) setSaving(false);
    }
  }, [buildSaveBody, chatId, onConnectionChange, apiPrefix]);

  useEffect(() => {
    if (embedded || open) fetchConfig();
  }, [embedded, open, fetchConfig]);

  const handleSave = () => saveConfig(false);

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setSuccess(null);
    try {
      // Always persist form first — test reads from server, not the form
      await saveConfig(true);
      const res = await fetch(`${API_BASE}${apiPrefix}/integrations/telegram/test`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        const msg = data.error || (res.status === 404 ? 'API route missing — restart backend container' : 'Test failed');
        throw new Error(msg);
      }
      setSuccess(data.incident_url
        ? `Test sent — open incident link on your phone (no login)`
        : 'Test message sent to Telegram');
      notifyDispatchRefresh();
      fetchConfig();
      setTimeout(() => setSuccess(null), 5000);
    } catch (e) {
      setError(e.message);
    } finally {
      setTesting(false);
    }
  };

  const canTest = chatId.trim() && (config?.telegram?.has_token || (tokenDirty && botToken.trim())) && !saving;

  if (!embedded && !open) return null;

  const body = (
        <div className={`flex-1 overflow-y-auto space-y-5 ${embedded ? '' : 'px-6 py-5'}`}>
          {error && (
            <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">{error}</div>
          )}
          {success && (
            <div className="px-4 py-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm">{success}</div>
          )}

          {loading ? (
            <div className="py-12 text-center text-slate-500 text-sm">
              <span className="material-icons-outlined animate-spin mr-2 align-middle">sync</span>
              Loading integrations…
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                {['telegram', 'email', 'whatsapp'].map((key) => {
                  const meta = INTEGRATION_META[key];
                  const live = key === 'telegram';
                  const active = live && config?.telegram?.enabled && config?.telegram?.configured;
                  const comingSoon = !live;
                  return (
                    <div
                      key={key}
                      className={`relative rounded-xl border p-4 text-center transition-all ${
                        active
                          ? 'border-[#00E5FF]/50 bg-[#00E5FF]/5'
                          : comingSoon
                            ? 'border-[#233544] bg-[#161E2E]/40 opacity-70'
                            : 'border-[#233544] bg-[#161E2E]/60'
                      }`}
                    >
                      {comingSoon && (
                        <span className="absolute top-2 right-2 text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
                          Soon
                        </span>
                      )}
                      {active && (
                        <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-emerald-400 animate-pulse" title="Connected" />
                      )}
                      <div
                        className="mx-auto w-12 h-12 rounded-xl flex items-center justify-center mb-2"
                        style={{ backgroundColor: `${meta.color}22`, color: meta.color }}
                      >
                        {meta.icon}
                      </div>
                      <div className="text-sm font-medium text-slate-200">{meta.name}</div>
                      <div className="text-[10px] text-slate-500 mt-0.5 leading-tight">{meta.subtitle}</div>
                    </div>
                  );
                })}
              </div>

              <div className="rounded-xl border border-[#233544] bg-[#161E2E] p-5 space-y-4">
                {config?.telegram?.configured && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs">
                    <span className="material-icons-outlined text-sm">check_circle</span>
                    <span>
                      Saved — Chat ID <span className="font-mono">{config.telegram.chat_id}</span>
                      {config.telegram.has_token && (
                        <> · Token on disk (…{config.telegram.token_last4 || config.telegram.bot_token_masked?.slice(-4)})</>
                      )}
                      {config.telegram.token_saved_at && (
                        <span className="text-emerald-500/70"> · {new Date(config.telegram.token_saved_at).toLocaleString()}</span>
                      )}
                    </span>
                  </div>
                )}
                {!config?.telegram?.has_token && config?.telegram?.chat_id && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs">
                    <span className="material-icons-outlined text-sm">warning</span>
                    <span>Bot token missing or invalid — paste the full @BotFather token below (not your PDUMind login password).</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                      <span style={{ color: INTEGRATION_META.telegram.color }}>{INTEGRATION_META.telegram.icon}</span>
                      Telegram Bot
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">Create a bot via @BotFather, then paste token &amp; chat ID</p>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <span className="text-xs text-slate-400">Enabled</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      onClick={() => setEnabled(!enabled)}
                      className={`relative w-10 h-5 rounded-full transition-colors ${enabled ? 'bg-[#00E5FF]' : 'bg-[#334155]'}`}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${enabled ? 'left-5' : 'left-0.5'}`} />
                    </button>
                  </label>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
                      Bot token
                      {config?.telegram?.has_token && (
                        <span className="normal-case text-emerald-500/80 ml-1">· saved (leave blank to keep)</span>
                      )}
                    </label>
                    <input
                      type="text"
                      autoComplete="off"
                      name="telegram-bot-api-token"
                      data-lpignore="true"
                      data-1p-ignore="true"
                      data-form-type="other"
                      readOnly
                      onFocus={(e) => e.target.removeAttribute('readOnly')}
                      value={botToken}
                      onChange={(e) => {
                        setBotToken(e.target.value);
                        setTokenDirty(true);
                      }}
                      placeholder={config?.telegram?.has_token ? `Saved — ends …${config.telegram.token_last4 || '????'}` : '123456789:ABCdefGHIjklMNOpqrsTUVwxyz'}
                      className="w-full bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2 text-sm font-mono text-slate-300 focus:outline-none focus:border-[#00E5FF] [font-variant-ligatures:none]"
                      style={{ WebkitTextSecurity: botToken ? 'disc' : 'none' }}
                    />
                    <p className="text-[10px] text-slate-600 mt-1">Paste once from @BotFather — stored in data/demo_integrations.json. Leave blank to keep saved token.</p>
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">Chat ID</label>
                    <input
                      type="text"
                      value={chatId}
                      onChange={(e) => setChatId(e.target.value)}
                      placeholder="-1001234567890"
                      className="w-full bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2 text-sm font-mono text-slate-300 focus:outline-none focus:border-[#00E5FF]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">Mobile link base URL</label>
                  <input
                    type="url"
                    value={frontendBaseUrl}
                    onChange={(e) => setFrontendBaseUrl(e.target.value)}
                    placeholder="http://192.168.1.10:3000"
                    className="w-full bg-[#0B1120] border border-[#233544] rounded-lg px-3 py-2 text-sm font-mono text-slate-300 focus:outline-none focus:border-[#00E5FF]"
                  />
                  <p className="text-[10px] text-slate-600 mt-1">Tailscale or LAN IP — used for Telegram incident + ops subscribe links (not localhost)</p>
                </div>

                <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notifyOnAlarm}
                    onChange={(e) => setNotifyOnAlarm(e.target.checked)}
                    className="rounded border-[#233544] bg-[#0B1120] text-[#00E5FF]"
                  />
                  Push Telegram when demo alarms trigger (temp, door, overload…)
                </label>

                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className="px-4 py-2 rounded-lg bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/40 text-xs font-bold uppercase tracking-wider hover:bg-[#00E5FF]/30 disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={handleTest}
                    disabled={testing || !canTest}
                    className="px-4 py-2 rounded-lg bg-[#233544] text-slate-300 text-xs font-bold uppercase tracking-wider hover:bg-[#334155] disabled:opacity-40"
                  >
                    {testing ? 'Saving & sending…' : 'Save & send test'}
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-dashed border-[#233544] bg-[#161E2E]/30 p-4">
                <p className="text-xs text-slate-500 leading-relaxed">
                  <span className="text-slate-400 font-medium">Email</span> and{' '}
                  <span className="text-slate-400 font-medium">WhatsApp</span> appear above for roadmap preview.
                  Telegram is live in demo — alarms include a mobile-friendly dashboard link.
                </p>
              </div>

              {config?.workflow?.length > 0 && (
                <div>
                  <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2">Workflow ledger</h3>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto">
                    {config.workflow.map((entry, i) => (
                      <div key={`${entry.ts}-${i}`} className="flex items-start gap-2 text-xs px-3 py-2 rounded-lg bg-[#161E2E] border border-[#233544]/60">
                        <span className="material-icons-outlined text-sm text-[#00E5FF] flex-shrink-0 mt-0.5">history</span>
                        <div className="min-w-0 flex-1">
                          <span className="text-slate-300">{STEP_LABELS[entry.step] || entry.step}</span>
                          <span className="text-slate-500"> — {entry.detail}</span>
                        </div>
                        <span className="text-[9px] font-mono text-slate-600 flex-shrink-0">{entry.ts?.slice(11, 19)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
  );

  if (embedded) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto -m-8 p-8">
        <div className="max-w-3xl mx-auto">
          <div className="mb-6">
            <h1 className="text-xl font-bold text-white">Integrations</h1>
            <p className="text-sm text-slate-500 mt-1">Alarm notifications &amp; mobile incident dispatch</p>
          </div>
          {body}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col bg-[#0B1120] border border-[#233544] rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#233544]">
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-[#00E5FF]/10 text-[#00E5FF]">
              <span className="material-icons-outlined">settings</span>
            </span>
            <div>
              <h2 className="text-lg font-semibold text-white">Stencil Integrations</h2>
              <p className="text-xs text-slate-500">Alarm notifications &amp; incident dispatch (demo)</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-white p-1 rounded-lg hover:bg-[#233544]">
            <span className="material-icons-outlined">close</span>
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}
