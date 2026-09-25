# Phase 2a: Settings: categories and budget amounts (#55)

- **Date:** 2026-09-25
- **Spec:** §5 (categories, budget_amounts), §6 (budget for a month), §7 (archived, never deleted; no "None of these fit"; default categories), §8 (More → Settings), §11 (E2E: change a budget amount)
- **Decisions:** 32 (default categories; Settings in Phase 2), 35 (built from the owner's round 5 studies)
- **Design:** `docs/design-concepts/2026-09-25/settings-*.webp`, and the build notes in `docs/design-concepts/README.md`

## Goal

The family can set up and change their categories and monthly budgets from the app. That's needed before the trial week (#24), because production starts with no seed data.

## What gets built

1. **Default categories.** Migration `0005_default_categories.sql` inserts the 14 default categories of spec §7, but only into a database that has none. The demo keeps its seed, and a database that already has categories is never touched. Each gets a Lucide line icon (copied into `icons.tsx`, decision 22) and a `cat-*` color, cycling through the five.
2. **The Settings page** (`/settings`). It replaces the placeholder, and every part works without JavaScript; htmx only swaps the section in place.
   - **Categories:** a list of rows, each a `<details>` showing the icon, the name, and "$600 a month" (or "No budget"). A row opens in place to edit:
     - its name, and "Budget from <this month> on"
     - Save and Cancel
     - Move up and Move down
     - Archive, a link-styled button, never a delete
   - **"+ Add category":** a `<details>` with the name and budget fields. A new category gets the tag icon and the next color.
   - **"Archived (n)":** a `<details>` listing archived categories, each with **Restore**. Restore is the undo for Archive; it's new to the spec, so spec §7 is updated in this PR for the owner to approve.
3. **Rules,** in one pure module (`src/settings/category-form.ts`), unit-tested:
   - A name is required, 40 characters at most, and unique ignoring case against every category, archived ones too. The unique index would reject a duplicate anyway, so the form catches it first. If an archived category has the name, the message says to restore it instead.
   - No category may be named "None of these fit" (spec §7), ignoring case.
   - At most 50 active categories, so every screen shows them all at once (decision 37; Jev's Choice question takes up to 255 options including "None of these fit"). This applies on add and on restore.
   - A budget is dollars (`toCents`) and 0 or more. Left blank, it doesn't change: a new category then has no budget, and an existing one keeps its budget.
4. **Saving a budget** writes one `budget_amounts` row for the current month, upserted on (category, month). This month and later use the new amount; earlier months keep theirs (spec §6).
5. **Feedback:** an `HX-Trigger` with `toast` + `announce`. Errors re-render the open row with `role="alert"`. Without JavaScript, a save redirects back to `/settings`.
6. **The E2E** gets §11's "change a budget amount" flow: open Groceries in Settings, set 650, save, and see Home show "of $650".

## Not in this PR
- **Choosing an icon or a color** for a category. New ones get the tag icon and the next color. This goes on the Later list.
- **Merchant-name review and suggested categories.** They're Phase 4 (#33, #51); the studies show where they'll go.
