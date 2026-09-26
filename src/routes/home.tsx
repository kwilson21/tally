import { type Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import { statusSentence, summarizeMonth } from "../budget";
import { MAX_BUDGET_CENTS, parseBudgetAmount } from "../budgets/amount";
import { nudgeCents } from "../budgets/nudge";
import { monthName, todayUtc } from "../dates";
import {
	type BudgetCategory,
	budgetCategory,
	lastMonthSpentCents,
	setBudget,
} from "../db/budgets";
import { loadMonth } from "../db/month";
import { centsToAmount, formatCents } from "../money";
import { AdjustLink } from "../views/adjust-link";
import { Band } from "../views/band";
import { BottomSheet } from "../views/bottom-sheet";
import { CategoryIcon } from "../views/category";
import { HowLink } from "../views/how-link";
import { Icon } from "../views/icons";
import { LedgerIllustration } from "../views/illustration";
import { Layout } from "../views/layout";
import { MoneyInput } from "../views/money-input";
import { ProgressRow } from "../views/progress-row";
import { ThingsToTry } from "../views/things-to-try";

type App = { Bindings: Env };
export const home = new Hono<App>();

/** "$650" or "$650.25": a budget as a sentence says it. */
const amount = (cents: number) =>
	formatCents(cents, { wholeDollars: cents % 100 === 0 });

// Opening a budget swaps in only the sheet, so Home keeps its place.
const openAttrs = (href: string) => ({
	"hx-get": href,
	"hx-target": "#sheet",
	"hx-select": "#sheet",
	"hx-swap": "outerHTML",
	"hx-push-url": "true",
});

// Adjust mode (#94): Adjust, Done and each − or + swap Home in place. Taps queue on the body, which
// is never swapped, so rapid taps apply one after another; focus stays on the tapped button by its id.
const adjustAttrs = (href: string) => ({
	id: "adjust-link",
	"hx-get": href,
	"hx-target": "#page",
	"hx-select": "#page",
	"hx-swap": "outerHTML",
	"hx-push-url": "true",
});
const nudgeAttrs = {
	"hx-target": "#page",
	"hx-select": "#page",
	"hx-swap": "outerHTML",
	"hx-sync": "body:queue all",
};

type HomeOptions = {
	/** The budget sheet over Home, drawn with this month's numbers. */
	sheet?: (spentCents: (id: number) => number) => Child;
	/** Move focus to this category's row: after a save, or when the sheet closes. */
	focusId?: number;
	/** Adjust mode: − and + on every budgeted row (#94). */
	adjusting?: boolean;
	/** After a tap reaches a limit, focus goes to the row's other button. */
	nudgeFocus?: { id: number; direction: "up" | "down" };
	status?: 200 | 404 | 422;
};

// Home: what's safe to spend this month, and how each category is doing (spec §8, feature 1).
// Every htmx swap selects a part of this same page.
async function renderHome(
	c: Context<App>,
	{ sheet, focusId, adjusting, nudgeFocus, status = 200 }: HomeOptions = {},
) {
	const month = todayUtc().slice(0, 7);
	const data = await loadMonth(c.env.DB, month);
	// Bills arrive in Phase 3; until then nothing is set aside for them.
	const summary = summarizeMonth({ month, ...data, unpaidDueBillsCents: 0 });
	const looks = new Map(data.categories.map((cat) => [cat.id, cat]));
	const budgeted = new Set(summary.categories.map((cat) => cat.id));
	const notBudgeted = data.categories.filter(
		(cat) => !cat.archived && !budgeted.has(cat.id),
	);
	// Focus goes to the row asked for; if it isn't a link any more (archived on another screen while
	// its sheet was open), to the Budget heading, so focus is never lost.
	const linked = new Set(
		data.categories.filter((cat) => !cat.archived).map((cat) => cat.id),
	);
	const focusHeading = focusId !== undefined && !linked.has(focusId);
	// Adjust is offered when there's a budget it can change: a budgeted category that isn't archived.
	const canAdjust = summary.categories.some((cat) => linked.has(cat.id));
	const { count, spentCents } = summary.uncategorized;
	const needs = `${count} ${count === 1 ? "transaction needs" : "transactions need"} a category`;
	const demo = c.env.DEMO === "true";
	// Counted spending by category, income left out, as Home counts it (spec §6).
	const spent = (id: number) =>
		data.transactions
			.filter((t) => t.categoryId === id && !t.income)
			.reduce((sum, t) => sum + t.amountCents, 0);

	return c.html(
		<Layout active="home" demo={demo}>
			<div id="page">
				{demo && (
					<div class="mb-6">
						<ThingsToTry />
					</div>
				)}
				<h1 class="font-serif text-5xl font-semibold tracking-tight">
					{monthName(month)}
				</h1>
				<HowLink section="budget" demo={demo} />
				<div class="mt-4 flex items-center justify-between gap-6 lg:justify-start lg:gap-12">
					<div>
						<p class="text-lg text-muted">Safe to spend</p>
						<p class="font-serif text-6xl font-semibold tracking-tight lg:text-7xl">
							{formatCents(summary.safeToSpendCents, { wholeDollars: true })}
						</p>
					</div>
					<LedgerIllustration />
				</div>
				<p class="mt-3 font-serif text-lg italic">
					{statusSentence(summary.categories)}
				</p>

				{count > 0 && (
					<div class="mt-6">
						<Band href="/transactions?uncategorized=1">{needs}</Band>
					</div>
				)}

				<section class="mt-8 lg:max-w-2xl" aria-labelledby="budget-title">
					<div class="flex items-baseline justify-between gap-4">
						<h2
							id="budget-title"
							class="font-serif text-3xl font-semibold"
							tabindex={focusHeading ? -1 : undefined}
							autofocus={focusHeading}
						>
							Budget
						</h2>
						{canAdjust && (
							<AdjustLink
								adjusting={adjusting === true}
								attrs={adjustAttrs(adjusting ? "/" : "/?adjust=1")}
							/>
						)}
					</div>
					{(summary.categories.length > 0 || count > 0) && (
						<ul class="mt-2 divide-y divide-rule">
							{summary.categories.map((cat) => {
								// An archived category shows for a month it has spending in (spec §7), but it
								// can't be budgeted, so its row isn't a link.
								const href = looks.get(cat.id)?.archived
									? undefined
									: `/budget/${cat.id}`;
								return (
									<ProgressRow
										name={cat.name}
										icon={looks.get(cat.id)?.icon ?? "list"}
										color={looks.get(cat.id)?.color ?? ""}
										spentCents={cat.spentCents}
										budgetCents={cat.budgetCents}
										href={href}
										attrs={href ? openAttrs(href) : undefined}
										autofocus={cat.id === focusId}
										nudge={
											adjusting && href
												? {
														href: `${href}/nudge`,
														id: `nudge-${cat.id}`,
														attrs: nudgeAttrs,
														focus:
															nudgeFocus?.id === cat.id
																? nudgeFocus.direction
																: undefined,
													}
												: undefined
										}
									/>
								);
							})}
							{count > 0 && (
								<li class="flex items-center gap-4 py-3 text-muted">
									<Icon name="circle-dashed" class="size-7 shrink-0" />
									<span class="flex-1 text-lg">Uncategorized</span>
									<span class="text-lg">
										{formatCents(spentCents, { wholeDollars: true })}
									</span>
								</li>
							)}
						</ul>
					)}
					{notBudgeted.length > 0 && (
						<>
							<h3 class="mt-6 text-sm text-muted">Not budgeted</h3>
							<ul class="divide-y divide-rule">
								{notBudgeted.map((cat) => {
									const href = `/budget/${cat.id}`;
									return (
										<li>
											<a
												href={href}
												autofocus={cat.id === focusId}
												class="flex min-h-11 items-center gap-4 py-2 text-ink no-underline"
												{...openAttrs(href)}
											>
												<CategoryIcon icon={cat.icon} color={cat.color} />
												<span class="min-w-0 flex-1 truncate text-lg">
													{cat.name}
												</span>
												<span class="text-accent">Add a budget</span>
											</a>
										</li>
									);
								})}
							</ul>
						</>
					)}
				</section>
				<div id="sheet">{sheet?.(spent)}</div>
			</div>
		</Layout>,
		status,
	);
}

/** The budget sheet: one amount, from this month on, with the money input's helpers. */
function BudgetSheet({
	category,
	value,
	error,
	spentCents,
	lastMonthCents,
}: {
	category: BudgetCategory;
	value: string;
	error?: string;
	spentCents: number;
	lastMonthCents: number;
}) {
	const month = monthName(todayUtc().slice(0, 7));
	// Closing swaps Home back in with focus on the row, so the change is announced.
	const closeAttrs = {
		"hx-get": `/?focus=${category.id}`,
		"hx-target": "#page",
		"hx-select": "#page",
		"hx-swap": "outerHTML",
		"hx-push-url": "/",
	};
	return (
		<BottomSheet
			labelledBy="budget-sheet-title"
			closeHref="/"
			closeAttrs={closeAttrs}
		>
			<div class="flex items-center gap-3">
				<CategoryIcon icon={category.icon} color={category.color} />
				<h2
					id="budget-sheet-title"
					class="font-serif text-3xl font-semibold"
					tabindex={-1}
				>
					{category.name}
				</h2>
			</div>
			<p class="mt-1 text-muted">
				{/* The same net amount as the Home row: refunds reduce spending (spec §6). */}
				{spentCents < 0
					? `${formatCents(-spentCents)} more refunded than spent in ${month}`
					: `${formatCents(spentCents)} spent so far in ${month}`}
			</p>
			<form
				method="post"
				action={`/budget/${category.id}`}
				class="mt-4 flex flex-col gap-4 border-t border-rule pt-4"
				hx-post={`/budget/${category.id}`}
				hx-target="#page"
				hx-select="#page"
				hx-swap="outerHTML"
			>
				<MoneyInput
					id="budget"
					name="budget"
					label={`Budget from ${month} on`}
					value={value}
					error={error}
					lastMonthCents={lastMonthCents}
					autofocus
				/>
				<div class="mt-2 grid grid-cols-2 gap-3">
					<a
						href="/"
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

const idOf = (c: Context<App>) => Number(c.req.param("id"));
/** The active category a budget route is about, or null. */
async function activeCategory(c: Context<App>) {
	const category = await budgetCategory(
		c.env.DB,
		idOf(c),
		todayUtc().slice(0, 7),
	);
	return category && !category.archived ? category : null;
}

// ?focus=<id> puts focus on that row when the sheet closes.
// ?adjust=1 is Adjust mode (#94).
home.get("/", (c) => {
	const focus = Number(c.req.query("focus"));
	return renderHome(c, {
		focusId: Number.isInteger(focus) && focus > 0 ? focus : undefined,
		adjusting: c.req.query("adjust") === "1",
	});
});

// A category's budget sheet over Home (#66). A real URL: it works without JavaScript and can be linked to.
home.get("/budget/:id{[0-9]+}", async (c) => {
	const category = await activeCategory(c);
	if (!category) return c.notFound();
	const lastMonth = await lastMonthSpentCents(
		c.env.DB,
		category.id,
		todayUtc().slice(0, 7),
	);
	return renderHome(c, {
		sheet: (spent) => (
			<BudgetSheet
				category={category}
				value={
					category.budgetCents === null
						? ""
						: centsToAmount(category.budgetCents)
				}
				spentCents={spent(category.id)}
				lastMonthCents={lastMonth}
			/>
		),
	});
});

// Saving a budget, from this month on (spec §7). htmx gets Home back with a toast; plain browsers are redirected.
home.post("/budget/:id{[0-9]+}", async (c) => {
	const category = await activeCategory(c);
	if (!category) return c.notFound();
	const month = todayUtc().slice(0, 7);
	const typed = String((await c.req.formData()).get("budget") ?? "");
	const parsed = parseBudgetAmount(typed);
	if (!parsed.ok) {
		const lastMonth = await lastMonthSpentCents(c.env.DB, category.id, month);
		return renderHome(c, {
			status: 422,
			sheet: (spent) => (
				<BudgetSheet
					category={category}
					value={typed}
					error={parsed.error}
					spentCents={spent(category.id)}
					lastMonthCents={lastMonth}
				/>
			),
		});
	}
	await setBudget(c.env.DB, category.id, parsed.cents, month);
	if (!c.req.header("HX-Request")) return c.redirect("/", 303);
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: { message: `Saved the ${category.name} budget`, type: "success" },
			announce: `${category.name} is ${amount(parsed.cents)} a month from ${monthName(month)} on.`,
		}),
	);
	c.header("HX-Push-Url", "/");
	return renderHome(c, { focusId: category.id });
});

// One tap in Adjust mode (#94, decision 48): the budget moves to the next round $10, from this month
// on, as the sheet saves it. htmx gets Home back in Adjust mode; plain browsers are redirected there.
home.post("/budget/:id{[0-9]+}/nudge/:direction{up|down}", async (c) => {
	const category = await activeCategory(c);
	// Only a budgeted category has buttons; one without a budget gets it from its sheet.
	if (!category || category.budgetCents === null) return c.notFound();
	const direction = c.req.param("direction") === "up" ? "up" : "down";
	const month = todayUtc().slice(0, 7);
	const cents = nudgeCents(category.budgetCents, direction);
	const moved = cents !== category.budgetCents;
	if (moved) await setBudget(c.env.DB, category.id, cents, month);
	if (!c.req.header("HX-Request")) return c.redirect("/?adjust=1", 303);
	c.header(
		"HX-Trigger",
		JSON.stringify(
			moved
				? {
						toast: {
							message: `${category.name} is ${amount(cents)} a month`,
							type: "success",
						},
						announce: `${category.name} is ${amount(cents)} a month from ${monthName(month)} on.`,
					}
				: {
						announce:
							direction === "down"
								? `${category.name} is at $0.`
								: `${category.name} is at the largest budget.`,
					},
		),
	);
	c.header("HX-Push-Url", "/?adjust=1");
	// Reaching a limit turns the tapped button off, so focus moves to the row's other one.
	const atLimit =
		(direction === "down" && cents === 0) ||
		(direction === "up" && cents === MAX_BUDGET_CENTS);
	return renderHome(c, {
		adjusting: true,
		nudgeFocus: atLimit
			? { id: category.id, direction: direction === "up" ? "down" : "up" }
			: undefined,
	});
});
