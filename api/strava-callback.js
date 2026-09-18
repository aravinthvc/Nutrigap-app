// api/strava-callback.js
//
// OAuth callback for Strava. Same pattern as the Fitbit callback — see
// its comments for the security rationale (tokens never reach the
// browser, state param doubles as the user's verified identity + CSRF
// protection). Strava's token response shape differs slightly: it gives
// an absolute `expires_at` (unix seconds) rather than `expires_in`
// (seconds from now), and rotates the refresh token on every exchange.

module.exports = async function handler(req, res) {
  const { code, state, error } = req.query || {};
  const appUrl = 'https://' + (req.headers.host || 'localhost');

  function fail(){
    res.writeHead(302, { Location: appUrl + '/#wearables?wearable_error=strava' });
    res.end();
  }

  if (error || !code || !state) { fail(); return; }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
  const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
    console.error('Strava callback is missing required environment variables.');
    fail();
    return;
  }

  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + state, apikey: SUPABASE_ANON_KEY },
    });
    if (!userRes.ok) throw new Error('Could not verify user session');
    const user = await userRes.json();
    const userId = user.id;

    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new Error('Strava token exchange failed: ' + await tokenRes.text());
    const tokenData = await tokenRes.json();
    const expiresAt = new Date(tokenData.expires_at * 1000).toISOString();

    const connRes = await fetch(SUPABASE_URL + '/rest/v1/wearable_connections?on_conflict=user_id,provider', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        user_id: userId, provider: 'strava',
        access_token: tokenData.access_token, refresh_token: tokenData.refresh_token,
        expires_at: expiresAt, provider_user_id: tokenData.athlete ? String(tokenData.athlete.id) : null,
      }),
    });
    if (!connRes.ok) throw new Error('Could not store Strava tokens: ' + await connRes.text());

    await fetch(SUPABASE_URL + '/rest/v1/wearable_status?on_conflict=user_id,provider', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ user_id: userId, provider: 'strava', connected: true, updated_at: new Date().toISOString() }),
    });

    res.writeHead(302, { Location: appUrl + '/#wearables?connected=strava' });
    res.end();
  } catch (e) {
    console.error('Strava callback error:', e);
    fail();
  }
};
