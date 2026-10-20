import { Hono } from "hono";
import { verifiedAccessIdentity } from "./access";
import { DEFAULT_TIME_ZONE, todayIn } from "./dates";
import { noteHouseholdMember } from "./db/reconnect";
import { canResetDemo, resetDemo } from "./demo/reset";
import { notFoundPage, serverErrorPage } from "./error-pages";
import { injectDiagnosticsScript } from "./feedback/diagnostics";
import { recordNightSync, utcDay } from "./first-tally/night";
import { runReadyEmail } from "./first-tally/ready-email";
import type { PlaidEnv } from "./plaid/client";
import { syncAllItems } from "./plaid/sync-all";
import { runReconnectReminders } from "./reconnect/reminders";
import { accounts } from "./routes/accounts";
import { bills } from "./routes/bills";
import { designSystem } from "./routes/design-system";
import { destinations } from "./routes/destinations";
import { feedback, retryFeedback } from "./routes/feedback";
import { firstPage } from "./routes/first-page";
import { health } from "./routes/health";
import { home } from "./routes/home";
import { howItWorks } from "./routes/how-it-works";
import { organize } from "./routes/organize";
import { plaid } from "./routes/plaid";
import { plans } from "./routes/plans";
import { settings } from "./routes/settings";
import { suggestions } from "./routes/suggestions";
import { transactions } from "./routes/transactions";
import { trends } from "./routes/trends";
import { webhooks } from "./routes/webhooks";
import { sameOrigin, security } from "./security";
import { startSorting } from "./sort-start";

type AppEnv = Env & {
	FEEDBACK_DIAGNOSTICS_ENABLED?: string;
	FEEDBACK_SCREENSHOT_PREVIEW_ENABLED?: string;
	APP_VERSION?: string;
	RESEND_API_KEY?: string;
	EMAIL?: {
		send(message: {
			to: string;
			from: string;
			subject: string;
			html: string;
			text: string;
		}): Promise<unknown>;
	};
};
type App = { Bindings: AppEnv; Variables: { actor: string } };
type ScheduledEnv = PlaidEnv & {
	DB: D1Database;
	DEMO?: string;
	RESEND_API_KEY?: string;
	EMAIL?: {
		send(message: {
			to: string;
			from: string;
			subject: string;
			html: string;
			text: string;
		}): Promise<unknown>;
	};
	JEV_API_KEY?: string;
	/** The sorting Workflow (decision 139): the 09:00 run starts the night's instance. */
	SORT: Env["SORT"];
	FEEDBACK_GITHUB_TOKEN?: string;
	FEEDBACK_DIAGNOSTICS_ENABLED?: string;
	FEEDBACK_SCREENSHOT_PREVIEW_ENABLED?: string;
};

export { SortWorkflow } from "./sort-workflow";
export const app = new Hono<App>();

// The app's own 404 and 500 pages (spec §8.5, decision 72); Hono's plain-text ones never show.
app.notFound(notFoundPage);
app.onError(serverErrorPage);

/**
 * Production runs twice each morning, each its own invocation (decision 139):
 *
 * - 09:00 (`runScheduled`): syncs every bank, which applies the merchant rules, keeps the first night's sync result,
 *   starts the night's Workflow and retries feedback. The Workflow (src/sort-instance.ts) sorts everything waiting in
 *   groups of 25, then makes the night's notes and names, then new-category suggestions, then keeps the first night's
 *   counts, each a step of its own, so none of it shares this invocation's 1,000 D1 queries.
 * - 10:00, reconnect reminders (`runReconnectReminders`), then the first week's ready email (`runReadyEmail`).
 *
 * The demo has the one 09:00 run: it resets, then starts the same Workflow (with no counts) and retries feedback.
 *
 * The crons stay in this module, not exported: workerd refuses an entry module whose named exports aren't functions
 * (test/entry-exports.test.ts). Any other cron, like the local test endpoint's (scripts/e2e.mjs, `npm run
 * db:seed:local`), runs the 09:00 work.
 */
const RECONNECT_EMAIL_CRON = "0 10 * * *";

/**
 * The 09:00 run, and the demo's only one. The demo resets first; production then catches up every
 * healthy Plaid Item. The reset puts the household's time zone back to the default too, so it seeds that
 * zone's date.
 */
export async function runScheduled(
	env: ScheduledEnv,
	fetchImpl?: typeof fetch,
	time?: RunClock,
) {
	await env.DB.prepare("DELETE FROM cash_delete_holds WHERE created_at <= ?")
		.bind(Date.now() - 86_400_000)
		.run();
	if (canResetDemo(env)) {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE), {
			categoryExample: true,
		});
	}
	const synced = await syncAllItems(env, fetchImpl);
	const night = utcDay(clockNow(time));
	// The first night's sync (#586), kept for the night's Workflow to decide. Production only: the demo has no banks.
	if (env.DEMO === "false") {
		await nightStep("sync", () => recordNightSync(env.DB, synced, night));
	}
	// The night's Workflow (decision 139): it sorts everything waiting, then makes the night's names and new-category
	// suggestions, then (production only) keeps the first night's counts for `night`, the day the sync was kept for.
	// It applies the merchant rules itself first, which also covers a sync whose own rules step failed.
	await startSorting(env, { bySync: false, rulesApplied: false, night });
	await retryFeedback(env, fetchImpl);
}

/**
 * Lets a test set the run's clock (the night's UTC day). Production passes nothing: `Date.now`.
 */
type RunClock = {
	now?: () => number;
};

/** The run's clock: a test's, or Date.now in production. */
const clockNow = (time?: RunClock) => (time?.now ?? Date.now)();

/**
 * One of the night's steps (#586). A failure is logged by name and the run goes on, so the night's counts never stop a
 * run's own work.
 */
async function nightStep(name: string, step: () => Promise<void>) {
	try {
		await step();
	} catch (error) {
		console.error(
			`first night: ${name} step failed ${error instanceof Error ? error.name : "unknown"}`,
		);
	}
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
	const identity = await verifiedAccessIdentity(c.req.raw, {
		ACCESS_TEAM_DOMAIN: (c.env as Env & { ACCESS_TEAM_DOMAIN?: string })
			.ACCESS_TEAM_DOMAIN,
		ACCESS_AUD: (c.env as Env & { ACCESS_AUD?: string }).ACCESS_AUD,
	});
	if (!identity) return c.text("Sign in through Cloudflare Access.", 403);
	c.set("actor", identity.email);
	if (c.env.DEMO !== "true" && path !== "/feedback") {
		try {
			await noteHouseholdMember(c.env.DB, identity.email, identity.issuedAt);
		} catch {
			console.error("household member bookkeeping failed");
		}
	}
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
app.route("/", suggestions);
app.route("/", settings);
app.route("/", accounts);
app.route("/", bills);
app.route("/", plans);
app.route("/", destinations);
app.route("/", feedback);
app.route("/", firstPage);
app.route("/", designSystem);
app.route("/", webhooks);

export default {
	fetch: app.fetch,
	async scheduled(controller, env) {
		if (controller.cron === RECONNECT_EMAIL_CRON) {
			await nightStep("reconnect reminders", () => runReconnectReminders(env));
			await nightStep("ready email", () => runReadyEmail(env));
		} else await runScheduled(env);
	},
} satisfies ExportedHandler<Env>;
