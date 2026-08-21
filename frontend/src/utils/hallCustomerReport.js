/** Customer hall report — Hyperspace executive PDF (server-side vector A4). */

const API_BASE = import.meta.env.VITE_API_URL || '';

function fmt(v, d = 1) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return Number(v).toFixed(d);
}

function stampLocal(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function slug(name) {
  return String(name || 'hall').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'hall';
}

export function hallReportFilename(hallName, d = new Date()) {
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `pdumind-hall-${slug(hallName)}-${day}.pdf`;
}

function filenameFromDisposition(header, fallback) {
  const m = String(header || '').match(/filename="([^"]+)"/i);
  return m ? m[1] : fallback;
}

/**
 * Same delivery as Hyperspace: backend renders a Helvetica A4 PDF and the
 * browser saves `application/pdf` (not an HTML print dialog).
 */
export async function downloadHallCustomerReport(payload) {
  const body = {
    hallName: payload?.hallName || 'Data hall',
    generatedAt: payload?.generatedAt || stampLocal(),
    metrics: payload?.metrics || {},
    cableWarnings: payload?.cableWarnings || [],
  };
  const fallbackName = hallReportFilename(body.hallName);
  const res = await fetch(`${API_BASE}/api/reporting/hall-customer/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      detail = err.message || err.error || detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get('Content-Disposition'), fallbackName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return name;
}

export { fmt, stampLocal };
