import { type Context, Hono } from "hono";
import { monthLabel, todayUtc } from "../dates";
import {
	addCategory,
	categoryNames,
	moveCategory,
	type SettingsCategory,
	saveCategory,
	setArchived,
	settingsCategories,
} from "../db/categories";
import { centsToInput, formatCents } from "../money";
import {
	type CategoryErrors,
	parseCategory,
	restoreProblem,
} from "../settings/category-form";
import { CategoryIcon } from "../views/category";
import { FormField } from "../views/form-field";
import { Icon } from "../views/icons";
import { Layout } from "../views/layout";

type App = { Bindings: Env };
export const settings = new Hono<App>();

/** "$600" or "$612.50": a budget as the list shows it. */
const amount = (cents: number) =>
	formatCents(cents, { wholeDollars: cents % 100 === 0 });

/** Every form on the page swaps the Categories section in place; without JavaScript it posts normally. */
const swap = (url: string) => ({
	method: "post" as const,
	action: url,
	"hx-post": url,
	"hx-target": "#categories",
	"hx-select": "#categories",
	"hx-swap": "outerHTML",
});

/**
 * A second submit button in a form that posts somewhere else (Archive, Move): `formaction` without
 * JavaScript, and its own htmx request with it. htmx 4 doesn't inherit hx-target, so it's repeated.
 */
const action = (url: string) => ({
	formaction: url,
	"hx-post": url,
	"hx-target": "#categories",
	"hx-select": "#categories",
	"hx-swap": "outerHTML",
});

const summaryClass =
	"flex min-h-11 cursor-pointer list-none items-center gap-4 py-2 [&::-webkit-details-marker]:hidden";
const chevron = (
	<span class="shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none">
		<Icon name="chevron-right" class="size-5" />
	</span>
);
const primary = "min-h-11 rounded-control bg-ink px-5 text-paper";
const secondary =
	"inline-flex min-h-11 items-center justify-center rounded-control border border-ink px-5 text-ink no-underline";

type View = {
	/** The row to show open: a category's id, or "new" for Add category. */
	open?: number | "new";
	/** Move focus here after a swap: a row's summary, or the Archived summary. */
	focus?: number | "archived";
	/** What was typed, shown again with the errors. */
	values?: { name: string; budget: string };
	errors?: CategoryErrors;
	/** Why a restore didn't happen. */
	restoreError?: string;
	/** Why the change didn't happen, shown above the list. */
	listError?: string;
	status?: 200 | 404 | 422;
};

/** The name and budget fields, for adding a category or editing one. */
function CategoryFields({
	idPrefix,
	name,
	budget,
	month,
	errors = {},
}: {
	idPrefix: string;
	name: string;
	budget: string;
	month: string;
	errors?: CategoryErrors;
}) {
	return (
		<div class="grid gap-4 sm:grid-cols-2">
			<FormField id={`${idPrefix}-name`} label="Name" error={errors.name}>
				{(a11y) => (
					<input
						id={`${idPrefix}-name`}
						name="name"
						value={name}
						maxlength={40}
						autocomplete="off"
						autofocus={Boolean(errors.name)}
						class="min-h-11 rounded-control border border-rule bg-band px-3 text-lg"
						{...a11y}
					/>
				)}
			</FormField>
			<FormField
				id={`${idPrefix}-budget`}
				label={`Budget from ${month} on`}
				error={errors.budget}
			>
				{(a11y) => (
					<div class="relative">
						<span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
							$
						</span>
						<input
							id={`${idPrefix}-budget`}
							name="budget"
							value={budget}
							inputmode="decimal"
							autocomplete="off"
							autofocus={!errors.name && Boolean(errors.budget)}
							class="min-h-11 w-full rounded-control border border-rule bg-band py-2 pl-7 pr-3 text-lg"
							{...a11y}
						/>
					</div>
				)}
			</FormField>
		</div>
	);
}

function CategoryRow({
	category: c,
	month,
	view,
	first,
	last,
}: {
	category: SettingsCategory;
	month: string;
	view: View;
	first: boolean;
	last: boolean;
}) {
	const isOpen = view.open === c.id;
	const url = `/settings/categories/${c.id}`;
	return (
		<details class="group border-b border-rule" data-row={c.id} open={isOpen}>
			<summary
				data-category={c.id}
				class={summaryClass}
				autofocus={view.focus === c.id && !view.errors}
			>
				<CategoryIcon icon={c.icon} color={c.color} />
				<span class="min-w-0 truncate text-lg font-medium">{c.name}</span>
				<span class="ml-auto shrink-0 tabular-nums">
					{c.budgetCents === null ? (
						<span class="text-muted">No budget</span>
					) : (
						<>
							{amount(c.budgetCents)}
							<span class="text-muted"> a month</span>
						</>
					)}
				</span>
				{chevron}
			</summary>
			<div class="flex flex-col gap-4 pb-5 sm:pl-11">
				<form class="flex flex-col gap-4" {...swap(url)}>
					<CategoryFields
						idPrefix={`c${c.id}`}
						name={isOpen && view.values ? view.values.name : c.name}
						budget={
							isOpen && view.values
								? view.values.budget
								: c.budgetCents === null
									? ""
									: centsToInput(c.budgetCents)
						}
						month={month}
						errors={isOpen ? view.errors : undefined}
					/>
					<div class="flex flex-wrap items-center gap-3">
						<button type="submit" class={primary}>
							Save
						</button>
						<a
							href="/settings"
							class={secondary}
							// Back to the list with focus on this row, so the change is announced.
							hx-get={`/settings?focus=${c.id}`}
							hx-target="#categories"
							hx-select="#categories"
							hx-swap="outerHTML"
						>
							Cancel
						</a>
						<button
							type="submit"
							class="ml-auto min-h-11 px-2 text-accent"
							{...action(`${url}/archive`)}
						>
							Archive
						</button>
					</div>
					{!(first && last) && (
						<div class="flex flex-wrap gap-2">
							{!first && (
								<button
									type="submit"
									class={`${secondary} gap-2 px-3`}
									{...action(`${url}/move/up`)}
								>
									<Icon name="arrow-up" class="size-4" />
									Move up
								</button>
							)}
							{!last && (
								<button
									type="submit"
									class={`${secondary} gap-2 px-3`}
									{...action(`${url}/move/down`)}
								>
									<Icon name="arrow-down" class="size-4" />
									Move down
								</button>
							)}
						</div>
					)}
				</form>
			</div>
		</details>
	);
}

/** The whole Settings page. Every swap selects #categories from this same page. */
async function renderSettings(c: Context<App>, view: View = {}) {
	const today = todayUtc();
	const thisMonth = today.slice(0, 7);
	const month = monthLabel(thisMonth, today);
	const { active, archived } = await settingsCategories(c.env.DB, thisMonth);
	const adding = view.open === "new";

	return c.html(
		<Layout
			title="Settings · Tally"
			active="settings"
			demo={c.env.DEMO === "true"}
		>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">Settings</h1>
			<section
				id="categories"
				aria-labelledby="categories-title"
				class="mt-8 lg:max-w-3xl"
			>
				<h2 id="categories-title" class="font-serif text-3xl font-semibold">
					Categories
				</h2>
				{view.listError && (
					<p role="alert" class="mt-3 text-sm text-over">
						{view.listError}
					</p>
				)}
				<div class="mt-3 border-t border-rule">
					{active.map((category, i) => (
						<CategoryRow
							category={category}
							month={month}
							view={view}
							first={i === 0}
							last={i === active.length - 1}
						/>
					))}
					<details
						class="group border-b border-rule"
						data-row="new"
						open={adding}
					>
						<summary class={`${summaryClass} text-accent`}>
							<Icon name="plus" class="size-5" />
							Add category
						</summary>
						<form
							class="flex flex-col gap-4 pb-5"
							{...swap("/settings/categories")}
						>
							<CategoryFields
								idPrefix="new"
								name={adding && view.values ? view.values.name : ""}
								budget={adding && view.values ? view.values.budget : ""}
								month={month}
								errors={adding ? view.errors : undefined}
							/>
							<div>
								<button type="submit" class={primary}>
									Add category
								</button>
							</div>
						</form>
					</details>
					{archived.length > 0 && (
						<details
							class="group border-b border-rule"
							open={Boolean(view.restoreError)}
						>
							<summary
								class={summaryClass}
								autofocus={view.focus === "archived"}
							>
								Archived ({archived.length}){chevron}
							</summary>
							{view.restoreError && (
								<p role="alert" class="pb-2 text-sm text-over">
									{view.restoreError}
								</p>
							)}
							<ul class="pb-3">
								{archived.map((a) => (
									<li class="flex min-h-11 items-center gap-4">
										<CategoryIcon icon={a.icon} color={a.color} />
										<span class="text-lg text-muted">{a.name}</span>
										<form
											class="ml-auto"
											{...swap(`/settings/categories/${a.id}/restore`)}
										>
											<button type="submit" class="min-h-11 px-2 text-accent">
												Restore
											</button>
										</form>
									</li>
								))}
							</ul>
						</details>
					)}
				</div>
			</section>
		</Layout>,
		view.status ?? 200,
	);
}

/** After a change: htmx gets the updated section with a toast and announcement; plain browsers go back to Settings. */
function done(
	c: Context<App>,
	toast: string,
	announce: string,
	view: View = {},
) {
	if (!c.req.header("HX-Request")) return c.redirect("/settings", 303);
	c.header(
		"HX-Trigger",
		JSON.stringify({ toast: { message: toast, type: "success" }, announce }),
	);
	return renderSettings(c, view);
}

/** "$650 a month from September on", or nothing when the budget wasn't changed. */
const budgetPhrase = (cents: number | null) =>
	cents === null
		? null
		: `${amount(cents)} a month from ${monthLabel(todayUtc().slice(0, 7), todayUtc())} on`;

/** The form again, open, with what was typed and why it wasn't saved. */
function retry(
	c: Context<App>,
	open: number | "new",
	form: FormData,
	errors: CategoryErrors,
) {
	return renderSettings(c, {
		open,
		values: {
			name: String(form.get("name") ?? ""),
			budget: String(form.get("budget") ?? ""),
		},
		errors,
		status: 422,
	});
}

/** The database refused a name that differs only in capitals: someone saved it a moment earlier. */
const nameTaken = (error: unknown) =>
	error instanceof Error && /UNIQUE/.test(error.message);

/**
 * The category was archived, restored or never existed: another screen got there first. The
 * current list comes back with a message, so the section is never swapped for a bare 404.
 */
const gone = (c: Context<App>) =>
	renderSettings(c, {
		listError:
			"That category was changed somewhere else. Here's the current list.",
		status: 404,
	});

const idOf = (c: Context<App>) => Number(c.req.param("id"));
async function find(c: Context<App>) {
	const all = await categoryNames(c.env.DB);
	return { all, category: all.find((x) => x.id === idOf(c)) };
}

// More → Settings (spec §8): the household's categories and their monthly budgets.
// ?open=<id> opens that category's row, so a row can be linked to (and screenshotted).
// ?focus=<id> puts focus on that row after Cancel.
settings.get("/settings", (c) => {
	const id = (key: string) => {
		const n = Number(c.req.query(key));
		return Number.isInteger(n) && n > 0 ? n : undefined;
	};
	return renderSettings(c, { open: id("open"), focus: id("focus") });
});

settings.post("/settings/categories", async (c) => {
	const form = await c.req.formData();
	const parsed = parseCategory(form, await categoryNames(c.env.DB), null);
	if (!parsed.ok) return retry(c, "new", form, parsed.errors);
	let id: number;
	try {
		id = await addCategory(c.env.DB, parsed.value, todayUtc().slice(0, 7));
	} catch (error) {
		if (nameTaken(error))
			return retry(c, "new", form, { name: "That name is taken." });
		throw error;
	}
	const phrase = budgetPhrase(parsed.value.budgetCents);
	return done(
		c,
		`Added ${parsed.value.name}`,
		phrase
			? `Added ${parsed.value.name}, ${phrase}.`
			: `Added ${parsed.value.name}.`,
		{ focus: id },
	);
});

settings.post("/settings/categories/:id{[0-9]+}", async (c) => {
	const { all, category } = await find(c);
	if (!category || category.archived) return gone(c);
	const thisMonth = todayUtc().slice(0, 7);
	const { active } = await settingsCategories(c.env.DB, thisMonth);
	const hasBudget =
		active.find((x) => x.id === category.id)?.budgetCents != null;
	const form = await c.req.formData();
	const parsed = parseCategory(form, all, category.id, hasBudget);
	if (!parsed.ok) return retry(c, category.id, form, parsed.errors);
	try {
		await saveCategory(c.env.DB, category.id, parsed.value, thisMonth);
	} catch (error) {
		if (nameTaken(error))
			return retry(c, category.id, form, { name: "That name is taken." });
		throw error;
	}
	const phrase = budgetPhrase(parsed.value.budgetCents);
	return done(
		c,
		`Saved ${parsed.value.name}`,
		phrase
			? `Saved. ${parsed.value.name} is ${phrase}.`
			: `Saved ${parsed.value.name}.`,
		{ focus: category.id },
	);
});

settings.post("/settings/categories/:id{[0-9]+}/archive", async (c) => {
	const { category } = await find(c);
	if (!category || category.archived) return gone(c);
	await setArchived(c.env.DB, category.id, true);
	return done(
		c,
		`Archived ${category.name}`,
		`Archived ${category.name}. Its transactions keep their category.`,
		// Its row is gone, so focus goes to the Archived list it moved to.
		{ focus: "archived" },
	);
});

settings.post("/settings/categories/:id{[0-9]+}/restore", async (c) => {
	const { all, category } = await find(c);
	if (!category?.archived) return gone(c);
	const problem = restoreProblem(all);
	if (problem) return renderSettings(c, { restoreError: problem, status: 422 });
	await setArchived(c.env.DB, category.id, false);
	return done(c, `Restored ${category.name}`, `Restored ${category.name}.`, {
		focus: category.id,
	});
});

// The direction is in the address, so every way of pressing the button sends it.
settings.post(
	"/settings/categories/:id{[0-9]+}/move/:direction{up|down}",
	async (c) => {
		const { category } = await find(c);
		if (!category || category.archived) return gone(c);
		const direction = c.req.param("direction") === "up" ? "up" : "down";
		await moveCategory(c.env.DB, category.id, direction);
		const { active } = await settingsCategories(
			c.env.DB,
			todayUtc().slice(0, 7),
		);
		const position = active.findIndex((x) => x.id === category.id) + 1;
		return done(
			c,
			`Moved ${category.name}`,
			`Moved ${category.name} ${direction}. It's now ${position} of ${active.length}.`,
			// Stay open, so the same button can be pressed again.
			{ open: category.id, focus: category.id },
		);
	},
);
