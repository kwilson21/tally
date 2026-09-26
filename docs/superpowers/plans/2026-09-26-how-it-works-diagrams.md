# How Tally works: a diagram per section (#61)

- **Date:** 2026-09-26
- **Spec:** §9 (How Tally works: one section per feature, with a worked example from the demo's own numbers)
- **Design:** the owner picked from an HTML mockup of two styles (A "ledger bars", B "flow boxes"): **B for Budget, Transactions and Categories, and A for Excluding**, and asked that the diagrams show the extra details (income, and why each transaction is excluded), with the worked examples saying the same.

## Goal

Each feature section on How Tally works gets a small picture of its rule, drawn by code from the same numbers as its worked example, so anyone trying the demo can see how the numbers fit together.

## Changes

1. **Numbers.**
   - `monthCounts` also returns `income`: counted transactions with no category that are income. They need no category.
   - `excludedBreakdown` replaces `excludedCount` and splits this month's excluded transactions into `transfer` (flagged transfer), `reimbursement` (flagged reimbursement, not transfer) and `byPerson` (neither flag).
2. **Worked examples** (`src/how-it-works/examples.ts`) say the same details:
   - The exclusions example names the kinds: "(1 transfer, 1 reimbursement and 1 excluded by a person)".
   - The categorization example adds "2 are income, which needs no category."
3. **Diagrams** (`src/views/how-diagrams.tsx`). All are inline SVG with a `<title>` and `<desc>` that say the same numbers in words, and use DESIGN.md tokens only. They are drawn at the width of a 390px phone (`max-w-md`), like the system diagram, so the text stays legible:
   - **Budget (B):** boxes for "Budget − Spent = Safe to spend", plus "− Bills due" once bills exist. The result box is green, or brick red when negative, and always carries its words.
   - **Transactions (B):** a top-to-bottom flow: This month → (− excluded) → Counted → Needs a category.
   - **Excluding (A):** one bar of this month's transactions, with the counted part solid and each kind of exclusion a dashed slice. Under it: "32 counted", "3 excluded", and the kinds.
   - **Categories (B):** the four numbered steps as boxes with arrows between them, each with how many transactions it handled this month. The last box ("Waits for a person") is dashed. Under them: "+ 2 income, which needs no category."
4. **Spec §9** says each feature section also has a diagram drawn by code from the same numbers. **DESIGN.md** lists the four diagrams as components.

## Tests

- The count queries: `income`, and each kind of exclusion.
- Each diagram: an accessible image (a role, a title and a description), and the right numbers for a given input, including zero, one, a negative safe-to-spend and bills.
- The route: each diagram's numbers match the worked example next to it.
