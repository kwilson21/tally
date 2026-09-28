import { Hono } from "hono";
import { verifiedEmail } from "./access";
import { categorizePending } from "./categorize-pending";
import { todayUtc } from "./dates";
import { canResetDemo, resetDemo } from "./demo/reset";
import type { PlaidEnv } from "./plaid/client";
import { syncAllItems } from "./plaid/sync-all";
import { accounts } from "./routes/accounts";
import { designSystem } from "./routes/design-system";
import { destinations } from "./routes/destinations";
import { feedback, retryFeedback } from "./routes/feedback";
import { health } from "./routes/health";
import { home } from "./routes/home";
import { howItWorks } from "./routes/how-it-works";
import { plaid } from "./routes/plaid";
import { settings } from "./routes/settings";
import { transactions } from "./routes/transactions";
import { webhooks } from "./routes/webhooks";
import { sameOrigin, security } from "./security";

type App = { Bindings: Env; Variables: { actor: string } };
type ScheduledEnv = PlaidEnv & {
	DB: D1Database;
	DEMO?: string;
	JEV_API_KEY?: string;
	FEEDBACK_GITHUB_TOKEN?: string;
};
export const app = new Hono<App>();

export async function runScheduled(
	env: ScheduledEnv,
	fetchImpl?: typeof fetch,
) {
	// The nightly job resets the demo first; production then catches up every healthy Plaid Item.
	if (canResetDemo(env)) {
		await resetDemo(env.DB, todayUtc());
	}
	await syncAllItems(env, fetchImpl);
	// Merchant rules and Jev run after sync so newly fetched transactions are sorted tonight.
	await categorizePending(env, fetchImpl);
	await retryFeedback(env, fetchImpl);
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

app.route("/", health);
app.route("/", home);
app.route("/", howItWorks);
app.route("/", plaid);
app.route("/", transactions);
app.route("/", settings);
app.route("/", accounts);
app.route("/", destinations);
app.route("/", feedback);
app.route("/", designSystem);
app.route("/", webhooks);

export default {
	fetch: app.fetch,
	async scheduled(_controller, env) {
		await runScheduled(env);
	},
} satisfies ExportedHandler<Env>;
