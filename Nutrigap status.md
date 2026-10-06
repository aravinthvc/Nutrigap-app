---
description: NutriGap / NutriGap_Bot build status — what's shipped, what's pending, what the user needs to do next. Read before resuming work on this project.
---

# NutriGap status (as of 2026-10-06)

Stack: Vercel serverless functions (`api/*.js`, CommonJS, no framework) + Supabase (Postgres + RLS). No local dev tooling — Aravinth deploys by copy-pasting files into Vercel/GitHub and SQL into the Supabase SQL editor. Telegram bot (`NutriGap_Bot`, webhook at `api/telegram-webhook.js`) is a second channel onto the same account/data as the website (`index.html`).

## This phase: "fix the menu gap, make the customer journey easier"

Triggered by a real Telegram log attempt failing to match "Ragi semiya" in the catalog.

**1. Telegram self-serve onboarding (acquisition funnel) — shipped earlier this phase, tested.**
A cold Telegram contact with no account can now sign up and fill in their profile entirely in chat (buttons for categorical fields, text for numbers), starting anonymous and claiming a real email only once value is shown. Creates a synthetic Supabase Auth user (`tg-<chatId>-<hex>@telegram.invalid`) via the Auth Admin API; claiming a real email later handles the Postgres unique-email collision gracefully (keeps the chat on its own profile, points them to linking via the website instead). New `telegram_links.source` / `onboarding_state` columns (`telegram_selfserve_onboarding.sql`).

**2. Unmatched Telegram food mentions now feed the catalog backlog.**
Previously, "Couldn't match: X" was just shown to the user and discarded. `telegram-webhook.js` now writes every unmatched name into the existing `food_requests` table (same table the website's "request a food" button uses), so there's now one real backlog of what people are trying to log that isn't in the catalog yet.

**3. Macro-only food import + "don't guess unverified nutrients" data-quality tier.**
`boxfullofbeans/master-menu-with-macros.md` (the ~1,250-dish BFB menu) turned out to have real data-quality problems on inspection — typo'd macros (impossible values like CHO=1563), heavy near-duplicates, and most rows being composite combo-meals rather than single dishes. Per Aravinth's call, did **not** bulk-import it. Instead:
- Added a `foods.micronutrients_complete` column (`foods_macro_only_tier.sql`), default `true` (no change to the existing catalog).
- Hand-vetted and imported a first batch of 47 clean single-dish items (29 soups + 18 salads from that doc), each macro-validated by a 4-4-9 kcal reconciliation check, with all micronutrient columns `NULL` (not 0) and `micronutrients_complete = false` (`menu_import_macro_only_batch1.sql`).
- Threaded a "partial data" concept through the whole stack so a macro-only food in today's log suppresses nutrient gap *claims* it can't back up, instead of silently showing a false deficiency (missing data read as zero): `lib/nutrition-core.js` (`hasPartialMicronutrientData`, `rankGapsForInsight(..., {includeMicros})`), `api/telegram-webhook.js` (gap summary + dietitian context), `lib/dietitian-agent.js` (explicit system-prompt instruction), and `index.html` (website gap panel shows a caveat instead of a false "all on target" or false deficiency, and the AI calls from the website exclude guessed nutrients the same way).
- Checked `api/dietitian-chat.js` (website Dietitian tab) for the same drift risk — it already requires `lib/dietitian-agent.js` and shares the exact prompt with Telegram (fixed in an earlier session, Sep 25). A stray, stale duplicate of the old inline-prompt version existed at the wrong path (`outputs/dietitian-chat.js` instead of `outputs/api/dietitian-chat.js`) and caused a false alarm this session that it needed re-fixing — confirmed via a mocked Anthropic-call dry run that the real file is correct, and deleted the stray duplicate.

**Deploying `menu_import_macro_only_batch1.sql` took three rounds to get right — all three verified against a real local Postgres, not just read over:**
1. **`column "fiber" is of type numeric but expression is of type text`.** Every row in the `insert into ... select ... from (values ...) as v(...)` has a literal `NULL` for fiber and all 15 micronutrient columns — with no non-null value anywhere in those columns, Postgres can't infer a numeric type and defaults to `text`. Fixed with explicit `::numeric` casts in the outer `select`.
2. **`null value in column "fiber" ... violates not-null constraint`.** `public.foods.fiber` is `NOT NULL` — safe until now (every existing food had real fiber data), but the source spreadsheet for this batch has no fiber column at all, so there's no honest number to put there. Fixed by widening the partial-data concept to cover fiber, not just vitamins/minerals (`micronutrients_complete = false` now means "nothing beyond calories/protein/carbs/fat is known," fiber included) — new `CORE_MACRO_DEFS` in `lib/nutrition-core.js` (macros minus fiber), reworded partial-data notes in `api/telegram-webhook.js`/`lib/dietitian-agent.js`, and `index.html`'s macro panel now shows a "Not tracked today" row for fiber instead of a fake 0g bar (new `gapRowUnknown()`; `computeRollingWindowPatterns` exempts fiber on a partial day too).
3. **`null value in column "iron" ... violates not-null constraint`.** Turned out fiber wasn't the only NOT NULL column beyond the core macros — *every* micronutrient column (iron, calcium, and all 13 vitamin columns) is NOT NULL in production, for the same original reason (every existing food had full data). Rather than chase this column-by-column, the migration (renamed `fix_foods_nutrient_columns_nullable.sql`, was `fix_foods_fiber_nullable.sql`) now drops NOT NULL on all 16 columns (fiber + all 15 micronutrients) in one `alter table` with multiple `alter column` clauses. Verified end-to-end against a local Postgres 16 table with all 16 columns set NOT NULL (matching what production turned out to be): reproduced the exact iron error, ran the migration, then confirmed the import succeeds (`INSERT 0 47`) and both the migration and the import are still idempotent on a second run.
- **For any future macro-only batch:** the `::numeric` casts, treating fiber as part of the unverified tier (not a core macro), and the "all 16 nutrient columns need NOT NULL dropped, not just fiber" fact are all now established patterns — batch 2 onward should need none of this rediscovered.

**Verified via test harnesses** (`test_telegram_webhook.js`, `test_telegram_selfserve_onboarding.js`, both in scratchpad, mock Supabase/Telegram/Anthropic and call the real handler functions) — all scenarios pass clean after every code change in this phase.

## Pending / next up

- **Keyword/synonym expansion pass** (approved: "do a pass on the current catalog") — blocked on Aravinth exporting `select name, keywords from public.foods order by name;` from the Supabase SQL editor and pasting/sending the result.
- **More macro-only batches** from `master-menu-with-macros.md` beyond the 47-item soups+salads batch, if the small-batch approach is working out — needs the same hand-vetting (the source doc is not safe to bulk-import as-is); the schema/casting gotchas above are already solved for batch 2+.
- Meal-box gap recommendations: matching BFB's 1,198-dish `meal_box_items` catalog to someone's specific nutrient shortfall (separate from the `foods` catalog).
- Medical trends dashboard; appointment reminders/confirmations (deferred, admin-side); voice/photo handling in the bot; Hindi/regional-language support.

## Deploy checklist for this phase's changes

Run in order in the Supabase SQL editor: `foods_macro_only_tier.sql` → `fix_foods_nutrient_columns_nullable.sql` → `menu_import_macro_only_batch1.sql` (latest version — re-copy it, it went through 3 fix rounds) → `telegram_selfserve_onboarding.sql` (if not already run). Then deploy the updated `index.html`, `api/telegram-webhook.js`, `lib/nutrition-core.js`, `lib/dietitian-agent.js` to Vercel. `api/dietitian-chat.js` is unchanged this phase (already correct).
