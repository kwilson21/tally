# Apple Card by Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repo that means a Haiku 5.5 builder per PR, tests first, then a fresh Haiku 5.5 verifier (CLAUDE.md, decisions 97 and 129).

**Goal:** Someone uploads the CSV Apple exports, and Tally adds the Apple Card transactions it doesn't have yet to one Apple Card account. A typed balance counts in net worth, and Home nudges after a week without an upload.

**Architecture:** A new `src/apple-card/` module has three parts:
- a pure reader that turns the file into rows
- a pure planner that numbers identical rows and applies the skips
- one D1 batch that stores the upload through a unique index, so a row Tally holds is never added twice and an upload saves all of itself or nothing

After the write, the same steps a Plaid sync starts run on the new rows. The UI is a sheet on Accounts (P141 B), modelled on Home's Savings sheet, plus a second tinted line on Home.

**Tech Stack:** Cloudflare Workers, Hono 4 JSX, htmx 4, D1 (SQLite), Vitest in the Workers runtime.

**Spec:** `docs/superpowers/specs/2026-09-22-tally-design.md` §8.10 "Apple Card by upload", plus §5's "from decision 138" notes and decision 138 in `docs/decisions.md`. Issue #731 has the owner's P141 picks at the bottom of its body.

**Two PRs, one issue each.**
- **PR 1 (#731): Tasks 1–3.** Reading, planning and storing. Screens don't change.
- **PR 2 (#766): Tasks 4 and 6.** The sheet and Accounts, the demo's sample, and How Tally works' line. The export's bank name shipped in #765.
- **PR 3 (#767): Task 5.** Home's nudge, built after #762 merges.

**Gate before PR 1's brief: met on 2026-10-21.** The owner's export, from Jul 1 to Oct 21, 2026 (never committed or copied into a test), confirmed:
- the 8-column header, with `Purchased By`
- Apple's Type words `Purchase`, `Payment`, `Interest` and `Other`. No refund was in the file, so a refund's word is still unconfirmed; it counts by its sign whatever it is, so nothing depends on it
- a Payment row's Category is `Payment`, its Merchant is filled in and its amount is negative; an Interest row's Category is `Interest`, its Merchant is filled in and its amount is positive; a bounced payment is an `Other` row, money out, whose Description says REVERSAL (decision 144)
- no row had a blank Merchant or a blank Clearing Date
- the format: UTF-8 with one non-ASCII character in a Description, no byte-order mark, LF line endings, no newline after the last row, every field quoted except the two dates, and dates zero-padded `MM/DD/YYYY`

Line numbers below were read on main at `9a7c3dd`. A builder checks them first.

## Global Constraints

- Money is integer cents, never floats. Parse text with `toCents` (`src/money.ts:5-16`).
- Sign: positive = money out. Apple's sign already matches, so keep it.
- A transaction's own date is never converted. Only "today" uses the household's time zone (decision 67). MM/DD/YYYY to YYYY-MM-DD is a reformat of the same calendar day.
- No new dependency and no new client JS beyond the `money.js` change Task 4 names. The CSV reader is hand-written.
- The upload form has `enctype="multipart/form-data"` and `hx-encoding="multipart/form-data"`.
- HTMX feedback is `HX-Trigger` with `toast` and `announce`, via `hxTrigger` (`src/htmx.ts:6`). Errors use `role="alert"`.
- Accessibility: labeled fields, focus-visible rings, 44px targets, and every swap announced.
- UI uses DESIGN.md tokens and components. The new `FileField` goes into DESIGN.md and the catalog in the same PR, catalog first. It is also receipts' file input (§8.9, decision 137): if receipts has shipped it, use it instead of adding another.
- Never log a row, a file or an amount. The uploaded file is never stored. Test fixtures are made-up rows in Apple's layout, never the family's export.
- The demo never takes a file.
- Migrations are plain SQL, numbered. `0058` is PR 1's; the next is `0059`.
- PR 2 decodes the uploaded file without `fatal` (`new TextDecoder("utf-8")`); csv.ts's U+FFFD check names the row that holds a bad byte, so a file in another encoding is refused by row.

## Review Focus

1. **A file a spreadsheet saved:** a byte-order mark, CRLF, every field quoted (the header too), a trailing blank line, and dates like `9/25/2026`. It reads the same as Apple's own file. Test in Task 1.
2. **Upload tapped twice, or two people at once:** no row is added twice, and the second upload says "Nothing new." Test in Task 3.
3. **A split Apple Card purchase, then the same range again:** the split stays and nothing is added, because only the parent carries `upload_key`. Test in Task 3.
4. **A person counts a Payment row back in, then re-uploads:** the row stays counted, because an upload never updates a row it holds. Test in Task 3.
5. **Uploading while Apple Card is removed with rows kept:** the same account reopens and nothing is doubled. The old balance is forgotten, so net worth counts the card again only once a balance is typed. Rows are tested in Task 3, net worth in Task 4.

---

### Task 1: Read Apple's CSV

**Files:**
- Create: `src/apple-card/csv.ts`
- Test: `test/apple-card-csv.test.ts`

**Interfaces:**
- Produces:
  - `type AppleRow = { line: number; transactionDate: string; clearingDate: string | null; description: string; merchant: string | null; category: string | null; type: string; amountCents: number }`
  - `const APPLE_COLUMNS = ["Transaction Date", "Clearing Date", "Description", "Merchant", "Category", "Type", "Amount (USD)"]`
    - The header is these 7, or these plus `"Purchased By"`.
    - Every row must have the header's number of fields.
  - `const NOT_APPLE = "This isn't an Apple Card CSV. In Wallet or on card.apple.com, choose Export Transactions and pick CSV."`
  - `function parseAppleCsv(text: string): { ok: true; rows: AppleRow[] } | { ok: false; error: string }`
- `line` is the row's number as a spreadsheet shows it: the header is 1, and the first transaction is 2.

**Corrections (2026-10-21, from the PR 1 brief):** a quote may only open a field. After a closing quote only a comma, a line ending or the end of the text may follow, and an unclosed quote at the end refuses the file.

- [ ] **Step 1: Write the failing tests** (`describe("parseAppleCsv")`):
  - **`reads one purchase`:** `10/03/2026,10/04/2026,"GREENLEAF MARKET #12 100 MAIN ST SPRINGFIELD 00000 XX USA","Greenleaf Market #12","Grocery","Purchase","38.40","Pat Rivera"` gives `{ line: 2, transactionDate: "2026-10-03", clearingDate: "2026-10-04", description: "GREENLEAF MARKET #12 100 MAIN ST SPRINGFIELD 00000 XX USA", merchant: "Greenleaf Market #12", category: "Grocery", type: "Purchase", amountCents: 3840 }`.
  - **`reads both headers`:** the 7-column file and the 8-column file give the same rows. Purchased By is ignored.
  - **`keeps a comma inside quotes`:** a Description like `"GREENLEAF MARKET, UNIT 3 EXAMPLE TOWN"` stays one field.
  - **`keeps a doubled quote`:** `"PAT ""THE"" CAFE"` reads as `PAT "THE" CAFE`.
  - **`reads a spreadsheet's re-save`:** a byte-order mark, CRLF, the header and every field quoted, a trailing blank line, and `9/5/2026` dates.
  - **`reads money in`:** `"-12.00"` gives `-1200`.
  - **`reads thousands`:** `"1,234.56"` gives `123456`.
  - **`reads zero`:** `"0.00"` and `"-0.00"` both give `0`.
  - **`allows a blank Clearing Date`:** it reads as `clearingDate: null`.
  - **`stores blank Merchant and Category as null`.**
  - **`refuses another file`:** an OFX's first line, a CSV with other columns, or an empty file gives `{ ok: false, error: NOT_APPLE }`.
  - **`names the first row it can't read`:**
    - Row 14's amount `"$45.25"` or `"45.2.5"` gives `"Row 14's amount can't be read. Nothing was added."`
    - A Transaction Date of `02/30/2026`, a blank Transaction Date, or a non-blank malformed Clearing Date gives `"Row 14's date can't be read. Nothing was added."`
    - A blank Description or Type, or a field count other than the header's, gives `"Row 14 can't be read. Nothing was added."`
- [ ] **Step 2:** Run `npx vitest run test/apple-card-csv.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `parseAppleCsv` in `src/apple-card/csv.ts`:
  - Read with a small character state machine for RFC 4180 quoting.
  - Strip a leading `﻿`.
  - Read the header line with the same reader and compare its fields with `APPLE_COLUMNS`, optionally followed by `Purchased By`.
  - Amount: refuse any `$`, then call `toCents`, which throws on anything else, then refuse a result that isn't `Number.isSafeInteger`, as the cash parser does (`src/transactions/cash.ts:38-40`). Turn `-0` into `0`. Test: a 20-digit amount gives the row's amount error.
  - Dates: `M/D/YYYY`, month first, with one or two digits each, checked as a real calendar day. A first number over 12 is an unreadable date.
- [ ] **Step 4:** Run `npx vitest run test/apple-card-csv.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: read Apple Card's CSV export into rows (#731)`.

### Task 2: Number the rows, and the words for what happened

**Files:**
- Create: `src/apple-card/plan.ts`
- Test: `test/apple-card-plan.test.ts`

**Interfaces:**
- Consumes: `AppleRow` (Task 1)
- Produces:
  - `const PAYMENT_TYPE = "Payment"`
  - `function rowKey(row: AppleRow): string`: `JSON.stringify([transactionDate, clearingDate, description, type, amountCents])`
  - `type ImportPlan = { add: { row: AppleRow; key: string; twin: number; excluded: boolean }[]; notCleared: number; beforeHistory: number }`
  - `function planImport(rows: AppleRow[], historyStart: string, held?: HeldTwins): ImportPlan`
    - `add` is every row to try.
    - `twin` is the row's rank, from 1, among rows with the same key, in file order, after the skips.
    - Task 3's unique index skips the ranks Tally already holds. Held twins are always 1 to h: uploaded rows are never deleted one by one, and split parts never carry `upload_key` (`src/db/transactions.ts:2236, 2466`).
  - `function importWords(counts: { added: number; already: number; notCleared: number; beforeHistory: number }, historyStart: string, today: string): string`
  - `function leftOut(row: AppleRow): boolean` (decision 144): true for `type === "Payment"`, or for `type === "Other"` with money out (`amountCents > 0`) and `REVERSAL` anywhere in the Description, in any case. A money-in row that says REVERSAL counts by its sign. Each `ImportPlan.add` item gains `excluded: boolean` (`leftOut(row)`), which Task 3 binds.

- [ ] **Step 1: Write the failing tests:**
  - **`numbers twins`:** two identical rows give twins 1 and 2 with the same key. A third identical row later in the file gives twin 3.
  - **`skips a row that hasn't cleared`:** it's counted in `notCleared`, never in `add`.
  - **`skips a row before Tally's history`:** with `historyStart` `"2026-07-21"`, a `clearingDate` of `"2026-07-20"` is counted in `beforeHistory`, and `"2026-07-21"` is added.
  - **`importWords`, with exact strings:**

    | Counts | Words |
    |---|---|
    | `{added:34, already:6}` | `"Added 34 from Apple Card. 6 were already in Tally."` |
    | `{added:1, already:1}` | `"Added 1 from Apple Card. 1 was already in Tally."` |
    | `{added:34, already:0}` | `"Added 34 from Apple Card."` |
    | `{added:0, already:40}` | `"Nothing new. All 40 were already in Tally."` |
    | all zero | `"Nothing new."` |
    | `notCleared:2` | appends `" 2 haven't cleared yet."` (1: `" 1 hasn't cleared yet."`) |
    | `beforeHistory:12`, `historyStart` `"2026-07-21"` | appends `" 12 were from before Jul 21, when Tally's history starts."` (1: `" 1 was from before …"`) |
    | `{added:0, already:0, notCleared:2}` | `"Nothing new. 2 haven't cleared yet."` |

    The day is `shortDay` (`src/dates.ts:130-134`), which adds the year when it isn't this year's.
- [ ] **Step 2:** Run `npx vitest run test/apple-card-plan.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `planImport`, `rowKey` and `importWords` in `src/apple-card/plan.ts`.
- [ ] **Step 4:** Run `npx vitest run test/apple-card-plan.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: number an Apple Card upload's identical rows (#731)`.

### Task 3: Store an upload in one batch

**Files:**
- Create: `migrations/0058_apple_card.sql`, `src/apple-card/import.ts`
- Modify:
  - `src/db/merchant-names.ts`:
    - Move `suggestPlaidNamesSql` here from `src/plaid/sync.ts:207` as `export const suggestBankNamesSql = (guard: string) => …`, body unchanged.
    - `NAME_ASKED_SQL` (`:34-36`) also skips accounts with `subtype = 'apple_card'`.
  - `src/plaid/sync.ts:989`: import the moved builder and pass `OWNS_LOCK`. Fix the comments at `:238` and `:951`.
  - `src/db/transactions.ts:2675`: `COALESCE(t.plaid_category, t.apple_category) AS plaidCategory`, through one shared helper that the save guard (`seenMatchSql`, `:2943`) also uses (correction 2 below).
  - `src/settings/export.ts:14-19`: the new account and transaction columns.
- Test:
  - `test/apple-card-import.test.ts`
  - `test/export.test.ts`: the key lists at `:58-71` and `:317-458`
  - the existing sync and merchant-name tests, which must pass unchanged

**Interfaces:**
- Consumes: Tasks 1–2
- Produces:
  - `type ImportResult = { accountId: number; addedIds: number[]; added: number; already: number; notCleared: number; beforeHistory: number; historyStart: string }`
  - `function importAppleCard(db: D1Database, rows: AppleRow[], opts: { by: string; today: string; balanceCents: number | null }): Promise<ImportResult>`
  - `function historyStart(db: D1Database, today: string): Promise<string>`:
    - `MIN(t.date)` over transactions on accounts with a non-null `plaid_item_id`, so a disconnected bank's kept rows are included.
    - While any connected bank (`plaid_items` not disconnected) has `history_complete_at` unset, or there are no such rows yet, it's the earlier of that date and `daysBefore(today, 90)` (`src/dates.ts:143`), so rows aren't left out while the first sync is still bringing older pages (`src/plaid/sync.ts:1116-1130`).
    - With no connected bank and no transaction on a Plaid account, it's the Apple Card's own earliest row, or `daysBefore(today, 90)` while the card has none, so a card that exists keeps uploading whatever happens to the banks.
    - Only with no Apple Card account yet, no connected bank and no bank history does `importAppleCard` save nothing and returns `{ ok: false, error: "Link a bank first. Tally's history starts with your bank's." }`. So `importAppleCard` returns `ImportResult | { ok: false; error: string }`.

**Corrections (2026-10-21, from the PR 1 brief):**
- **Decision 144 (a bounced payment).** The insert binds `excluded` 1 and `excluded_source 'plaid'` for each `ImportPlan.add` item whose `excluded` is true. Tests: a Payment and a bounced payment (an `Other` row with REVERSAL, money out) are both stored excluded, so the pair adds nothing to the month; an `Other` row with money in that says REVERSAL is not excluded.
- **Correction 2 (Jev sees Apple's category on both sides of decision 143's guard).** `src/db/transactions.ts:2675` reads `COALESCE(t.plaid_category, t.apple_category)` through one helper, `jevCategoryHintSql(alias)`, which `seenMatchSql` (`:2943`) also uses. No other reader changes: `src/db/category-suggestions.ts`, `src/bills/find.ts`, `src/transactions/rule-offer.ts`, `src/db/income.ts` and `src/plaid/pending-merge.ts` keep `plaid_category` alone. Do not add a field to `JevSeen`; its `plaidCategory` comment says it holds Plaid's category, or Apple's for an uploaded row. Tests: an end-to-end sort in `test/sort-groups.test.ts`, and an Apple row in that file's `CHANGES` table.
- **Correction 6 (the upload key is permanent).** `rowKey` builds the key from NFC-normalized, trimmed fields and a golden test pins its exact text. A row with U+FFFD in any field is unreadable, and each field is capped at 1,000 characters. `line` counts records, not physical lines.
- **Correction 7 (money words never leak).** `parseAppleCsv` catches the `toCents` error and returns only the row's words; nothing rethrows or logs the amount text.
- **Correction 8 (chunks by size too).** Each row insert is at most 500 rows or about 500,000 characters of JSON, whichever comes first, and the `RETURNING` ids are gathered across statements. Tests cover 250 rows, 1,001 rows (three or more statements) and 500 long rows (two or more).
- **Correction 9 (names in the same batch).** The name suggestions use `suggestBankNamesSql("1")`, moved from `sync.ts`, in the upload's own batch, built from `plan.add`'s merchants. The upsert leaves named and decided merchants alone.
- **Correction 10 (narrowing).** `ImportResult` has `ok: true`, so `ImportResult | { ok: false; error: string }` narrows in the tests.
- **Held twins before history (PR 2 brief).** `importAppleCard` reads the held twins before the batch: one `json_each` query, only for rows cleared before `historyStart`, so a held row counts as already, never as before history.
- **Historical start.** `historyStart` returns `string | null`: null when there is no card and no bank to start from. Then `importAppleCard` returns the "Link a bank first" error and saves nothing.

- [ ] **Step 1: Write `migrations/0058_apple_card.sql`:**
  - `ALTER TABLE accounts ADD COLUMN uploaded_on TEXT`, `balance_on TEXT`, `removed_at TEXT` and `counted_from TEXT`.
  - `CREATE UNIQUE INDEX accounts_one_apple_card ON accounts(subtype) WHERE subtype = 'apple_card';`
  - `ALTER TABLE transactions ADD COLUMN apple_category TEXT`, `upload_key TEXT` and `upload_twin INTEGER`.
  - `CREATE UNIQUE INDEX transactions_upload_twin ON transactions(account_id, upload_key, upload_twin) WHERE upload_key IS NOT NULL;`
  - No table rebuild.
- [ ] **Step 2: Write the failing tests** (Workers runtime: `import { env } from "cloudflare:workers"`, `beforeEach(() => resetDemo(env.DB, "2026-09-22"))`, as `test/split-route.test.ts` does):
  - **`creates one Apple Card account`:** name `'Apple Card'`, type `credit`, subtype `apple_card`, `is_liability` 1, no Plaid ids. A second upload reuses it.
  - **`stores a row`:**
    - `date` is the clearing date.
    - `raw_name` is the Description, and `merchant_name` is the Merchant or NULL.
    - `apple_category` is set, and `plaid_category` is NULL.
    - `pending` is 0, `upload_key` is `rowKey`, `upload_twin` is 1, and `updated_by` is `by`.
    - `credit_reviewed` is 0 for money in and 1 for money out, as sync sets them (`src/plaid/sync.ts:750-793`).
  - **`leaves a Payment out`:** `excluded` 1 and `excluded_source 'plaid'`. A Credit row isn't excluded.
  - **`uploading the same file twice adds nothing`** (Review Focus 2). Also run two calls with the same rows through `Promise.all`; between them they add each row once.
  - **`adds only the twins beyond what Tally holds`:** after an upload of two identical rows, an upload of three adds one row, twin 3.
  - **`a split purchase isn't added again`** (Review Focus 3).
  - **`an upload never changes a row it holds`** (Review Focus 4).
  - **`reopens a removed account`** (Review Focus 5):
    - `removed_at` becomes NULL, and the kept rows count as held.
    - Set up as Remove leaves it (`removed_at` set and `balance_on` NULL): reopening with a typed balance sets `balance_on` and `counted_from` to today; reopening without one leaves both as Remove left them.
  - **`saves nothing when a statement fails`:** force the insert to fail, then check that `uploaded_on`, the balance and the rows are all unchanged.
  - **`historyStart`:** the seed's earliest date on a Plaid account; the earlier of that and the 90-day fallback while a connected bank's `history_complete_at` is unset; the kept rows' earliest date after the last bank is disconnected with its rows kept, so uploads still work then. With no bank history at all, the card's own earliest row. With no bank, no bank history and no card rows, nothing is saved and the words are returned.
  - **`saves a typed balance`:**
    - `balance_cents`, `balance_on` = today, and that day's `balance_history` row.
    - A second upload the same day replaces the row.
    - `-1200` (a credit) is stored as `-1200`.
    - `counted_from` is set to today with any balance typed while `balance_on` is NULL (the first one, or the first after Remove cleared it), and left alone after that.
    - `null` leaves the balance as it was.
  - **`suggests Apple's Merchant as the store's name`:**
    - Only for added rows whose Merchant isn't the Description or `tidyName(Description)` (`src/transactions/tidy-name.ts:43`), as `plaidNameToSuggest` filters (`sync.ts:115-122`).
    - A merchant a person named is left alone.
  - **`never asks Workers AI about Apple rows`:** `merchantsToAsk` leaves them out, including a row with a blank Merchant.
  - **`gives Jev Apple's category as the hint`:** `pendingForJev`'s `plaidCategory` is `"Gas"` for an Apple row.
  - **`stores 250 rows in one call`.**
  - **`sets uploaded_on`** to the household's today (`opts.today`), and **`returns the added ids`**.
  - **Export:** the export test's key lists include `uploaded_on`, `balance_on`, `removed_at`, `counted_from`, `apple_category`, `upload_key` and `upload_twin`.
- [ ] **Step 3:** Run `npx vitest run test/apple-card-import.test.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement `importAppleCard` in `src/apple-card/import.ts`:
  1. Read `historyStart`, then call `planImport`.
  2. Write **one batch**, in this order:
     1. `INSERT … ON CONFLICT(subtype) WHERE subtype = 'apple_card' DO NOTHING` the account, as `src/transactions/cash.ts:116-121` does for Cash.
     2. `UPDATE` that account: `uploaded_on = ?` (`opts.today`), `removed_at = NULL`, and the typed balance with `balance_on`, setting `counted_from` to today in the same statement when the old `balance_on` was NULL. End with `RETURNING id`.
     3. The row inserts in statements of up to 500 rows each. Each is `INSERT … SELECT … FROM json_each(?) WHERE 1 ON CONFLICT (account_id, upload_key, upload_twin) WHERE upload_key IS NOT NULL DO NOTHING RETURNING id`, with the account id read as `(SELECT id FROM accounts WHERE subtype = 'apple_card')`. `WHERE 1` avoids SQLite's upsert parsing ambiguity, as `src/db/merchant-names.ts:96-117` does.
     4. The `balance_history` upsert, as `sync.ts:397-399` writes it.
     5. `suggestBankNamesSql("1")`, with the names filtered as above.
  3. `added` is the count of returned row ids, and `already = plan.add.length - added`.
- [ ] **Step 5:** Run `npx vitest run test/apple-card-import.test.ts test/export.test.ts`, then every gate (CLAUDE.md). Expected: PASS.
- [ ] **Step 6:** Commit: `feat: store an Apple Card upload once, in one batch, with its balance (#731)`.

### Task 4: The sheet and Accounts (PR 2)

**Corrections (2026-10-21, from the PR 2 brief; the brief wins where it differs):**
- The chart's SQL is a `LEFT JOIN plaid_items p`, with the card's clause in its WHERE (`src/db/balance-history.ts:29-43`). The card counts when `balanceOn !== null && removedAt === null`.
- Home's parts (BankBehind, the nudge) move to Task 5, which is PR 3 (#767).
- The export's bank name shipped in #765 and is dropped from Task 6.
- `src/db/first-tally.ts:195-225` holds `forgetPayDeposits`. Remove builds one shared pay-cleanup builder, and `forgetCardPayDeposits(db)` guards on the card being kept.
- `src/db/transactions.ts:2790-2811` holds `countWaitingForJev`; an upload's rows never draw a stroke.
- Cancel goes to `/accounts?focus=apple-card`; a Remove page is drawn modelled on Disconnect's.

**Files:**
- Create:
  - `src/views/file-field.tsx` (`FileField`, built on `FormField`)
  - `src/views/apple-card-group.tsx` (`AppleCardGroup`)
  - `src/views/apple-card-sheet.tsx` (`AppleCardSheet`)
  - (no separate Remove file: the Remove page is drawn in `src/routes/accounts.tsx`, beside Disconnect's page)
- Modify:
  - `src/routes/accounts.tsx`
  - `src/db/accounts.ts`
  - `src/db/balance-history.ts:29-65`
  - `src/db/first-tally.ts`: a per-account version of `forgetPayDeposits`, which today works per Plaid bank (`:195-225`)
  - `src/views/money-input.tsx`: `allowCredit`, `hint` and `noRound` props
  - `public/js/money.js`: a leading minus only where `data-allow-credit` is set, and on those fields `nudged()` and `showCents()` (`:28-49`) work on negative values: no clamp at 0, and cents formatted from the absolute value. Test both, as the existing money input tests do
  - `src/routes/how-it-works.tsx:259-261`: the net-worth example counts the card
  - `src/views/contents-list.tsx:35-45`: More's Accounts count
  - `src/design-system/catalog.tsx`
  - `DESIGN.md`
  - `scripts/pr-body.mjs` `PAGES`: add `/accounts/apple-card`
- Test: `test/apple-card-route.test.ts`, plus the existing design-system and accounts tests

**Interfaces:**
- Consumes:
  - `parseAppleCsv`, `importAppleCard` and `importWords`
  - `afterSync(db)` (`src/plaid/after-sync.ts:13`)
  - `sortAfterSync(env, { changedIds }, { rulesApplied })` (`src/plaid/sort-after-sync.ts:21`; since #735 it starts one SortWorkflow instance with all the rows, and `env` needs the `SORT` binding)
- Produces:
  - `type AppleCardAccount = { id: number; balanceCents: number; balanceOn: string | null; uploadedOn: string | null; removedAt: string | null; through: string | null }`
    - `through` is `MAX(date)` of the card's rows.
    - It is read **in the same batch as** `accountsWithHistory` (`src/db/balance-history.ts:53`), which gains `appleCard: AppleCardAccount | null`. That keeps the headline and the chart in step.
  - The card counts in net worth when `balanceOn !== null && removedAt === null`. Its id joins the chart's id list then. The chart's SQL keeps `a.plaid_item_id IS NOT NULL OR a.subtype = 'apple_card'`, so Cash stays out, and reads the card's `balance_history` only on or after its `counted_from`, so `netWorthSeries` (`src/net-worth.ts:47-75`) never carries a pre-removal balance through the gap.

**The picked look and words** (P141 B, pictures in #731). They are in §8.10; copy them exactly:
- **The group:**
  1. "Apple Card"
  2. "Updated through Oct 18", left out until the card holds a row
  3. One row: the card icon, "Apple Card" with "Balance as of Oct 18" under it, and the balance shown the way account rows show a card's balance (`src/views/account-row.tsx:38`)
  4. "Upload a file" (the `secondary` button)
  5. Manage, holding "Remove Apple Card"
  6. While no balance counts, the row's second line is left out, and "Apple Card isn't in net worth yet. Add its balance next time you upload." (muted) sits under the row.
- **The sheet:**
  1. The card icon and "Apple Card", in serif like Savings' title.
  2. "Upload the file Apple exports. Tally adds the ones it doesn't have yet." (muted).
  3. `FileField` "Apple Card file (CSV)", with "On card.apple.com or in Wallet: Export Transactions, pick the dates, then CSV." under it.
  4. `MoneyInput` "Balance in Wallet", with `allowCredit`, `noRound`, and the hint "Optional. Left blank, Oct 12's balance stays. For a credit, type a minus first." While no balance counts, the hint is "Optional. For a credit, type a minus first."
  5. Cancel and Upload, in Savings' grid.
- **Before the first upload:** "Add Apple Card" (`secondary`) beside Link a bank, under the banks, once a bank is linked. With no bank linked, the empty state offers only Link a bank, as today. The empty state shows only when there are no banks **and** no card (`src/routes/accounts.tsx:53`).

**Words decided here (not the owner's):**
- No file: "Choose the CSV file Apple exported."
- Too big: "This file is over 1 MB. An Apple Card CSV is far smaller, so check it's the right file."
- A bad balance: "Enter the balance as dollars, like 1,240.18, or with a minus for a credit."
- The demo sheet: "In the demo, Tally uses a sample file." with "Add the sample" in place of the file field and the balance field. The sample brings its own balance (`APPLE_CARD_SAMPLE_BALANCE_CENTS = 124018`), so the demo's card counts in net worth.

- [ ] **Step 1: Catalog first.**
  - `FileField` (Visual): empty, and with an error under it (`role="alert"`). Give it its full use spec in DESIGN.md.
  - `AppleCardGroup`: before the first upload, with a balance, with no balance yet, and removed.
  - `AppleCardSheet`: empty, with each error, and the demo's version.
  - The DESIGN.md entries. The entry format is pinned by `test/design-system-route.test.ts:515`.
- [ ] **Step 2: Write the failing route tests.**
  - **Harness.** Call `accounts.request(path, init, bindings)` with `DEMO: "false"` bindings, an actor wrapper as `test/transactions-first-visit.test.ts:15-20` builds, and a ctx with `waitUntil` as `test/accounts-route.test.ts:280-290` does. Build a multipart body with `new FormData()` and `body.set("file", new File([csv], "apple.csv", { type: "text/csv" }))`. Add one `exports.default.fetch` demo POST with `Origin`, which passes, and one without, which gets a 403.
  - **GET `/accounts/apple-card`:**
    - With HX, it returns the sheet in `#sheet`, which is the last child of `#accounts-summary`.
    - Without HX, it returns Accounts with the sheet open.
    - "Upload a file", "Add Apple Card" and Home's Upload all open it with `sheetAttrs` (`src/views/bottom-sheet.tsx`).
  - **POST `/accounts/apple-card`, success:**
    - With HX, it returns the redrawn `#accounts-summary`, `HX-Push-Url: /accounts`, focus on "Upload a file", and an `HX-Trigger` toast and announce of `importWords(…)`.
    - Without HX, it answers 303 to `/accounts`.
    - It runs `afterSync` (a merchant rule applies to a new row) inside try/catch, then `waitUntil(sortAfterSync(env, { changedIds: addedIds }, { rulesApplied: !afterSyncFailed }))`, which hands every added row to the sorting Workflow (decision 139), as Sync now does (`src/routes/accounts.tsx:159-164`).
    - The form keeps Savings' double-tap guard (`hx-disable`).
  - **POST refusals.** Each returns 422 with the sheet `still`, a `role="alert"`, the typed balance kept, and nothing saved:
    - Not Apple's file: `NOT_APPLE`.
    - No bank, no bank history and no card rows (a first upload before any bank): "Link a bank first. Tally's history starts with your bank's." With a disconnected bank's rows kept, uploads, Accounts' Upload and Home's nudge all still work.
    - A bad row: its words.
    - No file (an empty-named `File`).
    - A bad balance.
    - Over 1 MB: a request with no `Content-Length`, or one over 1,100,000, is refused **before** the body is read; `file.size > 1_000_000` is refused after. The demo's POST never reads its body.
  - **Cancel** links to `/accounts?focus=apple-card`, which puts focus on "Upload a file" or "Add Apple Card".
  - **Net worth** (Review Focus 5):
    - The headline, the chart and How Tally works' example count the card once `balance_on` is set, and not before that or while it's removed.
    - A reopened card with a new balance adds nothing to the chart for the days it was removed.
    - With a credit balance, How Tally works' example (`src/how-it-works/examples.ts:99-116`) counts the credit with the accounts, never as a negative amount owed, so it never reads "− -$12 owed".
    - More's Accounts count (`src/views/contents-list.tsx:30-45`) counts accounts, not balances: it counts a card that isn't removed from its first upload, balance or not.
    - A credit adds to net worth.
  - **Accounts with only a card and no bank** shows net worth and the group, not the empty state.
  - **Remove, GET and POST `/accounts/apple-card/remove`,** as Disconnect's confirm (`src/routes/accounts.tsx:332-357`):
    - Keeping rows sets `removed_at` and clears `balance_on`, so the card leaves net worth and any later balance restarts its chart history; Add Apple Card shows again.
    - `delete=yes` calls the per-account pay cleanup first, then deletes the card's transactions, its `balance_history` and the account.
    - Remove isn't offered in the demo: it returns 404, and the group has no Manage there, as with Disconnect.
  - **The first week:** an upload draws no stroke. The first week's waiting count still counts Plaid rows only (`src/first-tally/setup.ts:~417`, `src/db/transactions.ts:2759`).
  - **Demo (`DEMO: "true"`):** the sheet has no file or balance field; the POST never reads its body and imports `appleCardSample(today)` with `APPLE_CARD_SAMPLE_BALANCE_CENTS` (Task 6), and the demo's card counts in net worth.
  - **A card with no rows** (its first upload held only uncleared or older rows, or none), after the last bank and its history are deleted: an upload still works, starting 90 days back.
- [ ] **Step 3:** Run `npx vitest run test/apple-card-route.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - Model the routes on Home's `/savings-goal` GET and POST (`src/routes/home.tsx:772-845`).
  - Parse with `c.req.parseBody()`. The file field arrives as a `File` (Hono 4.13.8).
  - Parse the balance with its own parser: blank means no balance; otherwise `toCents`, with a leading minus allowed, and a result that isn't `Number.isSafeInteger` gets the bad-balance error.
- [ ] **Step 5:** Run the tests, then every gate. Expected: PASS.
- [ ] **Step 6:** Commit: `feat: Accounts uploads Apple Card's file in a sheet (P141 B)`.

### Task 5: Home's nudge (PR 3, #767)

**Files:**
- Create: `src/apple-card/stale.ts`
- Modify:
  - `src/views/bank-line.tsx:5-23`: `BankBehind` takes `icon`, `label`, `srLabel` and `href`. The defaults stay the bank icon, "Fix", " the bank in Accounts" and `/accounts`.
  - `src/views/home-top.tsx:91`
  - `src/views/home-setup.tsx:121, 196-199`
  - `src/routes/home.tsx:235-236, 347, 372-373` and `/home/banks` (`:678-713`)
  - `src/design-system/catalog.tsx`: BankBehind gets the Apple Card state, the phone in P141's picture 4
  - `DESIGN.md`: the BankBehind and HomeTop entries
- Test: `test/apple-card-stale.test.ts`, plus the existing Home tests

**Interfaces:**
- Produces:
  - `const APPLE_STALE_AFTER_DAYS = 7`
  - `function appleCardNotice(card: AppleCardAccount | null, today: string): { words: string; since: string } | null`. `since` is the card's `uploaded_on`, the household day of its last upload, so the 7 days count in household days.

- [ ] **Step 1: Write the failing tests:**
  - **When it shows:**
    - An upload 7 days before today gives `{ words: "Apple Card hasn't been updated since Oct 12", since: "2026-10-12" }`.
    - 6 days gives `null`.
    - Removed gives `null`, and so does no account.
  - **On Home:**
    - Home draws a second tinted line, with the card icon and "Upload" opening the upload sheet, and the sr label " an Apple Card file in Accounts". A bank's line, when there is one, comes first.
    - The dashed "as of" tag on Safe to spend takes the earliest `since` of every line and formats it once.
    - The Apple Card line shows on the current month only, never in the demo, and never in the first week's setup lines.
    - It never feeds `flagged` or `statusOf`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: Home nudges after a week without an Apple Card upload`.

### Task 6: The demo sample and How Tally works' line (PR 2, #766)

**Corrections (2026-10-21, from the PR 2 brief):** the export's bank name shipped in #765, so it is dropped here. The sample's dates are anchored to the seeded bank's latest transaction date (`SELECT MAX(t.date) FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.plaid_item_id IS NOT NULL`), so a second "Add the sample" finds its rows already held. How Tally works' line goes in the intro paragraph (`src/routes/how-it-works.tsx:300-307`).

**Files:**
- Create: `src/demo/apple-card-sample.ts`
- Modify:
  - `src/routes/how-it-works.tsx:300-307`
- Test: `test/apple-card-sample.test.ts`

**Interfaces:**
- Produces: `const APPLE_CARD_SAMPLE_BALANCE_CENTS = 124018` and `function appleCardSample(anchor: string): string`. It's a made-up CSV in Apple's 8-column header, dated back from `anchor` (the seeded bank's latest transaction date) within the seed's history, with 12–16 rows:
  - purchases at the Riveras' usual stores
  - one pair of twins
  - one Payment
  - one bounced payment (an `Other` row whose Description says REVERSAL, money out, with its payment)
  - one Credit refund
  - one Interest row
  - one row with a blank Clearing Date

- [ ] **Step 1: Write the failing tests:**
  - `parseAppleCsv(appleCardSample("2026-09-22"))` is ok and holds every kind listed above.
  - After a demo POST, the nightly `resetDemo` leaves no Apple Card account (`src/demo/reset.ts:24-47`).
  - How Tally works says "Apple Card comes in when you upload the file Apple exports, because Plaid can't reach it. Paying off the card, or a payment that bounced, is left out on both sides, so it never counts as spending."
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS. Then run every gate, the e2e included.
- [ ] **Step 5:** Commit: `feat: the demo's Apple Card sample, and How Tally works' line (#766)`.

## Confidence

**Task 1: 7.**
- Verified: `toCents` accepts `$`, thousands commas and 1–2 decimals and throws otherwise (`src/money.ts:5-16`).
- Verified from the owner's export (2026-10-21), the gate in the header: the 8-column header; Apple's Type words `Purchase`, `Payment`, `Interest` and `Other` (a refund's word is still unconfirmed, and it counts by its sign); Payment and Interest rows with a Merchant; no blank Merchant or Clearing Date; UTF-8 with no byte-order mark, LF line endings and no newline after the last row; every field quoted except the two dates, which are zero-padded `MM/DD/YYYY`.

**Task 2: 8.**
- Verified: `shortDay` (`src/dates.ts:130-134`) and `daysBefore` (`:143`).
- Verified: split parts never copy `upload_key`, and uploaded rows aren't deleted one by one (only cash is, `src/transactions/cash-undo.ts:51`).

**Task 3: 7.**
- Verified:
  - An upsert-SELECT with `WHERE 1` and `RETURNING` inside a batch (`src/db/merchant-names.ts:96-144`).
  - A partial-index conflict target (`src/transactions/cash.ts:116-121`, migrations 0014 and 0019).
  - The move is safe: one call site (`src/plaid/sync.ts:989`) and no test imports it.
  - Seed accounts carry `plaid_item_id` (`src/demo/reset.ts:135-150`).
  - `excluded_source = 'plaid'` readers are safe for Apple rows:
    - `src/transactions/edit.ts:251`
    - `src/db/counted-month.ts:112`
    - `src/db/transactions.ts:1396-1409`
    - `src/bills/find.ts:145`, which needs LOAN_PAYMENTS
    - `src/plaid/pending-merge.ts:257`, Plaid only
    - `rule-offer.ts:19`
- Unknown: D1's limit on one bound value. The 500-row chunks keep each well under 1 MB. The 250-row test proves the path.

**Task 4: 8.**
- Verified:
  - A multipart POST passes the same-origin check with `Origin` (`src/security.ts:44`, `src/index.tsx:152`).
  - `parseBody` returns `File` (Hono 4.13.8, `body.js`).
  - htmx 4 sends a file when the form's `enctype` is multipart.
  - Disconnect's SQL (`src/routes/accounts.tsx:332-357`).
  - `secondary` is the outlined button (`src/views/button.tsx:8-9`).
  - The chart's id filter (`src/db/balance-history.ts:62-65`).
- Verified: `nudged()` clamps at 0 and `showCents()` assumes a non-negative value (`public/js/money.js:28-49`), so both change on credit fields.

**Task 5: 8.**
- Verified: `BankBehind` hard-codes its icon and Fix (`src/views/bank-line.tsx:21-23`), and is drawn at `home-top.tsx:91` and `home-setup.tsx:121, 199`.
- Verified: `contents-list.tsx:36` uses `flaggedBanks` for sign-in only.

**Task 6: 8.**
- Verified: the demo reset clears accounts, transactions and balance history (`src/demo/reset.ts:24-47`).
