# Phase 3 review: Bills and splits

- **Date:** 2026-10-10
- **Issue:** #57
- **Checked against:** the spec (`docs/superpowers/specs/2026-09-22-tally-design.md`) and `main` at `19b3969`, with the decisions that changed Phase 3 after it was planned (57, 58, 60, 62, 67, 74, 83, 84, 85 and 93). Nine read-only audits, one per part plus the cross-cutting rules and the finish line; a second reader tried to refute every finding before it was kept.

## Finish line (spec §11)

> In both environments, with seed data for each. Shown in the demo, used by the family.

**Met on `main`; not met in the demo.**
- **`main` has all of Phase 3.** A local copy of `main` with the demo seed, reset through its nightly job, returns 200 for `/`, `/transactions`, `/transactions?uncategorized=1`, a transaction's page, `/bills`, a bill's page, `/trends`, `/accounts`, `/settings`, `/more`, `/how-it-works` and `/healthz`, and 404 for an unknown path.
- **E2E.** All four §11 flows are in `scripts/e2e.mjs`: recategorize (`:270`), split and remove a split (`:414`, `:424`), exclude (`:278`) and change a budget amount (`:338`), plus Add cash, a refund link, Select several and "no console errors". They passed in CI's own run on PR #319, whose tree is identical to `main`'s. CI runs the e2e on pull requests only.
- **Checks.** The latest `main` CI run is green.
- **The demo is not running Phase 3** (finding 1). The public demo serves a build from before PR #151 (Oct 4): Bills says "This part of Tally isn't built yet.", a bill's page is 404, Accounts returns 500, How Tally works says "the demo adds bills in a later phase", and its newest rows are dated Oct 2. ROADMAP said Phase 3 was "complete on `main` and the demo"; that line is corrected in this PR.
- **Production** was not checked: this review never reads production (decision 60's deploy after Oct 7 is the owner's).

## Built vs. spec

| Phase 3 part | Issue (PR) | Result |
|---|---|---|
| Bills screen, status rule (P15) | #25 (#151) | Done with gaps. The status rule matches §6 and decision 62; groups, add, edit, deactivate, the Safe to spend set-aside and Home's list are built and tested. Findings 2, 3, 13 and 14. |
| Bill matching, the bill's page, a late payment's month (P16, P22) | #26 (#155) | Done with gaps. One-to-one matching, the ±10% and ±5-day windows, the tie-break, the hand-link picker and the counted-month rule match §6.1; every month reader uses the same counted-month SQL. Findings 4, 5 and 9. |
| Splits (P17) | #28 (#152) | Done with gaps. Create, remove, the exact-sum rule, decision 62's bank-correction removal and keeping split parents out of every count are built. Findings 6 and 7. |
| Find bills (P18) | #156 (#161) | Done with gaps. The Band, the list, Add, Not a bill, the export and the seed match P18. Findings 10, 11 and 12. |
| Refunds (P19) | #157 (#165) | Done with gaps. Linking from the refund, counting in the purchase's month and category, both captions and the export are built. Findings 8, 15, 16 and 17. |
| Select several (P20) | #158 (#166) | Done with gaps. All 11 review findings on #166 are fixed; one rule from #165, merged 34 minutes later, never reached it. Finding 16. |
| Add cash (P21) | #159 (#162) | Done with gaps. The form, the single Cash account, positive cents for spending, dates against the household's today, and delete with a question and a 10-second Undo (decisions 84, 85). Findings 18 and 19. |
| Seed data | #29 | Done on `main`. The demo is behind (finding 1); finding 20. |

**Cross-cutting rules, checked in code across all 18 Phase 3 form posts:**
- **Money:** amounts are integer cents everywhere, with database checks, except `split_removed_from_cents` (small fixes, #329). Split parts sum exactly; bill tolerance and finding use integer math.
- **Plaid's sign:** honored by the finder, price offers, refunds and cash; not by the bill payment picker (finding 5).
- **Dates:** a transaction's date is never converted; every date sum is calendar math on `YYYY-MM-DD`; "today" is the household's.
- **Page behavior:** every edit sends `HX-Trigger` with `toast` and `announce`; every swap is announced or moves focus, except the bill page's month chips (finding 4) and cash Undo (finding 18); errors use `role="alert"`; controls are 44px.
- **Security and identity:** Hono's `csrf` guards every post; the actor comes only from the verified Access JWT; no Phase 3 code logs tokens or transaction details.

## Findings

Most important first. Bugs a person would hit are filed as issues now; the rest need the owner's call and are on the decisions page (Oct 10), each with a picture.

1. **The public demo runs a build from before Phase 3** (spec gap, owner action). Phase 3 isn't "shown in the demo". **Proposal:** the owner deploys `main` to the demo (`npx wrangler d1 migrations apply DB --env demo --remote`, then `npx wrangler deploy --env demo`), then checks that `/bills` shows its four groups and Transactions shows today's date.
2. **A bill added after its due date shows Overdue and holds its amount back for months** (money). Decision 62 doesn't tell a missed bill from one whose date passed before the family added it; a yearly bill added in October with a March date holds its amount out of Safe to spend until February, and nothing can mark it paid. **Owner's call** (decisions page, Phase 3 question 1).
3. **The bill form asks for "the bank's text" but matches on the merchant's name** (money). A payment to a merchant Plaid names ("CVS Pharmacy") never matches the bank text typed in ("CHECKCARD 0921 CVS"). **Owner's call** (question 2).
4. **Choosing a month in Link a payment nests a second copy of the page** (accessibility). htmx 4 sends `HX-Target: section#payment-picker`, the route expects `payment-picker`, and the whole page lands inside the picker with duplicate landmarks and ids. **Filed: #323.**
5. **The payment picker lets a refund pay a bill** (money). No `amount_cents > 0` check, so a credit marks the bill Paid and raises Safe to spend. **Filed: #324.**
6. **Removing a split deletes a bill payment linked to one of its parts, without a word** (data). **Owner's call** (question 3).
7. **After the bank removes a split, a merchant rule or Jev re-sorts the purchase at once** and the "split was removed" note disappears. **Owner's call** (question 5).
8. **Sync unlinks a refund when the bank changes its split purchase, without telling anyone.** **Owner's call** (question 4).
9. **Reactivating a bill doesn't link payments that arrived while it was off** (money, until the next sync). **Filed: #325.**
10. **Possible bills never suggests loan payments**, which Plaid files as transfers. **Owner's call** (question 6).
11. **Possible bills suggests a merchant already linked to a bill by hand.** **Owner's call** (question 7).
12. **A possible bill is named by its untidied bank text** (wrong words). **Filed: #328.**
13. **The bill status rule isn't explained anywhere a person can find it**: no How Tally works lines and no Why? link. **Owner's call** (question 14; placement is a new visual choice).
14. **An inactive bill still says "Due Oct 15"** (wrong words). **Owner's call** (question 15).
15. **A linked credit marked as income still says it counts with its purchase** (wrong words). **Filed: #326.**
16. **Set category on several transactions writes onto a refund that follows its purchase**, and the toast counts it (wrong words). **Owner's call** on the words for skipped rows (question 11).
17. **The spec doesn't say that splitting a purchase unlinks its refunds**, though the code and tests do. **Owner's call** (question 12).
18. **Cash Undo can't practically be reached by keyboard or screen reader** in its 10 seconds (accessibility). **Owner's call** on where focus goes (question 9).
19. **Add cash opens with $20.00 filled in.** **Owner's call** (question 10).
20. **The seeded Costco split parts say Tally picked their categories** (wrong words). **Filed: #327.**
21. **Small fixes** (an income row's split error, dead code, two How Tally works lines, a How this works link, Undo retry, the catalog's Undo toast, the matcher's query count): **Filed: #329.** Ticks lost between pages in Select mode go with #321 (question 13).

## Owner decisions (2026-10-10)

The owner answered every question from pictures of today's screen beside the options (decision 99).

| Finding | Outcome |
|---|---|
| 1. The demo runs an old build | The owner had Claude deploy `main` to the demo (27 migrations, 0006 to 0033) and then to production as release `v2026.10.10` (decision 98) |
| 2. A bill added after its due date | A date before the bill was added counts as handled: #337 |
| 3. "The bank's text" never matches | Typed bank text saves that payment's store, so it matches: #338 |
| 4, 5, 9, 12, 15, 20, 21 | Filed as bugs: #323, #324, #325, #328, #326, #327, #329 |
| 6. A split part's bill payment | Unlinked, and the toast says so: #343 |
| 7, 8. The bank removes a split | The purchase goes back to its earlier category with its note kept; a linked refund says it is no longer linked: #344 |
| 10, 11. Possible bills | Suggest loan payments; skip payments already linked; card payments and transfers get a proposal: #339, #336 |
| 13, 14. Bill status and inactive bills | Why? beside each Bills status heading; an inactive bill shows its schedule: #341 |
| 16. Set category on a linked refund | Its purchase gets the category and the refund follows: #346 |
| 17. Splitting a purchase with a refund | The split sheet asks which part the refund goes with: #345 |
| 18, 19. Cash Undo and the $20.00 | Focus moves to Undo; Add cash opens empty: #342 |
| "Not this one" (finding 9's neighbour) | Undo on the toast, and the picker keeps it under "You said not this one": #340 |
| Ticks across pages | Decided with #321 |

## What went well

- **One counting rule.** Every reader scoped to a month (Home, Trends, the bill page, refunds) uses the same counted-month SQL, so a bill payment or a refund counts in exactly one month everywhere.
- **Decided by seeing.** Decision 62 settled the two hardest rules (a missed bill, a bank change to a split) from pictures, and the code follows them.
- **The critical flows are covered.** All four §11 E2E flows, plus Phase 3's own, run on every pull request.

## Lessons for Phase 4 and 5

1. **A phase isn't shown in the demo until the demo is deployed.** ROADMAP said Phase 3 was in the demo for six days while the demo ran an older build. From now on, a phase's review checks the live demo, and ROADMAP says "on `main`" until the owner has deployed it.
2. **Two features merged the same hour can miss each other's rules.** Refund linking (#165) changed how a linked refund counts; Select several (#166), merged 34 minutes later, kept writing categories onto those refunds. When a feature adds a counting rule, its brief lists every other writer of the same columns.
3. **Verify with CI's exact commands.** PR #318's local checks ran `npm test` but not `npm run test:feedback-integration`, which CI runs on its own, and CI went red. Decision 97's verifier now runs both.
