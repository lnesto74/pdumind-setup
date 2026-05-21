import axios from 'axios';

const TOKEN_KEY = 'pdumind_token';

export function getAuthToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

/** Headers for coordinator API calls — attaches JWT when logged in. */
export function authHeaders(extra = {}) {
  const headers = { ...extra };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** fetch() wrapper that sends coordinator auth token on /api/ requests. */
export function authFetch(url, options = {}) {
  const isApi = typeof url === 'string' && url.includes('/api/');
  const isLogin = typeof url === 'string' && url.includes('/api/auth/login');
  if (isApi && !isLogin) {
    options.headers = authHeaders(options.headers || {});
  }
  return fetch(url, options);
}

// Attach token to all axios requests (outlet control, maintenance, etc.)
const api = axios.create({
  baseURL: '',
  timeout: 180000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = getAuthToken();
  if (token && config.url?.includes('/api/') && !config.url?.includes('/api/auth/login')) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Patch global fetch so legacy call sites get auth automatically
const _fetch = window.fetch.bind(window);
window.fetch = (url, options = {}) => {
  const urlStr = typeof url === 'string' ? url : url?.url || '';
  if (urlStr.includes('/api/') && !urlStr.includes('/api/auth/login')) {
    options.headers = authHeaders(options.headers || {});
  }
  return _fetch(url, options);
};

export default api;
