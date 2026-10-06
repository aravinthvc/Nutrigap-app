---
description: NutriGap / NutriGap_Bot build status — what's shipped, what's pending, what the user needs to do next. Read before resuming work on this project.
---

# NutriGap status (as of 2026-10-06)

Stack: Vercel serverless functions (`api/*.js`, CommonJS, no framework) + Supabase (Postgres + RLS). No local dev tooling — Aravinth deploys by copy-pasting files into Vercel/GitHub and SQL into the Supabase SQL editor. Telegram bot (`NutriGap_Bot`, webhook at `api/telegram-webhook.js`) is a second channel onto the same account/data as the website (`index.html`).

## Architecture decision: `foods` and `meal_box_items` stay separate (2026-10-06)

`foods` is the clean, fully-verified personal diet-logging catalog (always-complete macro + micronutrient data). `meal_box_items` is BFB's ~1,200-dish subscription menu — separate table, macro-only (kcal/protein/carbs/fat), used **only** for meal-idea suggestions to help close a nutrient gap, never logged as an exact diary entry. This was Aravinth's explicit call after watching an attempt to import BFB dishes into `foods` turn into three rounds of schema fights (see "Abandoned" below) — mixing a messy, macro-only subscription menu into a catalog that's always assumed complete data was the wrong model, not a solvable bug.

The website's Meal Box tab already implements this correctly (built in an earlier session, untouched by any of this): its "Best for today's gap" mode ranks `meal_box_items` by how much of what's left of today's calorie/protein/carb/fat targets each dish would cover, has no "add to log" button (pure suggestion), and honestly falls back to the real `foods` catalog whenever the actual biggest gap is fiber or a micronutrient — something meal-box data has no way to speak to. Telegram had no equivalent until this session (see below).

## This phase: "fix the menu gap, make the customer journey easier"

Triggered by a real Telegram log attempt failing to match "Ragi semiya" in the catalog.

**1. Telegram self-serve onboarding (acquisition funnel) — shipped, tested.**
A cold Telegram contact with no account can now sign up and fill in their profile entirely in chat (buttons for categorical fields, text for numbers), starting anonymous and claiming a real email only once value is shown. Creates a synthetic Supabase Auth user (`tg-<chatId>-<hex>@telegram.invalid`) via the Auth Admin API; claiming a real email later handles the Postgres unique-email collision gracefully. New `telegram_links.source` / `onboarding_state` columns (`telegram_selfserve_onboarding.sql`).

**2. Unmatched Telegram food mentions now feed the catalog backlog — shipped, tested.**
Previously, "Couldn't match: X" was just shown to the user and discarded. `telegram-webhook.js` now writes every unmatched name into the existing `food_requests` table (same table the website's "request a food" button uses) — the right way to grow `foods` over time: Aravinth/team reviews the backlog and adds genuinely verified entries, rather than the catalog absorbing whatever a spreadsheet happened to contain.

**3. Telegram meal-box ideas — new, shipped, tested.**
Ported the website's Meal Box "gap mode" logic to Telegram: ask "what should I eat?" (or send `/meals`) and the bot ranks `meal_box_items` against what's left of today's macro targets, same scoring as the website. If the real biggest gap is fiber or a micronutrient that meal-box data can't see, it says so plainly and instead suggests real foods for that specific nutrient — same honest two-tier behavior as the website, never silent and never claiming a BFB dish covers something it has no data on. Shared scoring logic now lives in `lib/nutrition-core.js` (`rankMealBoxForGap`, `pickFoodFallbackForGap`, `MEALBOX_COVERED_GAP_LABELS`) so website and Telegram can't drift onto different numbers for the same gap — the website's own inline copy in `index.html` is unchanged (pre-existing, working code) but now has a shared counterpart Telegram calls into.

**Abandoned this session, reverted cleanly:** an earlier attempt to hand-vet and import 47 BFB dishes (`master-menu-with-macros.md`'s soups + salads) directly into `foods` as a "macro-only" tier, with a `micronutrients_complete` flag to suppress fiber/micronutrient gap claims for those rows. This went through three rounds of real schema failures (a Postgres NULL-typing quirk, then discovering `fiber` was `NOT NULL`, then discovering *every* micronutrient column was too) before Aravinth called it: don't mix the menu into the logging catalog at all. Good news — none of those 47 rows ever actually landed in `foods` (every failed SQL run rolled back cleanly), so there was nothing to clean up data-wise. The supporting code (`hasPartialMicronutrientData`, `CORE_MACRO_DEFS`, `gapRowUnknown`, the `includeMicros` option on `rankGapsForInsight`) has been fully reverted out of `lib/nutrition-core.js`, `api/telegram-webhook.js`, `lib/dietitian-agent.js`, and `index.html`. The one harmless leftover is the `foods.micronutrients_complete` column itself (added, then never populated) — it's inert and costs nothing to leave, but `revert_micronutrients_complete_column.sql` is provided if Aravinth wants it gone too. The abandoned SQL files (`menu_import_macro_only_batch1.sql`, `fix_foods_nutrient_columns_nullable.sql`, `foods_macro_only_tier.sql`) have been deleted — don't run anything by those names if an old copy turns up.

**Verified via test harnesses** (`test_telegram_webhook.js`, `test_telegram_selfserve_onboarding.js`, both in scratchpad, mock Supabase/Telegram/Anthropic and call the real handler functions) — all scenarios pass clean after both the revert and the new meal-ideas feature, including a scenario exercising `/meals`, free-text "what should I eat?" routing, and (via a standalone call) the honest fiber/micronutrient fallback path.

## Pending / next up

- **Keyword/synonym expansion pass** (approved earlier: "do a pass on the current catalog") — still blocked on Aravinth exporting `select name, keywords from public.foods order by name;` from the Supabase SQL editor and sending the result.
- `foods` grows only through genuinely verified entries from now on — likely sourced from the `food_requests` backlog (item 2 above) as real logging misses accumulate, not from BFB's menu spreadsheet.
- Medical trends dashboard; appointment reminders/confirmations (deferred, admin-side); voice/photo handling in the bot; Hindi/regional-language support.

## Deploy checklist for this phase's changes

Deploy the updated `index.html`, `api/telegram-webhook.js`, `lib/nutrition-core.js`, `lib/dietitian-agent.js` to Vercel. Run `telegram_selfserve_onboarding.sql` in the Supabase SQL editor if not already done. `revert_micronutrients_complete_column.sql` is optional cleanup, not required. `api/dietitian-chat.js` is unchanged this phase.
