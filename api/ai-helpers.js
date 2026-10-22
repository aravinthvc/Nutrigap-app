// api/ai-helpers.js
//
// Combines several small, website-only Claude helper endpoints into one
// file to stay under Vercel's 12-serverless-function cap on the Hobby
// plan: explaining an unfamiliar lab marker, suggesting recipe ideas
// from a short food list, describing what's on a meal photo, reading the
// nutrition panel off a packaged-food photo, reading a dietary
// supplement's label, and (new) reviewing a submitted scan for promotion
// into the shared catalog. All were already simple, single-call-to-Claude
// POST handlers with no shared state and no external callers (unlike the
// Telegram/OAuth endpoints, which stay as their own files) — good merge
// candidates, EXCEPT review-submission, which -- uniquely among the kinds
// in this file -- also needs direct (service-role) database access to act
// on its own verdict; see that section below for why that's safe. Routed
// by `kind` in the POST body: 'explain-marker' | 'recipe-ideas' |
// 'photo-log' | 'packaged-food-scan' | 'supplement-scan' |
// 'review-submission'.
//
// The first three are unchanged from the original separate files -- see
// api/explain-marker.js, api/recipe-ideas.js, and api/photo-log.js in git
// history for the pre-merge originals. packaged-food-scan,
// supplement-scan, and review-submission are new.

const db = require('../lib/supabase-rest');

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

// ---------- supplement-scan (new) ----------
//
// Same facts-only discipline as packaged-food-scan, applied to a dietary
// supplement label (gummy, protein powder, capsule, etc.) instead of a
// food package. Supplement labels taught us (from real examples Aravinth
// shared) that they differ from food labels in ways that matter for
// safety, not just cosmetics:
//
// 1. The printed %RDA column is near-useless and potentially misleading --
//    it's calculated against whatever demographic the label happened to
//    pick (seen so far: "Children 1-3 years", "Women's Sedentary Work"),
//    never the actual person logging it. So this extraction NEVER asks
//    for or stores a %RDA -- only the absolute per-serving amount, same
//    units as packaged-food-scan. NutriGap's own gap engine is what turns
//    that into a real percentage, against the real logged-in person.
// 2. Supplement labels routinely carry real printed facts that don't fit
//    a fixed nutrient-column schema: proprietary/compound ingredient
//    blends with one combined weight for several named ingredients,
//    probiotic counts in Billion CFU, enzyme blends, amino-acid subtotals
//    (EAA/BCAA/NEAA groups with named-but-not-individually-quantified
//    members), and bioactives with a printed amount but no established
//    RDA (Curcumin, Myo-Inositol, Algal DHA). None of those are numbers
//    we can safely force into a fixed field -- splitting a blend's total
//    weight across its named ingredients would be a guess wearing a
//    number's clothes, exactly the thing this whole feature exists to
//    avoid. So (per the "lean V1" scope) they all land in one free-text
//    "labelNotes" field, copied close to verbatim, instead of fifteen new
//    speculative structured fields.
// 3. Usage/timing instructions are safety-relevant and label-specific --
//    "eat 1 gummy daily", "consume within 15 minutes of mixing", "use
//    within 5 weeks of opening", age restrictions, pregnancy/medical
//    disclaimers -- also folded into labelNotes for V1 rather than their
//    own fields, per the same lean-V1 choice.

async function handleSupplementScan(req, res, apiKey){
  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64) {
    res.status(400).json({ error: 'Missing required field: imageBase64.' });
    return;
  }

  const systemPrompt = `You are a label-reading assistant embedded in a health app called NutriGap.
You will be shown a photo of a dietary supplement's label (a gummy, protein powder, capsule, tablet, or similar -- not an ordinary packaged food). Your ONLY job is to extract what is explicitly printed -- nothing else.

Rules you must follow without exception:
- Extract only values that are explicitly printed on the label. Never infer, estimate, or guess a value that isn't printed -- if a field isn't stated anywhere on the label, set it to null. This applies to every nutrient, including vitamins and minerals.
- NEVER extract or report a %RDA / %DV / %RDI percentage for anything -- only the absolute per-serving amount (e.g. "20 mg", not "66%"). Supplement labels calculate their %RDA against whatever population they chose (children, sedentary adult women, etc.), which is almost never the person actually using this app, so that percentage would be actively misleading if stored or shown. If a sentence on the label explains what population/activity level the %RDA is based on (e.g. "as per ICMR 2020 guidelines for Women's Sedentary Work"), copy that sentence into labelNotes for the record, but never use it to compute or report a percentage yourself.
- "servingSizeText" is the serving size exactly as printed (e.g. "1 gummy (approx 3.4g)", "2 scoops (34g)", "1 capsule"). All the nutrient numbers you extract must be the values for that same stated serving -- if the label shows both a per-100g and a per-serving column, use the per-serving column.
- Report every amount in these exact units, converting if the label uses a different one (standard conversions, e.g. IU -> mcg for vitamin A/D using the standard factor for that vitamin's form): kcal in kcal; protein/carbs/fat/fiber in grams (g); sodium/calcium/iron/magnesium/zinc/potassium/vitamin C/vitamin E/vitamin B6 in milligrams (mg); vitamin D/vitamin B12/vitamin A/vitamin K/folate/selenium in micrograms (mcg). If you can't convert a printed unit to the required one with confidence, leave that field null rather than guess at the conversion.
- Many real supplement labels print nutrients that don't fit the fixed list above at all -- a full B-complex (B1/B2/B3/B5/B7), proprietary or compound ingredient blends with one combined weight for several named ingredients, probiotics in Billion CFU, enzyme blends, amino-acid subtotals (EAA/BCAA/NEAA groups), or bioactives with a printed amount but no established RDA (Curcumin, Myo-Inositol, Algal DHA, etc.). Do not force any of these into the fixed numeric fields and do not try to split a combined/blend weight across its named ingredients -- that would be a guess, not a fact. Instead, write each one as a short line in "labelNotes", exactly as printed (name and amount/unit), e.g. "Curcumin 95% - 5 mg (no RDA established)" or "Proprietary blend 100mg: Pomegranate, Apple, Beetroot, Spinach, Carrot".
- Also capture in "labelNotes", each as its own short line, anything else safety- or usage-relevant that's printed: dosing/usage instructions (e.g. "Eat 1 gummy daily"), any freshness or timing window (e.g. "consume within 15 minutes of mixing", "use within 5 weeks of opening"), age restrictions, and pregnancy/medical-condition disclaimers. Do not editorialize or add advice of your own -- copy what's printed, close to verbatim.
- "productName" and "brand" should be read from the packaging if visible in the photo; set either to null if not visible (the person will be asked to confirm or fill these in regardless).
- "ingredientsText" is the ingredients list exactly as printed, if visible; otherwise null.
- If the photo doesn't show a dietary supplement's label at all, set "notASupplementLabel" to true and leave every other field null/empty.

Respond with ONLY a JSON object -- no markdown, no code fences, no commentary -- in exactly this shape:
{"notASupplementLabel": false, "productName": "... or null", "brand": "... or null", "servingSizeText": "... or null", "kcal": 0, "protein": 0, "carbs": 0, "fat": 0, "fiber": null, "sodium": null, "iron": null, "calcium": null, "vitD": null, "vitB12": null, "vitC": null, "vitA": null, "vitE": null, "vitK": null, "folate": null, "vitB6": null, "magnesium": null, "zinc": null, "potassium": null, "selenium": null, "ingredientsText": "... or null", "labelNotes": "... or null"}`;

  try {
    const rawText = await callClaude(apiKey, {
      system: systemPrompt, maxTokens: 1800,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: "Extract this supplement label's information, following your instructions exactly." },
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

    // Same cheap insurance as packaged-food-scan: coerce anything that
    // isn't a finite number to null rather than passing it through.
    const NUMERIC_FIELDS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sodium',
      'iron', 'calcium', 'vitD', 'vitB12', 'vitC', 'vitA', 'vitE', 'vitK', 'folate', 'vitB6',
      'magnesium', 'zinc', 'potassium', 'selenium'];
    NUMERIC_FIELDS.forEach(f => {
      parsed[f] = Number.isFinite(parsed[f]) ? parsed[f] : null;
    });
    parsed.labelNotes = (typeof parsed.labelNotes === 'string' && parsed.labelNotes.trim())
      ? parsed.labelNotes.trim()
      : null;
    parsed.notASupplementLabel = !!parsed.notASupplementLabel;

    res.status(200).json(parsed);
  } catch (e) {
    if (e.isClaudeError) { res.status(502).json({ error: e.message }); return; }
    res.status(500).json({ error: e.message });
  }
}

// ---------- review-submission (new) ----------
//
// Replaces Aravinth manually running an approval query for every packaged-
// food/supplement scan with an automated check, per his explicit choice:
// auto-approve a clean submission into the shared catalog immediately, and
// immediately reject a doubtful one with a specific reason so the person
// can fix it and rescan -- no queue, no waiting on a human either way.
//
// This is a VERIFICATION pass, not a second extraction: it's shown the
// same photo again, told what the person actually saved (which may have
// been hand-edited in the review panel after the original scan), and
// asked whether that saved data is actually supported by what's printed.
// This is the one real gap a first extraction pass can't close on its
// own -- the confirm-before-save screen lets someone fix a misread value,
// but nothing previously caught someone fixing it to the WRONG value, by
// mistake or otherwise. Re-checking against the photo, fresh, after
// saving, closes that gap without adding a second human reviewer.
//
// This only ever makes a binary call -- approve or reject -- never a
// third "still pending" outcome from a successful review, matching the
// scope Aravinth chose. If the Claude call itself fails for an
// infrastructure reason (not a data-quality judgment), the row is left
// exactly as it was (`review_status` untouched) rather than guessing --
// see the catch block below. That also means `review_status: 'pending'`
// still exists as a safety-net state, reachable only when review itself
// couldn't run, and still visible to a manual admin check if one is ever
// needed, same query as before this feature existed.
//
// Security note: this is the ONLY kind in this file that touches the
// database, and on purpose -- the `foods` table's INSERT policy (see
// add_packaged_food_scanning.sql) only ever lets the browser insert a row
// owned by itself with review_status='pending'; there is deliberately NO
// update policy for the `authenticated` role at all, so the browser
// itself cannot flip a row to 'approved' (which also clears
// owner_user_id, promoting it into everyone's shared catalog) or even to
// 'rejected'. Only this endpoint can, because only it holds the
// service-role key (via lib/supabase-rest.js, same pattern
// api/telegram-webhook.js already uses) -- so a submission reaching the
// shared catalog always required an actual Claude verdict against the
// actual stored photo, never a client-asserted "trust me".

async function handleReviewSubmission(req, res, apiKey){
  const { foodId, productType, imageBase64, mediaType, submitted } = req.body || {};
  if (!foodId || !imageBase64 || !submitted || typeof submitted !== 'object') {
    res.status(400).json({ error: 'Missing required field(s): foodId, imageBase64, submitted.' });
    return;
  }
  const isSupplement = productType === 'supplement';

  const submittedSummary = JSON.stringify({
    productName: submitted.name || null,
    brand: submitted.brand || null,
    servingSizeText: submitted.servingSizeText || null,
    kcal: submitted.kcal, protein: submitted.protein, carbs: submitted.carbs, fat: submitted.fat, fiber: submitted.fiber,
    sodium: submitted.sodium, iron: submitted.iron, calcium: submitted.calcium, vitD: submitted.vitD, vitB12: submitted.vitB12,
    vitC: submitted.vitC, vitA: submitted.vitA, vitE: submitted.vitE, vitK: submitted.vitK, folate: submitted.folate,
    vitB6: submitted.vitB6, magnesium: submitted.magnesium, zinc: submitted.zinc, potassium: submitted.potassium, selenium: submitted.selenium,
    ingredientsText: submitted.ingredientsText || null,
    otherNotes: isSupplement ? (submitted.labelNotes || null) : (submitted.unquantifiedAdditives || []),
  }, null, 2);

  const systemPrompt = `You are a quality-control reviewer embedded in a health app called NutriGap. A user photographed a ${isSupplement ? "dietary supplement's" : "packaged food's"} label, an earlier AI pass extracted its nutrition facts, and the user then reviewed and could freely edit every value before saving. Your job is to check, against the SAME photo, whether what they actually saved is genuinely supported by what's printed -- catching either a bad original read or a bad manual edit, since both look identical by the time you see them.

You will be shown the photo again and told exactly what was saved. Decide "approved" or "rejected" -- there is no third option. When genuinely unsure, choose "rejected": a doubtful submission should never silently join the shared catalog everyone else sees, and rejecting is cheap -- the person just rescans.

Reject when:
- Any saved numeric value clearly disagrees with what's printed -- a materially different number, a misplaced decimal point, or a different unit than what the label actually shows. Minor differences consistent with ordinary rounding are fine; a value that's off by a large margin, or present when the label shows nothing for it, is not.
- The saved serving size doesn't match what's printed.
- The product name or brand looks like spam, gibberish, a placeholder ("test", "asdf"), offensive, or clearly doesn't match the product actually shown in the photo.
${isSupplement ? '- Any saved numeric field looks like it could be a %RDA/%DV percentage rather than an absolute amount (e.g. a suspiciously round number like 50, 66, 100 sitting where a specific milligram amount should be, with no matching printed amount) -- this app never stores that percentage.' : '- The saved calories are wildly inconsistent with the saved protein/carb/fat grams (roughly: kcal should be in the neighborhood of 4×protein + 4×carbs + 9×fat; only flag a real, large mismatch, and only when protein, carbs, and fat are all present -- don\'t penalize a null/missing field, and allow generous slack for fiber, sugar alcohols, and rounding).'}
- The photo doesn't actually show a legible ${isSupplement ? 'supplement' : 'food'} label at all.

Do NOT reject just because a field is null/missing -- an honest gap is correct behavior, never a reason to reject. Do NOT reject over a stylistic or formatting difference that doesn't change the actual facts.

If you reject, "reason" must be one short, specific, actionable sentence naming exactly what's wrong (e.g. "The label shows Vitamin C as 40 mg but 400 mg was saved" or "Calories (450) don't reconcile with the saved protein/carb/fat"), so the person knows exactly what to fix before rescanning. If you approve, "reason" should be null.

Respond with ONLY a JSON object -- no markdown, no code fences, no commentary -- in exactly this shape:
{"verdict": "approved", "reason": null}
or
{"verdict": "rejected", "reason": "..."}

Here is what was saved, to check against the photo:
${submittedSummary}`;

  let parsed;
  try {
    const rawText = await callClaude(apiKey, {
      system: systemPrompt, maxTokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: 'Check the saved data above against this photo, following your instructions exactly.' },
        ],
      }],
    });
    const cleaned = extractJson(rawText);
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Couldn't parse a verdict -- this is an infrastructure/format
      // failure, not a quality judgment, so leave review_status alone
      // (still 'pending') rather than guessing either way.
      res.status(502).json({ error: 'Could not parse the AI review response as JSON.', rawPreview: cleaned.slice(0, 300) });
      return;
    }
  } catch (e) {
    if (e.isClaudeError) { res.status(502).json({ error: e.message }); return; }
    res.status(500).json({ error: e.message });
    return;
  }

  const approved = parsed.verdict === 'approved';
  const reason = (!approved && typeof parsed.reason === 'string' && parsed.reason.trim()) ? parsed.reason.trim() : null;

  try {
    if (approved) {
      await db.update('foods', ['id=eq.' + encodeURIComponent(foodId), 'review_status=eq.pending'], {
        owner_user_id: null,
        review_status: 'approved',
        review_notes: reason, // null on approval, per the prompt above
        reviewed_at: new Date().toISOString(),
      });
    } else {
      await db.update('foods', ['id=eq.' + encodeURIComponent(foodId), 'review_status=eq.pending'], {
        review_status: 'rejected',
        review_notes: reason,
        reviewed_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    // The verdict was reached but couldn't be written -- report this as
    // its own distinct failure rather than claiming the verdict applied
    // when it didn't; the row stays 'pending' in the database either way,
    // so nothing was silently approved or silently rejected.
    res.status(502).json({ error: 'Reached a verdict but could not save it: ' + e.message, verdict: parsed.verdict, reason });
    return;
  }

  res.status(200).json({ verdict: approved ? 'approved' : 'rejected', reason });
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
  if (kind === 'supplement-scan') return handleSupplementScan(req, res, apiKey);
  if (kind === 'review-submission') return handleReviewSubmission(req, res, apiKey);
  res.status(400).json({ error: 'Missing or invalid kind (expected "explain-marker", "recipe-ideas", "photo-log", "packaged-food-scan", "supplement-scan", or "review-submission").' });
};
