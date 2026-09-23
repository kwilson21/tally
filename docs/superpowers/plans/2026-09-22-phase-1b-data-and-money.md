# Phase 1b (Data and Money) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the D1 schema, the money and budget math as pure tested functions, the query that loads a month, and the Rivera family demo seed with a reset function. Phase 1c screens can then render real numbers.

**Architecture:** One D1 binding (`DB`) with numbered SQL migrations in `migrations/`. Money is integer cents everywhere. `src/money.ts` handles converting to and from cents and formatting dollars. `src/budget.ts` turns a month's rows into a summary (spent, left, uncategorized, income, safe to spend, status sentence) with no I/O. `src/db/month.ts` is the only SQL that feeds it. `src/demo/seed.ts` builds the demo household as plain data relative to "today". `src/demo/reset.ts` wipes and reloads it in one `db.batch()`. Tests run against a real local D1 with migrations applied through `@cloudflare/vitest-plugin`.

**Tech stack:** Cloudflare D1 (SQLite), Wrangler D1 migrations, `@cloudflare/vitest-plugin` (`readD1Migrations`, `applyD1Migrations`), Hono, TypeScript.

**Spec:** §5 (data model), §6 (money rules and budget math), §9 (demo). **Issues:** #6 D1 schema and migrations, #7 Money utilities, #8 Budget math, #9 Seed household (Rivera family), plus the seeding half of #15 Nightly demo reset (the cron wiring and deploy stay in 1d).

**Docs checked on 2026-09-22 (Context7):**
- `d1_databases` entries need `binding`, `database_name`, and `database_id`. `migrations_dir` defaults to `migrations/`. In local mode, Wrangler writes to local storage, not the remote database.
- `npx wrangler d1 migrations create <DB> <message>` creates numbered files. `npx wrangler d1 migrations apply <DB> --local` applies them locally.
- Tests: `cloudflareTest(async () => ({ miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations(path) } } }))`, plus a `setupFiles` script that calls `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` (both from `cloudflare:test`).
- `db.batch([...])` is atomic, all or nothing (verified in docs/verified-assumptions.md, item 3).

---

## Spec clarifications this plan makes (Task 0 writes them into the spec)

The spec left these open. Each is the simplest choice that fits the design, and the owner reviews them with this plan:

1. **Flags become three columns:** `flag_transfer`, `flag_reimbursement`, `flag_income` (0/1), instead of one `flags` text field. They're easier to query and explain, and there's no string parsing.
2. **Categories store their look:** `icon` (an `IconName` from `src/views/icons.tsx`) and `color` (a token name like `cat-blue`), so the UI and the data agree on what each category looks like.
3. **Accounts can exist without Plaid:** `accounts.plaid_item_id` and `plaid_account_id` are nullable, because demo accounts have no Plaid item.
4. **Income isn't spending:** income-flagged transactions are left out of Spent, Uncategorized, and Safe to spend, and count only toward Income. Otherwise a paycheck with no category would show up as a negative "uncategorized" amount.
5. **Where the status sentence comes from:** code builds it from the summary (examples in Task 5).

---

## File structure

| File | Job |
|---|---|
| `migrations/0001_initial_schema.sql` | Every table from spec §5 (as clarified above), with constraints and indexes |
| `wrangler.jsonc` | Adds the `DB` binding (local placeholder ID) and the `DEMO` var |
| `vitest.config.ts` | Loads migrations into a test binding |
| `test/apply-migrations.ts` | Applies migrations before the tests run |
| `test/env.d.ts` | Types the `TEST_MIGRATIONS` test binding |
| `src/money.ts` | `toCents`, `plaidAmountToCents`, `formatCents` |
| `src/budget.ts` | `budgetForMonth`, `summarizeMonth`, `statusSentence`, and their types |
| `src/db/month.ts` | `loadMonth(db, month)`: the SQL that feeds `summarizeMonth` |
| `src/demo/seed.ts` | `buildSeed(today)`: the Rivera household as plain data |
| `src/demo/reset.ts` | `resetDemo(db, today)`: wipe and reload in one batch |
| `src/index.tsx` | `scheduled` handler: resets the demo when `DEMO === "true"` |
| `test/schema.test.ts`, `test/money.test.ts`, `test/budget.test.ts`, `test/month.test.ts`, `test/seed.test.ts` | Tests |

---

### Task 0: Branch and spec clarifications

- [ ] **Step 1: Branch.** Run: `git switch main && git pull && git switch -c phase-1b-data-and-money`

- [ ] **Step 2: Update the spec** (`docs/superpowers/specs/2026-09-22-tally-design.md`):
  - §5 `accounts` row: mark `plaid_item_id` and `plaid_account_id` as nullable, with the note "(null for demo accounts)".
  - §5 `categories` row: key columns become `id`, `name` (unique), `icon`, `color` (token name, e.g. `cat-blue`), `sort_order`, `archived`.
  - §5 `transactions` row: replace `flags` (e.g. …) with `flag_transfer`, `flag_reimbursement`, `flag_income` (0/1).
  - §6: after the "Counted transactions" sentence, add: "Transactions flagged `income` are counted only toward **Income**. They're left out of Spent, Uncategorized, and Safe to spend."
  - §6 Safe to spend row: change "minus all counted spending" to "minus all counted spending (income excluded)".

- [ ] **Step 3: Add a decision** to `docs/decisions.md` as the next number:
  `| 23 | 2026-09-22 | Data model clarifications: flags as three 0/1 columns; categories store icon + color token; accounts may lack a Plaid item; income is excluded from spending math | Each removes an ambiguity in spec §5–§6 with the simplest representation. See Phase 1b plan. |`

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: clarify data model and income handling for Phase 1b

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: D1 binding, migrations folder, test setup

**Files:**
- Modify: `wrangler.jsonc`, `vitest.config.ts`, `test/env.d.ts`
- Create: `test/apply-migrations.ts`, `migrations/0001_initial_schema.sql` (empty for now)

- [ ] **Step 1: Add to `wrangler.jsonc`**, after the `build` block:

```jsonc
	// Local-only placeholder ID. Real demo/production databases are created in Phase 1d
	// (wrangler d1 create) and set per environment.
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "tally-local",
			"database_id": "00000000-0000-0000-0000-000000000000",
			"migrations_dir": "migrations"
		}
	],
	// "true" shows the demo banner and lets the nightly job reset the data. Production sets "false" in Phase 1d.
	"vars": {
		"DEMO": "true"
	}
```

- [ ] **Step 2: Create `migrations/0001_initial_schema.sql`** as an empty file (Task 2 fills it in).

- [ ] **Step 3: Regenerate types.** Run: `npm run cf-typegen`. Expected: `worker-configuration.d.ts` now contains `DB: D1Database` and `DEMO: "true"` (or `string`).

- [ ] **Step 4: Replace `vitest.config.ts`**

```ts
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				// Test-only binding so test/apply-migrations.ts can build the schema.
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations(
						path.join(import.meta.dirname, "migrations"),
					),
				},
			},
		})),
	],
	test: {
		setupFiles: ["./test/apply-migrations.ts"],
	},
});
```

- [ ] **Step 5: Create `test/apply-migrations.ts`**

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 6: Type the test binding.** Append to `test/env.d.ts`:

```ts
declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {
		TEST_MIGRATIONS: D1Migration[];
	}
}
```

Check the current `@cloudflare/vitest-plugin` docs for the name of the interface that types `env` from `cloudflare:test` (it has been `ProvidedEnv`). If it's different, use the documented name and report it. If `env` should now come from `cloudflare:workers`, as it does for `exports`, switch `test/apply-migrations.ts` to that import and report it.

- [ ] **Step 7: Run all tests.** Run: `npm test`. Expected: the existing 35 tests pass (the migrations are empty, so nothing is applied yet).

- [ ] **Step 8: Commit**

```bash
git add wrangler.jsonc worker-configuration.d.ts vitest.config.ts test/apply-migrations.ts test/env.d.ts migrations
git commit -m "build: add D1 binding, migrations folder, and test migration setup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Initial schema

**Files:**
- Modify: `migrations/0001_initial_schema.sql`
- Create: `test/schema.test.ts`

- [ ] **Step 1: Write the failing test** `test/schema.test.ts`

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const db = env.DB;

async function tables() {
	const { results } = await db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
		)
		.all<{ name: string }>();
	return results.map((r) => r.name);
}

beforeEach(async () => {
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM bills"),
		db.prepare("DELETE FROM budget_amounts"),
		db.prepare("DELETE FROM merchants"),
		db.prepare("DELETE FROM categories"),
		db.prepare("DELETE FROM accounts"),
	]);
	await db.batch([
		db.prepare("INSERT INTO categories (id, name, icon, color) VALUES (1, 'Groceries', 'groceries', 'cat-blue')"),
		db.prepare("INSERT INTO accounts (id, name, type) VALUES (1, 'Checking', 'depository')"),
		db.prepare("INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (1, 'Internet', 8000, 5, 'monthly', 'COMCAST')"),
		db.prepare("INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (1, 1, '2026-09-05', 8000, 'COMCAST')"),
		db.prepare("INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (2, 1, '2026-10-05', 8000, 'COMCAST')"),
	]);
});

describe("schema", () => {
	it("creates every table from spec §5", async () => {
		expect(await tables()).toEqual([
			"accounts",
			"balance_history",
			"bill_payments",
			"bills",
			"budget_amounts",
			"categories",
			"documents",
			"merchants",
			"plaid_items",
			"transactions",
		]);
	});

	it("stores money as integers and rejects fractional cents", async () => {
		await expect(
			db.prepare("INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, '2026-09-01', 12.5, 'X')").run(),
		).rejects.toThrow();
	});

	it("rejects a malformed transaction date", async () => {
		await expect(
			db.prepare("INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, '9/1/2026', 100, 'X')").run(),
		).rejects.toThrow();
	});

	it("enforces foreign keys", async () => {
		await expect(
			db.prepare("INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (999, '2026-09-01', 100, 'X')").run(),
		).rejects.toThrow();
	});

	it("allows only one linked payment per bill period", async () => {
		await db.prepare("INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (1, '2026-09', 1, 'auto', 'linked')").run();
		await expect(
			db.prepare("INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (1, '2026-09', 2, 'auto', 'linked')").run(),
		).rejects.toThrow();
	});

	it("lets a transaction pay only one bill occurrence, but allows dismissed rows", async () => {
		await db.prepare("INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (1, '2026-09', 1, 'auto', 'linked')").run();
		await expect(
			db.prepare("INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (1, '2026-10', 1, 'auto', 'linked')").run(),
		).rejects.toThrow();
		await db.prepare("INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (1, '2026-10', 1, 'user', 'dismissed')").run();
	});
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `npm test -- test/schema.test.ts`. Expected: FAIL (no such table).

- [ ] **Step 3: Write `migrations/0001_initial_schema.sql`**

```sql
-- Tally initial schema. Money is integer cents. Dates are 'YYYY-MM-DD' strings as Plaid sends them.

CREATE TABLE plaid_items (
  id INTEGER PRIMARY KEY,
  access_token_encrypted BLOB NOT NULL,
  institution_name TEXT NOT NULL,
  sync_cursor TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'needs_attention')),
  linked_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  plaid_item_id INTEGER REFERENCES plaid_items(id),
  plaid_account_id TEXT UNIQUE,
  name TEXT NOT NULL,
  mask TEXT,
  type TEXT NOT NULL,
  subtype TEXT,
  is_liability INTEGER NOT NULL DEFAULT 0 CHECK (is_liability IN (0, 1)),
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(balance_cents) = 'integer'),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE balance_history (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  balance_cents INTEGER NOT NULL CHECK (typeof(balance_cents) = 'integer'),
  PRIMARY KEY (account_id, date)
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL,
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);

CREATE TABLE budget_amounts (
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  effective_month TEXT NOT NULL CHECK (effective_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents >= 0),
  PRIMARY KEY (category_id, effective_month)
);

CREATE TABLE merchants (
  raw_name TEXT PRIMARY KEY,
  suggested_name TEXT,
  display_name TEXT,
  default_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  suggestion_status TEXT NOT NULL DEFAULT 'none'
    CHECK (suggestion_status IN ('none', 'pending', 'accepted', 'rejected'))
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY,
  plaid_transaction_id TEXT UNIQUE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer'),
  raw_name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_source TEXT CHECK (category_source IN ('user', 'merchant_rule', 'jev')),
  category_confidence REAL,
  flag_transfer INTEGER NOT NULL DEFAULT 0 CHECK (flag_transfer IN (0, 1)),
  flag_reimbursement INTEGER NOT NULL DEFAULT 0 CHECK (flag_reimbursement IN (0, 1)),
  flag_income INTEGER NOT NULL DEFAULT 0 CHECK (flag_income IN (0, 1)),
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  parent_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  is_split INTEGER NOT NULL DEFAULT 0 CHECK (is_split IN (0, 1)),
  note TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX transactions_date ON transactions(date);
CREATE INDEX transactions_category ON transactions(category_id);
CREATE INDEX transactions_raw_name ON transactions(raw_name);
CREATE INDEX transactions_parent ON transactions(parent_id);

CREATE TABLE bills (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'yearly')),
  anchor_month INTEGER CHECK (anchor_month BETWEEN 1 AND 12),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  merchant_raw_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  CHECK (frequency = 'monthly' OR anchor_month IS NOT NULL)
);

CREATE TABLE bill_payments (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]' OR period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  matched_by TEXT NOT NULL CHECK (matched_by IN ('auto', 'user')),
  status TEXT NOT NULL CHECK (status IN ('linked', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Each bill gets at most one payment per period, and each transaction pays at most one bill (spec §6.1).
CREATE UNIQUE INDEX bill_payments_one_per_period ON bill_payments(bill_id, period) WHERE status = 'linked';
CREATE UNIQUE INDEX bill_payments_one_bill_per_transaction ON bill_payments(transaction_id) WHERE status = 'linked';

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT
);
```

- [ ] **Step 4: Run the tests.** Run: `npm test -- test/schema.test.ts`. Expected: PASS. If the foreign-key test fails, D1/Miniflare isn't enforcing foreign keys by default. Check the D1 docs on foreign keys, apply whatever they recommend, and report it.

- [ ] **Step 5: Check the migration applies with Wrangler too.** Run: `npx wrangler d1 migrations apply DB --local`. Expected: "Migrations applied" (answer yes if prompted). This is the command 1c uses for local dev.

- [ ] **Step 6: Commit**

```bash
git add migrations/0001_initial_schema.sql test/schema.test.ts
git commit -m "feat: add initial D1 schema with money, date, and bill-matching constraints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Money utilities

**Files:**
- Create: `src/money.ts`, `test/money.test.ts`

- [ ] **Step 1: Write the failing test** `test/money.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { formatCents, plaidAmountToCents, toCents } from "../src/money";

describe("toCents (form input → cents)", () => {
	it.each([
		["12", 1200],
		["12.3", 1230],
		["12.34", 1234],
		["$1,284.50", 128450],
		[" 0.99 ", 99],
		["-45.10", -4510],
	])("%s → %i", (input, cents) => {
		expect(toCents(input)).toBe(cents);
	});

	it.each(["", "abc", "12.345", "1.2.3", "$", "--5"])("rejects %j", (input) => {
		expect(() => toCents(input)).toThrow();
	});
});

describe("plaidAmountToCents (Plaid float → cents, never float math on stored values)", () => {
	it.each([
		[12.34, 1234],
		[0.29, 29],
		[1.005, 101],
		[-2450, -245000],
		[64.18, 6418],
	])("%d → %i", (amount, cents) => {
		expect(plaidAmountToCents(amount)).toBe(cents);
	});
});

describe("formatCents (cents → display)", () => {
	it.each([
		[128400, {}, "$1,284.00"],
		[128400, { wholeDollars: true }, "$1,284"],
		[650, {}, "$6.50"],
		[-245000, {}, "-$2,450.00"],
		[-245000, { signed: true }, "+$2,450.00"],
		[6418, { signed: true }, "$64.18"],
		[0, {}, "$0.00"],
	] as const)("%i %j → %s", (cents, options, text) => {
		expect(formatCents(cents, options)).toBe(text);
	});
});
```

Note on `signed`: the transaction list shows money *in* with a plus sign. Under Plaid's convention, negative amounts are money in, so `signed: true` shows negative cents as `+$…` and positive cents with no sign.

- [ ] **Step 2: Run it and watch it fail.** Run: `npm test -- test/money.test.ts`. Expected: FAIL.

- [ ] **Step 3: Create `src/money.ts`**

```ts
// Money is integer cents everywhere. Convert at the edges only: form input, Plaid, display.

const DOLLARS = /^-?\d+(\.\d{1,2})?$/;

/** Parses a typed dollar amount ("$1,284.50") into integer cents. Throws on anything else. */
export function toCents(input: string): number {
	const cleaned = input.trim().replace(/[$,]/g, "");
	if (!DOLLARS.test(cleaned)) throw new Error(`Not a dollar amount: ${input}`);
	const negative = cleaned.startsWith("-");
	const [whole = "0", fraction = ""] = cleaned.replace("-", "").split(".");
	const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
	return negative ? -cents : cents;
}

/** Converts Plaid's float amount to integer cents via its decimal string, so 1.005 → 101, not 100. */
export function plaidAmountToCents(amount: number): number {
	const [whole, fraction = ""] = Math.abs(amount).toFixed(3).split(".");
	const thousandths = Number(whole) * 1000 + Number(fraction);
	const cents = Math.round(thousandths / 10);
	return amount < 0 ? -cents : cents;
}

type FormatOptions = {
	/** "$1,284" instead of "$1,284.00" (headline amounts). */
	wholeDollars?: boolean;
	/** Show money in (negative, per Plaid) as "+$…" and money out with no sign. */
	signed?: boolean;
};

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const wholeDollars = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 0,
});

/** Formats integer cents for display. */
export function formatCents(cents: number, options: FormatOptions = {}): string {
	const formatter = options.wholeDollars ? wholeDollars : dollars;
	const text = formatter.format(Math.abs(cents) / 100);
	if (options.signed) return cents < 0 ? `+${text}` : text;
	return cents < 0 ? `-${text}` : text;
}
```

- [ ] **Step 4: Run the tests.** Run: `npm test -- test/money.test.ts`. Expected: PASS. If `1.005 → 101` fails, `toFixed(3)` isn't giving `"1.005"` in this runtime. Print it, and switch to converting through `amount.toString()` with manual rounding of the third decimal. Keep the test as written.

- [ ] **Step 5: Commit**

```bash
git add src/money.ts test/money.test.ts
git commit -m "feat: add cents parsing, Plaid conversion, and dollar formatting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Budget math (pure)

**Files:**
- Create: `src/budget.ts`, `test/budget.test.ts`

- [ ] **Step 1: Write the failing test** `test/budget.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
	type BudgetAmount,
	type CountedTransaction,
	budgetForMonth,
	summarizeMonth,
} from "../src/budget";

const CATEGORIES = [
	{ id: 1, name: "Groceries" },
	{ id: 2, name: "Eating Out" },
	{ id: 3, name: "Gas" },
];

const AMOUNTS: BudgetAmount[] = [
	{ categoryId: 1, effectiveMonth: "2026-04", amountCents: 60000 },
	{ categoryId: 2, effectiveMonth: "2026-04", amountCents: 20000 },
	{ categoryId: 2, effectiveMonth: "2026-07", amountCents: 25000 },
	// Gas has no budget until September.
	{ categoryId: 3, effectiveMonth: "2026-09", amountCents: 20000 },
];

describe("budgetForMonth", () => {
	it.each([
		[2, "2026-05", 20000],
		[2, "2026-07", 25000],
		[2, "2026-09", 25000],
		[1, "2026-09", 60000],
		[3, "2026-08", null],
		[3, "2026-09", 20000],
	])("category %i in %s → %s", (categoryId, month, expected) => {
		expect(budgetForMonth(AMOUNTS, categoryId, month)).toBe(expected);
	});
});

const tx = (categoryId: number | null, amountCents: number, income = false): CountedTransaction => ({
	categoryId,
	amountCents,
	income,
});

describe("summarizeMonth", () => {
	const summary = summarizeMonth({
		month: "2026-09",
		categories: CATEGORIES,
		amounts: AMOUNTS,
		transactions: [
			tx(1, 41200),
			tx(2, 30000),
			tx(2, -1400), // refund reduces Eating Out
			tx(3, 13800),
			tx(null, 1200),
			tx(null, 2349),
			tx(null, -245000, true), // paycheck
			tx(null, -245000, true),
		],
		unpaidDueBillsCents: 14200,
	});

	it("computes spent, left, and over per category", () => {
		expect(summary.categories).toEqual([
			{ id: 1, name: "Groceries", budgetCents: 60000, spentCents: 41200, leftCents: 18800, over: false },
			{ id: 2, name: "Eating Out", budgetCents: 25000, spentCents: 28600, leftCents: -3600, over: true },
			{ id: 3, name: "Gas", budgetCents: 20000, spentCents: 13800, leftCents: 6200, over: false },
		]);
	});

	it("keeps uncategorized as its own total and count, excluding income", () => {
		expect(summary.uncategorized).toEqual({ spentCents: 3549, count: 2 });
	});

	it("counts income separately as a positive amount", () => {
		expect(summary.incomeCents).toBe(490000);
	});

	it("safe to spend = total budget − all non-income spending − unpaid due bills", () => {
		// 105000 − (41200 + 28600 + 13800 + 3549) − 14200
		expect(summary.totalBudgetCents).toBe(105000);
		expect(summary.totalSpentCents).toBe(87149);
		expect(summary.safeToSpendCents).toBe(3651);
	});

	it("leaves categories with no budget out of the budget list but keeps their spending", () => {
		const s = summarizeMonth({
			month: "2026-08",
			categories: CATEGORIES,
			amounts: AMOUNTS,
			transactions: [tx(3, 5000)],
			unpaidDueBillsCents: 0,
		});
		expect(s.categories.map((c) => c.name)).toEqual(["Groceries", "Eating Out"]);
		expect(s.totalSpentCents).toBe(5000);
	});
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `npm test -- test/budget.test.ts`. Expected: FAIL.

- [ ] **Step 3: Create `src/budget.ts`**

```ts
// Budget math from spec §6. Pure functions: rows in, numbers out. All amounts are integer cents.

export type BudgetAmount = { categoryId: number; effectiveMonth: string; amountCents: number };
export type Category = { id: number; name: string };
/** A counted transaction: in the month, not excluded, not a split parent (the query guarantees this). */
export type CountedTransaction = { categoryId: number | null; amountCents: number; income: boolean };

export type CategorySummary = Category & {
	budgetCents: number;
	spentCents: number;
	leftCents: number;
	over: boolean;
};

export type MonthSummary = {
	month: string;
	categories: CategorySummary[];
	uncategorized: { spentCents: number; count: number };
	incomeCents: number;
	totalBudgetCents: number;
	totalSpentCents: number;
	safeToSpendCents: number;
};

/** The budget for a category in a month: the latest amount effective on or before that month, or null. */
export function budgetForMonth(amounts: BudgetAmount[], categoryId: number, month: string): number | null {
	let best: BudgetAmount | undefined;
	for (const a of amounts) {
		if (a.categoryId !== categoryId || a.effectiveMonth > month) continue;
		if (!best || a.effectiveMonth > best.effectiveMonth) best = a;
	}
	return best ? best.amountCents : null;
}

type MonthInput = {
	month: string;
	categories: Category[];
	amounts: BudgetAmount[];
	transactions: CountedTransaction[];
	/** Bills due or overdue this month and not paid (0 until Phase 3 adds bills). */
	unpaidDueBillsCents: number;
};

export function summarizeMonth(input: MonthInput): MonthSummary {
	const spentByCategory = new Map<number, number>();
	let uncategorizedCents = 0;
	let uncategorizedCount = 0;
	let incomeCents = 0;
	let totalSpentCents = 0;

	for (const t of input.transactions) {
		if (t.income) {
			incomeCents -= t.amountCents; // money in is negative under Plaid's convention
			continue;
		}
		totalSpentCents += t.amountCents;
		if (t.categoryId === null) {
			uncategorizedCents += t.amountCents;
			uncategorizedCount += 1;
		} else {
			spentByCategory.set(t.categoryId, (spentByCategory.get(t.categoryId) ?? 0) + t.amountCents);
		}
	}

	const categories: CategorySummary[] = [];
	for (const c of input.categories) {
		const budgetCents = budgetForMonth(input.amounts, c.id, input.month);
		if (budgetCents === null) continue;
		const spentCents = spentByCategory.get(c.id) ?? 0;
		const leftCents = budgetCents - spentCents;
		categories.push({ ...c, budgetCents, spentCents, leftCents, over: leftCents < 0 });
	}

	const totalBudgetCents = categories.reduce((sum, c) => sum + c.budgetCents, 0);

	return {
		month: input.month,
		categories,
		uncategorized: { spentCents: uncategorizedCents, count: uncategorizedCount },
		incomeCents,
		totalBudgetCents,
		totalSpentCents,
		safeToSpendCents: totalBudgetCents - totalSpentCents - input.unpaidDueBillsCents,
	};
}
```

- [ ] **Step 4: Run the tests.** Run: `npm test -- test/budget.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/budget.ts test/budget.test.ts
git commit -m "feat: add pure budget math (spent, left, uncategorized, income, safe to spend)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Status sentence

**Files:**
- Modify: `src/budget.ts`, `test/budget.test.ts`

- [ ] **Step 1: Add the failing tests** to `test/budget.test.ts`. Add `statusSentence` to the existing import from `../src/budget` (one import per module), then append:

```ts

const cat = (name: string, leftCents: number) => ({
	id: 0,
	name,
	budgetCents: 10000,
	spentCents: 10000 - leftCents,
	leftCents,
	over: leftCents < 0,
});

describe("statusSentence", () => {
	it.each([
		[[cat("Groceries", 100), cat("Gas", 50)], "Everything is on track."],
		[[cat("Eating Out", -3600), cat("Gas", 50)], "Eating Out is $36 over. Everything else is on track."],
		[[cat("Eating Out", -3650), cat("Gas", 50)], "Eating Out is $36.50 over. Everything else is on track."],
		[[cat("Eating Out", -100), cat("Gas", -200), cat("Kids", 5)], "Eating Out and Gas are over. Everything else is on track."],
		[[cat("Eating Out", -100), cat("Gas", -200), cat("Kids", -5)], "Eating Out, Gas, and Kids are over."],
		[[], "No budgets set yet."],
	])("%#", (categories, sentence) => {
		expect(statusSentence(categories)).toBe(sentence);
	});
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `npm test -- test/budget.test.ts`. Expected: FAIL (statusSentence isn't exported).

- [ ] **Step 3: Append to `src/budget.ts`**

```ts
import { formatCents } from "./money";

const listFormat = new Intl.ListFormat("en-US", { style: "long", type: "conjunction" });

/** The one-line status under the headline, written by code from the numbers (never by AI). */
export function statusSentence(categories: CategorySummary[]): string {
	if (categories.length === 0) return "No budgets set yet.";
	const over = categories.filter((c) => c.over);
	if (over.length === 0) return "Everything is on track.";
	const rest = over.length < categories.length ? " Everything else is on track." : "";
	if (over.length === 1) {
		const [only] = over as [CategorySummary];
		const amount = -only.leftCents;
		const text = formatCents(amount, { wholeDollars: amount % 100 === 0 });
		return `${only.name} is ${text} over.${rest}`;
	}
	return `${listFormat.format(over.map((c) => c.name))} are over.${rest}`;
}
```

Move the `import` to the top of the file with any other imports.

- [ ] **Step 4: Run the tests.** Run: `npm test -- test/budget.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/budget.ts test/budget.test.ts
git commit -m "feat: add code-written budget status sentence

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Loading a month from D1

**Files:**
- Create: `src/db/month.ts`, `test/month.test.ts`

- [ ] **Step 1: Write the failing test** `test/month.test.ts`

```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMonth } from "../src/db/month";

const db = env.DB;

beforeAll(async () => {
	// Child tables first, in case another test file left rows behind (foreign keys are enforced).
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM bills"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM budget_amounts"),
		db.prepare("DELETE FROM merchants"),
		db.prepare("DELETE FROM categories"),
		db.prepare("DELETE FROM accounts"),
	]);
	await db.batch([
		db.prepare("INSERT INTO accounts (id, name, type) VALUES (1, 'Checking', 'depository')"),
		db.prepare("INSERT INTO categories (id, name, icon, color, sort_order) VALUES (1, 'Groceries', 'groceries', 'cat-blue', 1), (2, 'Eating Out', 'eating-out', 'cat-plum', 2), (3, 'Old', 'kids', 'cat-ochre', 3)"),
		db.prepare("UPDATE categories SET archived = 1 WHERE id = 3"),
		db.prepare("INSERT INTO budget_amounts VALUES (1, '2026-01', 60000), (2, '2026-01', 25000)"),
		db.prepare(`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, excluded, is_split, parent_id, flag_income) VALUES
			(1, 1, '2026-09-02', 4000, 'TJ', 1, 0, 0, NULL, 0),
			(2, 1, '2026-09-30', 1000, 'CAFE', 2, 0, 0, NULL, 0),
			(3, 1, '2026-08-31', 9999, 'LAST MONTH', 1, 0, 0, NULL, 0),
			(4, 1, '2026-10-01', 9999, 'NEXT MONTH', 1, 0, 0, NULL, 0),
			(5, 1, '2026-09-10', 50000, 'TRANSFER', NULL, 1, 0, NULL, 0),
			(6, 1, '2026-09-12', 3000, 'COSTCO', NULL, 0, 1, NULL, 0),
			(7, 1, '2026-09-12', 2000, 'COSTCO', 1, 0, 0, 6, 0),
			(8, 1, '2026-09-12', 1000, 'COSTCO', 2, 0, 0, 6, 0),
			(9, 1, '2026-09-15', -245000, 'PAYCHECK', NULL, 0, 0, NULL, 1),
			(10, 1, '2026-09-16', 1200, 'SQ *BAKERY', NULL, 0, 0, NULL, 0)`),
	]);
});

describe("loadMonth", () => {
	it("returns only counted transactions for the month", async () => {
		const data = await loadMonth(db, "2026-09");
		const amounts = data.transactions.map((t) => t.amountCents).sort((a, b) => a - b);
		// Excludes last/next month, the excluded transfer, and the split parent; keeps its children.
		expect(amounts).toEqual([-245000, 1000, 1000, 1200, 2000, 4000]);
		expect(data.transactions.find((t) => t.amountCents === -245000)?.income).toBe(true);
	});

	it("returns active categories in sort order and all budget amounts", async () => {
		const data = await loadMonth(db, "2026-09");
		expect(data.categories).toEqual([
			{ id: 1, name: "Groceries", icon: "groceries", color: "cat-blue" },
			{ id: 2, name: "Eating Out", icon: "eating-out", color: "cat-plum" },
		]);
		expect(data.amounts).toHaveLength(2);
	});
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `npm test -- test/month.test.ts`. Expected: FAIL.

- [ ] **Step 3: Create `src/db/month.ts`**

```ts
import type { BudgetAmount, CountedTransaction } from "../budget";

export type CategoryRow = { id: number; name: string; icon: string; color: string };

export type MonthData = {
	categories: CategoryRow[];
	amounts: BudgetAmount[];
	transactions: CountedTransaction[];
};

/** Loads what summarizeMonth needs for a month ('YYYY-MM'). Counted = in month, not excluded, not a split parent. */
export async function loadMonth(db: D1Database, month: string): Promise<MonthData> {
	const [categories, amounts, transactions] = await db.batch([
		db.prepare("SELECT id, name, icon, color FROM categories WHERE archived = 0 ORDER BY sort_order, name"),
		db.prepare(
			"SELECT category_id AS categoryId, effective_month AS effectiveMonth, amount_cents AS amountCents FROM budget_amounts",
		),
		db
			.prepare(
				`SELECT category_id AS categoryId, amount_cents AS amountCents, flag_income AS income
				 FROM transactions
				 WHERE substr(date, 1, 7) = ?1 AND excluded = 0 AND is_split = 0`,
			)
			.bind(month),
	]);

	return {
		categories: categories.results as CategoryRow[],
		amounts: amounts.results as BudgetAmount[],
		transactions: (transactions.results as { categoryId: number | null; amountCents: number; income: number }[]).map(
			(t) => ({ ...t, income: t.income === 1 }),
		),
	};
}
```

- [ ] **Step 4: Run the tests.** Run: `npm test -- test/month.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/month.ts test/month.test.ts
git commit -m "feat: load a month's counted transactions and budgets from D1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The Rivera family seed

**Files:**
- Create: `src/demo/seed.ts`, `test/seed.test.ts`

The seed is plain data built relative to `today` (`'YYYY-MM-DD'`), so the demo always looks current. This month's transactions are dated `min(targetDay, today's day)`, so every total below holds on any date. Previous months each get three transactions per category on days 5, 14, and 23.

**This month's designed totals** (the test asserts them):

| Category | Budget | Spent | State |
|---|---|---|---|
| Groceries | $700 | $412.00 | on track |
| Eating Out | $250 | $286.00 | **$36 over** |
| Gas | $200 | $186.00 | close to the limit (93%) |
| Kids | $300 | $210.00 | on track |
| Household | $250 | $95.00 | on track |
| Uncategorized | — | $228.01 across **12** transactions | needs a category |
| Income | — | $4,900 (two paychecks) | — |
| Excluded | — | $500 transfer, $60 reimbursement | not counted |

Total budget $1,700. Spent $1,417.01. **Safe to spend $282.99** (bills are $0 until Phase 3).

Eating Out's budget changed from $200 to $250 two months ago, which exercises `effective_month`. Eating Out's history creeps up month over month (for Trends in Phase 4).

- [ ] **Step 1: Write the failing test** `test/seed.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { summarizeMonth } from "../src/budget";
import { buildSeed } from "../src/demo/seed";

describe("buildSeed", () => {
	it.each(["2026-09-22", "2026-09-01", "2026-02-28", "2027-01-31"])("designed totals hold on %s", (today) => {
		const seed = buildSeed(today);
		const month = today.slice(0, 7);
		const counted = seed.transactions.filter(
			(t) => t.date.startsWith(month) && !t.excluded && !t.isSplit,
		);

		const summary = summarizeMonth({
			month,
			categories: seed.categories,
			amounts: seed.budgetAmounts,
			transactions: counted.map((t) => ({ categoryId: t.categoryId, amountCents: t.amountCents, income: t.flagIncome })),
			unpaidDueBillsCents: 0,
		});

		const spent = Object.fromEntries(summary.categories.map((c) => [c.name, c.spentCents]));
		expect(spent).toEqual({ Groceries: 41200, "Eating Out": 28600, Gas: 18600, Kids: 21000, Household: 9500 });
		expect(summary.uncategorized).toEqual({ spentCents: 22801, count: 12 });
		expect(summary.incomeCents).toBe(490000);
		expect(summary.safeToSpendCents).toBe(28299);
	});

	it("never dates a transaction after today", () => {
		const seed = buildSeed("2026-09-03");
		expect(seed.transactions.every((t) => t.date <= "2026-09-03")).toBe(true);
	});

	it("includes six months of history with Eating Out creeping up", () => {
		const seed = buildSeed("2026-09-22");
		const eatingOut = (month: string) =>
			seed.transactions
				.filter((t) => t.date.startsWith(month) && t.categoryId === 2)
				.reduce((sum, t) => sum + t.amountCents, 0);
		expect(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"].map(eatingOut)).toEqual([
			17000, 19500, 21500, 24000, 26200,
		]);
	});

	it("has exactly one merchant row per raw name, covering every transaction", () => {
		const seed = buildSeed("2026-09-22");
		const names = seed.merchants.map((m) => m.rawName);
		expect(new Set(names).size).toBe(names.length);
		for (const t of seed.transactions) expect(names).toContain(t.rawName);
	});

	it("changes the Eating Out budget two months ago", () => {
		const seed = buildSeed("2026-09-22");
		expect(seed.budgetAmounts.filter((a) => a.categoryId === 2)).toEqual([
			{ categoryId: 2, effectiveMonth: "2026-04", amountCents: 20000 },
			{ categoryId: 2, effectiveMonth: "2026-07", amountCents: 25000 },
		]);
	});
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `npm test -- test/seed.test.ts`. Expected: FAIL.

- [ ] **Step 3: Create `src/demo/seed.ts`**

```ts
// The Rivera family: the demo household. Plain data, relative to "today", so the demo always looks current.
// Nothing here is real. Designed totals are documented in the Phase 1b plan and asserted in test/seed.test.ts.

import type { BudgetAmount } from "../budget";

export type SeedCategory = { id: number; name: string; icon: string; color: string; sortOrder: number };
export type SeedAccount = { id: number; name: string; mask: string; type: string; subtype: string; isLiability: boolean; balanceCents: number };
export type SeedMerchant = { rawName: string; displayName: string | null; defaultCategoryId: number | null };
export type SeedTransaction = {
	accountId: number;
	date: string;
	amountCents: number;
	rawName: string;
	categoryId: number | null;
	categorySource: "jev" | null;
	categoryConfidence: number | null;
	flagTransfer: boolean;
	flagReimbursement: boolean;
	flagIncome: boolean;
	excluded: boolean;
	isSplit: boolean;
};
export type Seed = {
	categories: SeedCategory[];
	accounts: SeedAccount[];
	merchants: SeedMerchant[];
	budgetAmounts: BudgetAmount[];
	transactions: SeedTransaction[];
};

const GROCERIES = 1;
const EATING_OUT = 2;
const GAS = 3;
const KIDS = 4;
const HOUSEHOLD = 5;
const CHECKING = 1;
const SAVINGS = 2;
const CARD = 3;

const CATEGORIES: SeedCategory[] = [
	{ id: GROCERIES, name: "Groceries", icon: "groceries", color: "cat-blue", sortOrder: 1 },
	{ id: EATING_OUT, name: "Eating Out", icon: "eating-out", color: "cat-plum", sortOrder: 2 },
	{ id: GAS, name: "Gas", icon: "gas", color: "cat-slate", sortOrder: 3 },
	{ id: KIDS, name: "Kids", icon: "kids", color: "cat-ochre", sortOrder: 4 },
	{ id: HOUSEHOLD, name: "Household", icon: "household", color: "cat-brown", sortOrder: 5 },
];

const ACCOUNTS: SeedAccount[] = [
	{ id: CHECKING, name: "Checking", mask: "1234", type: "depository", subtype: "checking", isLiability: false, balanceCents: 421055 },
	{ id: SAVINGS, name: "Savings", mask: "5678", type: "depository", subtype: "savings", isLiability: false, balanceCents: 1240000 },
	{ id: CARD, name: "Credit card", mask: "9012", type: "credit", subtype: "credit card", isLiability: true, balanceCents: 84217 },
];

// Categorized merchants: raw name as a bank sends it → display name.
const MERCHANTS: Record<number, [string, string][]> = {
	[GROCERIES]: [["TRADER JOE'S #552", "Trader Joe's"], ["COSTCO WHSE #0431", "Costco"], ["WHOLEFDS MKT 10233", "Whole Foods"]],
	[EATING_OUT]: [["BLUE BOTTLE COFFEE", "Blue Bottle Coffee"], ["CHIPOTLE 2291", "Chipotle"], ["OLIVE GARDEN 1187", "Olive Garden"], ["MARIO'S PIZZA", "Mario's Pizza"], ["STARBUCKS STORE 5521", "Starbucks"], ["THAI PALACE", "Thai Palace"]],
	[GAS]: [["SHELL OIL 57442", "Shell"], ["CHEVRON 0098812", "Chevron"]],
	[KIDS]: [["TARGET T-1432", "Target"], ["YOUTH SOCCER LEAGUE", "Youth Soccer League"], ["BARNES & NOBLE #2831", "Barnes & Noble"]],
	[HOUSEHOLD]: [["THE HOME DEPOT #6612", "The Home Depot"], ["AMAZON.COM*RT4K2", "Amazon"]],
};

// This month, categorized: [targetDay, rawName, categoryId, cents]. Totals per the plan's table.
const THIS_MONTH: [number, string, number, number][] = [
	[2, "TRADER JOE'S #552", GROCERIES, 6418], [9, "COSTCO WHSE #0431", GROCERIES, 18742], [16, "WHOLEFDS MKT 10233", GROCERIES, 9630], [22, "TRADER JOE'S #552", GROCERIES, 6410],
	[3, "BLUE BOTTLE COFFEE", EATING_OUT, 650], [6, "CHIPOTLE 2291", EATING_OUT, 3840], [12, "OLIVE GARDEN 1187", EATING_OUT, 11280], [15, "MARIO'S PIZZA", EATING_OUT, 6430], [19, "STARBUCKS STORE 5521", EATING_OUT, 1200], [21, "THAI PALACE", EATING_OUT, 5200],
	[4, "SHELL OIL 57442", GAS, 4820], [11, "CHEVRON 0098812", GAS, 5210], [17, "SHELL OIL 57442", GAS, 3770], [20, "CHEVRON 0098812", GAS, 4800],
	[5, "TARGET T-1432", KIDS, 8499], [8, "YOUTH SOCCER LEAGUE", KIDS, 9000], [18, "BARNES & NOBLE #2831", KIDS, 3501],
	[7, "THE HOME DEPOT #6612", HOUSEHOLD, 6125], [13, "AMAZON.COM*RT4K2", HOUSEHOLD, 3375],
];

// This month, uncategorized (12 transactions, $228.01): [targetDay, rawName, cents, displayName].
const UNCATEGORIZED: [number, string, number, string | null][] = [
	[22, "SQ *LOCAL BAKERY 4432", 1200, "Local Bakery"],
	[3, "PAYPAL *XYZSHOP", 2349, null],
	[5, "SQ *FARMERS MKT", 1800, null],
	[6, "VENMO *J RIVERA", 4000, null],
	[8, "TST* CORNER DELI", 1425, null],
	[10, "AMZN MKTP US*2K4", 2799, null],
	[11, "SP * CRAFTSUPPLY", 1980, null],
	[13, "POS 4417 CITY PARKING", 800, null],
	[14, "CHECKCARD 0921 CVS", 1643, null],
	[16, "APPLE.COM/BILL", 299, null],
	[18, "GOOGLE *YOUTUBE", 1399, null],
	[20, "DD *DOORDASH TACO", 3107, null],
];

// Previous months' category totals in cents, oldest first (5 months ago → 1 month ago).
const HISTORY: Record<number, number[]> = {
	[GROCERIES]: [64000, 65500, 61000, 69000, 67200],
	[EATING_OUT]: [17000, 19500, 21500, 24000, 26200],
	[GAS]: [17000, 18200, 16500, 19000, 17600],
	[KIDS]: [24000, 31000, 20500, 28000, 26000],
	[HOUSEHOLD]: [12000, 21000, 14000, 9500, 18000],
};

function monthOffset(today: string, monthsAgo: number): string {
	const [y, m] = today.split("-").map(Number) as [number, number];
	const index = y * 12 + (m - 1) - monthsAgo;
	return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function day(month: string, d: number): string {
	return `${month}-${String(d).padStart(2, "0")}`;
}

function spend(accountId: number, date: string, rawName: string, categoryId: number | null, amountCents: number): SeedTransaction {
	return {
		accountId,
		date,
		amountCents,
		rawName,
		categoryId,
		categorySource: categoryId === null ? null : "jev",
		categoryConfidence: categoryId === null ? null : 0.94,
		flagTransfer: false,
		flagReimbursement: false,
		flagIncome: false,
		excluded: false,
		isSplit: false,
	};
}

/** Builds the Rivera household relative to today ('YYYY-MM-DD'). */
export function buildSeed(today: string): Seed {
	const thisMonth = today.slice(0, 7);
	const todayDay = Number(today.slice(8, 10));
	const clamp = (target: number) => day(thisMonth, Math.min(target, todayDay));
	const transactions: SeedTransaction[] = [];

	// Previous 5 months: three transactions per category (days 5, 14, 23), plus paychecks and the savings transfer.
	for (let monthsAgo = 5; monthsAgo >= 1; monthsAgo--) {
		const month = monthOffset(today, monthsAgo);
		for (const category of CATEGORIES) {
			const total = HISTORY[category.id]?.[5 - monthsAgo] ?? 0;
			const merchants = MERCHANTS[category.id] ?? [];
			const third = Math.floor(total / 3);
			[third, third, total - 2 * third].forEach((cents, i) => {
				const [rawName] = merchants[i % merchants.length] as [string, string];
				transactions.push(spend(i === 2 ? CARD : CHECKING, day(month, [5, 14, 23][i] as number), rawName, category.id, cents));
			});
		}
		transactions.push(income(day(month, 1)), income(day(month, 15)), transfer(day(month, 2)));
	}

	// This month.
	for (const [target, rawName, categoryId, cents] of THIS_MONTH) {
		transactions.push(spend(CHECKING, clamp(target), rawName, categoryId, cents));
	}
	for (const [target, rawName, cents] of UNCATEGORIZED) {
		transactions.push(spend(CARD, clamp(target), rawName, null, cents));
	}
	transactions.push(income(clamp(1)), income(clamp(15)), transfer(clamp(2)), reimbursement(clamp(10)));

	const startMonth = monthOffset(today, 5);
	const budgetAmounts: BudgetAmount[] = [
		{ categoryId: GROCERIES, effectiveMonth: startMonth, amountCents: 70000 },
		{ categoryId: EATING_OUT, effectiveMonth: startMonth, amountCents: 20000 },
		{ categoryId: EATING_OUT, effectiveMonth: monthOffset(today, 2), amountCents: 25000 },
		{ categoryId: GAS, effectiveMonth: startMonth, amountCents: 20000 },
		{ categoryId: KIDS, effectiveMonth: startMonth, amountCents: 30000 },
		{ categoryId: HOUSEHOLD, effectiveMonth: startMonth, amountCents: 25000 },
	];

	const merchants: SeedMerchant[] = [
		...Object.values(MERCHANTS)
			.flat()
			.map(([rawName, displayName]) => ({ rawName, displayName, defaultCategoryId: null })),
		...UNCATEGORIZED.map(([, rawName, , displayName]) => ({ rawName, displayName, defaultCategoryId: null })),
		{ rawName: "ACME CORP PAYROLL", displayName: "Paycheck, Acme Corp", defaultCategoryId: null },
		{ rawName: "ONLINE TRANSFER TO SAV ...5678", displayName: "Transfer to Savings", defaultCategoryId: null },
		{ rawName: "DR MARTIN FAMILY PRACTICE REFUND", displayName: "Reimbursement, doctor's office", defaultCategoryId: null },
	];

	return { categories: CATEGORIES, accounts: ACCOUNTS, merchants, budgetAmounts, transactions };
}

function income(date: string): SeedTransaction {
	return { ...spend(CHECKING, date, "ACME CORP PAYROLL", null, -245000), flagIncome: true };
}

function transfer(date: string): SeedTransaction {
	return { ...spend(CHECKING, date, "ONLINE TRANSFER TO SAV ...5678", null, 50000), flagTransfer: true, excluded: true };
}

function reimbursement(date: string): SeedTransaction {
	return { ...spend(CHECKING, date, "DR MARTIN FAMILY PRACTICE REFUND", null, -6000), flagReimbursement: true, excluded: true };
}
```

There must be exactly one `SeedMerchant` per raw name (`merchants.raw_name` is the primary key). The uniqueness test in Step 1 guards this.

- [ ] **Step 4: Run the tests.** Run: `npm test -- test/seed.test.ts`. Expected: PASS for all four dates. If a total is off, fix the data, not the test. The test is the spec for the demo.

- [ ] **Step 5: Commit**

```bash
git add src/demo/seed.ts test/seed.test.ts
git commit -m "feat: add Rivera family demo seed relative to today

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Reset the demo database

**Files:**
- Create: `src/demo/reset.ts`
- Modify: `src/index.tsx`, `test/seed.test.ts`, `package.json`

- [ ] **Step 1: Add the failing test** to `test/seed.test.ts`. Add these imports at the top of the file (`env` from `cloudflare:test`, `loadMonth` from `../src/db/month`, `resetDemo` from `../src/demo/reset`), then append:

```ts

describe("resetDemo", () => {
	it("replaces all data with the seed, and running it twice gives the same result", async () => {
		await resetDemo(env.DB, "2026-09-22");
		await resetDemo(env.DB, "2026-09-22");

		const data = await loadMonth(env.DB, "2026-09");
		const summary = summarizeMonth({ month: "2026-09", ...data, unpaidDueBillsCents: 0 });
		expect(summary.safeToSpendCents).toBe(28299);
		expect(summary.uncategorized.count).toBe(12);

		const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM merchants WHERE raw_name = 'SQ *LOCAL BAKERY 4432'").all<{ n: number }>();
		expect(results[0]?.n).toBe(1);
	});
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `npm test -- test/seed.test.ts`. Expected: FAIL.

- [ ] **Step 3: Create `src/demo/reset.ts`**

```ts
import { buildSeed } from "./seed";

// Deletes in child-to-parent order, then inserts the seed, all in one atomic batch.
const TABLES_CHILD_FIRST = [
	"bill_payments",
	"documents",
	"balance_history",
	"transactions",
	"bills",
	"budget_amounts",
	"merchants",
	"categories",
	"accounts",
	"plaid_items",
];

/** Wipes the database and reloads the Rivera household. Only ever called when DEMO is "true". */
export async function resetDemo(db: D1Database, today: string): Promise<void> {
	const seed = buildSeed(today);
	const b = (v: boolean) => (v ? 1 : 0);

	await db.batch([
		...TABLES_CHILD_FIRST.map((t) => db.prepare(`DELETE FROM ${t}`)),
		...seed.categories.map((c) =>
			db.prepare("INSERT INTO categories (id, name, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)").bind(c.id, c.name, c.icon, c.color, c.sortOrder),
		),
		...seed.accounts.map((a) =>
			db
				.prepare("INSERT INTO accounts (id, name, mask, type, subtype, is_liability, balance_cents) VALUES (?, ?, ?, ?, ?, ?, ?)")
				.bind(a.id, a.name, a.mask, a.type, a.subtype, b(a.isLiability), a.balanceCents),
		),
		...seed.merchants.map((m) =>
			db.prepare("INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES (?, ?, ?)").bind(m.rawName, m.displayName, m.defaultCategoryId),
		),
		...seed.budgetAmounts.map((a) =>
			db.prepare("INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (?, ?, ?)").bind(a.categoryId, a.effectiveMonth, a.amountCents),
		),
		...seed.transactions.map((t) =>
			db
				.prepare(
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source, category_confidence,
					 flag_transfer, flag_reimbursement, flag_income, excluded, is_split, updated_by)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo')`,
				)
				.bind(t.accountId, t.date, t.amountCents, t.rawName, t.categoryId, t.categorySource, t.categoryConfidence, b(t.flagTransfer), b(t.flagReimbursement), b(t.flagIncome), b(t.excluded), b(t.isSplit)),
		),
	]);
}
```

- [ ] **Step 4: Wire the scheduled handler** in `src/index.tsx`. Replace the `export default` block with:

```tsx
import { resetDemo } from "./demo/reset";
// …

export default {
	fetch: app.fetch,
	async scheduled(_controller, env) {
		// The nightly job. In the demo it restores the seed; production sync is added in Phase 2.
		if (env.DEMO === "true") {
			await resetDemo(env.DB, new Date().toISOString().slice(0, 10));
		}
	},
} satisfies ExportedHandler<Env>;
```

The cron schedule itself (`triggers.crons`) is added per environment in Phase 1d. Locally it runs on demand (next step).

- [ ] **Step 5: Add a local seeding script to `package.json`**

```json
"db:migrate:local": "wrangler d1 migrations apply DB --local",
"db:seed:local": "curl -fsS \"http://127.0.0.1:8787/cdn-cgi/handler/scheduled\""
```

Check the current Wrangler docs for how to trigger a scheduled handler locally: the URL path and whether `wrangler dev` needs `--test-scheduled`. Use exactly what the docs say (`/__scheduled` in older versions, `/cdn-cgi/handler/scheduled` in newer ones), and add `--test-scheduled` to the `dev` script only if it's still required.

- [ ] **Step 6: Run all tests.** Run: `npm test`. Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/demo/reset.ts src/index.tsx test/seed.test.ts package.json
git commit -m "feat: add atomic demo reset and nightly scheduled handler

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Local check, docs, PR

- [ ] **Step 1: Check it end to end locally.** Run `npm run db:migrate:local`, start `npm run dev`, then in another terminal run `npm run db:seed:local`, then:
  `npx wrangler d1 execute DB --local --command "SELECT COUNT(*) FROM transactions"`. Expected: **125** (history: 5 months × (15 category transactions + 2 paychecks + 1 transfer) = 90; this month: 19 categorized + 12 uncategorized + 2 paychecks + 1 transfer + 1 reimbursement = 35).

  If `npm run dev` fails with "Could not resolve 'hono'" and a Yarn PnP message, that's the owner's stray `~/.pnp.cjs` (not a repo issue). Run the check from a copy of the repo outside the home directory, and report it.

- [ ] **Step 2: Add to `DESIGN.md` → Patterns:** `- Money: integer cents in the database and in code; format only in views with formatCents (src/money.ts).`

- [ ] **Step 3: Run all checks.** Run: `npm run build && npm run typecheck && npm run lint && npm test`. Expected: all pass.

- [ ] **Step 4: Commit, push, PR**

```bash
git add DESIGN.md
git commit -m "docs: note the money formatting pattern

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin phase-1b-data-and-money
gh pr create -R kwilson21/tally --title "Phase 1b: data and money" --body "Closes #6, #7, #8, #9. Part of #15 (reset function and scheduled handler; the cron and deploy come in 1d).
Plan: docs/superpowers/plans/2026-09-22-phase-1b-data-and-money.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
