# Roadmap

Each phase is a GitHub milestone. A phase ends with a review of what was built against the spec, and this file gets updated before the next phase starts.

| Phase | Goal | Finish line | Milestone |
|---|---|---|---|
| 0. Setup | Repo, rules, CI, skeleton | CI passes on the skeleton | [milestone](https://github.com/kwilson21/tally/milestone/1) |
| 1. Core demo live | Home + Transactions on seed data at tally-demo.thesuperhuman.us | Demo live over HTTPS, all routes work, no console errors | [milestone](https://github.com/kwilson21/tally/milestone/2) |
| 2. Family on the core | Plaid sync + Cloudflare Access for the family, plus Settings with default categories and exclusions, so the numbers are right from day one | Family uses it Oct 1–7, then through October (decision 58) | [milestone](https://github.com/kwilson21/tally/milestone/3) |
| 3. Bills and splits | In both environments, with the four extras (decisions 57, 58) as picked in decision 60. Building starts Oct 4; production gets it after the trial week | Shown in demo, used by family | [milestone](https://github.com/kwilson21/tally/milestone/4) |
| 3.5 Numbers you can trust | Fix the rule gaps that can make the family's numbers wrong (decision 67, spec §8.5, `docs/reviews/original-app-gaps.md`) | Safe to spend, Spent and bill statuses match the bank (a bill paid in two parts waits for Phase 5) | label [`phase-3.5`](https://github.com/kwilson21/tally/labels/phase-3.5) |
| 4. Trends, balances, name suggestions | Remaining features, plus AI suggestions for merchant names and new categories; Documents moved to the Later list (decision 66) | Features 1–7 live in both | [milestone](https://github.com/kwilson21/tally/milestone/5) |
| AI that earns its place | Each AI feature can be switched off, and Tally shows plainly what it did (decisions 68, 73, spec §8.6) | Switches, one review screen, the monthly tally and the demo's comparison live in both | label [`ai`](https://github.com/kwilson21/tally/labels/ai) |
| 5. From the original app | Eight features the original app had built, plus the review's gaps (decisions 66, 74, 76, spec §8.4), all picked on the proposals page | Shown in demo, used by family | label [`phase-5`](https://github.com/kwilson21/tally/labels/phase-5) |
| Design system (track) | A catalog at `/design-system` built from the real components, the process every UI change follows, and the original app's components brought over one at a time ([#76](https://github.com/kwilson21/tally/issues/76)); from decisions 75 and 76, the quiet ledger form, quiet motion and squircle corners (label [`design-system`](https://github.com/kwilson21/tally/labels/design-system)) | The catalog is live on the demo, every existing component is in it at its tier, and the owner has signed off MoneyInput and the first flows there | milestone to come |
| Onboarding (after the design system track) | What a first visit shows and teaches, in the demo and in the family's first week ([#95](https://github.com/kwilson21/tally/issues/95), decision 49) | Both first visits are designed on the proposals page and signed off, and they do Things to try's job and more | milestone to come |

Phase 1 finished on 2026-09-25: the demo is live. Review: [docs/reviews/phase-1.md](docs/reviews/phase-1.md).

The design system track runs alongside Phase 2 and comes before the audit details [#67](https://github.com/kwilson21/tally/issues/67)–[#74](https://github.com/kwilson21/tally/issues/74), which are built through its catalog. Non-UI Phase 2 work (Plaid, sync, Access) isn't blocked by it. [#92](https://github.com/kwilson21/tally/issues/92) moves Things to try, the demo's only onboarding today, from the top of Home to below the Budget list; #95 is where a proper onboarding replaces it.

## Where Phase 3 stands (Oct 4: all on `main`)

| Part | Issue | State |
|---|---|---|
| Bills screen (P15) | [#25](https://github.com/kwilson21/tally/issues/25) | Merged ([#151](https://github.com/kwilson21/tally/pull/151)) |
| Splits (P17) | [#28](https://github.com/kwilson21/tally/issues/28) | Merged ([#152](https://github.com/kwilson21/tally/pull/152)) |
| Bill matching, the bill's page, a late payment's month (P16, P22) | [#26](https://github.com/kwilson21/tally/issues/26) | Merged ([#155](https://github.com/kwilson21/tally/pull/155)) |
| Find bills (P18) | [#156](https://github.com/kwilson21/tally/issues/156) | Merged ([#161](https://github.com/kwilson21/tally/pull/161)) |
| Add cash (P21) | [#159](https://github.com/kwilson21/tally/issues/159) | Merged ([#162](https://github.com/kwilson21/tally/pull/162)) |
| Refunds (P19) | [#157](https://github.com/kwilson21/tally/issues/157) | Merged ([#165](https://github.com/kwilson21/tally/pull/165)) |
| Select several (P20) | [#158](https://github.com/kwilson21/tally/issues/158) | Merged ([#166](https://github.com/kwilson21/tally/pull/166)) |

Decision 62 (the owner's picks on Oct 4): a missed bill stays overdue until it's paid or the next one is due; a bank change to a split purchase's amount removes the split. Phase 3 is complete on `main` and the demo; it reaches production in the one owner-approved deploy after Oct 7 (decision 60). The other session's income work ([#149](https://github.com/kwilson21/tally/pull/149), [#153](https://github.com/kwilson21/tally/pull/153), [#160](https://github.com/kwilson21/tally/pull/160)) is separate; [#153](https://github.com/kwilson21/tally/pull/153) needs its migration renumbered after `0015`, which `main` now uses.

Phase 4 waits for Phase 3.5 (decision 67), except #170, which was already being built. Codex built Phase 3.5 and the start of Phase 5 from the main session's briefs, in worktrees on the owner's machine, while Claude delivered the PRs (decision 88, replacing decision 78's Sonnet subagents). From Oct 10, Claude subagents running Haiku 5.5 build the rest, a fresh Haiku 5.5 subagent verifies each branch before it is pushed, and Codex and Greptile review on the PR (decision 97). A separate ultracode session handles design and polish.

## Where Phase 3.5 stands (Oct 6: all on `main`)

Every visual piece was picked (P34–P40, P45, decision 72), and every part is merged.

| Part | Issue | State |
|---|---|---|
| Income: "Count as income", unreviewed credits held (decision 70) | [#153](https://github.com/kwilson21/tally/pull/153) | Merged |
| Income from Plaid's INCOME category | [#177](https://github.com/kwilson21/tally/issues/177) | Merged ([#225](https://github.com/kwilson21/tally/pull/225)) |
| Today in the household's time zone | [#174](https://github.com/kwilson21/tally/issues/174) | Merged ([#189](https://github.com/kwilson21/tally/pull/189); the Settings field, P35 A, in [#237](https://github.com/kwilson21/tally/pull/237) and [#252](https://github.com/kwilson21/tally/pull/252)) |
| Plaid's `merchant_name` as the merchant key | [#175](https://github.com/kwilson21/tally/issues/175) | Merged ([#190](https://github.com/kwilson21/tally/pull/190)) |
| Transfers and card payments excluded at sync; a linked bill payment always counts (decision 83) | [#176](https://github.com/kwilson21/tally/issues/176) | Merged ([#224](https://github.com/kwilson21/tally/pull/224); a reviewed credit counts, [#254](https://github.com/kwilson21/tally/pull/254)) |
| Merchant rules after every sync | [#178](https://github.com/kwilson21/tally/issues/178) | Merged ([#223](https://github.com/kwilson21/tally/pull/223)) |
| Pending counted and marked (P34 A) | [#179](https://github.com/kwilson21/tally/issues/179) | Merged ([#227](https://github.com/kwilson21/tally/pull/227)) |
| Bill matching: excluded payments, "Price changed?" (P36 B) | [#180](https://github.com/kwilson21/tally/issues/180) | Merged ([#228](https://github.com/kwilson21/tally/pull/228)) |
| Refund guards | [#181](https://github.com/kwilson21/tally/issues/181) | Merged ([#226](https://github.com/kwilson21/tally/pull/226)) |
| Bill guards (P45 A) | [#182](https://github.com/kwilson21/tally/issues/182) | Merged ([#188](https://github.com/kwilson21/tally/pull/188)) |
| A failed save says so (P38 A); 404 and 500 pages (P39 C) | [#183](https://github.com/kwilson21/tally/issues/183) | Merged ([#222](https://github.com/kwilson21/tally/pull/222)) |
| A stale or broken bank flagged on Home (P37 A) | [#184](https://github.com/kwilson21/tally/issues/184) | Merged ([#221](https://github.com/kwilson21/tally/pull/221)) |
| The first visit's empty list (P40 A) | [#185](https://github.com/kwilson21/tally/issues/185) | Merged ([#220](https://github.com/kwilson21/tally/pull/220)) |

## Where Phase 4 stands (Oct 5: picked; built after Phase 3.5, decision 88)

The owner picked every Phase 4 design on the proposals page (decision 64, spec §8.3), and asked for "Why?" links and How Tally works in the family app (decision 65).

| Part | Issue | State |
|---|---|---|
| How Tally works in the family app, and the "Why?" link (decision 65) | [#170](https://github.com/kwilson21/tally/issues/170) | Merged ([#173](https://github.com/kwilson21/tally/pull/173)) |
| Trends (P23 D, P24 A) | [#30](https://github.com/kwilson21/tally/issues/30) | Merged ([#229](https://github.com/kwilson21/tally/pull/229)) |
| Net-worth chart (P25 A, P26 A) | [#31](https://github.com/kwilson21/tally/issues/31) | Merged ([#230](https://github.com/kwilson21/tally/pull/230)) |
| Documents (P27 A, P28 A) | [#32](https://github.com/kwilson21/tally/issues/32) | Moved to the Later list with receipts (decision 66); not built |
| Merchant name suggestions (P29 A) | [#33](https://github.com/kwilson21/tally/issues/33) | In review ([#245](https://github.com/kwilson21/tally/pull/245)) |
| New-category and category suggestions, "Tally" not "Jev" on screens (P30 A, P32 A, decision 89) | [#51](https://github.com/kwilson21/tally/issues/51) | To build after #33 (both use `src/ai/suggest-name.ts`; decision 88) |

## AI that earns its place (decisions 68, 73; spec §8.6)

#191 is merged ([#231](https://github.com/kwilson21/tally/pull/231)), and so is #193 ([#238](https://github.com/kwilson21/tally/pull/238)). The nightly Jev pass runs twice, so a new bank's backfill of up to 500 can be sorted in one night, and when Jev answers slowly its time budgets stop the passes sooner and the rest waits for the next night (decision 56); a queue replaces the per-run caps next ([#248](https://github.com/kwilson21/tally/issues/248)).

| Part | Issue | Depends on |
|---|---|---|
| The AI suggestions switches in Settings (P41 B, a new Switch component) | [#191](https://github.com/kwilson21/tally/issues/191) | Merged |
| Jev's income answer: applied or "Maybe income" | [#192](https://github.com/kwilson21/tally/issues/192) | #177, #51, #191 |
| Sort new transactions right after each sync | [#193](https://github.com/kwilson21/tally/issues/193) | Merged |
| Plaid's merchant name as the first name suggestion | [#194](https://github.com/kwilson21/tally/issues/194) | #175, #33 (built, stacked on #245) |
| One review screen for every "Maybe …" (P42 A) | [#195](https://github.com/kwilson21/tally/issues/195) | #33, #51, #192 |
| What AI did this month (P43 A) | [#196](https://github.com/kwilson21/tally/issues/196) | #191 |
| The demo's See it without AI (P44 A, "Tidied by Tally · Straight from the bank", decision 89) | [#197](https://github.com/kwilson21/tally/issues/197) | — |
| Tally fills in a transaction's details (P89 A) | [#232](https://github.com/kwilson21/tally/issues/232) | #191, #194 |
| Jev told each merchant's recent categories, so every guess improves (decision 90, Q69 A); built before #233 | [#265](https://github.com/kwilson21/tally/issues/265) | — |

## Phase 5 (decisions 66, 74, 76, 82; spec §8.4)

The owner picked each open question's answer from a picture (decision 82, P91–P109 on the proposals page, and decision 86 for the bank email).

| Part | Issue |
|---|---|
| Browse past months on Home (P46 A) | [#198](https://github.com/kwilson21/tally/issues/198) |
| Home's top: over budget, Why?, a daily amount, older uncategorized (P47, P48, P50, P52) | [#199](https://github.com/kwilson21/tally/issues/199) |
| Budget rows: nearly spent, Not budgeted amounts, a link to transactions (P49, P51, P53) | [#200](https://github.com/kwilson21/tally/issues/200) |
| A monthly savings goal (P54 A, R1) | [#201](https://github.com/kwilson21/tally/issues/201) |
| Planned one-time expenses (P55 A) | [#202](https://github.com/kwilson21/tally/issues/202) |
| Reconnect reminder email (P56 B, P107–P109); Resend first (decision 86) | [#203](https://github.com/kwilson21/tally/issues/203) |
| Weekly, every-two-weeks and quarterly bills (P57 A) | [#204](https://github.com/kwilson21/tally/issues/204) |
| Partial bill payments (P58 A) | [#205](https://github.com/kwilson21/tally/issues/205) |
| A linked payment takes its bill's category (P59 A) | [#206](https://github.com/kwilson21/tally/issues/206) |
| The monthly bills total (P60 A and B) | [#207](https://github.com/kwilson21/tally/issues/207) |
| A bill's amount history (P61 A, H1) | [#208](https://github.com/kwilson21/tally/issues/208) |
| Offer a merchant rule after three saves (P62 B) | [#209](https://github.com/kwilson21/tally/issues/209) |
| Filter by account and by type (P63 A, P64 B); merged ([#243](https://github.com/kwilson21/tally/pull/243), [#251](https://github.com/kwilson21/tally/pull/251)) | [#210](https://github.com/kwilson21/tally/issues/210) |
| Search by category or amount, in every month (P65 A, P66 A) | [#211](https://github.com/kwilson21/tally/issues/211) |
| A New category chip, then likely transactions (P67 A, P73 A) | [#212](https://github.com/kwilson21/tally/issues/212) |
| Rename one transaction only (P68 A) | [#213](https://github.com/kwilson21/tally/issues/213) |
| "Always for these merchants" in Settings (P69 A) | [#214](https://github.com/kwilson21/tally/issues/214) |
| Select all in the action bar (P70 A) | [#215](https://github.com/kwilson21/tally/issues/215) |
| Edit a cash entry's date and amount (P71 A) | [#216](https://github.com/kwilson21/tally/issues/216) |
| A store that sells many kinds of things (P90, decision 89) | [#233](https://github.com/kwilson21/tally/issues/233) |

## Design system: what's next (decisions 75, 76; the design session builds these)

| Part | Issue |
|---|---|
| The quiet ledger form, catalog first, then Add a bill and Add cash (P72 A) | [#217](https://github.com/kwilson21/tally/issues/217) |
| Quiet motion in CSS, with View Transitions between pages (P74 A) | [#218](https://github.com/kwilson21/tally/issues/218) |
| Squircle corners (P75 A) | [#219](https://github.com/kwilson21/tally/issues/219) |
| MoneyInput sign-off, the budget, categorize and Settings flows, the component review | [#80](https://github.com/kwilson21/tally/issues/80), [#83](https://github.com/kwilson21/tally/issues/83)–[#86](https://github.com/kwilson21/tally/issues/86) |

The owner answered the 53 open questions on these issues by seeing a picture of each answer (decisions 79–81, [docs/reviews/open-questions-2026-10-05.md](docs/reviews/open-questions-2026-10-05.md)), and the picked drawings now say which rules are settled. Some issues still list smaller points under "Open (ask the owner)"; each goes to the owner, with a picture, before that issue is briefed. #74's pace line is covered by #199 and closed.

## Polish after Phase 3.5 (Oct 6; the design session)

A pass over every page Phase 3.5 touched, at 1280×800 and 390×844, on the demo and the family app, against DESIGN.md.

| Part | PR or issue |
|---|---|
| 44px targets and token colours only | [#240](https://github.com/kwilson21/tally/pull/240) |
| Headings at their type roles, Transactions lined up | [#241](https://github.com/kwilson21/tally/pull/241) |
| Copy, disclosure chevrons, How Tally works | [#242](https://github.com/kwilson21/tally/pull/242) |
| The owner's picks Q56–Q59: Documents out of the menu, the cash delete question, the demo's feedback page, Bills' How link (decision 84, P110–P113) | [#246](https://github.com/kwilson21/tally/pull/246) |
| The owner's picks Q60–Q63: the delete wording once Undo ships, the money box's corners, a 3-month average of whole months (decision 85, P114–P116) | [#253](https://github.com/kwilson21/tally/pull/253) |
| Undo after deleting a cash entry (decision 84, Q57 D); for the build session | [#244](https://github.com/kwilson21/tally/issues/244) |
| A 3-month average chip in the budget sheet (decision 85, Q62 B); for the build session | [#250](https://github.com/kwilson21/tally/issues/250) |

Later list (not scheduled): see spec §12.
