// lib/nutrition-core.js
//
// Shared, server-side port of the exact target/gap math that lives in
// index.html (recalc(), totals(), rankGapsForInsight(), DRI_TABLE, etc.).
// This file has to stay in lockstep with that browser-side copy -- if the
// two drift, a person could see one gap number on the website and a
// different one from the Telegram bot for the same day, which is exactly
// the kind of silent, confusing bug this app works hard to avoid elsewhere.
// If you ever change the target/gap formulas in index.html, mirror the
// change here too.
//
// Plain CommonJS, no npm dependencies -- required directly by the
// serverless functions under api/ with a relative require(), same as any
// other file in the repo. Nothing here talks to the network or a database;
// it's pure computation over whatever profile/entries data the caller
// already fetched.

// ---------- Life-stage-aware nutrient targets (NASEM/NIH DRI tables) ----------
function ageBracket(age) {
  if (age <= 13) return '9-13';
  if (age <= 18) return '14-18';
  if (age <= 30) return '19-30';
  if (age <= 50) return '31-50';
  if (age <= 70) return '51-70';
  return '70+';
}

const DRI_TABLE = {
  female: {
    none: {
      '9-13':  {iron:8,  calcium:1300, vitD:5,  vitB12:1.8, vitC:45, vitA:600, vitE:11, vitK:60, folate:300, vitB6:1.0, magnesium:240, zinc:8, potassium:2300, selenium:40},
      '14-18': {iron:15, calcium:1300, vitD:5,  vitB12:2.4, vitC:65, vitA:700, vitE:15, vitK:75, folate:400, vitB6:1.2, magnesium:360, zinc:9, potassium:2300, selenium:55},
      '19-30': {iron:18, calcium:1000, vitD:5,  vitB12:2.4, vitC:75, vitA:700, vitE:15, vitK:90, folate:400, vitB6:1.3, magnesium:310, zinc:8, potassium:2600, selenium:55},
      '31-50': {iron:18, calcium:1000, vitD:5,  vitB12:2.4, vitC:75, vitA:700, vitE:15, vitK:90, folate:400, vitB6:1.3, magnesium:320, zinc:8, potassium:2600, selenium:55},
      '51-70': {iron:8,  calcium:1200, vitD:10, vitB12:2.4, vitC:75, vitA:700, vitE:15, vitK:90, folate:400, vitB6:1.5, magnesium:320, zinc:8, potassium:2600, selenium:55},
      '70+':   {iron:8,  calcium:1200, vitD:15, vitB12:2.4, vitC:75, vitA:700, vitE:15, vitK:90, folate:400, vitB6:1.5, magnesium:320, zinc:8, potassium:2600, selenium:55},
    },
    pregnant: {
      '9-13':  {iron:27, calcium:1300, vitD:5, vitB12:2.6, vitC:80, vitA:750, vitE:15, vitK:75, folate:600, vitB6:1.9, magnesium:400, zinc:12, potassium:2600, selenium:60},
      '14-18': {iron:27, calcium:1300, vitD:5, vitB12:2.6, vitC:80, vitA:750, vitE:15, vitK:75, folate:600, vitB6:1.9, magnesium:400, zinc:12, potassium:2600, selenium:60},
      '19-30': {iron:27, calcium:1000, vitD:5, vitB12:2.6, vitC:85, vitA:770, vitE:15, vitK:90, folate:600, vitB6:1.9, magnesium:350, zinc:11, potassium:2900, selenium:60},
      '31-50': {iron:27, calcium:1000, vitD:5, vitB12:2.6, vitC:85, vitA:770, vitE:15, vitK:90, folate:600, vitB6:1.9, magnesium:360, zinc:11, potassium:2900, selenium:60},
      '51-70': {iron:27, calcium:1000, vitD:5, vitB12:2.6, vitC:85, vitA:770, vitE:15, vitK:90, folate:600, vitB6:1.9, magnesium:360, zinc:11, potassium:2900, selenium:60},
      '70+':   {iron:27, calcium:1000, vitD:5, vitB12:2.6, vitC:85, vitA:770, vitE:15, vitK:90, folate:600, vitB6:1.9, magnesium:360, zinc:11, potassium:2900, selenium:60},
    },
    lactating: {
      '9-13':  {iron:10, calcium:1300, vitD:5, vitB12:2.8, vitC:115, vitA:1200, vitE:19, vitK:75, folate:500, vitB6:2.0, magnesium:360, zinc:13, potassium:2500, selenium:70},
      '14-18': {iron:10, calcium:1300, vitD:5, vitB12:2.8, vitC:115, vitA:1200, vitE:19, vitK:75, folate:500, vitB6:2.0, magnesium:360, zinc:13, potassium:2500, selenium:70},
      '19-30': {iron:9,  calcium:1000, vitD:5, vitB12:2.8, vitC:120, vitA:1300, vitE:19, vitK:90, folate:500, vitB6:2.0, magnesium:310, zinc:12, potassium:2800, selenium:70},
      '31-50': {iron:9,  calcium:1000, vitD:5, vitB12:2.8, vitC:120, vitA:1300, vitE:19, vitK:90, folate:500, vitB6:2.0, magnesium:320, zinc:12, potassium:2800, selenium:70},
      '51-70': {iron:9,  calcium:1000, vitD:5, vitB12:2.8, vitC:120, vitA:1300, vitE:19, vitK:90, folate:500, vitB6:2.0, magnesium:320, zinc:12, potassium:2800, selenium:70},
      '70+':   {iron:9,  calcium:1000, vitD:5, vitB12:2.8, vitC:120, vitA:1300, vitE:19, vitK:90, folate:500, vitB6:2.0, magnesium:320, zinc:12, potassium:2800, selenium:70},
    }
  },
  male: {
    none: {
      '9-13':  {iron:8,  calcium:1300, vitD:5,  vitB12:1.8, vitC:45, vitA:600, vitE:11, vitK:60,  folate:300, vitB6:1.0, magnesium:240, zinc:8,  potassium:2500, selenium:40},
      '14-18': {iron:11, calcium:1300, vitD:5,  vitB12:2.4, vitC:75, vitA:900, vitE:15, vitK:75,  folate:400, vitB6:1.3, magnesium:410, zinc:11, potassium:3000, selenium:55},
      '19-30': {iron:8,  calcium:1000, vitD:5,  vitB12:2.4, vitC:90, vitA:900, vitE:15, vitK:120, folate:400, vitB6:1.3, magnesium:400, zinc:11, potassium:3400, selenium:55},
      '31-50': {iron:8,  calcium:1000, vitD:5,  vitB12:2.4, vitC:90, vitA:900, vitE:15, vitK:120, folate:400, vitB6:1.3, magnesium:420, zinc:11, potassium:3400, selenium:55},
      '51-70': {iron:8,  calcium:1200, vitD:10, vitB12:2.4, vitC:90, vitA:900, vitE:15, vitK:120, folate:400, vitB6:1.7, magnesium:420, zinc:11, potassium:3400, selenium:55},
      '70+':   {iron:8,  calcium:1200, vitD:15, vitB12:2.4, vitC:90, vitA:900, vitE:15, vitK:120, folate:400, vitB6:1.7, magnesium:420, zinc:11, potassium:3400, selenium:55},
    }
  }
};

// Ported 1:1 from recalc() in index.html. Takes a `profiles` row (the exact
// shape saveProfile()/loadProfile() use) and returns the same `state.targets`
// shape the website computes client-side.
function computeTargets(profile) {
  const age = profile.age || 0;
  const sex = profile.sex || 'male';
  const height = profile.height_cm || 0;
  const weight = profile.weight_kg || 0;
  const activity = profile.activity_level || 1.2;
  const goal = profile.goal || 'maintain';
  const lifeStage = sex === 'female' ? (profile.life_stage || 'none') : 'none';

  const bmr = sex === 'male'
    ? 10 * weight + 6.25 * height - 5 * age + 5
    : 10 * weight + 6.25 * height - 5 * age - 161;
  const activityCals = bmr * activity;
  const goalAdj = { lose: -500, maintain: 0, gain: 300, manage: 0 }[goal] || 0;
  let tdee = Math.round(activityCals + goalAdj);

  if (lifeStage === 'pregnant') tdee += 340;
  if (lifeStage === 'lactating') tdee += 450;

  const proteinFactor = { lose: 1.8, maintain: 1.2, gain: 1.8, manage: 1.1 }[goal] || 1.2;
  let proteinG = Math.round(weight * proteinFactor);
  if (lifeStage === 'pregnant' || lifeStage === 'lactating') proteinG += 25;

  const fatG = Math.round((tdee * 0.25) / 9);
  const carbG = Math.round((tdee - proteinG * 4 - fatG * 9) / 4);
  const fiberG = Math.max(25, Math.round(tdee / 1000 * 14));

  const bracket = ageBracket(age);
  const stageTable = (DRI_TABLE[sex] && (DRI_TABLE[sex][lifeStage] || DRI_TABLE[sex].none)) || DRI_TABLE.male.none;
  const dri = stageTable[bracket] || stageTable['19-30'];

  return {
    kcal: tdee, protein: proteinG, carbs: carbG, fat: fatG, fiber: fiberG,
    iron: dri.iron, calcium: dri.calcium, vitD: dri.vitD, vitB12: dri.vitB12, vitC: dri.vitC,
    vitA: dri.vitA, vitE: dri.vitE, vitK: dri.vitK, folate: dri.folate, vitB6: dri.vitB6,
    magnesium: dri.magnesium, zinc: dri.zinc, potassium: dri.potassium,
    sodium: 2300, selenium: dri.selenium
  };
}

// ---------- Gap math (ported from totals()/gapStatus()/rankGapsForInsight()) ----------
const macroDefs = [
  { key: 'kcal', label: 'Calories', unit: 'kcal' },
  { key: 'protein', label: 'Protein', unit: 'g' },
  { key: 'carbs', label: 'Carbohydrates', unit: 'g' },
  { key: 'fat', label: 'Fat', unit: 'g' },
  { key: 'fiber', label: 'Fiber', unit: 'g' },
];
const microDefs = [
  { key: 'iron', label: 'Iron', unit: 'mg' },
  { key: 'calcium', label: 'Calcium', unit: 'mg' },
  { key: 'vitD', label: 'Vitamin D', unit: 'mcg' },
  { key: 'vitB12', label: 'Vitamin B12', unit: 'mcg' },
  { key: 'vitC', label: 'Vitamin C', unit: 'mg' },
  { key: 'vitA', label: 'Vitamin A', unit: 'mcg' },
  { key: 'vitE', label: 'Vitamin E', unit: 'mg' },
  { key: 'vitK', label: 'Vitamin K', unit: 'mcg' },
  { key: 'folate', label: 'Folate (B9)', unit: 'mcg' },
  { key: 'vitB6', label: 'Vitamin B6', unit: 'mg' },
  { key: 'magnesium', label: 'Magnesium', unit: 'mg' },
  { key: 'zinc', label: 'Zinc', unit: 'mg' },
  { key: 'potassium', label: 'Potassium', unit: 'mg' },
  { key: 'sodium', label: 'Sodium', unit: 'mg', type: 'limit' },
  { key: 'selenium', label: 'Selenium', unit: 'mcg' },
];
const ALL_NUTRIENT_DEFS = [...macroDefs, ...microDefs];
const NUTRIENT_KEYS = ALL_NUTRIENT_DEFS.map(d => d.key);

// entries: array of rows each shaped like a food row (kcal/protein/.../selenium)
// plus a `servings` multiplier -- exactly what refreshDietLog() builds in
// index.html by spreading mapFoodRow(row.foods) and the diet_entries row.
function totals(entries) {
  const t = {};
  NUTRIENT_KEYS.forEach(k => { t[k] = 0; });
  (entries || []).forEach(e => {
    NUTRIENT_KEYS.forEach(k => { t[k] += (e[k] || 0) * (e.servings || 0); });
  });
  return t;
}

function gapStatus(def, consumed, target) {
  if (def.type === 'limit') {
    if (consumed > target) return { cls: 'over', text: '+' + Math.round(consumed - target) + def.unit + ' over limit' };
    return { cls: 'met', text: 'Within limit' };
  }
  const diff = target - consumed;
  if (diff > target * 0.1) return { cls: 'short', text: '−' + Math.round(diff) + def.unit + ' short' };
  if (diff < -target * 0.05) return { cls: 'over', text: '+' + Math.round(-diff) + def.unit + ' over' };
  return { cls: 'met', text: 'On target' };
}

function rankGapsForInsight(t, tg) {
  return ALL_NUTRIENT_DEFS.map(def => {
    const consumed = t[def.key] || 0;
    const target = tg[def.key] || 0;
    const { cls } = gapStatus(def, consumed, target);
    if (cls === 'met') return null;
    const deltaAbs = Math.abs(target - consumed);
    const deltaPct = target > 0 ? deltaAbs / target : 0;
    return {
      key: def.key, label: def.label, unit: def.unit,
      consumed: Math.round(consumed * 10) / 10, target: Math.round(target * 10) / 10,
      direction: cls, deltaPct: Math.round(deltaPct * 1000) / 1000, isLimit: def.type === 'limit'
    };
  }).filter(Boolean).sort((a, b) => b.deltaPct - a.deltaPct);
}

// Ported 1:1 from mapFoodRow() in index.html -- the DB's snake_case
// micronutrient columns (vit_d, vit_b12, ...) to the camelCase keys used
// everywhere else in this file (vitD, vitB12, ...). Any caller reading raw
// rows out of the `foods` table should map them through this before
// passing them to totals()/rankGapsForInsight().
function mapFoodRow(row) {
  return {
    id: row.id,
    name: row.name,
    keywords: row.keywords || [],
    kcal: row.kcal, protein: row.protein, carbs: row.carbs, fat: row.fat, fiber: row.fiber,
    iron: row.iron, calcium: row.calcium,
    vitD: row.vit_d, vitB12: row.vit_b12, vitC: row.vit_c,
    vitA: row.vit_a, vitE: row.vit_e, vitK: row.vit_k,
    folate: row.folate, vitB6: row.vit_b6,
    magnesium: row.magnesium, zinc: row.zinc, potassium: row.potassium,
    sodium: row.sodium, selenium: row.selenium,
    isPartial: false,
  };
}

// Ported 1:1 from mapMealBoxRow() in index.html. meal_box_items only ever
// carries kcal/protein/carbs/fat -- never fiber or any of the 15
// micronutrients. A diet_entries row logged from the meal box
// (meal_box_item_id set instead of food_id) is mapped through this instead
// of mapFoodRow(), with every unknown nutrient explicitly 0 (so totals()
// adds nothing for it rather than fabricating a number) and isPartial:true
// so callers can say plainly that fiber/micronutrients weren't counted for
// it -- see the partial-data note in formatGapSummary() below and the
// equivalent note in index.html's renderGaps().
function mapMealBoxRow(row) {
  return {
    id: row.id,
    name: row.name,
    kcal: row.kcal, protein: row.protein, carbs: row.carbs, fat: row.fat,
    fiber: 0, iron: 0, calcium: 0, vitD: 0, vitB12: 0, vitC: 0,
    vitA: 0, vitE: 0, vitK: 0, folate: 0, vitB6: 0,
    magnesium: 0, zinc: 0, potassium: 0, sodium: 0, selenium: 0,
    isPartial: true,
  };
}

// ---------- Meal-box gap matching ----------
// meal_box_items (BFB's ~1,200-dish subscription menu) is a deliberately
// separate catalog from foods -- never merged into it. It's the website's
// Meal Box tab's "Best for today's gap" mode and this module's Telegram
// equivalent (mealIdeas() in api/telegram-webhook.js): browsable meal
// IDEAS to help close a gap, never something logged as an exact diary
// entry. It only ever carries kcal/protein/carbs/fat, so it can only
// credibly speak to those four -- MEALBOX_COVERED_GAP_LABELS is what
// callers check before claiming a meal-box dish would help with
// anything else (fiber or any vitamin/mineral has no data here at all).
const MEALBOX_COVERED_GAP_LABELS = ['Calories', 'Protein', 'Carbohydrates', 'Fat'];

// BFB's menu spreadsheet has known decimal-point-lost rows (see
// meal_box_carbs_decimal_fix.sql -- "7544" meaning "75.44", caught for 12
// dishes so far, with at least 2 more of the same kind of bug still
// unfixed in the source data as of Oct 2026). Rather than wait on every
// individual dish being hand-corrected in Supabase, no suggestion ever
// shows a dish whose own listed macros are physically implausible for a
// single serving -- these thresholds are deliberately generous (no real
// dish serving exceeds them) so this only ever catches corrupted data,
// never a legitimately large meal.
function hasPlausibleMacros(d) {
  return (d.protein || 0) <= 150 && (d.carbs || 0) <= 250 && (d.fat || 0) <= 150;
}

// `remaining` is {kcal, protein, carbs, fat}, already clamped to >= 0 by
// the caller. `items` is raw meal_box_items rows. Returns the items that
// fit within remaining calories (15% tolerance), scored and sorted by how
// much of what's left of protein/carbs/fat each one alone would cover --
// identical scoring to the website's renderMealBoxesGap(), so the two
// channels never rank the same numbers differently.
function rankMealBoxForGap(remaining, items) {
  const kcalCeiling = (remaining.kcal || 0) * 1.15;
  const candidates = (items || []).filter(d => Number.isFinite(d.kcal) && d.kcal <= kcalCeiling && hasPlausibleMacros(d));
  candidates.forEach(d => {
    let score = 0;
    if (remaining.protein > 0) score += (d.protein || 0) / remaining.protein;
    if (remaining.carbs > 0) score += (d.carbs || 0) / remaining.carbs;
    if (remaining.fat > 0) score += (d.fat || 0) / remaining.fat;
    d.__score = score;
  });
  candidates.sort((a, b) => b.__score - a.__score);
  return candidates;
}

// When today's real biggest gap is something meal_box_items can't see
// (fiber or a micronutrient), this ranks the verified `foods` catalog by
// how much of that ONE nutrient each food alone would cover -- same
// "spotlight" approach as the website's renderMealBoxFoodFallback(), so a
// suggestion is never a vague blend across everything. `foods` must
// already be mapFoodRow()-mapped. Returns null if there's no non-limit
// gap to spotlight (e.g. everything left is an over-limit nutrient like
// sodium, which eating more food can't fix).
function pickFoodFallbackForGap(t, tg, foods, rankedGaps) {
  const remainingAll = {};
  ALL_NUTRIENT_DEFS.forEach(def => {
    if (def.type === 'limit') return;
    remainingAll[def.key] = Math.max(0, (tg[def.key] || 0) - (t[def.key] || 0));
  });
  const spotlightGap = (rankedGaps || []).find(g => !g.isLimit);
  if (!spotlightGap) return null;
  const spotlightDef = ALL_NUTRIENT_DEFS.find(d => d.label === spotlightGap.label);
  if (!spotlightDef) return null;
  const spotlightKey = spotlightDef.key;

  const candidates = (foods || []).filter(f => (f[spotlightKey] || 0) > 0);
  candidates.forEach(f => { f.__fallbackScore = (f[spotlightKey] || 0) / (remainingAll[spotlightKey] || 1); });
  candidates.sort((a, b) => b.__fallbackScore - a.__fallbackScore);
  return { spotlightGap, spotlightDef, remainingAll, top: candidates.slice(0, 3) };
}

// Same idea as pickFoodFallbackForGap, but for when the person asked about
// ONE specific nutrient by name (e.g. "vitamin K") rather than whatever
// today's single biggest gap happens to be. Ranks the verified `foods`
// catalog by how much of that exact nutrient each food alone would cover.
// Returns null for a nutrient that isn't a real gap-trackable field (a bad
// key) or that's a "limit" nutrient (sodium, etc. -- eating more food can't
// help close an over-limit gap, so there's nothing to rank).
function pickFoodFallbackForNutrient(t, tg, foods, nutrientKey) {
  const def = ALL_NUTRIENT_DEFS.find(d => d.key === nutrientKey);
  if (!def || def.type === 'limit') return null;

  const consumed = t[nutrientKey] || 0;
  const target = tg[nutrientKey] || 0;
  const remaining = Math.max(0, target - consumed);
  const { cls } = gapStatus(def, consumed, target);

  const candidates = (foods || []).filter(f => (f[nutrientKey] || 0) > 0);
  candidates.forEach(f => { f.__fallbackScore = (f[nutrientKey] || 0) / (remaining || 1); });
  candidates.sort((a, b) => b.__fallbackScore - a.__fallbackScore);

  return {
    def,
    consumed: Math.round(consumed * 10) / 10,
    target: Math.round(target * 10) / 10,
    remaining,
    met: cls === 'met',
    top: candidates.slice(0, 3),
  };
}

// Same day-part buckets as setDefaultMeal() in index.html, so a meal
// logged via Telegram with no explicit meal named falls into the same
// breakfast/lunch/snack/dinner bucket the website would default to at
// that time of day. Takes an hour-of-day (0-23) in whatever timezone the
// caller has already converted to (see toISTDateStr/istHour below).
function defaultMealForHour(hour) {
  if (hour < 11) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 18) return 'snack';
  return 'dinner';
}

// NutriGap's users are BFB's customers, all in India -- rather than depend
// on the server's ICU/timezone data being available and correctly
// configured, use a fixed +05:30 offset (India Standard Time has no DST,
// so this is always correct, not just usually).
const IST_OFFSET_MINUTES = 5 * 60 + 30;

function toIST(date) {
  return new Date(date.getTime() + IST_OFFSET_MINUTES * 60000);
}

function istDateStr(date) {
  const ist = toIST(date || new Date());
  return ist.toISOString().slice(0, 10);
}

function istHour(date) {
  return toIST(date || new Date()).getUTCHours();
}

module.exports = {
  ageBracket, DRI_TABLE, computeTargets,
  macroDefs, microDefs, ALL_NUTRIENT_DEFS, NUTRIENT_KEYS,
  totals, gapStatus, rankGapsForInsight, mapFoodRow, mapMealBoxRow,
  MEALBOX_COVERED_GAP_LABELS, rankMealBoxForGap, pickFoodFallbackForGap,
  pickFoodFallbackForNutrient,
  defaultMealForHour, istDateStr, istHour,
};
