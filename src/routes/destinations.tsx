import { Hono } from "hono";
import { addressOf } from "../address";
import { householdToday } from "../dates";
import { accountsByBank, appleCardAccount } from "../db/accounts";
import { suggestionQueue } from "../db/suggestions-queue";
import { Colophon, ContentsList, contentsPlaces } from "../views/contents-list";
import { KeysDetails } from "../views/keys";
import { Layout } from "../views/layout";
import { type NavKey, SIDEBAR_ITEMS } from "../views/nav";

// Every nav destination resolves inside the shell. A feature's own route replaces its placeholder when it ships.
export const destinations = new Hono<{
	Bindings: Env & { APP_VERSION?: string };
}>();

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
				currentPath={addressOf(c)}
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

// More is a contents page (P122 A, decision 111): each place with its icon, what it holds and a live count.
destinations.get("/more", async (c) => {
	const demo = c.env.DEMO === "true";
	const [banks, queue, today, appleCard] = await Promise.all([
		accountsByBank(c.env.DB),
		suggestionQueue(c.env.DB),
		householdToday(c.env.DB),
		appleCardAccount(c.env.DB),
	]);
	return c.html(
		<Layout
			title="More · Tally"
			active="more"
			demo={demo}
			currentPath={addressOf(c)}
		>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">More</h1>
			<ContentsList
				places={contentsPlaces({
					demo,
					banks,
					today,
					toCheck: queue.length,
					appleCard,
				})}
			>
				{/* Below lg the keys' row ends the list (decision 118); from lg the foot of a page has them. */}
				<li class="lg:hidden">
					<KeysDetails row />
				</li>
			</ContentsList>
			<Colophon demo={demo} version={c.env.APP_VERSION} />
		</Layout>,
	);
});
