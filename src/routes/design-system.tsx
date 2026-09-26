import { Hono } from "hono";
import { Catalog, SheetSpecimen } from "../design-system/catalog";
import { Layout } from "../views/layout";

export const designSystem = new Hono<{ Bindings: Env }>();

// The catalog exists in the demo and in development, never in production (decision 42).
designSystem.use("/design-system", async (c, next) => {
	if (c.env.DEMO !== "true") return c.notFound();
	await next();
});
designSystem.use("/design-system/*", async (c, next) => {
	if (c.env.DEMO !== "true") return c.notFound();
	await next();
});

designSystem.get("/design-system", (c) =>
	c.html(
		<Layout title="Design system · Tally" demo scripts={["/js/ds.js"]}>
			<Catalog />
		</Layout>,
	),
);

designSystem.get("/design-system/bottom-sheet", (c) =>
	c.html(
		<Layout title="BottomSheet · Design system · Tally" demo>
			<SheetSpecimen />
		</Layout>,
	),
);
