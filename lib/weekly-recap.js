// lib/weekly-recap.js
//
// Shared "how was your week" computation for the weekly newsletter
// (api/send-newsletter.js) -- used to build both its Telegram message and
// its email. Reuses the same target/gap math as everywhere else in this
// app (lib/nutrition-core.js) plus the moderate-equivalent-minutes /
// activity-tier math, ported 1:1 from index.html's
// computeModerateEquivalentMinutes()/ACTIVITY_TIERS/classifyActivityLevel()
// -- those three didn't exist server-side anywhere before this feature.
// Telegram's existing /recap command (weeklyRecapReply() in
// api/telegram-webhook.js) only ever showed streak/days-logged/meals-
// tracked, nothing about calorie balance, activity balance, or nutrient
// gaps -- this is new, richer content built specifically for the
// newsletter. /recap itself is deliberately left untouched by this file.
//
// Plain CommonJS, no npm dependencies, same convention as nutrition-core.js
// and supabase-rest.js.

const db = require('./supabase-rest');
const nc = require('./nutrition-core');

// The general 30 min/day CDC/WHO guideline -- same constant and same
// moderate-equivalent-minutes convention (1 vigorous min = 2 moderate min,
// light activity counts at half weight) as index.html's Trends page.
const GENERAL_ACTIVITY_TARGET_MIN = 30;

const ACTIVITY_TIERS = [
  { max: 0, label: 'Sedentary', value: 1.2 },
  { max: 29, label: 'Light', value: 1.375 },
  { max: 59, label: 'Moderate', value: 1.55 },
  { max: 89, label: 'Active', value: 1.725 },
  { max: Infinity, label: 'Very Active', value: 1.9 },
];
function classifyActivityLevel(mem) {
  if (mem <= 0) return ACTIVITY_TIERS[0];
  for (const tier of ACTIVITY_TIERS) { if (mem <= tier.max) return tier; }
  return ACTIVITY_TIERS[ACTIVITY_TIERS.length - 1];
}
function computeModerateEquivalentMinutes(entries) {
  return entries.reduce((sum, e) => {
    const weight = e.intensity === 'vigorous' ? 2 : e.intensity === 'moderate' ? 1 : 0.5;
    return sum + e.duration_minutes * weight;
  }, 0);
}

async function loadProfile(userId) {
  const rows = await db.select('profiles', { columns: '*', filters: ['user_id=eq.' + userId], limit: 1 });
  return (rows && rows[0]) || null;
}

function last7Days() {
  const days = [];
  for (let i = 0; i < 7; i++) days.push(nc.istDateStr(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
  return days.reverse(); // oldest-first, matching the website's trend ordering
}

// Returns null if there's no usable profile to compute targets from (same
// "nothing honest to say yet" skip the daily nudge cron already uses for
// this exact case) -- the caller should leave this person out of the
// newsletter entirely rather than send a recap built on guessed targets.
async function computeWeeklyRecap(userId) {
  const profile = await loadProfile(userId);
  if (!profile || !profile.age || !profile.sex || !profile.height_cm || !profile.weight_kg) return null;
  const tg = nc.computeTargets(profile);

  const days = last7Days();
  const startStr = days[0], endStr = days[days.length - 1];

  const [allDietRows, weekDietRows, weekActivityRows] = await Promise.all([
    db.select('diet_entries', { columns: 'entry_date', filters: ['user_id=eq.' + userId] }),
    db.select('diet_entries', {
      columns: 'entry_date,servings,meal,food_id,meal_box_item_id,foods(*),meal_box_items(*)',
      filters: ['user_id=eq.' + userId, 'entry_date=gte.' + startStr, 'entry_date=lte.' + endStr],
    }),
    db.select('activity_entries', {
      columns: 'entry_date,duration_minutes,calories_burned,activities(intensity)',
      filters: ['user_id=eq.' + userId, 'entry_date=gte.' + startStr, 'entry_date=lte.' + endStr],
    }),
  ]);

  // ---- Streak -- same algorithm as weeklyRecapReply() in
  // api/telegram-webhook.js, duplicated here deliberately rather than
  // imported from there, since that file isn't a requirable module (it's a
  // Vercel handler entrypoint) and this is the second place needing it. ----
  const todayIST = nc.istDateStr(new Date());
  const loggedDates = new Set((allDietRows || []).map(r => r.entry_date));
  let streakCurrent = 0, streakBest = 0;
  if (loggedDates.size > 0) {
    let cursor = new Date();
    if (!loggedDates.has(todayIST)) cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    while (loggedDates.has(nc.istDateStr(cursor))) { streakCurrent++; cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000); }
    const sorted = Array.from(loggedDates).sort();
    let run = 0, prev = null;
    sorted.forEach(d => {
      run = (prev && Math.round((new Date(d) - new Date(prev)) / 86400000) === 1) ? run + 1 : 1;
      streakBest = Math.max(streakBest, run);
      prev = d;
    });
  }

  // ---- Group this week's rows by day. Same orphaned-reference guard as
  // the 2026-10-23 fix in index.html's fetchEntriesRange()/refreshDietLog()
  // -- an embedded foods/meal_box_items/activities that comes back null
  // (a deleted catalog row) is skipped rather than thrown on, so one bad
  // reference can't crash the whole newsletter run for everyone. ----
  const dietByDate = {};
  (weekDietRows || []).forEach(row => {
    const ref = row.meal_box_item_id ? row.meal_box_items : row.foods;
    if (!ref) return;
    const entry = { ...(row.meal_box_item_id ? nc.mapMealBoxRow(ref) : nc.mapFoodRow(ref)), servings: row.servings, meal: row.meal };
    (dietByDate[row.entry_date] = dietByDate[row.entry_date] || []).push(entry);
  });
  const activityByDate = {};
  (weekActivityRows || []).forEach(row => {
    if (!row.activities) return;
    (activityByDate[row.entry_date] = activityByDate[row.entry_date] || []).push({
      duration_minutes: row.duration_minutes, intensity: row.activities.intensity,
    });
  });

  // ---- Calorie balance -- average % of calorie target across days with
  // diet logged this week, same definition as the Trends page's combo
  // chart. ----
  const calDays = Object.keys(dietByDate);
  let avgCalPct = null;
  if (calDays.length) {
    const sum = calDays.reduce((s, d) => {
      const t = nc.totals(dietByDate[d]);
      return s + (tg.kcal ? (t.kcal / tg.kcal) * 100 : 0);
    }, 0);
    avgCalPct = Math.round(sum / calDays.length);
  }

  // ---- Activity balance -- average % vs. the 30-min guideline across days
  // with activity logged this week, plus the week's average activity tier. ----
  const actDays = Object.keys(activityByDate);
  let avgActPct = null, activityTierLabel = null;
  if (actDays.length) {
    const memByDay = actDays.map(d => computeModerateEquivalentMinutes(activityByDate[d]));
    const sum = memByDay.reduce((s, mem) => s + ((mem - GENERAL_ACTIVITY_TARGET_MIN) / GENERAL_ACTIVITY_TARGET_MIN) * 100, 0);
    avgActPct = Math.round(sum / actDays.length);
    const avgMem = memByDay.reduce((s, m) => s + m, 0) / memByDay.length;
    activityTierLabel = classifyActivityLevel(avgMem).label;
  }

  // ---- Recurring nutrient gaps this week -- same algorithm as the
  // Trends page's "Recurring gaps" card: average % of target per nutrient
  // across logged days, flagged if it missed target/limit on at least one
  // of those days, ranked by how many days it missed, top 2 for a short
  // newsletter section rather than the website's full top-5 list. ----
  let topGaps = [];
  if (calDays.length) {
    topGaps = nc.microDefs.map(def => {
      let sum = 0, badCount = 0;
      calDays.forEach(d => {
        const t = nc.totals(dietByDate[d]);
        const pct = tg[def.key] ? (t[def.key] / tg[def.key]) * 100 : 0;
        sum += pct;
        if (def.type === 'limit') { if (t[def.key] > tg[def.key]) badCount++; }
        else if (pct < 90) badCount++;
      });
      return { key: def.key, label: def.label, unit: def.unit, type: def.type, avgPct: Math.round(sum / calDays.length), badCount };
    }).filter(d => d.badCount > 0).sort((a, b) => b.badCount - a.badCount).slice(0, 2);
  }

  return {
    streakCurrent, streakBest,
    loggedDaysThisWeek: calDays.length,
    mealsThisWeek: (weekDietRows || []).length,
    avgCalPct, loggedCalDays: calDays.length,
    avgActPct, loggedActDays: actDays.length, activityTierLabel,
    topGaps,
    hasAnyDataThisWeek: calDays.length > 0 || actDays.length > 0,
  };
}

module.exports = { computeWeeklyRecap };
