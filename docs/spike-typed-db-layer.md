# Spike: a typed database layer for Tally

Status: spike only. Nothing under `src/` was changed and `package.json` is untouched (the candidates were installed with `--no-save` in a throwaway worktree). The evidence is in `test/spike/*.test.ts` and `spike/`. Versions tested: drizzle-orm 0.45.4 (drizzle-kit 0.31.11), kysely 0.29.8, workers-qb 1.16.0, kysely-d1 0.4.0 (source read only). Run on `main` at b26f7be.

## Results

Pass = the test passes against the real schema in the Workers runtime. Partial = works with part of the query kept as raw SQL.

| # | Test | 1. No library (generator + `q`) | 2. Drizzle | 3. Kysely (compile + `db.batch`) | 4. workers-qb | 5. Prisma |
|---|---|---|---|---|---|---|
| 1 | Describe a real table (CHECK, partial unique index), fail on drift | **Pass**, every table: columns, CHECK lists, indexes (partial or not), FKs, read from SQLite. Drift test fails on a stale copy and on a real `ALTER TABLE`. | **Partial.** `category_suggestions`, `merchants`, `transactions` (58 columns) written by hand and checked by a drift test I wrote; the drift test fails on a wrong schema. The schema file does not drive the database (CHECKs are documentation only). `drizzle-kit pull` on our 68 migrations was **unusable**: it attached all 1,188 CHECKs of the whole database to every table, cut the closing `)` off them, dropped the columns and WHERE of the partial index (`uniqueIndex(...).on()`), and mis-quoted defaults. Partial index on `lower(name)` is expressible by hand. | **Fail.** Types only; erased at build time. No runtime object to compare. | **Fail.** Same, a type only. | Not tested. Docs: no CHECK syntax; partial indexes only behind a Preview flag; expression indexes (`lower(name)`) not supported. |
| 2 | Compare-and-set `UPDATE … WHERE status='pending' RETURNING name` | Pass (unchanged SQL, table name checked, id bound) | Pass (`.get()` gives `undefined` on no match) | Pass (`null` on no match) | Pass | Not tested |
| 3 | `db.batch`, one statement forced to fail | Pass (D1's own batch) | Pass: per-statement results, RETURNING works, a failing statement rolled back the whole batch. `orm.transaction()` rejects on D1 (BEGIN refused) and kept nothing. | Pass by compiling each query and calling `env.DB.batch` ourselves. kysely-d1 0.4.0 `db.transaction()` throws "Transactions are not supported yet." (read from its source). | Pass (`batchExecute`; rollback verified) | Docs: D1 transactions unsupported, array `$transaction` not stated to be atomic. Not tested. |
| 4a | `ON CONFLICT … DO UPDATE` with the settle `CASE` | Pass (unchanged) | Pass, same rows as `SETTLE_SUGGESTION_SQL` on 3 cases; **the CASE stays hand-written SQL** inside `sql\`\`` | Pass, same rows; CASE is raw `sql\`\`` | Pass, same rows; CASE is a `Raw` string | Not tested |
| 4b | `INSERT … SELECT … FROM json_each(?) … ON CONFLICT … WHERE` | Pass; a guard fragment brings its own parameters and the numbering follows, replacing `gate.sql(args.length + 1)` | **Fail in the builder:** `.insert().select()` always lists every column (3 values for 6 columns). Works only as one whole `orm.run(sql\`…\`)`, i.e. fully raw. | **Pass in the builder** (`selectFrom(sql\`json_each(…)\`.as('j'))`, `onConflict … .where`). Needs `WHERE 1` or SQLite reads `ON` as a join, as our original does. | Fail in the builder; works via `qb.raw({query, args})` only | Not tested |
| 5 | Derive a hand-kept list from the schema; fail when a migration adds a column | **Pass.** `SCHEMA.transactions.columns` (58); a test fails after a real `ALTER TABLE … ADD COLUMN`. Also derives the child-first delete order from the foreign keys and ran it on D1. | Pass for `transactions` (`getTableColumns`; drift test fails when the migration and the schema file disagree), but only for tables we describe; each needs hand-writing | **Fail** (no runtime columns) | **Fail** | Not tested |
| 6 | Worker bundle, `wrangler deploy --dry-run --env demo`, a minimal real use | **+3.4 KiB gzip** (772.01 vs 768.51). Mostly the generated schema pulled in by `q.ts`; a real design would export just a table-name list. | **+34.6 KiB gzip** (803.08) | **+67.6 KiB gzip** (836.12) | **+14.5 KiB gzip** (782.96) | Not measured. Docs only say Workers has a 3 MB limit. |

Baseline for the bundle: 3627.14 KiB raw / 768.51 KiB gzip. For comparison decision 170 measured XState at about 79 KiB gzip. Each figure is one measured run with a minimal use of the library; a bigger use may shrink or grow it.

## What the spike found in today's code

- The hand-kept `transactions` export list (`src/settings/export.ts`) has 57 of 58 columns. The one left out is `entry_key`. Nothing records whether that is on purpose, which is the problem.
- `TABLES_CHILD_FIRST` (`src/demo/reset.ts`) does not list `feedback`, `household_settings` or `push_subscriptions`. Nothing in the code says whether that is deliberate. Its order is valid against the foreign keys today.
- Four places match `/UNIQUE/` against `error.message` (`category-suggestions.ts` lines 130 and 502, `categories.ts` 121, `routes/settings.tsx` 1243). Drizzle wraps every driver error as `Failed query: …` and puts the UNIQUE text in `error.cause`, so those four checks would silently stop matching after a conversion.

## Maintenance (from the npm registry; GitHub issues were not read)

- drizzle-orm: stable releases 0.45.0 (2025-12-04), .1, .2 (2026-03-27), .3 (2026-09-21), .4 (2026-10-08); 5 stable in the last 12 months, with a six-month gap. A `1.0.0-beta` line is the active one (beta.22 at the time). Same team ships drizzle-kit and the D1 driver in-package.
- kysely: 20 stable releases in 12 months, last 0.29.8 on 2026-11-01. **Has no D1 dialect of its own.** kysely-d1 (third party, one maintainer): last release 2025-04-19, no transactions. Other D1 dialects exist on npm (for example `@notsplol/kysely-d1`, `@cibule/db-d1`); I did not evaluate them, because compile-and-`db.batch` needs none.
- workers-qb: 1.16.0 on 2026-10-22, 5 stable in 12 months, one main author, zero dependencies, 444 KB installed.
- Prisma: very active (7.10.1, 2026-10-15; 8.0.0-rc in progress). Docs state D1 has no transaction support; not tested here.

## What I did not verify

- Prisma was not run at all; its row is documentation only, from a subagent's fetch of prisma.io (not independently re-read).
- Type safety (compile-time errors for a wrong column) was not tested for any candidate; the tests are runtime. I did not run `tsc` on the spike files.
- Drizzle's 1.0 beta line, `drizzle-kit generate`/`migrate`, and Drizzle relational queries were not tried. `drizzle-kit pull` was run on a local SQLite file built from our migrations, not against D1 over HTTP; the introspection code is shared.
- Full suite, feedback integration, typecheck, lint and the production dry-run were not run, because nothing here changes `src/`. Only the four spike test files were run.
- Nothing was pushed and no PR was opened.

## Recommendation (updated after the owner's answer)

**Drizzle**, as the owner prefers, used for the simple queries; the hard queries stay `sql` fragments inside it. Reasons for the exceptions, both tested: `insert().select()` cannot build the 3-column `INSERT … SELECT … FROM json_each(?)` (it fills every column), and the settle `CASE` is raw SQL either way. The Drizzle schema is written by hand, one table at a time, as each part is converted, and a drift test in CI fails when it stops matching `migrations/*.sql`. The generator and the `q` template from candidate 1 are dropped from the proposal.

## Draft decision (renumber on merge)

| 176 | 2026-11-07 | DRAFT, for the owner to accept or reject, from the typed-database spike: **Tally's simple database queries are written with Drizzle ORM; hard queries stay SQL inside it; migrations stay the source of truth.** Drizzle is added at `drizzle-orm` 0.45.4, pinned exactly (no caret, `npm install --save-exact`); `drizzle-kit` is not used. `src/db/schema.ts` describes the tables, written by hand one table at a time as each part is converted (first `category_suggestions` and `merchants`, then the export and demo-reset lists, which read their column and table names from it). The `migrations/*.sql` files stay the only thing that changes the database. A test in CI reads the live schema in the Workers runtime and fails when `src/db/schema.ts` and the database disagree on a column, its not-null, a CHECK value list or an index (including whether it is partial). `INSERT … SELECT … FROM json_each(?)`, the settle `CASE` and other queries the builder cannot express stay SQL, written with Drizzle's `sql` template so the table and its parameters are still bound. Atomic writes use `orm.batch([...])`, which maps to D1 batch (tested: per-statement results, `RETURNING`, rollback of the whole batch on one failure); `orm.transaction()` is not used because D1 refuses BEGIN. **Rules that go with it:** a duplicate-name check reads the driver error's `error.cause`, because Drizzle wraps every error as "Failed query: …" and the four existing `/UNIQUE/.test(error.message)` checks (`category-suggestions.ts` twice, `categories.ts`, `routes/settings.tsx`) would otherwise stop matching; a query is converted only with its tests passing before and after; `drizzle-kit pull` is not used, since on our migrations it attached every CHECK in the database to every table, cut off their closing parentheses and dropped the partial index. **Costs, accepted:** the schema is described twice (migrations and `src/db/schema.ts`), kept honest by a test, not by generation; the Worker bundle grows by about 35 KiB gzip (768.51 to 803.08 KiB, measured with `npx wrangler deploy --dry-run --env demo`); Drizzle stable releases have slowed (five in 12 months, the active work is on a 1.0 beta not tested here), so the pin is re-checked at each upgrade; hard queries are still SQL strings. | The owner finds raw SQL harder to maintain and prefers a typed builder. The spike (docs/spike-typed-db-layer.md) ran Drizzle against the real schema: compare-and-set with `RETURNING`, batch and rollback, and the settle upsert all match today's behaviour, and a drift test catches a wrong CHECK list, a missing column and a missing index. The two things it cannot do are written into the rule above rather than worked around. |

## Questions for the owner

1. Accept the draft decision above (new dependency `drizzle-orm@0.45.4`, pinned)? Or should I first try the 1.0 beta?
2. Is leaving `entry_key` out of the transactions export on purpose? Are `feedback`, `household_settings` and `push_subscriptions` left out of the demo reset on purpose?
3. May I push this branch and open a docs-only PR for the report and decision (no dependency, no `src/` change), or keep it local until you accept?
