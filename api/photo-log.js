// api/photo-log.js
//
// Turns a photo of a plate into a plain-language description — nothing
// more. It never estimates nutrition itself and never tries to match
// against the app's food database; it only describes what's visible, the
// same way a person would say it out loud. That description then runs
// through the exact same client-side transcript parser used for typed and
// spoken entries, so the reviewable-checklist safety net is identical
// regardless of how the food was described.

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

  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64) {
    res.status(400).json({ error: 'Missing required field: imageBase64.' });
    return;
  }

  const systemPrompt = `You describe what's visibly on a plate of food, in a single natural sentence — exactly the way someone would say out loud what they're about to eat, for a nutrition logging app.

Rules:
- Mention each distinct food or dish separately, joined by commas or "and".
- Give a rough quantity for each based on what's visible (e.g. "two", "a cup of", "a small bowl of", "a spoon of") — these are rough visual estimates, not precise measurements, and you should describe them as approximate.
- Use everyday, generic food names. If you're not confident about a specific or unusual dish name, use a more generic description instead of guessing.
- Do not estimate calories, nutrients, or any numeric nutrition values — only describe the food itself.
- If the image doesn't clearly show food, respond with exactly: NO_FOOD_DETECTED

Respond with ONLY the sentence itself (or NO_FOOD_DETECTED) — no preamble, no markdown, no explanation.`;

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
        max_tokens: 300,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: 'What food is on this plate?' },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(502).json({ error: 'Claude API error: ' + errText });
      return;
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const description = ((textBlock && textBlock.text) || '').trim();

    res.status(200).json({ description });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
