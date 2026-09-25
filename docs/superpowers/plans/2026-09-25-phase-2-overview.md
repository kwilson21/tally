# Phase 2: Family on the core (overview plan)

- **Date:** 2026-09-25
- **Milestone:** Phase 2 ([milestone 3](https://github.com/kwilson21/tally/milestone/3))
- **Finish line (spec §11):** the family uses Tally for a week (#24). Retiring the Django app and moving `finance.thesuperhuman.us` is a separate decision.

Each step gets its own detailed plan (`2026-09-2x-phase-2x-….md`) in the PR that starts it, as in Phase 1.

## Owner decisions for this phase (2026-09-25)

| # | Decision | Recorded as |
|---|---|---|
| 1 | Groundwork first: Settings, exclusions and filter announcements come before identity and Plaid. | Order below |
| 2 | The family app lives at `tally.thesuperhuman.us`. Moving to `finance.thesuperhuman.us` later is its own decision (decision 16). | Decision 34; spec §4.1 |
| 3 | Settings and Accounts are built from generated design studies the owner selects (round 5), like the Phase 1 screens. | Decision 35; brief in `docs/design-concepts/README.md` |
| 4 | Local development uses Plaid Sandbox keys in the owner's git-ignored `.dev.vars`. Tests fake Plaid at `fetch`. Production keys exist only as secrets on the production Worker. | Decision 36; spec §4.2 |

## Order

| Step | Issues | Needs from the owner | Visible in the demo |
|---|---|---|---|
| **2a. Groundwork** | #56 filter announcements → #27 exclusions → #55 Settings + default categories | Round 5 studies for Settings, before #55's UI | Yes |
| **2b. Identity** | #22 verify the Cloudflare Access JWT, and record who changed what | Nothing: tests sign their own tokens | No (the demo records `demo`) |
| **2c. Plaid** | #17 token encryption → #16 client + Link (a minimal Accounts page) → #18 sync + Plaid's category hint → #19 webhook → #21 Fix connection | Sandbox keys in `.dev.vars` for a local run; round 5 studies for Accounts, before #16's UI | No (the demo has no Plaid) |
| **2d. Nightly job** | #20 daily sync, then categorization (production only) | Nothing | No |
| **2e. Production** | #23 production Worker, D1 `tally-prod`, Access policy, secrets, `tally.thesuperhuman.us` | Create D1 and Access; run `wrangler secret put`; approve the DNS record first | — |
| **2f. Trial week** | #24 the family uses it for a week, then the Phase 2 review | Use it | — |

**Why this order:**
- 2a needs no secrets and is visible in the demo.
- Identity comes before Plaid because every Plaid write records who linked the bank (`linked_by`).
- The nightly job needs sync.
- Production comes last so the family's first week has every Phase 2 piece.

## Design study brief (round 5)

For the owner to generate at 390×844 and 1280×800 in the Illustrated ledger direction (round 4). The studies are composition references only.

- **Settings** (More → Settings; spec §8) has three sections:
  - **Categories:** each with its icon in its color, its name and this month's budget. Actions: add a category, rename it, reorder, archive (never delete), and set a budget "from <month> on". It shows an error when a name is taken or is "None of these fit".
  - **Merchant names (Phase 4):** a suggested name to accept or reject.
  - **Suggested categories (Phase 4):** a suggestion with the transactions behind it, to create or dismiss.
- **Accounts** (More → Accounts; spec §8):
  - net worth (the chart comes in Phase 4)
  - accounts grouped by bank, with their balances
  - a "Link a bank" button
  - one bank connection that needs attention, with "Fix connection"

## Risks

- **Docs we can't reach.** Plaid's docs may be blocked from the cloud environment. We check against Plaid's published OpenAPI types from npm, as was done for Jev, and record each check in `docs/verified-assumptions.md`.
- **The Access team domain.** The token's issuer and certificate URL depend on the team's name. The owner provides the team domain in 2e; code reads it from config.
- **Link's CSP.** The CSP allows Plaid's CDN on the Accounts page only (spec §10).
