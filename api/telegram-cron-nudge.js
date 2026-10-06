// api/telegram-cron-nudge.js
//
// Daily proactive check-in reminders on Telegram -- the piece the webhook
// itself structurally can't do, since api/telegram-webhook.js only ever
// runs in response to Telegram POSTing an update to us (someone sending a
// message). This file is triggered on a schedule instead (Vercel Cron --
// see the "crons" entry in vercel.json), so it's the one place in this
// codebase that messages someone without them asking first.
//
// Because of that, it's deliberately conservative:
//   - opt-out, not silent: nudges_enabled defaults to true, but every
//     message it sends says how to turn it off, and /nudges on|off in the
//     webhook works any time (see telegram-webhook.js).
//   - only messages someone once a day (last_nudged_date guards against a
//     double-fire of the same day's cron run).
//   - only nudges someone who's actually under-logged today -- never
//     "just checking in" noise for someone already on track.
//   - skips anyone still mid-onboarding or without a complete profile --
//     there's nothing honest to say about their gap yet.
//
// Auth: Vercel adds `Authorization: Bearer <CRON_SECRET>` automatically
// when a Cron Job calls this URL, IF the CRON_SECRET env var is set in the
// Vercel project. This fails CLOSED -- if CRON_SECRET isn't configured,
// the endpoint refuses to run rather than silently mass-messaging every
// linked user to whoever happens to hit the URL.

const db = require('../lib/supabase-rest');
const nc = require('../lib/nutrition-core');

const TELEGRAM_API = 'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN;

async function sendMessage(chatId, text) {
  await fetch(TELEGRAM_API + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}

async function loadTargets(userId) {
  const rows = await db.select('profiles', { columns: '*', filters: ['user_id=eq.' + userId], limit: 1 });
  const profile = rows && rows[0];
  if (!profile || !profile.age || !profile.sex || !profile.height_cm || !profile.weight_kg) return null;
  return nc.computeTargets(profile);
}

async function loadEntriesForDate(userId, dateStr) {
  const rows = await db.select('diet_entries', {
    columns: 'servings,meal,food_id,meal_box_item_id,foods(*),meal_box_items(*)',
    filters: ['user_id=eq.' + userId, 'entry_date=eq.' + dateStr],
  });
  return (rows || []).map(row => ({
    ...(row.meal_box_item_id ? nc.mapMealBoxRow(row.meal_box_items || {}) : nc.mapFoodRow(row.foods || {})),
    servings: row.servings, meal: row.meal,
  }));
}

function noLogMessage() {
  return "👋 Haven't seen anything in today's log yet. Takes 10 seconds -- just tell me what you ate, like \"2 chapathis and dal for lunch\".\n\n(Send \"/nudges off\" any time to turn these daily reminders off.)";
}

function thinLogMessage(t, tg) {
  const kcalPct = Math.round((t.kcal / tg.kcal) * 100);
  const ranked = nc.rankGapsForInsight(t, tg);
  const topGap = ranked[0];
  const gapLine = topGap
    ? `${topGap.label} is your biggest gap right now (${Math.round(topGap.deltaPct * 100)}% short).`
    : "You're close on most things, just a bit light on calories overall.";
  return `Today's log is looking a little light -- about ${kcalPct}% of your calorie target so far. ${gapLine} Ask me "what should I eat?" for BFB meal-box ideas, or just tell me what else you've had.\n\n(Send "/nudges off" any time to turn these daily reminders off.)`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('telegram-cron-nudge: CRON_SECRET is not configured -- refusing to run.');
    res.status(500).json({ error: 'Server is missing CRON_SECRET -- this endpoint is disabled until it is set.' });
    return;
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const todayIST = nc.istDateStr(new Date());
  const stats = { checked: 0, sentNoLog: 0, sentThinLog: 0, skippedAlreadyNudged: 0, skippedOnboarding: 0, skippedNoProfile: 0, skippedOnTrack: 0, errors: 0 };

  try {
    const links = await db.select('telegram_links', {
      columns: 'chat_id,user_id,onboarding_state,last_nudged_date',
      filters: ['nudges_enabled=eq.true'],
    });

    for (const link of (links || [])) {
      stats.checked++;
      try {
        if (link.onboarding_state && link.onboarding_state.step) { stats.skippedOnboarding++; continue; }
        if (link.last_nudged_date === todayIST) { stats.skippedAlreadyNudged++; continue; }

        const targets = await loadTargets(link.user_id);
        if (!targets) { stats.skippedNoProfile++; continue; }

        const entries = await loadEntriesForDate(link.user_id, todayIST);
        const t = nc.totals(entries);

        let message = null;
        if (entries.length === 0) {
          message = noLogMessage();
          stats.sentNoLog++;
        } else if (targets.kcal > 0 && t.kcal < targets.kcal * 0.5) {
          message = thinLogMessage(t, targets);
          stats.sentThinLog++;
        } else {
          stats.skippedOnTrack++;
          continue;
        }

        await sendMessage(link.chat_id, message);
        await db.update('telegram_links', ['chat_id=eq.' + encodeURIComponent(String(link.chat_id))], { last_nudged_date: todayIST });
      } catch (e) {
        console.error('telegram-cron-nudge: failed for chat ' + link.chat_id + ':', e.message);
        stats.errors++;
      }
    }

    res.status(200).json({ ok: true, date: todayIST, stats });
  } catch (e) {
    console.error('telegram-cron-nudge: fatal error:', e);
    res.status(500).json({ error: e.message });
  }
};
