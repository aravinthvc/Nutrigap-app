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

module.exports = { select, insert, update, remove, SUPABASE_URL };
