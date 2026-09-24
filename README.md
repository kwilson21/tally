# Tally

A family budgeting app. It pulls in bank transactions, sorts them into categories with a small AI model, and shows how much is left to spend this month.

- **Demo:** https://tally-demo.thesuperhuman.us (fake data; coming in Phase 1)
- **Design:** [spec](docs/superpowers/specs/2026-09-22-tally-design.md) · [decisions](docs/decisions.md) · [roadmap](ROADMAP.md)

## How it works

One small TypeScript server on Cloudflare builds each page, stores data in a SQLite database (D1), pulls bank data from Plaid, and uses two AI models: Jev for categories and Workers AI for merchant names. Plain code does all the money math.

## Run locally

    npm install
    cp .dev.vars.example .dev.vars   # fill in values; never commit this file
    npm run dev

## Checks

    npm run typecheck && npm run lint && npm test

## Deploy the demo

Deploys are manual and done by the owner. The demo is the `demo` environment in `wrangler.jsonc`: a Worker named `tally-demo`, its own D1 database `tally-demo`, and one address, https://tally-demo.thesuperhuman.us. It has no Plaid secrets.

**Once, before the first deploy.** In the Cloudflare dashboard, open thesuperhuman.us → DNS → Records and search for `tally-demo`. Nothing should be there. The first deploy creates that one record (managed by Cloudflare, pointing at the Worker) and its certificate. Run it in a normal terminal: if a record already exists, Wrangler asks before replacing it, but in a script or CI it replaces it without asking.

    npx wrangler login
    npx wrangler d1 migrations apply DB --env demo --remote
    npx wrangler deploy --env demo

**Once, to load the sample data** into the empty database. Seed dates follow today's date, so this copies a freshly seeded local database. First empty the local database and start the app:

    rm -rf .wrangler/state/v3/d1 && npm run db:migrate:local
    npm run dev                      # leave running

Then, in a second terminal, run this as one command. It stops at the first failure. The `grep` checks that the export really holds transactions, which catches a reset that was skipped (for example when local Plaid credentials are set) because the local database started empty. So stale or empty data is never loaded.

    npm run db:seed:local && \
    npx wrangler d1 export DB --local --no-schema --output seed.sql \
      --table categories --table accounts --table budget_amounts --table merchants --table transactions && \
    grep -q 'INSERT INTO "transactions"' seed.sql && \
    npx wrangler d1 execute DB --env demo --remote --file seed.sql && \
    rm seed.sql

**After each merge to `main`:** pull `main`, then `npx wrangler deploy --env demo`. If a PR added a migration, run the `migrations apply` line first.

**Check it** on a phone and a laptop: the page loads over HTTPS, Home shows the Rivera household, every nav link works, and the browser console shows no errors.

**Undo.** `npx wrangler rollback --env demo` puts back the previous version of the code. `npx wrangler d1 time-travel restore tally-demo --env demo --timestamp=<time>` puts back the data as it was at that time. D1 keeps 30 days of history on Workers Paid and 7 days on Workers Free.
