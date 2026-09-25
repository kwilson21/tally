import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { dayLabel, monthLabel, todayUtc } from "../dates";
import {
	getTransaction,
	type ListRow,
	listTransactions,
	monthsWithTransactions,
	needsCategoryCount,
	PAGE_SIZE,
	saveEdit,
	type TransactionDetail,
} from "../db/transactions";
import { formatCents } from "../money";
import {
	type Edit,
	type EditErrors,
	parseEdit,
	safeBack,
} from "../transactions/edit";
import {
	type Filters,
	filtersToQuery,
	parseFilters,
} from "../transactions/filters";
import { resultCount } from "../transactions/result-count";
import { BottomSheet } from "../views/bottom-sheet";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { FormField } from "../views/form-field";
import { HowLink } from "../views/how-link";
import { Icon } from "../views/icons";
import { Layout } from "../views/layout";
import { TransactionRow } from "../views/transaction-row";

type App = { Bindings: Env };
export const transactions = new Hono<App>();

type Category = { id: number; name: string; icon: string; color: string };

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

type ListOptions = {
	/** The edit sheet to show over the list. */
	sheet?: (categories: Category[]) => unknown;
	/** After a save: focus this row, or the result count if it left the list. */
	focusId?: number;
	status?: 200 | 404 | 422;
};

/** The list URL for these filters (the edit sheet's "back"). */
function listHref(filters: Filters, thisMonth: string) {
	const query = filtersToQuery(filters, thisMonth);
	return `/transactions${query ? `?${query}` : ""}`;
}

/** The whole Transactions page for these filters. Every htmx swap selects a part of this same page. */
async function renderList(
	c: Context<App>,
	filters: Filters,
	{ sheet, focusId, status = 200 }: ListOptions = {},
) {
	const today = todayUtc();
	const [{ rows, total, page, pages }, months, needs, categories] =
		await Promise.all([
			listTransactions(c.env.DB, filters),
			monthsWithTransactions(c.env.DB),
			needsCategoryCount(c.env.DB, filters.month),
			c.env.DB.prepare(
				"SELECT id, name, icon, color FROM categories WHERE archived = 0 ORDER BY sort_order, name",
			).all<Category>(),
		]);

	// Keep the active month in the picker even when it has no transactions.
	if (filters.month !== "all" && !months.includes(filters.month)) {
		months.push(filters.month);
		months.sort().reverse();
	}
	const first = (page - 1) * PAGE_SIZE + 1;
	// Named even when archived (a bookmarked link can still filter by it), so the count always
	// says which category it is and every change is announced (#56). Only an archived or
	// unknown id needs the extra lookup.
	let categoryName: string | null = null;
	if (filters.category !== null) {
		categoryName =
			categories.results.find((cat) => cat.id === filters.category)?.name ??
			(
				await c.env.DB.prepare("SELECT name FROM categories WHERE id = ?")
					.bind(filters.category)
					.first<{ name: string }>()
			)?.name ??
			`category ${filters.category}`;
	}
	const count = resultCount(
		{ total, first, shown: rows.length, pages },
		filters,
		categoryName,
		today,
	);
	const listQuery = filtersToQuery({ ...filters, page }, today.slice(0, 7));
	const focusCount =
		focusId !== undefined && !rows.some((r) => r.id === focusId);
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
			title={sheet ? "Edit transaction · Tally" : "Transactions · Tally"}
			active="transactions"
			demo={c.env.DEMO === "true"}
		>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				Transactions
			</h1>
			<HowLink section="transactions" demo={c.env.DEMO === "true"} />

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
				<p
					id="result-count"
					aria-live="polite"
					tabindex={focusCount ? -1 : undefined}
					autofocus={focusCount}
					class="mt-4 text-sm text-muted"
				>
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
									{dayRows.map((row) => {
										const href = `/transactions/${row.id}${listQuery ? `?${listQuery}` : ""}`;
										return (
											<TransactionRow
												row={row}
												href={href}
												autofocus={row.id === focusId}
												// Opening swaps in only the sheet, so the list keeps its place.
												attrs={{
													"hx-get": href,
													"hx-target": "#sheet",
													"hx-select": "#sheet",
													"hx-swap": "outerHTML",
													"hx-push-url": "true",
												}}
											/>
										);
									})}
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
				<div id="sheet">{sheet?.(categories.results)}</div>
			</div>
		</Layout>,
		status,
	);
}

// Transactions: search and filter every transaction (spec §8, feature 3).
// Cancelling the edit panel asks for ?focus=<id> so focus returns to that row (the pushed URL stays clean).
transactions.get("/transactions", (c) => {
	const params = new URL(c.req.url).searchParams;
	const focus = Number(params.get("focus"));
	return renderList(c, parseFilters(params, todayUtc().slice(0, 7)), {
		focusId: Number.isInteger(focus) && focus > 0 ? focus : undefined,
	});
});

type SheetProps = {
	tx: TransactionDetail;
	back: string;
	categories: Category[];
	values: Edit;
	errors?: EditErrors;
	demo: boolean;
};

/** The edit panel for one transaction (spec §8): category, merchant rule, name, note. */
function EditSheet({
	tx,
	back,
	categories,
	values,
	errors = {},
	demo,
}: SheetProps) {
	// Closing swaps the list back in and returns focus to this row; the pushed URL stays clean.
	const closeAttrs = {
		"hx-get": `${back}${back.includes("?") ? "&" : "?"}focus=${tx.id}`,
		"hx-target": "#page",
		"hx-select": "#page",
		"hx-swap": "outerHTML",
		"hx-push-url": back,
	};
	const account = `${tx.accountName}${tx.accountMask ? ` ••${tx.accountMask}` : ""}`;
	return (
		<BottomSheet
			labelledBy="edit-title"
			closeHref={back}
			closeAttrs={closeAttrs}
		>
			{tx.rawName !== tx.displayName && (
				<p class="text-sm text-muted">{tx.rawName}</p>
			)}
			<h2
				id="edit-title"
				tabindex={-1}
				autofocus
				// Focused only so screen readers start here; it isn't a control, so no ring.
				class="font-serif text-4xl font-semibold tracking-tight outline-none"
			>
				{tx.displayName}
			</h2>
			<p class="font-serif text-4xl font-semibold">
				{formatCents(tx.amountCents, { signed: true })}
			</p>
			<p class="text-muted">
				{dayLabel(tx.date, todayUtc())} · {account}
			</p>
			{/* Outside the form, so following it never happens by accident mid-edit. */}
			{demo && (
				<p class="flex flex-wrap gap-x-4">
					<HowLink section="categorization" demo={demo} showTopic />
					<HowLink section="exclusions" demo={demo} showTopic />
				</p>
			)}
			<form
				method="post"
				action={`/transactions/${tx.id}`}
				class="mt-4 flex flex-col gap-4 border-t border-rule pt-4"
				hx-post={`/transactions/${tx.id}`}
				// The Needs category count sits in the filter form, outside #page, so update it too.
				hx-select-oob="#needs-count:innerHTML"
				hx-target="#page"
				hx-select="#page"
				hx-swap="outerHTML"
			>
				<input type="hidden" name="back" value={back} />
				<fieldset
					class="flex flex-col gap-2"
					aria-describedby={errors.category ? "category-error" : undefined}
				>
					<legend class="text-base text-ink">Category</legend>
					<div class="flex flex-wrap gap-2">
						{categories.map((cat) => (
							<Chip
								type="radio"
								name="category"
								value={String(cat.id)}
								checked={values.categoryId === cat.id}
								icon={<CategoryIcon icon={cat.icon} color={cat.color} />}
							>
								{cat.name}
							</Chip>
						))}
					</div>
					{tx.categorySource === "jev" && tx.categoryConfidence !== null && (
						<p class="text-sm text-muted">
							Picked by Jev · {Math.round(tx.categoryConfidence * 100)}% sure
						</p>
					)}
					{errors.category && (
						<p id="category-error" role="alert" class="text-sm text-over">
							{errors.category}
						</p>
					)}
				</fieldset>
				<label class="flex min-h-11 items-center gap-3">
					<input
						type="checkbox"
						name="always"
						value="1"
						checked={values.alwaysForMerchant}
						class="size-5"
					/>
					Always use this category for this merchant
				</label>
				<div>
					<label class="flex min-h-11 items-center gap-3">
						<input
							type="checkbox"
							name="excluded"
							value="1"
							checked={values.excluded}
							aria-describedby="excluded-hint"
							class="size-5"
						/>
						Exclude from the budget
					</label>
					<p id="excluded-hint" class="text-sm text-muted">
						An excluded transaction doesn't count toward spending or Safe to
						spend. Transfers and reimbursements start excluded.
					</p>
				</div>
				<FormField id="merchant" label="Merchant name" error={errors.merchant}>
					{(a11y) => (
						<>
							<input
								id="merchant"
								name="merchant"
								value={values.displayName ?? ""}
								placeholder={tx.rawName}
								autocomplete="off"
								class="min-h-11 rounded-control border border-rule bg-paper px-3 text-lg"
								{...a11y}
							/>
							<p class="text-sm text-muted">
								Renames every transaction from this merchant.
							</p>
						</>
					)}
				</FormField>
				<FormField id="note" label="Note" error={errors.note}>
					{(a11y) => (
						<textarea
							id="note"
							name="note"
							rows={2}
							class="rounded-control border border-rule bg-paper px-3 py-2 text-lg"
							{...a11y}
						>
							{values.note ?? ""}
						</textarea>
					)}
				</FormField>
				<div class="mt-2 grid grid-cols-2 gap-3">
					<a
						href={back}
						class="flex min-h-11 items-center justify-center rounded-control border border-ink text-ink no-underline"
						{...closeAttrs}
					>
						Cancel
					</a>
					<button
						type="submit"
						class="min-h-11 rounded-control bg-ink text-paper"
					>
						Save
					</button>
				</div>
			</form>
		</BottomSheet>
	);
}

const filtersFrom = (url: string) =>
	parseFilters(
		new URL(url, "http://tally").searchParams,
		todayUtc().slice(0, 7),
	);

async function notFound(c: Context<App>) {
	return c.html(
		<Layout
			title="Not found · Tally"
			active="transactions"
			demo={c.env.DEMO === "true"}
		>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				Not found
			</h1>
			<p class="mt-2">
				<a href="/transactions" class="inline-flex min-h-11 items-center">
					Back to Transactions
				</a>
			</p>
		</Layout>,
		404,
	);
}

// The edit panel over the list. A real URL: reloading or sharing it keeps the list's filters.
transactions.get("/transactions/:id{[0-9]+}", async (c) => {
	const tx = await getTransaction(c.env.DB, Number(c.req.param("id")));
	if (!tx) return notFound(c);
	const filters = parseFilters(
		new URL(c.req.url).searchParams,
		todayUtc().slice(0, 7),
	);
	const back = listHref(filters, todayUtc().slice(0, 7));
	const values: Edit = {
		categoryId: tx.categoryId,
		alwaysForMerchant: false,
		displayName: tx.merchantName,
		note: tx.note,
		excluded: tx.excluded,
	};
	return renderList(c, filters, {
		sheet: (categories) => (
			<EditSheet
				tx={tx}
				back={back}
				categories={categories}
				values={values}
				demo={c.env.DEMO === "true"}
			/>
		),
	});
});

// Saving the edit panel. htmx gets the updated list back with a toast; plain browsers are redirected to it.
transactions.post("/transactions/:id{[0-9]+}", async (c) => {
	const tx = await getTransaction(c.env.DB, Number(c.req.param("id")));
	if (!tx) return notFound(c);
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	const filters = filtersFrom(back);
	const { results: categories } = await c.env.DB.prepare(
		"SELECT id, name FROM categories WHERE archived = 0",
	).all<{ id: number; name: string }>();
	const parsed = parseEdit(
		form,
		categories.map((cat) => cat.id),
	);

	if (!parsed.ok) {
		const values: Edit = {
			categoryId: Number(form.get("category")) || null,
			alwaysForMerchant: form.get("always") === "1",
			displayName: form.get("merchant")?.toString() ?? null,
			note: form.get("note")?.toString() ?? null,
			excluded: form.get("excluded") === "1",
		};
		return renderList(c, filters, {
			status: 422,
			sheet: (all) => (
				<EditSheet
					tx={tx}
					back={back}
					categories={all}
					values={values}
					errors={parsed.errors}
					demo={c.env.DEMO === "true"}
				/>
			),
		});
	}

	await saveEdit(c.env.DB, tx.id, parsed.value, actor(c.env));
	if (!c.req.header("HX-Request")) return c.redirect(back, 303);

	const name = parsed.value.displayName ?? tx.rawName;
	const category = categories.find(
		(cat) => cat.id === parsed.value.categoryId,
	)?.name;
	const saved = category
		? `Saved. ${name} is now ${category}.`
		: `Saved ${name}.`;
	const exclusion =
		parsed.value.excluded === tx.excluded
			? ""
			: parsed.value.excluded
				? " It's excluded from the budget."
				: " It counts in the budget again.";
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: { message: `Saved ${name}`, type: "success" },
			announce: saved + exclusion,
		}),
	);
	c.header("HX-Push-Url", back);
	return renderList(c, filters, { focusId: tx.id });
});
