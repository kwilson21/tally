# Tally — Design Spec

- **Date:** 2026-09-22
- **Status:** Draft, awaiting owner review
- **Owner:** Kazon Wilson

## 1. What Tally is

Tally is a family budgeting app. It pulls in bank transactions automatically, sorts them into categories with a small AI model, and shows the household how much is left to spend this month.

It serves two audiences from one codebase:

1. **The owner's household**: a private app behind a login wall, with real bank data.
2. **The public**: a portfolio demo at `demo.thesuperhuman.us` with fake data only.

Tally replaces the owner's Django app (`personal-finance-app`). That app stays in place until Tally has fully taken over its job.

## 2. Guiding rules

1. **Explainable in one sentence.** Every part of the system must be explainable in one plain sentence, and this spec gives that sentence for each part. If the owner can't explain a part in their own words, it doesn't go in.
2. **The spec is the source of truth.** Nothing gets built unless it's in this spec. New ideas go on the Later list (§12) until the spec is updated.
3. **Decisions stay decided.** Settled choices are recorded in `docs/decisions.md` with their reasons. Reopening one takes a new decision entry, not a silent change.
4. **Simplicity beats keywords.** Tools are picked because they're the simplest fit, not because they appear on job postings.
5. **The server owns all state.** No client-side state framework.
6. **AI suggests; code calculates; people decide.** AI models classify and suggest. Deterministic code does all money math. People can override any AI output.

## 3. Scope

All eight features are in scope and ship across phases (§11):

| # | Feature |
|---|---|
| 1 | Budget vs. spent this month, with category left and safe to spend |
| 2 | Bills: upcoming, overdue, paid |
| 3 | Transaction list: browse, search, recategorize |
| 4 | Splitting a transaction across categories |
| 5 | Excluding transactions from the budget (transfers, reimbursements, one-offs) |
| 6 | Spending trends: month over month, by category |
| 7 | Account balances and net worth over time |
| 8 | Documents: stored statements and receipts (PDF) |

Also in scope: AI-suggested merchant name cleanup (accept or reject), the demo banner, a "Things to try" list, and a "How it works" page.

**Household model:** one shared household. Everyone who can log in sees and edits the same data. Changes record who made them.

**Data:** fresh start. Nothing is migrated from the Django app. Banks are linked again, and Plaid backfills the history.

## 4. Architecture

> One small TypeScript server on Cloudflare builds each page, stores data in a SQLite database, pulls bank data from Plaid, and uses two AI models: Jev for categories and Workers AI for merchant names.

| Part | Job, in one sentence |
|---|---|
| **Cloudflare Worker (Hono, TypeScript)** | Handles every request: builds pages, receives Plaid webhooks, and runs scheduled jobs. |
| **HTMX** | When you click something, HTMX asks the server for a piece of new HTML and swaps it into the page. |
| **Tailwind CSS** | Styles the pages with utility classes, compiled into one CSS file. |
| **Workers static assets** | Serves the CSS file, `htmx.js`, and icons. |
| **D1 (SQLite)** | Stores all data. |
| **R2** | Stores document PDFs; D1 keeps only each file's name and details. |
| **Plaid (REST over `fetch`)** | Supplies accounts, transactions, and balances from the family's banks. |
| **Jev (TypeSafe AI)** | Picks a category and flags for each transaction, with a confidence score. |
| **Workers AI** | Suggests a clean merchant name, which a person accepts or rejects. |
| **Cron Triggers** | Run the daily Plaid sync (a backup for webhooks), retry uncategorized transactions, and reset the demo nightly. |
| **Cloudflare Access** | A login wall with the family's emails in front of the family app; the app has no login code of its own. |
| **Wrangler** | The command-line tool that deploys the Worker and stores secrets. |

### 4.1 Two deployments, one codebase

Wrangler environments deploy the same code twice:

| | `production` (family) | `demo` (public) |
|---|---|---|
| Hostname | Chosen in Phase 2 (see §11); intended to eventually take over `finance.thesuperhuman.us` | `demo.thesuperhuman.us` |
| D1 database | `tally-prod` | `tally-demo` |
| R2 bucket | `tally-prod-docs` | `tally-demo-docs` (fake PDFs) |
| Plaid | On | **Off.** No Plaid secrets exist in this environment. |
| Jev / Workers AI | On | On |
| Login | Cloudflare Access | Public, with a demo banner on every page |
| Nightly job | Sync plus categorization retry | Reset the database and bucket to the seed |

**How real data stays out of the demo:** the demo database is only ever built from seed files in the repo. The demo environment has no Plaid credentials and no binding to the production database or bucket, so no code path can reach real data.

### 4.2 Secrets

Secrets are stored with `wrangler secret put` and never committed. The owner enters every value.

| Secret | production | demo |
|---|---|---|
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | yes | no |
| `TOKEN_ENCRYPTION_KEY` (encrypts Plaid access tokens) | yes | no |
| `PLAID_WEBHOOK_URL` (plain config, not secret) | yes | no |
| `JEV_API_KEY` | yes | yes |

Local development uses a git-ignored `.dev.vars` file. The repo commits a `.dev.vars.example` with placeholder names only.

## 5. Data model

All money is stored as **integer cents**, because SQLite has no exact decimal type: `$12.34` is stored as `1234`. Code converts to dollars only when formatting for display.

| Table | Job, in one sentence | Key columns |
|---|---|---|
| `plaid_items` | One row per linked bank login, holding its encrypted token and sync position. | `id`, `access_token_encrypted`, `institution_name`, `sync_cursor`, `status` (`ok` / `needs_attention`), `linked_by`, `created_at` |
| `accounts` | Each checking, savings, or credit account and its current balance. | `id`, `plaid_item_id` (nullable, null for demo accounts), `plaid_account_id` (unique, nullable for demo accounts), `name`, `mask`, `type`, `subtype`, `is_liability`, `balance_cents`, `updated_at` |
| `balance_history` | One balance per account per day, for the net-worth chart. | `account_id`, `date`, `balance_cents` (unique on account + date) |
| `categories` | The household's category list. | `id`, `name` (unique), `icon`, `color` (token name, e.g. `cat-blue`), `sort_order`, `archived` |
| `budget_amounts` | How much a category gets per month, starting from a given month. | `category_id`, `effective_month` (`YYYY-MM`), `amount_cents` (unique on category + month) |
| `merchants` | One row per raw name Plaid sends, with its suggested and chosen display names. | `raw_name` (unique), `suggested_name`, `display_name`, `default_category_id` (nullable), `suggestion_status` (`none` / `pending` / `accepted` / `rejected`) |
| `transactions` | Every transaction and how it's categorized. | `id`, `plaid_transaction_id` (unique, nullable for split children), `account_id`, `date` (`YYYY-MM-DD` as Plaid sends it), `amount_cents`, `raw_name`, `category_id` (nullable), `category_source` (`user` / `merchant_rule` / `jev` / null), `category_confidence`, `flag_transfer`, `flag_reimbursement`, `flag_income` (0/1), `excluded`, `parent_id` (nullable), `is_split`, `note`, `updated_by`, `updated_at` |
| `bills` | Recurring bills and how to recognize their payment. | `id`, `name`, `amount_cents`, `due_day`, `frequency` (`monthly` / `yearly`), `anchor_month` (for yearly), `category_id`, `merchant_raw_name`, `active` |
| `bill_payments` | Links one bill occurrence to the one transaction that paid it. | `bill_id`, `period` (`YYYY-MM` or `YYYY`), `transaction_id`, `matched_by` (`auto` / `user`), `status` (`linked` / `dismissed`), `created_at`. Among `linked` rows: unique on (`bill_id`, `period`) and unique on `transaction_id` |
| `documents` | Details of each stored PDF, whose file lives in R2. | `id`, `r2_key`, `filename`, `size_bytes`, `uploaded_by`, `uploaded_at`, `note` |

`updated_by`, `linked_by`, and `uploaded_by` hold the email claim from Cloudflare Access's signed login token. The Worker verifies the `Cf-Access-Jwt-Assertion` JWT against the team's public keys (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached) and never trusts the plain `Cf-Access-Authenticated-User-Email` header. In one sentence: we read who you are from Cloudflare's signed login token, not from a header anyone could fake. In the demo they hold `demo`.

Schema changes use numbered D1 migration files in `migrations/`.

## 6. Money rules and budget math

**Sign convention (Plaid's):** a positive amount is money out, and a negative amount is money in. Account balances on debt accounts (`is_liability`) display as negative.

**Dates:** transaction dates are stored and compared exactly as Plaid sends them (`YYYY-MM-DD`), with no time-zone conversion. A month is the `YYYY-MM` prefix of the date.

"Counted transactions" for a month means: date in that month, `excluded = false`, and `is_split = false`, so split parents are skipped and their children count instead. Transactions flagged `income` are counted only toward **Income**. They're left out of Spent, Uncategorized, and Safe to spend.

| Number | Rule |
|---|---|
| **Budget for a category in month M** | `amount_cents` from the `budget_amounts` row for that category with the latest `effective_month <= M`. No row means no budget. |
| **Spent** | Sum of `amount_cents` over counted transactions in the category. Refunds are negative, so they reduce it. |
| **Left** | Budget minus spent. |
| **Uncategorized** | Counted transactions with `category_id` null, shown as their own row and never hidden. |
| **Income** | Absolute value of the sum of counted transactions flagged `income`. |
| **Bill status** | *Paid* if the bill occurrence has a linked `bill_payments` row (see §6.1). Otherwise *overdue* if the due date has passed, *due* if it falls within the next 7 days, or *upcoming*. |
| **Safe to spend** | Total budget for the month, minus all counted spending (every category, including uncategorized and unbudgeted; income excluded), minus the amounts of bills that are *due* or *overdue* and not *paid*. In one sentence: what's left of the whole budget after setting aside money for bills that are due. |

### 6.1 Matching bills to payments

> Each bill gets at most one payment per period, and each transaction pays at most one bill.

**The key:** a bill *occurrence* is identified by `(bill_id, period)`, where `period` is `YYYY-MM` for monthly bills and `YYYY` for yearly bills. Unique constraints in `bill_payments` let the database itself rule out double matches in either direction, so re-running the matcher changes nothing.

**A transaction is a candidate for a bill occurrence only if all of these hold:**
1. **Merchant:** its `raw_name` equals the bill's `merchant_raw_name`.
2. **Amount:** it's within ±10% of `amount_cents`, so a bill that varies a little (like utilities) still matches.
3. **Date:** it falls within ±5 days of that occurrence's due date. This keeps a late payment from last month from being mistaken for this month's.
4. **Unclaimed:** it isn't already linked to a bill occurrence, isn't excluded, isn't a split parent, and hasn't been dismissed for this occurrence.

**If several candidates qualify,** the matcher picks the one closest to the due date, then the one closest in amount, then the earliest by `id`, so the result is always the same.

**When matching runs:** after each sync, and after a bill is created or edited. It only fills occurrences that have no payment yet and never changes an existing link.

**People override the matcher.** From a bill, a person can link a transaction by hand (`matched_by = user`) or unlink a wrong match. Unlinking records a `dismissed` row, so the matcher won't pick that transaction for that occurrence again.

The amount tolerance (10%) and date window (±5 days) are single config values. The demo seed exercises all the cases: a bill paid on time, one paid 3 days late, and a lookalike charge outside the window that correctly doesn't match.

**Splits:** splitting creates child transactions (`parent_id` set) and marks the parent `is_split = true`. The children must add up exactly to the parent's `amount_cents`, or the split is rejected. Removing a split deletes the children and clears `is_split`.

**Exclusions:** transactions flagged `transfer` or `reimbursement` start with `excluded = true`. A person can always toggle it.

## 7. Categorization and merchant names

**Who picks the category, in order of priority:**

1. **A person.** A manual choice sets `category_source = user`, which is never overwritten. The edit panel offers "Always use this category for this merchant," which sets `merchants.default_category_id`.
2. **Merchant rule.** If the merchant has a `default_category_id`, apply it (`category_source = merchant_rule`).
3. **Jev.** Make **one** `POST /v1/systemone` call per transaction. Its `questions` map holds a `category` Choice question (options: the household's category list) and one yes/no (Noul) question per allowed flag (`transfer`, `reimbursement`, `income`), which is the bundling pattern Jev's docs recommend. If the category answer's confidence is at or above the threshold, apply it (`category_source = jev`); otherwise leave the category null for review. Each flag is applied on its own confidence check.

The confidence threshold is a single config value, set during Phase 1 after checking Jev's output on the seed data.

**Jev input:** the raw name, merchant display name, amount, account type, and Plaid's own category hint if present.

**Boundary:** all Jev calls go through one module (`src/ai/categorize.ts`) with one function signature. Switching providers changes only that file.

**Merchant names:** the Settings screen lists merchants without a chosen name. Workers AI generates a `suggested_name` once per `raw_name` and caches it. A person accepts it (it becomes `display_name`) or rejects it. Renaming a merchant renames every transaction from that merchant, because display names are looked up from `merchants`. All Workers AI calls go through `src/ai/suggest-name.ts`.

## 8. Screens

Phone first. Phones get a bottom tab bar (Home, Transactions, Bills, Trends, More); desktop gets the same items in a sidebar.

| Screen | Contents | Features |
|---|---|---|
| **Home** | Safe to spend as the headline number; a spent/left bar per category; a "N transactions need a category" prompt linking to a filtered list; bills due in the next 7 days | 1, 2 |
| **Transactions** | Search, plus filters for month, category, uncategorized, and excluded. Tapping a row opens an edit panel: category, "always for this merchant," exclude toggle, split, rename merchant, note | 3, 4, 5 |
| **Bills** | Each bill with its status, plus add, edit, and deactivate | 2 |
| **Trends** | Spending by category over the last 6 months, and this month vs. last month | 6 |
| **More → Accounts** | Balances, net worth, net-worth chart, Link a bank, and Fix connection for items that need attention | 7 |
| **More → Documents** | Upload, list, download, and delete PDFs | 8 |
| **More → Settings** | Categories and budget amounts; merchant name review | — |
| **Demo only** | A banner on every page ("Demo data. Nothing here is real."), a "Things to try" list, and a "How it works" page | — |

**How the pages behave:**
- **Edits:** an edit returns the updated fragment, plus an `HX-Trigger` header with `toast` and `announce` keys for the confirmation toast and screen-reader announcement.
- **Charts:** the server renders them as inline SVG. No chart library.
- **Expand and collapse:** `<details>` / `<summary>`. No JavaScript.
- **JavaScript:** the only custom JavaScript is Plaid Link (loaded from Plaid's CDN, as Plaid requires) and a small toast listener.
- **Accessibility:** every form is labeled, focus rings use `focus-visible`, touch targets are at least 44×44 px, and HTMX swap regions use `aria-live="polite"`. Errors use `role="alert"`.

Generated design studies (phone 390×844, desktop 1280×800) are selected by the owner before any UI code. They're composition references only; the real UI comes from the design system. The selected direction is "Quiet ledger"; see `docs/design-concepts/README.md` and decisions 20–21.

## 9. Demo experience

The seed data tells the story of a fictional household ("the Rivera family") with about 6 months of history, written so each feature has something to show:

| Feature | Seed data includes |
|---|---|
| 1 | A current month with categories on track, one close to its limit, and one over |
| 2 | One bill due soon, one overdue, one paid |
| 3 | Realistic merchants, plus a handful left uncategorized for Jev to sort |
| 4 | A warehouse-store purchase to split between Groceries and Household |
| 5 | A transfer between accounts and a reimbursement, both excluded |
| 6 | Six months with a visible trend (Eating Out creeping up) |
| 7 | Checking, savings, and a credit card, with daily balance history |
| 8 | Two sample statement PDFs, clearly watermarked as fake |

Seed dates are relative to the current month, so the demo always looks current. The nightly job rebuilds the demo database and bucket from the seed. Visitors can edit anything; their changes are gone the next morning.

The "How Tally works" page has two parts:

1. **Architecture:** the system diagram (built as SVG) and the one-sentence explanation of each part (§4).
2. **One section per feature (all 8),** each with the feature's one-sentence explanation, its rule in plain words (taken from §6 and §6.1), and a small worked example using the demo's own numbers. For example: "Safe to spend = $1,850 budget − $424 spent − $142 overdue bill."

Every screen has a small "How this works" link to its feature's section. Each section ships in the same phase as its feature, and its text must match the rules in this spec. If a rule changes, the section changes in the same pull request.

## 10. Errors, security, and operations

| Situation | Behavior |
|---|---|
| Bank link needs re-authentication (`ITEM_LOGIN_REQUIRED` etc.) | Set `plaid_items.status = needs_attention` and show Fix connection, which opens Plaid Link in update mode. The update-mode `link_token` is created when the button is clicked, never ahead of time, because it expires after 30 minutes. |
| Sync fails partway | Save transactions and the new `sync_cursor` together, in one D1 batch. A retry resumes from the last saved cursor, so nothing is duplicated or skipped. |
| Plaid webhook | Plaid signs every webhook, and the Worker checks the signature against Plaid's published key before trusting it. The `Plaid-Verification` header is a JWT: reject it unless `alg` is `ES256`, fetch the key for its `kid` from `/webhook_verification_key/get` (cached), and verify with Web Crypto (ECDSA P-256). The webhook path is the only path excluded from Cloudflare Access, via an Access **Bypass** policy scoped to `/webhooks/plaid`. |
| Jev unavailable or slow | Leave the transaction uncategorized; the nightly job retries it. AI calls never block a page. |
| Workers AI unavailable | No suggestion; retried the next time the merchant list is opened. |
| Invalid input (split doesn't add up, bad amount) | Re-render the form with a field error (`role="alert"`). |
| Logging | Never log tokens, secrets, or transaction details. |
| Plaid access tokens | Encrypted with AES-GCM (Web Crypto) using `TOKEN_ENCRYPTION_KEY` before they're stored. |
| Backups | D1 Time Travel restores to a point in time. The retention window gets confirmed in Phase 0 and recorded in the README. |
| Security headers | `X-Frame-Options: DENY`, a strict CSP (no inline scripts; Plaid's CDN allow-listed on the Accounts page), and `SameSite=Lax` on any cookie. |

## 11. Phases

Each phase is a GitHub milestone with issues. A phase ends with a review of what was built against this spec, and the roadmap gets updated before the next phase starts.

| Phase | Build | Finish line |
|---|---|---|
| **0. Setup** | Public repo, this spec, `docs/decisions.md`, `CLAUDE.md` (short, rules taken from this spec), `ROADMAP.md`, milestones and issues, Hono Worker skeleton, CI (type-check + tests), and doc checks for §13 | CI passes on the skeleton |
| **1. Core demo live** | Wireframes; D1 schema; seed household; Home; Transactions (recategorize, merchant rules, rename); Jev categorization; demo banner, Things to try, How it works; nightly reset; `demo` deploy | `https://demo.thesuperhuman.us` loads over HTTPS, all Phase 1 routes work, and there are no console errors. DNS records are shown to the owner and approved before they're created. |
| **2. Family on the core** | Plaid Link, sync (webhook plus daily cron), token encryption, Cloudflare Access, `production` deploy, Fix connection | The family uses it for a week. Retiring the Django app and moving `finance.thesuperhuman.us` is a separate decision the owner approves; records are shown first. |
| **3. Bills, exclusions, splits** | In both environments, with seed data for each | Shown in the demo, used by the family |
| **4. Trends, balances, documents, name suggestions** | Trends, net-worth history, R2 documents, Workers AI name suggestions | All 8 features live in both environments |

### Testing

- **Unit tests (most tests):** cents parsing and formatting, budget math, the bill status rules, split validation, and category priority.
- **Route tests:** run in Cloudflare's local Workers runtime against a real local D1 database. Plaid, Jev, and Workers AI are faked at the `fetch` or binding boundary.
- **E2E (Playwright), critical flows only:** recategorize, split, exclude, and change a budget amount.
- **Screenshots:** on every pull request from this repo, CI screenshots each page at 1280×800 and 390×844, puts them in the PR description, and fails if a page logs a console error.
- **CI (GitHub Actions):** type-check, lint, and tests on every push. A failing check blocks the merge.
- **Deploy:** manual at first, with `npx wrangler deploy --env demo` or `--env production`, documented in the README.

## 12. Later list (not built)

- An "ask a question" box (LLM-written read-only queries)
- Deploying automatically from CI
- Planned one-time expenses
- Private per-person accounts
- Statement upload (CSV or PDF) as a second transaction source
- Pruning old PR screenshots from the screenshots branch

## 13. Checked against docs before writing code (Phase 0)

The owner's rule is to confirm every API against current docs. These are the assumptions in this spec that needed checking.

**Checked on 2026-09-22.** Results are in `docs/verified-assumptions.md`. Items 5, 6, and 7 led to the owner-approved changes in §5, §7, and §10. Still unverified: Jev's numeric rate limit (handled by retrying on `RateLimitError`).

1. Workers with static assets is Cloudflare's recommended path for new full-stack apps (vs. Pages).
2. Hono on Workers: routing, JSX rendering, and the Cron and webhook handlers.
3. D1: the batch semantics used for the atomic sync save, the migration workflow, and the Time Travel retention window.
4. Testing: Vitest with Cloudflare's Workers test integration and local D1.
5. Plaid: whether to use `fetch` or the Node SDK on Workers, `/transactions/sync` pagination, webhook signature verification, and Link update mode.
6. Cloudflare Access: bypassing a single path (`/webhooks/plaid`) and reading the authenticated-email header.
7. Jev: the request/response format, how confidence is reported, the 255-choice limit, and error handling.
8. Workers AI: which model to use for name suggestions, and pricing.
9. R2: upload and download from a Worker, and size limits.
