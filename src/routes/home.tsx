import { type Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import { calculateBillTotals } from "../bills/totals";
import { statusSentence, summarizeMonth } from "../budget";
import { MAX_BUDGET_CENTS, parseBudgetAmount } from "../budgets/amount";
import { daysInMonth, householdToday, monthLabel, monthName } from "../dates";
import { bankSyncs } from "../db/accounts";
import {
	type BudgetCategory,
	budgetCategory,
	lastMonthSpentCents,
	nudgeBudget,
	setBudget,
	threeMonthAverageSpentCents,
} from "../db/budgets";
import {
	COUNTED_JOINS,
	countedCategorySql,
	countedMonthSql,
	FOLLOWS_PURCHASE,
	INCLUDED,
} from "../db/counted-month";
import { homeForecastDays } from "../db/home-forecast";
import { firstCountedMonth, loadMonth } from "../db/month";
import { setSavingsGoal } from "../db/savings-goals";
import { olderNeedsCategoryCount } from "../db/transactions";
import { FORECAST_START_DAY, forecastMonth } from "../home-forecast";
import { centsToAmount, formatCents } from "../money";
import { flaggedBanks, homeBankNotice } from "../stale-bank";
import { AdjustLink } from "../views/adjust-link";
import { BillRow } from "../views/bill-row";
import { BottomSheet } from "../views/bottom-sheet";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { EmptyState } from "../views/empty-state";
import { HomeForecast } from "../views/home-forecast";
import { HomeTop } from "../views/home-top";
import { Layout } from "../views/layout";
import { MoneyInput } from "../views/money-input";
import {
	categoryRowAmount,
	MonthEnd,
	PastNotBudgeted,
} from "../views/month-end";
import { MonthNavigation } from "../views/month-navigation";
import { ProgressRow } from "../views/progress-row";
import { SavingsGoalRow } from "../views/savings-goal-row";
import { SavingsGoalSheet } from "../views/savings-goal-sheet";
import { ThingsToTry } from "../views/things-to-try";
import { loadBillRows } from "./bills";

type App = { Bindings: Env };
export const home = new Hono<App>();

/** "$650" or "$650.25": a budget as a sentence says it. */
const amount = (cents: number) =>
	formatCents(cents, { wholeDollars: cents % 100 === 0 });

/** The Band's amount: whole dollars like the budget rows, but cents under $1, so it never reads "$0" for 30¢. */
const bandAmount = (cents: number) =>
	formatCents(cents, { wholeDollars: cents >= 100 || cents === 0 });

const COUNTED_CATEGORY = countedCategorySql();
const NEEDS_CATEGORY_SQL = `${COUNTED_CATEGORY} IS NULL AND ${INCLUDED} AND t.is_split = 0 AND t.flag_income = 0 AND NOT ${FOLLOWS_PURCHASE} AND (t.amount_cents >= 0 OR t.credit_reviewed = 1)`;

// Opening a budget swaps in only the sheet, so Home keeps its place.
const openAttrs = (href: string) => ({
	"hx-get": href,
	"hx-target": "#sheet",
	"hx-select": "#sheet",
	"hx-swap": "outerHTML",
	"hx-push-url": "true",
});

const closeSavingsGoalAttrs = {
	"hx-get": "/?focus=savings-goal",
	"hx-target": "#page",
	"hx-select": "#page",
	"hx-swap": "outerHTML",
	"hx-push-url": "/",
};

// Adjust mode (#94): Adjust, Done and each − or + swap Home in place. They share one queue on the
// body, so rapid taps apply one after another and Done waits for a tap still saving; focus stays on
// the tapped button by its id. htmx picks a request's target when it's tapped, so they all swap into
// #home, which is never replaced: a queued request would find the #page it picked already gone.
const inPlace = {
	"hx-target": "#home",
	"hx-select": "#page",
	"hx-swap": "innerHTML",
	"hx-sync": "body:queue all",
};
const adjustAttrs = (href: string) => ({
	id: "adjust-link",
	"hx-get": href,
	"hx-push-url": "true",
	...inPlace,
});
const nudgeAttrs = inPlace;

type HomeOptions = {
	/** A finished month selected from Home's month strip. */
	viewMonth?: string;
	/** First month with a counted transaction, already read by the root route. */
	firstMonth?: string;
	/** The budget sheet over Home, drawn with this month's numbers. */
	sheet?: (
		spentCents: (id: number) => number,
		savingsGoalCents: number | null,
	) => Child;
	/** Move focus to this category's row: after a save, or when the sheet closes. */
	focusId?: number;
	focusSavingsGoal?: boolean;
	/** Adjust mode: − and + on every budgeted row (#94). */
	adjusting?: boolean;
	/** After a tap reaches a limit, focus goes to the row's other button. */
	nudgeFocus?: { id: number; direction: "up" | "down" };
	status?: 200 | 404 | 422;
};

// Home: what's safe to spend this month, and how each category is doing (spec §8, feature 1).
// Every htmx swap selects a part of this same page.
// `today` is the household's date, read once by the handler, so the whole request uses one month.
async function renderHome(
	c: Context<App>,
	today: string,
	{
		viewMonth,
		firstMonth: firstMonthOption,
		sheet,
		focusId,
		focusSavingsGoal,
		adjusting,
		nudgeFocus,
		status = 200,
	}: HomeOptions = {},
) {
	const currentMonth = today.slice(0, 7);
	const month = viewMonth ?? currentMonth;
	const current = month === currentMonth;
	const data = await loadMonth(c.env.DB, month);
	const billData =
		month === currentMonth ? await loadBillRows(c.env.DB, today) : null;
	const dueBills =
		billData?.rows.filter(
			(b) => b.active && (b.status === "due" || b.status === "overdue"),
		) ?? [];
	const activeBills = billData?.rows.filter((bill) => bill.active) ?? [];
	const billTotals = current
		? calculateBillTotals({
				month,
				bills: activeBills.map(({ id, amountCents, frequency }) => ({
					id,
					amountCents,
					frequency,
					active: true,
				})),
				displayedOccurrences: activeBills.map((bill) => ({
					billId: bill.id,
					dueDate: bill.dueDate,
					status: bill.status,
					amountCents: bill.amountCents,
					paidCents: bill.paidCents,
				})),
				thisMonthOccurrences: activeBills.flatMap((bill) =>
					bill.totalOccurrences
						.filter((occurrence) => occurrence.dueDate.startsWith(month))
						.map((occurrence) => ({ billId: bill.id, ...occurrence })),
				),
			})
		: null;
	const summary = summarizeMonth({
		month,
		...data,
		unpaidDueBillsCents: dueBills.reduce((sum, b) => sum + b.amountCents, 0),
		savingsGoalCents: data.savingsGoalCents,
	});
	const looks = new Map(data.categories.map((cat) => [cat.id, cat]));
	const storedFirstMonth =
		firstMonthOption ?? (await firstCountedMonth(c.env.DB));
	const firstMonth =
		storedFirstMonth && storedFirstMonth < currentMonth
			? storedFirstMonth
			: currentMonth;
	const budgeted = new Set(summary.categories.map((cat) => cat.id));
	const notBudgeted = data.categories.filter((cat) => {
		if (budgeted.has(cat.id)) return false;
		const hasSpending = data.transactions.some(
			(t) => t.categoryId === cat.id && !t.income,
		);
		return current ? !cat.archived || hasSpending : hasSpending;
	});
	// Focus goes to the row asked for; if it isn't a link any more (archived on another screen while
	// its sheet was open), to the Budget heading, so focus is never lost.
	const linked = new Set(
		data.categories.filter((cat) => !cat.archived).map((cat) => cat.id),
	);
	const focusHeading = focusId !== undefined && !linked.has(focusId);
	// Adjust is offered when there's a budget it can change: a budgeted category that isn't archived.
	const canAdjust = summary.categories.some((cat) => linked.has(cat.id));
	const { spentCents } = summary.uncategorized;
	const needsCount = current
		? await c.env.DB.prepare(
				`SELECT COUNT(*) AS n FROM transactions t ${COUNTED_JOINS} WHERE ${countedMonthSql()} = ? AND ${NEEDS_CATEGORY_SQL}`,
			)
				.bind(month)
				.first<{ n: number }>()
		: null;
	const currentNeeds = needsCount?.n ?? 0;
	const olderNeeds = current
		? await olderNeedsCategoryCount(c.env.DB, `${month}-01`)
		: 0;
	const hasSavingsGoal = (data.savingsGoalCents ?? 0) > 0;
	const needs = (
		<>
			{currentNeeds}
			<span class="sr-only">
				{" "}
				{currentNeeds === 1 ? "transaction" : "transactions"}
			</span>{" "}
			{currentNeeds === 1 ? "needs" : "need"} a category
		</>
	);
	const demo = c.env.DEMO === "true";
	// A connected bank that stopped syncing, so Safe to spend may be too high (spec §8.5). The demo has
	// no real banks, so it never asks.
	const bankNotice =
		demo || !current
			? null
			: homeBankNotice(flaggedBanks(await bankSyncs(c.env.DB), today), today);
	const day = Number(today.slice(8, 10));
	const forecastDays = current
		? await homeForecastDays(c.env.DB, month, today)
		: [];
	const forecastSpentCents = forecastDays.reduce(
		(sum, row) => sum + row.spentCents,
		0,
	);
	const billPaymentsCents = forecastDays.reduce(
		(sum, row) => sum + row.billPaymentsCents,
		0,
	);
	const refundsCents = forecastDays.reduce(
		(sum, row) => sum + row.refundsCents,
		0,
	);
	const everydayCents = forecastDays.reduce(
		(sum, row) => sum + row.everydayCents,
		0,
	);
	const forecast = forecastMonth({
		day,
		daysInMonth: daysInMonth(month),
		totalBudgetCents: summary.totalBudgetCents,
		spentCents: forecastSpentCents,
		everydayCents,
		billPaymentsCents,
		refundsCents,
		billsStillDueCents: billTotals?.stillToPayCents ?? 0,
	});
	const showForecast = current && day >= FORECAST_START_DAY && forecast.visible;
	const dailySpending = Array.from(
		{ length: day },
		(_, index) =>
			forecastDays.find((item) => item.day === index + 1)?.spentCents ?? 0,
	);
	const dailyAmount =
		current && day < FORECAST_START_DAY && summary.safeToSpendCents > 0
			? `About ${formatCents(Math.floor(summary.safeToSpendCents / (daysInMonth(month) - day + 1)))} a day for ${daysInMonth(month) - day + 1} days left.`
			: undefined;
	// Counted spending by category, income left out, as Home counts it (spec §6).
	const spent = (id: number) =>
		data.transactions
			.filter((t) => t.categoryId === id && !t.income)
			.reduce((sum, t) => sum + t.amountCents, 0);
	const pastNotBudgeted = notBudgeted.map((cat) => ({
		...cat,
		spentCents: spent(cat.id),
	}));

	return c.html(
		<Layout
			active="home"
			demo={demo}
			currentPath={c.req.path + new URL(c.req.url).search}
		>
			<div id="home">
				<div id="page">
					{/* One width for the top and the Budget list on desktop (#92, H6). */}
					<div class="lg:max-w-2xl">
						{current ? (
							<HomeTop
								month={monthName(month)}
								monthHeading={
									<MonthNavigation
										month={month}
										firstMonth={firstMonth}
										currentMonth={currentMonth}
									/>
								}
								safeToSpendCents={summary.safeToSpendCents}
								status={statusSentence(summary.categories)}
								bankLine={bankNotice?.words}
								bankDate={bankNotice?.asOf}
								dailyAmount={dailyAmount}
								forecast={
									showForecast && (
										<HomeForecast
											month={month}
											day={day}
											daysInMonth={daysInMonth(month)}
											spentByDay={dailySpending}
											budgetCents={summary.totalBudgetCents}
											endCents={forecast.endCents}
											differenceCents={
												summary.totalBudgetCents - forecast.endCents
											}
										/>
									)
								}
								band={
									currentNeeds > 0 || olderNeeds > 0
										? {
												href: "/transactions/organize",
												text:
													currentNeeds > 0
														? needs
														: `${olderNeeds} ${olderNeeds === 1 ? "transaction" : "transactions"} from earlier months ${olderNeeds === 1 ? "needs" : "need"} a category`,
												older: currentNeeds > 0 ? olderNeeds : undefined,
												// Refunds can outweigh the spending; it says so, as the budget sheet does.
												detail:
													currentNeeds === 0
														? undefined
														: spentCents < 0
															? `${bandAmount(-summary.uncategorized.spentCents)} more refunded than spent`
															: `${bandAmount(summary.uncategorized.spentCents)} of this month's spending`,
											}
										: undefined
								}
							/>
						) : (
							<>
								<MonthNavigation
									month={month}
									firstMonth={firstMonth}
									currentMonth={currentMonth}
								/>
								<MonthEnd
									chartId={month}
									monthName={monthLabel(month, currentMonth)}
									amountCents={
										summary.totalBudgetCents - summary.totalSpentCents
									}
									rows={summary.categories}
								/>
								<a
									href="/"
									class="mt-3 inline-flex min-h-11 items-center text-accent"
								>
									Back to {monthName(currentMonth)}
								</a>
							</>
						)}

						<section class="mt-8" aria-labelledby="budget-title">
							<div class="flex items-baseline justify-between gap-4">
								<h2
									id="budget-title"
									class="font-serif text-3xl font-semibold"
									tabindex={focusHeading ? -1 : undefined}
									autofocus={focusHeading}
								>
									Budget
								</h2>
								{current && canAdjust && (
									<AdjustLink
										adjusting={adjusting === true}
										attrs={adjustAttrs(adjusting ? "/" : "/?adjust=1")}
									/>
								)}
							</div>
							{(summary.categories.length > 0 || hasSavingsGoal) && (
								<ul class="mt-2 divide-y divide-rule">
									{hasSavingsGoal && current && (
										<SavingsGoalRow
											amountCents={data.savingsGoalCents}
											href="/savings-goal"
											attrs={openAttrs("/savings-goal")}
											autofocus={focusSavingsGoal}
										/>
									)}
									{hasSavingsGoal && !current && (
										<SavingsGoalRow amountCents={data.savingsGoalCents} />
									)}
									{summary.categories.map((cat) => {
										// An archived category shows for a month it has spending in (spec §7), but it
										// can't be budgeted, so its row isn't a link.
										const href =
											current && !looks.get(cat.id)?.archived
												? `/budget/${cat.id}`
												: undefined;
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
													current && adjusting && href
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
								</ul>
							)}
							{!current ? (
								<PastNotBudgeted items={pastNotBudgeted} />
							) : notBudgeted.length > 0 || !hasSavingsGoal ? (
								<>
									<h3 class="mt-6 text-sm text-muted">Not budgeted</h3>
									<ul class="divide-y divide-rule">
										{!hasSavingsGoal && (
											<SavingsGoalRow
												amountCents={data.savingsGoalCents}
												href="/savings-goal"
												attrs={openAttrs("/savings-goal")}
												autofocus={focusSavingsGoal}
											/>
										)}
										{notBudgeted.map((cat) =>
											cat.archived ? (
												<li class="flex min-h-11 items-center gap-4 py-2 text-ink">
													<CategoryIcon icon={cat.icon} color={cat.color} />
													<span class="min-w-0 flex-1 truncate text-lg">
														{cat.name}
													</span>
													<span
														class={categoryRowAmount(spent(cat.id)).className}
													>
														{categoryRowAmount(spent(cat.id)).text}
													</span>
												</li>
											) : (
												<li>
													<a
														href={`/budget/${cat.id}`}
														autofocus={cat.id === focusId}
														class="flex min-h-11 items-center gap-4 py-2 text-ink no-underline"
														{...openAttrs(`/budget/${cat.id}`)}
													>
														<CategoryIcon icon={cat.icon} color={cat.color} />
														<span class="min-w-0 flex-1 truncate text-lg">
															{cat.name}
														</span>
														<span class="text-accent">Add a budget</span>
													</a>
												</li>
											),
										)}
									</ul>
								</>
							) : null}
							{current &&
								summary.categories.length === 0 &&
								notBudgeted.length === 0 &&
								!hasSavingsGoal && (
									<EmptyState
										kind="done"
										sentence="No categories to budget yet."
										hint="Add a category in Settings to get started."
										action={{ href: "/settings", label: "Open Settings" }}
									/>
								)}
						</section>
						{current && dueBills.length > 0 && (
							<section class="mt-8" aria-labelledby="home-bills-title">
								<div class="flex items-baseline justify-between">
									<h2
										id="home-bills-title"
										class="font-serif text-3xl font-semibold"
									>
										Bills due soon
									</h2>
									<a href="/bills" class="min-h-11 py-2 text-accent">
										All bills
									</a>
								</div>
								<ul class="divide-y divide-rule">
									{dueBills.slice(0, 3).map((bill) => (
										<BillRow bill={bill} today={billData?.today ?? today} />
									))}
								</ul>
							</section>
						)}
						{/* The demo's Things to try, below the list until onboarding (#95) replaces it (#92). */}
						{current && demo && (
							<div class="mt-8">
								<ThingsToTry />
							</div>
						)}
					</div>
					<div id="sheet">{sheet?.(spent, data.savingsGoalCents)}</div>
				</div>
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
	averageCents,
	month: monthPeriod,
}: {
	category: BudgetCategory;
	value: string;
	error?: string;
	spentCents: number;
	lastMonthCents: number;
	averageCents: number | null;
	/** The household's current month, YYYY-MM. */
	month: string;
}) {
	const month = monthName(monthPeriod);
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
			// A refused amount draws the open sheet again.
			still={error !== undefined}
		>
			<div class="flex items-center gap-3">
				<CategoryIcon icon={category.icon} color={category.color} />
				<h2
					id="budget-sheet-title"
					class="min-w-0 wrap-anywhere font-serif text-4xl font-semibold tracking-tight"
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
				hx-disable="findAll button[type=submit]"
				hx-indicator="#budget-save"
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
					averageCents={averageCents}
					autofocus
				/>
				<div class="mt-2 grid grid-cols-2 gap-3">
					<Button href="/" kind="secondary" class="w-full" {...closeAttrs}>
						Cancel
					</Button>
					<Button
						id="budget-save"
						type="submit"
						class="w-full"
						busyLabel="Saving…"
					>
						Save
					</Button>
				</div>
			</form>
		</BottomSheet>
	);
}

const idOf = (c: Context<App>) => Number(c.req.param("id"));
/**
 * The active category a budget route is about, or null, with the household's date and current
 * month. This is the one place a budget request reads the date; it passes it on to renderHome.
 */
async function activeCategory(c: Context<App>) {
	const today = await householdToday(c.env.DB);
	const month = today.slice(0, 7);
	const category = await budgetCategory(c.env.DB, idOf(c), month);
	return category && !category.archived ? { category, today, month } : null;
}

// ?focus=<id> puts focus on that row when the sheet closes.
// ?adjust=1 is Adjust mode (#94).
home.get("/", async (c) => {
	const today = await householdToday(c.env.DB);
	const currentMonth = today.slice(0, 7);
	const storedFirstMonth = await firstCountedMonth(c.env.DB);
	const firstMonth =
		storedFirstMonth && storedFirstMonth < currentMonth
			? storedFirstMonth
			: currentMonth;
	const requested = c.req.query("month");
	const viewMonth =
		requested &&
		/^\d{4}-(0[1-9]|1[0-2])$/.test(requested) &&
		requested >= firstMonth &&
		requested <= currentMonth
			? requested
			: currentMonth;
	const focus = Number(c.req.query("focus"));
	if (c.req.query("focus") === "savings-goal" && c.req.header("HX-Request")) {
		const message = "Savings goal editing cancelled.";
		c.header(
			"HX-Trigger",
			JSON.stringify({ toast: { message, type: "info" }, announce: message }),
		);
	}
	return renderHome(c, today, {
		viewMonth,
		firstMonth,
		focusSavingsGoal: c.req.query("focus") === "savings-goal",
		focusId: Number.isInteger(focus) && focus > 0 ? focus : undefined,
		adjusting: viewMonth === currentMonth && c.req.query("adjust") === "1",
	});
});

// A category's budget sheet over Home (#66). A real URL: it works without JavaScript and can be linked to.
home.get("/budget/:id{[0-9]+}", async (c) => {
	const active = await activeCategory(c);
	if (!active) return c.notFound();
	const { category, today, month } = active;
	const lastMonth = await lastMonthSpentCents(c.env.DB, category.id, month);
	const average = await threeMonthAverageSpentCents(
		c.env.DB,
		category.id,
		month,
	);
	return renderHome(c, today, {
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
				averageCents={average}
				month={month}
			/>
		),
	});
});

home.get("/savings-goal", async (c) => {
	const today = await householdToday(c.env.DB);
	return renderHome(c, today, {
		sheet: (_spent, amountCents) => (
			<BottomSheet
				labelledBy="savings-goal-sheet-title"
				closeHref="/"
				closeAttrs={closeSavingsGoalAttrs}
			>
				<SavingsGoalSheet
					value={
						amountCents !== null && amountCents > 0
							? centsToAmount(amountCents)
							: ""
					}
					month={monthName(today.slice(0, 7))}
					closeAttrs={closeSavingsGoalAttrs}
				/>
			</BottomSheet>
		),
	});
});

home.post("/savings-goal", async (c) => {
	const today = await householdToday(c.env.DB);
	const month = today.slice(0, 7);
	const typed = String((await c.req.formData()).get("goal") ?? "");
	const parsed = parseBudgetAmount(typed);
	if (!parsed.ok) {
		if (c.req.header("HX-Request")) {
			c.header(
				"HX-Trigger",
				JSON.stringify({
					toast: { message: parsed.error, type: "error" },
					announce: parsed.error,
				}),
			);
		}
		return renderHome(c, today, {
			status: 422,
			sheet: () => (
				<BottomSheet
					labelledBy="savings-goal-sheet-title"
					closeHref="/"
					closeAttrs={closeSavingsGoalAttrs}
					still
				>
					<SavingsGoalSheet
						value={typed}
						error={parsed.error}
						month={monthName(month)}
						closeAttrs={closeSavingsGoalAttrs}
					/>
				</BottomSheet>
			),
		});
	}
	await setSavingsGoal(c.env.DB, parsed.cents, month);
	if (!c.req.header("HX-Request")) return c.redirect("/", 303);
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: { message: "Saved the savings goal", type: "success" },
			announce: `Savings is ${amount(parsed.cents)} a month from ${monthName(month)} on.`,
		}),
	);
	c.header("HX-Push-Url", "/");
	return renderHome(c, today, { focusSavingsGoal: true });
});

// Saving a budget, from this month on (spec §7). htmx gets Home back with a toast; plain browsers are redirected.
home.post("/budget/:id{[0-9]+}", async (c) => {
	const active = await activeCategory(c);
	if (!active) return c.notFound();
	const { category, today, month } = active;
	const typed = String((await c.req.formData()).get("budget") ?? "");
	const parsed = parseBudgetAmount(typed);
	if (!parsed.ok) {
		const lastMonth = await lastMonthSpentCents(c.env.DB, category.id, month);
		const average = await threeMonthAverageSpentCents(
			c.env.DB,
			category.id,
			month,
		);
		return renderHome(c, today, {
			status: 422,
			sheet: (spent) => (
				<BudgetSheet
					category={category}
					value={typed}
					error={parsed.error}
					spentCents={spent(category.id)}
					lastMonthCents={lastMonth}
					averageCents={average}
					month={month}
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
	return renderHome(c, today, { focusId: category.id });
});

// One tap in Adjust mode (#94, decision 48): the budget moves to the next round $10, from this month
// on, as the sheet saves it. htmx gets Home back in Adjust mode; plain browsers are redirected there.
home.post("/budget/:id{[0-9]+}/nudge/:direction{up|down}", async (c) => {
	const active = await activeCategory(c);
	// Only a budgeted category has buttons; one without a budget gets it from its sheet.
	if (!active || active.category.budgetCents === null) return c.notFound();
	const { category, today, month } = active;
	const direction = c.req.param("direction") === "up" ? "up" : "down";
	// Read and written in one statement, so two taps at once (two phones) both count.
	const cents = await nudgeBudget(c.env.DB, category.id, direction, month);
	if (!c.req.header("HX-Request")) return c.redirect("/?adjust=1", 303);
	// At a limit nothing changes, and it still says so on screen and to screen readers.
	const limit =
		direction === "down" ? "already $0" : "already the largest budget";
	c.header(
		"HX-Trigger",
		JSON.stringify(
			cents !== null
				? {
						toast: {
							message: `${category.name} is ${amount(cents)} a month`,
							type: "success",
						},
						announce: `${category.name} is ${amount(cents)} a month from ${monthName(month)} on.`,
					}
				: {
						toast: { message: `${category.name} is ${limit}`, type: "info" },
						announce: `${category.name} is ${limit}.`,
					},
		),
	);
	c.header("HX-Push-Url", "/?adjust=1");
	// Reaching a limit turns the tapped button off, so focus moves to the row's other one.
	const atLimit =
		cents === null ||
		(direction === "down" && cents === 0) ||
		(direction === "up" && cents === MAX_BUDGET_CENTS);
	return renderHome(c, today, {
		adjusting: true,
		nudgeFocus: atLimit
			? { id: category.id, direction: direction === "up" ? "down" : "up" }
			: undefined,
	});
});
