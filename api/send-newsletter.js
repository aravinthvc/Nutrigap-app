// api/send-newsletter.js
//
// The weekly NutriGap newsletter: a personalized "how was your week" recap
// sent over Telegram and/or email. Manual trigger only for now -- there is
// deliberately no Vercel Cron entry for this file (unlike
// api/telegram-cron-nudge.js's daily nudge, which does run on a schedule).
// Call it yourself (see curl example below) whenever you want a round to go
// out; nothing fires on its own yet.
//
// Scope, as decided when this was built (2026-10-23):
//   - Content: the personalized recap from lib/weekly-recap.js (streak,
//     days logged, calorie balance, activity balance, top recurring
//     nutrient gaps) -- richer than the Telegram /recap command's text,
//     which stays untouched.
//   - Channels: both Telegram (to every telegram_links row) and email (to
//     every account with a real, non-synthetic address) -- send to
//     whichever channel(s) a given user actually has, never both forced.
//   - Rollout: no new DB table/column this pass. No subscriber list, no
//     opt-in/opt-out preference for the newsletter specifically -- it's
//     computed fresh from profiles/telegram_links/Auth Admin on every
//     manual run. (telegram_links.nudges_enabled is intentionally NOT
//     checked here -- that flag is specifically the daily under-logged
//     nudge's opt-out, a different feature on a different cadence. If this
//     newsletter graduates to a real schedule later, it should probably
//     get its own opt-out column rather than borrowing that one.)
//
// Auth: same CRON_SECRET-protected, fail-closed pattern as
// telegram-cron-nudge.js, reusing the SAME secret (not a new one) since
// it's already configured in Vercel. Vercel Cron would add the
// Authorization header automatically if this ever gets a "crons" entry --
// until then, call it yourself with that header.
//
// Safety: dryRun defaults to true. A call with no body, or
// `{"dryRun": true}`, computes everything and returns a preview -- no
// Telegram message or email actually goes out. You must explicitly send
// `{"dryRun": false}` to really send. `onlyUserId` restricts a run (dry or
// real) to one account, for testing on yourself first.
//
// Example (preview only):
//   curl -X POST https://<your-app>.vercel.app/api/send-newsletter \
//     -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
//     -d '{"onlyUserId": "<your user id>"}'
// Example (really send, to everyone):
//   curl -X POST https://<your-app>.vercel.app/api/send-newsletter \
//     -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
//     -d '{"dryRun": false}'

const db = require('../lib/supabase-rest');
const { computeWeeklyRecap } = require('../lib/weekly-recap');

const TELEGRAM_API = 'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN;
const RESEND_API = 'https://api.resend.com/emails';
// Needs a real, DNS-verified sending domain in Resend -- a bare vercel.app
// subdomain can't be verified there. Set RESEND_FROM_EMAIL in Vercel once
// that's set up (see the status doc for the setup checklist item); this
// placeholder will make every real send fail loudly (a clear Resend 4xx)
// rather than silently claim success, until it's configured for real.
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'NutriGap <newsletter@YOUR_VERIFIED_DOMAIN>';
const WEBSITE_URL = 'https://nutrigap-app.vercel.app';

async function sendTelegramMessage(chatId, text) {
  const res = await fetch(TELEGRAM_API + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error('Telegram sendMessage failed (' + res.status + '): ' + await res.text());
}

async function sendEmail(to, subject, html, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not configured.');
  const res = await fetch(RESEND_API, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM_EMAIL, to, subject, html, text }),
  });
  if (!res.ok) throw new Error('Resend send failed (' + res.status + '): ' + await res.text());
}

function pct(n) { return (n === null || n === undefined) ? null : Math.round(n); }

// ---------- Telegram text ----------
// Deliberately more detailed than weeklyRecapReply()'s /recap text in
// api/telegram-webhook.js (which only ever covers streak/days/meals) --
// this is new content built specifically for the newsletter, and /recap
// itself is untouched.
function buildTelegramText(recap) {
  const lines = ['📬 Your weekly NutriGap recap', ''];
  lines.push(`🔥 ${recap.streakCurrent}-day streak${recap.streakBest > recap.streakCurrent ? ` (best: ${recap.streakBest})` : ''}`);
  lines.push(`✅ Logged ${recap.loggedDaysThisWeek}/7 days -- ${recap.mealsThisWeek} meal${recap.mealsThisWeek === 1 ? '' : 's'} tracked`);

  if (recap.avgCalPct !== null) {
    lines.push(`🍽 Averaged ${pct(recap.avgCalPct)}% of your calorie target on the ${recap.loggedCalDays} day${recap.loggedCalDays === 1 ? '' : 's'} you logged`);
  }
  if (recap.avgActPct !== null) {
    const diff = pct(recap.avgActPct);
    const dir = diff >= 0 ? `${diff}% above` : `${Math.abs(diff)}% below`;
    lines.push(`🏃 Activity averaged ${dir} the 30-min/day guideline (${recap.activityTierLabel} most days) across ${recap.loggedActDays} logged day${recap.loggedActDays === 1 ? '' : 's'}`);
  }

  if (recap.topGaps.length) {
    lines.push('', 'Recurring gaps this week:');
    recap.topGaps.forEach(g => {
      const verb = g.type === 'limit' ? 'over' : 'under';
      lines.push(`  • ${g.label}: ${verb} on ${g.badCount}/${recap.loggedCalDays} logged days (avg ${g.avgPct}% of ${g.type === 'limit' ? 'limit' : 'target'})`);
    });
  }

  lines.push('', `See the full breakdown: ${WEBSITE_URL}`);
  lines.push('', '(This recap is a once-a-week manual send for now, not an automatic subscription.)');
  return lines.join('\n');
}

// ---------- Email ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildEmailSubject(recap) {
  return `Your NutriGap week: ${recap.loggedDaysThisWeek}/7 days logged${recap.streakCurrent ? `, ${recap.streakCurrent}-day streak 🔥` : ''}`;
}

function buildEmailHtml(recap) {
  const row = (label, value) => value === null ? '' : `<tr><td style="padding:6px 0;color:#555;">${escapeHtml(label)}</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#222;">${escapeHtml(value)}</td></tr>`;

  const calRow = recap.avgCalPct !== null
    ? row('Calorie target (avg, logged days)', `${pct(recap.avgCalPct)}%`)
    : '';
  const actRow = recap.avgActPct !== null
    ? row('Activity vs. 30-min guideline (avg)', `${recap.avgActPct >= 0 ? '+' : ''}${pct(recap.avgActPct)}% (${recap.activityTierLabel})`)
    : '';

  const gapsHtml = recap.topGaps.length
    ? `<h3 style="margin:24px 0 8px;font-size:15px;color:#222;">Recurring gaps this week</h3>
       <ul style="margin:0;padding-left:20px;color:#444;">
         ${recap.topGaps.map(g => `<li style="margin-bottom:6px;">${escapeHtml(g.label)}: ${g.type === 'limit' ? 'over limit' : 'under target'} on ${g.badCount}/${recap.loggedCalDays} logged days (avg ${g.avgPct}% of ${g.type === 'limit' ? 'limit' : 'target'})</li>`).join('')}
       </ul>`
    : '';

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f5f3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f3;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
        <tr><td style="background:#1f6f4f;padding:20px 28px;">
          <span style="color:#fff;font-size:18px;font-weight:700;">📬 Your weekly NutriGap recap</span>
        </td></tr>
        <tr><td style="padding:24px 28px;">
          <p style="margin:0 0 16px;font-size:14px;color:#333;">
            🔥 <strong>${recap.streakCurrent}-day streak</strong>${recap.streakBest > recap.streakCurrent ? ` (best: ${recap.streakBest})` : ''} &middot;
            logged <strong>${recap.loggedDaysThisWeek}/7</strong> days &middot;
            <strong>${recap.mealsThisWeek}</strong> meal${recap.mealsThisWeek === 1 ? '' : 's'} tracked
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border-top:1px solid #eee;border-bottom:1px solid #eee;">
            ${calRow}${actRow}
          </table>
          ${gapsHtml}
          <p style="margin:24px 0 0;">
            <a href="${WEBSITE_URL}" style="display:inline-block;background:#1f6f4f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;">See full breakdown</a>
          </p>
          <p style="margin:24px 0 0;font-size:12px;color:#999;">This recap is a once-a-week manual send for now, not an automatic subscription.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildEmailText(recap) {
  // Plain-text fallback -- same content as buildTelegramText minus the emoji-
  // heavy formatting, since some mail clients show this instead of the HTML.
  return buildTelegramText(recap).replace(/[📬🔥✅🍽🏃•]/g, '-');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('send-newsletter: CRON_SECRET is not configured -- refusing to run.');
    res.status(500).json({ error: 'Server is missing CRON_SECRET -- this endpoint is disabled until it is set.' });
    return;
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = req.body || {};
  const dryRun = body.dryRun !== false; // must explicitly pass dryRun:false to really send
  const onlyUserId = body.onlyUserId || null;

  const stats = {
    checked: 0, sentTelegram: 0, sentEmail: 0,
    skippedNoProfile: 0, skippedNoData: 0, skippedNoChannel: 0, errors: 0,
  };
  const preview = [];
  const PREVIEW_CAP = 30;

  try {
    const [profileRows, telegramRows, authUsers] = await Promise.all([
      db.select('profiles', { columns: 'user_id', filters: onlyUserId ? ['user_id=eq.' + onlyUserId] : [] }),
      db.select('telegram_links', { columns: 'user_id,chat_id', filters: onlyUserId ? ['user_id=eq.' + onlyUserId] : [] }),
      db.authAdminListUsers(),
    ]);

    const chatIdByUser = {};
    (telegramRows || []).forEach(r => { chatIdByUser[r.user_id] = r.chat_id; });

    // Real, mailable emails only -- synthetic Telegram-onboarding addresses
    // live on the reserved ".invalid" TLD (see lib/supabase-rest.js /
    // telegram-webhook.js's claimEmail()) and must never be sent to.
    const emailByUser = {};
    (authUsers || []).forEach(u => {
      if (u.email && !u.email.toLowerCase().endsWith('.invalid')) emailByUser[u.id] = u.email;
    });

    for (const { user_id: userId } of (profileRows || [])) {
      stats.checked++;
      try {
        const recap = await computeWeeklyRecap(userId);
        if (!recap) { stats.skippedNoProfile++; continue; }
        if (!recap.hasAnyDataThisWeek) { stats.skippedNoData++; continue; }

        const chatId = chatIdByUser[userId] || null;
        const email = emailByUser[userId] || null;
        if (!chatId && !email) { stats.skippedNoChannel++; continue; }

        const telegramText = chatId ? buildTelegramText(recap) : null;
        const emailSubject = email ? buildEmailSubject(recap) : null;
        const emailHtml = email ? buildEmailHtml(recap) : null;
        const emailText = email ? buildEmailText(recap) : null;

        if (preview.length < PREVIEW_CAP) {
          preview.push({
            userId,
            channels: [chatId && 'telegram', email && 'email'].filter(Boolean),
            telegramText, emailSubject,
          });
        }

        if (!dryRun) {
          if (chatId) { await sendTelegramMessage(chatId, telegramText); stats.sentTelegram++; }
          if (email) { await sendEmail(email, emailSubject, emailHtml, emailText); stats.sentEmail++; }
        }
      } catch (e) {
        console.error('send-newsletter: failed for user ' + userId + ':', e.message);
        stats.errors++;
      }
    }

    res.status(200).json({ ok: true, dryRun, stats, preview });
  } catch (e) {
    console.error('send-newsletter: fatal error:', e);
    res.status(500).json({ error: e.message });
  }
};
