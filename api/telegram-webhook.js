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
const APPT_TIME_WINDOWS = ['Morning (9am-12pm)', 'Afternoon (12pm-4pm)', 'Evening (4pm-8pm)'];
const MEAL_VALUES = ['breakfast', 'lunch', 'dinner', 'snack'];

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
    columns: 'user_id,onboarding_state,source,nudges_enabled',
    filters: ['chat_id=eq.' + encodeURIComponent(String(chatId))],
    limit: 1,
  });
  return rows && rows[0] ? rows[0] : null;
}

async function handleLinking(chatId, text, from) {
  const parts = text.trim().split(/\s+/);
  const code = parts[0] === '/start' ? (parts[1] || '') : (/^[A-Z0-9]{6}$/i.test(text.trim()) ? text.trim() : '');

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
    '• "my appointments" to see what\'s upcoming\n\n' +
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

async function createSelfServeAccount(chatId, from) {
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
  return userId;
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

  if (data === 'ob:begin') {
    const existing = await findLink(chatId);
    if (existing) { await sendMessage(chatId, "This chat's already set up -- send /help to see what I can do."); return; }
    const userId = await createSelfServeAccount(chatId, cq.from);
    if (!userId) { await sendMessage(chatId, "Something went wrong setting you up -- try again in a moment."); return; }
    await askOnboardingStep(chatId, { step: 'name', answers: {} });
    return;
  }
  if (data === 'ob:have_account') {
    await sendMessage(chatId, 'No problem -- open NutriGap on the website → Profile tab → "Connect Telegram", get a one-time code, then send it to me here (or send "/start CODE").');
    return;
  }

  const link = await findLink(chatId);
  if (!link || !link.onboarding_state || !link.onboarding_state.step) {
    await sendMessage(chatId, "That button doesn't apply anymore -- send /help to see what I can do.");
    return;
  }
  await handleOnboardingButton(chatId, link.user_id, link.onboarding_state, data);
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

async function mealIdeas(userId) {
  const loaded = await loadTargets(userId);
  if (!loaded) return "You haven't finished setting up your profile yet -- add your age, sex, height and weight on the website (Profile tab) first, then I can work out your targets.";
  const dateStr = nc.istDateStr(new Date());
  const entries = await loadEntriesForDate(userId, dateStr);
  const t = nc.totals(entries);
  const tg = loaded.targets;

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

async function logMeal(userId, text, mealHint) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "Something's misconfigured on the server side -- Aravinth's been notified.";

  const catalog = await loadFoodCatalog();
  if (catalog.length === 0) return "I couldn't reach the food catalog just now -- try again in a moment.";

  const { items, meal } = await extractMealItems(apiKey, text, catalog, mealHint);
  if (items.length === 0) {
    return "I couldn't tell what you ate from that -- try naming the dish more directly, e.g. \"2 chapathis with palak matar for lunch\".";
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
    return `I couldn't find "${unmatched.map(u => u.queryText).join('", "')}" in the food catalog yet -- I've flagged it for the team to add. Try describing it differently in the meantime, or it may just not be in there yet.`;
  }

  const nameToId = new Map(catalog.map(f => [f.name, f.id]));
  const resolvedMeal = meal || nc.defaultMealForHour(nc.istHour(new Date()));
  const entryDate = nc.istDateStr(new Date());
  const rows = matched.map(it => ({
    user_id: userId, entry_date: entryDate, food_id: nameToId.get(it.name), servings: it.servings, meal: resolvedMeal,
  }));
  const mealBoxRows = mealBoxMatches.map(it => ({
    user_id: userId, entry_date: entryDate, meal_box_item_id: it.mealBoxId, servings: it.servings, meal: resolvedMeal,
  }));
  if (rows.length > 0) await db.insert('diet_entries', rows, { returning: false });
  if (mealBoxRows.length > 0) await db.insert('diet_entries', mealBoxRows, { returning: false });

  const loggedLines = matched.map(it => `${it.servings === 1 ? '' : it.servings + '× '}${it.name}`);
  const mealBoxLines = mealBoxMatches.map(it => `${it.servings === 1 ? '' : it.servings + '× '}${it.mealBoxName} (BFB box)`);
  let reply = `Logged under ${resolvedMeal}: ${[...loggedLines, ...mealBoxLines].join(', ')}.`;
  if (mealBoxMatches.length > 0) {
    reply += ` Note: the BFB meal-box item${mealBoxMatches.length === 1 ? '' : 's'} only track${mealBoxMatches.length === 1 ? 's' : ''} calories/protein/carbs/fat -- fiber and micronutrients aren't counted for ${mealBoxMatches.length === 1 ? 'it' : 'those'}.`;
  }
  if (unmatched.length > 0) {
    await recordFoodRequests(userId, unmatched.map(u => u.queryText));
    reply += ` (Couldn't match: "${unmatched.map(u => u.queryText).join('", "')}" -- not in the catalog yet, flagged for the team.)`;
  }
  reply += ' Ask "what\'s my gap today?" any time to see how that shifted things.';
  return reply;
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
  '• Use the buttons below any time -- My gap, Meal ideas, Log a meal, Appointments, Help\n' +
  '• Tell me what you ate ("2 chapathis with palak matar for lunch") and I\'ll log it\n' +
  '• Ask "what\'s my gap today?" for your macro/micro summary\n' +
  '• Ask "what should I eat?" for BFB meal-box ideas to help close today\'s gap\n' +
  '• Just talk to me about your goals -- I\'m the same AI first-line as the Dietitian tab\n' +
  '• "book an online appointment Tuesday evening" to request a real consultation\n' +
  '• "my appointments" to see what\'s upcoming, or "cancel my appointment" to cancel one\n' +
  '• /nudges to turn daily check-in reminders on or off\n' +
  '• /unlink to disconnect this chat from your NutriGap account';

// Button taps from MAIN_MENU_KEYBOARD arrive back as plain text messages --
// this maps the ones that are just shortcuts for an existing slash command
// onto that command's text, so one block of logic handles both. "📝 Log a
// meal" isn't in here: it has no equivalent command, it's just a prompt
// (see the dedicated check for it in the main handler).
const BUTTON_TO_COMMAND = {
  '📊 My gap': '/gap',
  '🍽 Meal ideas': '/meals',
  '📅 Appointments': '/appointments',
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
    if (!message || typeof message.text !== 'string') {
      res.status(200).json({ ok: true });
      return;
    }
    const chatId = message.chat.id;
    const text = message.text.trim();
    if (!text) { res.status(200).json({ ok: true }); return; }

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

    // A tap on the persistent menu's "📝 Log a meal" button isn't an action
    // in itself -- there's nothing to log yet -- so it just prompts, same
    // as it would if someone asked "how do I log food?".
    if (text === '📝 Log a meal') {
      await sendMessage(chatId, 'Tell me what you ate, like "2 chapathis and dal for lunch", and I\'ll log it and match it against the catalog.');
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
    if (lower === '/meals' || lower === '/ideas') {
      const reply = await mealIdeas(userId);
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

    // Everything past here involves at least one AI call (classification,
    // and usually a second for extraction/chat/booking) -- show typing so
    // the gap before a reply reads as "thinking", not broken.
    await sendTyping(chatId);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const context = await recentContext(userId, 8);
    const { intent, appointmentAction } = await classifyIntent(apiKey, text, context);
    await logMessage(userId, chatId, 'in', text, intent);

    let reply;
    if (intent === 'help') {
      reply = HELP_TEXT;
    } else if (intent === 'unlink') {
      await db.remove('telegram_links', ['chat_id=eq.' + encodeURIComponent(String(chatId)), 'user_id=eq.' + userId]);
      reply = "You're disconnected. Send /start with a fresh code from the website any time to reconnect.";
    } else if (intent === 'gap_summary') {
      reply = await gapSummary(userId);
    } else if (intent === 'meal_ideas') {
      reply = await mealIdeas(userId);
    } else if (intent === 'log_meal') {
      reply = await logMeal(userId, text, null);
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
