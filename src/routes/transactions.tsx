import { type Context, Hono } from "hono";
import { dayLabel, monthLabel, todayUtc } from "../dates";
import {
	LIST_LIMIT,
	type ListRow,
	listTransactions,
	monthsWithTransactions,
	needsCategoryCount,
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
	const thisMonth = today.slice(0, 7);
	const [{ rows, more }, months, needs, categories] = await Promise.all([
		listTransactions(c.env.DB, filters),
		monthsWithTransactions(c.env.DB),
		needsCategoryCount(c.env.DB, filters.month),
		c.env.DB.prepare(
			"SELECT id, name FROM categories WHERE archived = 0 ORDER BY sort_order, name",
		).all<Category>(),
	]);
	const query = filtersToQuery(filters, thisMonth);
	if (!months.includes(thisMonth)) months.unshift(thisMonth);

	if (c.req.header("HX-Request")) {
		const n = rows.length;
		c.header(
			"HX-Trigger",
			JSON.stringify({
				announce: `${more ? "More than " : ""}${n} transaction${n === 1 ? "" : "s"}`,
			}),
		);
	}

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
				hx-target="#results"
				hx-select="#results"
				hx-select-oob="#needs-count"
				hx-swap="outerHTML"
				hx-push-url="true"
			>
				<FormField id="q" label="Search transactions" hideLabel>
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
						/>
					</div>
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
				<button
					type="submit"
					class="sr-only rounded-control bg-ink px-4 text-paper focus:not-sr-only focus:min-h-11"
				>
					Apply filters
				</button>
			</form>

			<div id="page" class="lg:max-w-3xl">
				<section id="results" class="mt-6" aria-label="Results">
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
								<h2 class="mt-4 text-sm text-muted">{dayLabel(date, today)}</h2>
								<ul class="divide-y divide-rule">
									{dayRows.map((row) => (
										<TransactionRow row={row} query={query} />
									))}
								</ul>
							</>
						))
					)}
					{more && (
						<p class="mt-4 text-muted">
							Showing the first {LIST_LIMIT}. Narrow the search to see more.
						</p>
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
