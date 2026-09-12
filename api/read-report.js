// api/read-report.js
//
// Reads an uploaded lab report (PDF or image) using Claude's document/vision
// capability and extracts ONLY the values explicitly printed in it. This is
// the highest-sensitivity endpoint in the app, so the system prompt is
// deliberately narrow: extraction only, no diagnosis, no inferred reference
// ranges, no medical interpretation of any kind.

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

  const { fileBase64, mediaType } = req.body || {};
  if (!fileBase64 || !mediaType) {
    res.status(400).json({ error: 'Missing required fields: fileBase64, mediaType.' });
    return;
  }

  const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(mediaType)) {
    res.status(400).json({ error: 'Unsupported file type: ' + mediaType });
    return;
  }

  // Rough size guard — base64 is ~33% larger than the original file, and
  // Vercel's default request body limit is a few MB, so we fail clearly
  // rather than let a huge upload hang or get silently rejected.
  if (fileBase64.length > 6_000_000) {
    res.status(413).json({ error: 'File is too large. Please upload a file under about 4MB.' });
    return;
  }

  const systemPrompt = `You are a document-reading assistant embedded in a health app called NutriGap.
You will be shown an image or PDF of a lab or medical report. Your ONLY job is to extract values that are explicitly printed in the document — nothing else.

Rules you must follow without exception:
- Extract only tests/markers that have an explicit value printed in the document. Never infer, estimate, or guess a value that isn't printed.
- For each marker, extract: "name" (as printed), "value" (as printed, including its unit if attached), "unit" (separately, if identifiable), and "referenceRange" EXACTLY as printed for that marker.
- If no reference range is printed for a given marker, set "referenceRange" to null. NEVER supply a reference range from general medical knowledge — only use what is printed in this specific document.
- Set "flag" to "Low", "Normal", or "High" ONLY by comparing the printed value against the printed reference range for that same marker. If no reference range is printed, "flag" MUST be "Unknown" — do not use outside knowledge to guess what's normal.
- Do not diagnose any condition. Do not explain what a marker means medically. Do not speculate on causes. Do not recommend treatment, supplements, or lifestyle changes.
- Do not comment on the person's overall health status or how "concerning" any result is.
- If the document does not appear to be a medical or lab report, set "notAReport" to true and return an empty "markers" array.
- If you can find a report date printed on the document, include it as "reportDate" (as printed); otherwise null.
- If you can find the patient's name printed on the document, include it as "patientName" (as printed); otherwise null. This lets one account keep reports for multiple family members straight.

Respond with ONLY a JSON object — no markdown, no code fences, no commentary before or after — in exactly this shape:
{"notAReport": false, "reportDate": "... or null", "patientName": "... or null", "markers": [{"name": "...", "value": "...", "unit": "... or null", "referenceRange": "... or null", "flag": "Low"}]}`;

  const fileBlock = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: fileBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } };

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
        max_tokens: 8192,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: [
              fileBlock,
              { type: 'text', text: 'Extract the lab values from this report, following your instructions exactly.' },
            ],
          },
        ],
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
      res.status(502).json({
        error: 'Could not parse the AI response as JSON.',
        rawPreview: cleaned.slice(0, 300),
        blockTypes: (data.content || []).map(b => b.type),
      });
      return;
    }

    // Guardrail: force flag to "Unknown" whenever no reference range was
    // extracted, regardless of what the model returned — we never want a
    // Low/Normal/High label appearing without a printed range behind it.
    parsed.markers = (parsed.markers || []).map(m => ({
      ...m,
      flag: m.referenceRange ? m.flag : 'Unknown',
    }));

    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
