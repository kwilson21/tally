import { Hono } from "hono";
import { verifiedEmail } from "./access";
import { categorizePending } from "./categorize-pending";
import { todayUtc } from "./dates";
import { canResetDemo, resetDemo } from "./demo/reset";
import { designSystem } from "./routes/design-system";
import { destinations } from "./routes/destinations";
import { health } from "./routes/health";
import { home } from "./routes/home";
import { howItWorks } from "./routes/how-it-works";
import { plaid } from "./routes/plaid";
import { settings } from "./routes/settings";
import { transactions } from "./routes/transactions";
import { sameOrigin, security } from "./security";

type App = { Bindings: Env; Variables: { actor: string } };
const app = new Hono<App>();

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
app.route("/", destinations);
app.route("/", designSystem);

export default {
	fetch: app.fetch,
	async scheduled(_controller, env) {
		// The nightly job. In the demo it restores the seed; production sync is added in Phase 2.
		// "today" here is the UTC date, which is fine for the demo (it only shifts which day's
		// seed is shown); production scheduling is decided in Phase 2.
		if (canResetDemo(env)) {
			await resetDemo(env.DB, todayUtc());
		}
		// Then merchant rules and Jev sort what's uncategorized (spec §7). Without a key it does nothing.
		await categorizePending(env);
	},
} satisfies ExportedHandler<Env>;
