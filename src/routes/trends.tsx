import { Hono } from "hono";
import { householdToday } from "../dates";
import { loadTrends } from "../db/trends";
import { buildTrends } from "../trends";
import { Layout } from "../views/layout";
import { TrendsScreen } from "../views/trends";

export const trends = new Hono<{ Bindings: Env }>();

// Trends (spec §8.3): this month so far against the same days last month, each category's change,
// then what's going well, what's worth a look, and every other category's six months.
// `today` is the household's date, read once (decision 67); a transaction's own date is never converted.
trends.get("/trends", async (c) => {
	const today = await householdToday(c.env.DB);
	const page = buildTrends(await loadTrends(c.env.DB, today));
	return c.html(
		<Layout
			title="Trends · Tally"
			active="trends"
			demo={c.env.DEMO === "true"}
			currentPath={c.req.path + new URL(c.req.url).search}
		>
			<TrendsScreen page={page} />
		</Layout>,
	);
});
