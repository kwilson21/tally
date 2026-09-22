import { Hono } from "hono";
import { health } from "./routes/health";

const app = new Hono<{ Bindings: Env }>();

app.route("/", health);

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
