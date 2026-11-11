# Verified rules: when to use LemmaScript, and when not to

Decision 188. Read this before adding or changing a `//@` contract, and before proposing a new one.

## In one sentence

A verified rule is a plain statement about a pure money function ("each category row's spending equals the sum of that category's transactions") that a prover checks for every input inside a stated bound (see Numbers), not only the inputs a test happens to try.

A rule must be true of the code as it really behaves. "Category rows plus uncategorized add up to total spending" is a tempting rule that is false here: a category with spending but no budget yet has no row, so its spending is in the total and in no row. A contract that states it would fail the proof, or need a precondition production inputs do not meet.

## What the tools are

- **LemmaScript** (`lemmascript`, MIT, pinned exactly) reads ordinary TypeScript with `//@` comments. The comments do nothing when the app runs.
- **Dafny** (MIT, pinned exactly, ships its own Z3 prover) is what `lsc` runs to do the checking. If a rule does not hold, Dafny names the line and the rule that broke.
- **Quint** is not part of the repo. It is a design-time tool for flows where order and timing matter (see the end of this page).

Both LemmaScript and Dafny are dev and CI tools only. Neither is bundled into the Worker.

## The test: should this function carry a contract?

Answer these four questions about one function. It earns a contract only if all four are yes.

1. **Is it pure?** Plain values in, plain values out. No database, no `fetch`, no `await`, no clock, no `Intl`, no regex-heavy string handling.
2. **Does the rule involve a sum, a count, a partition or a conservation law?** "These parts add up exactly to the whole." "Every transaction is counted once." "Money out and money in never overlap."
3. **Would a break lose or miscount money or data?** The same bar as CLAUDE.md's review-round rule. A wrong word on a screen does not qualify.
4. **Can the rule be said in one plain sentence?** If it cannot (decision 2), it does not go in. A contract nobody can read is worse than a test.

## When not to use it

| Skip it when | Why | Use instead |
|---|---|---|
| The code is SQL, or builds SQL (`src/plaid/sync.ts`, `pending-merge.ts`, `src/db/*`) | The prover cannot see the database | Route tests in the Workers runtime |
| The code formats text or draws a page (`formatCents`, JSX, status sentences) | `Intl` and templates are outside the model, and a wrong word is not a money bug | Ordinary tests |
| The rule is one comparison (`Math.max(0, a - b)`) | A test states it as clearly and costs nothing | A unit test |
| The code parses strings or floats (`toCents`, `plaidAmountToCents`) | Regex and `toPrecision` are outside the model | Table-driven tests with edge cases |
| The code calls Plaid, Jev or Workers AI | Not pure | Tests with a fake `fetch` |
| The code changes every week | Annotations cost more than they save | Wait until it settles |
| The rule is a flow over time (cursor, lease, retries) | Contracts check one function, not an order of events | A Quint model while designing, then tests |

## How a verified module is written

- One file per module, listed in `LemmaScript-files.txt` at the repo root.
- Mark each function you verify with `//@ verify`. Once any function in a file has it, only marked ones are checked.
- Spec helpers (a recursive `sumTo` that the contract compares against) are `//@ verify` functions marked as spec in a comment, and live next to the code they describe.
- Use `//@ skip` for code the tool cannot read, and `//@ extern` plus a contract for a function you trust but do not check. Every `extern` carries a one-line comment saying why it is trusted.
- Never `//@ assume`. It tells the prover to believe something, which makes a green check meaningless. Add a helper lemma or restructure instead.
- Keep the production code natural. A small behaviour-preserving rewrite for the tool (spelling a spread out field by field) is fine and goes in the PR description. Do not bend the code into a shape that is harder to read.

## What LemmaScript reads

Tried on 2026-11-11 with `lemmascript` 0.6.6 and Dafny 4.9.0, for #942. "Translates" means `lsc` produced Dafny that type-checks for a small function using it; only the rows marked proved carry a real contract in the repo. Re-try a row before relying on it after an upgrade.

| Construct | Result |
|---|---|
| `new Map<string, V>()` with `has`, `get`, `set`, `delete`, `size` | Translates (a Dafny `map`). `has`, `get` and `set` on a `Map<number, number>` are proved in `summarizeMonth`. |
| `new Set<string>()` with `has`, `add` | Proved in `setAsideFor`. |
| `set.has(n)` on a `Set<number>` parameter | Proved in `setAsideFor`. |
| `for (const x of xs)` with `continue`, and over `[...a, ...b]` | Proved in `setAsideFor`; the loop's index is `_x_idx` in an invariant. |
| `s.startsWith(t)`, `Math.max(a, b)`, a union of string literals | Proved in `setAsideFor`. |
| `for (const x of map.values())`, `[...map.values()]`, `map.keys()`, `map.entries()` | **Fails**: "Unsupported Dafny method call: .values() on map" (and the same for `.keys()`, `.entries()`). |
| `for (const [k, v] of map)` | Translates, as a loop over the keys in an order Dafny does not fix. Nothing was proved through it: a running sum has no "first n" to state an invariant against, so add up by walking an array and use the Map for lookups. |
| A template string with a number field in it, `${o.billId}:${o.dueDate}` | **Fails**: the Dafny does not type-check ("type of right argument to + (int) must agree with the result type"). It translates only when the number is known to be a `nat`, such as an array's length. Put the key in a small `//@ extern` function; the prover then knows only that equal inputs give equal keys. |
| A template string of strings | Translates. |
| `String(n)`, `JSON.stringify(x)` | **Fails** (unresolved identifier; unsupported call). |
| `a?.b`, `a ?? b`, an optional field | Translate. An optional boolean field is proved in #944's `netWorthCents`. |
| `xs.filter(...).map(...)`, `xs.reduce(...)`, `[...xs].sort(compare)` | Translate (`reduce` as a library fold, `sort` as a library sort). Nothing was proved through them; the verified modules use loops with invariants instead. |

## What every new contract must show

1. **The rule, in one sentence**, as a comment above the `//@ ensures` lines.
2. **A planted bug the prover rejects.** Before the PR, break the code on purpose in a scratch copy and confirm `lsc check` fails on that rule. Say which bug in the PR description. A contract that passes on broken code proves nothing.
3. **A line in the module table below.**

## Numbers: what "every input" covers

LemmaScript models a TypeScript `number` as an unbounded mathematical integer. The Worker runs 64-bit floats, which hold whole numbers exactly only up to 2^53 − 1 (9,007,199,254,740,991 cents, about $90 trillion). Past that, a sum can round and the proof no longer describes what runs.

So a green check covers inputs inside a bound, and each verified module must state it:

- Write the bound as a `//@ requires` (for example, every `amountCents` is a safe integer with magnitude at most a named limit, and the row count is at most a named limit, so no running sum can reach 2^53).
- Name the line that enforces it at the edge (a guard, or the parse that already rejects larger amounts). If nothing enforces it, add the guard in the same PR, or the module is not a fit.
- Say in the module table which bound the proof assumes.

## What a green check does and does not mean

It means the TypeScript meets its contract for every input inside the stated bound. It does not mean:

- The inputs are inside that bound at runtime. The proof assumes it; the edge guard makes it true.

- The contract says the right thing. A wrong rule is proven just as happily. The owner reads the sentences.
- The data fed in is right. If the SQL hands the function the wrong rows, the proof still holds and the number is still wrong.
- Anything about code marked `skip` or `extern`.

## Verified modules

| Module | Rule (one sentence) | Decision / issue |
|---|---|---|
| `src/budget.ts` `summarizeMonth` | Total spent, income and uncategorized (amount and count) are each exactly the sum over the transactions; each category row's spent is exactly its category's sum; Safe to spend is the stated sum. Bound: every amount at most 1e10 cents, at most 1e5 counted transactions and 1e4 categories, enforced by `assertWithinLimits`, which throws a `RangeError`. | Decision 189, #933 |
| `src/bills/totals.ts` `setAsideFor` | The set-aside is exactly the sum of the unpaid part (amount less paid, never below zero) of each occurrence that is the first with its key, belongs to an active bill, is due this month and is due or overdue; every other occurrence adds nothing. Bound: no amount or paid amount above 1e10 cents and at most 1e5 occurrences, enforced by `assertSetAsideWithinLimits`, which throws a `RangeError` before the sum. At the edges: the bill form refuses an amount past the limit in words before it is saved (`save` in `src/routes/bills.tsx`), and an accepted price change is at most $100,000 (`BIG_BILL_CENTS`); a paid amount is the sum of linked bank payments and is not checked when it is stored, so one past the limit would reach the `RangeError`. Trusted, not proved: `occurrenceKey` (`extern`) gives two occurrences the same key only when their bill and due date both match; a test checks it. | #942 |
| `src/transactions/split.ts` `partsAddUp` | It is true exactly when there are at least two parts, each non-zero with the transaction's sign, adding up to its amount. Bound: no part above 1e10 cents and at most 1,000 parts, enforced in `parseSplit`, which refuses a split past either in words; the transaction's amount is a safe integer. | #934 |

## Candidates, by area

Assessed from reading the code on 2026-11-09, and again on 2026-11-10 (#935). "Fit" is the four-question test. Update this table as modules are done or ruled out.

| Area | Fit | Why |
|---|---|---|
| `src/budget.ts` `summarizeMonth` | Done (decision 189) | Spent, income and uncategorized each count a transaction once; category rows equal their category's sum; safe-to-spend is one identity. Proved in a spike. |
| `src/transactions/split.ts` `parseSplit` | No, as written | It takes strings and parses each amount with `toCents`, and parsing stays with ordinary tests. Trusting `positiveCents` as `extern` would not change that. |
| `src/transactions/split.ts`, the post-parse check | Done (#934) | Extracted as `partsAddUp`; `parseSplit` itself stays with ordinary tests. |
| `src/bills/totals.ts` `calculateBillTotals`, the set-aside | Done (#942) | Extracted as `setAsideFor` over the occurrences, shown ones first, and proved with the de-duplication inside it, so "counted once, the shown one winning a tie" is part of the contract. Two things had to change for the tool, both listed under "What LemmaScript reads": the loop over `counted.values()` became one loop that de-duplicates and adds together, and the key is made by `occurrenceKey`, an `extern`. The rest of `calculateBillTotals` (the headings, To pay soon, still to pay) keeps its own `counted` Map and stays with ordinary tests. |
| `src/bills/totals.ts` `monthlyBillShare` | No | A rounding bound (the share is within half a unit of the exact fraction) is not a sum, count, partition or conservation law, so it fails question 2 whatever LemmaScript supports. A table-driven test states it. |
| `src/net-worth.ts` `netWorthSeries` | Maybe | Fits the questions: each day's point is the sum of every counted account's latest balance, debt negative, and a wrong point misstates money in the history chart and its sentence ("Up $3,600 since May"); the Accounts headline is computed separately by `netWorthCents`, so it is not affected (`netWorthCents` is its own candidate, below). After #942 ("What LemmaScript reads"): `?.` and a sort with a comparator translate, but `entries()` and a Map's `values()` do not, and a sum taken while looping over a Map has no order to state an invariant against. So it needs the same rewrite the set-aside got (keep the balances in a Map, add them up by walking an array of the account ids), and a spec for "latest balance on or before the day"; not started. `netWorthView` is words and chart points: No. |
| `src/home-forecast.ts` `forecastMonth` | No | It does contain a sum (the month's end is spending so far plus bills still due plus the projection), so question 2 is met. It fails question 3 as applied here: it projects spending that has not happened and nothing records or adds it to other amounts, so a break moves an estimate, not a recorded amount. A test pins its rounding. |
| `src/bills/price-change.ts` `pickPriceOffer` | No | A pick and tie-break, not a sum or partition, and its result is an offer a person answers (nothing links by itself, decision 72), so a break cannot lose or miscount money. The rest of the file is SQL. |
| `src/trends.ts` `buildTrends`, the totals | Maybe | Decision 77 says the changes add up to the headline, and the code says the changes "must still add up to the comparison": spend rows are summed into per-category and per-month totals, and the changes' now and then amounts must add to the headline's and the comparison's. That is a sum and partition rule on displayed money, so it passes the four questions. The rule holds only when the ids in `input.categories` are unique (a repeated id makes its change appear twice while the headline counts each row once) and every non-null category id in the spend and same-days rows is one of them (a row for an unknown category is in the totals but in no change), so the contract must carry that as a precondition or account for unmatched ids; production loads every category row from the categories table (`src/db/trends.ts`), which should guarantee both, to confirm. After #942 ("What LemmaScript reads"): Maps with string keys, sorting and spreading all translate, so the remaining work is to extract the aggregation and to add the totals up by walking arrays, not a Map's values; a key built from a number needs an `extern` like `occurrenceKey`. The rest of the file (run counts, `averageMonthlyCents`, drawing, words) is No. |
| `src/budgets/month-cause.ts` `monthCauses` | Maybe | Pure, with no `Intl`: each over-budget category contributes how far over it is, each category with no budget its spending if above zero, and uncategorized money its amount if above zero, and the cause line shows those amounts. A filter-and-subtract rule on displayed money, like `keepShownBudgets`; weakest of the maybes, since it sums nothing, so take it after the others. |
| `src/budgets/month-cause.ts` `monthCause` | No | Chooses the two largest causes and words the line; a wrong word, and it calls `wholeUnlessTiny` (`Intl`). |
| `src/first-tally/budgets.ts` `keepShownBudgets`, `src/first-tally/pay.ts` `payShown` | Maybe | Each is a pure filter or set-equality rule that decides what is written: `keepShownBudgets` keeps exactly the current suggestions the form showed (`first-page.tsx:393` turns the result into budget writes), and `payShown` accepts a pay answer only when its values are exactly the merchant's deposits now (`first-page.tsx:296`). Both pass the four questions as rules. They compare `JSON.stringify` text, which LemmaScript does not read (confirmed in #942), so extract the comparison over plain records first: `keepShownBudgets` needs the (id, cents) pair, but `payShown` needs all four fields the form carries (id, key, date, cents), since dropping the key or date would weaken the guard against a stale form. Everything else in both files is setup words, cadence and parsing: No. |
| `src/transactions/refund-guards.ts` | No | One comparison; a test says it as clearly. |
| `src/money.ts` | No | Regex and `toPrecision`; tests with edge cases instead. |
| `src/plaid/*`, and the SQL in `src/db/*` | No | SQL. |
| `src/db/accounts.ts` `netWorthCents` | Yes, simplest | A pure sum that lives in a mostly-SQL file: net worth is exactly the sum of connected assets less the sum of connected liabilities, and the Accounts headline (`accounts.tsx:200`) shows it directly. Short (one reduce with a nested ternary, no Map or string), so it is also the cheapest first try after #942 if a quick win is wanted (#944); `countedAccounts`, which feeds it (the Apple Card counts as debt), goes with it. |
| other pure helpers under `src/db/*` | Unassessed | A quick search (exported functions that mention cents and take no database) found `netWorthCents` and `followsPurchase` in `counted-month.ts`; it was a heuristic, not a full read. Assess any pure helper like any other module, whatever directory it is in. |

## Review of the decision

This is a Tech Preview toolchain (LemmaScript 0.6.x). The decision stands only while it earns its keep. Review it on **2027-02-07** (three months). Remove it if all of these are true:

- No contract has caught a change that the tests missed.
- Upgrading LemmaScript or Dafny broke the check and needed more than a version bump to fix.
- The annotations slowed a PR enough that a reviewer asked for them to go.

Removing it means deleting all of these, and adding a decision entry that supersedes 188:

- the `lemmascript` devDependency and the lockfile entries;
- `LemmaScript-files.txt` and any `lemmascript.json`;
- every generated or hand-kept Dafny file next to a verified module (`*.dfy` and `*.dfy.gen`), including proof additions in them;
- the Dafny install and cache step in CI, and the `lsc check` step;
- the `//@` comments, and any `orZero`-style helper or field-by-field rewrite added only for the tool (keep a rewrite if the code reads better for it);
- the rule line in CLAUDE.md and the rows in the module table.

## Quint

Quint models a flow as events in any order and checks rules after each one. It helped once here (the Plaid sync spike) and found no bug. Use it when **designing** a new flow where order or timing matters, before the code exists. The model is a scratch aid and is not committed or run in CI unless the owner decides otherwise in a new decision.
