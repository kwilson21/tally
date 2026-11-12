# Tally

A budgeting app. My family is the first to use it, and I’m building it for others too.

- **Public demo:** https://tally-demo.thesuperhuman.us (fictional data; resets nightly). Visitors can explore Tally there. My family’s separate instance is private.
- **Design:** [spec](docs/superpowers/specs/2026-09-22-tally-design.md) · [decisions](docs/decisions.md) · [roadmap](ROADMAP.md)

## How it works

One small TypeScript server on Cloudflare builds each page, stores data in a SQLite database (D1), pulls bank data from Plaid, and uses two AI models: Jev for categories and Workers AI for merchant names. Plain code does all the money math.

## Run locally

Node 26 or newer (`.nvmrc`; `nvm use` picks it up) and [pnpm](https://pnpm.io/installation) at exactly the version `package.json` names in `packageManager` (another version stops with an error, decision 204).

    pnpm install
    cp .dev.vars.example .dev.vars   # fill in values; never commit this file
    pnpm run dev

## Checks

    pnpm run typecheck && pnpm run lint && pnpm test

## Deploy the demo

Deploys are manual and done by the owner. The demo is the `demo` mode in `cloudflare.config.ts`: a Worker named `tally-demo`, its own D1 database `tally-demo`, and one address, https://tally-demo.thesuperhuman.us. It has no Plaid secrets.

**Once, before the first deploy.** In the Cloudflare dashboard, open thesuperhuman.us → DNS → Records and search for `tally-demo`. Nothing should be there. The first deploy creates that one record (managed by Cloudflare, pointing at the Worker) and its certificate. Run it in a normal terminal: if a record already exists, Wrangler asks before replacing it, but in a script or CI it replaces it without asking.

    pnpm exec cf auth login
    pnpm exec cf d1 migrations apply ce0d954f-0f85-46bf-9a25-0890c589e383
    APP_VERSION="demo <short sha>" pnpm exec cf deploy --mode demo --message "demo <short sha>"

`cf`'s database commands take the database's ID, not its name: `ce0d954f-0f85-46bf-9a25-0890c589e383` is `tally-demo`, as `cloudflare.config.ts` says.

**The sample data** loads itself: the 09:00 reset below fills an empty database as it does any other. To load it sooner, run that cron once from the Worker's Settings → Triggers page in the Cloudflare dashboard. (In September 2026 the first copy was exported from a local database with Wrangler; that recipe read `wrangler.jsonc`, which decision 205 replaced.)

**Every day at 09:00 UTC** (4–5 am Eastern, 1–2 am Pacific, depending on daylight saving) the demo resets itself to the sample data. Visitors' edits last until the next reset. After the first deploy, the cron shows in the Cloudflare dashboard under Workers → `tally-demo` → Settings → Trigger events.

**After each merge to `main`:** pull `main`, then `APP_VERSION="demo <short sha>" pnpm exec cf deploy --mode demo --message "demo <short sha>"`. If a PR added a migration, run the `migrations apply` line first.

**Check it** on a phone and a laptop: the page loads over HTTPS, Home shows the Rivera household, every nav link works, and the browser console shows no errors.

**Undo.** `pnpm exec wrangler rollback --name tally-demo` puts back the previous version of the code (Wrangler does not read `cloudflare.config.ts`, so it is given the Worker's name). `pnpm exec cf d1 time-travel restore ce0d954f-0f85-46bf-9a25-0890c589e383 --timestamp=<time>` puts back the data as it was at that time. D1 keeps 30 days of history on Workers Paid and 7 days on Workers Free.

## Versions and releases

Each production deploy is a release named by its date, `vYYYY.MM.DD` (a second one the same day adds `.2`), decision 98. Deploys are owner-approved. From a clean checkout of `origin/main`, after `pnpm run build`:

    pnpm exec cf d1 migrations apply 97a4d15e-58a4-4067-b74e-6101195c6493
    APP_VERSION="vYYYY.MM.DD <short sha>" pnpm exec cf deploy --mode production --message "vYYYY.MM.DD <short sha>"

Then publish the release on the same commit, with notes that list the PRs merged since the previous release and the migrations applied:

    git fetch --tags origin
    git log --first-parent --format='- %s' <previous tag>..<sha>
    gh release create vYYYY.MM.DD --target <full sha> --title vYYYY.MM.DD --notes-file <notes>

A demo deploy uses the same message with `demo` in place of the release name, and gets no tag. The `APP_VERSION` in front of the command reaches the code through `cloudflare.config.ts`, which reads it when `cf` loads the file, and feedback reports store it with the build they came from. A deploy without it leaves `APP_VERSION` unset, so set it on every deploy. Before applying migrations, `pnpm exec cf d1 time-travel get-bookmark <database ID>` prints a bookmark to restore to.
