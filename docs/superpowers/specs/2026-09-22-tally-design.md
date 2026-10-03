# Tally — Design Spec

- **Date:** 2026-09-22
- **Status:** Approved by the owner (2026-09-25, Phase 1 review)
- **Owner:** Kazon Wilson

## 1. What Tally is

Tally is a family budgeting app. It pulls in bank transactions automatically, sorts them into categories with a small AI model, and shows the household how much is left to spend this month.

It serves two audiences from one codebase:

1. **The owner's household**: a private app behind a login wall, with real bank data.
2. **The public**: a portfolio demo at `tally-demo.thesuperhuman.us` with fake data only.

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

Also in scope: AI-suggested merchant name cleanup (accept or reject), AI-suggested new categories when none of the household's categories fit (a person creates or dismisses them), the demo banner, a "Things to try" list, a "How it works" page, and onboarding: what a first visit shows and teaches, in the demo and in the family's first week (decision 49, #95).

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
| **Cron Triggers** | Run the daily bank sync (a backup for webhooks), one bank at a time so one failure doesn't stop the others, skipping any bank that needs reconnecting; then retry uncategorized transactions. The demo has no bank sync: each night it resets to the seed data, then retries uncategorized transactions. |
| **Cloudflare Access** | A login wall with the family's emails in front of the family app; the app has no login code of its own. |
| **Wrangler** | The command-line tool that deploys the Worker and stores secrets. |

### 4.1 Two deployments, one codebase

Wrangler environments deploy the same code twice:

| | `production` (family) | `demo` (public) |
|---|---|---|
| Hostname | `tally.thesuperhuman.us` (decision 34); may later take over `finance.thesuperhuman.us` as its own decision (decision 16) | `tally-demo.thesuperhuman.us` |
| D1 database | `tally-prod` | `tally-demo` |
| R2 bucket | `tally-prod-docs` | `tally-demo-docs` (fake PDFs) |
| Plaid | On | **Off.** No Plaid secrets exist in this environment. |
| Jev / Workers AI | On | On |
| Login | Cloudflare Access | Public, with a demo banner on every page |
| Nightly job | Sync plus categorization retry | Reset the database and bucket to the seed, then categorize |

**How real data stays out of the demo:** the demo database is only ever built from seed files in the repo. The demo environment has no Plaid credentials and no binding to the production database or bucket, so no code path can reach real data.

### 4.2 Secrets

Secrets are stored with `wrangler secret put` and never committed. The owner enters every value.

| Secret | production | demo |
|---|---|---|
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | yes | no |
| `TOKEN_ENCRYPTION_KEY` (encrypts Plaid access tokens) | yes | no |
| `PLAID_WEBHOOK_URL` (plain config, not secret) | yes | no |
| `PLAID_ENV` (plain config: `sandbox` or `production`; anything else means sandbox) | yes | no |
| `JEV_API_KEY` | yes | yes |

Local development uses a git-ignored `.dev.vars` file, with Plaid **Sandbox** keys only (decision 36); tests fake Plaid at `fetch`, and production keys exist only as secrets on the production Worker. The repo commits a `.dev.vars.example` with placeholder names only.

## 5. Data model

All money is stored as **integer cents**, because SQLite has no exact decimal type: `$12.34` is stored as `1234`. Code converts to dollars only when formatting for display.

| Table | Job, in one sentence | Key columns |
|---|---|---|
| `plaid_items` | One row per linked bank login, holding its encrypted token and sync position. | `id`, `plaid_item_id` (Plaid's `item_id`, unique; webhooks identify an Item by it), `access_token_encrypted`, `institution_name`, `sync_cursor`, `sync_locked_until` and `sync_lock_id` (nullable five-minute per-Item sync lease and its owner), `status` (`ok` / `needs_attention`), `linked_by`, `created_at` |
| `accounts` | Each checking, savings, or credit account and its current balance. | `id`, `plaid_item_id` (nullable, null for demo accounts), `plaid_account_id` (unique, nullable for demo accounts), `name`, `mask`, `type`, `subtype`, `is_liability`, `balance_cents`, `updated_at` ; from Phase 3, one `Cash` account (type `cash`, no Plaid ids) holds hand-entered cash transactions and is left out of net worth (decision 60) |
| `balance_history` | One balance per account per day, for the net-worth chart. | `account_id`, `date`, `balance_cents` (unique on account + date) |
| `categories` | The household's category list. | `id`, `name` (unique), `icon`, `color` (token name, e.g. `cat-blue`), `sort_order`, `archived` |
| `budget_amounts` | How much a category gets per month, starting from a given month. | `category_id`, `effective_month` (`YYYY-MM`), `amount_cents` (unique on category + month) |
| `merchants` | One row per raw name Plaid sends, with its suggested and chosen display names. | `raw_name` (unique), `suggested_name`, `display_name`, `default_category_id` (nullable), `suggestion_status` (`none` / `pending` / `accepted` / `rejected`) ; from Phase 3, `not_a_bill` (0/1: never suggest this merchant as a bill again, decision 60) |
| `transactions` | Every transaction and how it's categorized. | `id`, `plaid_transaction_id` (unique, nullable for split children), `account_id`, `date` (`YYYY-MM-DD` as Plaid sends it), `amount_cents`, `raw_name`, `plaid_category` (Plaid's `personal_finance_category.primary`, a hint for Jev), `category_id` (nullable), `category_source` (`user` / `merchant_rule` / `jev` / null), `category_confidence`, `jev_category_id` (Jev's pick, kept even when it's below the threshold; null when Jev said none fit), `jev_failed_at` (when Jev last failed on this transaction; asked last), `flag_transfer`, `flag_reimbursement`, `flag_income` (0/1), `excluded`, `excluded_source` (`user` / `jev` / null: who last decided the exclusion; Jev never overrides a person, #27), `parent_id` (nullable), `is_split`, `refund_of_id` (nullable, from Phase 3: the purchase this refund refunds, decision 60), `note`, `updated_by`, `updated_at`. A hand-entered cash transaction has no `plaid_transaction_id` |
| `bills` | Recurring bills and how to recognize their payment. | `id`, `name`, `amount_cents`, `due_day`, `frequency` (`monthly` / `yearly`), `anchor_month` (for yearly), `category_id`, `merchant_raw_name`, `active` |
| `bill_payments` | Links one bill occurrence to the one transaction that paid it. | `bill_id`, `period` (`YYYY-MM` or `YYYY`), `transaction_id`, `matched_by` (`auto` / `user`), `status` (`linked` / `dismissed`), `created_at`. Among `linked` rows: unique on (`bill_id`, `period`) and unique on `transaction_id` |
| `documents` | Details of each stored PDF, whose file lives in R2. | `id`, `r2_key`, `filename`, `size_bytes`, `uploaded_by`, `uploaded_at`, `note` |

`updated_by`, `linked_by`, and `uploaded_by` hold the email claim from Cloudflare Access's signed login token. The Worker verifies the `Cf-Access-Jwt-Assertion` JWT against the team's public keys (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached) and never trusts the plain `Cf-Access-Authenticated-User-Email` header. In one sentence: we read who you are from Cloudflare's signed login token, not from a header anyone could fake. In the demo they hold `demo`.

Schema changes use numbered D1 migration files in `migrations/`.

## 6. Money rules and budget math

**Sign convention (Plaid's):** a positive amount is money out, and a negative amount is money in. Account balances on debt accounts (`is_liability`) display as negative.

**Dates:** transaction dates are stored and compared exactly as Plaid sends them (`YYYY-MM-DD`), with no time-zone conversion. A month is the `YYYY-MM` prefix of the date.

"Counted transactions" for a month means: date in that month (or, from Phase 3, a payment linked to an earlier month's bill occurrence counts in that occurrence's month instead, never both; decision 58, #26; and a refund linked to its purchase counts in the purchase's month and category instead of its own, never both; a refund of a split purchase links to one of its parts, decision 60), `excluded = false`, and `is_split = false`, so split parents are skipped and their children count instead. Transactions flagged `income` are counted only toward **Income**. They're left out of Spent, Uncategorized, and Safe to spend.

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

**People override the matcher.** From a bill, a person can link a transaction by hand (`matched_by = user`), choosing which occurrence (month) it pays; the picker lists unclaimed transactions within 30 days of that occurrence's due date, same merchant first, then closest amount (decision 60) or unlink a wrong match. Unlinking records a `dismissed` row, so the matcher won't pick that transaction for that occurrence again.

The amount tolerance (10%) and date window (±5 days) are single config values. The demo seed exercises all the cases: a bill paid on time, one paid 3 days late, and a lookalike charge outside the window that correctly doesn't match.

**Splits:** splitting creates child transactions (`parent_id` set) and marks the parent `is_split = true`. The children must add up exactly to the parent's `amount_cents`, or the split is rejected. Removing a split deletes the children and clears `is_split`; a refund linked to one of the children is unlinked (`refund_of_id` is set to null) and counts on its own date and category again, and the toast says so (decision 60).

**Exclusions:** transactions flagged `transfer` or `reimbursement` start with `excluded = true`. A person can always toggle it.

## 7. Categorization and merchant names

**Who picks the category, in order of priority:**

1. **A person.** A manual choice sets `category_source = user`, which is never overwritten. The edit panel offers "Always use this category for this merchant," which sets `merchants.default_category_id`.
2. **Merchant rule.** If the merchant has a `default_category_id`, apply it (`category_source = merchant_rule`).
3. **Jev.** Make **one** `POST /v1/systemone` call per transaction. Its `questions` map holds a `category` Choice question (options: the household's category list) and one yes/no (Noul) question per allowed flag (`transfer`, `reimbursement`, `income`), which is the bundling pattern Jev's docs recommend. If the category answer's confidence is at or above the threshold, apply it (`category_source = jev`); otherwise leave the category null for review. Each flag is applied on its own confidence check.

The confidence threshold is a single config value, set during Phase 1 after checking Jev's output on the seed data.

**When Jev runs (Phase 1, #12):** only in the nightly job, never while a page loads. In the demo it runs right after the reset. The job applies merchant rules to uncategorized transactions first, then asks Jev about the rest: at most 40 calls a night in the demo, and 500 in production, so a newly linked bank's backfill is sorted in a night (decision 56). A failure that would hit every call (rate limit, server error, timeout, bad key) stops that night's run, and the next night retries; a failure about one transaction (Jev rejects it, or answers with something that isn't one of the options) skips just that transaction, which stays pending; three such failures in a row stop the run, since they point at every call. A transaction Jev failed on is asked about last from then on (`jev_failed_at`, decision 31), so it can never block the others. With no categories to offer, Jev isn't asked at all. The threshold starts at 0.80 and applies to the category's confidence and to each flag's probability. Below the threshold, the category stays empty but its confidence is stored, so Jev isn't asked about the same transaction again (decision 27). Jev is told the raw name, the merchant's display name, the amount in cents with its direction (money out or in), and the account type. The category question also offers "None of these fit", which never applies a category. Jev's pick is kept in `jev_category_id` either way, next to its confidence, so the threshold can be tuned from real picks (#49). Jev's transfer and reimbursement flags exclude the transaction (§6), which a person can undo with the edit panel's exclude toggle (#27). Jev's income answer isn't stored until the edit panel can change the income flag (decision 28), because a wrong one would silently take a purchase out of spending; the panel has no income control yet. The edit panel shows "Picked by Jev · N% sure" when Jev chose the category. Only the log line `jev: <status> <request id>` is ever logged.

**Jev input:** the raw name, merchant display name, amount, account type, and Plaid's own category hint if present (from Phase 2, once sync stores it, #18).

**Boundary:** all Jev calls go through one module (`src/ai/categorize.ts`) with one function signature. Switching providers changes only that file.

**Categories are archived, never deleted.** Archiving keeps every stored pick, confidence and source meaningful; deleting would null `category_id` and `jev_category_id` while leaving the source and confidence behind, which miscounts rows and hides them from merchant rules and Jev. No category may be named "None of these fit", Jev's extra option. Settings enforces both when it manages categories (#55): names are unique ignoring case (archived ones included), at most 50 categories are active, so every screen shows them all at once with no pagination (decision 37; well under Jev's 255-option limit, one being "None of these fit"), and an archived category can be restored. A budget is set on Home (decision 38): tapping a budget row, or a category under "Not budgeted", opens a sheet whose amount applies from the current month on; once a category has a budget, it can be changed but not removed. Home also has an Adjust mode (decision 48, #94): "Adjust" beside the Budget heading puts a round − and + on every budgeted row, and each tap saves the budget at the next round $10 ($712 → $720 or $710), from the current month on, never below $0; "Done" puts them away. The amount field is the owner's hero amount from the original app (the money input, #66): round −$1 and +$1 buttons either side of a big amount field with ▲▼ cent arrows inside it, a "Round to" chip when there are cents, and a "Last month" chip with what the category spent last month; typing stops at two decimals and it never goes below $0. Settings can move a category up or down, and that order is the order on every screen. An archived category stays on Home for any month it has spending in, so that month still adds up, and leaves from the next month on. A merchant rule pointing at an archived category is skipped until the category is restored. A new category gets the tag icon and the next color.

**Default categories (decision 32, #55):** every new database starts with the same categories, adapted from the owner's earlier app: Groceries, Eating Out, Gas, Car & Transport, Rent, Utilities, Subscriptions, Shopping, Personal Care, Health, Entertainment, Kids, Date Night, and Donations & Charity. None has a budget until the family sets one. Income, transfers, payments, savings and refunds aren't categories, because flags and exclusions handle them (§6); there's no "Other", because "None of these fit" and new-category suggestions do that job. The demo uses its seed's categories instead.

**New category suggestions (Phase 4, owner-approved 2026-09-25, #51):** when Jev says "None of these fit", Workers AI suggests a new category name from the transactions Jev couldn't place, through `src/ai/suggest-name.ts`. The Settings screen shows each suggestion with the transactions behind it. A person creates the category (it then works like any other, and Jev offers it from the next run) or dismisses the suggestion. Nothing is created automatically.

**Merchant names:** the Settings screen lists merchants without a chosen name. Workers AI generates a `suggested_name` once per `raw_name` and caches it. A person accepts it (it becomes `display_name`) or rejects it. Renaming a merchant renames every transaction from that merchant, because display names are looked up from `merchants`. All Workers AI calls go through `src/ai/suggest-name.ts`.

**Tidied names (decision 46, #93):** until a person names a merchant, its raw bank text is tidied by code for display only — card and processor prefixes, codes and store numbers removed, a `*` between words read as a space, sentence case, with a short list of acronyms kept in capitals — while `raw_name` itself is never touched, so search still matches it. A Workers AI name suggestion (#33) replaces it only when a person accepts it, and a person's own rename always wins.

## 8. Screens

Phone first. Phones get a bottom tab bar (Home, Transactions, Bills, Trends, More); desktop gets the same items in a sidebar.

| Screen | Contents | Features |
|---|---|---|
| **Home** | Safe to spend as the headline number; a spent/left bar per category, each opening its budget sheet; a quiet "Not budgeted" list of categories with no budget; a "N transactions need a category" prompt, with how much they add up to, linking to a filtered list (decision 50); bills due in the next 7 days | 1, 2 |
| **Transactions** | Search, plus filters for month, category, uncategorized, and excluded. Tapping a row opens an edit panel: category, "always for this merchant," exclude toggle, split, rename merchant, note. "Needs category" counts the same transactions as Home. The Excluded filter shows only excluded transactions. Search matches the merchant name, raw name, and note. The list shows 25 transactions per page. | 3, 4, 5 |
| **Bills** | Each bill with its status, plus add, edit, and deactivate | 2 |
| **Trends** | Spending by category over the last 6 months, and this month vs. last month | 6 |
| **More → Accounts** | Balances, net worth, net-worth chart, Link a bank, Fix connection for items that need attention, Disconnect a bank, and Sync now with when each bank last synced (§8.1) | 7 |
| **More → Documents** | Upload, list, download, and delete PDFs | 8 |
| **More → Settings** | Categories (rename, order, archive, restore; each row links to its budget on Home); merchant name review; Download your data (§8.1) | — |
| **Transactions → Organize** | Transactions that need a category, grouped by merchant, each group categorized in one go (§8.1) | 3 |
| **Demo only** | A banner on every page ("Demo data. Nothing here is real."), a "Things to try" list, and a "How it works" page | — |

### 8.1 Brought back from the original app (decision 57)

Four things the owner's earlier app had, added to Phase 2 so the family's first weeks with real bank data go smoothly:

- **Organize.** Transactions that need a category, grouped by merchant (its tidied or chosen name), each group showing its count and total, largest first. A group is every transaction that needs a category whose merchant shows the same name, so it can span several `raw_name`s ("TARGET 1234" and "TARGET.COM" both showing as Target). One category choice applies to every transaction in the group (`category_source = user`) and becomes the rule (`default_category_id`) of every `merchants` row in it, one per `raw_name`, creating any that don't exist yet, so later ones follow; an optional rename sets `display_name` on those same rows. A group leaves the list once it's done, and the page says how many are left. Reached from the Band on Home and from the "Needs category" filter.
- **Disconnect a bank.** From Accounts, a confirm step that names the bank and how many accounts and transactions it has. Disconnecting calls Plaid's `/item/remove` and deletes the stored access token, so it can never sync again. By default its accounts and transactions stay, so past months still add up, and its accounts are marked "Disconnected" and left out of net worth; "Also delete its accounts and transactions" removes them too, for a bank linked by mistake.
- **Sync now.** One button on Accounts that syncs every healthy bank now, then runs merchant rules (not Jev, which stays nightly), and says what came in ("12 new transactions"). Each bank shows when it last synced. It can run at most once a minute, and a sync already running is left to finish.
- **Download your data.** From Settings: every transaction as CSV (date, bank's name, merchant, amount in dollars, category, excluded, note, account), and a JSON file with every row of `categories`, `budget_amounts`, `merchants` (so their rules and names), `accounts`, `balance_history`, `transactions`, `bills` and `bill_payments`; banks from `plaid_items` by name and status only; and `documents` as a list of file names and dates, not the files. Access tokens, sync cursors and locks, and secrets are never included; a test checks that no column of `plaid_items` beyond name and status appears.
- **Send feedback (decision 58).** A small Feedback button with a round speech bubble, pinned above the tab bar on every page so it's always visible (decision 59; no shadow), opens a short form: type (bug, idea, question, other), how it feels (five faces, frustrated to delighted), and a message up to 2,000 characters; the server adds the page it came from and the device. If the separate diagnostics switch is explicitly enabled, the form offers an unchecked consent box for allowlisted browser/OS versions, viewport/screen size, build, and a generic client error type; stored context and issue bodies exclude screen contents, raw errors and raw user agents; the Worker parses the user agent transiently. Replay links require a second explicit switch and a valid HTTPS PostHog host, and no PostHog script is loaded by Tally. All switches are off unless an operator configures them. A third switch can expose an explicit geometry-only layout sketch: html2canvas renders a fresh document of neutral rectangles, and the result stays in browser session storage for at most ten minutes with a removal control. The sketch retains visible rectangle positions and sizes, including fixed panels at the current scroll position. It can expose clipping and overlap, but loses text, imagery, chart contents, colors and typography, so it cannot establish visual fidelity or diagnose content errors. No screenshot field, upload or reviewer endpoint exists in this draft. Migration 0011 is proposed only; deployment and migration application require a separate approval. Feedback is saved to D1, then filed as an issue in the private repo `kwilson21/tally-feedback` with plain `fetch` and a token that can only write issues there (`FEEDBACK_GITHUB_TOKEN`); a failed filing is retried nightly. At most 10 an hour per person. A daily routine triages each issue: bugs are fixed and merged under CLAUDE.md's rules, anything that changes the look, the spec or a decision becomes a proposal for the owner, and every issue gets a reply saying what happened. Nothing from a note is ever quoted in the public tally repo.

**How the pages behave:**
- **Edits:** an edit returns the updated fragment, plus an `HX-Trigger` header with `toast` and `announce` keys for the confirmation toast and screen-reader announcement.
- **Edit panel:** a page region, not a modal. Focus moves into it, and Cancel or the backdrop closes it. Escape isn't supported, because it would need custom JavaScript.
- **Enhancements (decision 45):** swipe gestures, drag and modal dialogs, as in the original app, each built through the catalog with its own allowed-JS decision. Every page works without them; until a modal dialog is built, the edit panel below stays a page region.
- **Charts:** the server renders them as inline SVG. No chart library.
- **Expand and collapse:** `<details>` / `<summary>`. No JavaScript.
- **JavaScript:** the only custom JavaScript is Plaid Link (loaded from Plaid's CDN, as Plaid requires), a small toast listener, and the money input's `money.js` (decision 39). Without `money.js` the money input is a plain field. The design system catalog has one script of its own, served only on its pages (decision 44).
- **Accessibility:** every form is labeled, focus rings use `focus-visible`, touch targets are at least 44×44 px, and every HTMX swap is announced: through an `aria-live="polite"` count or announcer, or by moving focus (a whole list is never a live region, which would read out every row). Errors use `role="alert"`.

Generated design studies (phone 390×844, desktop 1280×800) are selected by the owner before a new screen's UI code. They're composition references only; the real UI comes from the design system. The selected direction is "Quiet ledger"; see `docs/design-concepts/README.md` and decisions 20–21.

**Design system catalog (decisions 42–44, 47):** `/design-system` shows every component in its states, rendered by importing the real components with fake data, so the catalog can't drift from the app. It exists in the demo and in development, and production returns 404. Each component is marked with one tier: **Visual** (static states side by side, inert), **Interactive** (works in the browser without the server) or **Flow** (a multi-step journey on fake data, on its own page, with the step in the URL). Every UI change starts there and the owner signs it off there before it reaches an app page. A proposal that changes how something looks is decided by seeing it: `/design-system/proposals` shows each open proposal next to today's version at 1280 and 390, and lists what's been decided, with the issue each ships in (decision 47). Proposed versions are prototypes that live only on that page until the owner picks. The process is in `DESIGN.md`; the inventory of the original app's components is in `docs/design-system/inventory.md`.

### 8.2 Phase 3 screens (decision 60)

Picked on `/design-system/proposals` (P15–P22), where the drawings stay as the build reference until each ships.
- **Bills (P15):** grouped by status, each group once under its heading: Overdue, Due in the next 7 days, Upcoming, Paid this month. Add a bill opens the form in a bottom sheet; Deactivate is its text action, and inactive bills wait under Inactive (N).
- **A bill's page (P16):** its own page with each month's occurrence and the payment linked to it, Link a payment (the picker in §6.1) and Not this one (records a dismissal).
- **Split (P17):** in the edit panel, parts of category plus amount with a live "$X left to assign" line and Add a part. The line is computed by the server as you type (htmx), so it needs no new script; a save that doesn't add up exactly is rejected with a field error.
- **Finding bills (P18):** Tally suggests merchants that charge about the same amount about monthly. On Bills, a stronger Band (a terracotta rule on its left edge, the bills icon, the count in semibold, "From repeat charges in the last 3 months") opens a review list with Add (opens the bill form filled in) or Not a bill per row. Not a bill is remembered for that merchant for good; nothing becomes a bill until a person adds it.
- **Refunds (P19):** in a refund's edit panel, "This refunds…" lists purchases from the same merchant; linking makes the refund count in the purchase's month and category (§6). A split purchase is listed by its parts, never the parent, so a refund always links to one part and takes that part's category. Removing that split unlinks the refund (§6.1). Both rows then say so on their caption line.
- **Select several (P20):** a Select button on Transactions turns rows into checkboxes with an action bar pinned at the bottom (set category, exclude).
- **Cash (P21):** an "Add cash" button on Transactions opens the edit-panel form (date, amount, merchant, category, note) and saves to the Cash account.
- **A late bill payment (P22):** the month is chosen when linking the payment on the bill's page; the transaction row then shows a muted "Counts in April" on its caption line.

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
2. **One section per feature (all 8),** each with the feature's one-sentence explanation, its rule in plain words (taken from §6 and §6.1), a small diagram of the rule, and a small worked example using the demo's own numbers. Code draws the diagram from the same numbers as the example (#61), as inline SVG with a title and description for screen readers. For example: "Safe to spend = $1,850 budget − $424 spent − $142 overdue bill."

Every screen has a small "How this works" link to its feature's section. In Phase 1 (#13) the links sit under the page title on Home (budget), Transactions (transactions) and the edit panel (categorization); screens whose features ship later get theirs with the feature.

**Demo only (#13):** the "How Tally works" page (`/how-it-works`), the Things to try block and the "How this works" links appear only when `DEMO` is `"true"`; outside the demo the page is a 404. **Things to try** is a short block on Home, below the Budget list (#92, decision 46: safe to spend comes first on a phone), with three items, each linking to where it's done: "Give a transaction a category" (the Needs category list), "Set a rule for a merchant" and "Rename a merchant" (the Local Bakery edit panel), plus a "How Tally works" link. It has no close button: the demo resets nightly and remembering a dismissal would need saved state. It is the demo's only onboarding for now; onboarding (#95, decision 49) replaces it. Each section ships in the same phase as its feature, and its text must match the rules in this spec. If a rule changes, the section changes in the same pull request.

## 10. Errors, security, and operations

| Situation | Behavior |
|---|---|
| Bank link needs re-authentication (`ITEM_LOGIN_REQUIRED` etc.) | Set `plaid_items.status = needs_attention` and show Fix connection, which opens Plaid Link in update mode. The update-mode `link_token` is created when the button is clicked, never ahead of time, because it expires after 30 minutes. |
| Sync fails partway | Save transactions and the new `sync_cursor` together, in one D1 batch. A retry resumes from the last saved cursor, so nothing is duplicated or skipped. |
| Plaid webhook | Plaid signs every webhook, and the Worker checks the signature against Plaid's published key before trusting it. The `Plaid-Verification` header is a JWT: reject it unless `alg` is `ES256`, fetch the key for its `kid` from `/webhook_verification_key/get` (cached), and verify with Web Crypto (ECDSA P-256). `SYNC_UPDATES_AVAILABLE` starts that Item's transaction sync; permanent `ITEM` errors, pending expiration or disconnect, and revoked user permission mark it as needing attention. The webhook path is the only path excluded from Cloudflare Access, via an Access **Bypass** policy scoped to `/webhooks/plaid`. |
| Jev unavailable or slow | Leave the transaction uncategorized; the nightly job retries it. AI calls never block a page. |
| Workers AI unavailable | No suggestion; retried the next time the merchant list is opened. |
| Invalid input (split doesn't add up, bad amount) | Re-render the form with a field error (`role="alert"`). |
| Logging | Never log tokens, secrets, or transaction details. |
| Plaid access tokens | Encrypted with AES-GCM (Web Crypto) using `TOKEN_ENCRYPTION_KEY` before they're stored. |
| Backups | D1 Time Travel restores to a point in time. The retention window gets confirmed in Phase 0 and recorded in the README. |
| Security headers | `X-Frame-Options: DENY`, a strict CSP (no inline scripts; Plaid's CDN allow-listed on the Accounts page), and `SameSite=Lax` on any cookie. |
| Form posts from other sites | Rejected with 403 unless the browser shows the post came from this site (`Sec-Fetch-Site: same-origin` or a matching `Origin`), using Hono's built-in `csrf` middleware. |

## 11. Phases

Each phase is a GitHub milestone with issues. A phase ends with a review of what was built against this spec, and the roadmap gets updated before the next phase starts.

| Phase | Build | Finish line |
|---|---|---|
| **0. Setup** | Public repo, this spec, `docs/decisions.md`, `CLAUDE.md` (short, rules taken from this spec), `ROADMAP.md`, milestones and issues, Hono Worker skeleton, CI (type-check + tests), and doc checks for §13 | CI passes on the skeleton |
| **1. Core demo live** | Wireframes; D1 schema; seed household; Home; Transactions (recategorize, merchant rules, rename); Jev categorization; demo banner, Things to try, How it works; nightly reset; `demo` deploy | `https://tally-demo.thesuperhuman.us` loads over HTTPS, all Phase 1 routes work, and there are no console errors. DNS records are shown to the owner and approved before they're created. |
| **2. Family on the core** | Plaid Link, sync (webhook plus daily cron), token encryption, Cloudflare Access, `production` deploy, Fix connection, Settings for categories and budget amounts with the default categories (decision 32), and exclusions (decision 33), so the family's numbers are right from the first week; Organize, Disconnect a bank, Sync now, Download your data and Send feedback (decisions 57 and 58, §8.1) | The family uses it for a week (Oct 1–7), then keeps using it through October; the month-end review feeds Phase 3's review (decision 58). Retiring the Django app and moving `finance.thesuperhuman.us` is a separate decision the owner approves; records are shown first. |
| **3. Bills and splits** | In both environments, with seed data for each (exclusions moved to Phase 2, decision 33). Also (decisions 57 and 58): finding bills from recurring charges, linking a refund to its purchase, selecting several transactions at once, adding a cash transaction by hand, and counting a bill payment toward its bill's month (a payment linked to an earlier month's bill occurrence counts in that month's spending *instead of* its own date's month, never both; the bank's date is unchanged) | Building starts Oct 4 while production stays frozen for the trial week (fixes only); Phase 3 reaches production after Oct 7 in one owner-approved deploy (decision 60). Shown in the demo, used by the family |
| **4. Trends, balances, documents, name suggestions** | Trends, net-worth history, R2 documents, Workers AI name suggestions (merchant names and new categories) | All 8 features live in both environments |

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
- A "More…" category chip when a household has more categories than the edit panel fits
- Pruning old PR screenshots from the screenshots branch
- A close (×) button on the demo's Things to try block, remembered with a cookie
- Choosing a category's icon and color in Settings (new categories get the tag icon and the next color)
- Removing a category's budget (for now the budget sheet requires an amount)
- The raw bank text under a categorized row's tidied name in the Transactions list (#93 shows it under rows that need a category and in the edit panel; categorized rows would need a third line, a TransactionRow shape change for the catalog)
- Session replay (e.g. PostHog) linked from each feedback issue. It needs a new script on every page and masking of everything personal on screen: amounts, merchant names, raw bank text, notes, account names and numbers, and anything typed (including the feedback itself). Weigh it at the month-end review (decision 58) if notes turn out too vague to act on.
- A user-triggered, previewable screenshot of the page a person is reporting. The draft provides a local html2canvas geometry preview, disabled by default. Keep screenshot submission off until a private storage/viewing path, retention and access rule are reviewed; it must not upload an unredacted image or make third-party requests.

## 13. Checked against docs before writing code (Phase 0)

The owner's rule is to confirm every API against current docs. These are the assumptions in this spec that needed checking.

**Checked on 2026-09-22.** Results are in `docs/verified-assumptions.md`. Items 5, 6, and 7 led to the owner-approved changes in §5, §7, and §10. Still unverified: Jev's numeric rate limit (a 429 stops that night's run and the next night retries; there's no SDK, decision 19).

1. Workers with static assets is Cloudflare's recommended path for new full-stack apps (vs. Pages).
2. Hono on Workers: routing, JSX rendering, and the Cron and webhook handlers.
3. D1: the batch semantics used for the atomic sync save, the migration workflow, and the Time Travel retention window.
4. Testing: Vitest with Cloudflare's Workers test integration and local D1.
5. Plaid: whether to use `fetch` or the Node SDK on Workers, `/transactions/sync` pagination, webhook signature verification, and Link update mode.
6. Cloudflare Access: bypassing a single path (`/webhooks/plaid`) and reading the authenticated-email header.
7. Jev: the request/response format, how confidence is reported, the 255-choice limit, and error handling.
8. Workers AI: which model to use for name suggestions, and pricing.
9. R2: upload and download from a Worker, and size limits.
