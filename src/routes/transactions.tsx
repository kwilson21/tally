import { type Context, Hono } from "hono";
import { dayLabel, monthLabel, todayUtc } from "../dates";
import {
	type ListRow,
	listTransactions,
	monthsWithTransactions,
	needsCategoryCount,
	PAGE_SIZE,
} from "../db/transactions";
import {
	type Filters,
	filtersToQuery,
	parseFilters,
} from "../transactions/filters";
import { Chip } from "../views/chip";
import { FormField } from "../views/form-field";
import { Icon } from "../views/icons";
import { Layout } from "../views/layout";
import { TransactionRow } from "../views/transaction-row";

type App = { Bindings: Env };
export const transactions = new Hono<App>();

type Category = { id: number; name: string };

/** Consecutive rows that share a date, in list order. */
function byDay(rows: ListRow[]): [string, ListRow[]][] {
	const groups: [string, ListRow[]][] = [];
	for (const row of rows) {
		const last = groups.at(-1);
		if (last && last[0] === row.date) last[1].push(row);
		else groups.push([row.date, [row]]);
	}
	return groups;
}

const pill =
	"min-h-11 rounded-full border border-rule bg-paper px-4 text-base text-ink";

/** The whole Transactions page for these filters. Every htmx swap selects a part of this same page. */
async function renderList(c: Context<App>, filters: Filters) {
	const today = todayUtc();
	const [{ rows, total, page, pages }, months, needs, categories] =
		await Promise.all([
			listTransactions(c.env.DB, filters),
			monthsWithTransactions(c.env.DB),
			needsCategoryCount(c.env.DB, filters.month),
			c.env.DB.prepare(
				"SELECT id, name FROM categories WHERE archived = 0 ORDER BY sort_order, name",
			).all<Category>(),
		]);

	// Keep the active month in the picker even when it has no transactions.
	if (filters.month !== "all" && !months.includes(filters.month)) {
		months.push(filters.month);
		months.sort().reverse();
	}
	const noun = (n: number) => `transaction${n === 1 ? "" : "s"}`;
	const first = (page - 1) * PAGE_SIZE + 1;
	const count =
		pages > 1
			? `Showing ${first}–${first + rows.length - 1} of ${total} ${noun(total)}`
			: `${total} ${noun(total)}`;
	const pageHref = (n: number) => {
		const query = filtersToQuery({ ...filters, page: n }, today.slice(0, 7));
		return `/transactions${query ? `?${query}` : ""}`;
	};
	// Page links swap only the list's contents and scroll back to its top; the live count says where you are.
	const pageLink = (n: number, rel: "prev" | "next", label: string) => (
		<a
			href={pageHref(n)}
			rel={rel}
			class="inline-flex min-h-11 items-center px-2"
			hx-get={pageHref(n)}
			hx-sync="#filters:replace"
			hx-target="#results"
			hx-select="#results > *"
			hx-select-oob="#result-count:innerHTML"
			hx-swap="innerHTML show:top"
			hx-push-url="true"
		>
			{label}
		</a>
	);

	return c.html(
		<Layout
			title="Transactions · Tally"
			active="transactions"
			demo={c.env.DEMO === "true"}
		>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				Transactions
			</h1>

			{/* Works as a plain GET form; htmx re-requests the same URL and swaps in only the results. */}
			<form
				id="filters"
				method="get"
				action="/transactions"
				class="mt-4 flex flex-col gap-3 lg:max-w-3xl"
				hx-get="/transactions"
				hx-trigger="input delay:300ms, submit"
				// The newest request replaces any in flight, so results always match the controls.
				hx-sync="replace"
				hx-target="#results"
				hx-select="#results > *"
				hx-select-oob="#needs-count:innerHTML, #result-count:innerHTML"
				hx-swap="innerHTML"
				hx-push-url="true"
			>
				<FormField id="q" label="Search transactions" hideLabel>
					{(a11y) => (
						<div class="relative">
							<span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
								<Icon name="search" class="size-5" />
							</span>
							<input
								id="q"
								name="q"
								type="search"
								value={filters.q}
								placeholder="Search transactions"
								autocomplete="off"
								class="min-h-11 w-full rounded-control border border-rule bg-band py-2 pl-10 pr-3 text-lg"
								{...a11y}
							/>
						</div>
					)}
				</FormField>
				<div class="flex flex-wrap gap-2">
					<label for="month" class="sr-only">
						Month
					</label>
					<select id="month" name="month" class={pill}>
						{months.map((m) => (
							<option value={m} selected={filters.month === m}>
								{monthLabel(m, today)}
							</option>
						))}
						<option value="all" selected={filters.month === "all"}>
							All months
						</option>
					</select>
					<label for="category" class="sr-only">
						Category
					</label>
					<select id="category" name="category" class={pill}>
						<option value="">All categories</option>
						{categories.results.map((cat) => (
							<option value={cat.id} selected={filters.category === cat.id}>
								{cat.name}
							</option>
						))}
					</select>
				</div>
				<div class="flex flex-wrap gap-2">
					<Chip
						type="checkbox"
						name="uncategorized"
						value="1"
						checked={filters.uncategorized}
					>
						{/* One span, so the chip's flex gap doesn't split the text around the count. */}
						<span>
							Needs category (<span id="needs-count">{needs}</span>)
						</span>
					</Chip>
					<Chip
						type="checkbox"
						name="excluded"
						value="1"
						checked={filters.excluded}
					>
						Excluded
					</Chip>
				</div>
				{/* With JavaScript, filters apply as you type or pick; without it, this button submits the form. */}
				<noscript>
					<button
						type="submit"
						class="min-h-11 self-start rounded-control bg-ink px-4 text-paper"
					>
						Apply filters
					</button>
				</noscript>
			</form>

			<div id="page" class="lg:max-w-3xl">
				{/* Stays in place while htmx replaces its text, so screen readers announce each new count (spec §8). */}
				<p id="result-count" aria-live="polite" class="mt-4 text-sm text-muted">
					{count}
				</p>
				<section id="results" class="mt-2" aria-label="Results">
					{rows.length === 0 ? (
						<p class="text-muted">
							No transactions match.{" "}
							<a href="/transactions" class="inline-flex min-h-11 items-center">
								Clear filters
							</a>
						</p>
					) : (
						byDay(rows).map(([date, dayRows]) => (
							<>
								<h2 class="mt-3 text-sm text-muted">{dayLabel(date, today)}</h2>
								<ul class="divide-y divide-rule">
									{dayRows.map((row) => (
										<TransactionRow row={row} />
									))}
								</ul>
							</>
						))
					)}
					{pages > 1 && (
						<nav
							aria-label="Pages"
							class="mt-4 flex items-center justify-between border-t border-rule pt-2"
						>
							<span>{page > 1 && pageLink(page - 1, "prev", "Newer")}</span>
							<span class="text-sm text-muted">
								Page {page} of {pages}
							</span>
							<span>{page < pages && pageLink(page + 1, "next", "Older")}</span>
						</nav>
					)}
				</section>
				<div id="sheet" />
			</div>
		</Layout>,
	);
}

// Transactions: search and filter every transaction (spec §8, feature 3).
transactions.get("/transactions", (c) =>
	renderList(
		c,
		parseFilters(new URL(c.req.url).searchParams, todayUtc().slice(0, 7)),
	),
);
