import { Hono } from "hono";
import { todayUtc } from "./dates";
import { canResetDemo, resetDemo } from "./demo/reset";
import { destinations } from "./routes/destinations";
import { health } from "./routes/health";
import { home } from "./routes/home";
import { transactions } from "./routes/transactions";
import { security } from "./security";

const app = new Hono<{ Bindings: Env }>();

app.use("*", security);

app.route("/", health);
app.route("/", home);
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
	},
} satisfies ExportedHandler<Env>;
