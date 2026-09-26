// lib/dietitian-agent.js
//
// The AI-first-line "dietitian" conversation logic, factored out so both
// api/dietitian-chat.js (the website's Dietitian tab) and
// api/telegram-webhook.js (the Telegram AI agent) call the exact same
// system prompt and the exact same Anthropic request shape. Before this
// file existed, that logic only lived inside dietitian-chat.js -- copying
// it a second time for Telegram would have meant two prompts that could
// quietly drift apart, exactly the kind of duplicated-source-of-truth bug
// this project has run into before (see the meal-box carbs data fix).
//
// Nothing in here talks to Supabase -- callers fetch the message history
// and context themselves (each has a different way of loading it) and
// pass in plain data.

function buildContextBlock(ctx) {
  ctx = (ctx && typeof ctx === 'object') ? ctx : {};
  const lines = [];
  if (typeof ctx.goal === 'string') {
    const goalPhrase = {
      lose: 'losing fat', maintain: 'maintaining their weight',
      gain: 'building muscle', manage: 'managing a health condition',
    }[ctx.goal] || null;
    if (goalPhrase) lines.push(`Stated goal: ${goalPhrase}.`);
  }
  if (ctx.targets && typeof ctx.targets === 'object' && Number.isFinite(ctx.targets.kcal)) {
    lines.push(`Daily targets: ${JSON.stringify(ctx.targets)}.`);
  }
  if (Array.isArray(ctx.rankedGaps) && ctx.rankedGaps.length > 0) {
    lines.push(`Today's nutrient gaps, already computed by the app and ranked largest to smallest (do not recompute or re-rank): ${JSON.stringify(ctx.rankedGaps)}.`);
  }
  if (Array.isArray(ctx.patterns) && ctx.patterns.length > 0) {
    lines.push(`Multi-day patterns from their last-7-logged-days history (real computed data, never invent new counts): ${JSON.stringify(ctx.patterns)}.`);
  }
  return lines.length > 0
    ? `\n\nWhat NutriGap already knows about this person, computed by the app itself (use it when relevant, don't recompute or contradict it, and don't force it into every reply if they're just asking something general):\n${lines.join('\n')}`
    : '\n\nNutriGap has no profile/target data for this person yet -- if that would help answer their question, gently suggest they fill in their profile and targets first.';
}

// `channelNote` lets each caller describe where this conversation is
// happening (the website's Dietitian tab vs a Telegram chat) so the model's
// reply reads naturally in that surface (e.g. it can mention "the booking
// form on this page" on the website, but shouldn't on Telegram, where
// there is no form -- see channelInstructions below).
function buildSystemPrompt(ctx, channelInstructions) {
  const contextBlock = buildContextBlock(ctx);
  return `You are the first-line assistant in the "Dietitian" section of a nutrition app called NutriGap, built for Box Full of Beans' panel of human dietitians.

Who you are and are not: you are NOT a dietitian, and you have NO ability to diagnose, prescribe, or actually create, confirm, reschedule, or cancel an appointment. Your job is to (1) have a helpful, warm conversation that draws out what the person actually needs -- their situation, and their short-term, medium-term, and long-term health goals if they haven't already said -- (2) help them think through and organize a plan in plain terms, and (3) recognize when it's time to point them to booking a real consultation (online or offline) with one of BFB's panel dietitians. You must never say or imply that you have booked, confirmed, or scheduled anything yourself -- only a real, separate booking action does that, and you don't control it.

${channelInstructions}

Conversation style: warm, plain language, like a knowledgeable coach, not clinical or robotic. Ask ONE focused follow-up question at a time rather than interrogating them with a list. Keep replies concise (2-5 sentences) unless they've asked for something that genuinely needs more detail (like walking through a plan).

Hard rules, no exceptions:
- Never diagnose a condition, never interpret medical test results or lab values (that's a separate, stricter part of the app), and never recommend a specific supplement or medication.
- Never state or imply a guaranteed outcome. "may help" / "could support" — never "will fix" or "will cure".
- If the conversation touches something that sounds like it needs real clinical judgment (a medical condition, medication interaction, an eating disorder, pregnancy, a child's nutrition, or anything you're not confident is safe general guidance), say plainly that this needs a real dietitian's judgment and steer them toward booking, rather than answering it yourself.
- Never fabricate a fact about this person -- if you don't have data for something (their weight, a lab value, a past conversation), ask rather than assume.
- Don't repeat the same disclaimer in every message -- say it plainly once when it's actually relevant, not as a reflexive tic.

When you judge the conversation has reached a point where booking a real consultation would genuinely help them (they've described a need a first-line chat can't fully resolve, or they've directly asked to talk to a dietitian, or you've gathered enough about their situation that a real session is the natural next step), say so plainly and naturally in your reply, and separately set suggestBooking to true.

Respond with ONLY a JSON object -- no markdown, no code fences, no text before or after it -- in exactly this shape:
{"reply": "...", "suggestBooking": true}${contextBlock}`;
}

const WEB_CHANNEL_INSTRUCTIONS =
  'You can describe the appointment request form elsewhere on this same page and encourage them to use it.';
const TELEGRAM_CHANNEL_INSTRUCTIONS =
  'This conversation is happening over Telegram, not the website -- there is no form on screen. If booking would help, tell them they can request an appointment right here in this chat (e.g. "book an online appointment for Tuesday evening"), or do it from the Dietitian tab on the NutriGap website -- either works, since it\'s the same account.';

// Calls the Anthropic API with the dietitian system prompt and returns
// { reply, suggestBooking } -- or throws, with a `.userMessage` the caller
// can show as-is (already stripped of raw JSON/HTML noise), matching the
// error-shape convention the other api/*.js files use.
async function callDietitianModel({ apiKey, messages, context, channel }) {
  const channelInstructions = channel === 'telegram' ? TELEGRAM_CHANNEL_INSTRUCTIONS : WEB_CHANNEL_INSTRUCTIONS;
  const systemPrompt = buildSystemPrompt(context, channelInstructions);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    let message = errText;
    try {
      const errJson = JSON.parse(errText);
      if (errJson && errJson.error && errJson.error.message) message = errJson.error.message;
    } catch (parseErr) { /* not JSON -- fall back to the raw text as-is */ }
    const err = new Error('Anthropic API error: ' + message);
    err.userMessage = message;
    throw err;
  }

  const data = await response.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  const rawText = (textBlock && textBlock.text) || '';

  let cleaned = rawText.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    if (rawText.trim()) return { reply: rawText.trim(), suggestBooking: false };
    const err = new Error('Could not parse the AI response.');
    err.userMessage = "Sorry, I couldn't put together a reply just now -- try again in a moment.";
    throw err;
  }

  const reply = typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : null;
  if (!reply) {
    const err = new Error('The AI response was missing a reply.');
    err.userMessage = "Sorry, I couldn't put together a reply just now -- try again in a moment.";
    throw err;
  }
  return { reply, suggestBooking: parsed.suggestBooking === true };
}

module.exports = { buildSystemPrompt, callDietitianModel, WEB_CHANNEL_INSTRUCTIONS, TELEGRAM_CHANNEL_INSTRUCTIONS };
