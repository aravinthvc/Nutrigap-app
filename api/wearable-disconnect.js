// api/wearable-disconnect.js
//
// Removes a stored connection. Requires the user's own Supabase session
// token (sent as a normal Authorization header from the app, not the
// OAuth "state" trick used by the callbacks) so nobody can disconnect
// someone else's account.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Server is missing required Supabase environment variables.' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const userToken = authHeader.replace(/^Bearer\s+/i, '');
  const { provider } = req.body || {};
  if (!userToken || !['fitbit','strava'].includes(provider)) {
    res.status(400).json({ error: 'Missing or invalid provider, or not signed in.' });
    return;
  }

  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + userToken, apikey: SUPABASE_ANON_KEY },
    });
    if (!userRes.ok) { res.status(401).json({ error: 'Not signed in.' }); return; }
    const user = await userRes.json();

    await fetch(`${SUPABASE_URL}/rest/v1/wearable_connections?user_id=eq.${user.id}&provider=eq.${provider}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY },
    });

    await fetch(SUPABASE_URL + '/rest/v1/wearable_status?on_conflict=user_id,provider', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ user_id: user.id, provider, connected: false, last_sync_note: null, updated_at: new Date().toISOString() }),
    });

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
