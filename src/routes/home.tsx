import { Hono } from "hono";
import { Layout } from "../views/layout";

export const home = new Hono<{ Bindings: Env }>();

home.get("/", (c) =>
	c.html(
		<Layout active="home" demo={true}>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				September
			</h1>
			<p class="mt-2 text-muted">The Home screen is built in Phase 1c.</p>
		</Layout>,
	),
);
