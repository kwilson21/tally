# Phase 1c-2 (Transactions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two pull requests, in this order:
1. **Part A (#10):** the Transactions list, with search and filters for month, category, "Needs category" and "Excluded". Rows are grouped by day. Home's band link (`/transactions?uncategorized=1`) lands on the filtered list.
2. **Part B (#11):** the edit sheet. Tapping a row opens it, and it lets a person:
   - pick a category
   - tick "Always use this category for this merchant"
   - rename the merchant
   - add a note

   Saving updates the list and Home, and shows the toast and announcement.

**Architecture:** every screen is a real URL that renders a full page. htmx only swaps parts of it:
- `GET /transactions?…` renders the list. The filter form re-requests the same URL and swaps in `#results` (`hx-select`).
- `GET /transactions/:id?…` renders the same page with the edit sheet filled in. The row link swaps in only `#sheet`.
- `POST /transactions/:id` saves.
  - With htmx, it returns the updated list page with the sheet closed, and swaps `#page` (the results plus the sheet).
  - Without JavaScript, it redirects (303) back to the list.
  - Invalid input re-renders the sheet with an error, with status 422. htmx 4 swaps every status except 204 and 304.

The pure parts are tested first: filter parsing, day labels, search escaping, and edit validation. The SQL lives in `src/db/transactions.ts`. A save is one `db.batch()`.

**Tech stack:** Hono JSX, htmx 4.0.0 (`hx-get`, `hx-post`, `hx-select`, `hx-target`, `hx-swap`, `hx-push-url`, `HX-Trigger`), D1, and the Tailwind v4 tokens. There are no new dependencies. The recategorize E2E in Part B uses `playwright`, which is already a dev dependency (decision 24).

**Spec:** §6 (counted transactions), §7 (category priority, merchant rule, rename), §8 (Transactions screen, edits, accessibility), §10 (security), §11 (the E2E list includes "recategorize"). **Direction:** round 4, "Transactions, mobile" and "Transaction edit panel, mobile" (`docs/design-concepts/`). **Issues:** #10 (Part A), #11 (Part B).

**Out of scope, with where each part goes:**
- The panel's "Exclude from budget" toggle: #27. Exclusion rules come with it in Phase 3.
- "Split this transaction": #28.
- A "More…" category chip: the seed has 5 categories and all of them fit. It gets added when a household has more categories than a sheet can hold (a Later-list item, Task A0).
- Who made a change: until #22 (Cloudflare Access) lands, `updated_by` is `demo`, set by one helper that #22 replaces.

**Checked on 2026-09-23 against installed `htmx.org` 4.0.0** (`node_modules/htmx.org/dist/htmx.js`; the docs site is blocked in this environment, and the executor re-checks on htmx.org before Task A3):
- **Requests:** htmx sends `HX-Request: true` and `HX-Target` on each request. `hx-select`, `hx-select-oob` and `hx-push-url` exist.
- **Swaps:** `config.noSwap` is `[204, 304]`, so a 422 response is swapped. That's how validation errors get shown.
- **Focus:** after a swap, htmx focuses the first `[autofocus]` element in the new content (`#setFocus`). That's how focus moves into the sheet, and back to the row after closing.
- **CSP constraint:** trigger filters (`keyup[key=='Escape']`) and `hx-on` are evaluated with `new Function`. The CSP (`script-src 'self'`, no `'unsafe-eval'`) blocks that, so **neither may be used**. Trigger *modifiers* (`delay:300ms`, `changed`) are plain parsing and are fine.
- **HX-Trigger:** the response header is handled even for error statuses, so the toast and announce keys work on 422 responses too.

---

## Owner review: choices this plan makes

1. **"Needs category" means exactly what Home counts:** in the month, not excluded, not a split parent, not income, and category null. The chip's count always matches Home's band ("12").
2. **Filters:**
   - Month defaults to the current month and also offers "All months".
   - The "Excluded" chip shows *only* excluded transactions. By default, excluded rows still appear in the list, muted, as in the study.
   - Search matches the merchant's display name, its raw name, and the note, ignoring case.
3. **The edit sheet is a non-modal page region, not a modal dialog.**
   - Focus moves into it when it opens.
   - Cancel (a link) and the dimmed backdrop close it, and focus returns to the row.
   - **Escape doesn't close it:** that needs custom JavaScript or an htmx filter, and the CSP forbids both.
   - Without JavaScript, the sheet is simply an edit page.
4. **"Always use this category for this merchant" applies to more than future transactions.** It also recategorizes this merchant's existing transactions, except ones a person already categorized (`category_source = user`). This is spec §7's priority order (a merchant rule outranks Jev), applied now instead of waiting for the next sync, so the demo's "Set a rule for a merchant" shows a visible result.
5. **Changing the category marks it as a person's choice** (`category_source = user`, confidence cleared). Saving without changing the category, for example only editing the note, leaves the source as it was.
6. **Form posts from other sites are rejected.** A `POST` whose `Origin` header names another host gets a 403. It's one small middleware. The demo has no login and production uses Access cookies, so this is the simple guard against cross-site form posts. Task B0 adds it to spec §10.
7. **The list is paged, 25 rows at a time** (owner request on #42, replacing a 200-row cap). "Newer" and "Older" links plus "Page N of M", with each page a real URL (`?page=2`). Changing a filter returns to page 1, and a page past the end shows the last page. The live count reads "Showing 26–35 of 35 transactions".

---

## File structure

| File | Part | Job |
|---|---|---|
| `src/transactions/filters.ts` | A | `parseFilters`, `filtersToQuery`, `likePattern` (pure) |
| `src/dates.ts` | A | Adds `dayLabel(date, today)` and `monthLabel(month, today)` |
| `src/db/transactions.ts` | A | `listTransactions`, `needsCategoryCount`, `monthsWithTransactions`; in B, `getTransaction`, `saveEdit` |
| `src/views/transaction-row.tsx` | A | `TransactionRow`: icon, name, caption or "Needs category" tag, and signed amount; a link to the edit URL |
| `src/views/chip.tsx` | A | `Chip`: a visually hidden checkbox or radio inside a pill label, checked state via `has-[:checked]` |
| `src/views/form-field.tsx` | A | `FormField`: label plus control plus an optional `role="alert"` error |
| `src/routes/transactions.tsx` | A, B | The list page; in B also the edit page and the save |
| `src/routes/destinations.tsx` | A | Drops the `/transactions` placeholder |
| `src/transactions/edit.ts` | B | `parseEdit(form, categories)` → value or field errors; `safeBack(url)` (pure) |
| `src/views/bottom-sheet.tsx` | B | `BottomSheet`: backdrop link plus a sheet (bottom on phones, right-hand panel on desktop) |
| `src/actor.ts` | B | `actor(env)`: who is making the change (`"demo"` until #22) |
| `src/security.ts` | B | Adds `sameOrigin` middleware for non-GET requests |
| `scripts/e2e.mjs` | B | Recategorize end to end in Chromium (spec §11) |
| `scripts/pr-body.mjs` | A, B | Adds the filtered list and the edit sheet to `PAGES` |
| Tests | A, B | `test/filters.test.ts`, `test/day-label.test.ts`, `test/transactions-db.test.ts`, `test/transactions-route.test.ts`, `test/edit.test.ts`, `test/transactions-edit-route.test.ts`, `test/same-origin.test.ts` |

---

# Part A: the Transactions list (#10)

### Task A0: Branch and spec clarifications

- [ ] **Step 1: Branch.** Branch from the latest `main`. In a Claude Code on the web session, use the session's designated branch, reset to `origin/main`.

- [ ] **Step 2: Spec §8.**
  - Transactions row: add after the contents cell: "'Needs category' counts the same transactions as Home. The Excluded filter shows only excluded transactions. Search matches the merchant name, raw name, and note."
  - "How the pages behave": add "The edit panel is a page region, not a modal: focus moves into it, and Cancel or the backdrop closes it. Escape isn't supported, because it would need custom JavaScript."

- [ ] **Step 3: Spec §12 (Later).** Add "A 'More…' category chip when a household has more categories than the edit panel fits".

- [ ] **Step 4: Commit.** `git commit -am "docs: clarify Transactions filters, search, and the edit panel"`

### Task A1: Filters, search escaping, day labels (pure, tested first)

- [ ] **Step 1: Failing tests.** `test/filters.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { filtersToQuery, likePattern, parseFilters } from "../src/transactions/filters";

const parse = (qs: string) => parseFilters(new URLSearchParams(qs), "2026-09");

describe("parseFilters", () => {
	it("defaults to this month with nothing else set", () => {
		expect(parse("")).toEqual({
			q: "",
			month: "2026-09",
			category: null,
			uncategorized: false,
			excluded: false,
		});
	});

	it("reads Home's band link", () => {
		expect(parse("uncategorized=1").uncategorized).toBe(true);
	});

	it("accepts all months, a month, a category id, and trims search", () => {
		expect(parse("month=all").month).toBe("all");
		expect(parse("month=2026-07").month).toBe("2026-07");
		expect(parse("category=3").category).toBe(3);
		expect(parse("q=%20bakery%20").q).toBe("bakery");
	});

	it("ignores malformed values instead of failing", () => {
		expect(parse("month=nope&category=abc").month).toBe("2026-09");
		expect(parse("category=abc").category).toBeNull();
		expect(parse(`q=${"x".repeat(200)}`).q).toHaveLength(100);
	});
});

describe("filtersToQuery", () => {
	it("round-trips and leaves out defaults", () => {
		const f = parse("q=bakery&uncategorized=1&month=2026-08");
		expect(filtersToQuery(f, "2026-09")).toBe(
			"q=bakery&month=2026-08&uncategorized=1",
		);
		expect(filtersToQuery(parse(""), "2026-09")).toBe("");
	});
});

describe("likePattern", () => {
	it("wraps in % and escapes LIKE wildcards", () => {
		expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
	});
});
```
  `test/day-label.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { dayLabel, monthLabel } from "../src/dates";

describe("dayLabel", () => {
	it("names today and formats other days as 'Mon D'", () => {
		expect(dayLabel("2026-09-22", "2026-09-22")).toBe("Today, Sep 22");
		expect(dayLabel("2026-09-21", "2026-09-22")).toBe("Sep 21");
		expect(dayLabel("2026-01-05", "2026-09-22")).toBe("Jan 5");
	});
	it("adds the year for other years", () => {
		expect(dayLabel("2025-12-31", "2026-01-02")).toBe("Dec 31, 2025");
	});
});

describe("monthLabel", () => {
	it("adds the year only for other years", () => {
		expect(monthLabel("2026-09", "2026-09-22")).toBe("September");
		expect(monthLabel("2025-12", "2026-01-02")).toBe("December 2025");
	});
});
```
  Run: `npm test -- filters day-label`. Expected: FAIL.

- [ ] **Step 2: Implement** `src/transactions/filters.ts`:
```ts
// The list's filters live in the URL, so every filtered view is a link that can be shared and reloaded.

export type Filters = {
	q: string;
	month: string; // 'YYYY-MM' or 'all'
	category: number | null;
	uncategorized: boolean;
	excluded: boolean;
};

const MONTH = /^\d{4}-\d{2}$/;

export function parseFilters(params: URLSearchParams, thisMonth: string): Filters {
	const month = params.get("month") ?? "";
	const category = Number(params.get("category"));
	return {
		q: (params.get("q") ?? "").trim().slice(0, 100),
		month: month === "all" || MONTH.test(month) ? month : thisMonth,
		category: Number.isInteger(category) && category > 0 ? category : null,
		uncategorized: params.get("uncategorized") === "1",
		excluded: params.get("excluded") === "1",
	};
}

/** The query string for these filters, leaving out defaults (used for links and the edit panel's "back"). */
export function filtersToQuery(f: Filters, thisMonth: string): string {
	const p = new URLSearchParams();
	if (f.q) p.set("q", f.q);
	if (f.month !== thisMonth) p.set("month", f.month);
	if (f.category !== null) p.set("category", String(f.category));
	if (f.uncategorized) p.set("uncategorized", "1");
	if (f.excluded) p.set("excluded", "1");
	return p.toString();
}

/** A LIKE pattern matching `q` anywhere, with LIKE's wildcards escaped (use with ESCAPE '\'). */
export function likePattern(q: string): string {
	return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
```
  In `src/dates.ts`, add:
```ts
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Today, Sep 22", "Sep 21", or "Dec 31, 2025", from YYYY-MM-DD strings (no time zones). */
export function dayLabel(date: string, today: string): string {
	const label = `${SHORT[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
	if (date === today) return `Today, ${label}`;
	return date.slice(0, 4) === today.slice(0, 4) ? label : `${label}, ${date.slice(0, 4)}`;
}

/** "September", or "December 2025" when it isn't this year. */
export function monthLabel(month: string, today: string): string {
	const name = monthName(month);
	return month.slice(0, 4) === today.slice(0, 4) ? name : `${name} ${month.slice(0, 4)}`;
}
```
  Run tests. Expected: PASS. Commit: `feat: parse Transactions filters and label days`

### Task A2: The list query (route-runtime tests on the seed)

- [ ] **Step 1: Failing test** `test/transactions-db.test.ts`. `beforeEach` runs `resetDemo(env.DB, "2026-09-22")`.
  - This month, with no filters: 35 rows (19 categorized, 12 uncategorized, 2 paychecks, 1 transfer, 1 reimbursement), newest first.
  - `uncategorized`: 12 rows, and `needsCategoryCount(db, "2026-09")` is 12, the same as Home.
  - `excluded`: 2 rows (the transfer and the reimbursement).
  - `category` = Groceries (1): 4 rows.
  - `q = "bakery"`: 1 row, found by its display name "Local Bakery". `q = "SQ *LOCAL"` finds the same row by raw name. `q = "%"` finds 0 rows, which checks the escaping.
  - `month = "all"`, `q = "trader"`: every Trader Joe's row across 6 months, ordered by date desc, then id desc.
  - Each row carries `displayName` (the merchant's display name or the raw name), plus the category's `name`, `icon` and `color`, or nulls.
  - `monthsWithTransactions` returns the 6 months, newest first.

- [ ] **Step 2: Implement** `src/db/transactions.ts`:
```ts
import type { Filters } from "../transactions/filters";
import { likePattern } from "../transactions/filters";

export type ListRow = {
	id: number;
	date: string;
	amountCents: number;
	rawName: string;
	displayName: string;
	note: string | null;
	excluded: boolean;
	income: boolean;
	categoryId: number | null;
	categoryName: string | null;
	categoryIcon: string | null;
	categoryColor: string | null;
};

export const LIST_LIMIT = 200;

// "Needs category" is the same set Home counts as uncategorized (spec §6): in the month, counted, not income.
const NEEDS_CATEGORY =
	"t.category_id IS NULL AND t.excluded = 0 AND t.is_split = 0 AND t.flag_income = 0";

export async function listTransactions(db: D1Database, f: Filters): Promise<ListRow[]> {
	const where: string[] = [];
	const args: (string | number)[] = [];
	if (f.month !== "all") {
		where.push("substr(t.date, 1, 7) = ?");
		args.push(f.month);
	}
	if (f.category !== null) {
		where.push("t.category_id = ?");
		args.push(f.category);
	}
	if (f.uncategorized) where.push(NEEDS_CATEGORY);
	if (f.excluded) where.push("t.excluded = 1");
	if (f.q) {
		where.push(
			"(COALESCE(m.display_name, t.raw_name) LIKE ? ESCAPE '\\' OR t.raw_name LIKE ? ESCAPE '\\' OR COALESCE(t.note, '') LIKE ? ESCAPE '\\')",
		);
		const pattern = likePattern(f.q);
		args.push(pattern, pattern, pattern);
	}
	const sql = `SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS rawName,
		COALESCE(m.display_name, t.raw_name) AS displayName, t.note, t.excluded, t.flag_income AS income,
		c.id AS categoryId, c.name AS categoryName, c.icon AS categoryIcon, c.color AS categoryColor
		FROM transactions t
		LEFT JOIN merchants m ON m.raw_name = t.raw_name
		LEFT JOIN categories c ON c.id = t.category_id
		${where.length ? `WHERE ${where.join(" AND ")}` : ""}
		ORDER BY t.date DESC, t.id DESC
		LIMIT ${LIST_LIMIT + 1}`; // one extra row tells us there are more
	// Run with .bind(...args), map excluded/income 0/1 to booleans, and return { rows, more }.
}
```
  Also:
  - `needsCategoryCount(db, month)`: `SELECT COUNT(*)` with the month plus `NEEDS_CATEGORY`.
  - `monthsWithTransactions(db)`: `SELECT DISTINCT substr(date, 1, 7) … ORDER BY 1 DESC`.
  - Return `{ rows, more }` from `listTransactions`, where `more` means the 201st row exists.

  Run tests. Expected: PASS. Commit: `feat: query transactions by month, category, search, and flags`

### Task A3: Views (TransactionRow, Chip, FormField)

- [ ] **Step 1: `TransactionRow`.** An `<li>` containing one `<a>` (the whole row, `min-h-11`, full width, `text-ink no-underline`) that links to `/transactions/${id}?${query}`. In Part B it also gets htmx attributes. Contents:
  - **Icon:** the category's `CategoryIcon`. Otherwise `income` (ink) for income, `transfer` (muted) for excluded (round 4 build note), or `circle-dashed` (muted) for needs-category.
  - **Title:** `displayName`, `text-lg`.
  - **Caption** (muted): the category name, "Income", "Excluded", or, when uncategorized, the raw name (only if it differs from the display name) plus a "Needs category" tag (`bg-band rounded-control px-2 text-sm`).
  - **Amount** (right-aligned, tabular): `formatCents(amountCents, { signed: true })`, so money in shows as "+$2,450.00".
  - Excluded rows set `text-muted` on the title too. The word "Excluded" carries the meaning, not only the color.
  - A pure `rowCaption(row)` returns `{ icon, caption, tag }` and gets unit tests for all four cases.

- [ ] **Step 2: `Chip`.**
```tsx
// A pill-shaped checkbox or radio. The input is visually hidden but keyboard-focusable; the pill shows its state.
export function Chip({ type, name, value, checked, children, icon }: …) {
	return (
		<label class="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-rule px-4 text-base has-[:checked]:border-ink has-[:checked]:bg-band has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
			<input type={type} name={name} value={value} checked={checked} class="sr-only" />
			{icon}
			{children}
		</label>
	);
}
```
  The checked state shows as a darker border plus the band background. Screen readers get it from the native input itself, so no ARIA is needed. Status is never color alone.

- [ ] **Step 3: `FormField`.** A `<label for>` plus the control (passed as children), plus an optional `<p id="{id}-error" role="alert" class="text-over">`. The control gets `aria-describedby` and `aria-invalid` when there's an error.

- [ ] **Step 4:** Add unit tests for `rowCaption`, and a render test that `Chip` includes a real `<input type=…>`. Commit: `feat: add transaction row, chip, and form field components`

### Task A4: The route (route test first)

- [ ] **Step 1: Failing test** `test/transactions-route.test.ts`. It resets the seed to `todayUtc()`, then checks:
  - `GET /transactions` returns 200. It has the heading "Transactions", a labeled search (`<label …>Search transactions</label>`), labeled month and category `<select>`s, and chips reading "Needs category (12)" and "Excluded". Rows are grouped under day headings that start with "Today, ".
  - `GET /transactions?uncategorized=1` shows 12 rows, each with "Needs category", and the chip is checked.
  - `GET /transactions?excluded=1` shows "Transfer to Savings" and "Reimbursement, doctor&#39;s office" (check the escaping), and nothing else.
  - `GET /transactions?q=zzz` shows the empty state "No transactions match." with a "Clear filters" link to `/transactions`.
  - With `HX-Request: true`, the response carries `HX-Trigger` with `announce` set to "12 transactions" (for `?uncategorized=1`).
  - Home's band link resolves: fetch Home, take the `href` of the band, fetch it, and expect the 12 rows.
  - The `/transactions` nav item is still marked current (the `nav-routes.test.ts` case keeps passing).

- [ ] **Step 2: Implement** `src/routes/transactions.tsx`. Its main pieces are:
  - **`renderList(c, filters, sheet?)`:** used by all three routes in Part B. It returns the full `Layout` page, active nav "transactions":
    - `<h1>`: Transactions.
    - The filter `<form id="filters" method="get" action="/transactions" hx-get="/transactions" hx-trigger="input delay:300ms, change" hx-target="#results" hx-select="#results" hx-swap="outerHTML" hx-push-url="true">`, containing:
      - `FormField` "Search transactions", with a visually hidden label and a search icon, input `type="search" name="q"`
      - the month `<select name="month">`, with "All months" plus `monthsWithTransactions`, labeled with `monthLabel`
      - the category `<select name="category">`, with "All categories" plus the categories
      - `Chip` checkbox `uncategorized=1` "Needs category (N)"
      - `Chip` checkbox `excluded=1` "Excluded"
      - a submit button "Apply filters", `sr-only focus:not-sr-only`, so the form still works without JavaScript and for keyboard users
    - `<div id="page">`, which holds `<section id="results" aria-labelledby=…>` with the day groups (`<h2>` day label, `<ul>` of `TransactionRow`), the 200-row note, and the empty state; plus `<div id="sheet">`, empty in Part A.
  - **`transactions.get("/transactions", …)`:** parses the filters from the URL and renders. When `HX-Request` is set, it adds `HX-Trigger: {"announce": "N transactions"}` ("1 transaction" for one), so screen readers hear the result of a filter change. The `#announcer` live region in `Layout` speaks it (spec §8: aria-live on swap regions).

  Remove `/transactions` from the placeholder loop in `src/routes/destinations.tsx`, and mount `transactions` in `src/index.tsx`.

- [ ] **Step 3: Screenshot page.** Add `{ name: "transactions-needs-category", path: "/transactions?uncategorized=1" }` to `PAGES` in `scripts/pr-body.mjs`.

- [ ] **Step 4:** Run the build, typecheck, lint and all tests. Commit: `feat: build the Transactions list with search and filters`

### Task A5: Docs, local check, PR

- [ ] **DESIGN.md → Components:**
  - add rows for `TransactionRow`, `Chip` (replaces the planned `CategoryChip`: one component, with an optional icon, for both filters and categories) and `FormField`
  - the Planned row keeps `BottomSheet` for Part B
- [ ] **Local check:** run `npm run screenshots`, compare the Transactions pages with the round 4 study, and tab through the filters, checking each chip's focus ring.
- [ ] **Open the PR:** "feat: Transactions list with search and filters", `Closes #10.` CI adds the screenshots. This is a UI PR, so the owner merges it.

---

# Part B: the edit sheet (#11)

Start after Part A is merged.

### Task B0: Spec and same-origin guard (test first)

- [ ] **Spec §10:** add the row `| Form posts from other sites | Rejected: a non-GET request whose Origin header names another host gets 403. |`.
- [ ] **Test** `test/same-origin.test.ts`:
  - `POST /transactions/1` with `Origin: https://evil.example` → 403.
  - The same request with `Origin: http://tally.test` → not 403.
  - With no Origin header (old browsers, curl) → not 403.
- [ ] **Implement** `sameOrigin` in `src/security.ts`: for methods other than GET and HEAD, if `Origin` is present and `new URL(origin).host !== new URL(c.req.url).host`, return `c.text("Forbidden", 403)`. Mount it after `security` in `src/index.tsx`. Commit: `feat: reject form posts from other sites`

### Task B1: Edit validation (pure, tested first)

- [ ] **Test** `test/edit.test.ts` for `parseEdit(form: FormData, categoryIds: number[])`, which returns `{ ok: true, value } | { ok: false, errors }`:
  - `category=2&merchant=Local%20Bakery&note=` → `{ categoryId: 2, alwaysForMerchant: false, displayName: "Local Bakery", note: null }`
  - No `category` field → `categoryId: null`, meaning the category is left as it is.
  - `category=99` (not a live category) → `errors.category = "Pick a category from the list."`
  - `always=1` with no category → `errors.category = "Pick a category to use for this merchant."`
  - A merchant name that is whitespace only → `displayName: null`, falling back to the raw name. Over 80 characters → `errors.merchant = "Keep the name under 80 characters."`
  - A note over 500 characters → `errors.note = "Keep the note under 500 characters."`
  - `safeBack("/transactions?q=x")` returns it unchanged. `safeBack("https://evil.example")`, `safeBack("//evil.example")` and `safeBack("/settings")` all return `/transactions`, so the edit form can't be used to redirect elsewhere.
- [ ] **Implement** `src/transactions/edit.ts` to pass. Commit: `feat: validate transaction edits`

### Task B2: Saving (DB test first)

- [ ] **Test** in `test/transactions-db.test.ts`, on the seed. The transaction is "SQ *LOCAL BAKERY 4432", found by raw name, not by id:
  - **Category:** `saveEdit` with `categoryId: 2` sets `category_id = 2`, `category_source = 'user'`, `category_confidence = NULL` and `updated_by = 'demo'`. `needsCategoryCount` drops to 11, and `summarizeMonth` shows Eating Out spent 29800.
  - **Unchanged category:** saving the same category again with only a new note leaves `category_source` as it was.
  - **Merchant rule:** with `alwaysForMerchant: true`, `merchants.default_category_id` becomes 2, and every other transaction with that raw name whose source isn't `user` gets category 2 with source `merchant_rule`. Set one of them to `user` first to prove it's left alone.
  - **Rename:** `displayName: "Corner Bakery"` changes `merchants.display_name`, and `listTransactions` shows "Corner Bakery" for every row from that merchant. A merchant with no `merchants` row gets one (upsert on `raw_name`).
  - **Atomic:** all of it is one `db.batch()`. Check that a bad category id rejected by the foreign key leaves the transaction's note unchanged too.
- [ ] **Implement** in `src/db/transactions.ts`:
  - `getTransaction(db, id)`: the `ListRow`, plus the account name and mask (for "Sep 22 · Checking ••1234"), the merchant's `display_name`, and `category_source`.
  - `saveEdit(db, id, edit, actor)`: one batch containing the transaction `UPDATE` (the category and source only when changed, the note, `updated_by`, and `updated_at = datetime('now')`), the merchant upsert (`INSERT … ON CONFLICT(raw_name) DO UPDATE SET display_name = excluded.display_name`), and, when `alwaysForMerchant` is set, the rule `UPDATE merchants SET default_category_id` plus the `UPDATE transactions … WHERE raw_name = ? AND id != ? AND COALESCE(category_source, '') != 'user'`.
- [ ] **`src/actor.ts`:** `export function actor(env: Env): string { return "demo"; }`, with the comment "#22 replaces this with the email from the verified Cloudflare Access token." Commit: `feat: save category, merchant rule, rename, and note in one batch`

### Task B3: BottomSheet and the edit routes (route test first)

- [ ] **Test** `test/transactions-edit-route.test.ts`, with the seed reset and the Local Bakery id looked up by raw name:
  1. **The edit page:** `GET /transactions/{id}?uncategorized=1` returns 200.
     - The page shows the list (12 rows) **and** a sheet: `role="dialog"`, `aria-labelledby` pointing at a heading "Local Bakery" that carries `autofocus`, the raw name, "$12.00", and "Sep … · Credit card ••9012" (the seed puts uncategorized spending on the card).
     - The Category `<fieldset>` has a `<legend>Category</legend>` and 5 radio chips.
     - There's the "Always use this category for this merchant" checkbox, a "Merchant name" input with the value "Local Bakery", a "Note" textarea, a Cancel link to `/transactions?uncategorized=1`, and a Save button.
  2. **Unknown id:** `GET /transactions/999999` → 404, rendered inside the layout.
  3. **Save with htmx:** `POST /transactions/{id}` (htmx) with `category=2&merchant=Local Bakery&note=&back=/transactions?uncategorized=1` returns 200.
     - The body shows 11 rows and no sheet contents.
     - The `HX-Trigger` JSON has `toast.message` = "Saved Local Bakery" and `announce` = "Saved. Local Bakery is now Eating Out."
     - `HX-Push-Url` is `/transactions?uncategorized=1`.
     - The saved row's link carries `autofocus`, so focus returns to it. With the uncategorized filter it has left the list, so focus goes to the results heading instead.
  4. **Save without JavaScript:** the same POST without `HX-Request` → 303, `Location: /transactions?uncategorized=1`.
  5. **Invalid input:** a POST with `category=99` → 422. The sheet is re-rendered with `role="alert"` "Pick a category from the list.", and the typed-in values are kept.
  6. **Home follows the edit:** after the save, Home's band reads "11 transactions need a category".
- [ ] **`BottomSheet`** (`src/views/bottom-sheet.tsx`):
```tsx
// A page region that slides over the list: bottom sheet on phones, right-hand panel on desktop.
// Not a modal: focus moves in via autofocus; Cancel or the backdrop (links) close it.
export function BottomSheet({ labelledBy, closeHref, children }: …) {
	return (
		<>
			<a href={closeHref} class="fixed inset-0 bg-ink/30" aria-label="Close" tabindex="-1" {...closeHtmx} />
			<section role="dialog" aria-labelledby={labelledBy}
				class="fixed inset-x-0 bottom-0 max-h-[90vh] overflow-y-auto rounded-t-sheet bg-paper p-5 lg:inset-y-0 lg:left-auto lg:w-[28rem] lg:rounded-none lg:rounded-l-sheet">
				{children}
			</section>
		</>
	);
}
```
  `closeHtmx` is `hx-get={closeHref} hx-target="#page" hx-select="#page" hx-swap="outerHTML" hx-push-url="true"`. Check the backdrop colour (`bg-ink/30`) against DESIGN.md: it's a new use of the ink token, so record it there.
- [ ] **Routes** in `src/routes/transactions.tsx`:
  - **`GET /transactions/:id`:** `renderList(c, filtersFromBack, editForm)`. The query string is the list's filters, so reloading or sharing the URL keeps them.
  - **Row links (Part A's `TransactionRow`)** gain `hx-get={href} hx-target="#sheet" hx-select="#sheet" hx-swap="outerHTML" hx-push-url="true"`. Opening swaps only the sheet, and the list keeps its scroll position.
  - **The form:** `<form method="post" action="/transactions/{id}" hx-post=… hx-target="#page" hx-select="#page" hx-swap="outerHTML">`, with a hidden `back` field.
    - **Category:** a `<fieldset><legend>Category</legend>` of radio `Chip`s with icons.
    - **Merchant rule:** the `always` checkbox, labeled "Always use this category for this merchant".
    - **Merchant name:** a `FormField` "Merchant name" (`name="merchant"`), with a hint that it renames every transaction from this merchant.
    - **Note:** a `FormField` "Note" (`<textarea name="note">`).
    - **Cancel:** a link with the same `closeHtmx` attributes.
    - **Save:** a submit button, `bg-ink text-paper rounded-control min-h-11`.
  - **`POST /transactions/:id`:** runs `parseEdit`.
    - **Errors:** 422, re-render with the errors.
    - **Otherwise:** `saveEdit(…, actor(c.env))`. Then, for htmx, render `renderList(back filters, no sheet, focus = id)` with `HX-Trigger` (toast plus announce) and `HX-Push-Url: back`. Without JavaScript, return a 303 to `back`.
- [ ] Commit: `feat: edit a transaction's category, merchant rule, name, and note`

### Task B4: E2E recategorize (spec §11)

- [ ] **Write `scripts/e2e.mjs`:** Playwright plus `node:assert`, run against the running app like `screenshots.mjs`, honoring `BASE_URL` and `CHROMIUM_PATH`. The flow:
  1. Open `/`, then click the band "12 transactions need a category". The URL is `/transactions?uncategorized=1`.
  2. Click "Local Bakery". The sheet opens, and focus is on its heading.
  3. Choose "Eating Out" and click Save.
  4. A toast "Saved Local Bakery" appears, the list shows 11 rows, and the URL is still `/transactions?uncategorized=1`.
  5. Go to `/`. The band reads "11 transactions need a category".
  6. Fail on any console error.
- [ ] **Wire it up:** add `"e2e": "node scripts/e2e.mjs"` to `package.json`. In `.github/workflows/screenshots.yml`, add `- run: npm run e2e` **after** the screenshots step. The app is already running and seeded there, and the E2E changes the data, so it has to run after the screenshots.
- [ ] **Screenshot page:** add `{ name: "transaction-edit", path: "/transactions/110?uncategorized=1" }` to `PAGES`. 110 is Local Bakery's id after a reset (90 history rows, then 19 categorized, then the first uncategorized row). Add a `test/seed.test.ts` assertion that id 110 is `SQ *LOCAL BAKERY 4432`, so the screenshot can't silently drift.
- [ ] Commit: `test: recategorize end to end in Chromium`

### Task B5: Docs, local check, PR

- [ ] **DESIGN.md:**
  - Components: add `BottomSheet`, and remove the Planned row, since everything planned now exists.
  - Tokens: note the backdrop `ink/30`.
  - Patterns: "Edits: form → save → the list page swaps back with the toast and announce; focus returns to the row."
- [ ] **Local check:**
  - Run `npm run screenshots && npm run e2e`.
  - Compare the edit sheet with the round 4 study (without the exclude toggle and split, which are Phase 3).
  - Keyboard: tab through the sheet, choose a category with the arrow keys (native radios), and save with Enter.
  - Check that the no-JavaScript path works: disable JavaScript in Playwright and save once.
- [ ] **Open the PR:** "feat: transaction edit panel", `Closes #11.` This is a UI PR, so the owner merges it.
