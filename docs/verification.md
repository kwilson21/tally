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
| `src/transactions/split.ts` `partsAddUp` | It is true exactly when there are at least two parts, each non-zero with the transaction's sign, adding up to its amount. Bound: no part above 1e10 cents and at most 1,000 parts, enforced in `parseSplit`, which refuses a split past either in words; the transaction's amount is a safe integer. | #934 |

## Candidates, by area

Assessed from reading the code on 2026-11-09. "Fit" is the four-question test. Update this table as modules are done or ruled out.

| Area | Fit | Why |
|---|---|---|
| `src/budget.ts` `summarizeMonth` | Done (decision 189) | Spent, income and uncategorized each count a transaction once; category rows equal their category's sum; safe-to-spend is one identity. Proved in a spike. |
| `src/transactions/split.ts` `parseSplit` | No, as written | It takes strings and parses each amount with `toCents`, and parsing stays with ordinary tests. Trusting `positiveCents` as `extern` would not change that. |
| `src/transactions/split.ts`, the post-parse check | Done (#934) | Extracted as `partsAddUp`; `parseSplit` itself stays with ordinary tests. |
| `src/home-forecast.ts` `forecastMonth` | Maybe | Rounding to whole dollars; needs a check of how LemmaScript treats division first. |
| `src/bills/totals.ts`, `src/net-worth.ts`, `src/trends.ts`, `src/budgets/month-cause.ts`, `src/first-tally/budgets.ts`, `src/first-tally/pay.ts` | Unassessed | Pure and money-heavy by size; read each against the four questions before deciding. |
| `src/transactions/refund-guards.ts` | No | One comparison; a test says it as clearly. |
| `src/money.ts` | No | Regex and `toPrecision`; tests with edge cases instead. |
| `src/plaid/*`, `src/db/*` | No | SQL. |

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
