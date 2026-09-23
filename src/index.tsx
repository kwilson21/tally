import { Hono } from "hono";
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
} satisfies ExportedHandler<Env>;
