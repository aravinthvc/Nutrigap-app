---
description: NutriGap / NutriGap_Bot build status — what's shipped, what's pending, what the user needs to do next. Read before resuming work on this project.
---

# NutriGap status (as of 2026-10-07)

Stack: Vercel serverless functions (`api/*.js`, CommonJS, no framework) + Supabase (Postgres + RLS). No local dev tooling — Aravinth deploys by copy-pasting files into Vercel/GitHub and SQL into the Supabase SQL editor. Telegram bot (`NutriGap_Bot`, webhook at `api/telegram-webhook.js`) is a second channel onto the same account/data as the website (`index.html`).

## Newest this session: real photo-based meal analysis on Telegram (previously just a placeholder) — built, tested, not yet deployed

Aravinth picked this as the next feature to build (from the "Pending" list below). Previously, sending a photo at the "what did you eat?" step just saved it to `meal_photo_logs` for manual review and told the person plainly it wouldn't count — no analysis at all. Now it actually looks at the photo.

**How it stays honest (the app's core principle, applied to vision the same way it's applied everywhere else):** Claude is shown the photo and asked to describe what's on the plate only as specifically as it can actually see — never naming an exact dish it's guessing at, never estimating calories itself, and explicitly told to say "not confident" rather than guess when the photo is blurry, dark, or unclear. Whatever it identifies is shown to the person, who must tap **"✅ Yes, log it"** or **"✏️ No, let me type it instead"** before anything is saved — nothing from a photo is ever logged silently. Confirmed, the description runs through the exact same strict catalog-matching `logMeal()` already uses for typed text (`extractMealItems()`'s exact-name-only guardrail) — so a photo can only ever result in a real catalog match or an honestly-flagged "couldn't find that" miss, never a fabricated nutrient value. When Claude isn't confident, it falls back to the original placeholder behavior unchanged (saved for the team, person asked to type it instead).

**New pieces, all in `api/telegram-webhook.js`:**
- `telegramGetFilePath()` / `downloadTelegramFileAsBase64()` — pulls the actual image bytes from Telegram's file API (`getFile` then the file-download endpoint) using the bot token, which the account already has as `TELEGRAM_BOT_TOKEN`.
- `identifyFoodFromPhoto()` — one Claude vision call (image + text content blocks) with an honesty-first system prompt; returns `{confident, description, note}`.
- `handleMealPhoto()` — orchestrates the above, always writes a `meal_photo_logs` row (confident or not — this table remains the team's manual-review backstop either way), and either moves to a new `photo_confirm` step (confident) or falls back to the old placeholder message (not confident, or any failure downloading/analyzing — fails closed, never guesses to paper over an error).
- New `pending_log` step `photo_confirm` and a new callback kind `log:photoconfirm:yes|no`, following the exact same guided-flow pattern as the meal/date confirmation steps (escapable, re-askable on a stray message, etc).

**Schema (`add_meal_photo_analysis.sql`):** three new nullable columns on `meal_photo_logs` — `ai_description` (what Claude thought it saw, or null), `ai_confident` (whether it was confident enough to show a description at all), `confirmed` (null while awaiting a reply, true/false once the person answers). Every photo is still saved to this table regardless of outcome, now with richer context for manual review of the misses.

Verified via the test harness (`test_telegram_webhook.js`, scenarios 5f rewritten + 5f2/5f3 added): a confidently-identified photo shows the description and logs correctly on "yes" (via the same strict matching as typed text, including a correctly-flagged unmatched item); on "no" it falls back to asking for typed text and the flow stays open; a photo Claude isn't confident about still gets the honest placeholder treatment unchanged. Full pre-existing regression suite still passes.

**Not yet deployed** — needs `add_meal_photo_analysis.sql` run in Supabase, then `api/telegram-webhook.js` redeployed (same redeploy this folds into — see Deploy checklist).

## Telegram meal-ideas bot now answers the SPECIFIC nutrient asked about, and never shows a corrupted meal-box dish

Aravinth's report (with screenshots): asking "give me some suggestions to bridge the vitamin C gap" and then "...vitamin K gap" got back the **identical reply both times**, which also named vitamin K as "your biggest real gap" regardless of which one was asked — plus the reply included an irrelevant, visibly-corrupted BFB dish block ("2074g protein", "1563g carbs" on single-serving dishes). His ask: give precise, per-nutrient information, using "hybrid knowledge from both the database and Claude LLM," and make it accurate **and token-efficient**.

**Root cause:** `mealIdeas()` always answered "what's today's single biggest gap, generically" — it never looked at which nutrient the person actually named. `classifyIntent` only ever returns a bucket (`meal_ideas`), not the specific nutrient inside the sentence.

**Fix — four pieces, all in `api/telegram-webhook.js` and `lib/nutrition-core.js`, no new SQL needed:**

1. **`extractNamedNutrient(text)`** — a plain regex lookup (`NUTRIENT_ALIASES`, ~20 entries covering every macro/micro NutriGap tracks, incl. "vitamin k"/"vit k", "fibre"/"fiber", "salt"/"sodium", etc.). Deliberately **not** another AI call — the vocabulary is small and closed, so this is free and instant, directly answering the "token efficient" half of the ask.
2. **`nutrientSpecificIdeas(t, tg, nutrientKey)`** (new) — answers the one nutrient actually asked about: says plainly if it's already met, or if it's a "limit" nutrient (sodium) where the right move is eating *less*, not more; otherwise shows BFB meal-box dishes **only** if that nutrient is one of the four meal-box data actually covers (calories/protein/carbs/fat — `MEALBOX_COVERED_GAP_LABELS`), and always backs it up with real individual foods from the verified `foods` catalog, which is the only place micronutrient data exists at all.
3. **`pickFoodFallbackForNutrient()`** (new, in `lib/nutrition-core.js`) — generalizes the existing `pickFoodFallbackForGap()` to rank `foods` by one *named* nutrient instead of always deriving the nutrient from today's single biggest gap.
4. **`mealIdeas(userId, targetNutrientKey)`** — signature now takes an optional nutrient key; when present, delegates straight to `nutrientSpecificIdeas()` instead of the old generic reply. Both call sites (`/meals`/`/ideas` command, and the `meal_ideas` AI-routed branch) now pass `extractNamedNutrient(text)`. The `/meals`/`/ideas` command match was also loosened to catch `/meals iron` (trailing text), so a nutrient named right after the command routes with **zero** AI calls, not just when it comes through free-text classification.

**Separately — the actual corrupted-data trigger:** `rankMealBoxForGap()` (`lib/nutrition-core.js`) now runs every meal-box dish through a new `hasPlausibleMacros()` guard (protein ≤150g, carbs ≤250g, fat ≤150g per serving — deliberately generous, no real single serving needs more) before it can ever be suggested. This is the same known BFB source-data bug as `meal_box_carbs_decimal_fix.sql` from a prior session (decimal point lost, e.g. "1563" meaning "15.63") — that script explicitly flagged two "Rice with kadala curry" rows as still-unfixed, and this session's screenshot is exactly that bug resurfacing, plus a newly-spotted third row ("Rice with Prawns malai curry," 2074g protein). Rather than guess a "corrected" number (against the app's no-hallucination principle), bad rows are now just never shown — paired with a diagnostic query, `find_implausible_meal_box_macros.sql`, for Aravinth to find and hand-fix every such row at the source in Supabase. Hiding isn't the same as fixing: a hidden dish currently can't be suggested to anyone until its real numbers are corrected.

Verified via the test harness (`test_telegram_webhook.js`, scenarios 7d–7g added): vitamin K vs. vitamin C questions now get distinct, nutrient-correct replies; `/meals iron` routes directly; the corrupted "Rice with kadala curry" row never appears in a generic `/meals` suggestion; full pre-existing regression suite still passes.

## Guided meal-logging flow on Telegram (meal + date confirmation) — built, tested, not yet deployed

Aravinth's feedback after seeing the new quick-action menu: "should we keep a separate menu for Log a Meal? we should ask details of the meal that is getting logged — Breakfast/Lunch/etc, which date is the entry for, etc. Else how do you track random entries/photos?" Walked through the trade-offs with him (scope: button-only vs. every message; date range; whether to build photo handling now) via explicit choices — he picked: confirm meal+date on **every** food-sounding message (not just the button), support typing **any date** (not just today/yesterday), and add a **placeholder** step for photos first (now superseded by real analysis above).

**What changed:** logging a meal — whether started by typing food free-text ("2 chapathis for lunch") or by tapping "📝 Log a meal" (or `/log`) — now always asks which meal (Breakfast/Lunch/Dinner/Snack, inline buttons) and which date (Today/Yesterday/type one) before anything is saved, instead of silently guessing the meal from time-of-day and always assuming today. If the free-text entry already said what was eaten, it's not asked a third time — the flow just confirms meal+date and finishes. If it was started via the button, a final step asks "what did you eat, or send a photo."

**State machine:** `telegram_links.pending_log` (jsonb) column, same pattern as the existing `onboarding_state` — `{step, text, meal, entryDate, ...}`, `step` one of `meal | date | custom_date | items | photo_confirm` (the last one added by the photo-analysis feature above). Reuses the existing inline-keyboard + `callback_query` plumbing (same one onboarding already uses) rather than inventing a new mechanism.

**Date typing:** accepts `2026-10-05` or a day+month like "5 Oct" / "Oct 5" / "5 October" (assumed current year, rolled back a year if that would land in the future). Deliberately **rejects slash dates** like "5/10" rather than guess DD/MM vs MM/DD — the exact silent misread this flow exists to avoid for an Indian user typing day-first. Also rejects anything more than 90 days back or in the future (almost certainly a typo, not a real backfill).

**Escaping the flow:** mid-flow, sending a recognized command or a different menu button (`/gap`, `📊 My gap`, etc.) abandons the half-finished log and is handled normally — doesn't trap someone who changed their mind. A stray text message while a button tap is expected (meal/date/photo_confirm steps) gets redirected back to the question rather than silently ignored or misinterpreted.

**`logMeal()`** no longer guesses the meal (previously `defaultMealForHour`) or the date (previously always today) — both are now required parameters, supplied only after the person has confirmed them.

Verified via the test harness (`test_telegram_webhook.js`, scenarios 5/5b rewritten, 5c–5i added, 5f2/5f3 added for photo analysis) covering: free-text entry finishing after 2 taps, button-first entry asking a 3rd question, custom date (valid and the rejected-slash-format case), both photo outcomes (confident+confirmed, confident+declined, unconfident placeholder), mid-flow escape via `/gap`, and the stray-text redirect — all pass, alongside the full pre-existing regression suite (onboarding, appointments, nudges, menu-button routing, etc.).

## Telegram `/gap` summary now always shows macro gaps too (shipped, deployed, confirmed live 2026-10-07)

Root cause was `formatGapSummary()` taking the top 5 nutrients from `rankGapsForInsight()` ranked purely by % off target — vitamin gaps routinely run bigger percentages than macro gaps, so protein/carbs/fat/fiber kept getting crowded out of the top 5 even when meaningfully off. Fixed by splitting into two guaranteed sections: "Macros" (every off-target macro) and "Biggest micronutrient gaps" (capped top 4). Confirmed live via screenshot — a real `/gap` reply now shows both sections correctly.

## Telegram UX overhaul (shipped and fully deployed 2026-10-06/07)

Aravinth's feedback: the Telegram journey "needs to be more intuitive, easy and smooth." He picked three priorities: command menu + quick-action buttons, responsiveness polish, and daily nudges/reminders. **All three confirmed live in production** — SQL migrations run, `CRON_SECRET` set in Vercel, and the Telegram "/" command menu confirmed working via screenshot in the real NutriGapBot chat.

**1. Persistent quick-action menu + command routing.** `MAIN_MENU_KEYBOARD` (a Telegram reply keyboard, not inline — docks under the text box and stays visible across every later message): 📊 My gap / 🍽 Meal ideas / 📝 Log a meal / 📅 Appointments / ❓ Help. Sent after linking, after onboarding finishes, and on /start or /help. Button taps route via `BUTTON_TO_COMMAND` onto the same deterministic code path as the matching slash command (no extra AI call).

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
- **Hand-fix the implausible-macro rows in `meal_box_items`** at the source — run `find_implausible_meal_box_macros.sql` in Supabase, correct each flagged row. The app now hides these from suggestions either way, but a hidden dish is one that currently can't be recommended to anyone.
- **Keyword/synonym expansion pass** — still blocked on Aravinth exporting `select name, keywords from public.foods order by name;` and sending the result.
- `foods` grows only through genuinely verified entries from now on — likely sourced from the `food_requests` backlog, not BFB's menu spreadsheet.
- Medical trends dashboard; appointment reminders/confirmations (deferred, admin-side); Hindi/regional-language support; expanding wearable support beyond Fitbit/Strava (Google Fit/Health Connect, Garmin, Apple HealthKit are currently simulated placeholders, not real OAuth).

## Deploy checklist

1. ~~Run `add_meal_box_logging.sql` and `add_telegram_nudges.sql` in the Supabase SQL editor~~ — **done, confirmed.**
2. ~~Merge `vercel.json`'s `crons` entry into the real project config~~ — **done, confirmed.**
3. ~~Set a `CRON_SECRET` env var in Vercel~~ — **done, confirmed.**
4. ~~Run the one-time `setMyCommands` curl command~~ — **done, confirmed live via screenshot.**
5. ~~Redeploy `api/telegram-webhook.js` (the macro-gaps display fix)~~ — **done, confirmed live.**
6. **Run `add_telegram_meal_logging_flow.sql` AND `add_meal_photo_analysis.sql` in the Supabase SQL editor** (adds `telegram_links.pending_log`, the `meal_photo_logs` table, and its three new analysis columns).
7. **Redeploy `api/telegram-webhook.js` and `lib/nutrition-core.js` together to Vercel** — carries the guided meal-logging flow, the nutrient-specific-ideas fix + corrupted-dish filter, AND real photo-based meal analysis (all in the same two files, one redeploy covers all of it).
8. Optional, whenever convenient: run `find_implausible_meal_box_macros.sql` in the Supabase SQL editor and hand-correct any rows it flags.
9. Decide on and run the cleanup for the 47 pre-existing incomplete `foods` rows — separate from everything else above, still open.
10. `revert_micronutrients_complete_column.sql` is optional cleanup, not required. `api/dietitian-chat.js` / `lib/dietitian-agent.js` are unchanged this phase.
