---
description: NutriGap / NutriGap_Bot build status — what's shipped, what's pending, what the user needs to do next. Read before resuming work on this project.
---

# NutriGap status (as of 2026-10-06)

Stack: Vercel serverless functions (`api/*.js`, CommonJS, no framework) + Supabase (Postgres + RLS). No local dev tooling — Aravinth deploys by copy-pasting files into Vercel/GitHub and SQL into the Supabase SQL editor. Telegram bot (`NutriGap_Bot`, webhook at `api/telegram-webhook.js`) is a second channel onto the same account/data as the website (`index.html`).

## Newest this session: Telegram UX overhaul (`add_telegram_nudges.sql`, `vercel.json`, `api/telegram-cron-nudge.js`)

Aravinth's feedback: the Telegram journey "needs to be more intuitive, easy and smooth." He picked three priorities (over making suggestions tappable / confirming the meal bucket, which are still open — see Pending): command menu + quick-action buttons, responsiveness polish, and daily nudges/reminders.

**1. Persistent quick-action menu + command routing.** New `MAIN_MENU_KEYBOARD` (a Telegram reply keyboard, not inline — docks under the text box and stays visible across every later message): 📊 My gap / 🍽 Meal ideas / 📝 Log a meal / 📅 Appointments / ❓ Help. Sent after linking, after onboarding finishes, and on /start or /help. Button taps arrive back as plain text and are routed via `BUTTON_TO_COMMAND` onto the same deterministic code path as the matching slash command (no extra AI call) — "📝 Log a meal" has no command equivalent, it just prompts for what to type. Free text and existing slash commands are unchanged; this is additive.

**Telegram's own "/" command menu is a separate thing and still needs a one-time setup call** — `setMyCommands` isn't something a webhook request can do for itself, it's bot-level config. Aravinth needs to run this once (his own bot token, never shared in chat):
```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands":[
    {"command":"gap","description":"Today'"'"'s nutrition gap"},
    {"command":"meals","description":"BFB meal-box ideas for today'"'"'s gap"},
    {"command":"appointments","description":"Your dietitian appointments"},
    {"command":"nudges","description":"Turn daily reminders on or off"},
    {"command":"help","description":"What I can do"},
    {"command":"unlink","description":"Disconnect this chat"}
  ]}'
```

**2. Responsiveness polish.** New `sendTyping()` fires Telegram's "typing..." indicator right before any reply that involves an AI call (classify, and usually a second call for extraction/chat/booking) — a few seconds of silence otherwise reads as broken, not slow. Deterministic commands (DB-only, already fast) don't need it. Error-copy rewrite was considered and skipped — existing messages ("couldn't find X, flagged for the team", "just a number between 10 and 100") were judged already clear; not touched, to keep this change's risk surface small.

**3. Daily check-in nudges (new file, new table columns, new cron job).** `telegram_links` gets `nudges_enabled` (default true) and `last_nudged_date`. New `api/telegram-cron-nudge.js`, triggered once daily by Vercel Cron at 20:00 IST (`vercel.json`'s `crons` entry — **merge this key into Aravinth's real vercel.json if one already exists in the repo; don't let this placeholder file overwrite it**). For every linked, fully-onboarded, nudges-enabled chat not already nudged today: skip if no complete profile yet (nothing honest to say); if zero diet_entries logged today, send a plain "haven't seen your log today" nudge; if logged but under 50% of calorie target, send a nudge naming the current biggest gap and pointing at meal ideas; if already reasonably logged, skip silently (never nagging someone who's on track). Every nudge message states how to turn it off, and `/nudges` / `/nudges on` / `/nudges off` work any time from the chat itself. **Fails closed**: refuses to run (500) if `CRON_SECRET` isn't set in Vercel env vars, and rejects (401) any request whose `Authorization: Bearer` header doesn't match it — this is the one piece of code in the whole app that messages people without them asking first, so it's deliberately locked down against being hit by anyone else. Aravinth needs to set `CRON_SECRET` to some random value in Vercel's env vars (Vercel sets the matching header automatically when it fires the cron job itself).

**Verified via test harness** (`test_telegram_cron_nudge.js`, new, scratchpad) — covers: no-log nudge, thin-log nudge (with correct biggest-gap naming), on-track skipped, already-nudged-today skipped (idempotency), mid-onboarding skipped, no-profile skipped, opted-out chat never even queried, auth rejected on missing/wrong secret, and a second same-day run sending nothing. `test_telegram_webhook.js` extended with scenarios for menu-button routing (confirms "📊 My gap" behaves exactly like `/gap`), the "📝 Log a meal" prompt, and `/nudges` status/on/off — all pass, alongside every pre-existing scenario (onboarding harness too).

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

## Honest logging of BFB meal-box dishes (`add_meal_box_logging.sql`)

The conundrum Aravinth raised: if the app recommends a BFB dish to close a gap, the customer reasonably expects to log it once eaten — but `meal_box_items` has no micronutrient data, so logging it as if it were a complete `foods` entry would silently understate/misstate the day's real micronutrient gap. Resolution, explicitly approved: keep `foods` exactly as strict as the architecture decision says (logging search only ever shows complete, verified entries) — don't widen that door again. Instead, add a distinct, honestly-labeled way to log a BFB dish as a BFB dish.

**Schema** (`add_meal_box_logging.sql`, not yet run by Aravinth): `diet_entries.food_id` is now nullable; new nullable `diet_entries.meal_box_item_id` (FK to `meal_box_items`); a check constraint enforces exactly one of the two is ever set. No separate "source" flag needed — the app derives partial-vs-complete from which id column is populated. Verified end-to-end against a local Postgres built to match production's constraint shape.

**Website (`index.html`):** `mealBoxCard()` (Meal Box tab, "Best for today's gap" mode) has a "Log this" button next to each suggested dish. Logs with `meal_box_item_id` set (not `food_id`), servings 1, current meal selection. `mapMealBoxRow()` maps a meal-box row the same shape as `mapFoodRow()` but with fiber/all 15 micronutrients explicitly `0` and `isPartial:true`. `refreshDietLog()` embeds both `foods(*)` and `meal_box_items(*)` and picks the right mapper per row. The diet log table tags each BFB-sourced row "BFB box"; `renderGaps()` shows a plain-language note above the macro gaps whenever any of today's entries are partial.

**Telegram (`api/telegram-webhook.js` + `lib/nutrition-core.js`):** `nc.mapMealBoxRow()` exported from `lib/nutrition-core.js`. `loadEntriesForDate()` embeds both tables like the website. `logMeal()`: when an item the AI couldn't match against `foods` turns out to match a `meal_box_items` name (simple case-insensitive match, no second AI call), it's logged as a partial meal-box entry instead of just being flagged to `food_requests`. `gapSummary()`/`formatGapSummary()` append the same "N BFB meal-box item(s) logged" note as the website.

**Scope note:** the "Log this" button only exists in the Meal Box tab's gap-mode (where a dish is being actively suggested to close today's gap) — not general browse mode or a general meal-box search-to-log.

## Earlier phase this session: "fix the menu gap, make the customer journey easier" — shipped, tested

Triggered by a real Telegram log attempt failing to match "Ragi semiya" in the catalog.

**1. Telegram self-serve onboarding (acquisition funnel).** A cold Telegram contact with no account can now sign up and fill in their profile entirely in chat, starting anonymous and claiming a real email only once value is shown. Creates a synthetic Supabase Auth user via the Auth Admin API. New `telegram_links.source` / `onboarding_state` columns (`telegram_selfserve_onboarding.sql`).

**2. Unmatched Telegram food mentions feed the catalog backlog.** Writes every unmatched name into the existing `food_requests` table.

**3. Telegram meal-box ideas.** Ported the website's Meal Box "gap mode" logic to Telegram ("what should I eat?" / `/meals`). Shared scoring logic lives in `lib/nutrition-core.js`.

**Abandoned earlier this session, reverted cleanly:** an attempt to hand-vet and import 47 BFB dishes directly into `foods` as a "macro-only" tier. None of those 47 rows ever landed in `foods`. The `foods.micronutrients_complete` column added for that attempt is inert; `revert_micronutrients_complete_column.sql` drops it if wanted.

## Pending / next up

- **Clean up the 47 pre-existing incomplete BFB rows in `foods`** — decide delete vs. complete, then act.
- **Telegram UX — not yet built, picked by Aravinth as lower priority this round:** making meal-idea/meal-box suggestions tappable (inline "Log this" buttons instead of retyping the dish name) and confirming the meal bucket (breakfast/lunch/dinner/snack) via quick buttons instead of silently guessing from time of day.
- **Keyword/synonym expansion pass** — still blocked on Aravinth exporting `select name, keywords from public.foods order by name;` and sending the result.
- `foods` grows only through genuinely verified entries from now on — likely sourced from the `food_requests` backlog, not BFB's menu spreadsheet.
- Medical trends dashboard; appointment reminders/confirmations (deferred, admin-side); voice/photo handling in the bot; Hindi/regional-language support.

## Deploy checklist

1. Run `add_meal_box_logging.sql` and `add_telegram_nudges.sql` in the Supabase SQL editor (neither run yet).
2. Deploy the updated `index.html`, `api/telegram-webhook.js`, `lib/nutrition-core.js`, plus the new `api/telegram-cron-nudge.js`, to Vercel.
3. Merge `vercel.json`'s `crons` entry into the real project config (don't blindly overwrite if one already exists).
4. Set a `CRON_SECRET` env var in Vercel (any random value) — the nudge cron refuses to run without it.
5. Run the one-time `setMyCommands` curl command above (own bot token, not shared in chat) so Telegram's "/" menu shows the real commands.
6. Decide on and run the cleanup for the 47 pre-existing incomplete `foods` rows — separate from everything else above.
7. `revert_micronutrients_complete_column.sql` is optional cleanup, not required. `api/dietitian-chat.js` / `lib/dietitian-agent.js` are unchanged this phase.
