// api/dietitian-chat.js
//
// The "Dietitian" tab's AI first line. This runs on Vercel's server, same as
// api/insights.js — the Claude API key never reaches the browser.
//
// What this assistant is and isn't: it's a first-line intake and planning
// helper for BFB's panel of human dietitians — not a dietitian itself, and
// it has no ability to actually confirm, schedule, reschedule, or cancel an
// appointment. The real appointment request is created by the frontend's own
// form (a plain insert into dietitian_appointments) when the person submits
// it — this endpoint can only ever point them toward that form and set
// suggestBooking:true so the frontend can highlight it; it must never claim
// to have booked, confirmed, or scheduled anything itself.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing its ANTHROPIC_API_KEY environment variable.' });
    return;
  }

  const { messages, context } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Missing or empty required field: messages.' });
    return;
  }
  const validRoles = new Set(['user', 'assistant']);
  const cleanMessages = messages.filter(m =>
    m && validRoles.has(m.role) && typeof m.content === 'string' && m.content.trim().length > 0
  );
  if (cleanMessages.length === 0) {
    res.status(400).json({ error: 'No valid messages (each needs role "user" or "assistant" and non-empty content).' });
    return;
  }
  // Cap how much history gets sent up, as a cost/latency backstop -- the
  // frontend already stores the full thread, this just bounds one request.
  const recentMessages = cleanMessages.slice(-30);
  // Anthropic's API requires the message list to start with a "user" turn.
  while (recentMessages.length && recentMessages[0].role !== 'user') recentMessages.shift();
  if (recentMessages.length === 0) {
    res.status(400).json({ error: 'Message history must contain at least one user message.' });
    return;
  }

  const ctx = context && typeof context === 'object' ? context : {};
  const contextLines = [];
  if (typeof ctx.goal === 'string') {
    const goalPhrase = {
      lose: 'losing fat', maintain: 'maintaining their weight',
      gain: 'building muscle', manage: 'managing a health condition',
    }[ctx.goal] || null;
    if (goalPhrase) contextLines.push(`Stated goal: ${goalPhrase}.`);
  }
  if (ctx.targets && typeof ctx.targets === 'object' && Number.isFinite(ctx.targets.kcal)) {
    contextLines.push(`Daily targets: ${JSON.stringify(ctx.targets)}.`);
  }
  if (Array.isArray(ctx.rankedGaps) && ctx.rankedGaps.length > 0) {
    contextLines.push(`Today's nutrient gaps, already computed by the app and ranked largest to smallest (do not recompute or re-rank): ${JSON.stringify(ctx.rankedGaps)}.`);
  }
  if (Array.isArray(ctx.patterns) && ctx.patterns.length > 0) {
    contextLines.push(`Multi-day patterns from their last-7-logged-days history (real computed data, never invent new counts): ${JSON.stringify(ctx.patterns)}.`);
  }
  const contextBlock = contextLines.length > 0
    ? `\n\nWhat NutriGap already knows about this person, computed by the app itself (use it when relevant, don't recompute or contradict it, and don't force it into every reply if they're just asking something general):\n${contextLines.join('\n')}`
    : '\n\nNutriGap has no profile/target data for this person yet -- if that would help answer their question, gently suggest they fill in tab 01, Profile & targets.';

  const systemPrompt = `You are the first-line assistant in the "Dietitian" section of a nutrition app called NutriGap, built for Box Full of Beans' panel of human dietitians.

Who you are and are not: you are NOT a dietitian, and you have NO ability to diagnose, prescribe, or actually create, confirm, reschedule, or cancel an appointment. Your job is to (1) have a helpful, warm conversation that draws out what the person actually needs -- their situation, and their short-term, medium-term, and long-term health goals if they haven't already said -- (2) help them think through and organize a plan in plain terms, and (3) recognize when it's time to point them to booking a real consultation (online or offline) with one of BFB's panel dietitians, using the appointment request form elsewhere on this same page. You can describe that form and encourage them to use it; you must never say or imply that you have booked, confirmed, or scheduled anything yourself -- only a real submission of that form does that, and you don't control it.

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

  const anthropicMessages = recentMessages.map(m => ({ role: m.role, content: m.content }));

  try {
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
        messages: anthropicMessages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      let message = errText;
      try {
        const errJson = JSON.parse(errText);
        if (errJson && errJson.error && errJson.error.message) message = errJson.error.message;
      } catch (parseErr) { /* not JSON — fall back to the raw text as-is */ }
      res.status(502).json({ error: message });
      return;
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
      // The model occasionally answers in plain prose despite the instruction
      // -- rather than fail the whole turn, fall back to showing that text
      // as-is instead of leaving the person with a dead end.
      if (rawText.trim()) {
        res.status(200).json({ reply: rawText.trim(), suggestBooking: false });
        return;
      }
      res.status(502).json({
        error: 'Could not parse the AI response.',
        rawPreview: cleaned.slice(0, 300),
      });
      return;
    }

    const reply = typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : null;
    if (!reply) {
      res.status(502).json({ error: 'The AI response was missing a reply.' });
      return;
    }
    res.status(200).json({
      reply,
      suggestBooking: parsed.suggestBooking === true,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
