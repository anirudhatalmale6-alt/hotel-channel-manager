const TOKEN_KEY = 'cm.token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) {
    setToken(null);
    window.location.reload();
    throw new Error('Session expired');
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }

  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function money(n, currency) {
  if (n === null || n === undefined) return '';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
}
