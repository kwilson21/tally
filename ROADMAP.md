# Roadmap

Each phase is a GitHub milestone. A phase ends with a review of what was built against the spec, and this file gets updated before the next phase starts.

| Phase | Goal | Finish line | Milestone |
|---|---|---|---|
| 0. Setup | Repo, rules, CI, skeleton | CI passes on the skeleton | [milestone](https://github.com/kwilson21/tally/milestone/1) |
| 1. Core demo live | Home + Transactions on seed data at tally-demo.thesuperhuman.us | Demo live over HTTPS, all routes work, no console errors | [milestone](https://github.com/kwilson21/tally/milestone/2) |
| 2. Family on the core | Plaid sync + Cloudflare Access for the family, plus Settings with default categories and exclusions, so the numbers are right from day one | Family uses it Oct 1–7, then through October (decision 58) | [milestone](https://github.com/kwilson21/tally/milestone/3) |
| 3. Bills and splits | In both environments, with the four extras (decisions 57, 58) as picked in decision 60. Building starts Oct 4; production gets it after the trial week | Shown in demo, used by family | [milestone](https://github.com/kwilson21/tally/milestone/4) |
| 4. Trends, balances, documents, name suggestions | Remaining features, plus AI suggestions for merchant names and new categories | All 8 features live in both | [milestone](https://github.com/kwilson21/tally/milestone/5) |
| Design system (track) | A catalog at `/design-system` built from the real components, the process every UI change follows, and the original app's components brought over one at a time ([#76](https://github.com/kwilson21/tally/issues/76)) | The catalog is live on the demo, every existing component is in it at its tier, and the owner has signed off MoneyInput and the first flows there | milestone to come |
| Onboarding (after the design system track) | What a first visit shows and teaches, in the demo and in the family's first week ([#95](https://github.com/kwilson21/tally/issues/95), decision 49) | Both first visits are designed on the proposals page and signed off, and they do Things to try's job and more | milestone to come |

Phase 1 finished on 2026-09-25: the demo is live. Review: [docs/reviews/phase-1.md](docs/reviews/phase-1.md).

The design system track runs alongside Phase 2 and comes before the audit details [#67](https://github.com/kwilson21/tally/issues/67)–[#74](https://github.com/kwilson21/tally/issues/74), which are built through its catalog. Non-UI Phase 2 work (Plaid, sync, Access) isn't blocked by it. [#92](https://github.com/kwilson21/tally/issues/92) moves Things to try, the demo's only onboarding today, from the top of Home to below the Budget list; #95 is where a proper onboarding replaces it.

## Where Phase 3 stands (Oct 4)

| Part | Issue | State |
|---|---|---|
| Bills screen (P15) | [#25](https://github.com/kwilson21/tally/issues/25) | Merged ([#151](https://github.com/kwilson21/tally/pull/151)) |
| Splits (P17) | [#28](https://github.com/kwilson21/tally/issues/28) | Merged ([#152](https://github.com/kwilson21/tally/pull/152)) |
| Bill matching, the bill's page, a late payment's month (P16, P22) | [#26](https://github.com/kwilson21/tally/issues/26) | Merged ([#155](https://github.com/kwilson21/tally/pull/155)) |
| Find bills (P18) | [#156](https://github.com/kwilson21/tally/issues/156) | Merged ([#161](https://github.com/kwilson21/tally/pull/161)) |
| Add cash (P21) | [#159](https://github.com/kwilson21/tally/issues/159) | Merged ([#162](https://github.com/kwilson21/tally/pull/162)) |
| Refunds (P19) | [#157](https://github.com/kwilson21/tally/issues/157) | Briefed to Codex (Oct 4) |
| Select several (P20) | [#158](https://github.com/kwilson21/tally/issues/158) | Briefed to Codex (Oct 4) |

Decision 62 (the owner's picks on Oct 4): a missed bill stays overdue until it's paid or the next one is due; a bank change to a split purchase's amount removes the split. Phase 3 stays on `main` and the demo until the one production deploy after Oct 7 (decision 60). The other session's income work ([#149](https://github.com/kwilson21/tally/pull/149), [#153](https://github.com/kwilson21/tally/pull/153), [#160](https://github.com/kwilson21/tally/pull/160)) is separate; [#153](https://github.com/kwilson21/tally/pull/153) needs its migration renumbered after `0014`, which `main` now uses; refunds take `0015`.

Later list (not scheduled): see spec §12.
