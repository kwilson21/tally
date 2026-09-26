# Roadmap

Each phase is a GitHub milestone. A phase ends with a review of what was built against the spec, and this file gets updated before the next phase starts.

| Phase | Goal | Finish line | Milestone |
|---|---|---|---|
| 0. Setup | Repo, rules, CI, skeleton | CI passes on the skeleton | [milestone](https://github.com/kwilson21/tally/milestone/1) |
| 1. Core demo live | Home + Transactions on seed data at tally-demo.thesuperhuman.us | Demo live over HTTPS, all routes work, no console errors | [milestone](https://github.com/kwilson21/tally/milestone/2) |
| 2. Family on the core | Plaid sync + Cloudflare Access for the family, plus Settings with default categories and exclusions, so the numbers are right from day one | Family uses it for a week | [milestone](https://github.com/kwilson21/tally/milestone/3) |
| 3. Bills and splits | In both environments | Shown in demo, used by family | [milestone](https://github.com/kwilson21/tally/milestone/4) |
| 4. Trends, balances, documents, name suggestions | Remaining features, plus AI suggestions for merchant names and new categories | All 8 features live in both | [milestone](https://github.com/kwilson21/tally/milestone/5) |
| Design system (track) | A catalog at `/design-system` built from the real components, the process every UI change follows, and the original app's components brought over one at a time ([#76](https://github.com/kwilson21/tally/issues/76)) | The catalog is live on the demo, every existing component is in it at its tier, and the owner has signed off MoneyInput and the first flows there | milestone to come |

Phase 1 finished on 2026-09-25: the demo is live. Review: [docs/reviews/phase-1.md](docs/reviews/phase-1.md).

The design system track runs alongside Phase 2 and comes before the audit details [#67](https://github.com/kwilson21/tally/issues/67)–[#74](https://github.com/kwilson21/tally/issues/74), which are built through its catalog. Non-UI Phase 2 work (Plaid, sync, Access) isn't blocked by it.

Later list (not scheduled): see spec §12.
