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
  totals, gapStatus, rankGapsForInsight, mapFoodRow,
  defaultMealForHour, istDateStr, istHour,
};
