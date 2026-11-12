import { bindings, defineConfig, exports, triggers } from "cf/config";

// Tally's Worker, once for each place it runs (decision 205). A mode is chosen with `--mode`:
//   no mode      local development and the tests: a local database and no Workers AI
//   demo         the public demo (decision 26), tally-demo.thesuperhuman.us
//   production   the family's app (#23), tally.thesuperhuman.us, behind Cloudflare Access
// Nothing is merged between modes: each case below is the whole configuration for its mode.
// Secrets and Plaid settings are never here: they are set with `wrangler secret put <NAME> --name <worker>`.

// Set once at project start; bump deliberately, never automatically.
const COMPATIBILITY_DATE = "2026-09-22";

// Temporal (dates, time zones) is on by default only from 2026-12-01; we turn it on now.
const COMPATIBILITY_FLAGS = ["temporal"];

const ENTRYPOINT = "./src/index.tsx";

// Sorting runs as a Workflow (decision 139). Names are unique per account, so each mode has its own.
const sortWorkflow = (name: string) =>
	exports.workflow({
		name,
		defaultRetention: {
			successRetention: "3 days",
			errorRetention: "3 days",
		},
	});

// This file is run by Node when cf loads it. The project has no Node types, so the one thing read is declared.
declare const process: { env: { APP_VERSION?: string } };

// The release and commit a deploy is made from (decision 98): `APP_VERSION="v2026.11.12 abc1234" cf deploy ...`.
// Unset, as in local development, the Worker has no APP_VERSION at all.
const version = process.env.APP_VERSION;
const appVersion = version ? bindings.text<string>(version) : undefined;

export default defineConfig((ctx) => {
	switch (ctx.mode) {
		case "demo": {
			return {
				worker: {
					name: "tally-demo",
					compatibilityDate: COMPATIBILITY_DATE,
					compatibilityFlags: COMPATIBILITY_FLAGS,
					entrypoint: ENTRYPOINT,
					// Served only at its custom domain. Cloudflare creates the DNS record and certificate on deploy.
					workersDev: false,
					previewUrls: false,
					domains: ["tally-demo.thesuperhuman.us"],
					// The nightly reset (spec §9), demo only, which also sorts and names in the one run. 09:00 UTC is 4–5 am
					// Eastern and 1–2 am Pacific, depending on daylight saving.
					triggers: [triggers.scheduled({ schedule: "0 9 * * *" })],
					env: {
						// "true" shows the demo banner and lets the nightly job reset the data.
						DEMO: bindings.text<string>("true"),
						APP_VERSION: appVersion,
						DB: bindings.d1({
							name: "tally-demo",
							id: "ce0d954f-0f85-46bf-9a25-0890c589e383",
						}),
						SORT: bindings.workflow({
							name: "tally-demo-sort",
							worker: "tally-demo",
							exportName: "SortWorkflow",
						}),
						// Workers AI suggests merchant names in the demo too (spec §4.1), after each nightly reset.
						AI: bindings.ai({}),
						ASSETS: bindings.assets(),
					},
					exports: { SortWorkflow: sortWorkflow("tally-demo-sort") },
				},
			};
		}

		case "production": {
			return {
				worker: {
					name: "tally-production",
					compatibilityDate: COMPATIBILITY_DATE,
					compatibilityFlags: COMPATIBILITY_FLAGS,
					entrypoint: ENTRYPOINT,
					// Cloudflare Access guards every path but /webhooks/plaid.
					workersDev: false,
					previewUrls: false,
					domains: ["tally.thesuperhuman.us"],
					// Two runs a morning (decision 139): 09:00 the daily catch-up sync (spec §4), at the demo's hour, which then
					// starts the night's Workflow (sort everything waiting, then clear the daily run's wait mark, then names and
					// suggestions) and retries feedback; 10:00 the reconnect reminders, in their own invocation, then the ready
					// email as a backstop. Each minute the ready email alone (decision 146): a new family's email goes out once
					// its person has left the first-week pages. src/index.tsx routes by these exact strings.
					triggers: [
						triggers.scheduled({ schedule: "0 9 * * *" }),
						triggers.scheduled({ schedule: "0 10 * * *" }),
						triggers.scheduled({ schedule: "* * * * *" }),
					],
					env: {
						// Not the demo: no banner, and the nightly reset can never run (decision 25).
						DEMO: bindings.text<string>("false"),
						APP_VERSION: appVersion,
						DB: bindings.d1({
							name: "tally-production",
							id: "97a4d15e-58a4-4067-b74e-6101195c6493",
						}),
						EMAIL: bindings.sendEmail({}),
						SORT: bindings.workflow({
							name: "tally-production-sort",
							worker: "tally-production",
							exportName: "SortWorkflow",
						}),
						// Workers AI suggests merchant names (spec §7, #33), only through src/ai/suggest-name.ts. It needs no
						// secret.
						AI: bindings.ai({}),
						ASSETS: bindings.assets(),
					},
					exports: { SortWorkflow: sortWorkflow("tally-production-sort") },
				},
			};
		}

		default: {
			return {
				worker: {
					name: "tally",
					compatibilityDate: COMPATIBILITY_DATE,
					compatibilityFlags: COMPATIBILITY_FLAGS,
					entrypoint: ENTRYPOINT,
					env: {
						DEMO: bindings.text<string>("true"),
						APP_VERSION: appVersion,
						// A local-only database: the ID is a placeholder that `cf d1 migrations apply --local` accepts
						// (package.json's db:migrate:local names it). Each deployed mode names its own database above.
						DB: bindings.d1({
							name: "tally-local",
							id: "00000000-0000-4000-8000-000000000000",
						}),
						SORT: bindings.workflow({
							name: "tally-sort",
							worker: "tally",
							exportName: "SortWorkflow",
						}),
						// No Workers AI here: an AI binding always runs on Cloudflare's side, so it would make every
						// `pnpm test` and `pnpm run dev` open a remote connection and may incur usage charges. Tests hand the
						// code a fake `AI` instead, and the nightly job skips the step where there is none.
						ASSETS: bindings.assets(),
					},
					exports: { SortWorkflow: sortWorkflow("tally-sort") },
				},
			};
		}
	}
});
