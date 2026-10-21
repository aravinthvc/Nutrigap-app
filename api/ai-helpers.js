// api/ai-helpers.js
//
// Combines several small, website-only Claude helper endpoints into one
// file to stay under Vercel's 12-serverless-function cap on the Hobby
// plan: explaining an unfamiliar lab marker, suggesting recipe ideas
// from a short food list, describing what's on a meal photo, and (new)
// reading the nutrition panel off a packaged-food photo. All were already
// simple, single-call-to-Claude POST handlers with no shared state and no
// external callers (unlike the Telegram/OAuth endpoints, which stay as
// their own files) — good merge candidates. Routed by `kind` in the POST
// body: 'explain-marker' | 'recipe-ideas' | 'photo-log' | 'packaged-food-scan'.
//
// The first three are unchanged from the original separate files -- see
// api/explain-marker.js, api/recipe-ideas.js, and api/photo-log.js in git
// history for the pre-merge originals. packaged-food-scan is new.

async function callClaude(apiKey, { system, maxTokens, messages }){
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    const err = new Error('Claude API error: ' + errText);
    err.isClaudeError = true;
    throw err;
  }
  const data = await response.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return ((textBlock && textBlock.text) || '');
}

function extractJson(rawText){
  let cleaned = rawText.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
  return cleaned;
}

// ---------- explain-marker (formerly api/explain-marker.js) ----------
//
// General, textbook-level education about what a lab test measures and its
// general significance — used only as a fallback for markers not already
// covered by the app's static library (see MARKER_EDUCATION in index.html).
// The frontend caches every result in the `marker_explanations` table so
// each unusual test name is only ever explained once, for anyone, not once
// per person per view.

async function handleExplainMarker(req, res, apiKey){
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
    const rawText = await callClaude(apiKey, { system: systemPrompt, maxTokens: 500, messages: [{ role: 'user', content: userPrompt }] });
    const cleaned = extractJson(rawText);
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({ error: 'Could not parse the AI response as JSON.', rawPreview: cleaned.slice(0, 300) });
      return;
    }
    res.status(200).json(parsed);
  } catch (e) {
    if (e.isClaudeError) { res.status(502).json({ error: e.message }); return; }
    res.status(500).json({ error: e.message });
  }
}

// ---------- recipe-ideas (formerly api/recipe-ideas.js) ----------
//
// Turns a short list of real foods from the app's own database into a
// couple of simple recipe ideas. This is plain cooking content — no
// nutrition claims, no medical framing — used from the "Notes for your
// dietitian" section as an optional, user-triggered extra.

async function handleRecipeIdeas(req, res, apiKey){
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
    const rawText = await callClaude(apiKey, { system: systemPrompt, maxTokens: 1200, messages: [{ role: 'user', content: userPrompt }] });
    const cleaned = extractJson(rawText);
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({ error: 'Could not parse the AI response as JSON.', rawPreview: cleaned.slice(0, 300) });
      return;
    }
    res.status(200).json(parsed);
  } catch (e) {
    if (e.isClaudeError) { res.status(502).json({ error: e.message }); return; }
    res.status(500).json({ error: e.message });
  }
}

// ---------- photo-log (formerly api/photo-log.js) ----------
//
// Turns a photo of a plate into a plain-language description — nothing
// more. It never estimates nutrition itself and never tries to match
// against the app's food database; it only describes what's visible, the
// same way a person would say it out loud. That description then runs
// through the exact same client-side transcript parser used for typed and
// spoken entries, so the reviewable-checklist safety net is identical
// regardless of how the food was described.

async function handlePhotoLog(req, res, apiKey){
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
    const description = (await callClaude(apiKey, {
      system: systemPrompt, maxTokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: 'What food is on this plate?' },
        ],
      }],
    })).trim();
    res.status(200).json({ description });
  } catch (e) {
    if (e.isClaudeError) { res.status(502).json({ error: e.message }); return; }
    res.status(500).json({ error: e.message });
  }
}

// ---------- packaged-food-scan (new) ----------
//
// Reads the nutrition panel (and ingredients list) off a photo of a
// packaged/retail food's label and extracts ONLY what's explicitly
// printed -- same "facts only, never infer" discipline as
// api/read-report.js uses for medical reports, applied to a food label
// instead of a lab report. Every numeric field is either a number that
// was actually printed somewhere on the label, or null -- the caller
// (index.html) shows the user every extracted value before anything is
// saved, same confirm-before-logging principle as the meal-photo flow,
// specifically so a misread number gets caught before it becomes part of
// someone's real nutrition data.
//
// This deliberately does NOT try to estimate a micronutrient from the
// ingredients list the way a food-composition database would (e.g.
// inferring vitamin C because an ingredient is "orange juice concentrate")
// -- an ingredients list has no quantities, so that would be a guess
// wearing a number's clothes, not a fact. The one thing it DOES pull from
// the ingredients list is an explicit fortification claim with no printed
// amount (e.g. "added Vitamin B12") -- that's reported separately, as a
// named-but-unquantified note, never folded into a numeric value.

async function handlePackagedFoodScan(req, res, apiKey){
  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64) {
    res.status(400).json({ error: 'Missing required field: imageBase64.' });
    return;
  }

  const systemPrompt = `You are a label-reading assistant embedded in a health app called NutriGap.
You will be shown a photo of a packaged/retail food's label (nutrition panel, and usually an ingredients list and the product name/brand). Your ONLY job is to extract what is explicitly printed -- nothing else.

Rules you must follow without exception:
- Extract only values that are explicitly printed on the label. Never infer, estimate, or guess a value that isn't printed -- if a field isn't stated anywhere on the label, set it to null. This applies to every nutrient, including vitamins and minerals.
- If the ingredients list names an added vitamin/mineral/fortificant with NO quantity printed anywhere (e.g. "added Vitamin B12" with no mg/mcg stated), do not invent a number for it -- instead add its name (as printed) to "unquantifiedAdditives". Never estimate a micronutrient amount from an ingredient's mere presence (e.g. never estimate vitamin C because an ingredient is "orange juice concentrate") -- ingredient lists carry no quantities, so that would be a guess, not a fact.
- "servingSizeText" is the serving size exactly as printed (e.g. "30g (about 1/4 cup)"). All the nutrient numbers you extract must be the values for that same stated serving -- if the label shows both a per-100g and a per-serving column, use the per-serving column; if only a per-100g column exists, say so by setting servingSizeText to "100g" and use that column.
- Report every amount in these exact units, converting if the label uses a different one (standard conversions, e.g. IU -> mcg for vitamin A/D using the standard factor for that vitamin's form): kcal in kcal; protein/carbs/fat/fiber in grams (g); sodium/calcium/iron/magnesium/zinc/potassium/vitamin C/vitamin E/vitamin B6 in milligrams (mg); vitamin D/vitamin B12/vitamin A/vitamin K/folate/selenium in micrograms (mcg). If you can't convert a printed unit to the required one with confidence, leave that field null rather than guess at the conversion.
- "productName" and "brand" should be read from the packaging if visible in the photo; set either to null if not visible (the person will be asked to confirm or fill these in regardless).
- "ingredientsText" is the ingredients list exactly as printed, if visible; otherwise null.
- If the photo doesn't show a food package's nutrition label at all, set "notAFoodLabel" to true and leave every other field null/empty.

Respond with ONLY a JSON object -- no markdown, no code fences, no commentary -- in exactly this shape:
{"notAFoodLabel": false, "productName": "... or null", "brand": "... or null", "servingSizeText": "... or null", "kcal": 0, "protein": 0, "carbs": 0, "fat": 0, "fiber": null, "sodium": null, "iron": null, "calcium": null, "vitD": null, "vitB12": null, "vitC": null, "vitA": null, "vitE": null, "vitK": null, "folate": null, "vitB6": null, "magnesium": null, "zinc": null, "potassium": null, "selenium": null, "ingredientsText": "... or null", "unquantifiedAdditives": []}`;

  try {
    const rawText = await callClaude(apiKey, {
      system: systemPrompt, maxTokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: "Extract this food label's nutrition information, following your instructions exactly." },
        ],
      }],
    });
    const cleaned = extractJson(rawText);
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({ error: 'Could not parse the AI response as JSON.', rawPreview: cleaned.slice(0, 300) });
      return;
    }

    // Guardrail: never trust a non-numeric value through as a number (the
    // model should only ever emit a real number or null per the prompt
    // above, but this is cheap insurance against a stray string slipping
    // through) -- coerce anything that isn't a finite number to null
    // rather than silently passing through something unusable.
    const NUMERIC_FIELDS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sodium',
      'iron', 'calcium', 'vitD', 'vitB12', 'vitC', 'vitA', 'vitE', 'vitK', 'folate', 'vitB6',
      'magnesium', 'zinc', 'potassium', 'selenium'];
    NUMERIC_FIELDS.forEach(f => {
      parsed[f] = Number.isFinite(parsed[f]) ? parsed[f] : null;
    });
    parsed.unquantifiedAdditives = Array.isArray(parsed.unquantifiedAdditives)
      ? parsed.unquantifiedAdditives.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim())
      : [];

    res.status(200).json(parsed);
  } catch (e) {
    if (e.isClaudeError) { res.status(502).json({ error: e.message }); return; }
    res.status(500).json({ error: e.message });
  }
}

// ---------- dispatch ----------

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

  const { kind } = req.body || {};
  if (kind === 'explain-marker') return handleExplainMarker(req, res, apiKey);
  if (kind === 'recipe-ideas') return handleRecipeIdeas(req, res, apiKey);
  if (kind === 'photo-log') return handlePhotoLog(req, res, apiKey);
  if (kind === 'packaged-food-scan') return handlePackagedFoodScan(req, res, apiKey);
  res.status(400).json({ error: 'Missing or invalid kind (expected "explain-marker", "recipe-ideas", "photo-log", or "packaged-food-scan").' });
};
