# Edit budgets on Home, with nudges (#66)

- **Date:** 2026-09-26
- **Spec:** §7 (budgets), §8 (Home, Settings)
- **Decisions:** 38 (budgets are set on Home, not in Settings), 39 (`money.js` joins the allowed custom JS)
- **Audit:** #65, M1–M4. The details come from the original app's `currency-input`.

## Goal

A budget is changed where it's seen: tap a budget row on Home. The amount field has the original app's small helpers, so nudging a budget by a dollar or a cent is one tap.

## Changes

1. **Home** renders like Transactions. A budget row is a link to `/budget/<id>`, which opens a sheet (`BottomSheet`) over Home. htmx swaps only `#sheet`, and the URL works without JavaScript.
   - **Not budgeted:** under the budget rows, a quiet list of active categories with no budget this month. Each row says "Add a budget" and opens the same sheet. This replaces the old "Add budget amounts in Settings" link.
2. **The budget sheet:** the category's icon and name, and one field, "Budget from <month> on".
   - **Saving:** writes one `budget_amounts` row for this month (upsert), as Settings did. The toast and announcement say "Groceries is $650 a month from September on." Focus returns to the row.
   - **Errors:** "Enter a dollar amount, like 250 or 250.50." and "Keep the budget to $1,000,000 a month or less." Both come back in the sheet with `role="alert"`.
   - **No budget removal yet:** the field is required (the Later list has removing a budget).
3. **MoneyInput** (`src/views/money-input.tsx`) and `public/js/money.js`:
   - **Layout:** the owner's hero amount from the original app. A round −$1 button, then a big amount field (`$`, bold, always with cents: "700.00") with ▲▼ cent arrows stacked inside its right edge, then a round +$1 button.
     - The first version swapped this for a row of four 44px buttons to meet the target-size rule.
     - The owner asked for the original design back (2026-09-26), so the original is kept.
     - To meet the 44px rule without changing the look, the field is 90px tall, so each stacked cent arrow is 44×44 (the owner's pick, from a side-by-side).
   - **Chips:**
     - "Round to $251" shows only when the amount has cents.
     - "Last month: $612.40" shows what the category spent last month (counted spending, not income), only when that's above $0. It dims when the field already holds it.
   - **Rules:** typing stops at two decimals, and the minus buttons are disabled at $0.
   - **Without JavaScript:** the buttons and chips stay hidden (`html.js` turns them on), and the field still saves.
   - **The math is integer cents:** `money.js` exports pure functions, which are unit-tested.
4. **Settings** loses its budget fields (the row still shows "$600 a month"). Add category adds only a name.
5. **Spec, DESIGN.md, CLAUDE.md and decisions** change with it, and the E2E's "change a budget amount" moves to Home and uses a nudge.
