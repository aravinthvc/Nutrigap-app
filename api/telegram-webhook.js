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
// have the same AI-first-line dietitian conversation as the website's
// Dietitian tab (continuing the same shared thread), and request/list/
// cancel a real appointment. Anything it's not confident routing gets
// treated as a dietitian-chat message -- that's the safe, designed-for-
// open-ended-conversation default, never a guess dressed up as an action.

const db = require('../lib/supabase-rest');
const nc = require('../lib/nutrition-core');
const { callDietitianModel } = require('../lib/dietitian-agent');

const TELEGRAM_API = 'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN;
const APPT_TIME_WINDOWS = ['Morning (9am-12pm)', 'Afternoon (12pm-4pm)', 'Evening (4pm-8pm)'];
const MEAL_VALUES = ['breakfast', 'lunch', 'dinner', 'snack'];

// ---------- Telegram I/O ----------

async function sendMessage(chatId, text) {
  await fetch(TELEGRAM_API + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
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

async function findLinkedUser(chatId) {
  const rows = await db.select('telegram_links', {
    columns: 'user_id',
    filters: ['chat_id=eq.' + encodeURIComponent(String(chatId))],
    limit: 1,
  });
  return rows && rows[0] ? rows[0].user_id : null;
}

async function handleLinking(chatId, text, from) {
  const parts = text.trim().split(/\s+/);
  const code = parts[0] === '/start' ? (parts[1] || '') : (/^[A-Z0-9]{6}$/i.test(text.trim()) ? text.trim() : '');

  if (!code) {
    await sendMessage(chatId,
      "Hi! I'm the NutriGap AI agent -- I'm not linked to an account yet.\n\n" +
      'To connect me: open NutriGap on the website → Profile tab → "Connect Telegram", ' +
      'get a one-time code, then send it to me here (or send "/start CODE").'
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
  }], { returning: false });
  await db.update('telegram_link_codes', ['code=eq.' + encodeURIComponent(row.code)], { used_at: new Date().toISOString() });

  await sendMessage(chatId,
    "You're linked! Here's what I can do:\n\n" +
    '• Tell me what you ate ("2 chapathis with palak matar for lunch") and I\'ll log it\n' +
    '• Ask "what\'s my gap today?" for your macro/micro summary\n' +
    '• Just talk to me about your goals -- I\'m the same AI first-line as the Dietitian tab\n' +
    '• "book an online appointment Tuesday evening" to request a real consultation\n' +
    '• "my appointments" to see what\'s upcoming\n\n' +
    'Send /help any time to see this again, or /unlink to disconnect this chat.'
  );
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
    columns: 'id,servings,meal,entry_date,foods(*)',
    filters: ['user_id=eq.' + userId, 'entry_date=eq.' + dateStr],
  });
  return (rows || []).map(row => ({ ...nc.mapFoodRow(row.foods || {}), servings: row.servings, meal: row.meal }));
}

function formatGapSummary(t, tg, dateLabel) {
  if (!tg.kcal) return "You haven't finished setting up your profile yet -- add your age, sex, height and weight on the website (Profile tab) first, then I can work out your targets.";
  const ranked = nc.rankGapsForInsight(t, tg);
  const kcalLine = `Calories: ${Math.round(t.kcal)} / ${Math.round(tg.kcal)} kcal`;
  if (ranked.length === 0) {
    return `${dateLabel}'s log — ${kcalLine}. Everything else is on target. Nicely balanced day.`;
  }
  const top = ranked.slice(0, 5).map(g => {
    if (g.isLimit) return `• ${g.label}: ${g.consumed}${g.unit} (limit ${g.target}${g.unit}) — over`;
    const verb = g.direction === 'short' ? 'short' : 'over';
    const amt = Math.abs(g.target - g.consumed);
    return `• ${g.label}: ${g.consumed}${g.unit} / ${g.target}${g.unit} — ${Math.round(amt * 10) / 10}${g.unit} ${verb}`;
  }).join('\n');
  return `${dateLabel}'s log — ${kcalLine}\n\nBiggest gaps:\n${top}\n\nAsk me anything about these, or say what you're planning to eat next and I can tell you how it'd help.`;
}

async function gapSummary(userId) {
  const loaded = await loadTargets(userId);
  if (!loaded) return "You haven't finished setting up your profile yet -- add your age, sex, height and weight on the website (Profile tab) first, then I can work out your targets.";
  const dateStr = nc.istDateStr(new Date());
  const entries = await loadEntriesForDate(userId, dateStr);
  if (entries.length === 0) return "You haven't logged anything today yet. Tell me what you've eaten and I'll get it started.";
  const t = nc.totals(entries);
  return formatGapSummary(t, loaded.targets, 'Today');
}

// ---------- Meal logging ----------

async function loadFoodCatalog() {
  const rows = await db.select('foods', { columns: 'id,name', order: 'name.asc' });
  return rows || [];
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
  const unmatched = items.filter(it => !it.name);
  if (matched.length === 0) {
    return `I couldn't find "${unmatched.map(u => u.queryText).join('", "')}" in the food catalog yet. Try describing it differently, or it may not be added yet.`;
  }

  const nameToId = new Map(catalog.map(f => [f.name, f.id]));
  const resolvedMeal = meal || nc.defaultMealForHour(nc.istHour(new Date()));
  const entryDate = nc.istDateStr(new Date());
  const rows = matched.map(it => ({
    user_id: userId, entry_date: entryDate, food_id: nameToId.get(it.name), servings: it.servings, meal: resolvedMeal,
  }));
  await db.insert('diet_entries', rows, { returning: false });

  const loggedLines = matched.map(it => `${it.servings === 1 ? '' : it.servings + '× '}${it.name}`).join(', ');
  let reply = `Logged under ${resolvedMeal}: ${loggedLines}.`;
  if (unmatched.length > 0) {
    reply += ` (Couldn't match: "${unmatched.map(u => u.queryText).join('", "')}" -- not in the catalog yet.)`;
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
    const allowed = ['log_meal', 'gap_summary', 'appointment', 'help', 'unlink', 'dietitian_chat'];
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
  '• Tell me what you ate ("2 chapathis with palak matar for lunch") and I\'ll log it\n' +
  '• Ask "what\'s my gap today?" for your macro/micro summary\n' +
  '• Just talk to me about your goals -- I\'m the same AI first-line as the Dietitian tab\n' +
  '• "book an online appointment Tuesday evening" to request a real consultation\n' +
  '• "my appointments" to see what\'s upcoming, or "cancel my appointment" to cancel one\n' +
  '• /unlink to disconnect this chat from your NutriGap account';

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
    const message = update.message;
    if (!message || typeof message.text !== 'string') {
      res.status(200).json({ ok: true });
      return;
    }
    const chatId = message.chat.id;
    const text = message.text.trim();
    if (!text) { res.status(200).json({ ok: true }); return; }

    let userId = await findLinkedUser(chatId);

    if (!userId) {
      await handleLinking(chatId, text, message.from);
      res.status(200).json({ ok: true });
      return;
    }

    // Deterministic slash commands first -- faster, cheaper, and more
    // reliable than routing them through the AI classifier.
    const lower = text.toLowerCase();
    if (lower === '/start' || lower === '/help') {
      await sendMessage(chatId, HELP_TEXT);
      res.status(200).json({ ok: true });
      return;
    }
    if (lower === '/unlink') {
      await db.remove('telegram_links', ['chat_id=eq.' + encodeURIComponent(String(chatId)), 'user_id=eq.' + userId]);
      await sendMessage(chatId, "You're disconnected. Send /start with a fresh code from the website any time to reconnect.");
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
    if (lower === '/appointments') {
      const reply = await listAppointments(userId);
      await logMessage(userId, chatId, 'in', text, 'appointment');
      await logMessage(userId, chatId, 'out', reply, 'appointment');
      await sendMessage(chatId, reply);
      res.status(200).json({ ok: true });
      return;
    }

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
    await sendMessage(chatId, reply);
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
