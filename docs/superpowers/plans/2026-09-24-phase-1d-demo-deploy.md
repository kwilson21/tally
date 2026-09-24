# Phase 1d (Demo deploy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** put the demo live at **`https://tally-demo.thesuperhuman.us`**, so the owner can test each merged change from a phone and a laptop without running anything locally. Two small pull requests, in this order:
1. **Part A (#15):** a `demo` Wrangler environment (its own D1 database, its own custom domain, `DEMO="true"`, no Plaid anything), CI proving that config is valid on every PR, and a README section with the owner's deploy steps.
2. **Part B (#14):** the nightly cron that resets the demo to the seed. The reset code already exists (`resetDemo`, `canResetDemo`, decision 25); only the schedule is missing.

**Who does what.** Code and docs come in PRs from Claude. Everything that touches the Cloudflare account is run by the owner: login, creating the database, the deploy that creates the DNS record, and loading the seed (CLAUDE.md: deploys are owner-approved only). No secrets are needed. The demo has no Plaid secrets (spec §4.2), and Jev (#12) isn't built yet. `JEV_API_KEY` gets added with #12.

**Architecture:** the same code deployed a second time. `wrangler deploy --env demo` publishes a Worker named `tally-demo`, bound to a D1 database named `tally-demo`, and served only at `tally-demo.thesuperhuman.us` as a Workers **Custom Domain**. Cloudflare creates that hostname's DNS record and certificate itself during the deploy. The `workers.dev` and preview URLs are turned off, so there's exactly one public address.

**Tech stack:** Wrangler 4.136.3 (already a dev dependency), D1, Cron Triggers. There are no new dependencies and no new runtime code in Part A. Part B is one config line and one test.

**Spec:** §4.1 (two deployments), §4.2 (secrets), §9 (nightly reset), §10 (Time Travel backups), §11 (Phase 1 finish line: "loads over HTTPS, all Phase 1 routes work, no console errors. DNS records are shown to the owner and approved before they're created"). **Issues:** #15 (Part A), #14 (Part B).

**Out of scope, with where each part goes:**
- **Per-PR preview URLs** (testing a PR before it merges): "Deploying automatically from CI" is on the spec's Later list. It needs a Cloudflare API token in GitHub secrets and its own decision entry. It gets proposed separately once this is live.
- **The demo banner, Things to try, and How it works:** #13. Until #13 ships, the URL is live but not announced anywhere (owner choice 4).
- **The `tally-demo-docs` R2 bucket:** nothing uses R2 until documents (Phase 4). It's created then, following "prefer the smallest tool" (owner choice 3).
- **Production:** Phase 2.

**Checked on 2026-09-24 against the installed `wrangler` 4.136.3** (`node_modules/wrangler/config-schema.json` and `wrangler-dist/cli.js`; developers.cloudflare.com is blocked in this environment, so the executor re-checks the Custom Domains and Cron Triggers pages before Task A1):
- **Env config:** `vars` and `d1_databases` are *not inherited* by a named environment ("must be specified in every named environment"), so `env.demo` repeats both. `assets`, `build`, `main` and `compatibility_date` are inherited.
- **Worker name:** with `--env demo` the Worker is named `<name>-<env>`, so it's `tally-demo`.
- **Custom domain syntax:** `routes: [{ "pattern": "tally-demo.thesuperhuman.us", "custom_domain": true }]` (`CustomDomainRoute`: `pattern` and `custom_domain` are required).
- **`workers_dev` and `preview_urls`** are booleans per environment.
- **Crons:** `triggers: { "crons": ["…"] }`.
- **DNS conflict behavior (important for the approval step):** if a DNS record for the hostname already exists, an **interactive** deploy stops and asks: "You already have DNS records that conflict for these Custom Domains … Update them to point to this script instead?" A **non-interactive** deploy (no TTY, as in CI or a piped shell) sets `override_existing_dns_record = true` and **replaces the record without asking**. So the owner runs the first deploy in a normal terminal, after checking the hostname is free (Task A3).
- **Dry run:** `npx wrangler deploy --dry-run --env demo --outdir <dir>` validates the config and bundles without an account or network. It was tried in a scratch copy with a draft `env.demo`. Output: bindings `env.DB (tally-demo)`, `env.ASSETS`, `env.DEMO ("true")`.
- **First seed:** a deployed Worker's scheduled handler can't be triggered by hand the way `wrangler dev`'s `/cdn-cgi/handler/scheduled` can. So the first seed is copied from a local seeded database: `wrangler d1 export DB --local --no-schema --table … --output seed.sql`, then `wrangler d1 execute DB --env demo --remote --file seed.sql`. It was tried locally: the export holds the 5 categories, 3 accounts, 6 budget amounts, 31 merchants and 125 transactions, and starts with `PRAGMA defer_foreign_keys=TRUE`. Without `--table` it also exports `d1_migrations` and `sqlite_sequence`, which would collide with the remote database's own rows, so the export names the app tables explicitly.

---

## Owner review: choices this plan makes

1. **Hostname `tally-demo.thesuperhuman.us`** (owner request), replacing `demo.thesuperhuman.us` in the spec, CLAUDE.md, README and ROADMAP. It's decision 26. It leaves `demo.` free, and names the app in the address, which suits a site that will show more than one project.
2. **Deploys are manual, from `main`, by the owner** (spec §11 "Deploy: manual at first"). After merging a PR, run one command. If you want to try an unmerged PR, you *can* deploy its branch, but the demo then shows unmerged code until the next deploy from `main`.
3. **No R2 bucket yet.** #15's title mentions R2. It's created with documents in Phase 4, when something first uses it.
4. **Not announced until #13.** The URL is public from the first deploy, but nothing links to it until the demo banner and Things to try exist. All the data is fake either way.
5. **The nightly reset runs at 09:00 UTC** (Part B). That's 5 am Eastern and 2 am Pacific, so a visitor's edits last the rest of their day. Change the hour if you prefer.
6. **CI dry-runs the demo config on every PR** (one step in the `check` job), so a broken `env.demo` is caught before the owner deploys.

---

## File structure

| File | Part | Change |
|---|---|---|
| `wrangler.jsonc` | A | Add `env.demo`: routes (custom domain), `workers_dev: false`, `preview_urls: false`, `vars`, `d1_databases` (real `database_id`) |
| `.github/workflows/ci.yml` | A | Add the dry-run step |
| `README.md` | A | "Deploying the demo" section: one-time setup, every deploy, first seed, checks, rollback |
| `docs/decisions.md` | A | Decision 26 (hostname) |
| spec, `CLAUDE.md`, `ROADMAP.md` | A | `demo.thesuperhuman.us` → `tally-demo.thesuperhuman.us` |
| `wrangler.jsonc` | B | `env.demo.triggers.crons: ["0 9 * * *"]` |
| `test/demo-config.test.ts` | B | Pins the demo's safety invariants (see B1) |

---

## Part A (#15): the demo environment

### Task A0: Owner creates the database (before the PR)

- [x] **Owner**, in a terminal in the repo (done 2026-09-24; region ENAM, id `ce0d954f-0f85-46bf-9a25-0890c589e383`):
  ```sh
  npx wrangler login
  npx wrangler d1 create tally-demo
  ```
  Paste the printed `database_id` into the chat. It's an identifier, not a secret, and gets committed. Keep the binding name `DB` (the code reads `env.DB`), not the `tally_demo` that Wrangler's printed snippet suggests.
- [ ] Also confirm that `thesuperhuman.us` is a zone in the same Cloudflare account. Custom Domains need the zone there.

### Task A1: Config, CI check, docs

- [ ] Branch from `main`.
- [ ] Add `env.demo` to `wrangler.jsonc`, with a comment on each non-obvious line:
  ```jsonc
  "env": {
  	"demo": {
  		// Served only here; Cloudflare creates the DNS record and certificate on deploy.
  		"routes": [{ "pattern": "tally-demo.thesuperhuman.us", "custom_domain": true }],
  		"workers_dev": false,
  		"preview_urls": false,
  		// vars and d1_databases are not inherited from the top level.
  		"vars": { "DEMO": "true" },
  		"d1_databases": [
  			{ "binding": "DB", "database_name": "tally-demo", "database_id": "<from A0>", "migrations_dir": "migrations" }
  		]
  	}
  }
  ```
  Update the two comments at the top of the file that say "Phase 1d".
- [ ] Add to `ci.yml`, after `npm run build`: `npx wrangler deploy --dry-run --env demo --outdir "$RUNNER_TEMP/demo-dry-run"`. Check that it fails CI when `env.demo` is broken: temporarily delete its `d1_databases`, see it fail, then restore.
- [ ] Decision 26, and the hostname in the spec, CLAUDE.md and ROADMAP. Rename #15 to "Demo environment: D1, deploy, tally-demo.thesuperhuman.us".
- [ ] README "Deploying the demo": the commands from A3 and A4, the checks from A5, and rollback (`npx wrangler rollback --env demo` for code; `npx wrangler d1 time-travel restore tally-demo --env demo --timestamp=…` for data). Also record the Time Travel retention (30 days Paid, 7 Free) that spec §10 asks for.
- [ ] `npm run build && npm run typecheck && npm run lint && npm test`, plus the dry run locally. Open the PR: "Closes #15" is set only after the owner confirms A5, so the PR says "Part of #15" until then.

### Task A2: Owner merges the PR

### Task A3: Owner checks DNS, then deploys (the approval step)

- [ ] **Check that the hostname is free:** Cloudflare dashboard → thesuperhuman.us → DNS → Records → search `tally-demo`. There should be nothing. The deploy will create one record for `tally-demo.thesuperhuman.us`, managed by Cloudflare and pointing at the `tally-demo` Worker. No other record is touched. *This is the record being approved.*
- [ ] From an up-to-date `main`, **in an interactive terminal** (so a conflict would prompt instead of overwriting):
  ```sh
  npx wrangler d1 migrations apply DB --env demo --remote
  npx wrangler deploy --env demo
  ```

### Task A4: Owner loads the first seed

Run this once, on the empty database. After that, the nightly reset (Part B) keeps it fresh.
With `npm run db:migrate:local` done and `npm run dev` running, in a second terminal run this as one command. The `&&`s mean a failed local reset stops everything, so stale local data is never copied (Greptile, #46):
```sh
npm run db:seed:local && \
npx wrangler d1 export DB --local --no-schema --output seed.sql \
  --table categories --table accounts --table budget_amounts --table merchants --table transactions && \
npx wrangler d1 execute DB --env demo --remote --file seed.sql && \
rm seed.sql
```
The executor re-checks this list against the migrations and adds any tables the seed fills by then (balance history, bills). Seed dates are relative to "today", so export and load on the same day.

### Task A5: Checks (the Phase 1 finish line, minus #12 to #14)

The sandbox can't reach thesuperhuman.us (its network policy blocks it), so the owner runs these checks on a phone and a laptop:
- [ ] `https://tally-demo.thesuperhuman.us` loads with a valid certificate. `http://` redirects to `https://`.
- [ ] Home shows the Rivera household, and the band says 12 to categorize.
- [ ] Transactions: search, the month and category chips, Needs category, and Newer/Older all work.
- [ ] The edit sheet (once #45 is merged and deployed): recategorize Local Bakery → toast → Home says 11.
- [ ] Every nav destination loads; no page errors. On a laptop, the browser console shows no errors.
- [ ] `https://tally-demo.<account>.workers.dev` does **not** serve the app.

Then the PR gets "Closes #15".

---

## Part B (#14): the nightly reset

### Task B1: The cron (test first)

- [ ] `test/demo-config.test.ts` reads `wrangler.jsonc` (imported as raw text, with comments stripped, then parsed) and asserts:
  - `env.demo.vars.DEMO === "true"`
  - `env.demo` has no Plaid-related keys anywhere
  - the `DB` binding is `tally-demo`
  - the custom domain is the only route
  - `env.demo.triggers.crons` equals `["0 9 * * *"]`

  It fails until the cron is added. (The executor checks that a raw-text import of `wrangler.jsonc` works under the Workers Vitest pool. If it doesn't, the same checks move into a small `node` script run by CI.)
- [ ] Add `"triggers": { "crons": ["0 9 * * *"] }` to `env.demo` only. The top level stays without crons, so local dev and production are unchanged. Production's sync cron comes in Phase 2.
- [ ] Checks, dry run, and a PR that "Closes #14". After the owner merges and deploys, the next morning's data shows today's dates again. Also check: Cloudflare dashboard → Workers → `tally-demo` → Settings → Trigger events lists the cron.

---

## Risks

| Risk | Guard |
|---|---|
| The deploy overwrites an existing DNS record | A3 checks the hostname first and deploys in an interactive terminal, where a conflict prompts. |
| Demo code reaches real data | The demo binds only `tally-demo`. It has no Plaid secrets, `canResetDemo` refuses whenever Plaid credentials exist, and B1's test pins that `env.demo` has no Plaid keys. |
| A visitor fills the demo with junk | Field lengths are capped (`parseEdit`), and the nightly reset wipes it. Nothing is announced before #13. |
| A bad deploy | `wrangler rollback --env demo` restores the previous version, and D1 Time Travel restores the data. |
