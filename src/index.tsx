import { Hono } from "hono";
import { verifiedEmail } from "./access";
import { categorizePending } from "./categorize-pending";
import { DEFAULT_TIME_ZONE, todayIn } from "./dates";
import { canResetDemo, resetDemo } from "./demo/reset";
import { notFoundPage, serverErrorPage } from "./error-pages";
import { injectDiagnosticsScript } from "./feedback/diagnostics";
import type { PlaidEnv } from "./plaid/client";
import { syncAllItems } from "./plaid/sync-all";
import { accounts } from "./routes/accounts";
import { bills } from "./routes/bills";
import { designSystem } from "./routes/design-system";
import { destinations } from "./routes/destinations";
import { feedback, retryFeedback } from "./routes/feedback";
import { health } from "./routes/health";
import { home } from "./routes/home";
import { howItWorks } from "./routes/how-it-works";
import { merchantNames } from "./routes/merchant-names";
import { organize } from "./routes/organize";
import { plaid, enabled as plaidEnabled } from "./routes/plaid";
import { settings } from "./routes/settings";
import { transactions } from "./routes/transactions";
import { trends } from "./routes/trends";
import { webhooks } from "./routes/webhooks";
import { sameOrigin, security } from "./security";
import { suggestMerchantNames } from "./suggest-names-pending";

type AppEnv = Env & {
	FEEDBACK_DIAGNOSTICS_ENABLED?: string;
	FEEDBACK_SCREENSHOT_PREVIEW_ENABLED?: string;
	APP_VERSION?: string;
};
type App = { Bindings: AppEnv; Variables: { actor: string } };
type ScheduledEnv = PlaidEnv & {
	DB: D1Database;
	DEMO?: string;
	JEV_API_KEY?: string;
	/** Workers AI, bound in production and the demo (wrangler.jsonc); local development has none. */
	AI?: Ai;
	FEEDBACK_GITHUB_TOKEN?: string;
	FEEDBACK_DIAGNOSTICS_ENABLED?: string;
	FEEDBACK_SCREENSHOT_PREVIEW_ENABLED?: string;
};
export const app = new Hono<App>();

// The app's own 404 and 500 pages (spec §8.5, decision 72); Hono's plain-text ones never show.
app.notFound(notFoundPage);
app.onError(serverErrorPage);

/**
 * Production runs three times each morning, 20 minutes apart, because D1 allows 1,000 queries in one
 * Worker invocation and a Jev call costs about three of them (the switches read before it and after it,
 * and saving its answer). Each run has the whole limit to itself, and the day's Jev calls still add up
 * to the 500 of decision 56:
 *
 * - 09:00, the sync run (`runScheduled`): syncs every bank, which applies the merchant rules, and retries
 *   feedback. It asks Jev and Workers AI nothing.
 * - 09:20, the first sort run (`runFirstSort`): asks Jev about up to `MAX_CALLS_PER_RUN`, 300.
 * - 09:40, the names and second sort run (`runSecondSort`): makes the night's names, then asks Jev about
 *   what is left, up to 200.
 *
 * The demo has the one 09:00 run, which does all of it: resets, syncs (nothing, it has no Plaid), sorts
 * within 40 calls, names within 100 and retries feedback, far under the limit.
 *
 * The crons stay in this module, not exported: workerd refuses an entry module whose named exports
 * aren't functions (test/entry-exports.test.ts).
 */
const FIRST_SORT_CRON = "20 9 * * *";
const SECOND_SORT_CRON = "40 9 * * *";
const SECOND_SORT_MAX_CALLS = 200;

/**
 * The 09:00 run, and the demo's only one. The demo resets first; production then catches up every
 * healthy Plaid Item. The reset puts the household's time zone back to the default too, so it seeds that
 * zone's date.
 */
export async function runScheduled(
	env: ScheduledEnv,
	fetchImpl?: typeof fetch,
) {
	if (canResetDemo(env)) {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	}
	const synced = await syncAllItems(env, fetchImpl);
	// Production stops here for Jev and names: the 09:20 and 09:40 runs make them, in invocations of their
	// own. This one has synced, at about five queries for each new transaction, so 16 new ones (about 110
	// queries) plus 300 Jev calls (about 900) already go past 1,000. The merchant rules ran at the sync
	// (`afterSync`), so they aren't waiting on Jev.
	if (env.DEMO !== "false") {
		// The demo has no banks, so this pass applies the merchant rules itself (and does when the sync's
		// own step failed). It asks about everything still waiting, not only what the sync brought in, so it
		// doesn't wait on the "as they arrive" switch, and it only spends what's left of today's cap
		// (spec §8.6). Then the names, last, so a long names step can't hold up the sort.
		await categorizePending(env, fetchImpl, {
			rulesApplied: plaidEnabled(env) && !synced.afterSyncFailed,
		});
		await nameMerchants(env);
	}
	await retryFeedback(env, fetchImpl);
}

/**
 * Workers AI suggests names for the bank texts Plaid didn't name (spec §7, §9), while the names switch is
 * on: up to 100 texts at about three queries each. Nothing here changes a name, and a failure never stops
 * what the run does next.
 */
async function nameMerchants(env: ScheduledEnv) {
	try {
		await suggestMerchantNames(env);
	} catch (error) {
		console.error(
			`workers-ai: names step failed ${error instanceof Error ? error.name : "unknown"}`,
		);
	}
}

/**
 * Production's 09:20 run, the first sort (decision 56): Jev asked about up to `MAX_CALLS_PER_RUN`, 300
 * calls and about 900 queries, within what the day's 500 still allows. It never syncs or resets. It
 * applies the merchant rules itself first, which also covers a sync at 09:00 whose own rules step failed.
 */
export async function runFirstSort(
	env: ScheduledEnv,
	fetchImpl?: typeof fetch,
) {
	await categorizePending(env, fetchImpl, { rulesApplied: false });
}

/**
 * Production's 09:40 run, the names and the second sort (decision 56): one run asks Jev about at most
 * `MAX_CALLS_PER_RUN`, so this one asks about what the first sort left, within what's left of the day's
 * cap, and a newly linked bank's backfill is still sorted in a night. It never syncs or resets.
 *
 * It makes the night's names (spec §7) first, so a long names step can't starve the sort. Its own Jev
 * pass asks about at most `SECOND_SORT_MAX_CALLS`: 100 names and 200 calls are about 900 queries, under
 * D1's 1,000 for one invocation, and with the first sort's 300 they still reach the day's 500.
 */
export async function runSecondSort(
	env: ScheduledEnv,
	fetchImpl?: typeof fetch,
) {
	await nameMerchants(env);
	await categorizePending(env, fetchImpl, {
		rulesApplied: false,
		maxCalls: SECOND_SORT_MAX_CALLS,
	});
}

app.use("*", security);
app.use("*", sameOrigin);
app.use("*", async (c, next) => {
	const path = new URL(c.req.url).pathname;
	const publicPath =
		path === "/webhooks/plaid" ||
		path === "/design-system" ||
		path.startsWith("/design-system/") ||
		path.startsWith("/assets/") ||
		path.startsWith("/fonts/") ||
		path.startsWith("/vendor/") ||
		path.startsWith("/js/") ||
		path === "/favicon.svg";
	if (publicPath) return next();
	if (c.env.DEMO === "true") {
		c.set("actor", "demo");
		return next();
	}
	const email = await verifiedEmail(c.req.raw, {
		ACCESS_TEAM_DOMAIN: (c.env as Env & { ACCESS_TEAM_DOMAIN?: string })
			.ACCESS_TEAM_DOMAIN,
		ACCESS_AUD: (c.env as Env & { ACCESS_AUD?: string }).ACCESS_AUD,
	});
	if (!email) return c.text("Sign in through Cloudflare Access.", 403);
	c.set("actor", email);
	return next();
});
// Only inject the first-party, opt-in diagnostics collector when an operator enables it.
// It performs no network requests and stores only a generic error name in sessionStorage.
app.use("*", async (c, next) => {
	await next();
	if (!c.res) return;
	if (
		c.env.DEMO === "true" ||
		c.env.FEEDBACK_DIAGNOSTICS_ENABLED !== "true" ||
		!c.res.headers.get("content-type")?.includes("text/html")
	)
		return;
	const response = c.res;
	const html = await response.text();
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	if (!html.includes("</body>")) {
		c.res = new Response(html, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
		return;
	}
	c.res = new Response(injectDiagnosticsScript(html, true), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
});

app.route("/", health);
app.route("/", home);
app.route("/", howItWorks);
app.route("/", plaid);
app.route("/", organize);
app.route("/", transactions);
app.route("/", trends);
app.route("/", merchantNames);
app.route("/", settings);
app.route("/", accounts);
app.route("/", bills);
app.route("/", destinations);
app.route("/", feedback);
app.route("/", designSystem);
app.route("/", webhooks);

export default {
	fetch: app.fetch,
	async scheduled(controller, env) {
		if (controller.cron === FIRST_SORT_CRON) await runFirstSort(env);
		else if (controller.cron === SECOND_SORT_CRON) await runSecondSort(env);
		else await runScheduled(env);
	},
} satisfies ExportedHandler<Env>;
