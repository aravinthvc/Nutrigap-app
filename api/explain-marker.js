// api/explain-marker.js
//
// General, textbook-level education about what a lab test measures and its
// general significance — used only as a fallback for markers not already
// covered by the app's static library (see MARKER_EDUCATION in index.html).
// The frontend caches every result in the `marker_explanations` table so
// each unusual test name is only ever explained once, for anyone, not once
// per person per view.

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

  const { markerName } = req.body || {};
  if (!markerName || typeof markerName !== 'string') {
    res.status(400).json({ error: 'Missing required field: markerName.' });
    return;
  }

  const systemPrompt = `You explain medical lab tests in plain language for a general audience, for a health app.

Rules you must follow without exception:
- Describe the test in general, textbook terms only — what it measures and why it's typically ordered. Never mention or address "you", "your result", or any specific person.
- For significance, describe general population-level associations only (e.g. "low levels are commonly associated with..."). Never diagnose, never say something is concerning, never recommend treatment or a specific action.
- If you are not confident this is a real, recognized medical or lab test, say so plainly rather than inventing an explanation.
- Keep each field to 1-2 concise sentences.

Respond with ONLY a JSON object — no markdown, no code fences, no commentary — in exactly this shape:
{"what": "...", "significance": "..."}`;

  const userPrompt = `Explain this lab test: "${markerName}"`;

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
        max_tokens: 500,
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
