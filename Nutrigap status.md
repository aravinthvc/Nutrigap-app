---
description: NutriGap / NutriGap_Bot build status — what's shipped, what's pending, what the user needs to do next. Read before resuming work on this project.
---

# NutriGap status (as of 2026-10-07)

Stack: Vercel serverless functions (`api/*.js`, CommonJS, no framework) + Supabase (Postgres + RLS). No local dev tooling — Aravinth deploys by copy-pasting files into Vercel/GitHub and SQL into the Supabase SQL editor. Telegram bot (`NutriGap_Bot`, webhook at `api/telegram-webhook.js`) is a second channel onto the same account/data as the website (`index.html`).

## Newest this session: Telegram `/gap` summary now always shows macro gaps too

Aravinth reported (screenshot of a real `/gap` reply): the "Biggest gaps" list only ever showed micronutrients (Iron, Vitamin A, Vitamin D, Vitamin E, Vitamin B12), never protein/carbs/fat/fiber, even on a day where calories were clearly short too.

**Root cause:** `formatGapSummary()` in `api/telegram-webhook.js` took the top 5 nutrients from `rankGapsForInsight()` ranked purely by % off target. Micronutrient targets (vitamins especially) routinely show much larger percentage gaps than macros do, so macros were getting crowded out of the top 5 every time, even when meaningfully off target themselves — not a data bug, a display bug.

**Fix:** `formatGapSummary()` now splits `rankGapsForInsight()`'s output into two guaranteed sections instead of one blended top-5: a "Macros" section listing every off-target macro (protein/carbs/fat/fiber — kcal stays on its own summary line as before), and a "Biggest micronutrient gaps" section capped at the top 4 by % off target. Macros never get crowded out again; the micronutrient list is still capped so the message doesn't get unwieldy. Verified against the test harness (`test_telegram_webhook.js`, scenario 12b) and a standalone reconstruction of Aravinth's actual numbers — confirms protein/carbs/fat/fiber now appear whenever they're off target, independent of how big the vitamin percentages are that day.

No schema change, no new file — just `api/telegram-webhook.js` to redeploy (copy-paste into GitHub, same as any other code change). Website (`index.html`) was never affected by this bug — it already shows macro and micro gaps in two separate always-visible cards, not a truncated top-N list.

## Telegram UX overhaul (shipped and fully deployed 2026-10-06/07)

Aravinth's feedback: the Telegram journey "needs to be more intuitive, easy and smooth." He picked three priorities (over making suggestions tappable / confirming the meal bucket, which are still open — see Pending): command menu + quick-action buttons, responsiveness polish, and daily nudges/reminders. **All three confirmed live in production** — SQL migrations run, `CRON_SECRET` set in Vercel, and the Telegram "/" command menu confirmed working via screenshot in the real NutriGapBot chat.

**1. Persistent quick-action menu + command routing.** `MAIN_MENU_KEYBOARD` (a Telegram reply keyboard, not inline — docks under the text box and stays visible across every later message): 📊 My gap / 🍽 Meal ideas / 📝 Log a meal / 📅 Appointments / ❓ Help. Sent after linking, after onboarding finishes, and on /start or /help. Button taps route via `BUTTON_TO_COMMAND` onto the same deterministic code path as the matching slash command (no extra AI call) — "📝 Log a meal" has no command equivalent, it just prompts for what to type.

Telegram's own "/" command menu (`setMyCommands`) was a separate one-time bot-level config call — **done**, confirmed live via screenshot (`/gap`, `/meals`, `/appointments`, `/nudges`, `/help`, `/unlink` all showing with descriptions in the real chat).

**2. Responsiveness polish.** `sendTyping()` fires Telegram's "typing..." indicator right before any reply that involves an AI call.

**3. Daily check-in nudges.** `telegram_links.nudges_enabled` (default true) / `last_nudged_date`. `api/telegram-cron-nudge.js`, triggered once daily by Vercel Cron at 20:00 IST. Skips anyone mid-onboarding, without a complete profile, or already nudged today; sends a plain "haven't logged today" nudge if zero entries, or a biggest-gap-naming nudge if under 50% of calorie target; stays silent for anyone on track. Every nudge states how to turn it off; `/nudges` / `/nudges on` / `/nudges off` work any time. Fails closed without `CRON_SECRET`.

## Pre-existing data leak found and still needs cleanup: BFB dishes already inside `foods`

While checking whether the `foods`/`meal_box_items` separation (below) was actually holding, Aravinth spotted BFB-style dish names (Ragi roti, Apple banana date salad with cream, Bajra roti, Ash gourd soup, ...) in the website's food-search/logging dropdown — not the Meal Box tab. Diagnostic query confirmed: **47 rows** in `foods` share a name with a `meal_box_items` dish and are missing fiber + all micronutrients (`NULL`). These predate this session entirely — an earlier abandoned 47-row import batch never committed (verified via Postgres statement atomicity) and only covered soups/salads, which doesn't explain entries like "Bajra roti". Likely an older bulk import from before the architecture decision was made.

**Not yet cleaned up.** The 47 rows are still live and still searchable/loggable as if they were complete foods — this is the actual "Ragi roti still visible" bug, worse than it first looked (2 rows → 47). Next step: decide whether to delete them outright (since the "Log this" meal-box flow below now covers the same dishes honestly) or complete their micronutrient data properly. Query to re-pull the list any time:
```sql
select f.name, f.kcal, f.protein, f.carbs, f.fat, f.fiber, f.iron
from public.foods f
where exists (select 1 from public.meal_box_items m where lower(m.name) = lower(f.name) or lower(m.name) like lower(f.name) || '%')
and (f.fiber is null or f.iron is null or f.calcium is null or f.vit_c is null)
order by f.name;
```
Note while investigating: BFB's own richest recipe source (`final-recipe-file.md`, ingredient-level) only has macro data (Energy/CHO/Protein/Fat) per ingredient — no micronutrients anywhere in BFB's menu data at any level. Completing micronutrients properly would mean running every ingredient through a real nutrient database (USDA/IFCT-style), a separate project, not a quick fix.

## Architecture decision: `foods` and `meal_box_items` stay separate (2026-10-06)

`foods` is the clean, fully-verified personal diet-logging catalog (always-complete macro + micronutrient data). `meal_box_items` is BFB's ~1,200-dish subscription menu — separate table, macro-only (kcal/protein/carbs/fat), used for meal-idea suggestions AND honest partial logging (see below). This was Aravinth's explicit call after watching an attempt to import BFB dishes into `foods` turn into three rounds of schema fights — mixing a messy, macro-only subscription menu into a catalog that's always assumed complete data was the wrong model, not a solvable bug.

## Honest logging of BFB meal-box dishes (`add_meal_box_logging.sql` — confirmed run in production)

The conundrum Aravinth raised: if the app recommends a BFB dish to close a gap, the customer reasonably expects to log it once eaten — but `meal_box_items` has no micronutrient data, so logging it as if it were a complete `foods` entry would silently understate/misstate the day's real micronutrient gap. Resolution, explicitly approved: keep `foods` exactly as strict as the architecture decision says (logging search only ever shows complete, verified entries) — don't widen that door again. Instead, add a distinct, honestly-labeled way to log a BFB dish as a BFB dish.

**Schema:** `diet_entries.food_id` is nullable; `diet_entries.meal_box_item_id` (FK to `meal_box_items`, nullable); a check constraint enforces exactly one of the two is ever set. No separate "source" flag needed — the app derives partial-vs-complete from which id column is populated.

**Website (`index.html`):** `mealBoxCard()` (Meal Box tab, "Best for today's gap" mode) has a "Log this" button next to each suggested dish. Logs with `meal_box_item_id` set (not `food_id`), servings 1, current meal selection. `mapMealBoxRow()` maps a meal-box row the same shape as `mapFoodRow()` but with fiber/all 15 micronutrients explicitly `0` and `isPartial:true`. `refreshDietLog()` embeds both `foods(*)` and `meal_box_items(*)` and picks the right mapper per row. The diet log table tags each BFB-sourced row "BFB box"; `renderGaps()` shows a plain-language note above the macro gaps whenever any of today's entries are partial.

**Telegram (`api/telegram-webhook.js` + `lib/nutrition-core.js`):** `nc.mapMealBoxRow()` exported from `lib/nutrition-core.js`. `loadEntriesForDate()` embeds both tables like the website. `logMeal()`: when an item the AI couldn't match against `foods` turns out to match a `meal_box_items` name (simple case-insensitive match, no second AI call), it's logged as a partial meal-box entry instead of just being flagged to `food_requests`. `gapSummary()`/`formatGapSummary()` append the same "N BFB meal-box item(s) logged" note as the website.

**Scope note:** the "Log this" button only exists in the Meal Box tab's gap-mode (where a dish is being actively suggested to close today's gap) — not general browse mode or a general meal-box search-to-log.

## Earlier phase: "fix the menu gap, make the customer journey easier" — shipped, tested

Triggered by a real Telegram log attempt failing to match "Ragi semiya" in the catalog.

**1. Telegram self-serve onboarding (acquisition funnel).** A cold Telegram contact with no account can now sign up and fill in their profile entirely in chat, starting anonymous and claiming a real email only once value is shown. Creates a synthetic Supabase Auth user via the Auth Admin API. New `telegram_links.source` / `onboarding_state` columns (`telegram_selfserve_onboarding.sql`).

**2. Unmatched Telegram food mentions feed the catalog backlog.** Writes every unmatched name into the existing `food_requests` table.

**3. Telegram meal-box ideas.** Ported the website's Meal Box "gap mode" logic to Telegram ("what should I eat?" / `/meals`). Shared scoring logic lives in `lib/nutrition-core.js`.

**Abandoned earlier, reverted cleanly:** an attempt to hand-vet and import 47 BFB dishes directly into `foods` as a "macro-only" tier. None of those 47 rows ever landed in `foods`. The `foods.micronutrients_complete` column added for that attempt is inert; `revert_micronutrients_complete_column.sql` drops it if wanted.

## Pending / next up

- **Clean up the 47 pre-existing incomplete BFB rows in `foods`** — decide delete vs. complete, then act.
- **Telegram UX — not yet built, picked by Aravinth as lower priority this round:** making meal-idea/meal-box suggestions tappable (inline "Log this" buttons instead of retyping the dish name) and confirming the meal bucket (breakfast/lunch/dinner/snack) via quick buttons instead of silently guessing from time of day.
- **Keyword/synonym expansion pass** — still blocked on Aravinth exporting `select name, keywords from public.foods order by name;` and sending the result.
- `foods` grows only through genuinely verified entries from now on — likely sourced from the `food_requests` backlog, not BFB's menu spreadsheet.
- Medical trends dashboard; appointment reminders/confirmations (deferred, admin-side); voice/photo handling in the bot; Hindi/regional-language support.

## Deploy checklist

1. ~~Run `add_meal_box_logging.sql` and `add_telegram_nudges.sql` in the Supabase SQL editor~~ — **done, confirmed.**
2. **Redeploy `api/telegram-webhook.js`** to Vercel (today's macro-gap fix — the only file that changed this round).
3. ~~Merge `vercel.json`'s `crons` entry into the real project config~~ — **done, confirmed.**
4. ~~Set a `CRON_SECRET` env var in Vercel~~ — **done, confirmed.**
5. ~~Run the one-time `setMyCommands` curl command~~ — **done, confirmed live via screenshot.**
6. Decide on and run the cleanup for the 47 pre-existing incomplete `foods` rows — separate from everything else above, still open.
7. `revert_micronutrients_complete_column.sql` is optional cleanup, not required. `api/dietitian-chat.js` / `lib/dietitian-agent.js` are unchanged this phase.
