import { publicFetch } from './api';

/**
 * Fetch for public mobile pages (subscribe, incident links).
 * Uses unpatched fetch and prefers same-origin (:3000 proxy) so Tailscale /
 * LAN links work from phones without hitting localhost:5002.
 */
export async function publicApiFetch(path, options = {}) {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const host = window.location.hostname || 'localhost';
  const protocol = window.location.protocol || 'http:';
  const onLocalhost = host === 'localhost' || host === '127.0.0.1';

  const bases = [
    '', // same host:port as page — vite preview proxies /api → backend
  ];

  if (!onLocalhost) {
    bases.push(`${protocol}//${host}:5002`);
  } else {
    bases.push('http://localhost:5002');
  }

  const envBase = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
  if (envBase && onLocalhost && !bases.includes(envBase)) {
    bases.push(envBase);
  }

  let lastError;
  for (const base of bases) {
    const url = `${base}${cleanPath}`;
    try {
      const res = await publicFetch(url, options);
      return res;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Load failed');
}

export async function publicApiJson(path, options = {}) {
  const res = await publicApiFetch(path, options);
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(res.ok ? 'Invalid server response' : `Server error (${res.status})`);
  }
  if (!res.ok) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json;
}

/**
 * Public incident/subscribe tokens are served by either the production Neural Ops
 * layer (/api/ops/*) or the demo layer (/api/demo/*). A token doesn't say which,
 * so we try ops first then demo and return the prefix that matched so callers can
 * reuse it for follow-up actions (ack/resolve).
 */
export const PUBLIC_LAYER_PREFIXES = ['/api/ops', '/api/demo'];

export async function resolveLayerJson(suffix, options = {}) {
  let lastError;
  for (const prefix of PUBLIC_LAYER_PREFIXES) {
    try {
      const res = await publicApiFetch(`${prefix}${suffix}`, options);
      if (res.ok) {
        const json = await res.json();
        return { json, prefix };
      }
      // 404 (layer disabled / token not in this store) → try the next layer.
      if (res.status !== 404) {
        let body = {};
        try { body = await res.json(); } catch { /* non-JSON */ }
        lastError = new Error(body.error || `Request failed (${res.status})`);
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Incident not found or expired');
}
