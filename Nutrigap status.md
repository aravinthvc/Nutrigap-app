---
description: NutriGap / NutriGap_Bot build status — what's shipped, what's pending, what the user needs to do next. Read before resuming work on this project.
---

# NutriGap status (as of 2026-10-06)

Stack: Vercel serverless functions (`api/*.js`, CommonJS, no framework) + Supabase (Postgres + RLS). No local dev tooling — Aravinth deploys by copy-pasting files into Vercel/GitHub and SQL into the Supabase SQL editor. Telegram bot (`NutriGap_Bot`, webhook at `api/telegram-webhook.js`) is a second channel onto the same account/data as the website (`index.html`).

## Architecture decision: `foods` and `meal_box_items` stay separate (2026-10-06)

`foods` is the clean, fully-verified personal diet-logging catalog (always-complete macro + micronutrient data). `meal_box_items` is BFB's ~1,200-dish subscription menu — separate table, macro-only (kcal/protein/carbs/fat), used for meal-idea suggestions AND (new, see below) honest partial logging. This was Aravinth's explicit call after watching an attempt to import BFB dishes into `foods` turn into three rounds of schema fights — mixing a messy, macro-only subscription menu into a catalog that's always assumed complete data was the wrong model, not a solvable bug.

## Pre-existing data leak found and still needs cleanup: BFB dishes already inside `foods`

While checking whether the architecture decision above was actually holding, Aravinth spotted BFB-style dish names (Ragi roti, Apple banana date salad with cream, Bajra roti, Ash gourd soup, ...) in the website's food-search/logging dropdown — not the Meal Box tab. Diagnostic query confirmed: **47 rows** in `foods` share a name with a `meal_box_items` dish and are missing fiber + all micronutrients (`NULL`). These predate this session entirely — my earlier abandoned 47-row import batch never committed (verified via Postgres statement atomicity) and only covered soups/salads, which doesn't explain entries like "Bajra roti". Likely an older bulk import from before the architecture decision was made.

**Not yet cleaned up.** The 47 rows are still live and still searchable/loggable as if they were complete foods — this is the actual "Ragi roti still visible" bug, worse than it first looked (2 rows → 47). Next step: decide whether to delete them outright (since the new "Log this" meal-box flow below now covers the same dishes honestly) or complete their micronutrient data properly. Query to re-pull the list any time:
```sql
select f.name, f.kcal, f.protein, f.carbs, f.fat, f.fiber, f.iron
from public.foods f
where exists (select 1 from public.meal_box_items m where lower(m.name) = lower(f.name) or lower(m.name) like lower(f.name) || '%')
and (f.fiber is null or f.iron is null or f.calcium is null or f.vit_c is null)
order by f.name;
```
Note while investigating: BFB's own richest recipe source (`final-recipe-file.md`, ingredient-level) only has macro data (Energy/CHO/Protein/Fat) per ingredient — no micronutrients anywhere in BFB's menu data at any level. Completing micronutrients properly would mean running every ingredient through a real nutrient database (USDA/IFCT-style), a separate project, not a quick fix.

## New this session: honest logging of BFB meal-box dishes (`add_meal_box_logging.sql`)

The conundrum Aravinth raised: if the app recommends a BFB dish to close a gap, the customer reasonably expects to log it once eaten — but `meal_box_items` has no micronutrient data, so logging it as if it were a complete `foods` entry would silently understate/misstate the day's real micronutrient gap. Resolution, explicitly approved: keep `foods` exactly as strict as the architecture decision says (logging search only ever shows complete, verified entries) — don't widen that door again. Instead, add a distinct, honestly-labeled way to log a BFB dish as a BFB dish.

**Schema** (`add_meal_box_logging.sql`, not yet run by Aravinth): `diet_entries.food_id` is now nullable; new nullable `diet_entries.meal_box_item_id` (FK to `meal_box_items`); a check constraint enforces exactly one of the two is ever set. No separate "source" flag needed — the app derives partial-vs-complete from which id column is populated. Verified end-to-end against a local Postgres built to match production's constraint shape (food-only insert, meal-box-only insert, both-set rejected, neither-set rejected — all behaved correctly).

**Website (`index.html`):** `mealBoxCard()` (Meal Box tab, "Best for today's gap" mode) now has a "Log this" button next to each suggested dish. Logs with `meal_box_item_id` set (not `food_id`), servings 1, current meal selection. New `mapMealBoxRow()` maps a meal-box row the same shape as `mapFoodRow()` but with fiber/all 15 micronutrients explicitly `0` and `isPartial:true`, so totals() adds nothing fabricated for those nutrients. `refreshDietLog()` now embeds both `foods(*)` and `meal_box_items(*)` and picks the right mapper per row. The diet log table tags each BFB-sourced row "BFB box"; `renderGaps()` shows a plain-language note above the macro gaps whenever any of today's entries are partial ("N meal-box item(s) logged today — tracked for calories/protein/carbs/fat only; fiber and micronutrient numbers may be a bit better than what was actually eaten").

**Telegram (`api/telegram-webhook.js` + `lib/nutrition-core.js`):** `nc.mapMealBoxRow()` added (mirrors the website's, exported from `lib/nutrition-core.js`). `loadEntriesForDate()` embeds both tables like the website. `logMeal()`: when an item the AI couldn't match against `foods` turns out to match a `meal_box_items` name (simple case-insensitive exact/substring match, no second AI call), it's logged as a partial meal-box entry instead of just being flagged to `food_requests` — reply says plainly it's tracked for macros only. Still falls through to `food_requests` if neither catalog matches. `gapSummary()`/`formatGapSummary()` now append the same "N BFB meal-box item(s) logged" note as the website whenever applicable.

**Verified via test harness** (`test_telegram_webhook.js`, scratchpad) — new scenario 5b logs "lentil soup" by free text, confirms it resolves via the meal-box fallback (not `foods`), inserts with `meal_box_item_id` set and no `food_id`, and that `/gap` afterward shows the honest partial-data note. Scenario 5's pre-existing "mystery soup" (matches neither catalog) still correctly falls through to `food_requests`, confirming no false-positive matching. All other scenarios (onboarding, meal ideas, appointments, etc.) still pass clean.

**Scope note:** the "Log this" button only exists in the Meal Box tab's gap-mode (where a dish is being actively suggested to close today's gap) — not the general browse mode, and not a general meal-box search-to-log anywhere else. That matches what was actually asked for and keeps BFB dishes out of any general-purpose logging surface.

## Earlier phase this session: "fix the menu gap, make the customer journey easier" — shipped, tested

Triggered by a real Telegram log attempt failing to match "Ragi semiya" in the catalog.

**1. Telegram self-serve onboarding (acquisition funnel).** A cold Telegram contact with no account can now sign up and fill in their profile entirely in chat (buttons for categorical fields, text for numbers), starting anonymous and claiming a real email only once value is shown. Creates a synthetic Supabase Auth user (`tg-<chatId>-<hex>@telegram.invalid`) via the Auth Admin API; claiming a real email later handles the Postgres unique-email collision gracefully. New `telegram_links.source` / `onboarding_state` columns (`telegram_selfserve_onboarding.sql`).

**2. Unmatched Telegram food mentions feed the catalog backlog.** `telegram-webhook.js` writes every unmatched name into the existing `food_requests` table (same table the website's "request a food" button uses) — Aravinth/team reviews the backlog and adds genuinely verified entries, rather than the catalog absorbing whatever a spreadsheet happened to contain.

**3. Telegram meal-box ideas.** Ported the website's Meal Box "gap mode" logic to Telegram: ask "what should I eat?" (or send `/meals`) and the bot ranks `meal_box_items` against what's left of today's macro targets, same scoring as the website, with the same honest fallback to real foods when the real biggest gap is fiber or a micronutrient. Shared scoring logic lives in `lib/nutrition-core.js` (`rankMealBoxForGap`, `pickFoodFallbackForGap`, `MEALBOX_COVERED_GAP_LABELS`).

**Abandoned earlier this session, reverted cleanly:** an attempt to hand-vet and import 47 BFB dishes directly into `foods` as a "macro-only" tier. Went through three rounds of real schema failures before Aravinth called it: don't mix the menu into the logging catalog at all. None of those 47 rows ever landed in `foods` (every failed SQL run rolled back cleanly). The `foods.micronutrients_complete` column added for that attempt is inert and harmless to leave; `revert_micronutrients_complete_column.sql` drops it if wanted.

## Pending / next up

- **Clean up the 47 pre-existing incomplete BFB rows in `foods`** (see above) — decide delete vs. complete, then act.
- **Keyword/synonym expansion pass** (approved earlier) — still blocked on Aravinth exporting `select name, keywords from public.foods order by name;` from the Supabase SQL editor and sending the result.
- `foods` grows only through genuinely verified entries from now on — likely sourced from the `food_requests` backlog as real logging misses accumulate, not from BFB's menu spreadsheet.
- Medical trends dashboard; appointment reminders/confirmations (deferred, admin-side); voice/photo handling in the bot; Hindi/regional-language support.

## Deploy checklist for this phase's changes

1. Run `add_meal_box_logging.sql` in the Supabase SQL editor (not yet run).
2. Deploy the updated `index.html`, `api/telegram-webhook.js`, `lib/nutrition-core.js` to Vercel.
3. Decide on and run the cleanup for the 47 pre-existing incomplete `foods` rows (query above) — not done yet, separate from the schema migration.
4. `revert_micronutrients_complete_column.sql` is optional cleanup, not required. `api/dietitian-chat.js` / `lib/dietitian-agent.js` are unchanged this phase.
