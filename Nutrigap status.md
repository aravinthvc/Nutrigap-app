---
description: NutriGap / NutriGap_Bot build status — what's shipped, what's pending, what the user needs to do next. Read before resuming work on this project.
---

# NutriGap status (as of 2026-10-07)

Stack: Vercel serverless functions (`api/*.js`, CommonJS, no framework) + Supabase (Postgres + RLS). No local dev tooling — Aravinth deploys by copy-pasting files into Vercel/GitHub and SQL into the Supabase SQL editor. Telegram bot (`NutriGap_Bot`, webhook at `api/telegram-webhook.js`) is a second channel onto the same account/data as the website (`index.html`).

## Newest this session: guided meal-logging flow on Telegram (meal + date confirmation, honest photo placeholder)

Aravinth's feedback after seeing the new quick-action menu: "should we keep a separate menu for Log a Meal? we should ask details of the meal that is getting logged — Breakfast/Lunch/etc, which date is the entry for, etc. Else how do you track random entries/photos?" Walked through the trade-offs with him (scope: button-only vs. every message; date range; whether to build photo handling now) via explicit choices — he picked: confirm meal+date on **every** food-sounding message (not just the button), support typing **any date** (not just today/yesterday), and add a **placeholder** step for photos (accepted and saved for review, not analyzed).

**What changed:** logging a meal — whether started by typing food free-text ("2 chapathis for lunch") or by tapping "📝 Log a meal" (or `/log`) — now always asks which meal (Breakfast/Lunch/Dinner/Snack, inline buttons) and which date (Today/Yesterday/type one) before anything is saved, instead of silently guessing the meal from time-of-day and always assuming today. If the free-text entry already said what was eaten, it's not asked a third time — the flow just confirms meal+date and finishes. If it was started via the button, a final step asks "what did you eat, or send a photo."

**State machine:** new `telegram_links.pending_log` (jsonb) column, same pattern as the existing `onboarding_state` — `{step, text, meal, entryDate}`, `step` one of `meal | date | custom_date | items`. Reuses the existing inline-keyboard + `callback_query` plumbing (same one onboarding already uses) rather than inventing a new mechanism.

**Date typing:** accepts `2026-10-05` or a day+month like "5 Oct" / "Oct 5" / "5 October" (assumed current year, rolled back a year if that would land in the future). Deliberately **rejects slash dates** like "5/10" rather than guess DD/MM vs MM/DD — the exact silent misread this flow exists to avoid for an Indian user typing day-first. Also rejects anything more than 90 days back or in the future (almost certainly a typo, not a real backfill).

**Photos:** not analyzed (that's separate, bigger work — see Pending). When someone sends a photo at the "what did you eat" step, it's saved to a new `meal_photo_logs` table (Telegram's `file_id`, meal, date, user) for manual review, and the reply says plainly it won't count toward their nutrient numbers yet — same honesty principle as the rest of the app (medical-report insights, partial BFB logging): never let something uncounted pass as counted. A photo sent with no logging flow in progress gets a short redirect instead of being silently dropped or burning an AI call on empty text.

**Escaping the flow:** mid-flow, sending a recognized command or a different menu button (`/gap`, `📊 My gap`, etc.) abandons the half-finished log and is handled normally — doesn't trap someone who changed their mind. A stray text message while a button tap is expected (the meal/date steps) gets redirected back to the question rather than silently ignored or misinterpreted.

**`logMeal()`** no longer guesses the meal (previously `defaultMealForHour`) or the date (previously always today) — both are now required parameters, supplied only after the person has confirmed them.

Verified via the existing test harness (`test_telegram_webhook.js`, scenarios 5/5b rewritten, 5c–5i added) covering: free-text entry finishing after 2 taps, button-first entry asking a 3rd question, custom date (valid and the rejected-slash-format case), the photo placeholder (in-flow and out-of-flow), mid-flow escape via `/gap`, and the stray-text redirect — all pass, alongside the full pre-existing regression suite (onboarding, appointments, nudges, menu-button routing, etc.).

**Not yet deployed** — needs `add_telegram_meal_logging_flow.sql` run in Supabase (adds `telegram_links.pending_log` + the new `meal_photo_logs` table) and `api/telegram-webhook.js` redeployed. See Deploy checklist.

## Telegram `/gap` summary now always shows macro gaps too (shipped, deployed, confirmed live 2026-10-07)

Root cause was `formatGapSummary()` taking the top 5 nutrients from `rankGapsForInsight()` ranked purely by % off target — vitamin gaps routinely run bigger percentages than macro gaps, so protein/carbs/fat/fiber kept getting crowded out of the top 5 even when meaningfully off. Fixed by splitting into two guaranteed sections: "Macros" (every off-target macro) and "Biggest micronutrient gaps" (capped top 4). Confirmed live via screenshot — a real `/gap` reply now shows both sections correctly.

## Telegram UX overhaul (shipped and fully deployed 2026-10-06/07)

Aravinth's feedback: the Telegram journey "needs to be more intuitive, easy and smooth." He picked three priorities: command menu + quick-action buttons, responsiveness polish, and daily nudges/reminders. **All three confirmed live in production** — SQL migrations run, `CRON_SECRET` set in Vercel, and the Telegram "/" command menu confirmed working via screenshot in the real NutriGapBot chat.

**1. Persistent quick-action menu + command routing.** `MAIN_MENU_KEYBOARD` (a Telegram reply keyboard, not inline — docks under the text box and stays visible across every later message): 📊 My gap / 🍽 Meal ideas / 📝 Log a meal / 📅 Appointments / ❓ Help. Sent after linking, after onboarding finishes, and on /start or /help. Button taps route via `BUTTON_TO_COMMAND` onto the same deterministic code path as the matching slash command (no extra AI call) — "📝 Log a meal" now starts the guided logging flow above (previously just a static prompt).

Telegram's own "/" command menu (`setMyCommands`) — **done**, confirmed live via screenshot (`/gap`, `/meals`, `/appointments`, `/nudges`, `/help`, `/unlink` all showing with descriptions in the real chat). The new `/log` command isn't in that menu yet — optional, low-priority to add (the button already covers it); would need another one-time `setMyCommands` call if wanted.

**2. Responsiveness polish.** `sendTyping()` fires Telegram's "typing..." indicator right before any reply that involves an AI call.

**3. Daily check-in nudges.** `telegram_links.nudges_enabled` (default true) / `last_nudged_date`. `api/telegram-cron-nudge.js`, triggered once daily by Vercel Cron at 20:00 IST. Skips anyone mid-onboarding, without a complete profile, or already nudged today; sends a plain "haven't logged today" nudge if zero entries, or a biggest-gap-naming nudge if under 50% of calorie target; stays silent for anyone on track. Every nudge states how to turn it off; `/nudges` / `/nudges on` / `/nudges off` work any time. Fails closed without `CRON_SECRET`.

## Pre-existing data leak found and still needs cleanup: BFB dishes already inside `foods`

While checking whether the `foods`/`meal_box_items` separation (below) was actually holding, Aravinth spotted BFB-style dish names (Ragi roti, Apple banana date salad with cream, Bajra roti, Ash gourd soup, ...) in the website's food-search/logging dropdown — not the Meal Box tab. Diagnostic query confirmed: **47 rows** in `foods` share a name with a `meal_box_items` dish and are missing fiber + all micronutrients (`NULL`). These predate this session entirely. Still not cleaned up — decide delete vs. complete, then act. Query to re-pull the list any time:
```sql
select f.name, f.kcal, f.protein, f.carbs, f.fat, f.fiber, f.iron
from public.foods f
where exists (select 1 from public.meal_box_items m where lower(m.name) = lower(f.name) or lower(m.name) like lower(f.name) || '%')
and (f.fiber is null or f.iron is null or f.calcium is null or f.vit_c is null)
order by f.name;
```
Note while investigating: BFB's own richest recipe source (`final-recipe-file.md`, ingredient-level) only has macro data (Energy/CHO/Protein/Fat) per ingredient — no micronutrients anywhere in BFB's menu data at any level. Completing micronutrients properly would mean running every ingredient through a real nutrient database (USDA/IFCT-style), a separate project, not a quick fix.

## Architecture decision: `foods` and `meal_box_items` stay separate (2026-10-06)

`foods` is the clean, fully-verified personal diet-logging catalog (always-complete macro + micronutrient data). `meal_box_items` is BFB's ~1,200-dish subscription menu — separate table, macro-only (kcal/protein/carbs/fat), used for meal-idea suggestions AND honest partial logging (see below).

## Honest logging of BFB meal-box dishes (`add_meal_box_logging.sql` — confirmed run in production)

If the app recommends a BFB dish to close a gap, the customer reasonably expects to log it once eaten — but `meal_box_items` has no micronutrient data. Resolution: keep `foods` strict, add a distinct, honestly-labeled way to log a BFB dish as a BFB dish.

**Schema:** `diet_entries.food_id` is nullable; `diet_entries.meal_box_item_id` (FK to `meal_box_items`, nullable); a check constraint enforces exactly one of the two is ever set.

**Website (`index.html`):** `mealBoxCard()` has a "Log this" button next to each suggested dish. `mapMealBoxRow()` maps a meal-box row with fiber/all 15 micronutrients explicitly `0` and `isPartial:true`. The diet log table tags each BFB-sourced row "BFB box"; `renderGaps()` shows a plain-language note whenever any of today's entries are partial.

**Telegram:** `nc.mapMealBoxRow()` from `lib/nutrition-core.js`. `logMeal()`: when an item can't match `foods` but matches a `meal_box_items` name, it's logged as a partial meal-box entry. `gapSummary()` appends the same "N BFB meal-box item(s) logged" note as the website.

## Pending / next up

- **Clean up the 47 pre-existing incomplete BFB rows in `foods`** — decide delete vs. complete, then act.
- **Photo-based meal logging — real analysis, not just the placeholder save.** Needs a vision step to identify food from an image; bigger, separate piece of work.
- **Keyword/synonym expansion pass** — still blocked on Aravinth exporting `select name, keywords from public.foods order by name;` and sending the result.
- `foods` grows only through genuinely verified entries from now on — likely sourced from the `food_requests` backlog, not BFB's menu spreadsheet.
- Medical trends dashboard; appointment reminders/confirmations (deferred, admin-side); Hindi/regional-language support.

## Deploy checklist

1. ~~Run `add_meal_box_logging.sql` and `add_telegram_nudges.sql` in the Supabase SQL editor~~ — **done, confirmed.**
2. ~~Merge `vercel.json`'s `crons` entry into the real project config~~ — **done, confirmed.**
3. ~~Set a `CRON_SECRET` env var in Vercel~~ — **done, confirmed.**
4. ~~Run the one-time `setMyCommands` curl command~~ — **done, confirmed live via screenshot.**
5. ~~Redeploy `api/telegram-webhook.js` (the macro-gaps display fix)~~ — **done, confirmed live.**
6. **Run `add_telegram_meal_logging_flow.sql` in the Supabase SQL editor** (new — adds `telegram_links.pending_log` + the new `meal_photo_logs` table).
7. **Redeploy `api/telegram-webhook.js`** to Vercel (today's guided meal-logging flow — the only code file that changed this round).
8. Decide on and run the cleanup for the 47 pre-existing incomplete `foods` rows — separate from everything else above, still open.
9. `revert_micronutrients_complete_column.sql` is optional cleanup, not required. `api/dietitian-chat.js` / `lib/dietitian-agent.js` are unchanged this phase.
