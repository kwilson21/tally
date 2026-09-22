import { Hono } from "hono";
import { health } from "./routes/health";
import { home } from "./routes/home";

const app = new Hono<{ Bindings: Env }>();

app.route("/", health);
app.route("/", home);

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
