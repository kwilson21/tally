import { Hono } from "hono";
import { Layout } from "../views/layout";
import { type NavKey, SIDEBAR_ITEMS } from "../views/nav";

// Every nav destination resolves inside the shell. A feature's own route replaces its placeholder when it ships.
export const destinations = new Hono<{ Bindings: Env }>();

const MORE_ITEMS = SIDEBAR_ITEMS.filter((item) =>
	["accounts", "settings"].includes(item.key),
);

// Documents is no menu item (decisions 66 and 82), but its address keeps answering inside the shell.
const PLACEHOLDERS: { key?: NavKey; label: string; href: string }[] = [
	...SIDEBAR_ITEMS.filter(
		// Home, Transactions, Trends, Accounts and Settings have their own routes.
		(item) =>
			!["home", "transactions", "trends", "accounts", "settings"].includes(
				item.key,
			),
	),
	{ label: "Documents", href: "/documents" },
];

for (const item of PLACEHOLDERS) {
	destinations.get(item.href, (c) =>
		c.html(
			<Layout
				title={`${item.label} · Tally`}
				active={item.key}
				currentPath={c.req.path + new URL(c.req.url).search}
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

destinations.get("/more", (c) => {
	const items = [
		...MORE_ITEMS,
		{ label: "How Tally works", href: "/how-it-works" },
	];
	return c.html(
		<Layout
			title="More · Tally"
			active="more"
			demo={c.env.DEMO === "true"}
			currentPath={c.req.path + new URL(c.req.url).search}
		>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">More</h1>
			<ul class="mt-6 divide-y divide-rule border-y border-rule">
				{items.map((item) => (
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
	);
});
