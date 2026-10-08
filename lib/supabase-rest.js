// lib/supabase-rest.js
//
// A tiny hand-rolled Supabase REST (PostgREST) client for server-side code
// that needs to read/write as the service role -- i.e. bypassing RLS,
// acting on behalf of whichever user_id it's explicitly given. Used by
// api/telegram-webhook.js, which has no browser session/JWT to act as a
// user with (Telegram has no concept of a Supabase auth session), so it
// authenticates as the service role and is careful to always filter every
// query by an already-verified user_id.
//
// This project's other serverless functions (insights.js, dietitian-chat.js,
// read-report.js) intentionally use plain fetch() with no npm dependencies,
// so this file does the same rather than pulling in @supabase/supabase-js
// -- one less thing that has to be added to package.json and installed.
//
// The service-role key is a secret with full database access (it bypasses
// every RLS policy) -- it must only ever be set as a server-side
// environment variable in Vercel, never in index.html or anywhere the
// browser can see it.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qicfpzrvcugmhpqxyecu.supabase.co';

function requireServiceKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    const err = new Error('Server is missing its SUPABASE_SERVICE_ROLE_KEY environment variable.');
    err.userMessage = "Something's misconfigured on the server side -- Aravinth's been notified.";
    throw err;
  }
  return key;
}

function headers(extra) {
  const key = requireServiceKey();
  return Object.assign({
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  }, extra || {});
}

async function request(method, path, opts) {
  opts = opts || {};
  const res = await fetch(SUPABASE_URL + '/rest/v1' + path, {
    method,
    headers: headers(opts.headers),
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Supabase ${method} ${path} failed (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// select(table, { columns, filters, order, limit })
// filters: array of raw PostgREST query fragments, e.g. ['user_id=eq.' + userId]
async function select(table, { columns = '*', filters = [], order, limit } = {}) {
  const params = ['select=' + encodeURIComponent(columns), ...filters];
  if (order) params.push('order=' + order);
  if (limit) params.push('limit=' + limit);
  return request('GET', `/${table}?${params.join('&')}`);
}

async function insert(table, rows, { returning = true } = {}) {
  return request('POST', `/${table}`, {
    body: rows,
    headers: { Prefer: returning ? 'return=representation' : 'return=minimal' },
  });
}

async function update(table, filters, patch, { returning = false } = {}) {
  return request('PATCH', `/${table}?${filters.join('&')}`, {
    body: patch,
    headers: { Prefer: returning ? 'return=representation' : 'return=minimal' },
  });
}

async function remove(table, filters) {
  return request('DELETE', `/${table}?${filters.join('&')}`, {
    headers: { Prefer: 'return=minimal' },
  });
}

// ---------- Supabase Auth Admin (service role only) ----------
//
// Used by api/telegram-webhook.js's self-serve onboarding: a brand-new
// Telegram user has no browser session/JWT to sign up with in the normal
// way, so the webhook creates a real auth.users row directly through the
// Admin API (only the service-role key can call this), starting from a
// synthetic, never-mailed address on the reserved ".invalid" TLD (RFC
// 2606) until the person gives a real email and "claims" the account.
// This hits /auth/v1/admin/users directly rather than going through
// select/insert/update/remove above, since that's a GoTrue endpoint, not
// a PostgREST table.

async function authRequest(method, path, body) {
  const res = await fetch(SUPABASE_URL + '/auth/v1/admin/users' + path, {
    method,
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  if (!res.ok) {
    const err = new Error(`Supabase auth admin ${method} ${path} failed (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// payload: { email, password, email_confirm, user_metadata }
async function authAdminCreateUser(payload) {
  return authRequest('POST', '', payload);
}

// payload: any subset of { email, password, email_confirm, user_metadata }
async function authAdminUpdateUser(userId, payload) {
  return authRequest('PUT', '/' + encodeURIComponent(userId), payload);
}

// ---------- Supabase Storage (service role direct download) ----------
//
// The Telegram bot has no browser session to get a signed URL the normal
// way index.html does for "View original" / "View original file" -- but
// the service-role key can read any object in any bucket directly,
// bypassing RLS entirely (same privilege level as the Admin Auth API
// above), so this just GETs the raw bytes straight from Storage's own REST
// endpoint instead. Scoping to the right person's own files is still
// enforced by the caller -- every query that produces a storage_path
// already filters by a verified user_id (see "Medical documents" in
// api/telegram-webhook.js), same pattern as every other table read here.

function encodeStoragePath(path) {
  // '/' is a real path separator in a storage path (e.g.
  // "<user id>/medical-reports/172...-file.pdf") -- encode each segment on
  // its own so the slashes survive, rather than encoding the whole path and
  // turning them into "%2F".
  return String(path).split('/').map(encodeURIComponent).join('/');
}

async function storageDownload(bucket, path) {
  const key = requireServiceKey();
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(path)}`, {
    headers: { apikey: key, Authorization: 'Bearer ' + key },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Supabase storage download failed (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  return { buffer: buf, contentType };
}

// The reverse of storageDownload -- used by the Telegram bot's new "upload
// a report / prescription from Telegram" flow to write a file straight into
// the same private 'medical-documents' bucket the website uses, as the
// service role (bypassing RLS the same way storageDownload does). The
// caller is responsible for building a path that starts with the right
// user_id folder, same convention index.html uses client-side
// (`${userId}/medical-reports/...` or `${userId}/${visitId}/...`).
async function storageUpload(bucket, path, buffer, contentType) {
  const key = requireServiceKey();
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(path)}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': contentType || 'application/octet-stream',
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Supabase storage upload failed (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }
}

module.exports = {
  select, insert, update, remove, SUPABASE_URL,
  authAdminCreateUser, authAdminUpdateUser,
  storageDownload, storageUpload,
};
