import { Hono } from "hono";
import { Layout } from "../views/layout";
import { SIDEBAR_ITEMS } from "../views/nav";

// Every nav destination resolves inside the shell. A feature's own route replaces its placeholder when it ships.
export const destinations = new Hono<{ Bindings: Env }>();

const MORE_ITEMS = SIDEBAR_ITEMS.filter((item) =>
	["accounts", "documents", "settings"].includes(item.key),
);

// Home and Transactions have their own routes.
for (const item of SIDEBAR_ITEMS.filter(
	(item) => !["home", "transactions"].includes(item.key),
)) {
	destinations.get(item.href, (c) =>
		c.html(
			<Layout
				title={`${item.label} · Tally`}
				active={item.key}
				demo={c.env.DEMO === "true"}
			>
				<h1 class="font-serif text-5xl font-semibold tracking-tight">
					{item.label}
				</h1>
				<p class="mt-2 text-muted">This part of Tally isn't built yet.</p>
			</Layout>,
		),
	);
}

destinations.get("/more", (c) =>
	c.html(
		<Layout title="More · Tally" active="more" demo={c.env.DEMO === "true"}>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">More</h1>
			<ul class="mt-6 divide-y divide-rule border-y border-rule">
				{MORE_ITEMS.map((item) => (
					<li>
						<a
							href={item.href}
							class="flex min-h-11 items-center py-3 text-lg text-ink no-underline"
						>
							{item.label}
						</a>
					</li>
				))}
			</ul>
		</Layout>,
	),
);
