const BASE = '/_couchmail/api';

// Calls the bridge API; resolves to the JSON body or throws with its error
export async function api(method, path, body) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body !== undefined || method === 'POST') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(BASE + path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const login = (name, password) => api('POST', '/auth/login', { name, password });
export const logout = () => api('POST', '/auth/logout');
export const getSession = () => api('GET', '/auth/session');

export const enc = encodeURIComponent;

export function isAdmin(user) {
  return !!(user && user.roles && user.roles.includes('admin'));
}

// Global admin, or admin of at least one domain
export function canAdminister(user) {
  return isAdmin(user) || !!(user && user.adminDomains && user.adminDomains.length);
}
