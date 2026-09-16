// api/recipe-ideas.js
//
// Turns a short list of real foods from the app's own database into a
// couple of simple recipe ideas. This is plain cooking content — no
// nutrition claims, no medical framing — used from the "Notes for your
// dietitian" section as an optional, user-triggered extra.

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

  const { foods } = req.body || {};
  if (!Array.isArray(foods) || foods.length === 0) {
    res.status(400).json({ error: 'Missing required field: foods (non-empty array).' });
    return;
  }

  const systemPrompt = `You suggest simple, practical recipe ideas for a home cook, for a nutrition app.

Rules:
- Build each recipe around at least one of the given foods as a key ingredient. You may add common pantry staples (oil, salt, common spices, onion, garlic, etc.) freely.
- Suggest exactly 2 recipes, each simple enough for a home cook on a weeknight (under 30 minutes active time).
- Do not make any nutrition, health, or medical claims about the recipes — this is purely cooking content.
- Keep ingredient lists and steps concise.

Respond with ONLY a JSON object — no markdown, no commentary — in exactly this shape:
{"recipes": [{"title": "...", "time": "e.g. 20 min", "ingredients": ["...", "..."], "steps": ["...", "..."]}]}`;

  const userPrompt = `Suggest recipes using: ${foods.join(', ')}`;

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
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(502).json({ error: 'Claude API error: ' + errText });
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
      res.status(502).json({ error: 'Could not parse the AI response as JSON.', rawPreview: cleaned.slice(0, 300) });
      return;
    }

    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
