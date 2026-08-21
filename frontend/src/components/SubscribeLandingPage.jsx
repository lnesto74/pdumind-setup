import React, { useEffect, useState } from 'react';
import { resolveLayerJson } from '../publicApi';

export default function SubscribeLandingPage({ token }) {
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    resolveLayerJson(`/teams/invite/${encodeURIComponent(token)}`)
      .then(({ json }) => setInfo(json))
      .catch((e) => setError(e.message || 'Load failed'))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0B1120] text-slate-300 flex items-center justify-center">
        <p className="text-sm">Loading invite…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#0B1120] text-slate-300 flex flex-col items-center justify-center p-6 text-center">
        <span className="material-icons-outlined text-4xl text-red-400 mb-3">link_off</span>
        <h1 className="text-lg font-semibold text-white mb-1">Invite not found</h1>
        <p className="text-sm text-slate-500 max-w-sm">{error}</p>
        <p className="text-[10px] text-slate-600 mt-4 max-w-xs">
          Ensure your phone is on Tailscale and can reach {typeof window !== 'undefined' ? window.location.hostname : 'this host'} on ports 3000 and 5002.
        </p>
      </div>
    );
  }

  const hall = info.hall || {};
  const tgLink = info.telegram_deep_link;

  return (
    <div className="min-h-screen bg-[#0B1120] text-slate-100 flex flex-col items-center justify-center p-6">
      <div className="max-w-md w-full rounded-2xl border border-[#233544] bg-[#161E2E] p-8 text-center shadow-xl">
        <span className="material-icons-outlined text-4xl text-[#00E5FF] mb-4">groups</span>
        <h1 className="text-xl font-bold text-white mb-1">Join ops alerts</h1>
        <p className="text-sm text-slate-400 mb-6">
          Subscribe to <strong className="text-white">{hall.name || 'data hall'}</strong> incident notifications via Telegram.
        </p>

        {tgLink ? (
          <a
            href={tgLink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-2 w-full py-3 px-4 rounded-xl bg-[#0088cc] hover:bg-[#0077b5] text-white font-medium transition-colors"
          >
            <span className="material-icons-outlined">send</span>
            Open in Telegram
          </a>
        ) : (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            Configure a Telegram bot token in PDUMind Integrations first, then return to this link.
          </div>
        )}

        <ol className="text-left text-xs text-slate-500 mt-6 space-y-2 list-decimal list-inside">
          <li>Tap <strong className="text-slate-400">Open in Telegram</strong></li>
          <li>Press <strong className="text-slate-400">Start</strong> in the bot chat</li>
          <li>Choose your discipline and display name</li>
          <li>You may receive PRIMARY round-robin assignments</li>
        </ol>

        <p className="text-[10px] text-slate-600 mt-6 font-mono truncate">
          Hall: {hall.id} · {info.subscribe_payload}
        </p>
      </div>
    </div>
  );
}
