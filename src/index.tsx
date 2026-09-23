import { Hono } from "hono";
import { resetDemo } from "./demo/reset";
import { destinations } from "./routes/destinations";
import { health } from "./routes/health";
import { home } from "./routes/home";
import { security } from "./security";

const app = new Hono<{ Bindings: Env }>();

app.use("*", security);

app.route("/", health);
app.route("/", home);
app.route("/", destinations);

export default {
	fetch: app.fetch,
	async scheduled(_controller, env) {
		// The nightly job. In the demo it restores the seed; production sync is added in Phase 2.
		if (env.DEMO === "true") {
			await resetDemo(env.DB, new Date().toISOString().slice(0, 10));
		}
	},
} satisfies ExportedHandler<Env>;
