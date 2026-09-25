# Phase 1 review: Core demo live

- **Date:** 2026-09-25
- **Issue:** #53
- **Checked against:** the spec (`docs/superpowers/specs/2026-09-22-tally-design.md`) and `main` at `a9921f0`, which is deployed to the demo as version `27fda33f`.

## Finish line (spec §11)

> `https://tally-demo.thesuperhuman.us` loads over HTTPS, all Phase 1 routes work, and there are no console errors. DNS records are shown to the owner and approved before they're created.

**Met.**
- **Loads over HTTPS.** The demo is served as a Workers Custom Domain, and the owner opened it on their phone (#15).
- **DNS.** The owner checked the one record before the first deploy, as README's "Deploy the demo" section describes.
- **Routes.** Run against a local copy of `main` with the demo seed:
  - `/`, `/transactions`, `/transactions?uncategorized=1`, `/transactions/110`, `/transactions/94`, `/how-it-works`, `/more`, `/bills`, `/trends`, `/accounts`, `/documents`, `/settings` and `/healthz` all return 200.
  - An unknown path returns 404.
- **No console errors.** `npm run screenshots` took 24 images, and `npm run e2e` (recategorize, spec §11) passed. Both fail on any console error.
- **Checks.** Build, typecheck and lint pass, and all 312 tests pass.
- **The live data tells the story.** After Jev's nightly run, the demo still shows the §9 story: Eating Out over, Gas close to its limit (93%), and the rest on track.

## Built vs. spec

| Phase 1 item (§11) | Issues | Result |
|---|---|---|
| Wireframes | #4 | Done. Design studies selected ("Quiet ledger", decisions 20–21), and a design system in `DESIGN.md` (#36). |
| D1 schema | #5 | Done. Matches §5, plus `jev_category_id` (decision 29) and `jev_failed_at` (decision 31). |
| Seed household | #8 | Done for features 1 and 3. The seeds for features 2 and 4–8 come with those features (#29, #34). |
| Home | #9 | Done for feature 1. "Bills due in the next 7 days" comes with bills (#25). |
| Transactions: search, filters, 25 a page | #10 | Done. |
| Edit panel: category, merchant rule, rename, note | #11 | Done. The exclude toggle and split come in Phase 3 (#27, #28). |
| Jev categorization | #12, #49 | Done. Nightly only, 40 calls a night, 0.80 threshold, "None of these fit", failure handling (decisions 27–31). |
| Demo banner, Things to try, How Tally works | #13 | Done. |
| Nightly reset | #14, #43 | Done. It runs only when `DEMO` is `"true"` and no Plaid credentials are present (decision 25). |
| `demo` deploy | #15 | Done. |
| Not in the §11 list, done at the owner's request | #39 | CI screenshots in every PR description (decision 24). |

**Cross-cutting rules, checked in code:**
- **Money:** amounts are integer cents; the database rejects anything else (`typeof(...) = 'integer'`).
- **Page behavior:** edits send an `HX-Trigger` header with `toast` and `announce`, and swap regions are `aria-live`.
- **Security:** a strict CSP with no inline scripts, `X-Frame-Options: DENY`, and Hono's `csrf` for form posts.
- **Jev:** only `src/ai/categorize.ts` talks to Jev. The only log lines are `jev: <status> <request id>` and the nightly counts.
- **Identity:** edits record `demo` in the demo. Anywhere else they fail loudly until #22 reads the verified Cloudflare Access email.

## Findings

Ranked by how much they matter. Nothing here blocks the demo. Items 1 to 4 need the owner's decision.

1. **Settings for categories and budget amounts has no issue in any phase.**
   - Spec §8 lists it under More → Settings, and §11's E2E list includes "change a budget amount". The only Settings work with an issue is merchant-name review (#33, Phase 4).
   - The production database starts empty; only the demo gets the seed. So in Phase 2 the family couldn't set up categories or budgets, and Home would say "No budgets set yet".
   - **Proposal:** a new issue in Phase 2. Settings lists, adds, renames and archives categories (never deletes them, per §7), and sets a budget amount from a month on. It enforces §7's rules: no category named "None of these fit", and at most 254 active categories, because Jev's Choice question takes up to 255 options including "None of these fit". It includes the "change a budget amount" E2E.
2. **Plaid's category hint isn't sent to Jev.**
   - Spec §7 lists it as Jev input, but no column stores it yet. The 1e plan deferred it to Phase 2 sync, but no issue tracks it.
   - **Proposal:** add it to #18 (sync stores Plaid's hint) and have `askJev` send it once it's stored.
3. **Jev's transfer and reimbursement flags don't exclude anything yet.**
   - Spec §6 says flagged transactions start excluded. Today Jev sets the flag, but `excluded` stays 0 until #27 (Phase 3).
   - Production will run Jev in Phase 2, before #27, so it will build up flagged but counted rows.
   - **Proposal:** note on #27 that it must also exclude transactions Jev flagged before it shipped, and must leave any a person has already changed alone.
4. **Spec text that no longer matches what was decided.** None of these changes behavior. Proposed wording, to apply once approved:
   - **§4.1, the demo's nightly job:** "Reset the database and bucket to the seed" → "…to the seed, then categorize" (§7 already says Jev runs after the reset).
   - **§7, Jev input:** add "(from Phase 2, once sync stores it)" after Plaid's category hint.
   - **§13:** "handled by retrying on `RateLimitError`" → "a 429 stops that night's run and the next night retries". There is no SDK (decision 19).
   - **Header:** "Status: Draft, awaiting owner review". Phases 0 and 1 were built from it, so the owner may want to mark it approved.
5. **`npm run deploy` deploys with no environment (low).**
   - It runs `wrangler deploy` against the top-level config: a Worker named `tally`, `DEMO` set to `"true"`, and a placeholder database id.
   - It most likely fails at the database binding, but it's a trap next to the documented `--env demo` command.
   - **Proposal:** remove the script. README and CLAUDE.md already give the full command.
6. **Review issues (low).** Phases 2 and 4 have review issues (#24, #35); Phases 1 and 3 had none. This review is #53. **Proposal:** add a "Phase 3 review" issue to its milestone.

## What went well

- **Reviews caught real bugs before they shipped.** Greptile and the two independent review agents on #52 found issues that tests alone didn't.
- **Decisions stayed decided.** Every change of direction got a decision entry: 26–31 in this phase.
- **Deploys only ever came from `main`.** They ran from a clean checkout of `origin/main`, with migrations applied before code.

## Lesson for Phase 2

**A PR that adds a migration must say so in its deploy steps.** #52 briefly said "no migrations" when it added one. The deploy applied it first anyway. From now on, a PR's "After merging" section lists every migration it adds, with the `migrations apply` command first.
