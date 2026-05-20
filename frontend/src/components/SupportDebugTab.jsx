import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = '';

function getToken() {
  return localStorage.getItem('pdumind_token') || '';
}

export default function SupportDebugTab() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError('');
    setCopied(false);
    try {
      const res = await fetch(`${API_BASE}/api/debug/support-report`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to generate report');
        setReport(null);
        return;
      }
      setReport(data);
    } catch {
      setError('Could not reach backend');
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const handleCopy = async () => {
    if (!report?.text) return;
    try {
      await navigator.clipboard.writeText(report.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = report.text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const issueCount = report?.summary?.issues_count ?? 0;
  const hasCritical = (report?.issues || []).some(i => i.startsWith('CRITICAL'));

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Generate a diagnostic report and send it to support via WhatsApp or email.
            No passwords are included — only SET/EMPTY status.
          </p>
          {report && (
            <p className={`text-xs mt-2 font-mono ${hasCritical ? 'text-red-400' : issueCount ? 'text-amber-400' : 'text-emerald-400'}`}>
              {issueCount === 0
                ? 'No issues detected'
                : `${issueCount} issue${issueCount !== 1 ? 's' : ''} found${hasCritical ? ' (action required)' : ''}`}
            </p>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={fetchReport}
            disabled={loading}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-[#00E5FF] border border-[#233544] hover:border-[#00E5FF]/30 transition-colors disabled:opacity-50"
          >
            <span className={`material-icons-outlined text-sm ${loading ? 'animate-spin' : ''}`}>refresh</span>
            Refresh
          </button>
          <button
            onClick={handleCopy}
            disabled={!report?.text || loading}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors disabled:opacity-40 ${
              copied
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-[#00E5FF]/10 text-[#00E5FF] border border-[#00E5FF]/30 hover:bg-[#00E5FF]/20'
            }`}
          >
            <span className="material-icons-outlined text-sm">{copied ? 'check' : 'content_copy'}</span>
            {copied ? 'Copied!' : 'Copy Report'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
          {error}
        </div>
      )}

      {loading && !report && (
        <div className="py-12 text-center text-slate-500 text-xs animate-pulse">
          Running diagnostics…
        </div>
      )}

      {report?.text && (
        <textarea
          readOnly
          value={report.text}
          className="w-full h-[420px] p-4 rounded-xl bg-[#0B1120] border border-[#233544] text-[11px] font-mono text-slate-300 leading-relaxed resize-none focus:outline-none focus:border-[#00E5FF]/40"
          onClick={(e) => e.target.select()}
        />
      )}

      <p className="text-[10px] text-slate-600">
        Tip: click the text box to select all, or use Copy Report. Send the full text to your PDUMind support contact.
      </p>
    </div>
  );
}
