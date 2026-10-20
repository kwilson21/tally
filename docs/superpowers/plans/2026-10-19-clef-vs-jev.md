# Measuring Clef against Jev on the demo seed (#TBD)

- **Date:** 2026-10-19
- **Decision:** 136. **Do not build until decision 136's docs PR has merged.** Nothing in the app changes: decision 9 (Jev) stands until the owner reads the results.
- **Spec:** §7 (the Jev call, the threshold, the one-module boundary), §11 Testing (no real service in tests), §12 Later list (the Clef line).
- **Builder:** a Haiku 5.5 subagent in its own worktree, tests first (CLAUDE.md work split). Check every API against the current Cloudflare docs before using it. Never call the real Jev or Workers AI while building or verifying: the tests fake both.
- **Before briefing the builder:** run decision 129's read-only brief check. The brief has 3+ tasks and more than one plausible approach.

## Goal

One command prints a side-by-side report of Jev, Clef and Clef-flash answering Tally's own call about the demo's transactions, so the owner can decide on decision 9 with numbers.

## What the docs say (checked 2026-10-19)

- **Models:** `@cf/cloudflare/clef` (27B) and `@cf/cloudflare/clef-flash` (9B), called with `env.AI.run(modelId, body)`. The body's `model` field is `"clef"` or `"clef-flash"`. The rest is the System One body Jev takes: `state`, plus `questions` with 1 to 64 entries of type `noul`, `choice` or `score`, each with `instructions` and, for `choice`, `criteria`. Sources: developers.cloudflare.com/workers-ai/models/clef/ and /clef-flash/.
- **Switching:** the Oct 1 changelog says a Jev integration switches "by changing the endpoint and model". A choice answer is read at `answers.<id>.choice` and returns "the chosen option, a probability per option, and a confidence value". A noul answer is read at `answers.<id>.noul`. The docs neither name the confidence field nor show a whole response. The run will show both.
- **Limits:** no documented limit on how many options a choice question may have, and Tally sends up to 51, twice. The context window is 64K tokens for Clef and 24K for Clef-flash.
- **Price:** input costs $0.240 per million tokens for Clef and $0.038 for Clef-flash. Output is free (Oct 9 changelog).
- **Local dev:** under `wrangler dev`, AI bindings always run remotely and are billed. Set `"remote": true` on the binding (developers.cloudflare.com/workers/development-testing/).
- **Wrangler 4.136.3:** `wrangler dev --help` lists `-c/--config` and `--env-file <path>` ("Path to an .env file to load").
- **Types:** `@cf/cloudflare/clef*` isn't in the generated `AiModels` list (worker-configuration.d.ts, no match for "clef"). The call needs a cast.

## Choices made here (internals, not the owner's)

- **A Worker of its own, never deployed:** `scripts/compare-models/worker.ts`, with its own `scripts/compare-models/wrangler.jsonc`:
  - `name: "tally-compare-models"`, `main: "worker.ts"`, `compatibility_date: "2026-09-22"`
  - `ai: { binding: "AI", remote: true }`, `workers_dev: false`
  - no D1, no assets, no routes, no crons.

  The app's wrangler.jsonc stays untouched, so `npm run dev`, the tests and CI never get an AI binding.
- **Tally's exact call:** every model is asked through `askJev` (src/ai/categorize.ts:60) with `{ details: true, people: [{ id: 1, name: "Everyone" }] }`, the demo's one person (src/demo/reset.ts:112). That way the request, the parser and the 10-second timeout are the app's own, and the call carries the nine questions the nightly sort asks when every switch is on.
  - **Jev** gets `env.JEV_API_KEY` and the Worker's `fetch`.
  - **Clef and Clef-flash** each get a `fetchImpl` adapter, `viaWorkersAI(ai, modelId, selector)`. It parses the request body, sets `model` to the selector and awaits `ai.run(modelId, body)`. It returns the result as a JSON `Response` with status 200, or status 502 when `run` throws. They get an empty api key.
  - **The parser stays as it is.** If Clef's answers come back unreadable, that is a result: the report shows it.
- **Cases (a new family's first sync):**
  - Start from `buildSeed(today)` (src/demo/seed.ts:438), skipping split parts (`parentId` set) and split parents (`isSplit` true).
  - There is one case per raw name and direction (money in or money out), and the first row wins.
  - `displayName` is the row's `merchantName` (Plaid's) or null. `accountType` is the row's account's `type`.
  - No `merchantCategoryHistory`, note, kind or person is sent, because a new family has none yet.
  - The right answer is the seed's category name, whatever its source. Rows the seed leaves without a category have no right answer: they are the demo's "Jev wasn't sure" rows. Each case also carries the seed's three flags.
- **Two category lists:**
  - **Demo:** the demo's 7 (`buildSeed(today).categories` in `sortOrder`).
  - **Fifty:** those 7 then these 43, which is decision 37's most: Utilities, Electricity, Water, Phone, Internet, Streaming, Subscriptions, Gym, Health, Doctor, Dentist, Pharmacy, Health Insurance, Car Insurance, Home Insurance, Life Insurance, Car Payment, Car Repair, Parking, Tolls, Public Transit, Rideshare, Travel, Hotels, Flights, Clothing, Shoes, Haircuts, Gifts, Charity, Pets, Vet, Hobbies, Crafts, Books, Electronics, Home Repair, Garden, Furniture, Postage, Bank Fees, Taxes, Allowance.
  - Some of these are fair answers too (Gym for CITY GYM MEMBERSHIP, which the demo calls Household). The report says so under the fifty-list tables.
- **Scoring is Tally's own:** each answer goes through `decide(answer, categories, JEV_THRESHOLD)` (src/ai/decide.ts:48, src/ai/categorize.ts:8). Category ids are each name's 1-based position in its list. So "applied" means exactly what Tally would store, 0.80 itself included (src/ai/confidence.ts:8).
- **One call at a time:** one model, one list and one case at a time, in order, with no retries. That is about 40 cases × 2 lists × 3 models, about 240 calls, and under $0.25 at the prices above.
- **The report:** `GET /` returns it as markdown. The demo's data is invented and already public, so printing it is fine. The Worker has no D1 binding, so it can't read anything else.

## Tasks (tests first, each one red before its code)

All tests go in `test/compare-models.test.ts`, which imports from `../scripts/compare-models/` as test/capture.test.ts:8 imports from `../scripts/`.

1. **Cases:** `buildCases(seed)` in `scripts/compare-models/score.ts`.
   - **Test:** use a small hand-made `Seed` holding:
     - a split purchase with its two parts
     - a store seen three times
     - a refund of that store's purchase (money in)
     - a store with a Plaid `merchantName`
     - a row with no category
     - a transfer
   - **It gives:** one case per raw name and direction; split rows skipped; `displayName` from `merchantName`; `accountType` from the account; a null answer for the row with no category; and the flags as seeded.
   - **Also:** `buildCases(buildSeed("2026-10-19"))` has at least 30 cases, and every demo category is some case's answer.
2. **Category lists:** `demoCategories(seed)` and `fiftyCategories(seed)`.
   - **Test:** the fifty list has 50 different names, and its first 7 are the demo's, in `sortOrder`.
3. **Scoring:** `scoreCase(kase, result, categories)` returns one outcome.
   - A failed call is `failed`, with its status (or `no response`).
   - A case with a right answer is `right`, `wrong`, `left: none fit` or `left: unsure`. Left means `decide` applied nothing: `none fit` when `noneFit` is set, otherwise `unsure`.
   - A case without a right answer is `applied`, `left: none fit` or `left: unsure`.
   - Each flag is `hit`, `false alarm`, `missed` or `quiet`, comparing `decision.flags` with the seed's.
   - It also keeps the pick, its confidence and the call's milliseconds.
   - `summarize(rows)` counts each outcome. It also gives the confidence's lowest, middle (median) and highest over the answered cases, and the middle and slowest milliseconds.
   - **Tests:** use hand-made `JevResult`s for every outcome, including:
     - confidence exactly 0.80 (applied)
     - 0.7999 (unsure)
     - "None of these fit" at 0.95 (none fit)
     - an `ok: false` result with status 429, and one with status null.
4. **Report:** `formatReport(...)` returns markdown.
   - For each list, a summary table with one row per model. Columns: calls that worked; right; wrong; left (none fit / unsure); applied with no right answer; flags (hit / false alarm / missed); confidence (low / middle / high); middle and slowest ms.
   - Then a per-case table: raw name, the demo's category, then each model's pick and confidence, with ✓ on a pick Tally would apply.
   - Under the fifty-list tables: "Some of the 50 names fit these stores as well as the demo's own category does, so read the picks, not just the count."
   - Then each model's first unreadable response (raw JSON) and first `usage` object, when there was one.
   - Plain words throughout, because the owner reads it.
   - **Tests:** the model rows; a ✓ on an applied pick; a failed call's status; the fifty-list line; a raw unreadable response appearing once.
5. **Worker:** in `scripts/compare-models/worker.ts`.
   - `runComparison(env, fetchImpl = fetch)` builds the cases from `buildSeed(todayIn(DEFAULT_TIME_ZONE))` (src/dates.ts:20, :40, the demo's own zone), and asks each model over both lists.
   - While doing so, it records each model's first response body that askJev couldn't read and its first `usage`. To get them, a thin wrapper around each `fetchImpl` clones the response.
   - Without `JEV_API_KEY`, Jev's rows say "skipped: no JEV_API_KEY" and Clef still runs.
   - The default export's `fetch` returns `runComparison`'s report as `text/markdown`.
   - **Tests:**
     - a fake `AI` whose `run` records its model id and body and returns a Jev-shaped answer: Clef is called as `@cf/cloudflare/clef` with `model: "clef"`, and Clef-flash likewise
     - a throwing `run` makes that model's calls `failed` with 502
     - no `JEV_API_KEY` skips Jev
     - Jev's fake `fetchImpl` receives `JEV_URL` with the bearer key.
6. **Config, types and how to run it.**
   - Write `scripts/compare-models/wrangler.jsonc` as above.
   - Add `"../scripts/**/*.ts"` to test/tsconfig.json's `include`, so `npm run typecheck` checks the new files.
   - Cast `ai.run`'s model id, because Clef isn't in the generated types.
   - At the top of worker.ts, write a comment of a few lines saying what it is and how to run it, so it's explainable in one plain sentence:

     ```bash
     npx wrangler dev --config scripts/compare-models/wrangler.jsonc --env-file <path to .dev.vars> --port 8799
     ```

     then

     ```bash
     curl -s http://localhost:8799/
     ```

     The comment also says it needs `wrangler login`, bills Workers AI, and must never be deployed.

Once tests pass, ask: is there a simpler way than what you just wrote? Reuse the app's helpers, cut what isn't needed, rerun the tests, and say what you simplified.

## Running it (after the fresh verifier passes, not by the builder)

A fresh Haiku 5.5 subagent runs the two commands above from the verified head, with the main checkout's `.dev.vars` passed through `--env-file`. It returns the report. The report goes on the issue and in the PR description, and is run again if a review changes the script. If every Clef call comes back unreadable, stop: the main session reads the raw response and decides what the adapter maps. `src/ai/categorize.ts` stays as it is.

## Not in this issue

- Any change to the app, `src/ai/categorize.ts`, the threshold or the app's wrangler.jsonc.
- Production data. Measuring on the family's own categories is the owner's call after this.
- Clef-omni, retries, or calls in parallel.

## Verification (the fresh verifier, CLAUDE.md)

- Run every CI `check` command: `npm test`, `npm run test:feedback-integration`, typecheck, lint, the build, and both `wrangler deploy --dry-run` envs (unchanged).
- Also run `npx wrangler deploy --dry-run --config scripts/compare-models/wrangler.jsonc`. It must bundle `askJev`, `decide` and `buildSeed`.
- Run the e2e against a migrated `wrangler dev` (unchanged), and check the scope against this brief.
- No real Jev or Workers AI call.

## Confidence

| Task | Evidence | Score | What's unknown (under 8) |
|---|---|---|---|
| 1 Cases | src/demo/seed.ts:38-56 (`SeedTransaction`), :438 (`buildSeed`), :551-577 (the split Costco parent and parts) | 8 | — |
| 2 Lists | src/demo/seed.ts:89 (`CATEGORIES`, 7 with `sortOrder`); decision 37 (50 at most) | 9 | — |
| 3 Scoring | src/ai/decide.ts:48 (`decide`: `categoryId`, `noneFit`, `flags`); src/ai/confidence.ts:8; src/ai/categorize.ts:8 | 8 | — |
| 4 Report | new, plain markdown | 8 | — |
| 5 Worker | src/ai/categorize.ts:60 (`fetchImpl` and options), :76 (`model: "jev-latest"`), :171 (timeout); test/categorize.test.ts:16 (`fakeFetch`) | 7 | Whether `env.AI.run` returns Clef's answer as-is (the REST API wraps it in `result`), and the name of a choice's confidence field. The run shows both, and the report keeps the first unreadable response. |
| 6 Config | `wrangler dev --help` on 4.136.3 (`--config`, `--env-file`); the development-testing page (AI always remote, `remote: true`); test/tsconfig.json `include`; test/capture.test.ts:8 | 7 | Whether `--env-file` fills `env` the way `.dev.vars` does. If not, the runner says so and stops, and never copies `.dev.vars` anywhere. |

**Argue the opposite.**
- *Send ~40 requests by hand with curl.* That would retype Tally's request and skip its parser and `decide`. So it couldn't tell whether Tally's call works on Clef unchanged, which is the main question, and it couldn't be run again when the threshold is checked again.
- *Use production's own categories as the right answers instead; they're much better labels.* The owner asked for the demo, and running on production data is the owner's call next.
- *40 cases can't rank accuracy.* That's true. The run shows whether the call works, and how each model treats clear stores and unclear ones. The report gives its case count, and the main session says so when it sends the numbers.
- *Make it a vitest test with real calls.* CI must never call a paid service or hold a secret, so the real run stays a command a person starts.

Kept from the counter: the report says how many cases it has.
