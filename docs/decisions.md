# Decisions

Settled choices and their reasons. To reverse one, add a new entry that supersedes it. Never edit an old entry.

| # | Date | Decision | Why |
|---|---|---|---|
| 1 | 2026-09-22 | Build Tally as a new project instead of porting the Django app | The Django app was built for public signups and many users. Tally only needs to serve one family, plus a public demo, so it can be much simpler. |
| 2 | 2026-09-22 | Every part must be explainable in one plain sentence | The owner directs AI-written code and must be able to explain every part in their own words, including in interviews. |
| 3 | 2026-09-22 | Plaid for automatic bank sync | The owner chose auto-sync over statement uploads. Production Plaid access already exists. |
| 4 | 2026-09-22 | Fresh start; no data migration from Django | Simplest option. Plaid backfills history when a bank is linked. |
| 5 | 2026-09-22 | One shared household, no per-user permissions | The whole family shares one budget. Changes record who made them. |
| 6 | 2026-09-22 | Server-rendered HTML (Hono JSX) + HTMX, not React | It's the simplest option the owner can explain, and it matches the "server owns state" approach from the Django app. |
| 7 | 2026-09-22 | Ship the demo first, then Plaid for the family, then the remaining features in both environments | The portfolio demo goes live early. The family gets the core before the extras. |
| 8 | 2026-09-22 | GitHub Issues + one milestone per phase; `ROADMAP.md` links to them | Built-in progress tracking, and pull requests close issues. Nothing is written in two places. |
| 9 | 2026-09-22 | Jev for categories and flags | A fast, cheap classifier with confidence scores. The owner has early access and accepts the risk that comes with it. |
| 10 | 2026-09-22 | Workers AI for merchant name suggestions, which people accept or reject | Runs on the same Cloudflare account, with no extra vendor or key. Follows the rule "the app helps, it doesn't decide." |
| 11 | 2026-09-22 | No general LLM (Claude, DeepSeek) in the app for now | None of the 8 features needs one. The "ask a question" box is on the Later list. |
| 12 | 2026-09-22 | Cloudflare Workers + D1 + R2, with one Worker deployed as two environments | No servers to run. The demo and family app share code but never share data. |
| 13 | 2026-09-22 | Money stored as integer cents | SQLite has no exact decimal type, and integers avoid floating-point errors. |
| 14 | 2026-09-22 | Cloudflare Access for family login; no auth code in the app | Removes signup, passwords, and rate limiting from the codebase. |
| 15 | 2026-09-22 | Public repo | Portfolio visibility. Secrets live only in Wrangler secrets and a git-ignored `.dev.vars`. |
| 16 | 2026-09-22 | The Django app stays up until Tally replaces it; `finance.thesuperhuman.us` DNS is only changed with the owner's explicit approval | Beta users depend on it. |
| 17 | 2026-09-22 | Identify the user from Cloudflare Access's signed login token (`Cf-Access-Jwt-Assertion`), not the plain email header; Plaid webhooks use an Access Bypass policy for that one path | Cloudflare recommends validating the token. A misconfigured rule can't be used to fake who made a change. |
| 18 | 2026-09-22 | One Jev call per transaction, asking the category and all flags together | Jev's docs recommend bundling questions in one call, which is cheaper and faster than one call per question. |
| 19 | 2026-09-22 | Call Plaid and Jev over plain `fetch`, not their SDKs | Neither SDK is confirmed to work on Workers, and `fetch` is one less dependency to explain. |
| 20 | 2026-09-22 | Visual direction "Quiet ledger": shares thesuperhuman.us foundations (paper, ink, rule, Newsreader + Inter); green/brick-red status bars; terracotta only for navigation | Chosen from three generated studies. It ties Tally to the owner's site, and the status colors never double as brand color. See docs/design-concepts/README.md. |
| 21 | 2026-09-22 | Design process: generated studies (GPT images) before UI code, then a small design system built foundations → tokens → components → patterns, following the owner's personal-site process and designsystems.one | This replaces "wireframes before UI code." Studies set the direction; HTML and tokens are the real system. |
| 22 | 2026-09-22 | Frontend assets from our own origin: htmx 4 vendored from npm at build time, Inter + Newsreader self-hosted (OFL), icons copied from Lucide (ISC) into `src/views/icons.tsx` with no package dependency | The CSP can stay `'self'`, nothing loads from third-party CDNs, and each piece is one sentence to explain. Tailwind v4 is the CSS build tool named in spec §4. |
| 23 | 2026-09-22 | Data model clarifications: flags as three 0/1 columns; categories store icon + color token; accounts may lack a Plaid item; income is excluded from spending math | Each removes an ambiguity in spec §5–§6 with the simplest representation. See Phase 1b plan. |
| 24 | 2026-09-23 | CI screenshots every page with Playwright (dev dependency) and stores the images on an orphan `screenshots` branch, linked from the PR description | Owner request (#39). The spec already names Playwright for E2E. A branch in this public repo needs no extra service or secret, and the owner reviews UI without running the app. |
| 25 | 2026-09-23 | The nightly demo reset runs only when `DEMO` is `"true"` and no Plaid credentials are present | Owner request. The reset deletes every table. Production always has Plaid credentials and the demo never does (spec §4), so one mistaken variable can no longer wipe the family's data. |
| 26 | 2026-09-24 | The demo lives at `tally-demo.thesuperhuman.us` (was `demo.thesuperhuman.us`), served as a Workers Custom Domain with `workers.dev` and preview URLs off | Owner request. The name says which app it is, which suits a site that will show more than one project, and it leaves `demo.` free. One public address means one thing to check. |
| 27 | 2026-09-24 | A stored `category_confidence` with no category means "Jev looked and wasn't sure"; the nightly job asks Jev only about transactions with neither | Jev isn't re-asked (and re-billed) about the same transaction every night, only failed calls are retried, and it needs no new column. A person's choice clears the confidence, as it already does. |
| 28 | 2026-09-24 | Jev is still asked all three flags (decision 18), but its income answer isn't stored until the edit panel can change flags (#27); transfer and reimbursement are stored | An income flag takes a transaction out of spending and out of "needs a category", and today a person couldn't undo a wrong one (Greptile, #48). Transfer and reimbursement don't change any numbers until exclusions arrive with #27, which also adds the controls. |
