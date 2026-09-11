// api/insights.js
//
// This runs on Vercel's server, not in the browser — so the Claude API key
// below (read from an environment variable) is never visible to anyone
// visiting the site. The frontend calls this endpoint with the person's
// computed nutrient gap; this function is the only thing that talks to
// Claude directly.

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

  const { targets, consumed, goal, foodNames } = req.body || {};
  if (!targets || !consumed || !goal || !Array.isArray(foodNames)) {
    res.status(400).json({ error: 'Missing required fields: targets, consumed, goal, foodNames.' });
    return;
  }

  const goalPhrase = {
    lose: 'losing fat',
    maintain: 'maintaining their weight',
    gain: 'building muscle',
    manage: 'managing a health condition',
  }[goal] || 'their stated goal';

  const systemPrompt = `You are a nutrition analysis assistant embedded in a diet-tracking app called NutriGap.
You are given a person's daily nutrient targets, what they actually consumed today, and their goal.

Respond with ONLY a JSON object — no markdown, no code fences, no preamble, no text before or after it — in exactly this shape:
{"analysis": "...", "suggestions": [{"name": "...", "reason": "..."}]}

Rules you must follow without exception:
- "analysis" is a short paragraph (2-4 sentences) in plain, non-clinical language, describing which nutrients are short, on target, or over a limit today.
- Never state or imply a guaranteed outcome. Use language like "may help" — never "will fix" or "will cause".
- Never diagnose a condition, and never imply the person has a medical issue based on their diet log.
- If the goal is "managing a health condition", explicitly note that general nutrition guidance can't replace their clinician's specific plan.
- "suggestions" must contain 2-4 items. Every "name" field must be copied EXACTLY, character for character, from the provided list of available food names. Never invent a food, a dish, or a brand that is not in that list.
- Each suggestion's "reason" is a short phrase (under 12 words) naming which nutrient gap it helps close.
- Do not mention supplements, medications, or anything outside whole foods from the provided list.
- Write like a concise, knowledgeable coach — not a robotic recitation of the numbers you were given.`;

  const userPrompt = `Daily targets: ${JSON.stringify(targets)}
Consumed today: ${JSON.stringify(consumed)}
Goal: ${goalPhrase}
Available foods — choose suggestion names ONLY from this exact list: ${JSON.stringify(foodNames)}`;

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
        max_tokens: 800,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt },
          // Prefilling the assistant's turn with "{" forces the reply to
          // continue directly as a JSON object, which reliably prevents
          // the model from adding an intro sentence or a closing remark
          // before/after the JSON.
          { role: 'assistant', content: '{' },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(502).json({ error: 'Claude API error: ' + errText });
      return;
    }

    const data = await response.json();
    const rawText = (data.content && data.content[0] && data.content[0].text) || '';
    // Add back the "{" we prefilled, since the model's own text continues
    // after it rather than repeating it, then strip any stray code fences
    // and grab everything between the first "{" and the last "}" as a
    // final safety net against any leading/trailing text.
    let cleaned = ('{' + rawText).replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({
        error: 'Could not parse the AI response as JSON.',
        rawPreview: cleaned.slice(0, 300),
      });
      return;
    }

    // Guardrail: drop any suggestion whose name isn't an exact match in our
    // real food list, in case the model still slips one in despite the
    // instruction above — we never want to show a fabricated food.
    const validNames = new Set(foodNames);
    parsed.suggestions = (parsed.suggestions || []).filter(s => validNames.has(s.name));

    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
