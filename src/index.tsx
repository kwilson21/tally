import { Hono } from "hono";
import { categorizePending } from "./categorize-pending";
import { todayUtc } from "./dates";
import { canResetDemo, resetDemo } from "./demo/reset";
import { destinations } from "./routes/destinations";
import { health } from "./routes/health";
import { home } from "./routes/home";
import { howItWorks } from "./routes/how-it-works";
import { transactions } from "./routes/transactions";
import { sameOrigin, security } from "./security";

const app = new Hono<{ Bindings: Env }>();

app.use("*", security);
app.use("*", sameOrigin);

app.route("/", health);
app.route("/", home);
app.route("/", howItWorks);
app.route("/", transactions);
app.route("/", destinations);

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
