// api/fitbit-callback.js
//
// OAuth callback for Fitbit data — via the Google Health API, which is
// what "Fitbit" now actually means for new integrations (Google retired
// the legacy Fitbit Web API in September 2026 and consolidated Fitbit +
// Google device data into this API). Despite the filename and the
// FITBIT_CLIENT_ID/SECRET env var names (kept for continuity), this talks
// to standard Google OAuth2 endpoints, not Fitbit's old ones.
//
// Exchanges the authorization code for tokens server-side and stores them
// using the Supabase service role key — the browser never sees a Google
// access or refresh token. The user's own Supabase session token is
// passed through OAuth's "state" parameter (it's already an unguessable
// secret tied to their session, so it also doubles as CSRF protection)
// and verified here before anything is stored.

module.exports = async function handler(req, res) {
  const { code, state, error } = req.query || {};
  const appUrl = 'https://' + (req.headers.host || 'localhost');

  function fail(){
    res.writeHead(302, { Location: appUrl + '/#wearables?wearable_error=fitbit' });
    res.end();
  }

  if (error || !code || !state) { fail(); return; }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const FITBIT_CLIENT_ID = process.env.FITBIT_CLIENT_ID; // Google Health API client ID
  const FITBIT_CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET; // Google Health API client secret

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !FITBIT_CLIENT_ID || !FITBIT_CLIENT_SECRET) {
    console.error('Fitbit callback is missing required environment variables.');
    fail();
    return;
  }

  try {
    // 1. Verify the user via the session token passed through `state`.
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + state, apikey: SUPABASE_ANON_KEY },
    });
    if (!userRes.ok) throw new Error('Could not verify user session');
    const user = await userRes.json();
    const userId = user.id;

    // 2. Exchange the authorization code for tokens — standard Google
    // OAuth2 token endpoint, the same one every Google API uses.
    const redirectUri = appUrl + '/api/fitbit-callback';
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: FITBIT_CLIENT_ID,
        client_secret: FITBIT_CLIENT_SECRET,
      }),
    });
    if (!tokenRes.ok) throw new Error('Google token exchange failed: ' + await tokenRes.text());
    const tokenData = await tokenRes.json();
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

    // 3. Store tokens server-side only.
    const connRes = await fetch(SUPABASE_URL + '/rest/v1/wearable_connections?on_conflict=user_id,provider', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        user_id: userId, provider: 'fitbit',
        access_token: tokenData.access_token, refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
      }),
    });
    if (!connRes.ok) throw new Error('Could not store Fitbit tokens: ' + await connRes.text());

    // 4. Update the client-readable status mirror.
    await fetch(SUPABASE_URL + '/rest/v1/wearable_status?on_conflict=user_id,provider', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ user_id: userId, provider: 'fitbit', connected: true, updated_at: new Date().toISOString() }),
    });

    res.writeHead(302, { Location: appUrl + '/#wearables?connected=fitbit' });
    res.end();
  } catch (e) {
    console.error('Fitbit callback error:', e);
    fail();
  }
};
