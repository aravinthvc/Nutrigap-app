// api/telegram-webhook.js
//
// The Telegram side of the NutriGap AI agent. Telegram calls this URL
// (configured once via a "setWebhook" call -- see the setup notes that
// came with this file) every time someone sends the bot a message.
//
// This function is stateless between calls (a fresh serverless invocation
// each time), so all memory of who's talking and what's been said lives in
// Supabase: telegram_links (who this chat_id belongs to), telegram_messages
// (a short conversation log used as context for the AI), and the app's own
// tables (profiles, foods, diet_entries, dietitian_messages,
// dietitian_appointments). It authenticates to Supabase with the
// service-role key (see lib/supabase-rest.js) since there's no browser
// session/JWT for a Telegram chat, and is careful to only ever read/write
// rows for a user_id it has already verified via telegram_links.
//
// What it can do, once someone's linked their account (see the linking
// flow below): log a meal in plain English, answer "what's my gap today",
// suggest BFB meal-box ideas to close that gap ("what should I eat?"),
// have the same AI-first-line dietitian conversation as the website's
// Dietitian tab (continuing the same shared thread), and request/list/
// cancel a real appointment. Anything it's not confident routing gets
// treated as a dietitian-chat message -- that's the safe, designed-for-
// open-ended-conversation default, never a guess dressed up as an action.

const crypto = require('crypto');
const db = require('../lib/supabase-rest');
const nc = require('../lib/nutrition-core');
const { callDietitianModel } = require('../lib/dietitian-agent');

const TELEGRAM_API = 'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN;
// Only needed to BUILD a t.me deep link (e.g. for /invite) -- the webhook
// itself never needs its own username for anything else. Set a
// TELEGRAM_BOT_USERNAME env var in Vercel with the real @username (no "@"),
// same place TELEGRAM_BOT_TOKEN already lives; same placeholder convention
// as index.html's TELEGRAM_BOT_USERNAME constant, which needs the same value.
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'YourNutriGapBot';
const APPT_TIME_WINDOWS = ['Morning (9am-12pm)', 'Afternoon (12pm-4pm)', 'Evening (4pm-8pm)'];
const MEAL_VALUES = ['breakfast', 'lunch', 'dinner', 'snack'];
const MEAL_OPTIONS = [
  { label: 'Breakfast', value: 'breakfast' }, { label: 'Lunch', value: 'lunch' },
  { label: 'Dinner', value: 'dinner' }, { label: 'Snack', value: 'snack' },
];

// ---------- Telegram I/O ----------

// The persistent quick-action menu -- a Telegram "reply keyboard", not an
// inline one: it docks under the text box and stays visible across every
// later message (not just the one it was sent with), until replaced or
// removed. Sent once after linking/onboarding and on /start or /help, so a
// returning user always has the main actions one tap away instead of
// having to remember exact phrasing or slash commands. Button taps arrive
// back as ordinary text messages (see BUTTON_TO_COMMAND in the main
// handler below) -- free-text still works exactly as before this existed.
const MAIN_MENU_KEYBOARD = [
  ['📊 My gap', '🍽 Meal ideas'],
  ['📝 Log a meal', '📅 Appointments'],
  ['📄 My documents', '👥 Invite friends'],
  ['❓ Help'],
];

// `keyboard`, when given, is an array of rows of {text, callback_data} --
// Telegram renders it as tappable inline buttons under the message. Used
// by the self-serve onboarding flow below for anything with a fixed set
// of valid answers (sex, activity level, goal, ...), so those come back
// as an exact value rather than something free text would have to parse.
// `opts.menu: true` attaches the persistent MAIN_MENU_KEYBOARD instead --
// mutually exclusive with `keyboard` (Telegram only renders one
// reply_markup per message; callers never need both on the same message).
async function sendMessage(chatId, text, keyboard, opts) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  else if (opts && opts.menu) body.reply_markup = { keyboard: MAIN_MENU_KEYBOARD, resize_keyboard: true };
  await fetch(TELEGRAM_API + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Shows Telegram's "NutriGap_Bot is typing..." indicator for a few
// seconds. Fired once before any reply that might involve an AI call (a
// couple of seconds of silence otherwise reads as broken, not slow) --
// best-effort, never worth failing or slowing a reply down over.
async function sendTyping(chatId) {
  try {
    await fetch(TELEGRAM_API + '/sendChatAction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
  } catch (e) { /* best-effort only */ }
}

// Sends a file already in hand (downloaded server-side from Supabase
// Storage) as a real Telegram document attachment -- a multipart upload
// straight to Telegram's own API, no intermediate public URL needed (the
// storage bucket is private). Used by the "My documents" feature below to
// deliver a saved medical report or prescription directly into the chat,
// the same file someone would get from "View original" / the file chip on
// the website, just native to Telegram instead of a link.
async function sendTelegramFile(chatId, buffer, filename, contentType, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption.slice(0, 1024));
  form.append('document', new Blob([buffer], { type: contentType || 'application/octet-stream' }), filename || 'file');
  const res = await fetch(TELEGRAM_API + '/sendDocument', { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Telegram sendDocument failed: ' + res.status + ' ' + text);
  }
}

// Dismisses the little loading spinner Telegram shows on the tapped
// button -- cosmetic, but leaving it out makes every button tap look like
// it did nothing for a moment. Best-effort: never worth failing a reply
// over.
async function answerCallbackQuery(id) {
  try {
    await fetch(TELEGRAM_API + '/answerCallbackQuery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: id }),
    });
  } catch (e) { console.error('answerCallbackQuery failed:', e.message); }
}

// Strips the buttons off a message once it's been answered, so a stale
// tap on an old question can't be replayed. Best-effort -- editing can
// fail (e.g. the message is too old), and that's fine to ignore.
async function clearKeyboard(chatId, messageId) {
  try {
    await fetch(TELEGRAM_API + '/editMessageReplyMarkup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    });
  } catch (e) { /* best-effort only */ }
}

// ---------- Conversation log (short-term memory + audit trail) ----------

async function logMessage(userId, chatId, direction, text, intent) {
  try {
    await db.insert('telegram_messages', [{
      user_id: userId, chat_id: String(chatId), direction, text: String(text).slice(0, 4000), intent: intent || null,
    }], { returning: false });
  } catch (e) {
    console.error('Could not log telegram message:', e.message);
  }
}

async function recentContext(userId, limit) {
  try {
    const rows = await db.select('telegram_messages', {
      columns: 'direction,text,created_at',
      filters: ['user_id=eq.' + userId],
      order: 'created_at.desc',
      limit: limit || 8,
    });
    return (rows || []).reverse().map(r => `${r.direction === 'in' ? 'User' : 'Bot'}: ${r.text}`).join('\n');
  } catch (e) {
    console.error('Could not load telegram context:', e.message);
    return '';
  }
}

// ---------- Account linking ----------

// Returns the full telegram_links row (user_id, onboarding_state, source)
// for this chat, or null if the chat has never been linked at all -- not
// to be confused with onboarding_state being null, which just means
// there's no *onboarding* in progress (either it finished, or this link
// came from the website's code flow and never needed it).
async function findLink(chatId) {
  const rows = await db.select('telegram_links', {
    columns: 'user_id,onboarding_state,pending_log,pending_upload,source,nudges_enabled',
    filters: ['chat_id=eq.' + encodeURIComponent(String(chatId))],
    limit: 1,
  });
  return rows && rows[0] ? rows[0] : null;
}

async function handleLinking(chatId, text, from) {
  const parts = text.trim().split(/\s+/);
  const code = parts[0] === '/start' ? (parts[1] || '') : (/^[A-Z0-9]{6}$/i.test(text.trim()) ? text.trim() : '');

  // A referral deep link (`/start ref_<code>`, from someone's "Invite
  // friends" link) is a different namespace from a website linking code --
  // intercept it before the telegram_link_codes lookup below, which would
  // otherwise just dead-end with "that code doesn't match anything." The
  // resolved code rides along in the "Get started" button's own
  // callback_data (see handleCallbackQuery's 'ob:begin' branch), since
  // there's no telegram_links row yet to persist it on at this point.
  if (code && /^ref_/i.test(code)) {
    const refCode = code.slice(4).toUpperCase();
    let referrerFound = false;
    if (refCode) {
      try {
        const rows = await db.select('profiles', {
          columns: 'user_id', filters: ['referral_code=eq.' + encodeURIComponent(refCode)], limit: 1,
        });
        referrerFound = !!(rows && rows[0]);
      } catch (e) { console.error('Referral code lookup failed:', e.message); }
    }
    const beginCallback = referrerFound ? `ob:begin:ref:${refCode}` : 'ob:begin';
    await sendMessage(chatId,
      "Hi! I'm the NutriGap AI agent." + (referrerFound ? ' Looks like a friend sent you.' : '') + " This chat isn't set up yet -- two ways to fix that:",
      [
        [{ text: '🚀 Get started -- no account needed', callback_data: beginCallback }],
        [{ text: '🔗 I already have a NutriGap account', callback_data: 'ob:have_account' }],
      ]
    );
    return;
  }

  if (!code) {
    await sendMessage(chatId,
      "Hi! I'm the NutriGap AI agent. This chat isn't set up yet -- two ways to fix that:",
      [
        [{ text: '🚀 Get started -- no account needed', callback_data: 'ob:begin' }],
        [{ text: '🔗 I already have a NutriGap account', callback_data: 'ob:have_account' }],
      ]
    );
    return;
  }

  const rows = await db.select('telegram_link_codes', {
    columns: 'code,user_id,expires_at,used_at',
    filters: ['code=eq.' + encodeURIComponent(code.toUpperCase())],
    limit: 1,
  });
  const row = rows && rows[0];
  if (!row) {
    await sendMessage(chatId, "That code doesn't match anything -- get a fresh one from the website (Profile tab → Connect Telegram) and send it again.");
    return;
  }
  if (row.used_at) {
    await sendMessage(chatId, 'That code has already been used. Get a fresh one from the website (Profile tab → Connect Telegram).');
    return;
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await sendMessage(chatId, 'That code has expired (they last 10 minutes) -- get a fresh one from the website (Profile tab → Connect Telegram).');
    return;
  }

  await db.insert('telegram_links', [{
    chat_id: String(chatId), user_id: row.user_id,
    telegram_username: (from && (from.username || from.first_name)) || null,
    source: 'website', onboarding_state: null,
  }], { returning: false });
  await db.update('telegram_link_codes', ['code=eq.' + encodeURIComponent(row.code)], { used_at: new Date().toISOString() });

  await sendMessage(chatId,
    "You're linked! Here's what I can do:\n\n" +
    '• Tell me what you ate ("2 chapathis with palak matar for lunch") and I\'ll log it\n' +
    '• Ask "what\'s my gap today?" for your macro/micro summary\n' +
    '• Just talk to me about your goals -- I\'m the same AI first-line as the Dietitian tab\n' +
    '• "book an online appointment Tuesday evening" to request a real consultation\n' +
    '• "my appointments" to see what\'s upcoming\n' +
    '• "📄 My documents" to pull back a saved medical report or prescription\n\n' +
    'Use the buttons below any time, or send /help to see this again. /unlink disconnects this chat.',
    null, { menu: true }
  );
}

// ---------- Self-serve onboarding (acquisition: no prior account) ----------
//
// Triggered by the "🚀 Get started" button on a cold /start. Creates a
// real Supabase Auth user right away (via the Admin API -- see
// lib/supabase-rest.js) under a synthetic, never-mailed address, so every
// table keyed by user_id (profiles, diet_entries, ...) just works exactly
// as it does for a website signup. Then walks through the same fields the
// Profile tab collects, one at a time, and writes a real `profiles` row
// at the end. Optionally "claims" the account with a real email so it's
// also usable from the website -- see claimEmail() below.
//
// State lives in telegram_links.onboarding_state (jsonb) so it survives
// between these stateless serverless calls: {step, answers}. step is one
// of the ONBOARDING_FIELDS keys while onboarding is in progress, and the
// column is set back to null once finalizeOnboarding() runs.

const SEX_OPTIONS = [{ label: 'Male', value: 'male' }, { label: 'Female', value: 'female' }];
const LIFE_STAGE_OPTIONS = [
  { label: 'None of these', value: 'none' },
  { label: 'Pregnant', value: 'pregnant' },
  { label: 'Breastfeeding', value: 'lactating' },
];
const FRAME_OPTIONS = [
  { label: 'Small', value: 'small' }, { label: 'Medium', value: 'medium' }, { label: 'Large', value: 'large' },
];
const ACTIVITY_OPTIONS = [
  { label: 'Sedentary', value: '1.2' }, { label: 'Light', value: '1.375' }, { label: 'Moderate', value: '1.55' },
  { label: 'Active', value: '1.725' }, { label: 'Very active', value: '1.9' },
];
const GOAL_OPTIONS = [
  { label: 'Lose fat', value: 'lose' }, { label: 'Maintain', value: 'maintain' },
  { label: 'Build muscle', value: 'gain' }, { label: 'Manage a condition', value: 'manage' },
];

// Same shape the website's segmented controls / number fields collect on
// the Profile tab (see saveProfile() in index.html) -- kept in this order
// so computeTargets() has everything it needs by the last required field.
const ONBOARDING_FIELDS = {
  name: {
    kind: 'text',
    prompt: () => "First things first -- what should I call you?",
    parse: (t) => { const v = t.trim().slice(0, 60); return v ? v : null; },
    next: () => 'age',
  },
  age: {
    kind: 'text',
    prompt: (a) => `Nice to meet you, ${a.name}! How old are you?`,
    parse: (t) => { const n = parseInt(t.trim(), 10); return (Number.isFinite(n) && n >= 10 && n <= 100) ? n : null; },
    invalidHint: 'Just a number between 10 and 100.',
    next: () => 'sex',
  },
  sex: {
    kind: 'buttons', options: SEX_OPTIONS,
    prompt: () => 'Sex? This affects how I calculate your targets.',
    next: (a) => a.sex === 'female' ? 'life_stage' : 'height',
  },
  life_stage: {
    kind: 'buttons', options: LIFE_STAGE_OPTIONS,
    prompt: () => 'Are you currently pregnant or breastfeeding? A few of your targets change if so.',
    next: () => 'height',
  },
  height: {
    kind: 'text',
    prompt: () => 'Height in cm?',
    parse: (t) => { const n = parseFloat(t.trim()); return (Number.isFinite(n) && n >= 100 && n <= 250) ? n : null; },
    invalidHint: 'A number in cm, between 100 and 250 (e.g. 170).',
    next: () => 'weight',
  },
  weight: {
    kind: 'text',
    prompt: () => 'Weight in kg?',
    parse: (t) => { const n = parseFloat(t.trim()); return (Number.isFinite(n) && n >= 25 && n <= 300) ? n : null; },
    invalidHint: 'A number in kg, between 25 and 300 (e.g. 68).',
    next: () => 'frame',
  },
  frame: {
    kind: 'buttons', options: FRAME_OPTIONS,
    prompt: () => "Body frame -- wrist/joint size relative to your height?",
    next: () => 'activity',
  },
  activity: {
    kind: 'buttons', options: ACTIVITY_OPTIONS,
    prompt: () => 'How active is a typical day for you?',
    next: () => 'goal',
  },
  goal: {
    kind: 'buttons', options: GOAL_OPTIONS,
    prompt: () => "What's your main health goal right now?",
    next: () => 'email',
  },
  email: {
    kind: 'text',
    prompt: () => 'Last thing -- want the website too (charts, meal boxes, medical report review)? Send your email and I\'ll set that up, or reply "skip" to stay on Telegram for now.',
    parse: (t) => t.trim(),
    next: () => null,
  },
};

function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

async function askOnboardingStep(chatId, state) {
  await db.update('telegram_links', ['chat_id=eq.' + encodeURIComponent(String(chatId))], { onboarding_state: state });
  const field = ONBOARDING_FIELDS[state.step];
  const text = field.prompt(state.answers);
  const keyboard = field.kind === 'buttons'
    ? field.options.map(o => [{ text: o.label, callback_data: `ob:${state.step}:${o.value}` }])
    : null;
  await sendMessage(chatId, text, keyboard);
}

async function createSelfServeAccount(chatId, from, refCode) {
  const syntheticEmail = `tg-${chatId}-${crypto.randomBytes(4).toString('hex')}@telegram.invalid`;
  const throwawayPassword = crypto.randomBytes(12).toString('hex');
  let authUser;
  try {
    authUser = await db.authAdminCreateUser({
      email: syntheticEmail, password: throwawayPassword, email_confirm: true,
    });
  } catch (e) {
    console.error('Could not create self-serve account:', e.message);
    return null;
  }
  const userId = authUser && authUser.id;
  if (!userId) return null;
  await db.insert('telegram_links', [{
    chat_id: String(chatId), user_id: userId,
    telegram_username: (from && (from.username || from.first_name)) || null,
    source: 'telegram_selfserve',
    onboarding_state: { step: 'name', answers: {} },
  }], { returning: false });

  if (refCode) {
    try { await recordTelegramReferral(userId, refCode); }
    catch (e) { console.error('Referral attribution failed (non-fatal):', e.message); }
  }
  return userId;
}

// ---------- Referrals (social-only invite program) ----------
//
// Mirrors the website's own referral_code / referrals setup (see
// add_referrals.sql and index.html's "Referrals / invite link" section) --
// same one code per person, same purely-social framing (no reward/credit
// granted), just resolved and written with the webhook's service-role
// privileges instead of going through api/record-referral.js, since this
// side already has everything it needs server-side.

function generateReferralCodeTG() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I -- avoids visual confusion if read aloud or retyped
  let code = '';
  for (let i = 0; i < 7; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

// Returns the person's existing referral code, or generates and saves a new
// one -- but only when a `profiles` row already exists for them (nothing to
// attach a code to otherwise; a mid-onboarding Telegram user or a website
// signup that never touched the Profile tab has no row yet).
async function ensureReferralCode(userId) {
  const rows = await db.select('profiles', { columns: 'referral_code', filters: ['user_id=eq.' + userId], limit: 1 });
  const row = rows && rows[0];
  if (!row) return null;
  if (row.referral_code) return row.referral_code;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateReferralCodeTG();
    try {
      await db.update('profiles', ['user_id=eq.' + userId], { referral_code: code });
      return code;
    } catch (e) {
      if (!/duplicate|unique/i.test(e.message || '')) throw e;
      // else: collision against the DB's unique constraint -- astronomically
      // unlikely at this alphabet/length, but retry with a fresh code.
    }
  }
  return null;
}

// Resolves a referral code to its owner and records the credit -- the same
// self-referral guard and referred-user-is-unique idempotency as
// api/record-referral.js. Also notifies the referrer right away if they're
// themselves reachable on Telegram, since seeing an invite actually land is
// what makes someone send a second one.
async function recordTelegramReferral(referredUserId, refCode) {
  const rows = await db.select('profiles', {
    columns: 'user_id', filters: ['referral_code=eq.' + encodeURIComponent(refCode)], limit: 1,
  });
  const referrer = rows && rows[0];
  if (!referrer || referrer.user_id === referredUserId) return;

  const existing = await db.select('referrals', {
    columns: 'id', filters: ['referred_user_id=eq.' + encodeURIComponent(referredUserId)], limit: 1,
  });
  if (existing && existing[0]) return;

  await db.insert('referrals', [{
    referrer_user_id: referrer.user_id, referred_user_id: referredUserId, source: 'telegram',
  }], { returning: false });

  try {
    const referrerLinks = await db.select('telegram_links', {
      columns: 'chat_id', filters: ['user_id=eq.' + referrer.user_id], limit: 1,
    });
    const referrerChatId = referrerLinks && referrerLinks[0] && referrerLinks[0].chat_id;
    if (referrerChatId) {
      await sendMessage(referrerChatId, "🎉 Someone just joined NutriGap through your invite link! Send /invite any time to see your link again.");
    }
  } catch (e) { console.error('Could not notify referrer:', e.message); }
}

async function inviteReply(userId) {
  const code = await ensureReferralCode(userId);
  if (!code) {
    return "You'll need to finish setting up your profile first (on the website, or by answering a few quick questions here) before I can make your invite link -- then send /invite again.";
  }
  const countRows = await db.select('referrals', { columns: 'id', filters: ['referrer_user_id=eq.' + userId] });
  const count = (countRows || []).length;
  const countLine = count > 0
    ? `${count} friend${count === 1 ? '' : 's'} joined through your invite so far 🎉`
    : "Forward this to a friend -- when they join, I'll let you know.";
  const lines = [`Your invite link:`];
  if (TELEGRAM_BOT_USERNAME && TELEGRAM_BOT_USERNAME !== 'YourNutriGapBot') {
    lines.push(`https://t.me/${TELEGRAM_BOT_USERNAME}?start=ref_${code}`);
  } else {
    // Bot username not configured server-side yet (see the
    // TELEGRAM_BOT_USERNAME constant near the top of this file) -- the
    // website link still works either way, so this never fully dead-ends.
    lines.push("(Telegram link isn't set up yet -- use the website link below for now.)");
  }
  lines.push('', countLine, '', `Works on the website too: nutrigap-app.vercel.app/?ref=${code}`);
  return lines.join('\n');
}

async function weeklyRecapReply(userId) {
  const todayIST = nc.istDateStr(new Date());
  const days = [];
  for (let i = 0; i < 7; i++) days.push(nc.istDateStr(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
  const startStr = days[days.length - 1], endStr = days[0];

  const [allRows, weekRows] = await Promise.all([
    db.select('diet_entries', { columns: 'entry_date', filters: ['user_id=eq.' + userId] }),
    db.select('diet_entries', {
      columns: 'entry_date',
      filters: ['user_id=eq.' + userId, 'entry_date=gte.' + startStr, 'entry_date=lte.' + endStr],
    }),
  ]);

  const logged = new Set((allRows || []).map(r => r.entry_date));
  let streakCurrent = 0, streakBest = 0;
  if (logged.size > 0) {
    const loggedToday = logged.has(todayIST);
    let cursor = new Date();
    if (!loggedToday) cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    while (logged.has(nc.istDateStr(cursor))) { streakCurrent++; cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000); }
    const sorted = Array.from(logged).sort();
    let run = 0, prev = null;
    sorted.forEach(d => {
      run = (prev && Math.round((new Date(d) - new Date(prev)) / 86400000) === 1) ? run + 1 : 1;
      streakBest = Math.max(streakBest, run);
      prev = d;
    });
  }

  const loggedDaysThisWeek = new Set((weekRows || []).map(r => r.entry_date)).size;
  const mealsThisWeek = (weekRows || []).length;
  const code = await ensureReferralCode(userId);

  const lines = [
    '📊 Your NutriGap week',
    '',
    `🔥 ${streakCurrent}-day streak${streakBest > streakCurrent ? ` (best: ${streakBest})` : ''}`,
    `✅ Logged ${loggedDaysThisWeek}/7 days this week`,
    `🍽 ${mealsThisWeek} meal${mealsThisWeek === 1 ? '' : 's'} tracked`,
  ];
  if (code) {
    lines.push('', "Forward this to a friend -- here's your invite link:", `nutrigap-app.vercel.app/?ref=${code}`);
  }
  return lines.join('\n');
}

// Tries to attach a real email (+ a temporary password) to the synthetic
// account so it's also usable from the website. Relies on Postgres/GoTrue's
// unique constraint on email as the dedupe check -- if that email already
// belongs to a real account, we hear about it as a 422/"already exists"
// error rather than needing a separate lookup call, and we point the
// person at the existing website-side linking flow instead of trying to
// merge two accounts automatically.
async function claimEmail(userId, email) {
  if (!isValidEmail(email)) {
    return "That didn't look like a valid email, so I've kept you on Telegram-only for now -- you can add one later from the website.";
  }
  const tempPassword = crypto.randomBytes(6).toString('hex');
  try {
    await db.authAdminUpdateUser(userId, { email, email_confirm: true, password: tempPassword });
    return `Your web login: ${email} / temporary password ${tempPassword} -- sign in at the website and change it whenever you like.`;
  } catch (e) {
    if (e.status === 422 || /already.*(registered|exists)/i.test(e.message || '')) {
      return `Looks like ${email} already has a NutriGap account -- I've kept this chat on its own profile for now. To link this chat to that account instead, open the website → Profile tab → "Connect Telegram" and send me the code it gives you.`;
    }
    console.error('Could not claim email for self-serve user:', e.message);
    return "Couldn't save that email just now -- you can add it later from the website.";
  }
}

async function finalizeOnboarding(chatId, userId, answers) {
  const profilePayload = {
    user_id: userId,
    age: answers.age,
    sex: answers.sex,
    height_cm: answers.height,
    weight_kg: answers.weight,
    frame: answers.frame,
    activity_level: parseFloat(answers.activity),
    goal: answers.goal,
    life_stage: answers.sex === 'female' ? (answers.life_stage || 'none') : 'none',
  };
  try {
    await db.insert('profiles', [profilePayload], { returning: false });
  } catch (e) {
    console.error('Could not save onboarding profile:', e.message);
    await sendMessage(chatId, "I hit a snag saving your profile -- try /start again in a moment, or finish setting up from the website instead.");
    return;
  }

  try { await db.authAdminUpdateUser(userId, { user_metadata: { full_name: answers.name } }); }
  catch (e) { console.error('Could not save display name:', e.message); }

  // Best-effort: give them their own invite code right away too, same as a
  // website signup gets the first time they open "Invite friends."
  try { await ensureReferralCode(userId); } catch (e) { console.error('Could not generate referral code:', e.message); }

  const rawEmail = String(answers.email || '');
  const wantsEmail = rawEmail && rawEmail.toLowerCase() !== 'skip';
  const emailNote = wantsEmail ? await claimEmail(userId, rawEmail) : '';

  await db.update('telegram_links', ['chat_id=eq.' + encodeURIComponent(String(chatId))], { onboarding_state: null });

  const targets = nc.computeTargets(profilePayload);
  const lines = [
    `You're all set, ${answers.name}! Estimated daily target: ~${Math.round(targets.kcal)} kcal, ${targets.protein}g protein.`,
  ];
  if (emailNote) lines.push(emailNote);
  lines.push('', HELP_TEXT);
  await sendMessage(chatId, lines.join('\n'), null, { menu: true });
}

async function handleOnboardingText(chatId, userId, state, text) {
  const field = ONBOARDING_FIELDS[state.step];
  if (field.kind === 'buttons') {
    await sendMessage(chatId, 'Tap one of the options above to answer this one.');
    await askOnboardingStep(chatId, state);
    return;
  }
  if (state.step === 'email') {
    const answers = { ...state.answers, email: field.parse(text) };
    await finalizeOnboarding(chatId, userId, answers);
    return;
  }
  const value = field.parse(text);
  if (value === null) {
    await sendMessage(chatId, field.invalidHint || "I didn't catch that -- try again?");
    return;
  }
  const answers = { ...state.answers, [state.step]: value };
  const nextStep = field.next(answers);
  if (!nextStep) { await finalizeOnboarding(chatId, userId, answers); return; }
  await askOnboardingStep(chatId, { step: nextStep, answers });
}

async function handleOnboardingButton(chatId, userId, state, data) {
  const parts = data.split(':');
  const step = parts[1];
  const value = parts.slice(2).join(':');
  if (step !== state.step) {
    // A tap on a stale/earlier question (already cleared or superseded) --
    // just re-ask the current one rather than silently doing nothing.
    await askOnboardingStep(chatId, state);
    return;
  }
  const field = ONBOARDING_FIELDS[step];
  if (!field.options.some(o => o.value === value)) { await askOnboardingStep(chatId, state); return; }
  const answers = { ...state.answers, [step]: value };
  const nextStep = field.next(answers);
  if (!nextStep) { await finalizeOnboarding(chatId, userId, answers); return; }
  await askOnboardingStep(chatId, { step: nextStep, answers });
}

async function handleCallbackQuery(cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const data = cq.data || '';
  if (!chatId) return;
  await answerCallbackQuery(cq.id);
  if (cq.message && cq.message.message_id) await clearKeyboard(chatId, cq.message.message_id);

  if (data === 'ob:begin' || data.startsWith('ob:begin:ref:')) {
    const existing = await findLink(chatId);
    if (existing) { await sendMessage(chatId, "This chat's already set up -- send /help to see what I can do."); return; }
    const refCode = data.startsWith('ob:begin:ref:') ? data.slice('ob:begin:ref:'.length) : null;
    const userId = await createSelfServeAccount(chatId, cq.from, refCode);
    if (!userId) { await sendMessage(chatId, "Something went wrong setting you up -- try again in a moment."); return; }
    await askOnboardingStep(chatId, { step: 'name', answers: {} });
    return;
  }
  if (data === 'ob:have_account') {
    await sendMessage(chatId, 'No problem -- open NutriGap on the website → Profile tab → "Connect Telegram", get a one-time code, then send it to me here (or send "/start CODE").');
    return;
  }

  const link = await findLink(chatId);
  if (!link) {
    await sendMessage(chatId, "This chat isn't set up yet -- send /start to get going.");
    return;
  }

  if (data.startsWith('log:')) {
    if (!link.pending_log || !link.pending_log.step) {
      await sendMessage(chatId, "That button doesn't apply anymore -- tell me what you ate, or tap 📝 Log a meal to start again.");
      return;
    }
    await handleLogButton(chatId, link.user_id, link.pending_log, data);
    return;
  }

  if (data.startsWith('doc:')) {
    await handleDocumentButton(chatId, link.user_id, data);
    return;
  }

  if (data.startsWith('docsmore:')) {
    const offset = parseInt(data.split(':')[1], 10) || 0;
    const { text: listText, keyboard } = await documentsListReply(link.user_id, offset);
    await sendMessage(chatId, listText, keyboard);
    return;
  }

  if (data.startsWith('uploadstart:')) {
    const kind = data.split(':')[1]; // 'report' | 'visit'
    await clearPendingLog(chatId);
    if (kind === 'report') {
      await setPendingUpload(chatId, { type: 'report', step: 'awaiting_file' });
      await sendMessage(chatId, "Send me a photo or PDF of your lab report, and I'll read the values off it. Send /documents any time to cancel.");
    } else if (kind === 'visit') {
      await setPendingUpload(chatId, { type: 'visit', step: 'visit_date', visit: {} });
      await sendMessage(chatId, 'What date was the visit? e.g. "2026-09-10" or "10 Sept". Send /documents any time to cancel.');
    }
    return;
  }

  if (data.startsWith('upload:')) {
    const state = link.pending_upload;
    if (!state || !state.step) {
      await sendMessage(chatId, "That button doesn't apply anymore -- send /documents to start again.");
      return;
    }
    const parts = data.split(':'); // upload:<kind>:<value>
    const kind = parts[1];
    const value = parts.slice(2).join(':');

    if (kind === 'reportsave') {
      if (state.type !== 'report' || state.step !== 'confirm') {
        await sendMessage(chatId, "That's expired -- send /uploadreport to try again.");
        return;
      }
      if (value === 'no') {
        await clearPendingUpload(chatId);
        await sendMessage(chatId, 'Okay, discarded -- nothing was saved. Send /uploadreport any time to try again.');
        return;
      }
      await sendTyping(chatId);
      try {
        const filePath = await telegramGetFilePath(state.fileId);
        const buffer = await downloadTelegramFileBytes(filePath);
        const path = `${link.user_id}/medical-reports/${Date.now()}-${sanitizeFileNameTG(state.fileName)}`;
        await db.storageUpload(DOCS_BUCKET, path, buffer, state.mimeType);
        await db.insert('medical_reports', [{
          user_id: link.user_id,
          patient_name: state.extracted.patientName || null,
          report_date: state.extracted.reportDate || null,
          file_name: state.fileName || null,
          markers: state.extracted.markers || [],
          storage_path: path,
        }], { returning: false });
        await clearPendingUpload(chatId);
        await sendMessage(chatId, 'Saved to your reports. You can share it anytime from the website, or send /latestreport to get it back here.');
      } catch (e) {
        console.error('Could not save uploaded report:', e.message);
        await sendMessage(chatId, "Couldn't save that just now -- try again.",
          [[{ text: '✅ Save', callback_data: 'upload:reportsave:yes' }, { text: '❌ Discard', callback_data: 'upload:reportsave:no' }]]);
      }
      return;
    }

    if (kind === 'doctype') {
      if (state.type !== 'visit' || state.step !== 'doc_type') {
        await sendMessage(chatId, "That button doesn't apply anymore -- send /documents to start again.");
        return;
      }
      let newState = { ...state, docType: value };
      if (!newState.visit.id) {
        try {
          const inserted = await db.insert('doctor_visits', [{
            user_id: link.user_id,
            visit_date: state.visit.visit_date,
            doctor_name: state.visit.doctor_name || null,
            specialty: state.visit.specialty || null,
            clinic_name: state.visit.clinic_name || null,
            visit_notes: null,
            follow_up_date: null,
          }]);
          const visitId = inserted && inserted[0] && inserted[0].id;
          if (!visitId) throw new Error('No id returned from doctor_visits insert');
          newState = { ...newState, visit: { ...newState.visit, id: visitId } };
        } catch (e) {
          console.error('Could not save visit:', e.message);
          await clearPendingUpload(chatId);
          await sendMessage(chatId, "Couldn't save the visit just now -- send /uploadvisit to try again.");
          return;
        }
      }
      newState.step = 'awaiting_file';
      await setPendingUpload(chatId, newState);
      await sendMessage(chatId, 'Now send the file (photo or PDF).');
      return;
    }

    if (kind === 'morefiles') {
      if (state.type !== 'visit' || state.step !== 'more_files') {
        await sendMessage(chatId, "That button doesn't apply anymore -- send /documents to start again.");
        return;
      }
      if (value === 'yes') {
        await setPendingUpload(chatId, { ...state, step: 'doc_type' });
        await askDocTypeButtons(chatId);
      } else {
        await clearPendingUpload(chatId);
        await sendMessage(chatId, "All set -- the visit's saved with its file(s). See it on the website's Doctor visits tab any time, or pull a prescription back here with /latestprescription.");
      }
      return;
    }
    return;
  }

  if (!link.onboarding_state || !link.onboarding_state.step) {
    await sendMessage(chatId, "That button doesn't apply anymore -- send /help to see what I can do.");
    return;
  }
  await handleOnboardingButton(chatId, link.user_id, link.onboarding_state, data);
}

// ---------- Guided meal logging (meal + date confirmation) ----------
//
// Every meal log -- whether it starts from a free-text message ("2
// chapathis for lunch") or the "📝 Log a meal" button -- goes through this
// short guided flow before anything is saved: confirm which meal it's for,
// confirm which date, then (if not already supplied up front) what was
// eaten, or a photo. This replaces silently guessing the meal from time of
// day and always assuming "today" -- someone logging a late breakfast, or
// backfilling yesterday's dinner, gets it attributed correctly instead of
// guessed at.
//
// State lives in telegram_links.pending_log (jsonb), the same pattern as
// onboarding_state: {step, text, meal, entryDate, photoFileId}. step is one
// of 'meal' | 'date' | 'custom_date' | 'items' | 'photo_confirm'. `text`
// holds the raw "what I ate" message when it was already supplied up front
// (the free-text entry point) -- in that case the flow skips straight to
// logging once meal and date are confirmed, instead of asking a third time
// for what was eaten. `photoFileId` is the same idea but for a photo sent
// up front (e.g. before tapping "Log a meal" at all) -- once meal and date
// are confirmed, it runs straight into the same photo-identification step
// a photo sent mid-flow would, instead of being discarded.

async function setPendingLog(chatId, state) {
  await db.update('telegram_links', ['chat_id=eq.' + encodeURIComponent(String(chatId))], { pending_log: state });
}

async function clearPendingLog(chatId) {
  await db.update('telegram_links', ['chat_id=eq.' + encodeURIComponent(String(chatId))], { pending_log: null });
}

async function startMealLogFlow(chatId, text, photoFileId) {
  const state = { step: 'meal', text: text || null, meal: null, entryDate: null, photoFileId: photoFileId || null };
  await setPendingLog(chatId, state);
  await sendMessage(chatId, 'Which meal is this for?', MEAL_OPTIONS.map(o => [{ text: o.label, callback_data: `log:meal:${o.value}` }]));
}

async function askLogDate(chatId, state) {
  await setPendingLog(chatId, state);
  await sendMessage(chatId, 'Which date?', [
    [{ text: 'Today', callback_data: 'log:date:today' }, { text: 'Yesterday', callback_data: 'log:date:yesterday' }],
    [{ text: '📅 Type a date', callback_data: 'log:date:custom' }],
  ]);
}

async function askLogItems(chatId, state) {
  await setPendingLog(chatId, state);
  await sendMessage(chatId, 'What did you eat? Type it, or send a photo of the meal.');
}

async function reaskCurrentLogStep(chatId, state) {
  if (state.step === 'date') { await askLogDate(chatId, state); return; }
  if (state.step === 'photo_confirm') {
    await sendMessage(chatId,
      `Still waiting on: log "${state.photoDescription}" under ${state.meal} (${dateLabelFor(state.entryDate)})?`,
      [[{ text: '✅ Yes, log it', callback_data: 'log:photoconfirm:yes' }, { text: '✏️ No, let me type it', callback_data: 'log:photoconfirm:no' }]]
    );
    return;
  }
  await sendMessage(chatId, 'Which meal is this for?', MEAL_OPTIONS.map(o => [{ text: o.label, callback_data: `log:meal:${o.value}` }]));
}

// Accepts "2026-10-05", or a day+month like "5 Oct" / "Oct 5" / "5 October"
// (assumed in the current year, rolled back a year if that would land in
// the future -- typing "25 Dec" in January means last Dec 25, not next).
// Deliberately rejects slash-style dates (e.g. "5/10") rather than guess
// DD/MM vs MM/DD -- an Indian user typing day-first into a US-style parser
// is exactly the kind of silent misread this flow exists to avoid. Also
// rejects anything outside the last 90 days or in the future, since those
// are almost always a typo rather than a real backfill.
function dateLabelFor(dateStr) {
  const todayIST = nc.istDateStr(new Date());
  const yesterdayIST = nc.istDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
  if (dateStr === todayIST) return 'today';
  if (dateStr === yesterdayIST) return 'yesterday';
  return dateStr;
}

function parseLoggedDate(text) {
  const now = new Date();
  const todayIST = nc.istDateStr(now);
  const t = String(text || '').trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
  if (iso) return iso <= todayIST ? iso : null;

  const year = now.getFullYear();
  const parsed = new Date(t + ' ' + year + ' UTC');
  if (Number.isNaN(parsed.getTime())) return null;
  let candidate = nc.istDateStr(parsed);
  if (candidate > todayIST) {
    const lastYear = new Date(Date.UTC(year - 1, parsed.getUTCMonth(), parsed.getUTCDate()));
    candidate = nc.istDateStr(lastYear);
  }
  const ninetyDaysAgo = nc.istDateStr(new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000));
  if (candidate < ninetyDaysAgo || candidate > todayIST) return null;
  return candidate;
}

async function finishMealLog(chatId, userId, state) {
  await sendTyping(chatId);
  const { reply, loggedAnything } = await logMeal(userId, state.text, state.meal, state.entryDate);
  await logMessage(userId, chatId, 'out', reply, 'log_meal');
  await sendMessage(chatId, reply);
  if (loggedAnything) {
    await clearPendingLog(chatId);
  } else {
    // A failed parse (nothing recognizable as food, or nothing in the
    // catalog matched) used to end the flow here anyway -- clearing
    // pending_log before even checking whether anything was logged. That
    // silently dropped the person out of the flow on the very first typo
    // or ambiguous phrasing (including "log a meal" itself getting
    // mistaken for food-sounding text by the classifier below and carried
    // forward as state.text). Meal and date are already confirmed, so
    // just ask again for what was eaten instead of dead-ending.
    await askLogItems(chatId, { ...state, text: null });
  }
}

async function proceedAfterDate(chatId, userId, state) {
  // A photo sent up front (before the flow even started) takes the same
  // priority as free text supplied up front -- run it through the exact
  // same identification + confirm-before-logging step a mid-flow photo
  // goes through, now that meal + date are confirmed, instead of making
  // the person resend the photo a second time.
  if (state.photoFileId) {
    await sendTyping(chatId);
    await handleMealPhoto(chatId, userId, state, state.photoFileId);
    return;
  }
  // Free-text entry point already supplied what they ate -- no need to ask
  // a third time, finish the log now that meal + date are confirmed.
  if (state.text) { await finishMealLog(chatId, userId, state); return; }
  await askLogItems(chatId, state);
}

async function handleLogButton(chatId, userId, state, data) {
  const parts = data.split(':');
  const kind = parts[1];
  const value = parts.slice(2).join(':');

  if (kind === 'meal') {
    if (state.step !== 'meal' || !MEAL_VALUES.includes(value)) { await reaskCurrentLogStep(chatId, state); return; }
    await askLogDate(chatId, { ...state, meal: value, step: 'date' });
    return;
  }
  if (kind === 'date') {
    if (state.step !== 'date') { await reaskCurrentLogStep(chatId, state); return; }
    if (value === 'today' || value === 'yesterday') {
      const entryDate = value === 'today' ? nc.istDateStr(new Date()) : nc.istDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
      await proceedAfterDate(chatId, userId, { ...state, entryDate, step: 'items' });
      return;
    }
    if (value === 'custom') {
      await setPendingLog(chatId, { ...state, step: 'custom_date' });
      await sendMessage(chatId, 'What date? Send it like "2026-10-05" or "5 Oct" (up to 90 days back, not in the future).');
      return;
    }
  }
  if (kind === 'photoconfirm') {
    if (state.step !== 'photo_confirm') { await reaskCurrentLogStep(chatId, state); return; }
    if (value === 'yes') {
      await sendTyping(chatId);
      const { reply, loggedAnything } = await logMeal(userId, state.photoDescription, state.meal, state.entryDate);
      await logMessage(userId, chatId, 'out', reply, 'log_meal');
      await sendMessage(chatId, reply);
      // They confirmed the identification was right either way -- a
      // catalog-match miss afterward is a separate, honestly-flagged issue
      // (see logMeal()'s food_requests fallback), not a wrong identification.
      if (state.photoLogId) {
        try { await db.update('meal_photo_logs', ['id=eq.' + state.photoLogId], { confirmed: true }); }
        catch (e) { console.error('Could not mark photo log confirmed:', e.message); }
      }
      if (loggedAnything) {
        await clearPendingLog(chatId);
      } else {
        // Same fix as finishMealLog() above -- don't dead-end the flow on
        // a catalog-match miss, ask for it in different words instead.
        await askLogItems(chatId, { ...state, step: 'items', photoDescription: null, photoLogId: null });
      }
      return;
    }
    if (value === 'no') {
      if (state.photoLogId) {
        try { await db.update('meal_photo_logs', ['id=eq.' + state.photoLogId], { confirmed: false }); }
        catch (e) { console.error('Could not mark photo log declined:', e.message); }
      }
      await askLogItems(chatId, { ...state, step: 'items', photoDescription: null, photoLogId: null });
      return;
    }
  }
  await reaskCurrentLogStep(chatId, state);
}

// ---------- Meal-photo identification ----------
//
// This never invents macros or logs anything by itself. It only identifies
// roughly what's on the plate (the same kind of plain description a person
// would type -- "2 rotis with dal and a side salad"), which then goes
// through the EXACT same strict catalog-matching logMeal() already uses
// for typed text (see extractMealItems() above) -- so a photo can only
// ever result in an exact catalog match or an honestly-flagged miss, never
// a guessed dish or a guessed nutrient value. And nothing from a photo is
// logged without the person seeing the guess and confirming it first --
// same confirm-before-logging principle as the meal/date steps above.
// When the photo can't be confidently read (blurry, no food visible, or
// the model just isn't sure), it falls back to the old honest placeholder:
// saved for manual review, plainly told it doesn't count yet.

async function telegramGetFilePath(fileId) {
  const res = await fetch(TELEGRAM_API + '/getFile?file_id=' + encodeURIComponent(fileId));
  if (!res.ok) throw new Error('Telegram getFile failed: ' + res.status);
  const data = await res.json();
  if (!data.ok || !data.result || !data.result.file_path) throw new Error('Telegram getFile returned no file_path');
  return data.result.file_path;
}

async function downloadTelegramFileAsBase64(filePath) {
  const url = 'https://api.telegram.org/file/bot' + process.env.TELEGRAM_BOT_TOKEN + '/' + filePath;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Telegram file download failed: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return { base64: buf.toString('base64'), mediaType };
}

// Plain-bytes version used by the "upload a report / prescription from
// Telegram" flow below -- unlike downloadTelegramFileAsBase64 above (which
// only ever deals with meal photos and always assumes an image type from
// the file extension), a medical document can be a PDF, and Telegram tells
// us its real mime_type directly on message.document, so there's no
// extension-sniffing needed here -- the caller already knows the type.
async function downloadTelegramFileBytes(filePath) {
  const url = 'https://api.telegram.org/file/bot' + process.env.TELEGRAM_BOT_TOKEN + '/' + filePath;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Telegram file download failed: ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

// Looks at one meal photo and tries to say, in plain language, what's on
// the plate. Returns {confident, description, note} -- description is
// only ever non-empty when confident is true, and note is always a short,
// honest caveat (portion sizes are a guess from a photo either way).
async function identifyFoodFromPhoto(apiKey, base64, mediaType) {
  const systemPrompt = `You're looking at one photo of a meal someone is about to log in a nutrition-tracking app. Describe what's on the plate the way a person would type it into a food diary -- e.g. "2 rotis with dal and a side salad" or "a bowl of curd rice with pickle".

Rules -- these matter more than being helpful:
- Only describe what you can actually see. Never name a specific branded or regional dish unless it's unmistakable from the photo -- prefer a plain description of the visible components (grain/bread, curry/gravy, vegetable, protein source) over guessing an exact recipe name.
- Never guess at ingredients hidden inside a dish (a curry's exact spices, what's inside a stuffed paratha, etc).
- If the photo is blurry, dark, shows no food, or you're genuinely not confident what it shows, set "confident" to false rather than guessing -- being wrong here would log the wrong thing against someone's health data.
- Don't estimate exact weights or calories yourself -- just describe the food and a rough everyday portion ("a bowl of", "2 pieces of", "a small side of").

Respond with ONLY a JSON object, no markdown, no commentary, in exactly this shape:
{"confident": true, "description": "...", "note": "portion size is an estimate from the photo"}

If not confident:
{"confident": false, "description": null, "note": "the photo is too blurry to tell what's on the plate"}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: 'What does this meal photo show?' },
        ],
      }],
    }),
  });
  if (!response.ok) throw new Error('Anthropic vision API error: ' + (await response.text()));
  const data = await response.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  let cleaned = ((textBlock && textBlock.text) || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch (e) { return { confident: false, description: null, note: "couldn't make sense of the photo" }; }
  return {
    confident: parsed.confident === true && typeof parsed.description === 'string' && parsed.description.trim().length > 0,
    description: typeof parsed.description === 'string' ? parsed.description.trim() : null,
    note: typeof parsed.note === 'string' ? parsed.note : '',
  };
}

// Entry point when a photo arrives at the "what did you eat" step. Always
// saves a meal_photo_logs row either way (the team's own manual-review
// backstop, same as before this feature existed) -- confident or not, so
// nothing is ever lost. A confident read moves the flow to a new
// "photo_confirm" step and waits for a yes/no tap before logging anything;
// an unconfident one (or any failure downloading/analyzing the photo --
// fails closed, never guesses to cover for an error) falls back to asking
// the person to type it instead, same as the original placeholder.
async function handleMealPhoto(chatId, userId, state, fileId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let result = { confident: false, description: null, note: '' };
  if (apiKey) {
    try {
      const filePath = await telegramGetFilePath(fileId);
      const { base64, mediaType } = await downloadTelegramFileAsBase64(filePath);
      result = await identifyFoodFromPhoto(apiKey, base64, mediaType);
    } catch (e) {
      console.error('Photo identification failed:', e.message);
    }
  }

  let logId = null;
  try {
    const inserted = await db.insert('meal_photo_logs', [{
      user_id: userId, chat_id: String(chatId), meal: state.meal, entry_date: state.entryDate,
      telegram_file_id: fileId, ai_description: result.description, ai_confident: result.confident,
    }]);
    logId = inserted && inserted[0] && inserted[0].id;
  } catch (e) {
    console.error('Could not save meal photo log:', e.message);
  }

  if (!result.confident) {
    await clearPendingLog(chatId);
    const reason = result.note ? ` (${result.note})` : '';
    await sendMessage(chatId,
      `I couldn't confidently tell what's in that photo${reason} -- saved it for the team to review, but it won't count toward your numbers yet. Type what you ate instead and I'll log that properly, e.g. "2 chapathis and dal".`
    );
    return;
  }

  await setPendingLog(chatId, { ...state, step: 'photo_confirm', photoFileId: null, photoDescription: result.description, photoLogId: logId });
  const noteLine = result.note ? `\n(${result.note})` : '';
  await sendMessage(chatId,
    `Looks like: ${result.description}${noteLine}\n\nLog this under ${state.meal} (${dateLabelFor(state.entryDate)})?`,
    [[{ text: '✅ Yes, log it', callback_data: 'log:photoconfirm:yes' }, { text: '✏️ No, let me type it', callback_data: 'log:photoconfirm:no' }]]
  );
}

// Lets someone escape the guided flow mid-way (tapping a different menu
// button, or sending a recognized command) instead of getting trapped --
// the half-finished log is just dropped, and whatever they sent is handled
// normally from there.
const LOG_FLOW_ESCAPE_COMMANDS = new Set([
  '/start', '/help', '/gap', '/today', '/meals', '/ideas', '/appointments',
  '/unlink', '/nudges', '/nudges on', '/nudges off', '/log',
  '/documents', '/latestreport', '/latestprescription',
  '/uploadreport', '/uploadvisit', '/invite', '/recap',
]);
function isEscapeFromLogFlow(text) {
  if (!text) return false;
  if (text === '📝 Log a meal') return true;
  const lower = (BUTTON_TO_COMMAND[text] || text).toLowerCase();
  return LOG_FLOW_ESCAPE_COMMANDS.has(lower);
}

// Same idea as isEscapeFromLogFlow above, for the "upload a report /
// prescription" guided flow below -- shares the same command set, since
// any of those recognized commands/buttons should equally interrupt
// whichever guided flow happens to be in progress.
function isEscapeFromUploadFlow(text) {
  if (!text) return false;
  if (text === '📝 Log a meal') return true;
  const lower = (BUTTON_TO_COMMAND[text] || text).toLowerCase();
  return LOG_FLOW_ESCAPE_COMMANDS.has(lower);
}

// ---------- Gap summary ----------

async function loadTargets(userId) {
  const rows = await db.select('profiles', { columns: '*', filters: ['user_id=eq.' + userId], limit: 1 });
  const profile = rows && rows[0];
  if (!profile || !profile.age || !profile.sex || !profile.height_cm || !profile.weight_kg) return null;
  return { profile, targets: nc.computeTargets(profile) };
}

async function loadEntriesForDate(userId, dateStr) {
  const rows = await db.select('diet_entries', {
    columns: 'id,servings,meal,entry_date,food_id,meal_box_item_id,foods(*),meal_box_items(*)',
    filters: ['user_id=eq.' + userId, 'entry_date=eq.' + dateStr],
  });
  return (rows || []).map(row => ({
    ...(row.meal_box_item_id ? nc.mapMealBoxRow(row.meal_box_items || {}) : nc.mapFoodRow(row.foods || {})),
    servings: row.servings, meal: row.meal,
  }));
}

// Macro gap keys (fiber counts as a macro here, matching macroDefs in
// nutrition-core.js/index.html). kcal is excluded -- it's already shown on
// its own line above the gap lists.
const MACRO_GAP_KEYS = ['protein', 'carbs', 'fat', 'fiber'];

function formatGapLine(g) {
  if (g.isLimit) return `• ${g.label}: ${g.consumed}${g.unit} (limit ${g.target}${g.unit}) — over`;
  const verb = g.direction === 'short' ? 'short' : 'over';
  const amt = Math.abs(g.target - g.consumed);
  return `• ${g.label}: ${g.consumed}${g.unit} / ${g.target}${g.unit} — ${Math.round(amt * 10) / 10}${g.unit} ${verb}`;
}

function formatGapSummary(t, tg, dateLabel, entries) {
  if (!tg.kcal) return "You haven't finished setting up your profile yet -- add your age, sex, height and weight on the website (Profile tab) first, then I can work out your targets.";
  const ranked = nc.rankGapsForInsight(t, tg);
  const kcalLine = `Calories: ${Math.round(t.kcal)} / ${Math.round(tg.kcal)} kcal`;
  const partialCount = (entries || []).filter(e => e.isPartial).length;
  const partialNote = partialCount > 0
    ? `\n\n(${partialCount} BFB meal-box item${partialCount === 1 ? '' : 's'} logged ${dateLabel.toLowerCase()} -- tracked for calories/protein/carbs/fat only, so fiber/micronutrient numbers above may be a bit better than what was actually eaten.)`
    : '';

  // rankGapsForInsight ranks every off-target nutrient by % off target --
  // left as one list, calcium/vitamin-type gaps (which tend to run at much
  // higher % off) crowd out protein/carbs/fat/fiber even when those are
  // meaningfully off too. So: always surface the macro gaps that exist,
  // separately from a capped top-N of the micronutrient gaps, rather than
  // letting them compete in one ranking.
  const macroGaps = ranked.filter(g => MACRO_GAP_KEYS.includes(g.key));
  const microGaps = ranked.filter(g => !MACRO_GAP_KEYS.includes(g.key)).slice(0, 4);

  if (macroGaps.length === 0 && microGaps.length === 0) {
    return `${dateLabel}'s log — ${kcalLine}. Everything else is on target. Nicely balanced day.${partialNote}`;
  }

  const sections = [];
  if (macroGaps.length > 0) sections.push(`Macros:\n${macroGaps.map(formatGapLine).join('\n')}`);
  if (microGaps.length > 0) sections.push(`Biggest micronutrient gaps:\n${microGaps.map(formatGapLine).join('\n')}`);

  return `${dateLabel}'s log — ${kcalLine}\n\n${sections.join('\n\n')}\n\nAsk me anything about these, or say what you're planning to eat next and I can tell you how it'd help.${partialNote}`;
}

async function gapSummary(userId) {
  const loaded = await loadTargets(userId);
  if (!loaded) return "You haven't finished setting up your profile yet -- add your age, sex, height and weight on the website (Profile tab) first, then I can work out your targets.";
  const dateStr = nc.istDateStr(new Date());
  const entries = await loadEntriesForDate(userId, dateStr);
  if (entries.length === 0) return "You haven't logged anything today yet. Tell me what you've eaten and I'll get it started.";
  const t = nc.totals(entries);
  return formatGapSummary(t, loaded.targets, 'Today', entries);
}

// ---------- Meal-box ideas (gap-bridging suggestions from BFB's menu) ----------
// meal_box_items is a deliberately separate catalog from foods -- BFB's
// ~1,200-dish subscription menu, never merged into the personal diet-log
// catalog (that's what caused the earlier macro-only-import detour: the
// menu has real data-quality issues and nowhere near the completeness
// foods assumes). This only ever suggests IDEAS, never logs anything, and
// mirrors the website's Meal Box "Best for today's gap" mode via the
// shared scoring in lib/nutrition-core.js so the two channels never
// recommend differently for the same numbers.

async function loadMealBoxItems() {
  const rows = await db.select('meal_box_items', { limit: 2000 });
  return rows || [];
}

async function loadFoodsFull() {
  const rows = await db.select('foods');
  return (rows || []).map(nc.mapFoodRow);
}

function formatMealBoxDish(d) {
  const bits = [];
  if (Number.isFinite(d.kcal)) bits.push(`${Math.round(d.kcal)} kcal`);
  if (Number.isFinite(d.protein)) bits.push(`${d.protein}g protein`);
  if (Number.isFinite(d.carbs)) bits.push(`${d.carbs}g carbs`);
  if (Number.isFinite(d.fat)) bits.push(`${d.fat}g fat`);
  const tag = d.meal_type ? ` (${d.meal_type}${d.meal_course ? ', ' + d.meal_course : ''})` : '';
  return `• ${d.name}${tag} — ${bits.join(', ')}`;
}

// Common nutrient names/synonyms people actually type in Telegram, mapped
// onto the exact lib/nutrition-core.js ALL_NUTRIENT_DEFS key -- so a
// question that names a specific nutrient ("vitamin K", "iron", "fibre")
// gets an answer about THAT nutrient instead of whatever today's single
// biggest gap happens to be (the bug the user flagged: asking about
// vitamin C and vitamin K back to back got the identical reply, both
// times about vitamin K, because the old code never looked at what was
// actually asked). Deliberately a plain regex list, not another AI call --
// the vocabulary is small and closed (five macros + ten-odd micros), so
// this is free and instant where an extra Claude call would be neither,
// directly answering the "token efficient" part of the ask.
const NUTRIENT_ALIASES = [
  { key: 'vitB12', re: /\bvit(?:amin)?\.?\s*b\s*-?\s*12\b/i },
  { key: 'vitB6', re: /\bvit(?:amin)?\.?\s*b\s*-?\s*6\b/i },
  { key: 'vitK', re: /\bvit(?:amin)?\.?\s*k\b/i },
  { key: 'vitC', re: /\bvit(?:amin)?\.?\s*c\b/i },
  { key: 'vitD', re: /\bvit(?:amin)?\.?\s*d\b/i },
  { key: 'vitA', re: /\bvit(?:amin)?\.?\s*a\b/i },
  { key: 'vitE', re: /\bvit(?:amin)?\.?\s*e\b/i },
  { key: 'folate', re: /\bfolate\b|\bfolic\s*acid\b|\bvit(?:amin)?\.?\s*b\s*-?\s*9\b/i },
  { key: 'iron', re: /\biron\b/i },
  { key: 'calcium', re: /\bcalcium\b/i },
  { key: 'magnesium', re: /\bmagnesium\b/i },
  { key: 'zinc', re: /\bzinc\b/i },
  { key: 'potassium', re: /\bpotassium\b/i },
  { key: 'sodium', re: /\bsodium\b|\bsalt\b/i },
  { key: 'selenium', re: /\bselenium\b/i },
  { key: 'fiber', re: /\bfib(?:er|re)\b/i },
  { key: 'protein', re: /\bprotein\b/i },
  { key: 'carbs', re: /\bcarb(?:ohydrate)?s?\b/i },
  { key: 'fat', re: /\bfat\b/i },
  { key: 'kcal', re: /\bcal(?:orie)?s?\b/i },
];

function extractNamedNutrient(text) {
  if (!text) return null;
  for (const { key, re } of NUTRIENT_ALIASES) {
    if (re.test(text)) return key;
  }
  return null;
}

// Answers a question about ONE specific nutrient (e.g. "suggestions to
// bridge my vitamin C gap") instead of the generic "what's left of today's
// targets" answer mealIdeas() gives by default -- a vitamin K question and
// a vitamin C question must never come back with the same text.
// meal_box_items only ever carries kcal/protein/carbs/fat (see
// MEALBOX_COVERED_GAP_LABELS), so a BFB dish list only ever appears for
// one of those four; any other nutrient (fiber, any vitamin/mineral) goes
// straight to the verified `foods` catalog, which is the only place that
// data actually exists -- never shown as if a meal-box dish could help.
async function nutrientSpecificIdeas(t, tg, nutrientKey) {
  const def = nc.ALL_NUTRIENT_DEFS.find(d => d.key === nutrientKey);
  if (!def) {
    return "I don't have that one in my tracking list -- ask me about calories, protein, carbs, fat, fiber, or any of the vitamins/minerals on your gap summary.";
  }

  const consumed = t[nutrientKey] || 0;
  const target = tg[nutrientKey] || 0;

  if (def.type === 'limit') {
    if (consumed > target) {
      return `${def.label} is a limit, not something to fill up -- you're already ${Math.round(consumed - target)}${def.unit} over today's limit, so the move is eating less of it, not more.`;
    }
    return `${def.label} is a limit, not a gap -- you're within today's limit (${Math.round(consumed)}${def.unit} of ${Math.round(target)}${def.unit}), so there's nothing to bridge there.`;
  }

  const { cls } = nc.gapStatus(def, consumed, target);
  if (cls === 'met') {
    return `You're already on target for ${def.label.toLowerCase()} today (${Math.round(consumed)}${def.unit} of ${Math.round(target)}${def.unit}) -- no gap to bridge there right now.`;
  }

  const shortBy = Math.round(target - consumed);
  const lines = [`Your ${def.label.toLowerCase()} gap today: ${Math.round(consumed)}${def.unit} of ${Math.round(target)}${def.unit} so far -- ${shortBy}${def.unit} short.`];

  if (nc.MEALBOX_COVERED_GAP_LABELS.includes(def.label)) {
    const remaining = {
      kcal: Math.max(0, tg.kcal - t.kcal),
      protein: Math.max(0, tg.protein - t.protein),
      carbs: Math.max(0, tg.carbs - t.carbs),
      fat: Math.max(0, tg.fat - t.fat),
    };
    const items = await loadMealBoxItems();
    const top = nc.rankMealBoxForGap(remaining, items).slice(0, 3);
    if (top.length > 0) {
      lines.push(`\nBFB meal-box ideas that help with this:`);
      lines.push(top.map(formatMealBoxDish).join('\n'));
    }
  }

  const foods = await loadFoodsFull();
  const fallback = nc.pickFoodFallbackForNutrient(t, tg, foods, nutrientKey);
  if (fallback && !fallback.met && fallback.top.length > 0) {
    lines.push(`\nTop individual foods for your ${def.label.toLowerCase()} gap:`);
    lines.push(fallback.top.map(f => {
      const pct = Math.round(((f[nutrientKey] || 0) / (fallback.remaining || 1)) * 100);
      return `• ${f.name} — covers ${pct}% of it, ${Math.round(f.kcal)} kcal/serving`;
    }).join('\n'));
  }

  return lines.join('\n');
}

async function mealIdeas(userId, targetNutrientKey) {
  const loaded = await loadTargets(userId);
  if (!loaded) return "You haven't finished setting up your profile yet -- add your age, sex, height and weight on the website (Profile tab) first, then I can work out your targets.";
  const dateStr = nc.istDateStr(new Date());
  const entries = await loadEntriesForDate(userId, dateStr);
  const t = nc.totals(entries);
  const tg = loaded.targets;

  if (targetNutrientKey) {
    return nutrientSpecificIdeas(t, tg, targetNutrientKey);
  }

  const remaining = {
    kcal: Math.max(0, tg.kcal - t.kcal),
    protein: Math.max(0, tg.protein - t.protein),
    carbs: Math.max(0, tg.carbs - t.carbs),
    fat: Math.max(0, tg.fat - t.fat),
  };
  if (remaining.kcal <= 0) {
    return "You've already met (or gone over) today's calorie target based on your log -- no meal-box suggestions for the rest of today.";
  }

  const items = await loadMealBoxItems();
  const ranked = nc.rankMealBoxForGap(remaining, items);
  const top = ranked.slice(0, 3);

  const rankedGaps = nc.rankGapsForInsight(t, tg);
  const topGap = rankedGaps[0];
  const topGapNotCoverable = !!topGap && !nc.MEALBOX_COVERED_GAP_LABELS.includes(topGap.label);

  const lines = [];
  if (top.length > 0) {
    lines.push(`Best BFB meal-box ideas for what's left of today (${Math.round(remaining.kcal)} kcal, ${Math.round(remaining.protein)}g protein, ${Math.round(remaining.carbs)}g carbs, ${Math.round(remaining.fat)}g fat remaining):`);
    lines.push(top.map(formatMealBoxDish).join('\n'));
  } else {
    lines.push("No meal-box dishes fit what's left of today's targets right now.");
  }

  // Meal-box dishes only carry calories/protein/carbs/fat -- when the real
  // biggest gap is fiber or a micronutrient, say so plainly and point at
  // real foods for that specific nutrient instead of staying silent about
  // the blind spot or, worse, implying a meal-box dish covers it.
  if (top.length === 0 || topGapNotCoverable) {
    const foods = await loadFoodsFull();
    const fallback = nc.pickFoodFallbackForGap(t, tg, foods, rankedGaps);
    if (fallback && fallback.top.length > 0) {
      const { spotlightGap, spotlightDef, remainingAll, top: foodTop } = fallback;
      if (topGapNotCoverable) {
        lines.push(`\nRight now your biggest real gap is ${spotlightGap.label} -- meal-box dishes only carry calories, protein, carbs and fat, so they can't show whether one would help with that.`);
      }
      lines.push(`Top individual foods for your ${spotlightGap.label.toLowerCase()} gap:`);
      lines.push(foodTop.map(f => {
        const pct = Math.round(((f[spotlightDef.key] || 0) / (remainingAll[spotlightDef.key] || 1)) * 100);
        return `• ${f.name} — covers ${pct}% of it, ${Math.round(f.kcal)} kcal/serving`;
      }).join('\n'));
    }
  }

  return lines.join('\n');
}

// ---------- Meal logging ----------

async function loadFoodCatalog() {
  const rows = await db.select('foods', { columns: 'id,name', order: 'name.asc' });
  return rows || [];
}

// Used only as a fallback inside logMeal(), after an item fails to match the
// real `foods` catalog -- see the comment above that fallback for why.
async function loadMealBoxCatalog() {
  const rows = await db.select('meal_box_items', { columns: 'id,name', limit: 2000 });
  return rows || [];
}

// Simple case-insensitive exact/substring match -- meal-box dish names are
// specific enough (e.g. "Lentil soup", "Chicken green salad") that this is
// enough to find a real match without a second AI call per message. Picks
// the shortest-name match among substring hits as the most specific one.
function matchMealBoxItem(queryText, mealBoxCatalog) {
  const q = String(queryText || '').trim().toLowerCase();
  if (!q) return null;
  const exact = mealBoxCatalog.find(m => m.name.toLowerCase() === q);
  if (exact) return exact;
  const contains = mealBoxCatalog.filter(m => {
    const name = m.name.toLowerCase();
    return name.includes(q) || q.includes(name);
  });
  if (contains.length > 0) return contains.sort((a, b) => a.name.length - b.name.length)[0];
  return null;
}

// Feeds Telegram's unmatched items into the same food_requests table the
// website's "Can't find a food? Let us know" button writes to -- so a
// miss here isn't just a dead end, it's a prioritizable backlog entry,
// exactly like a website miss already is. Best-effort: never worth
// failing or slowing down a meal-log reply over.
async function recordFoodRequests(userId, queryTexts) {
  const names = (queryTexts || []).map(t => String(t || '').trim()).filter(Boolean);
  if (names.length === 0) return;
  try {
    await db.insert('food_requests', names.map(requested_name => ({ user_id: userId, requested_name })), { returning: false });
  } catch (e) {
    console.error('Could not record food request(s) from Telegram:', e.message);
  }
}

async function extractMealItems(apiKey, text, catalog, mealHint) {
  const catalogList = catalog.map(f => f.name).join('\n');
  const systemPrompt = `You extract food items from a message someone sent about what they ate, matching each one against NutriGap's real food catalog.

Rules:
- Only ever use a food name that appears EXACTLY (character for character) in the catalog list below. Never invent, rename, or guess-spell a food that isn't in the list.
- If something the person mentioned has no reasonable match in the catalog, include it with "name": null and put what they said in "queryText".
- "servings" is a multiplier (1 = one standard serving of that catalog item). Default to 1 if not stated. "2 chapathis" of a food whose catalog entry IS "Chapathi" (one piece) means servings:2.
- If the message says which meal this was (breakfast/lunch/dinner/snack, or a synonym), set "meal" to one of: breakfast, lunch, dinner, snack. Otherwise set "meal" to null.

Respond with ONLY a JSON object, no markdown, no commentary, in exactly this shape:
{"items": [{"name": "...", "queryText": "...", "servings": 1}], "meal": "lunch"}

Catalog (one food name per line):
${catalogList}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!response.ok) throw new Error('Anthropic API error: ' + (await response.text()));
  const data = await response.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  let cleaned = ((textBlock && textBlock.text) || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch (e) { return { items: [], meal: null }; }

  // Guardrail: only accept items whose name is an exact match in the real
  // catalog -- never trust the model's own spelling, same backstop pattern
  // used in api/insights.js.
  const validNames = new Set(catalog.map(f => f.name));
  const items = Array.isArray(parsed.items) ? parsed.items.filter(it => it && typeof it === 'object') : [];
  const meal = MEAL_VALUES.includes(parsed.meal) ? parsed.meal : (mealHint && MEAL_VALUES.includes(mealHint) ? mealHint : null);
  return {
    items: items.map(it => ({
      name: typeof it.name === 'string' && validNames.has(it.name) ? it.name : null,
      queryText: typeof it.queryText === 'string' ? it.queryText : (typeof it.name === 'string' ? it.name : ''),
      servings: Number.isFinite(it.servings) && it.servings > 0 ? it.servings : 1,
    })),
    meal,
  };
}

// `meal` and `entryDate` are the values the person already confirmed via
// the guided flow above (startMealLogFlow / handleLogButton) -- logMeal()
// no longer guesses either one. extractMealItems() still asks the model to
// notice a meal mentioned in the text itself, but that's now informational
// only (useful if it ever disagrees enough to investigate); the confirmed
// value always wins.
//
// Returns {reply, loggedAnything} rather than a bare string -- callers
// (finishMealLog, the photo-confirm "yes" handler) need to know whether
// anything actually got written before they clear the guided flow's
// pending_log, so a failed parse re-asks what was eaten instead of
// silently dropping the person out of an in-progress log.
async function logMeal(userId, text, meal, entryDate) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { reply: "Something's misconfigured on the server side -- Aravinth's been notified.", loggedAnything: false };

  const catalog = await loadFoodCatalog();
  if (catalog.length === 0) return { reply: "I couldn't reach the food catalog just now -- try again in a moment.", loggedAnything: false };

  const { items } = await extractMealItems(apiKey, text, catalog, meal);
  if (items.length === 0) {
    return { reply: "I couldn't tell what you ate from that -- try naming the dish more directly, e.g. \"2 chapathis with palak matar for lunch\".", loggedAnything: false };
  }

  const matched = items.filter(it => it.name);
  let unmatched = items.filter(it => !it.name);

  // Before giving up on something the real foods catalog has no match for,
  // check whether it's actually a BFB meal-box dish -- real, just macro-only.
  // Logged as its own partial kind of diet_entries row (meal_box_item_id,
  // not food_id) rather than either passing it off as a complete food or
  // silently dropping it to the food_requests backlog. See mapMealBoxRow()
  // in lib/nutrition-core.js for how this stays honest in the gap math.
  const mealBoxCatalog = unmatched.length > 0 ? await loadMealBoxCatalog() : [];
  const mealBoxMatches = [];
  const stillUnmatched = [];
  unmatched.forEach(u => {
    const hit = matchMealBoxItem(u.queryText, mealBoxCatalog);
    if (hit) mealBoxMatches.push({ ...u, mealBoxId: hit.id, mealBoxName: hit.name });
    else stillUnmatched.push(u);
  });
  unmatched = stillUnmatched;

  if (matched.length === 0 && mealBoxMatches.length === 0) {
    await recordFoodRequests(userId, unmatched.map(u => u.queryText));
    return { reply: `I couldn't find "${unmatched.map(u => u.queryText).join('", "')}" in the food catalog yet -- I've flagged it for the team to add. Try describing it differently in the meantime, or it may just not be in there yet.`, loggedAnything: false };
  }

  const nameToId = new Map(catalog.map(f => [f.name, f.id]));
  const entryDateStr = entryDate || nc.istDateStr(new Date());
  const rows = matched.map(it => ({
    user_id: userId, entry_date: entryDateStr, food_id: nameToId.get(it.name), servings: it.servings, meal,
  }));
  const mealBoxRows = mealBoxMatches.map(it => ({
    user_id: userId, entry_date: entryDateStr, meal_box_item_id: it.mealBoxId, servings: it.servings, meal,
  }));
  if (rows.length > 0) await db.insert('diet_entries', rows, { returning: false });
  if (mealBoxRows.length > 0) await db.insert('diet_entries', mealBoxRows, { returning: false });

  const loggedLines = matched.map(it => `${it.servings === 1 ? '' : it.servings + '× '}${it.name}`);
  const mealBoxLines = mealBoxMatches.map(it => `${it.servings === 1 ? '' : it.servings + '× '}${it.mealBoxName} (BFB box)`);
  let reply = `Logged under ${meal} (${dateLabelFor(entryDateStr)}): ${[...loggedLines, ...mealBoxLines].join(', ')}.`;
  if (mealBoxMatches.length > 0) {
    reply += ` Note: the BFB meal-box item${mealBoxMatches.length === 1 ? '' : 's'} only track${mealBoxMatches.length === 1 ? 's' : ''} calories/protein/carbs/fat -- fiber and micronutrients aren't counted for ${mealBoxMatches.length === 1 ? 'it' : 'those'}.`;
  }
  if (unmatched.length > 0) {
    await recordFoodRequests(userId, unmatched.map(u => u.queryText));
    reply += ` (Couldn't match: "${unmatched.map(u => u.queryText).join('", "')}" -- not in the catalog yet, flagged for the team.)`;
  }
  reply += ' Ask "what\'s my gap today?" any time to see how that shifted things.';
  return { reply, loggedAnything: true };
}

// ---------- Dietitian chat (shared thread with the website's Dietitian tab) ----------

async function loadDietitianHistory(userId, limit) {
  const rows = await db.select('dietitian_messages', {
    columns: 'role,content,created_at',
    filters: ['user_id=eq.' + userId],
    order: 'created_at.desc',
    limit: limit || 20,
  });
  return (rows || []).reverse().map(r => ({ role: r.role, content: r.content }));
}

async function buildDietitianContext(userId) {
  const loaded = await loadTargets(userId);
  if (!loaded) return {};
  const dateStr = nc.istDateStr(new Date());
  const entries = await loadEntriesForDate(userId, dateStr);
  const t = nc.totals(entries);
  const rankedGaps = nc.rankGapsForInsight(t, loaded.targets);
  return { goal: loaded.profile.goal, targets: loaded.targets, rankedGaps };
}

async function dietitianChat(userId, text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "Something's misconfigured on the server side -- Aravinth's been notified.";

  await db.insert('dietitian_messages', [{ user_id: userId, role: 'user', content: text, channel: 'telegram' }], { returning: false });

  const history = await loadDietitianHistory(userId, 20);
  const context = await buildDietitianContext(userId);
  try {
    const { reply, suggestBooking } = await callDietitianModel({ apiKey, messages: history, context, channel: 'telegram' });
    await db.insert('dietitian_messages', [{ user_id: userId, role: 'assistant', content: reply, channel: 'telegram' }], { returning: false });
    return reply;
  } catch (e) {
    return e.userMessage || "Sorry, I couldn't reply just now -- try again in a moment.";
  }
}

// ---------- Appointments ----------

function formatAppointment(a) {
  const modeLabel = a.mode === 'online' ? 'Online' : 'In person';
  return `${modeLabel} · ${a.preferred_date} · ${a.time_window} · ${a.status}`;
}

async function listAppointments(userId) {
  const rows = await db.select('dietitian_appointments', {
    columns: '*', filters: ['user_id=eq.' + userId], order: 'preferred_date.asc',
  });
  if (!rows || rows.length === 0) return "You don't have any appointment requests yet. Say something like \"book an online appointment Tuesday evening\" to request one.";
  return 'Your appointments:\n' + rows.map(formatAppointment).join('\n');
}

async function cancelAppointment(userId, text) {
  const rows = await db.select('dietitian_appointments', {
    columns: '*', filters: ['user_id=eq.' + userId, 'status=eq.requested'], order: 'preferred_date.asc',
  });
  const requested = rows || [];
  if (requested.length === 0) return "You don't have any pending appointment requests to cancel.";
  if (requested.length === 1) {
    await db.remove('dietitian_appointments', ['id=eq.' + requested[0].id, 'user_id=eq.' + userId]);
    return `Cancelled: ${formatAppointment(requested[0])}.`;
  }
  const dateMatch = requested.find(a => text.includes(a.preferred_date));
  if (dateMatch) {
    await db.remove('dietitian_appointments', ['id=eq.' + dateMatch.id, 'user_id=eq.' + userId]);
    return `Cancelled: ${formatAppointment(dateMatch)}.`;
  }
  return 'You have more than one pending request -- which one? Reply with the date (YYYY-MM-DD):\n' + requested.map(formatAppointment).join('\n');
}

async function extractAppointmentRequest(apiKey, text, context) {
  const todayIST = nc.istDateStr(new Date());
  const systemPrompt = `You are helping someone request a real appointment with a human dietitian through NutriGap's Telegram bot, based on their message (and the recent conversation below, in case earlier messages already gave part of this).

You need exactly three things: "mode" (must be exactly "online" or "offline"), "date" (a real calendar date on or after ${todayIST}, formatted YYYY-MM-DD -- work out the actual date from things like "tomorrow", "next Tuesday", "Oct 5"), and "timeWindow" (must be EXACTLY one of these three strings, character for character: "Morning (9am-12pm)", "Afternoon (12pm-4pm)", "Evening (4pm-8pm)").

If all three are clearly given (across this message and the recent conversation), set "ready": true and write a short, warm confirmation as "reply" (don't claim it's been booked/confirmed by a human yet -- say it's been requested and a real dietitian will confirm). If anything is missing or ambiguous, set "ready": false, leave that field null, and write "reply" as a short, specific question asking only for what's missing (don't re-ask for what you already have).

Recent conversation:
${context || '(none yet)'}

Respond with ONLY a JSON object, no markdown, no commentary, in exactly this shape:
{"mode": "online", "date": "2026-10-05", "timeWindow": "Evening (4pm-8pm)", "ready": true, "reply": "..."}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 500, system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!response.ok) throw new Error('Anthropic API error: ' + (await response.text()));
  const data = await response.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  let cleaned = ((textBlock && textBlock.text) || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch (e) { return { ready: false, reply: "Sorry, I didn't catch that -- could you say the mode (online/in person), date, and preferred time again?" }; }

  const modeOk = parsed.mode === 'online' || parsed.mode === 'offline';
  const dateOk = typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) && parsed.date >= todayIST;
  const windowOk = APPT_TIME_WINDOWS.includes(parsed.timeWindow);
  const ready = parsed.ready === true && modeOk && dateOk && windowOk;
  return {
    ready, mode: modeOk ? parsed.mode : null, date: dateOk ? parsed.date : null, timeWindow: windowOk ? parsed.timeWindow : null,
    reply: typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : "Could you confirm the mode (online/in person), date, and preferred time window?",
  };
}

async function bookAppointment(userId, text, context) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "Something's misconfigured on the server side -- Aravinth's been notified.";
  const result = await extractAppointmentRequest(apiKey, text, context);
  if (!result.ready) return result.reply;
  await db.insert('dietitian_appointments', [{
    user_id: userId, mode: result.mode, preferred_date: result.date, time_window: result.timeWindow, status: 'requested',
  }], { returning: false });
  return result.reply;
}

// ---------- Medical documents (reports + doctor-visit prescriptions) ----------
//
// A read-only mirror of the website's "Medical reports" and "Doctor
// visits" tabs -- lets someone pull a saved lab report or a saved
// prescription back from Telegram. Uploading a NEW one still only happens
// on the website (the AI extraction step for reports, and the visit form
// for prescriptions, both live there) -- this only ever reads what's
// already saved, through the exact same `medical_reports` /
// `doctor_visits` / `doctor_visit_files` tables and the same
// `medical-documents` storage bucket the website uses, every query scoped
// to the verified user_id from telegram_links, same as everything else here.

const DOCS_BUCKET = 'medical-documents';
const DOC_TYPE_LABELS_TG = { prescription: 'Prescription', consultation_note: 'Consultation note', bill_receipt: 'Bill/receipt', other: 'Document' };

// Same fix as the website's medical trends dashboard: a report's printed
// "value" sometimes already carries its unit as text (e.g. "70 /cmm"), so
// naively appending the separately-extracted "unit" field again would
// duplicate it ("70 /cmm /cmm"). Only append when it isn't already there.
function formatValueUnitTG(rawValue, unit) {
  const raw = rawValue === undefined || rawValue === null ? '' : String(rawValue);
  if (!unit) return raw;
  const rawNorm = raw.toLowerCase().replace(/\s+/g, '');
  const unitNorm = String(unit).toLowerCase().replace(/\s+/g, '');
  if (!unitNorm || rawNorm.includes(unitNorm)) return raw;
  return `${raw} ${unit}`;
}

async function loadRecentReports(userId, limit) {
  const rows = await db.select('medical_reports', {
    columns: 'id,patient_name,report_date,file_name,markers,storage_path,created_at',
    filters: ['user_id=eq.' + userId],
    order: 'created_at.desc',
    limit: limit || 10,
  });
  return rows || [];
}

// doctor_visit_files has no created_at of its own to sort by -- order by
// the parent visit's visit_date instead (always present, required on every
// saved visit), fetched via the same embedded-resource join the website's
// loadVisits() uses, then sorted here since PostgREST can't order a list by
// an embedded table's column through this simple select() wrapper.
async function loadRecentPrescriptions(userId, limit) {
  const rows = await db.select('doctor_visit_files', {
    columns: 'id,visit_id,storage_path,file_name,doc_type,doctor_visits(visit_date,doctor_name,specialty)',
    filters: ['user_id=eq.' + userId, 'doc_type=eq.prescription'],
  });
  const withVisit = (rows || []).filter(r => r.doctor_visits);
  withVisit.sort((a, b) => String(b.doctor_visits.visit_date || '').localeCompare(String(a.doctor_visits.visit_date || '')));
  return withVisit.slice(0, limit || 10);
}

function reportLabel(r) {
  const n = (r.markers || []).length;
  const date = r.report_date || new Date(r.created_at).toLocaleDateString();
  return `🧪 ${date} — ${n} value${n === 1 ? '' : 's'}${r.storage_path ? '' : ' (no file, values only)'}`;
}

function prescriptionLabel(p) {
  const v = p.doctor_visits || {};
  const who = v.doctor_name ? `Dr. ${v.doctor_name}` : (v.specialty || 'Prescription');
  return `💊 ${v.visit_date || ''} — ${who}`;
}

// Plain-text fallback for a report with no original file attached (saved
// before the file-storage feature existed, or the upload failed at save
// time) -- same info as the website's expanded marker table, as a message
// instead of a file, per Aravinth's choice rather than skipping it.
function formatMarkersAsText(report) {
  const markers = report.markers || [];
  const header = `🧪 ${report.file_name || 'Report'}${report.report_date ? ' — ' + report.report_date : ''}`;
  if (markers.length === 0) return `${header}\n\nNo values were saved on this one.`;
  const lines = markers.map(m => {
    const val = formatValueUnitTG(m.value, m.unit);
    const range = m.referenceRange ? ` (ref: ${m.referenceRange})` : '';
    const flag = m.flag && m.flag !== 'Unknown' ? ` — ${m.flag}` : '';
    return `• ${m.name}: ${val}${range}${flag}`;
  });
  return [header, '(no original file attached -- extracted values only)', '', ...lines].join('\n');
}

async function sendSavedReport(chatId, report) {
  if (report.storage_path) {
    try {
      const { buffer, contentType } = await db.storageDownload(DOCS_BUCKET, report.storage_path);
      const caption = `🧪 ${report.file_name || 'Report'}${report.report_date ? ' — ' + report.report_date : ''}`;
      await sendTelegramFile(chatId, buffer, report.file_name || 'report', contentType, caption);
      return;
    } catch (e) {
      console.error('Could not download report file, falling back to a text summary:', e.message);
      // fall through to the text summary below -- better than a dead end
    }
  }
  await sendMessage(chatId, formatMarkersAsText(report));
}

async function sendVisitFile(chatId, file) {
  if (!file.storage_path) {
    await sendMessage(chatId, "That one has no file attached -- nothing to send.");
    return;
  }
  try {
    const { buffer, contentType } = await db.storageDownload(DOCS_BUCKET, file.storage_path);
    const v = file.doctor_visits || {};
    const who = v.doctor_name ? `Dr. ${v.doctor_name}` : (v.specialty || '');
    const caption = `💊 ${DOC_TYPE_LABELS_TG[file.doc_type] || 'Document'}${v.visit_date ? ' — ' + v.visit_date : ''}${who ? ' (' + who + ')' : ''}`;
    await sendTelegramFile(chatId, buffer, file.file_name || 'prescription', contentType, caption);
  } catch (e) {
    console.error('Could not download visit file:', e.message);
    await sendMessage(chatId, "Couldn't fetch that file just now -- try again in a moment.");
  }
}

// Combined, newest-first browsable list -- reports and prescriptions mixed
// together, each as its own tappable button (handled in
// handleDocumentButton below via its callback_data). Paged 10 at a time
// (DOCS_PAGE_SIZE) with a trailing "Show more" button rather than a single
// fixed top-10 -- someone with a longer history can still reach an older
// report or prescription instead of hitting a dead end after the newest 10.
// Re-fetches and re-sorts the whole list on every page (no separate stored
// "where was I" state) -- cheap at personal-data volumes, and means the
// list is never stale if something was added/deleted between pages.
const DOCS_PAGE_SIZE = 10;
const DOCS_FETCH_CAP = 200; // generous ceiling for a personal medical history

async function loadAllDocItems(userId) {
  const [reports, prescriptions] = await Promise.all([
    loadRecentReports(userId, DOCS_FETCH_CAP),
    loadRecentPrescriptions(userId, DOCS_FETCH_CAP),
  ]);
  const items = [
    ...reports.map(r => ({ sortKey: r.report_date || r.created_at, button: { text: reportLabel(r), callback_data: `doc:report:${r.id}` } })),
    ...prescriptions.map(p => ({ sortKey: (p.doctor_visits && p.doctor_visits.visit_date) || '', button: { text: prescriptionLabel(p), callback_data: `doc:presc:${p.id}` } })),
  ];
  items.sort((a, b) => String(b.sortKey).localeCompare(String(a.sortKey)));
  return items;
}

// Shown once at the top of the first page of the list -- lets someone add a
// new report or prescription right from Telegram instead of only ever being
// able to pull back what was already saved on the website. See "Upload a
// report / prescription from Telegram" below for what these start.
const UPLOAD_START_BUTTONS = [
  [{ text: '⬆️ Upload a report', callback_data: 'uploadstart:report' }],
  [{ text: '⬆️ Upload a prescription / visit file', callback_data: 'uploadstart:visit' }],
];

async function documentsListReply(userId, offset) {
  offset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const items = await loadAllDocItems(userId);
  if (items.length === 0) {
    return {
      text: "You don't have any saved medical reports or prescriptions yet -- tap below to add one from here, or save it from the website's Medical reports / Doctor visits tabs.",
      keyboard: UPLOAD_START_BUTTONS,
    };
  }
  const page = items.slice(offset, offset + DOCS_PAGE_SIZE);
  const keyboard = offset === 0 ? [...UPLOAD_START_BUTTONS, ...page.map(it => [it.button])] : page.map(it => [it.button]);
  const shownSoFar = offset + page.length;
  const remaining = items.length - shownSoFar;
  if (remaining > 0) {
    keyboard.push([{ text: `➡️ Show ${Math.min(remaining, DOCS_PAGE_SIZE)} more`, callback_data: `docsmore:${shownSoFar}` }]);
  }
  const rangeLabel = items.length <= DOCS_PAGE_SIZE
    ? `Your ${items.length} saved document${items.length === 1 ? '' : 's'} (reports and prescriptions)`
    : `Documents ${offset + 1}–${shownSoFar} of ${items.length} (reports and prescriptions)`;
  return { text: `${rangeLabel} -- tap one to get it sent here, or upload a new one below:`, keyboard };
}

async function handleDocumentButton(chatId, userId, data) {
  const parts = data.split(':');
  const kind = parts[1]; // 'report' | 'presc'
  const id = parts.slice(2).join(':');
  await sendTyping(chatId);
  try {
    if (kind === 'report') {
      const rows = await db.select('medical_reports', {
        columns: 'id,patient_name,report_date,file_name,markers,storage_path,created_at',
        filters: ['id=eq.' + encodeURIComponent(id), 'user_id=eq.' + userId],
        limit: 1,
      });
      const report = rows && rows[0];
      if (!report) { await sendMessage(chatId, "Couldn't find that report -- it may have been deleted."); return; }
      await sendSavedReport(chatId, report);
    } else if (kind === 'presc') {
      const rows = await db.select('doctor_visit_files', {
        columns: 'id,visit_id,storage_path,file_name,doc_type,doctor_visits(visit_date,doctor_name,specialty)',
        filters: ['id=eq.' + encodeURIComponent(id), 'user_id=eq.' + userId],
        limit: 1,
      });
      const file = rows && rows[0];
      if (!file) { await sendMessage(chatId, "Couldn't find that file -- it may have been deleted."); return; }
      await sendVisitFile(chatId, file);
    }
  } catch (e) {
    console.error('Document fetch/send failed:', e.message);
    await sendMessage(chatId, "Couldn't fetch that file just now -- try again in a moment.");
  }
}

// ---------- Upload a report / prescription from Telegram ----------
//
// Mirrors the website's own upload paths -- a lab report goes through the
// same Claude extraction-only read (never a diagnosis, never a guessed
// reference range) that api/read-report.js does, a prescription/bill/note
// goes through the same "create a visit, then attach a file to it" shape
// the website's "Add visit" form does -- just as a short guided
// conversation instead of a form, since Telegram has no form fields.
// State lives in telegram_links.pending_upload (jsonb), the same pattern as
// pending_log: {type: 'report'|'visit', step, ...}. A report's steps are
// 'awaiting_file' -> 'confirm' (shows the extracted summary, waits for a
// Save/Discard tap). A visit's steps are 'visit_date' -> 'doctor_name' ->
// 'specialty' -> 'clinic_name' -> 'doc_type' -> 'awaiting_file' ->
// 'more_files' (loops back to 'doc_type' for another file, or finishes).
//
// The extraction system prompt below is a deliberate copy of
// api/read-report.js's -- same highest-sensitivity rules (extraction only,
// no diagnosis, no inferred reference ranges) -- rather than importing it,
// matching this codebase's existing choice (see formatValueUnitTG above) to
// duplicate small, stable pieces of logic across files instead of adding
// shared-module plumbing between the website's API and the bot.

const UPLOAD_ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

function sanitizeFileNameTG(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

async function setPendingUpload(chatId, state) {
  await db.update('telegram_links', ['chat_id=eq.' + encodeURIComponent(String(chatId))], { pending_upload: state });
}

async function clearPendingUpload(chatId) {
  await db.update('telegram_links', ['chat_id=eq.' + encodeURIComponent(String(chatId))], { pending_upload: null });
}

// Reads whichever of message.document / message.photo is present and
// normalizes it to one shape. A photo is always a plain image (Telegram
// re-encodes it as JPEG), so it's always "supported"; a document reports
// its own mime_type, which is checked against the same four types
// read-report.js accepts.
function resolveIncomingFile(message) {
  if (message.document) {
    const mime = message.document.mime_type || '';
    return {
      fileId: message.document.file_id,
      mimeType: mime,
      fileName: message.document.file_name || 'document',
      supported: UPLOAD_ALLOWED_MIME.includes(mime),
    };
  }
  if (message.photo && message.photo.length) {
    const largest = message.photo[message.photo.length - 1];
    return { fileId: largest.file_id, mimeType: 'image/jpeg', fileName: `photo-${Date.now()}.jpg`, supported: true };
  }
  return null;
}

// A more permissive date parser than the meal-logging flow's
// parseLoggedDate -- a doctor visit can reasonably be years in the past
// (unlike a meal, which is only ever backfilled a few months at most), and
// a near-future date is valid too (an upcoming/just-scheduled visit), so
// the bounds here are deliberately wide rather than reusing that function's
// 90-day/no-future rule.
function parseFlexibleDateTG(text) {
  const t = String(text || '').trim();
  const now = new Date();
  const minDate = nc.istDateStr(new Date(now.getTime() - 15 * 365 * 24 * 60 * 60 * 1000));
  const maxDate = nc.istDateStr(new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000));

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    return (t >= minDate && t <= maxDate) ? t : null;
  }
  const year = now.getFullYear();
  const parsed = new Date(t + ' ' + year + ' UTC');
  if (Number.isNaN(parsed.getTime())) return null;
  let candidate = nc.istDateStr(parsed);
  if (candidate > maxDate) {
    const lastYear = new Date(Date.UTC(year - 1, parsed.getUTCMonth(), parsed.getUTCDate()));
    candidate = nc.istDateStr(lastYear);
  }
  return (candidate >= minDate && candidate <= maxDate) ? candidate : null;
}

const REPORT_EXTRACTION_SYSTEM_PROMPT_TG = `You are a document-reading assistant embedded in a health app called NutriGap.
You will be shown an image or PDF of a lab or medical report. Your ONLY job is to extract values that are explicitly printed in the document -- nothing else.

Rules you must follow without exception:
- Extract only tests/markers that have an explicit value printed in the document. Never infer, estimate, or guess a value that isn't printed.
- For each marker, extract: "name" (as printed), "value" (as printed, including its unit if attached), "unit" (separately, if identifiable), and "referenceRange" EXACTLY as printed for that marker.
- If no reference range is printed for a given marker, set "referenceRange" to null. NEVER supply a reference range from general medical knowledge -- only use what is printed in this specific document.
- Set "flag" to "Low", "Normal", or "High" ONLY by comparing the printed value against the printed reference range for that same marker. If no reference range is printed, "flag" MUST be "Unknown" -- do not use outside knowledge to guess what's normal.
- Do not diagnose any condition. Do not explain what a marker means medically. Do not speculate on causes. Do not recommend treatment, supplements, or lifestyle changes.
- Do not comment on the person's overall health status or how "concerning" any result is.
- If the document does not appear to be any kind of medical or lab report at all (e.g. it's a photo of something unrelated), set "notAReport" to true and return an empty "markers" array.
- If you can find a report date printed on the document, include it as "reportDate" (as printed); otherwise null.
- If you can find the patient's name printed on the document, include it as "patientName" (as printed); otherwise null.

Respond with ONLY a JSON object -- no markdown, no code fences, no commentary before or after -- in exactly this shape:
{"notAReport": false, "reportDate": "... or null", "patientName": "... or null", "markers": [{"name": "...", "value": "...", "unit": "... or null", "referenceRange": "... or null", "flag": "Low"}]}`;

async function extractReportFromFileTG(base64, mediaType) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Something's misconfigured on the server side -- Aravinth's been notified.");

  const fileBlock = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 24000,
      system: REPORT_EXTRACTION_SYSTEM_PROMPT_TG,
      messages: [{
        role: 'user',
        content: [fileBlock, { type: 'text', text: 'Extract the lab values from this report, following your instructions exactly.' }],
      }],
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    let message = errText;
    try { const errJson = JSON.parse(errText); if (errJson && errJson.error && errJson.error.message) message = errJson.error.message; } catch (e) { /* not JSON */ }
    throw new Error(message);
  }
  const data = await response.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  const rawText = (textBlock && textBlock.text) || '';
  let cleaned = rawText.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    if (data.stop_reason === 'max_tokens') {
      const err = new Error('This report has more values than I can read in one pass here -- try uploading it from the website instead (it can split big reports automatically).');
      err.truncated = true;
      throw err;
    }
    throw new Error("couldn't make sense of the AI's response for this file");
  }
  parsed.markers = (parsed.markers || []).map(m => ({ ...m, flag: m.referenceRange ? m.flag : 'Unknown' }));
  return parsed;
}

async function handleReportFileReceived(chatId, userId, state, message) {
  const resolved = resolveIncomingFile(message);
  if (!resolved || !resolved.supported) {
    await sendMessage(chatId, "I can only read PDF, JPEG, PNG, or WEBP files for reports -- try a different format, or upload it from the website instead.");
    return;
  }
  await sendTyping(chatId);

  let buffer;
  try {
    const filePath = await telegramGetFilePath(resolved.fileId);
    buffer = await downloadTelegramFileBytes(filePath);
  } catch (e) {
    console.error('Could not download report file from Telegram:', e.message);
    await sendMessage(chatId, "Couldn't download that file from Telegram -- try sending it again.");
    return;
  }

  const base64 = buffer.toString('base64');
  // Same reachable-size guard as api/read-report.js -- Vercel's own request
  // body limit would reject anything bigger before this code even runs.
  if (base64.length > 4_400_000) {
    await sendMessage(chatId, "That file's a bit large for me to read here -- try a smaller file, or upload it from the website instead (it can split big PDFs automatically).");
    return;
  }

  let parsed;
  try {
    parsed = await extractReportFromFileTG(base64, resolved.mimeType);
  } catch (e) {
    console.error('Report extraction failed:', e.message);
    await clearPendingUpload(chatId);
    await sendMessage(chatId, `Couldn't read that file just now -- ${e.message || 'try again in a moment'}. Send /uploadreport to try again.`);
    return;
  }

  if (parsed.notAReport) {
    await sendMessage(chatId, "That doesn't look like a medical/lab report to me, so I didn't save anything. Send a clearer photo/PDF, or /documents to cancel.");
    return;
  }

  const markers = parsed.markers || [];
  const outOfRange = markers.filter(m => m.flag === 'Low' || m.flag === 'High').length;
  const noRange = markers.filter(m => m.flag === 'Unknown').length;
  const lines = markers.slice(0, 25).map(m => {
    const val = formatValueUnitTG(m.value, m.unit);
    const flag = m.flag && m.flag !== 'Unknown' ? ` — ${m.flag}` : '';
    return `• ${m.name}: ${val}${flag}`;
  });
  const more = markers.length > 25 ? `\n...and ${markers.length - 25} more (full table on the website after saving)` : '';

  let summary = `Read ${markers.length} value${markers.length === 1 ? '' : 's'} from your report.`;
  if (outOfRange > 0) summary += ` ${outOfRange} sit outside the range printed on the report -- that's a fact from your document, not a diagnosis.`;
  if (noRange > 0) summary += ` ${noRange} had no reference range printed.`;
  if (parsed.reportDate) summary += `\nReport date: ${parsed.reportDate}`;
  if (parsed.patientName) summary += `\nPatient: ${parsed.patientName}`;
  const body = lines.length ? `\n\n${lines.join('\n')}${more}` : '';

  await setPendingUpload(chatId, {
    type: 'report', step: 'confirm',
    fileId: resolved.fileId, mimeType: resolved.mimeType, fileName: resolved.fileName,
    extracted: { reportDate: parsed.reportDate || null, patientName: parsed.patientName || null, markers },
  });
  await sendMessage(chatId, `${summary}${body}\n\nSave this to your reports?`,
    [[{ text: '✅ Save', callback_data: 'upload:reportsave:yes' }, { text: '❌ Discard', callback_data: 'upload:reportsave:no' }]]);
}

async function askDocTypeButtons(chatId) {
  await sendMessage(chatId, 'What kind of file is this?', [
    [{ text: '💊 Prescription', callback_data: 'upload:doctype:prescription' }],
    [{ text: '🧾 Bill / receipt', callback_data: 'upload:doctype:bill_receipt' }],
    [{ text: '📝 Consultation note', callback_data: 'upload:doctype:consultation_note' }],
    [{ text: '📄 Other', callback_data: 'upload:doctype:other' }],
  ]);
}

async function handleVisitTextStep(chatId, userId, state, text) {
  if (state.step === 'visit_date') {
    if (!text) { await sendMessage(chatId, 'What date was the visit? e.g. "2026-09-10" or "10 Sept".'); return; }
    const date = parseFlexibleDateTG(text);
    if (!date) { await sendMessage(chatId, 'I couldn\'t read that as a date -- try "2026-09-10" or "10 Sept".'); return; }
    await setPendingUpload(chatId, { ...state, step: 'doctor_name', visit: { ...state.visit, visit_date: date } });
    await sendMessage(chatId, 'Doctor\'s name? (or type "skip")');
    return;
  }
  if (state.step === 'doctor_name') {
    const value = text.trim().toLowerCase() === 'skip' ? null : text.trim();
    await setPendingUpload(chatId, { ...state, step: 'specialty', visit: { ...state.visit, doctor_name: value || null } });
    await sendMessage(chatId, 'Specialty? (or type "skip")');
    return;
  }
  if (state.step === 'specialty') {
    const value = text.trim().toLowerCase() === 'skip' ? null : text.trim();
    await setPendingUpload(chatId, { ...state, step: 'clinic_name', visit: { ...state.visit, specialty: value || null } });
    await sendMessage(chatId, 'Clinic or hospital name? (or type "skip")');
    return;
  }
  if (state.step === 'clinic_name') {
    const value = text.trim().toLowerCase() === 'skip' ? null : text.trim();
    await setPendingUpload(chatId, { ...state, step: 'doc_type', visit: { ...state.visit, clinic_name: value || null } });
    await askDocTypeButtons(chatId);
    return;
  }
}

async function handleVisitFileReceived(chatId, userId, state, message) {
  const resolved = resolveIncomingFile(message);
  if (!resolved || !resolved.supported) {
    await sendMessage(chatId, 'I can only save PDF, JPEG, PNG, or WEBP files -- try a different format, or use the website instead.');
    return;
  }
  const visitId = state.visit && state.visit.id;
  if (!visitId) {
    await clearPendingUpload(chatId);
    await sendMessage(chatId, "Something went wrong saving the visit -- send /uploadvisit to try again.");
    return;
  }

  await sendTyping(chatId);
  let buffer;
  try {
    const filePath = await telegramGetFilePath(resolved.fileId);
    buffer = await downloadTelegramFileBytes(filePath);
  } catch (e) {
    console.error('Could not download visit file from Telegram:', e.message);
    await sendMessage(chatId, "Couldn't download that file from Telegram -- try sending it again.");
    return;
  }

  const path = `${userId}/${visitId}/${Date.now()}-${sanitizeFileNameTG(resolved.fileName)}`;
  try {
    await db.storageUpload(DOCS_BUCKET, path, buffer, resolved.mimeType);
    await db.insert('doctor_visit_files', [{
      visit_id: visitId, user_id: userId, doc_type: state.docType, storage_path: path, file_name: resolved.fileName,
    }], { returning: false });
  } catch (e) {
    console.error('Could not save visit file:', e.message);
    await sendMessage(chatId, "Couldn't save that file just now -- try sending it again.");
    return;
  }

  await setPendingUpload(chatId, { ...state, step: 'more_files' });
  await sendMessage(chatId, `Saved as ${DOC_TYPE_LABELS_TG[state.docType] || 'a file'}. Add another file to this visit?`,
    [[{ text: '➕ Yes, add another', callback_data: 'upload:morefiles:yes' }, { text: '✅ Done', callback_data: 'upload:morefiles:no' }]]);
}

// Entry point from the main handler below whenever telegram_links.pending_upload
// has an active step and the incoming message wasn't a recognized escape
// command. Dispatches purely on state.type/state.step; steps that expect a
// button tap (report's 'confirm', visit's 'doc_type'/'more_files') just
// re-prompt on any free text instead of trying to interpret it.
async function handleUploadFlowMessage(chatId, userId, state, ctx) {
  const { text, hasPhoto, hasDocument, message } = ctx;
  if (state.type === 'report') {
    if (state.step === 'awaiting_file') {
      if (!hasPhoto && !hasDocument) { await sendMessage(chatId, 'Send a photo or PDF of the report, or /documents to cancel.'); return; }
      await handleReportFileReceived(chatId, userId, state, message);
      return;
    }
    await sendMessage(chatId, 'Tap "Save" or "Discard" above to continue, or /documents to cancel.');
    return;
  }
  if (state.type === 'visit') {
    if (state.step === 'visit_date' || state.step === 'doctor_name' || state.step === 'specialty' || state.step === 'clinic_name') {
      await handleVisitTextStep(chatId, userId, state, text);
      return;
    }
    if (state.step === 'awaiting_file') {
      if (!hasPhoto && !hasDocument) { await sendMessage(chatId, 'Send a photo or PDF of the file, or /documents to cancel.'); return; }
      await handleVisitFileReceived(chatId, userId, state, message);
      return;
    }
    await sendMessage(chatId, 'Tap one of the buttons above to continue, or /documents to cancel.');
    return;
  }
}

// ---------- Intent routing ----------

async function classifyIntent(apiKey, text, context) {
  const systemPrompt = `Classify one message sent to NutriGap's Telegram AI agent, using the recent conversation below for context if it helps.

Choose exactly one "intent":
- "log_meal" -- they're describing food they ate (or are about to eat) that should be logged.
- "gap_summary" -- they're asking about their nutrition gap, targets, or how today's log looks.
- "meal_ideas" -- they're asking what to eat, for meal/food suggestions, or how to close their nutrition gap (e.g. "what should I eat?", "give me some meal ideas", "what can I eat to hit my protein target?"). Not the same as gap_summary -- that's asking what today's numbers look like, this is asking what to DO about it.
- "appointment" -- anything about booking, requesting, listing, or cancelling a consultation with a dietitian. Also set "appointmentAction" to "book", "list", or "cancel".
- "help" -- asking what the bot can do.
- "unlink" -- asking to disconnect/unlink their account.
- "dietitian_chat" -- anything else: general questions, talking through their goals, small talk, or anything ambiguous. This is the safe default -- use it whenever you're not confident it's one of the above.

Recent conversation:
${context || '(none yet)'}

Respond with ONLY a JSON object, no markdown, no commentary, in exactly this shape:
{"intent": "dietitian_chat", "appointmentAction": null}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 200, system: systemPrompt,
        messages: [{ role: 'user', content: text }],
      }),
    });
    if (!response.ok) return { intent: 'dietitian_chat', appointmentAction: null };
    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    let cleaned = ((textBlock && textBlock.text) || '').replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
    const parsed = JSON.parse(cleaned);
    const allowed = ['log_meal', 'gap_summary', 'meal_ideas', 'appointment', 'help', 'unlink', 'dietitian_chat'];
    return {
      intent: allowed.includes(parsed.intent) ? parsed.intent : 'dietitian_chat',
      appointmentAction: ['book', 'list', 'cancel'].includes(parsed.appointmentAction) ? parsed.appointmentAction : 'book',
    };
  } catch (e) {
    return { intent: 'dietitian_chat', appointmentAction: null };
  }
}

const HELP_TEXT =
  "Here's what I can do:\n\n" +
  '• Use the buttons below any time -- My gap, Meal ideas, Log a meal, Appointments, My documents, Help\n' +
  '• Tell me what you ate ("2 chapathis with palak matar for lunch"), send a photo of the plate, or tap "📝 Log a meal" / send /log -- any of those gets things started, I\'ll ask which meal and which date, then log it. For a photo, I\'ll try to identify what\'s on the plate and show you before logging anything; if I\'m not confident I\'ll save it for the team to review instead and ask you to type it\n' +
  '• Ask "what\'s my gap today?" for your macro/micro summary\n' +
  '• Ask "what should I eat?" for BFB meal-box ideas to help close today\'s gap, or name a specific nutrient ("suggestions to bridge my vitamin C gap") for ideas just for that one\n' +
  '• Just talk to me about your goals -- I\'m the same AI first-line as the Dietitian tab\n' +
  '• "book an online appointment Tuesday evening" to request a real consultation\n' +
  '• "my appointments" to see what\'s upcoming, or "cancel my appointment" to cancel one\n' +
  '• /documents to pull back a saved medical report or prescription (tap "📄 My documents"), or /latestreport / /latestprescription for just the newest one\n' +
  '• /uploadreport to send a photo or PDF of a lab report and have me read the values off it (same extraction as the website -- facts from the document only, never a diagnosis), or /uploadvisit to save a prescription/bill/note against a doctor visit -- both also start from the buttons under "📄 My documents"\n' +
  '• /invite (or tap "👥 Invite friends") for your personal invite link -- works on Telegram and the website\n' +
  '• /recap for a quick shareable summary of your week (streak, days logged) with your invite link attached\n' +
  '• /nudges to turn daily check-in reminders on or off\n' +
  '• /unlink to disconnect this chat from your NutriGap account';

// Button taps from MAIN_MENU_KEYBOARD arrive back as plain text messages --
// this maps the ones that are just shortcuts for an existing slash command
// onto that command's text, so one block of logic handles both. "📝 Log a
// meal" isn't in here: it starts the guided logging flow directly (see the
// dedicated check for it in the main handler), it doesn't map onto another
// command's text.
const BUTTON_TO_COMMAND = {
  '📊 My gap': '/gap',
  '🍽 Meal ideas': '/meals',
  '📅 Appointments': '/appointments',
  '📄 My documents': '/documents',
  '👥 Invite friends': '/invite',
  '❓ Help': '/help',
};

// ---------- Main handler ----------

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Always ack Telegram with 200 quickly-ish, even on an internal error --
  // Telegram retries a non-200 repeatedly, which would otherwise turn one
  // bug into a storm of duplicate replies.
  try {
    const update = req.body || {};

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      res.status(200).json({ ok: true });
      return;
    }

    const message = update.message;
    const hasPhoto = !!(message && message.photo && message.photo.length);
    const hasDocument = !!(message && message.document);
    if (!message || (typeof message.text !== 'string' && !hasPhoto && !hasDocument)) {
      res.status(200).json({ ok: true });
      return;
    }
    const chatId = message.chat.id;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text && !hasPhoto && !hasDocument) { res.status(200).json({ ok: true }); return; }

    const link = await findLink(chatId);

    if (!link) {
      await handleLinking(chatId, text, message.from);
      res.status(200).json({ ok: true });
      return;
    }
    const userId = link.user_id;

    if (link.onboarding_state && link.onboarding_state.step) {
      await handleOnboardingText(chatId, userId, link.onboarding_state, text);
      res.status(200).json({ ok: true });
      return;
    }

    // Mid-way through the guided meal-logging flow (see "Guided meal
    // logging" above) -- intercept before anything else, including the AI
    // classifier, so a half-answered "which date?" doesn't get reinterpreted
    // as a fresh message. A recognized command/menu-button still escapes
    // the flow instead of getting trapped by it.
    if (link.pending_log && link.pending_log.step) {
      const state = link.pending_log;
      if (isEscapeFromLogFlow(text)) {
        await clearPendingLog(chatId);
        // falls through to normal handling below with the original message
      } else if (state.step === 'meal' || state.step === 'date' || state.step === 'photo_confirm') {
        await sendMessage(chatId, 'Tap one of the buttons above to answer that one.');
        await reaskCurrentLogStep(chatId, state);
        res.status(200).json({ ok: true });
        return;
      } else if (state.step === 'custom_date') {
        if (!text) {
          await sendMessage(chatId, 'What date? Send it like "2026-10-05" or "5 Oct".');
          res.status(200).json({ ok: true });
          return;
        }
        const entryDate = parseLoggedDate(text);
        if (!entryDate) {
          await sendMessage(chatId, "I couldn't read that as a date -- try \"2026-10-05\" or \"5 Oct\" (up to 90 days back, not in the future).");
          res.status(200).json({ ok: true });
          return;
        }
        await proceedAfterDate(chatId, userId, { ...state, entryDate, step: 'items' });
        res.status(200).json({ ok: true });
        return;
      } else if (state.step === 'items') {
        if (hasPhoto) {
          const fileId = message.photo[message.photo.length - 1].file_id;
          await logMessage(userId, chatId, 'in', '[photo]', 'log_meal');
          await sendTyping(chatId);
          await handleMealPhoto(chatId, userId, state, fileId);
          res.status(200).json({ ok: true });
          return;
        }
        if (text) {
          await logMessage(userId, chatId, 'in', text, 'log_meal');
          await finishMealLog(chatId, userId, { ...state, text });
          res.status(200).json({ ok: true });
          return;
        }
        await sendMessage(chatId, 'Type what you ate, or send a photo of the meal.');
        res.status(200).json({ ok: true });
        return;
      }
    }

    // Mid-way through the "upload a report / prescription" guided flow (see
    // "Upload a report / prescription from Telegram" above) -- same
    // intercept-before-anything-else pattern as pending_log just above, and
    // the same escape rule (a recognized command/button drops the half-done
    // upload instead of trapping the person in it).
    if (link.pending_upload && link.pending_upload.step) {
      if (isEscapeFromUploadFlow(text)) {
        await clearPendingUpload(chatId);
        // falls through to normal handling below with the original message
      } else {
        await handleUploadFlowMessage(chatId, userId, link.pending_upload, { text, hasPhoto, hasDocument, message });
        res.status(200).json({ ok: true });
        return;
      }
    }

    // A tap on the persistent menu's "📝 Log a meal" button (or /log) starts
    // the guided flow directly -- see "Guided meal logging" above.
    if (text === '📝 Log a meal' || text.toLowerCase() === '/log') {
      await startMealLogFlow(chatId, null);
      res.status(200).json({ ok: true });
      return;
    }

    // Deterministic slash commands first -- faster, cheaper, and more
    // reliable than routing them through the AI classifier. Menu-button
    // taps that mirror a command (see BUTTON_TO_COMMAND) are normalized
    // onto that command's text here so one block handles both; `text`
    // itself is left alone for logging/display.
    const lower = (BUTTON_TO_COMMAND[text] || text).toLowerCase();
    if (lower === '/start' || lower === '/help') {
      await sendMessage(chatId, HELP_TEXT, null, { menu: true });
      res.status(200).json({ ok: true });
      return;
    }
    if (lower === '/unlink') {
      await db.remove('telegram_links', ['chat_id=eq.' + encodeURIComponent(String(chatId)), 'user_id=eq.' + userId]);
      await sendMessage(chatId, "You're disconnected. Send /start with a fresh code from the website any time to reconnect.");
      res.status(200).json({ ok: true });
      return;
    }
    if (lower === '/nudges') {
      const enabled = link.nudges_enabled !== false;
      await sendMessage(chatId, `Daily check-in reminders are currently ${enabled ? 'ON' : 'OFF'}. Send "/nudges off" or "/nudges on" to change.`);
      res.status(200).json({ ok: true });
      return;
    }
    if (lower === '/nudges off') {
      await db.update('telegram_links', ['chat_id=eq.' + encodeURIComponent(String(chatId)), 'user_id=eq.' + userId], { nudges_enabled: false });
      await sendMessage(chatId, "Okay, no more daily check-in reminders. Send \"/nudges on\" any time to turn them back on.");
      res.status(200).json({ ok: true });
      return;
    }
    if (lower === '/nudges on') {
      await db.update('telegram_links', ['chat_id=eq.' + encodeURIComponent(String(chatId)), 'user_id=eq.' + userId], { nudges_enabled: true });
      await sendMessage(chatId, "Daily check-in reminders are back on.");
      res.status(200).json({ ok: true });
      return;
    }
    if (lower === '/gap' || lower === '/today') {
      const reply = await gapSummary(userId);
      await logMessage(userId, chatId, 'in', text, 'gap_summary');
      await logMessage(userId, chatId, 'out', reply, 'gap_summary');
      await sendMessage(chatId, reply);
      res.status(200).json({ ok: true });
      return;
    }
    // Also matches "/meals iron" / "/ideas vitamin c" etc -- a nutrient
    // named after the command still routes here directly (no AI call
    // needed at all), rather than falling through to the classifier just
    // because trailing text broke an exact string match.
    if (lower === '/meals' || lower === '/ideas' || lower.startsWith('/meals ') || lower.startsWith('/ideas ')) {
      const reply = await mealIdeas(userId, extractNamedNutrient(text));
      await logMessage(userId, chatId, 'in', text, 'meal_ideas');
      await logMessage(userId, chatId, 'out', reply, 'meal_ideas');
      await sendMessage(chatId, reply);
      res.status(200).json({ ok: true });
      return;
    }
    if (lower === '/appointments') {
      const reply = await listAppointments(userId);
      await logMessage(userId, chatId, 'in', text, 'appointment');
      await logMessage(userId, chatId, 'out', reply, 'appointment');
      await sendMessage(chatId, reply);
      res.status(200).json({ ok: true });
      return;
    }
    if (lower === '/documents') {
      await logMessage(userId, chatId, 'in', text, 'documents');
      const { text: reply, keyboard } = await documentsListReply(userId);
      await logMessage(userId, chatId, 'out', reply, 'documents');
      await sendMessage(chatId, reply, keyboard);
      res.status(200).json({ ok: true });
      return;
    }
    if (lower === '/latestreport') {
      await logMessage(userId, chatId, 'in', text, 'documents');
      await sendTyping(chatId);
      const reports = await loadRecentReports(userId, 1);
      if (reports.length === 0) {
        await sendMessage(chatId, "You don't have any saved medical reports yet -- save one from the website's Medical reports tab first.");
      } else {
        await sendSavedReport(chatId, reports[0]);
      }
      res.status(200).json({ ok: true });
      return;
    }
    if (lower === '/latestprescription') {
      await logMessage(userId, chatId, 'in', text, 'documents');
      await sendTyping(chatId);
      const prescriptions = await loadRecentPrescriptions(userId, 1);
      if (prescriptions.length === 0) {
        await sendMessage(chatId, "You don't have any saved prescriptions yet -- attach one to a visit from the website's Doctor visits tab first.");
      } else {
        await sendVisitFile(chatId, prescriptions[0]);
      }
      res.status(200).json({ ok: true });
      return;
    }
    if (lower === '/uploadreport') {
      await clearPendingLog(chatId);
      await logMessage(userId, chatId, 'in', text, 'documents');
      await setPendingUpload(chatId, { type: 'report', step: 'awaiting_file' });
      await sendMessage(chatId, "Send me a photo or PDF of your lab report, and I'll read the values off it. Send /documents any time to cancel.");
      res.status(200).json({ ok: true });
      return;
    }
    if (lower === '/uploadvisit') {
      await clearPendingLog(chatId);
      await logMessage(userId, chatId, 'in', text, 'documents');
      await setPendingUpload(chatId, { type: 'visit', step: 'visit_date', visit: {} });
      await sendMessage(chatId, 'What date was the visit? e.g. "2026-09-10" or "10 Sept". Send /documents any time to cancel.');
      res.status(200).json({ ok: true });
      return;
    }
    if (lower === '/invite') {
      await logMessage(userId, chatId, 'in', text, 'invite');
      const reply = await inviteReply(userId);
      await logMessage(userId, chatId, 'out', reply, 'invite');
      await sendMessage(chatId, reply);
      res.status(200).json({ ok: true });
      return;
    }
    if (lower === '/recap') {
      await logMessage(userId, chatId, 'in', text, 'invite');
      await sendTyping(chatId);
      const reply = await weeklyRecapReply(userId);
      await logMessage(userId, chatId, 'out', reply, 'invite');
      await sendMessage(chatId, reply);
      res.status(200).json({ ok: true });
      return;
    }

    // A document (PDF, usually) with no guided flow in progress -- this
    // only ever means something when the meal-log/upload flows above didn't
    // already claim it, so there's nothing useful to do with a "cold"
    // document the way a "cold" photo starts the meal-log flow below:
    // point them at /uploadreport or /uploadvisit instead of silently
    // dropping it.
    if (hasDocument) {
      await sendMessage(chatId, "I've got a file from you, but I'm not sure what it's for -- send /uploadreport to read it as a lab report, or /uploadvisit to attach it to a doctor visit.");
      res.status(200).json({ ok: true });
      return;
    }

    // A photo with no guided flow in progress yet -- rather than discarding
    // it and making the person resend it after answering two questions,
    // start the flow now (ask which meal, then which date) and run this
    // same photo through identification once those are confirmed. This is
    // what used to just reject the photo outright, which is why sending a
    // photo "cold" on Telegram looked broken compared to the website's
    // always-available photo button -- same photo, same vision analysis,
    // just asked for meal/date first since Telegram has no separate
    // button for it.
    if (hasPhoto) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      await logMessage(userId, chatId, 'in', '[photo]', 'log_meal');
      await startMealLogFlow(chatId, null, fileId);
      res.status(200).json({ ok: true });
      return;
    }

    // Everything past here involves at least one AI call (classification,
    // and usually a second for extraction/chat/booking) -- show typing so
    // the gap before a reply reads as "thinking", not broken.
    await sendTyping(chatId);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const context = await recentContext(userId, 8);
    const { intent, appointmentAction } = await classifyIntent(apiKey, text, context);
    await logMessage(userId, chatId, 'in', text, intent);

    // Food-sounding free text starts the same guided meal+date confirmation
    // flow as the button, carrying the text forward so it isn't asked for
    // twice -- see "Guided meal logging" above. It replies for itself.
    if (intent === 'log_meal') {
      await startMealLogFlow(chatId, text);
      res.status(200).json({ ok: true });
      return;
    }

    let reply;
    if (intent === 'help') {
      reply = HELP_TEXT;
    } else if (intent === 'unlink') {
      await db.remove('telegram_links', ['chat_id=eq.' + encodeURIComponent(String(chatId)), 'user_id=eq.' + userId]);
      reply = "You're disconnected. Send /start with a fresh code from the website any time to reconnect.";
    } else if (intent === 'gap_summary') {
      reply = await gapSummary(userId);
    } else if (intent === 'meal_ideas') {
      reply = await mealIdeas(userId, extractNamedNutrient(text));
    } else if (intent === 'appointment') {
      if (appointmentAction === 'list') reply = await listAppointments(userId);
      else if (appointmentAction === 'cancel') reply = await cancelAppointment(userId, text);
      else reply = await bookAppointment(userId, text, context);
    } else {
      reply = await dietitianChat(userId, text);
    }

    await logMessage(userId, chatId, 'out', reply, intent);
    await sendMessage(chatId, reply, null, { menu: intent === 'help' });
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('telegram-webhook error:', e);
    try {
      const chatId = req.body && req.body.message && req.body.message.chat && req.body.message.chat.id;
      if (chatId) await sendMessage(chatId, "Something went wrong on my end -- try again in a moment.");
    } catch (e2) { /* best-effort only */ }
    res.status(200).json({ ok: true });
  }
};
