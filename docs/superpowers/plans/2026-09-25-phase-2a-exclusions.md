# Phase 2a: Exclusions (#27)

- **Date:** 2026-09-25
- **Spec:** §6 ("Exclusions"), §8 (edit panel: exclude toggle), §9 (a How Tally works section per feature), §11 (E2E: exclude)
- **Decisions:** 28 (a flag is applied only once a person can undo it), 33 (exclusions move to Phase 2)

## Goal

Transfers and reimbursements don't count as spending, and a person can exclude or include any transaction. This has to work before the family's trial week (#24).

## Changes

1. **The edit panel's exclude toggle.**
   - A labeled checkbox, "Exclude from the budget", with a hint under it.
   - `parseEdit` reads it, and `saveEdit` writes `excluded` in the same atomic batch as the rest of the edit.
   - The announcement adds "It's excluded from the budget." or "It counts in the budget again." when the setting changed.
2. **Jev's flags exclude.** `saveJevResult` sets `excluded = MAX(excluded, transfer OR reimbursement)`. It only ever turns exclusion on, and only on rows nobody has categorized (its existing guard).
3. **Migration `0004_exclude_flagged.sql`.** It excludes rows Jev flagged before this shipped. Until now no one could change exclusion, so no person's choice is overwritten.
4. **How Tally works gets an "Excluding transactions" section**, with the §6 rule and this month's excluded count.
5. **The E2E** (`scripts/e2e.mjs`) also excludes a transaction and checks that Home's count follows.

## Not changed

**Jev's income flag is still not stored.** Decision 28 held it back until a person can change flags. #27 adds the exclude toggle only, and spec §8's edit panel has no income control. Whether to add one, and then store Jev's income answer, is for the owner to decide.

## Deploy

This adds migration `0004`. Apply it before deploying:

    npx wrangler d1 migrations apply DB --env demo --remote
    npx wrangler deploy --env demo
