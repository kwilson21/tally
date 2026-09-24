# Phase 1e (Jev categorization) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jev sorts uncategorized transactions, following spec §7's order (a person, then a merchant rule, then Jev). One pull request (#12):
1. `src/ai/categorize.ts`: the only place that talks to Jev. It makes one `fetch` per transaction, asking the category and all three flags together.
2. A nightly step, `categorizePending`:
   - First it applies merchant rules to uncategorized transactions.
   - Then it asks Jev about the rest, applying answers at or above the confidence threshold.
   - It runs in the scheduled handler, right after the demo reset.
3. The edit sheet says when Jev picked the category ("Picked by Jev · 93% sure"), so a person can see it and change it.

**Architecture:**
- The nightly job is the only caller. AI never runs while a page is loading (spec §10: "AI calls never block a page").
- `categorize.ts` returns plain answers and decides nothing.
- A pure function, `decide(answer, threshold)`, turns the answers into column values. That's the unit-tested core: code decides, Jev only suggests.
- The database updates only rows whose `category_source` is still null. So a person's choice or a merchant rule is never overwritten, even if one lands mid-run.

**Tech stack:** plain `fetch` (decision 19), D1, and Cron Triggers (the demo already has `0 9 * * *`). There are no new dependencies. Tests fake Jev at the `fetch` boundary (spec §11).

**Spec:** §4 (Jev, Cron), §4.2 (`JEV_API_KEY`), §7 (priority, the bundled call, the threshold, Jev's inputs), §10 (Jev unavailable → leave uncategorized, retry nightly; never log transaction details). **Decisions:** 9, 18, 19. **Issue:** #12.

**Checked on 2026-09-24.** docs.typesafe.ai is blocked here. So this was checked against the types and code of Jev's official SDK, `@typesafe-ai/sdk` 0.6.0, downloaded to the scratchpad and **not** installed. The executor re-checks against docs.typesafe.ai before Task 2.
- **Request:** `POST https://api.typesafe.ai/v1/systemone` with headers `Authorization: Bearer <key>` and `Content-Type: application/json`. The body is `{ state, questions, model }`, and the model is `"jev-latest"`.
- **Questions:**
  - Choice: `{ type: "choice", instructions, criteria: { <label>: <description or null> } }`
  - Noul: `{ type: "noul", instructions, criteria?: { true?, false? } }`
- **Answers:** `answers.<name>` is either `{ type: "choice", choice, confidence, probabilities }` or `{ type: "noul", noul }`. `noul` is the probability of yes, from 0 to 1.
- **Errors:**
  - 401 authentication; 403 denied; 422 validation.
  - 429 rate limit, with `Retry-After` / `retry-after-ms` headers.
  - 5xx server errors.
  - The SDK defaults to a 10-second timeout per attempt and retries 408, 429 and 5xx.
- **Request ID:** the `x-typesafe-request-id` response header. This is safe to log; nothing else from Jev is logged.

**Out of scope, with where each part goes:**
- **Plaid's own category hint** (a spec §7 input): the schema has no column for it until Phase 2 sync. The state object gains it then.
- **Acting on the transfer and reimbursement flags:** they're stored, but excluding those transactions from the budget comes with exclusions in Phase 3 (#27). Only `flag_income` affects today's math: income is left out of spending (spec §6).
- **Showing Jev's below-threshold guess** ("Jev thinks Eating Out, 62%"): that needs a column for the suggested category. It goes on the Later list if wanted.
- **Workers AI name suggestions:** Phase 4.

---

## Owner review: choices this plan makes

1. **When Jev runs:** in the nightly job only, after the demo reset. The live demo therefore starts each morning with Jev's picks applied, and the transactions Jev wasn't sure about stay in "needs a category" for visitors. CI, screenshots and local dev have no key, so Jev is skipped there. Their pages still show 12 to categorize, so screenshots and the E2E are unaffected.
2. **Threshold: 0.80 to start**, as one constant in `categorize.ts`. The same number applies to the category's `confidence` and to each flag's `noul` probability. Spec §7 says to set it after checking Jev's output on the seed data (Task 5). Changing it later is a one-line PR.
3. **"Jev already looked" is recorded in `category_confidence`.** When Jev answers below the threshold, the category stays null (source null), but its confidence is stored.
   - The nightly job asks Jev only about rows with a null source **and** a null confidence.
   - So a transaction Jev was unsure about isn't re-asked (and re-billed) every night. Only calls that failed (timeouts, 429s, outages) are retried.
   - A person choosing a category clears the confidence, as `saveEdit` already does.
   - This uses the existing column and needs no migration. It gets decision 27.
4. **A cap of 40 Jev calls per run.** That's enough for a day of family transactions and the demo's 12. It also stays under Workers' per-invocation subrequest limit on any plan; the executor confirms the current number in Cloudflare's docs. Anything left over waits for the next night.
5. **Failures stop the run, and there are no in-run retries:**
   - **429, 5xx or timeout:** the run stops. The rows stay untried, and the next night retries them (spec §10). That's simpler than backoff, and nothing waits on it.
   - **401, 403 or 422:** it logs `jev: <status> <request-id>` once and stops.
   - It never logs the key, the request, or any transaction details (CLAUDE.md).
6. **What Jev is told** (the `state` object): the raw name, the merchant display name (if any), the amount in cents with the direction ("money out" / "money in", Plaid's sign convention), and the account type. There are no dates, notes or account names.
7. **The edit sheet shows Jev's picks.** When `category_source = 'jev'`, a muted line under the category reads "Picked by Jev · 93% sure". Choosing a category makes it the person's choice, as it already does.

---

## File structure

| File | Change |
|---|---|
| `src/ai/categorize.ts` | New: `askJev(input, categories, apiKey, fetchImpl?)`, the only Jev call, plus the `JEV_THRESHOLD` constant |
| `src/ai/decide.ts` | New, pure: `decide(answer, categories, threshold)` → `{ categoryId, source, confidence, flags }` |
| `src/categorize-pending.ts` | New: `categorizePending(env, fetchImpl?)`. Runs merchant rules first, then Jev, with the cap and the stop-on-failure rule. |
| `src/db/transactions.ts` | `pendingForJev(db, limit)`, `applyMerchantRules(db)`, `saveJevResult(db, id, result)` (guarded by `category_source IS NULL`) |
| `src/index.tsx` | Call `categorizePending` in `scheduled` after the reset, only when `JEV_API_KEY` is set |
| `src/routes/transactions.tsx` | The "Picked by Jev" line in `EditSheet` |
| `worker-configuration.d.ts` / `test/env.d.ts` | Type `JEV_API_KEY` as an optional secret |
| `docs/decisions.md` | Decision 27 (choice 3). Record the threshold choice after Task 5. |
| spec §7 | Record choices 1–6 as clarifications, with the threshold value once it's set |

---

### Task 0: Branch, spec, decision

- [ ] Branch from `main`. Add choices 1–6 to spec §7, and write decision 27.

### Task 1: `decide` (pure, tested first)

- [ ] `test/decide.test.ts`:
  - At or above the threshold: the category is applied with `source: "jev"` and the confidence.
  - Below the threshold: `categoryId: null` and `source: null`, but the confidence is still returned (choice 3).
  - An unknown label (not one of the categories) is treated as below the threshold.
  - Each flag is set only if its `noul` is ≥ the threshold. Flags are independent of the category.
  - Exactly at the threshold counts as "at".

### Task 2: `askJev` (tested first against a fake `fetch`)

- [ ] `test/categorize.test.ts`, with a fake `fetch` that records the request:
  - It makes one request with the URL, method and headers above.
  - The body holds exactly one `category` Choice (whose criteria are the category names) plus `transfer`, `reimbursement` and `income` Nouls.
  - `model` is `"jev-latest"`.
  - `state` contains the choice-6 fields and nothing else.
  - A 200 response is parsed into `{ category: { label, confidence }, flags: { transfer, reimbursement, income } }`.
  - A 429, 5xx, timeout (via `AbortSignal.timeout`), 401 or 422 each come back as a typed failure (`{ ok: false, retryable, status, requestId }`), never a thrown error.
  - A malformed body counts as a non-retryable failure.
- [ ] Implement it with a 10-second timeout, no SDK, and no logging inside it.

### Task 3: Database helpers (route-runtime tests first)

- [ ] `test/categorize-db.test.ts`, on the seed:
  - `applyMerchantRules` sets `merchant_rule` only on rows with a null source whose merchant has a default category. It never touches `user` rows.
  - `pendingForJev(db, 40)` returns the 12 seed rows, then fewer after one is given a confidence.
  - `saveJevResult` writes the category, source, confidence and flags. It does nothing if the row's source became non-null in the meantime.
  - It doesn't touch `updated_by`: Jev isn't a person. The executor checks that the Home and Transactions counts follow.

### Task 4: `categorizePending` and the scheduled handler (tests first)

- [ ] `test/categorize-pending.test.ts`, with a fake `fetch`:
  - Confident answers are applied, and uncertain ones leave the row null with its confidence stored.
  - Needs-category drops by exactly the confident count, and Home's count agrees.
  - A 429 on the third call stops the run: two are applied, the rest stay untried, and a second run picks them up.
  - At most 40 calls are made.
  - No key means no calls at all.
- [ ] Update `test/scheduled.test.ts`:
  - Reset, then categorize, in that order.
  - Without `JEV_API_KEY` it only resets, as today.
  - A Jev failure never fails the reset.
- [ ] Wire it into `src/index.tsx` after `resetDemo`. Production calls it too; with no data yet, it does nothing until Phase 2 sync adds transactions.

### Task 5: Set the threshold on the seed data (spec §7), after the first live run

The key stays only on the demo Worker (owner's choice): no key in this environment or CI.
- [ ] Ship with 0.80. After the owner merges and the demo is deployed, the 09:00 UTC run asks Jev about the seed's 12 uncategorized transactions, using the Worker's own `JEV_API_KEY`.
- [ ] The next morning, read the results from the demo database:
      `wrangler d1 execute DB --env demo --remote --command "SELECT t.raw_name, c.name AS category, t.category_source, t.category_confidence, t.flag_income, t.flag_transfer, t.flag_reimbursement FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.category_source = 'jev' AND t.category_confidence != 0.94 OR (t.category_source IS NULL AND t.category_confidence IS NOT NULL)"`
      This is fake seed data, so reading it is fine; it isn't logged anywhere.
- [ ] Review the 12 with the owner: right and wrong picks against their confidences. Keep 0.80 or change it in a one-line PR, and record the numbers in decision 27's follow-up entry.

### Task 6: Edit sheet line, docs, checks, PR

- [ ] Route test first: a `jev` row's sheet shows "Picked by Jev · 93% sure", and a `user` row's doesn't. Then add the line.
- [ ] Run `npm run build && npm run typecheck && npm run lint && npm test`, `npm run e2e`, `npm run screenshots`, and the demo dry run.
- [ ] Open the PR with "Closes #12". It's a UI PR, because the sheet line changes; the owner merges.
- [ ] After merge, deploy with `npx wrangler deploy --env demo`. The next 09:00 UTC run applies Jev on the live demo. Check the next morning with a remote query of Jev's rows (counts only), and on the site.

---

## Risks

| Risk | Guard |
|---|---|
| Jev mislabels something with high confidence | The threshold is set from real output (Task 5). The sheet shows "Picked by Jev" and a person can change it. The demo resets nightly. |
| A person's choice gets overwritten | Every write is `WHERE category_source IS NULL`, tested, including a change that lands mid-run. |
| Cost from re-asking uncertain rows nightly | The confidence marker (choice 3) and the 40-call cap. |
| The key or transaction data leaks into logs | The only log line is the status plus the request ID. There's no SDK and no body logging. A test asserts the log text. |
| Jev is down | The run stops quietly, the rows stay for people to categorize, and the next night retries. |
