// api/wearable-sync.js
//
// Pulls recent activity from Fitbit (via the Google Health API) or Strava
// and writes it into the same activity_entries table the manual Activity
// Log uses, tagged with source='fitbit'/'strava' and an external_id so
// re-syncing never creates duplicates (activity_entries has a unique
// index on (user_id, source, external_id) — see 08_wearable_integrations.sql).
//
// "Fitbit" here means Google Health API's `exercise` data type — Google
// retired the legacy Fitbit Web API in September 2026. This is a discrete
// workout-session model (like Strava's), so the sync logic mirrors the
// Strava path closely.
//
// IMPORTANT CAVEAT: written against Google's documented API shape, but
// not yet exercised against a live connected account. The EXERCISE_TYPE_MAP
// below is a best guess at Google's exerciseType enum values — Google's
// docs give a few examples (RUNNING, WALKING, BIKING, AEROBIC_WORKOUT) but
// not a full table, so real synced data may reveal types that fall
// through to the generic fallback and should be added here once seen.

async function verifyUser(SUPABASE_URL, SUPABASE_ANON_KEY, userToken){
  const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + userToken, apikey: SUPABASE_ANON_KEY },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getConnection(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, userId, provider){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/wearable_connections?user_id=eq.${userId}&provider=eq.${provider}&select=*`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

async function storeConnection(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, userId, provider, tokenData, expiresAt){
  await fetch(SUPABASE_URL + '/rest/v1/wearable_connections?on_conflict=user_id,provider', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY, Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      user_id: userId, provider, access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token, expires_at: expiresAt,
    }),
  });
}

async function refreshFitbitToken(conn, FITBIT_CLIENT_ID, FITBIT_CLIENT_SECRET){
  // Google's token endpoint — same one used for the initial exchange.
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: conn.refresh_token,
      client_id: FITBIT_CLIENT_ID,
      client_secret: FITBIT_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error('Google token refresh failed: ' + await res.text());
  const tokenData = await res.json();
  // Google normally does NOT return a new refresh_token on a refresh call —
  // only the original one from first consent stays valid. Preserve it, or
  // the next refresh would have nothing to refresh with.
  if (!tokenData.refresh_token) tokenData.refresh_token = conn.refresh_token;
  return { tokenData, expiresAt: new Date(Date.now() + tokenData.expires_in * 1000).toISOString() };
}

async function refreshStravaToken(conn, STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET){
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token', refresh_token: conn.refresh_token,
    }),
  });
  if (!res.ok) throw new Error('Strava token refresh failed: ' + await res.text());
  const tokenData = await res.json();
  return { tokenData, expiresAt: new Date(tokenData.expires_at * 1000).toISOString() };
}

function dateStr(d){ return d.toISOString().slice(0,10); }

// Best-effort Google Health `exerciseType` -> our activities.keywords
// mapping. Google's docs give RUNNING, WALKING, BIKING, and
// AEROBIC_WORKOUT as example values but not a full enum table — this
// covers the common ones; anything unmapped falls back to a generic
// "Synced" activity rather than being dropped.
const EXERCISE_TYPE_MAP = {
  RUNNING: 'run', WALKING: 'brisk walk', HIKING: 'hiking', BIKING: 'cycling',
  SWIMMING: 'swim', STRENGTH_TRAINING: 'weight training', WEIGHT_TRAINING: 'weight training',
  YOGA: 'yoga', AEROBIC_WORKOUT: 'crossfit', ELLIPTICAL: 'elliptical',
  ROWING: 'rowing', DANCING: 'dancing', TENNIS: 'tennis', BASKETBALL: 'basketball',
  SOCCER: 'soccer', GOLF: 'golf', BADMINTON: 'badminton', STAIR_CLIMBING: 'stair climbing',
  SPINNING: 'moderate cycling', HIIT: 'crossfit',
};

// Google's Duration format is a string like "1800s" — strip the trailing "s".
function parseDurationSeconds(s){
  if (!s) return 0;
  const n = parseFloat(String(s).replace(/s$/i, ''));
  return isNaN(n) ? 0 : n;
}

async function syncFitbitExerciseSessions(ctx){
  const { userId, accessToken, activitiesByKeyword } = ctx;
  const fallback = activitiesByKeyword['fitbit moderate'];

  // Deliberately no server-side filter here. `exercise` is a Session-kind
  // record (unlike interval types like steps), and session filtering uses
  // a different field convention that isn't fully documented — a first
  // attempt using the interval-type convention (interval.start_time)
  // failed with INVALID_DATA_POINT_FILTER against the live API. Rather
  // than guess again, fetch recent sessions unfiltered and restrict to
  // the last 7 days in code below — avoids depending on getting Google's
  // exact filter syntax right for this specific record kind.
  const since = new Date(); since.setDate(since.getDate() - 7);
  const url = `https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints?pageSize=50`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } });
  if (!res.ok) throw new Error('Google Health exercise fetch failed: ' + await res.text());
  const data = await res.json();
  const points = (data.dataPoints || []).filter(p => {
    const startTime = p.exercise && p.exercise.interval && p.exercise.interval.startTime;
    return startTime && new Date(startTime) >= since;
  });

  return points.map(p => {
    const ex = p.exercise;
    if (!ex || !ex.interval || !ex.interval.startTime) return null;
    const durationMin = Math.round(parseDurationSeconds(ex.activeDuration) / 60);
    if (durationMin <= 0) return null;
    const kw = EXERCISE_TYPE_MAP[ex.exerciseType];
    const matched = (kw && activitiesByKeyword[kw]) || fallback;
    if (!matched) return null;
    const summary = ex.metricsSummary || {};
    const calories = summary.caloriesKcal ? Math.round(summary.caloriesKcal) : Math.round(matched.met * 70 * (durationMin/60));
    return {
      user_id: userId, entry_date: ex.interval.startTime.slice(0,10),
      activity_id: matched.id, duration_minutes: durationMin, calories_burned: calories,
      source: 'fitbit', external_id: p.name || `fitbit-${ex.interval.startTime}`,
    };
  }).filter(Boolean);
}

// Passive, non-workout activity — steps/movement the device tracked in
// the background, bucketed by intensity. Unlike `exercise` (deliberate,
// user-started sessions), this is the data most Fitbit wearers actually
// generate day to day without pressing "start workout." The `active-minutes`
// data type's activityLevel enum (LIGHT/MODERATE/VIGOROUS) maps directly
// onto this app's own intensity taxonomy and the generic "Fitbit-tracked
// activity" reference rows created in 08_wearable_integrations.sql.
async function syncFitbitActiveMinutes(ctx){
  const { userId, accessToken, activitiesByKeyword } = ctx;
  const levelToActivity = {
    LIGHT: activitiesByKeyword['fitbit light'],
    MODERATE: activitiesByKeyword['fitbit moderate'],
    VIGOROUS: activitiesByKeyword['fitbit vigorous'],
  };

  const since = new Date(); since.setDate(since.getDate() - 7);
  const url = `https://health.googleapis.com/v4/users/me/dataTypes/active-minutes/dataPoints?pageSize=50`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } });
  if (!res.ok) throw new Error('Google Health active-minutes fetch failed: ' + await res.text());
  const data = await res.json();
  const points = (data.dataPoints || []).filter(p => {
    const st = p.activeMinutes && p.activeMinutes.interval && p.activeMinutes.interval.startTime;
    return st && new Date(st) >= since;
  });

  // Sum minutes per day per level first — Google may return several
  // smaller intervals across a day rather than one row per day.
  const byDayLevel = {};
  points.forEach(p => {
    const day = p.activeMinutes.interval.startTime.slice(0,10);
    const levels = p.activeMinutes.activeMinutesByActivityLevel || [];
    byDayLevel[day] = byDayLevel[day] || { LIGHT: 0, MODERATE: 0, VIGOROUS: 0 };
    levels.forEach(l => {
      const mins = parseFloat(l.activeMinutes) || 0;
      if (byDayLevel[day][l.activityLevel] !== undefined) byDayLevel[day][l.activityLevel] += mins;
    });
  });

  const rows = [];
  Object.entries(byDayLevel).forEach(([day, levels]) => {
    ['LIGHT','MODERATE','VIGOROUS'].forEach(level => {
      const minutes = Math.round(levels[level]);
      const activity = levelToActivity[level];
      if (minutes > 0 && activity) rows.push({
        user_id: userId, entry_date: day, activity_id: activity.id, duration_minutes: minutes,
        calories_burned: Math.round(activity.met * 70 * (minutes/60)),
        source: 'fitbit', external_id: `fitbit-active-${day}-${level.toLowerCase()}`,
      });
    });
  });
  return rows;
}

async function syncFitbit(ctx){
  // Combine deliberate workout sessions with passive daily activity —
  // two different Google Health data types, merged into one row set.
  const [sessions, activeMinutes] = await Promise.all([
    syncFitbitExerciseSessions(ctx),
    syncFitbitActiveMinutes(ctx),
  ]);
  return [...sessions, ...activeMinutes];
}

// Best-effort Strava activity-type -> our activities.keywords mapping.
const STRAVA_TYPE_MAP = {
  Run: 'run', TrailRun: 'run', Walk: 'brisk walk', Hike: 'hiking',
  Ride: 'cycling', MountainBikeRide: 'fast cycling', GravelRide: 'moderate cycling',
  Swim: 'swim', WeightTraining: 'weight training', Workout: 'crossfit',
  Crossfit: 'crossfit', Yoga: 'yoga', Elliptical: 'elliptical',
  StairStepper: 'stair climbing', RockClimbing: 'rock climbing', Golf: 'golf',
  Tennis: 'tennis', Badminton: 'badminton', Basketball: 'basketball',
  Soccer: 'soccer', Dance: 'dancing',
};

async function syncStrava(ctx){
  const { userId, accessToken, activitiesByKeyword, activitiesList } = ctx;
  const after = Math.floor(Date.now()/1000) - 7*24*60*60;
  const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=50`, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!res.ok) throw new Error('Strava activities fetch failed: ' + await res.text());
  const activities = await res.json();
  const fallback = activitiesByKeyword['strava other'];

  return activities.map(a => {
    const kw = STRAVA_TYPE_MAP[a.type] || STRAVA_TYPE_MAP[a.sport_type];
    const matched = (kw && activitiesByKeyword[kw]) || fallback;
    const durationMin = Math.round((a.moving_time || 0) / 60);
    if (!matched || durationMin <= 0) return null;
    // Prefer Strava's own calorie figure when present; otherwise estimate
    // from the matched activity's MET using a generic 70kg reference
    // weight (we don't have the user's weight in this server-side
    // context without an extra profile lookup) — an approximation.
    const calories = a.calories ? Math.round(a.calories) : Math.round(matched.met * 70 * (durationMin/60));
    return {
      user_id: userId, entry_date: (a.start_date_local || a.start_date || '').slice(0,10),
      activity_id: matched.id, duration_minutes: durationMin, calories_burned: calories,
      source: 'strava', external_id: `strava-${a.id}`,
    };
  }).filter(Boolean).filter(r => r.entry_date);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const FITBIT_CLIENT_ID = process.env.FITBIT_CLIENT_ID;
  const FITBIT_CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET;
  const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
  const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

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
    const user = await verifyUser(SUPABASE_URL, SUPABASE_ANON_KEY, userToken);
    if (!user) { res.status(401).json({ error: 'Not signed in.' }); return; }

    let conn = await getConnection(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, user.id, provider);
    if (!conn) { res.status(400).json({ error: `${provider} isn't connected.` }); return; }

    // Refresh the token first if it's expired or close to it.
    if (new Date(conn.expires_at).getTime() < Date.now() + 60000) {
      const { tokenData, expiresAt } = provider === 'fitbit'
        ? await refreshFitbitToken(conn, FITBIT_CLIENT_ID, FITBIT_CLIENT_SECRET)
        : await refreshStravaToken(conn, STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET);
      await storeConnection(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, user.id, provider, tokenData, expiresAt);
      conn = { ...conn, access_token: tokenData.access_token };
    }

    // Load the activities reference table once, indexed by keyword, so
    // provider activity types can be matched to a real activity_id.
    const actRes = await fetch(SUPABASE_URL + '/rest/v1/activities?select=id,met,keywords', {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY },
    });
    const activitiesList = await actRes.json();
    const activitiesByKeyword = {};
    activitiesList.forEach(a => (a.keywords || []).forEach(k => { activitiesByKeyword[k] = a; }));

    const ctx = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, userId: user.id, accessToken: conn.access_token, activitiesByKeyword, activitiesList };
    const rows = provider === 'fitbit' ? await syncFitbit(ctx) : await syncStrava(ctx);

    let imported = 0;
    if (rows.length) {
      const insertRes = await fetch(SUPABASE_URL + '/rest/v1/activity_entries?on_conflict=user_id,source,external_id', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY, Prefer: 'resolution=ignore-duplicates,return=representation',
        },
        body: JSON.stringify(rows),
      });
      if (insertRes.ok) {
        const inserted = await insertRes.json();
        imported = Array.isArray(inserted) ? inserted.length : 0;
      } else {
        // Never swallow this silently again — a failed insert should be
        // visible in logs even outside an active debugging session.
        console.error('Wearable sync insert failed:', insertRes.status, await insertRes.text());
      }
    }

    const note = `Imported ${imported} new entr${imported===1?'y':'ies'} from the last 7 days.`;
    await fetch(SUPABASE_URL + '/rest/v1/wearable_status?on_conflict=user_id,provider', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY, Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ user_id: user.id, provider, connected: true, last_synced_at: new Date().toISOString(), last_sync_note: note, updated_at: new Date().toISOString() }),
    });

    res.status(200).json({ ok: true, imported, note });
  } catch (e) {
    console.error('Wearable sync error:', e);
    res.status(500).json({ error: e.message });
  }
};
