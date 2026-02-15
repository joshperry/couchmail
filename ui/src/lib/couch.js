const BASE = '';

export async function login(name, password) {
  const res = await fetch('/_session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ name, password })
  });
  if (!res.ok) throw new Error('Login failed');
  return res.json();
}

export async function logout() {
  await fetch('/_session', { method: 'DELETE', credentials: 'include' });
}

export async function getSession() {
  const res = await fetch('/_session', { credentials: 'include' });
  return res.json();
}

export async function getDoc(id) {
  const res = await fetch(`/mail/${encodeURIComponent(id)}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to get ${id}`);
  return res.json();
}

export async function putDoc(doc) {
  const res = await fetch(`/mail/${encodeURIComponent(doc._id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(doc)
  });
  if (!res.ok) throw new Error(`Failed to save ${doc._id}`);
  return res.json();
}

export async function deleteDoc(doc) {
  const res = await fetch(`/mail/${encodeURIComponent(doc._id)}?rev=${doc._rev}`, {
    method: 'DELETE',
    credentials: 'include'
  });
  if (!res.ok) throw new Error(`Failed to delete ${doc._id}`);
  return res.json();
}

export async function allDocs(options = {}) {
  const params = new URLSearchParams();
  if (options.startkey) params.set('startkey', JSON.stringify(options.startkey));
  if (options.endkey) params.set('endkey', JSON.stringify(options.endkey));
  if (options.include_docs) params.set('include_docs', 'true');
  const res = await fetch(`/mail/_all_docs?${params}`, { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to list docs');
  return res.json();
}
