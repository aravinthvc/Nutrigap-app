// api/insights.js
//
// This runs on Vercel's server, not in the browser — so the Claude API key
// below (read from an environment variable) is never visible to anyone
// visiting the site. The frontend does all the arithmetic itself (which
// gaps exist, how big they are, which nutrients keep coming up short across
// the last several logged days) and sends the already-correct numbers here.
// This function's only job is turning those numbers into calm, honest
// prose and picking a short ranked list of real foods to suggest — it
// never computes or invents a number of its own.

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

  const { dateLabel, goal, remainingKcal, rankedGaps, patterns, foodNames } = req.body || {};
  if (
    typeof dateLabel !== 'string' ||
    typeof goal !== 'string' ||
    typeof remainingKcal !== 'number' ||
    !Array.isArray(rankedGaps) ||
    !Array.isArray(patterns) ||
    !Array.isArray(foodNames)
  ) {
    res.status(400).json({ error: 'Missing or malformed fields: dateLabel, goal, remainingKcal, rankedGaps, patterns, foodNames.' });
    return;
  }

  const goalPhrase = {
    lose: 'losing fat',
    maintain: 'maintaining their weight',
    gain: 'building muscle',
    manage: 'managing a health condition',
  }[goal] || 'their stated goal';

  const systemPrompt = `You are a nutrition analysis assistant embedded in a diet-tracking app called NutriGap.
You are given one person's nutrient gaps for a specific day, already computed and ranked for you by the app — a fixed set of facts you must explain, never recompute, re-rank, or add to.

Respond with ONLY a JSON object — no markdown, no code fences, no preamble, no text before or after it — in exactly this shape:
{"analysis": "...", "suggestions": [{"name": "...", "reason": "..."}, ...]}

Follow this exact structure for "analysis" (2-5 sentences), in plain, non-clinical, calm language:
1. Open by naming the day (use the exact dateLabel given, e.g. "Today's log shows..." or "<dateLabel>'s log shows...").
2. Cover the biggest gaps first — rankedGaps is already sorted largest to smallest by how far off target it is; respect that order, don't re-rank or re-prioritize it yourself.
3. If any entry in rankedGaps has direction "over", name what's already been exceeded (for a nutrient marked isLimit:true, framing it as "already over your limit" is correct; for others, "already past target" is correct — don't call an over-target macro like protein a bad thing unless the day's goal direction says so).
4. Close with one calm, non-alarmist sentence. A gap on a single day is never a crisis — never use alarming language ("dangerously low", "you need to fix this immediately", "this is bad for your health").

Tone rules for the "patterns" array — each entry means this exact nutrient has landed short (or, for a limit nutrient, over) on "count" of the last "of" logged days. This is real historical data the app computed, not a guess, and you must use the exact numbers given, never invent or round differently:
- If patterns is empty, say nothing about a multi-day trend — describe only today.
- For a pattern entry with possiblyUnderlogged: false, name the pattern plainly and specifically using the real count/of values, e.g. "this is the Nth day this week protein's landed short" — this is a confident, factual statement because the app has already ruled out incomplete logging as the explanation.
- For a pattern entry with possiblyUnderlogged: true, you must use honest, ambiguous framing instead of asserting a real dietary shortfall — something like: "<nutrient> has landed short on N of the last M logged days — a few of those days were lightly logged overall, so part of that could be food that wasn't entered rather than a real gap." Never claim confidently that this reflects the person's actual diet when possiblyUnderlogged is true; naming the ambiguity honestly is more useful than a wrong confident explanation.
- Only mention nutrients that appear in the patterns array, and only the day-counts you were given — never a nutrient or number that isn't there.

The suggestions — this is a shortlist of individual foods for the person to choose from and add to their log themselves, NOT a combined meal, so don't reason about eating all of them together or about which meal (breakfast/lunch/dinner) they'd go with:
- Set "suggestions" to an empty array [] when rankedGaps is empty (there's nothing to close), or when remainingKcal is at or below 0 and the goal is not "gain" (no calorie room left to add anything today).
- Otherwise return up to 4 foods, each copied EXACTLY character-for-character from the provided foodNames list — never invent a food, dish, or brand not on that list. Return fewer than 4 if the food list genuinely doesn't offer that many reasonable, distinct options — never pad the list with a weak or repetitive pick just to reach 4.
- Every suggested food must independently help close the largest gap(s) in rankedGaps and reasonably fit within remainingKcal on its own (these are alternatives to pick ONE from, not amounts to sum together).
- Prefer spreading the list across DIFFERENT gaps from rankedGaps where the food list allows it (e.g. one pick mainly for the top gap, another for the next one down), rather than 4 foods that all happen to address only the single biggest gap — but never force a weak pick onto a lesser gap just for variety; a food that strongly addresses the top gap is always a legitimate choice.
- Never repeat the same food twice in the list.
- Each "reason" is a short phrase (under 16 words) naming which specific gap(s) that food helps close, in the direction of the stated goal.

General rules:
- Never state or imply a guaranteed outcome. Use language like "may help" — never "will fix" or "will cause".
- Never diagnose a condition, and never imply the person has a medical issue based on one day's (or one week's) diet log.
- If the goal is "managing a health condition", explicitly note that general nutrition guidance can't replace their clinician's specific plan.
- Do not mention supplements, medications, or anything outside whole foods from the provided list.
- Write like a concise, knowledgeable coach — not a robotic recitation of the numbers you were given.`;

  const userPrompt = `Day: ${dateLabel}
Goal: ${goalPhrase}
Remaining calorie budget today: ${remainingKcal} kcal (negative means already over target)
Today's gaps, already ranked largest to smallest — do not re-rank: ${JSON.stringify(rankedGaps)}
Multi-day patterns from the last-7-logged-days history (real computed data, never invent new counts): ${JSON.stringify(patterns)}
Available foods — choose the suggestion name ONLY from this exact list: ${JSON.stringify(foodNames)}`;

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
        max_tokens: 1200,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      // Anthropic's error responses are JSON with the actual human-readable
      // reason nested inside (e.g. an expired API key or a low credit
      // balance) — pull that out instead of forwarding the raw JSON blob,
      // so whatever's actually wrong is plain and readable on the page.
      let message = errText;
      try {
        const errJson = JSON.parse(errText);
        if (errJson && errJson.error && errJson.error.message) message = errJson.error.message;
      } catch (parseErr) { /* not JSON — fall back to the raw text as-is */ }
      res.status(502).json({ error: message });
      return;
    }

    const data = await response.json();
    // Look for the actual text block rather than assuming it's the first
    // item — newer Claude models can return a "thinking" block ahead of
    // the text block, and grabbing content[0] blindly would grab that
    // instead and come back empty.
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const rawText = (textBlock && textBlock.text) || '';
    // Strip any stray code fences, then grab everything between the first
    // "{" and the last "}" as a safety net against any leading/trailing
    // text the model adds despite being told not to.
    let cleaned = rawText.replace(/```json|```/g, '').trim();
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
        blockTypes: (data.content || []).map(b => b.type),
      });
      return;
    }

    // Guardrail: drop any suggestion whose name isn't an exact match in our
    // real food list, in case the model still slips one in despite the
    // instruction above — we never want to show a fabricated food. Also
    // dedupe by name and cap at 4, as a backstop against the model not
    // following those parts of the instructions either.
    const validNames = new Set(foodNames);
    const seen = new Set();
    parsed.suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.filter(s => {
          if (!s || typeof s.name !== 'string' || !validNames.has(s.name) || seen.has(s.name)) return false;
          seen.add(s.name);
          return true;
        }).slice(0, 4)
      : [];

    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
