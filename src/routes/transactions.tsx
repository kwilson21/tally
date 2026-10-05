import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { dayLabel, monthLabel, shortDay, todayUtc } from "../dates";
import {
	getTransaction,
	type ListRow,
	listTransactions,
	monthsWithTransactions,
	needsCategoryCount,
	PAGE_SIZE,
	type RefundPurchase,
	refundPurchases,
	removeSplit,
	saveEdit,
	saveSplit,
	type TransactionDetail,
} from "../db/transactions";
import { formatCents } from "../money";
import { type CashValues, parseCash, saveCash } from "../transactions/cash";
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
import { parseSplit } from "../transactions/split";
import { tidyName } from "../transactions/tidy-name";
import { BottomSheet } from "../views/bottom-sheet";
import { Button } from "../views/button";
import { CashForm } from "../views/cash-form";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { EmptyState } from "../views/empty-state";
import { FormField } from "../views/form-field";
import { HowLink } from "../views/how-link";
import { Icon } from "../views/icons";
import { Layout } from "../views/layout";
import { ABOVE_TABS } from "../views/nav";
import { SelectableTransactionRow } from "../views/selectable-transaction-row";
import { SplitForm, SplitLine, type SplitValue } from "../views/split-form";
import { TextInput } from "../views/text-input";
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
	pageTitle?: string;
	selecting?: boolean;
	/** In select mode: the rows to show ticked (back from the Set category sheet, or kept across a list change). */
	checkedIds?: Set<number>;
	selectionError?: string;
	focusHeading?: boolean;
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
	{
		sheet,
		focusId,
		status = 200,
		pageTitle,
		selecting = false,
		checkedIds = new Set<number>(),
		selectionError,
		focusHeading = false,
	}: ListOptions = {},
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
	const allCategorized =
		filters.uncategorized &&
		filters.q === "" &&
		filters.category === null &&
		!filters.excluded;
	const pageHref = (n: number) => {
		const query = filtersToQuery({ ...filters, page: n }, today.slice(0, 7));
		const params = new URLSearchParams(query);
		if (selecting) params.set("select", "1");
		return `/transactions${params.size ? `?${params}` : ""}`;
	};
	// In select mode a list change carries the ticked rows, so the ones still listed stay ticked.
	const includeTicked = selecting
		? { "hx-include": "#selection-form input[name=ids]:checked" }
		: {};
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
			hx-select-oob={LIST_OOB}
			hx-swap="innerHTML show:top"
			hx-push-url="true"
			{...includeTicked}
		>
			{label}
		</a>
	);
	const pageNav = pages > 1 && (
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
	);
	const back = listHref(filters, today.slice(0, 7));
	// Select and Done keep every filter and the page; Done drops only select mode.
	const doneHref = `/transactions${listQuery ? `?${listQuery}` : ""}`;
	const selectHref = `/transactions?${listQuery ? `${listQuery}&` : ""}select=1`;
	// Only rows still in the list stay ticked. With htmx the count is exact; a full page load
	// shows the no-JS hint, and htmx re-counts on load.
	const ticked = rows.filter((row) => !row.isSplit && checkedIds.has(row.id));
	const htmx = c.req.header("HX-Request") === "true";
	const cashHref = `/transactions/cash/new?back=${encodeURIComponent(back)}`;

	return c.html(
		<Layout
			title={
				pageTitle ??
				(sheet ? "Edit transaction · Tally" : "Transactions · Tally")
			}
			active="transactions"
			currentPath={c.req.path + new URL(c.req.url).search}
			demo={c.env.DEMO === "true"}
		>
			<div class="flex items-center justify-between gap-3">
				<h1
					id="transactions-title"
					tabindex={focusHeading ? -1 : undefined}
					autofocus={focusHeading}
					class="font-serif text-5xl font-semibold tracking-tight outline-none"
				>
					Transactions
				</h1>
				{/* Swapped out-of-band on filter and page changes, so it keeps the current filters. */}
				<Button
					id="select-toggle"
					kind="text"
					href={selecting ? doneHref : selectHref}
				>
					{selecting ? "Done" : "Select"}
				</Button>
			</div>
			{selecting && (
				<p class="mt-2 text-sm text-muted">Tap rows to select them.</p>
			)}
			<div class="mt-3">
				{/* Swapped out-of-band on filter and page changes, so its back URL keeps the current filters. */}
				<Button
					id="add-cash"
					kind="secondary"
					href={cashHref}
					class="gap-2"
					hx-get={cashHref}
					hx-target="#sheet"
					hx-select="#sheet"
					hx-swap="outerHTML"
					hx-push-url="true"
				>
					<Icon name="plus" class="size-5" /> Add cash
				</Button>
			</div>
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
				hx-select-oob={`#needs-count:innerHTML, ${LIST_OOB}`}
				hx-swap="innerHTML"
				hx-push-url="true"
				{...includeTicked}
			>
				{selecting && <input type="hidden" name="select" value="1" />}
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
					<Button type="submit" class="self-start px-4">
						Apply filters
					</Button>
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
				{filters.uncategorized && (
					<Button kind="text" href="/transactions/organize">
						Organize by merchant
					</Button>
				)}
				{selecting ? (
					<form
						id="selection-form"
						aria-label="Select transactions"
						method="post"
						class="pb-28"
						hx-get="/transactions/select/count"
						hx-trigger="load, change"
						hx-target="#selected-count"
						hx-swap="innerHTML"
					>
						<input id="selection-back" type="hidden" name="back" value={back} />
						<section id="results" class="mt-2" aria-label="Results">
							{selectionError && (
								<p role="alert" class="my-3 text-sm text-over">
									{selectionError}
								</p>
							)}
							{rows.length === 0 ? (
								<EmptyState
									kind="search"
									sentence="No transactions match these filters."
									hint="Try a wider month, or clear the search."
									action={{ href: "/transactions", label: "Clear filters" }}
								/>
							) : (
								byDay(rows).map(([date, dayRows]) => (
									<>
										<h2 class="mt-3 text-sm text-muted">
											{dayLabel(date, today)}
										</h2>
										<ul class="divide-y divide-rule">
											{dayRows.map((row) =>
												row.isSplit ? (
													<TransactionRow row={row} />
												) : (
													<SelectableTransactionRow
														row={row}
														checked={checkedIds.has(row.id)}
													/>
												),
											)}
										</ul>
									</>
								))
							)}
							{pageNav}
						</section>
						{/* On phones it sits on the tab bar. On desktop it pins to the bottom of the content column:
						    left comes from its place in the page, and the width is the column's (the layout's
						    max-w-6xl less its px-8 sides, w-56 sidebar and gap-10 = 20.5rem, up to max-w-3xl). */}
						<div
							class={`fixed inset-x-0 ${ABOVE_TABS} z-30 border-t border-ink bg-paper px-5 py-3 pl-[calc(1.25rem+var(--safe-area-left))] pr-[calc(1.25rem+var(--safe-area-right))] lg:inset-x-auto lg:bottom-0 lg:w-[min(48rem,calc(min(100%,72rem)-20.5rem))] lg:px-0`}
						>
							<div class="flex flex-wrap items-center gap-2">
								<span
									id="selected-count"
									aria-live="polite"
									class="mr-auto text-lg"
								>
									{htmx
										? selectedLabel(ticked.length)
										: "Choose rows, then an action"}
								</span>
								<SelectionActionButtons
									disabled={htmx && ticked.length === 0}
								/>
							</div>
						</div>
					</form>
				) : (
					<section id="results" class="mt-2" aria-label="Results">
						{rows.length === 0 ? (
							allCategorized ? (
								<EmptyState
									kind="done"
									sentence="Every transaction has a category."
									hint="New ones appear here as they come in."
								/>
							) : (
								<EmptyState
									kind="search"
									sentence="No transactions match these filters."
									hint="Try a wider month, or clear the search."
									action={{ href: "/transactions", label: "Clear filters" }}
								/>
							)
						) : (
							byDay(rows).map(([date, dayRows]) => (
								<>
									<h2 class="mt-3 text-sm text-muted">
										{dayLabel(date, today)}
									</h2>
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
						{pageNav}
					</section>
				)}
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
	const selecting = params.get("select") === "1";
	return renderList(c, parseFilters(params, todayUtc().slice(0, 7)), {
		focusId: Number.isInteger(focus) && focus > 0 ? focus : undefined,
		selecting,
		checkedIds: selecting
			? new Set(parseIds(params.getAll("ids")).slice(0, MAX_SELECTED))
			: undefined,
	});
});

/** What a list change refreshes outside the results, so nothing shows stale filters or ticks. */
const LIST_OOB = [
	"#result-count:innerHTML",
	"#add-cash:outerHTML",
	"#select-toggle:outerHTML",
	"#selection-back:outerHTML",
	"#selected-count:innerHTML",
	"#set-category-selection:outerHTML",
	"#exclude-selection:outerHTML",
].join(", ");

/** Most ids one bulk action takes (D1 binds at most 100 parameters per statement). */
const MAX_SELECTED = 100;
const TOO_MANY = `Select ${MAX_SELECTED} or fewer transactions.`;
const NONE_SELECTED = "Select at least one transaction.";

const selectedLabel = (count: number) => `${count} selected`;

/** Positive whole-number ids, once each; each value may be one id or "1,2,3". */
function parseIds(values: (string | File)[]) {
	const ids = new Set<number>();
	for (const value of values) {
		if (typeof value !== "string") continue;
		for (const part of value.split(",")) {
			const id = /^\d{1,15}$/.test(part.trim()) ? Number(part) : 0;
			if (id > 0) ids.add(id);
		}
	}
	return [...ids];
}

function SelectionActionButtons({
	disabled = false,
	oob = false,
}: {
	disabled?: boolean;
	oob?: boolean;
}) {
	// Only the count fragment's copy swaps itself in out of band; each button's own request
	// keeps its normal swap.
	const oobSwap = oob ? "outerHTML" : undefined;
	return (
		<>
			<Button
				id="set-category-selection"
				kind="secondary"
				type="submit"
				class="px-3"
				formaction="/transactions/select/category"
				formmethod="post"
				disabled={disabled}
				hx-post="/transactions/select/category"
				hx-target="#sheet"
				hx-select="#sheet"
				hx-swap="outerHTML"
				hx-swap-oob={oobSwap}
			>
				Set category
			</Button>
			<Button
				id="exclude-selection"
				kind="secondary"
				type="submit"
				class="px-3"
				formaction="/transactions/select/exclude"
				formmethod="post"
				disabled={disabled}
				hx-post="/transactions/select/exclude"
				hx-target="#main"
				hx-select="#main > *"
				hx-swap="innerHTML"
				hx-swap-oob={oobSwap}
			>
				Exclude
			</Button>
		</>
	);
}

async function selectableIds(db: D1Database, ids: number[]) {
	if (ids.length === 0 || ids.length > MAX_SELECTED) return [];
	const marks = ids.map(() => "?").join(",");
	const rows = await db
		.prepare(
			`SELECT id FROM transactions WHERE is_split = 0 AND id IN (${marks})`,
		)
		.bind(...ids)
		.all<{ id: number }>();
	return rows.results.map((row) => row.id);
}

/** The bar's count (swapped into the live region's text) and its buttons, out of band. */
transactions.get("/transactions/select/count", (c) => {
	const count = parseIds(new URL(c.req.url).searchParams.getAll("ids")).length;
	return c.html(
		<>
			{selectedLabel(count)}
			<SelectionActionButtons disabled={count === 0} oob />
		</>,
	);
});

/** The posted ids, or why they can't be acted on. */
async function postedSelection(c: Context<App>, form: FormData) {
	const posted = parseIds(form.getAll("ids"));
	if (posted.length > MAX_SELECTED) return { ids: [], error: TOO_MANY };
	const ids = await selectableIds(c.env.DB, posted);
	return { ids, error: ids.length === 0 ? NONE_SELECTED : undefined };
}

/** The select-mode list with these rows ticked (Cancel and close on the sheet). */
const selectModeHref = (back: string, ids: number[]) =>
	`${back}${back.includes("?") ? "&" : "?"}select=1${ids.length ? `&ids=${ids.join(",")}` : ""}`;

function SelectCategorySheet({
	ids,
	back,
	categories,
	error,
}: {
	ids: number[];
	back: string;
	categories: Category[];
	error?: string;
}) {
	const cancelHref = selectModeHref(back, ids);
	const alert = error && (
		<p id="select-category-error" role="alert" class="text-sm text-over">
			{error}
		</p>
	);
	return (
		<BottomSheet labelledBy="select-category-title" closeHref={cancelHref}>
			<h2
				id="select-category-title"
				tabindex={-1}
				autofocus
				class="font-serif text-4xl font-semibold tracking-tight outline-none"
			>
				{ids.length ? `Set category for ${ids.length}` : "Set category"}
			</h2>
			{ids.length === 0 ? (
				// Nothing to save: say why, and go back to choosing rows.
				<div class="mt-4 flex flex-col gap-4">
					{alert}
					<Button kind="secondary" href={cancelHref} class="w-full">
						Cancel
					</Button>
				</div>
			) : (
				<form
					method="post"
					action="/transactions/select/category/save"
					class="mt-4 flex flex-col gap-4"
					hx-post="/transactions/select/category/save"
					hx-target="#main"
					hx-select="#main > *"
					hx-swap="innerHTML"
				>
					{ids.map((id) => (
						<input type="hidden" name="ids" value={id} />
					))}
					<input type="hidden" name="back" value={back} />
					<fieldset
						aria-describedby={error ? "select-category-error" : undefined}
					>
						<legend class="mb-2">Category</legend>
						<div class="flex flex-wrap gap-2">
							{categories.map((cat, index) => (
								<Chip
									type="radio"
									name="category"
									value={String(cat.id)}
									required={index === 0}
									icon={<CategoryIcon icon={cat.icon} color={cat.color} />}
								>
									{cat.name}
								</Chip>
							))}
						</div>
						{alert && <div class="mt-2">{alert}</div>}
					</fieldset>
					<div class="grid grid-cols-2 gap-3">
						<Button kind="secondary" href={cancelHref} class="w-full">
							Cancel
						</Button>
						<Button type="submit" class="w-full">
							Save
						</Button>
					</div>
				</form>
			)}
		</BottomSheet>
	);
}

/** The select-mode list with the Set category sheet over it; a problem shows inside the sheet. */
function categorySheet(
	c: Context<App>,
	back: string,
	ids: number[],
	error?: string,
) {
	return renderList(c, filtersFrom(back), {
		selecting: true,
		checkedIds: new Set(ids),
		status: error ? 422 : 200,
		pageTitle: "Set category · Tally",
		sheet: (categories) => (
			<SelectCategorySheet
				ids={ids}
				back={back}
				categories={categories}
				error={error}
			/>
		),
	});
}

transactions.post("/transactions/select/category", async (c) => {
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	const { ids, error } = await postedSelection(c, form);
	return categorySheet(c, back, ids, error);
});

async function finishSelection(c: Context<App>, back: string, message: string) {
	if (!c.req.header("HX-Request")) return c.redirect(back, 303);
	c.header(
		"HX-Trigger",
		JSON.stringify({ toast: { message, type: "success" }, announce: message }),
	);
	// The list is out of select mode, so the address bar is too.
	c.header("HX-Push-Url", back);
	return renderList(c, filtersFrom(back), { focusHeading: true });
}

transactions.post("/transactions/select/category/save", async (c) => {
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	const { ids, error } = await postedSelection(c, form);
	if (error) return categorySheet(c, back, ids, error);
	const category = Number(form.get("category"));
	const cat = Number.isInteger(category)
		? await c.env.DB.prepare(
				"SELECT id,name FROM categories WHERE id=? AND archived=0",
			)
				.bind(category)
				.first<{ id: number; name: string }>()
		: null;
	if (!cat)
		return categorySheet(c, back, ids, "Pick a category from the list.");
	// The same write as the edit panel's category change (saveEdit).
	await c.env.DB.batch(
		ids.map((id) =>
			c.env.DB.prepare(
				"UPDATE transactions SET category_id=?, category_source='user', category_confidence=NULL, split_removed_from_cents=NULL, updated_by=?, updated_at=datetime('now') WHERE id=?",
			).bind(cat.id, actor(c), id),
		),
	);
	const message = `Set ${ids.length} ${ids.length === 1 ? "transaction" : "transactions"} to ${cat.name}.`;
	return finishSelection(c, back, message);
});

transactions.post("/transactions/select/exclude", async (c) => {
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	const { ids, error } = await postedSelection(c, form);
	if (error)
		return renderList(c, filtersFrom(back), {
			selecting: true,
			checkedIds: new Set(ids),
			status: 422,
			selectionError: error,
		});
	// As in the edit panel (saveEdit): a split is one bank transaction, so excluding a part
	// excludes the purchase and all its parts. Rows already excluded keep who excluded them.
	await c.env.DB.batch(
		ids.map((id) =>
			c.env.DB.prepare(
				`UPDATE transactions SET excluded=1, excluded_source='user', updated_by=?2, updated_at=datetime('now')
				WHERE excluded=0 AND (
					id=?1
					OR parent_id=?1
					OR id=(SELECT parent_id FROM transactions WHERE id=?1)
					OR parent_id=(SELECT parent_id FROM transactions WHERE id=?1)
				)`,
			).bind(id, actor(c)),
		),
	);
	return finishSelection(
		c,
		back,
		`Excluded ${ids.length} ${ids.length === 1 ? "transaction" : "transactions"}.`,
	);
});

type SheetProps = {
	tx: TransactionDetail;
	back: string;
	categories: Category[];
	values: Edit;
	errors?: EditErrors;
	demo: boolean;
	deleteConfirm?: boolean;
	refunds?: RefundPurchase[];
};

/** The edit panel for one transaction (spec §8): category, merchant rule, name, note. */
function EditSheet({
	tx,
	back,
	categories,
	values,
	errors = {},
	demo,
	deleteConfirm = false,
	refunds = [],
}: SheetProps) {
	const editHref = `/transactions/${tx.id}${back.includes("?") ? back.slice(back.indexOf("?")) : ""}`;
	// Closing swaps the list back in and returns focus to this row; the pushed URL stays clean.
	const closeAttrs = {
		"hx-get": `${back}${back.includes("?") ? "&" : "?"}focus=${tx.id}`,
		"hx-target": "#page",
		"hx-select": "#page",
		"hx-swap": "outerHTML",
		"hx-push-url": back,
	};
	const account = `${tx.accountName}${tx.accountMask ? ` ••${tx.accountMask}` : ""}`;
	// A refund that follows its purchase counts in that purchase's category, so its own can't be
	// picked until it's unlinked (or the purchase is excluded, when it counts on its own).
	const purchase = refunds.find(
		(p) => p.id === values.refundOfId && !p.excluded,
	);
	const purchaseCategory = categories.find(
		(cat) => cat.id === purchase?.categoryId,
	);
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
			{tx.splitRemovedFromCents != null && tx.categoryId === null && (
				<p role="status" class="text-sm text-over">
					The bank changed this from{" "}
					{formatCents(tx.splitRemovedFromCents, { signed: true })}, so its
					split was removed.
				</p>
			)}
			{tx.countsInMonth && !tx.excluded && (
				<p class="text-muted">
					Counts in{" "}
					{new Intl.DateTimeFormat("en-US", {
						month: "long",
						timeZone: "UTC",
					}).format(new Date(`${tx.countsInMonth}-01T00:00:00Z`))}
				</p>
			)}
			{/* The saved state, near the top, so an excluded transaction says so before any options. */}
			{tx.excluded && (
				<p class="flex items-center gap-2 text-muted">
					<Icon name="transfer" class="size-5" />
					Excluded from the budget
				</p>
			)}
			{/* Outside the form, so following it never happens by accident mid-edit. */}
			{demo && (
				<p>
					<HowLink section="categorization" demo={demo} />
				</p>
			)}
			{tx.parentId === null && !tx.isSplit && !tx.income && (
				<Button
					kind="secondary"
					href={`/transactions/${tx.id}/split?back=${encodeURIComponent(back)}`}
					class="mt-4 w-full"
				>
					Split
				</Button>
			)}
			{tx.isSplit && (
				<form
					method="post"
					action={`/transactions/${tx.id}/split/remove`}
					class="mt-4"
					hx-post={`/transactions/${tx.id}/split/remove`}
					hx-target="#page"
					hx-select="#page"
					hx-swap="outerHTML"
					hx-select-oob="#needs-count:innerHTML"
				>
					<input type="hidden" name="back" value={back} />
					<Button kind="secondary" type="submit" class="w-full">
						Remove split
					</Button>
				</form>
			)}
			<form
				method="post"
				action={`/transactions/${tx.id}`}
				class="mt-4 flex flex-col gap-4 border-t border-rule pt-4"
				hx-post={`/transactions/${tx.id}`}
				hx-disable="findAll button[type=submit]"
				hx-indicator="#edit-save"
				// The Needs category count sits in the filter form, outside #page, so update it too.
				hx-select-oob="#needs-count:innerHTML"
				hx-target="#page"
				hx-select="#page"
				hx-swap="outerHTML"
			>
				<input type="hidden" name="back" value={back} />
				<fieldset
					class="flex flex-col gap-2"
					disabled={purchase !== undefined}
					aria-describedby={errors.category ? "category-error" : undefined}
				>
					<legend class="text-base text-ink">Category</legend>
					<div class="flex flex-wrap gap-2">
						{categories.map((cat) => (
							<Chip
								type="radio"
								name="category"
								value={String(cat.id)}
								checked={
									purchase
										? purchase.categoryId === cat.id
										: values.categoryId === cat.id
								}
								icon={<CategoryIcon icon={cat.icon} color={cat.color} />}
							>
								{cat.name}
							</Chip>
						))}
					</div>
					{purchase && (
						<p class="text-sm text-muted">
							{purchaseCategory
								? `Counts in ${purchaseCategory.name} with the ${shortDay(purchase.date, tx.date)} purchase.`
								: `Counts with the ${shortDay(purchase.date, tx.date)} purchase.`}
						</p>
					)}
					{!purchase &&
						tx.categorySource === "jev" &&
						tx.categoryConfidence !== null && (
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
				{(refunds.length > 0 || tx.refundOfId != null) && (
					<details
						class="group border-t border-rule"
						open={Boolean(errors.refund)}
					>
						<summary class="flex min-h-11 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
							<span class="transition-transform group-open:rotate-90 motion-reduce:transition-none">
								<Icon name="chevron-right" class="size-5" />
							</span>
							This refunds…
						</summary>
						<div class="flex flex-col gap-3 pt-1">
							<p class="text-sm text-muted">
								{tx.displayName} purchases in the last 90 days
							</p>
							<fieldset
								class="flex flex-col gap-3"
								aria-describedby={errors.refund ? "refund-error" : undefined}
							>
								<legend class="sr-only">Purchase this refunds</legend>
								<Chip
									type="radio"
									name="refund_of"
									value=""
									checked={values.refundOfId == null}
								>
									Not linked
								</Chip>
								{refunds.map((p) => (
									<Chip
										type="radio"
										name="refund_of"
										value={String(p.id)}
										checked={values.refundOfId === p.id}
									>
										{shortDay(p.date, tx.date)} · {formatCents(p.amountCents)} ·{" "}
										{p.categoryName ?? "No category"}
									</Chip>
								))}
							</fieldset>
							{errors.refund && (
								<p id="refund-error" role="alert" class="text-sm text-over">
									{errors.refund}
								</p>
							)}
						</div>
					</details>
				)}
				{/* The two things people change most after the category, one tap each (owner's pick C). */}
				<div class="flex flex-wrap gap-2">
					{/* A linked refund has no category of its own to make a rule from. */}
					{!purchase && (
						<Chip
							type="checkbox"
							name="always"
							value="1"
							checked={values.alwaysForMerchant}
						>
							Always for this merchant
						</Chip>
					)}
					<Chip
						type="checkbox"
						name="excluded"
						value="1"
						checked={values.excluded}
					>
						Exclude from budget
					</Chip>
				</div>
				<div class="flex flex-col gap-2 border-t border-rule pt-3">
					<p class="text-base text-ink">Income</p>
					<div class="flex flex-wrap gap-2">
						<Chip
							type="checkbox"
							name="income"
							value="1"
							checked={values.income}
						>
							Count as income
						</Chip>
					</div>
				</div>
				{tx.amountCents < 0 && (
					<div class="flex flex-col gap-2 border-t border-rule pt-3">
						<input type="hidden" name="creditReviewedVisible" value="1" />
						{!tx.creditReviewed && !values.income && (
							<p class="text-sm text-muted">
								This bank credit is held out of spending until you identify it.
							</p>
						)}
						<Chip
							type="checkbox"
							name="creditReviewed"
							value="1"
							checked={values.creditReviewed}
						>
							Reviewed as a refund or other non-income credit
						</Chip>
					</div>
				)}
				{/* Renaming and notes are rarer, so they wait behind one tap. It opens when there's something to
				    see: a note, a typed name that isn't saved yet (after a failed save), or an error. */}
				<details
					class="group border-t border-rule"
					open={Boolean(
						values.note ||
							(values.displayName || null) !== tx.merchantName ||
							errors.merchant ||
							errors.note,
					)}
				>
					<summary class="flex min-h-11 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
						<span class="transition-transform group-open:rotate-90 motion-reduce:transition-none">
							<Icon name="chevron-right" class="size-5" />
						</span>
						Rename or add a note
					</summary>
					<div class="flex flex-col gap-4 pt-2">
						<TextInput
							id="merchant"
							label="Merchant name"
							name="merchant"
							value={values.displayName ?? ""}
							placeholder={tx.rawName}
							autocomplete="off"
							surface="paper"
							hint="Renames every transaction from this merchant."
							error={errors.merchant}
						/>
						<FormField id="note" label="Note" error={errors.note}>
							{({ class: errorClass, ...a11y }) => (
								<textarea
									id="note"
									name="note"
									rows={2}
									class={`rounded-control border border-rule bg-paper px-3 py-2 text-lg ${errorClass ?? ""}`}
									{...a11y}
								>
									{values.note ?? ""}
								</textarea>
							)}
						</FormField>
					</div>
				</details>
				<div class="mt-2 grid grid-cols-2 gap-3">
					<Button href={back} kind="secondary" class="w-full" {...closeAttrs}>
						Cancel
					</Button>
					<Button
						id="edit-save"
						type="submit"
						class="w-full"
						busyLabel="Saving…"
					>
						Save
					</Button>
				</div>
			</form>
			{tx.accountType === "cash" && tx.parentId === null && (
				<form
					method="post"
					action={`/transactions/${tx.id}/delete`}
					class="mt-4"
					hx-post={`/transactions/${tx.id}/delete`}
					hx-target="#page"
					hx-select="#page"
					hx-swap="outerHTML"
				>
					<input type="hidden" name="back" value={back} />
					{deleteConfirm ? (
						<div class="flex items-center gap-3">
							<input type="hidden" name="confirm" value="1" />
							<Button type="submit">Delete this cash entry?</Button>
							{/* Cancel goes back to this entry's edit sheet, not the list. */}
							<Button
								href={editHref}
								kind="text"
								hx-get={editHref}
								hx-target="#page"
								hx-select="#page"
								hx-swap="outerHTML"
							>
								Cancel
							</Button>
						</div>
					) : (
						<Button kind="text" type="submit">
							Delete cash transaction
						</Button>
					)}
				</form>
			)}
		</BottomSheet>
	);
}

const filtersFrom = (url: string) =>
	parseFilters(
		new URL(url, "http://tally").searchParams,
		todayUtc().slice(0, 7),
	);

const cashValues = (form?: FormData): CashValues => ({
	date: form?.get("date")?.toString() ?? todayUtc(),
	amount: form?.get("amount")?.toString() ?? "20.00",
	merchant: form?.get("merchant")?.toString() ?? "",
	category: form?.get("category")?.toString() ?? "",
	note: form?.get("note")?.toString() ?? "",
});

function CashSheet({
	categories,
	values,
	errors,
	back,
}: {
	categories: Category[];
	values: CashValues;
	errors?: import("../transactions/cash").CashErrors;
	back: string;
}) {
	return (
		<BottomSheet labelledBy="cash-title" closeHref={back}>
			<h2
				id="cash-title"
				tabindex={-1}
				autofocus
				class="font-serif text-4xl font-semibold tracking-tight outline-none"
			>
				Add cash spending
			</h2>
			<CashForm
				categories={categories}
				values={values}
				errors={errors}
				today={todayUtc()}
				back={back}
			/>
		</BottomSheet>
	);
}

transactions.get("/transactions/cash/new", (c) => {
	const back = safeBack(
		new URL(c.req.url).searchParams.get("back") ?? undefined,
	);
	return renderList(c, filtersFrom(back), {
		pageTitle: "Add cash · Tally",
		sheet: (categories) => (
			<CashSheet categories={categories} values={cashValues()} back={back} />
		),
	});
});

transactions.post("/transactions/cash", async (c) => {
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	const values = cashValues(form);
	const { results: categories } = await c.env.DB.prepare(
		"SELECT id,name,icon,color FROM categories WHERE archived=0 ORDER BY sort_order,name",
	).all<Category>();
	const parsed = parseCash(
		values,
		todayUtc(),
		categories.map((x) => x.id),
	);
	if (!parsed.ok)
		return renderList(c, filtersFrom(back), {
			pageTitle: "Add cash · Tally",
			status: 422,
			sheet: () => (
				<CashSheet
					categories={categories}
					values={values}
					errors={parsed.errors}
					back={back}
				/>
			),
		});
	await saveCash(c.env.DB, parsed.value, actor(c));
	if (!c.req.header("HX-Request")) return c.redirect(back, 303);
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: { message: `Added ${parsed.value.merchant}`, type: "success" },
			announce: `Added ${formatCents(parsed.value.amountCents)} cash spending at ${parsed.value.merchant}.`,
		}),
	);
	c.header("HX-Push-Url", back);
	return renderList(c, filtersFrom(back));
});

async function notFound(c: Context<App>) {
	return c.html(
		<Layout
			title="Not found · Tally"
			active="transactions"
			currentPath={c.req.path + new URL(c.req.url).search}
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
		income: tx.income,
		creditReviewed: tx.income ? false : tx.creditReviewed,
		refundOfId: tx.refundOfId ?? null,
	};
	const refunds = await refundPurchases(c.env.DB, tx);
	return renderList(c, filters, {
		sheet: (categories) => (
			<EditSheet
				tx={tx}
				back={back}
				categories={categories}
				values={values}
				refunds={refunds}
				demo={c.env.DEMO === "true"}
			/>
		),
	});
});

function SplitSheet({
	tx,
	back,
	categories,
	values,
	error,
}: {
	tx: TransactionDetail;
	back: string;
	categories: Category[];
	values: SplitValue[];
	error?: string;
}) {
	const account = `${tx.accountName}${tx.accountMask ? ` ••${tx.accountMask}` : ""}`;
	return (
		<BottomSheet labelledBy="split-title" closeHref={back}>
			<p class="text-sm text-muted">{tx.rawName}</p>
			<h2
				id="split-title"
				tabindex={-1}
				autofocus={values.length <= 2}
				class="font-serif text-4xl font-semibold outline-none"
			>
				{tx.displayName}
			</h2>
			<p class="font-serif text-4xl font-semibold">
				{formatCents(tx.amountCents, { signed: true })}
			</p>
			<p class="text-muted">
				{dayLabel(tx.date, todayUtc())} · {account}
			</p>
			<SplitForm
				id={tx.id}
				parentCents={tx.amountCents}
				categories={categories}
				values={values}
				back={back}
				error={error}
			/>
		</BottomSheet>
	);
}

async function splitContext(c: Context<App>) {
	const tx = await getTransaction(c.env.DB, Number(c.req.param("id")));
	const categories = await c.env.DB.prepare(
		"SELECT id, name, icon, color FROM categories WHERE archived = 0 ORDER BY sort_order, name",
	).all<Category>();
	return { tx, categories: categories.results };
}

transactions.get("/transactions/:id{[0-9]+}/split", async (c) => {
	const { tx, categories } = await splitContext(c);
	// Income is never split (decision 62's review): no form for it either.
	if (!tx || tx.parentId !== null || tx.income) return notFound(c);
	const back = safeBack(new URL(c.req.url).searchParams.get("back"));
	const filters = filtersFrom(back);
	return renderList(c, filters, {
		sheet: () => (
			<SplitSheet
				tx={tx}
				back={back}
				categories={categories}
				values={[
					{ category: "", amount: "" },
					{ category: "", amount: "" },
				]}
			/>
		),
	});
});

transactions.post("/transactions/:id{[0-9]+}/split/line", async (c) => {
	const tx = await getTransaction(c.env.DB, Number(c.req.param("id")));
	if (!tx) return c.notFound();
	const form = await c.req.formData();
	return c.html(
		<div id="split-line">
			<SplitLine
				parentCents={tx.amountCents}
				amounts={form.getAll("part_amount").map(String)}
			/>
		</div>,
	);
});

transactions.post("/transactions/:id{[0-9]+}/split", async (c) => {
	const { tx, categories } = await splitContext(c);
	if (!tx || tx.parentId !== null) return notFound(c);
	if (tx.income) return c.text("Income transactions cannot be split.", 400);
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	const categoryValues = form.getAll("part_category").map(String);
	const amountValues = form.getAll("part_amount").map(String);
	const values = categoryValues.map((category, i) => ({
		category,
		amount: amountValues[i] ?? "",
	}));
	if (form.get("add") === "1") values.push({ category: "", amount: "" });
	else {
		const parsed = parseSplit(
			categoryValues,
			amountValues,
			tx.amountCents,
			categories.map((cat) => cat.id),
		);
		const result = parsed.ok
			? await saveSplit(c.env.DB, tx.id, parsed.parts, actor(c))
			: null;
		if (result && !result.saved) {
			// Show the bank's new amount, so the next save checks against it.
			const fresh = (await getTransaction(c.env.DB, tx.id)) ?? tx;
			return renderList(c, filtersFrom(back), {
				status: 422,
				sheet: () => (
					<SplitSheet
						tx={fresh}
						back={back}
						categories={categories}
						values={values}
						error="The bank just changed this amount. Check the parts and save again."
					/>
				),
			});
		}
		if (result) {
			if (!c.req.header("HX-Request")) return c.redirect(back, 303);
			const unlinked = unlinkedSentence(result.unlinked);
			c.header(
				"HX-Trigger",
				JSON.stringify({
					toast: {
						message: `Split ${tx.displayName}${unlinked ? `.${unlinked}` : ""}`,
						type: "success",
					},
					announce: `Saved split for ${tx.displayName}.${unlinked}`,
				}),
			);
			c.header("HX-Push-Url", back);
			return renderList(c, filtersFrom(back), { focusId: tx.id });
		}
		return renderList(c, filtersFrom(back), {
			status: 422,
			sheet: () => (
				<SplitSheet
					tx={tx}
					back={back}
					categories={categories}
					values={values}
					error={parsed.ok ? undefined : parsed.error}
				/>
			),
		});
	}
	return renderList(c, filtersFrom(back), {
		sheet: () => (
			<SplitSheet tx={tx} back={back} categories={categories} values={values} />
		),
	});
});

/** What a split change says about refunds it unlinked: " The refund on Sep 26 is no longer linked.", or "" for none. */
function unlinkedSentence(dates: string[]): string {
	const [first] = dates;
	if (first === undefined) return "";
	return dates.length === 1
		? ` The refund on ${shortDay(first, todayUtc())} is no longer linked.`
		: ` ${dates.length} refunds are no longer linked.`;
}

transactions.post("/transactions/:id{[0-9]+}/split/remove", async (c) => {
	const tx = await getTransaction(c.env.DB, Number(c.req.param("id")));
	if (!tx?.isSplit) return notFound(c);
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	const unlinked = unlinkedSentence(
		await removeSplit(c.env.DB, tx.id, actor(c)),
	);
	if (!c.req.header("HX-Request")) return c.redirect(back, 303);
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: {
				message: `Removed split from ${tx.displayName}${unlinked ? `.${unlinked}` : ""}`,
				type: "success",
			},
			announce: `Removed split from ${tx.displayName}.${unlinked}`,
		}),
	);
	c.header("HX-Push-Url", back);
	return renderList(c, filtersFrom(back), { focusId: tx.id });
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
	// "This refunds…": no field leaves the link as it is; an empty one unlinks. A chosen purchase
	// must be one the panel offers (the current link always is).
	const refunds = await refundPurchases(c.env.DB, tx);
	const current = tx.refundOfId ?? null;
	const posted = form.get("refund_of");
	const refundOfId =
		posted === null ? current : posted === "" ? null : Number(posted);
	const refundOk =
		refundOfId === null || refunds.some((p) => p.id === refundOfId);
	// A refund that follows its purchase counts in that purchase's category, so a posted category
	// (and a merchant rule made from it) is ignored.
	if (refundOk && refunds.some((p) => p.id === refundOfId && !p.excluded)) {
		form.delete("category");
		form.delete("always");
	}
	const parsed = parseEdit(
		form,
		categories.map((cat) => cat.id),
	);

	if (!parsed.ok || !refundOk) {
		const values: Edit = {
			categoryId: Number(form.get("category")) || null,
			alwaysForMerchant: form.get("always") === "1",
			displayName: form.get("merchant")?.toString() ?? null,
			note: form.get("note")?.toString() ?? null,
			excluded: form.get("excluded") === "1",
			income: form.get("income") === "1",
			creditReviewed: form.get("creditReviewed") === "1",
			creditReviewedProvided:
				form.get("creditReviewedVisible") === "1" || form.has("creditReviewed"),
			refundOfId,
		};
		const errors: EditErrors = {
			...(parsed.ok ? {} : parsed.errors),
			...(refundOk ? {} : { refund: "Pick a purchase from the list." }),
		};
		return renderList(c, filters, {
			status: 422,
			sheet: (all) => (
				<EditSheet
					tx={tx}
					back={back}
					categories={all}
					values={values}
					refunds={refunds}
					errors={errors}
					demo={c.env.DEMO === "true"}
				/>
			),
		});
	}

	// The link is written only when it changes.
	await saveEdit(
		c.env.DB,
		tx.id,
		{
			...parsed.value,
			refundOfId: refundOfId === current ? undefined : refundOfId,
		},
		actor(c),
	);
	if (!c.req.header("HX-Request")) return c.redirect(back, 303);

	// An unnamed merchant is named by its tidied text, never the raw bank string (#93).
	const name = parsed.value.displayName ?? tidyName(tx.rawName);
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

transactions.post("/transactions/:id{[0-9]+}/delete", async (c) => {
	const tx = await getTransaction(c.env.DB, Number(c.req.param("id")));
	if (tx?.accountType !== "cash" || tx.parentId !== null) return notFound(c);
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	if (form.get("confirm") !== "1") {
		const values: Edit = {
			categoryId: tx.categoryId,
			income: tx.income,
			creditReviewed: tx.creditReviewed,
			alwaysForMerchant: false,
			displayName: tx.merchantName,
			note: tx.note,
			excluded: tx.excluded,
			refundOfId: tx.refundOfId ?? null,
		};
		const refunds = await refundPurchases(c.env.DB, tx);
		return renderList(c, filtersFrom(back), {
			sheet: (categories) => (
				<EditSheet
					tx={tx}
					back={back}
					categories={categories}
					values={values}
					refunds={refunds}
					demo={c.env.DEMO === "true"}
					deleteConfirm
				/>
			),
		});
	}
	await c.env.DB.prepare(
		"DELETE FROM transactions WHERE id=? AND parent_id IS NULL AND account_id IN (SELECT id FROM accounts WHERE type='cash')",
	)
		.bind(tx.id)
		.run();
	if (!c.req.header("HX-Request")) return c.redirect(back, 303);
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: { message: `Deleted ${tx.displayName}`, type: "success" },
			announce: `Deleted cash transaction for ${tx.displayName}.`,
		}),
	);
	c.header("HX-Push-Url", back);
	return renderList(c, filtersFrom(back));
});
