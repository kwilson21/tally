import { type Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import { billTotalsForRows } from "../bills/totals";
import { statusSentence, summarizeMonth } from "../budget";
import { MAX_BUDGET_CENTS, parseBudgetAmount } from "../budgets/amount";
import { daysInMonth, householdToday, monthLabel, monthName } from "../dates";
import { bankSyncs } from "../db/accounts";
import {
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
import { BudgetSheet } from "../views/budget-sheet";
import { EmptyState } from "../views/empty-state";
import { HomeForecast } from "../views/home-forecast";
import { HomeTop } from "../views/home-top";
import { Layout } from "../views/layout";
import { MonthEnd, PastNotBudgeted } from "../views/month-end";
import { MonthNavigation } from "../views/month-navigation";
import { NotBudgetedRow } from "../views/not-budgeted-row";
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

// Where the savings goal sheet's close goes: Home, with focus on the Savings row. Its htmx close and its plain
// link (Cancel and the backdrop without JavaScript) both use it.
const SAVINGS_GOAL_CLOSE_HREF = "/?focus=savings-goal";
const closeSavingsGoalAttrs = {
	"hx-get": SAVINGS_GOAL_CLOSE_HREF,
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
		transactionCount: (id: number) => number,
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
	const billData = current ? await loadBillRows(c.env.DB, today) : null;
	const activeBills = billData?.rows.filter((bill) => bill.active) ?? [];
	// The list is the bills Safe to spend sets aside, judged by the same totals, so the list and the figure agree.
	const dueBills = current
		? activeBills.filter(
				(bill) => billTotalsForRows(month, [bill]).soonCount > 0,
			)
		: [];
	const billTotals = current ? billTotalsForRows(month, activeBills) : null;
	const unpaidBillsCents = billTotals?.soonCents ?? 0;
	const summary = summarizeMonth({
		month,
		...data,
		unpaidDueBillsCents: unpaidBillsCents,
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
	// Any budget this month, the same test statusSentence uses. With none, Home is never over budget (#519).
	const hasBudgets = summary.categories.length > 0;
	// With no budget the forecast would measure spending against $0 and draw it over budget, so it waits for one.
	const showForecast =
		current && hasBudgets && day >= FORECAST_START_DAY && forecast.visible;
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
	const transactionCount = (id: number) =>
		data.transactions.filter((t) => t.categoryId === id && !t.income).length;
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
								hasBudgets={hasBudgets}
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
												reserveArrow={current && !adjusting}
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
								<PastNotBudgeted
									items={pastNotBudgeted}
									needsCategory={summary.uncategorized}
								/>
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
										{notBudgeted.map((cat) => (
											<NotBudgetedRow
												name={cat.name}
												icon={cat.icon}
												color={cat.color}
												spentCents={spent(cat.id)}
												href={cat.archived ? undefined : `/budget/${cat.id}`}
												attrs={
													cat.archived
														? undefined
														: openAttrs(`/budget/${cat.id}`)
												}
												autofocus={cat.id === focusId}
											/>
										))}
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
					<div id="sheet">
						{sheet?.(spent, data.savingsGoalCents, transactionCount)}
					</div>
				</div>
			</div>
		</Layout>,
		status,
	);
}

// Closing a budget sheet goes back to Home with focus on that category's row: its plain link (Cancel and the
// backdrop without JavaScript) and its htmx swap, which announces the change.
const budgetCloseHref = (categoryId: number) => `/?focus=${categoryId}`;
const closeBudgetAttrs = (categoryId: number) => ({
	"hx-get": budgetCloseHref(categoryId),
	"hx-target": "#page",
	"hx-select": "#page",
	"hx-swap": "outerHTML",
	"hx-push-url": "/",
});

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
	const closeAttrs = closeBudgetAttrs(category.id);
	return renderHome(c, today, {
		sheet: (spent, _savingsGoal, transactionCount) => (
			<BottomSheet
				labelledBy="budget-sheet-title"
				closeHref={budgetCloseHref(category.id)}
				closeAttrs={closeAttrs}
			>
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
					transactionCount={transactionCount(category.id)}
					month={month}
					closeHref={budgetCloseHref(category.id)}
					closeAttrs={closeAttrs}
				/>
			</BottomSheet>
		),
	});
});

home.get("/savings-goal", async (c) => {
	const today = await householdToday(c.env.DB);
	return renderHome(c, today, {
		sheet: (_spent, amountCents) => (
			<BottomSheet
				labelledBy="savings-goal-sheet-title"
				closeHref={SAVINGS_GOAL_CLOSE_HREF}
				closeAttrs={closeSavingsGoalAttrs}
			>
				<SavingsGoalSheet
					value={
						amountCents !== null && amountCents > 0
							? centsToAmount(amountCents)
							: ""
					}
					month={monthName(today.slice(0, 7))}
					closeHref={SAVINGS_GOAL_CLOSE_HREF}
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
					closeHref={SAVINGS_GOAL_CLOSE_HREF}
					closeAttrs={closeSavingsGoalAttrs}
					still
				>
					<SavingsGoalSheet
						value={typed}
						error={parsed.error}
						month={monthName(month)}
						closeHref={SAVINGS_GOAL_CLOSE_HREF}
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
		const closeAttrs = closeBudgetAttrs(category.id);
		// A refused amount draws the open sheet again, without its arrival.
		return renderHome(c, today, {
			status: 422,
			sheet: (spent, _savingsGoal, transactionCount) => (
				<BottomSheet
					labelledBy="budget-sheet-title"
					closeHref={budgetCloseHref(category.id)}
					closeAttrs={closeAttrs}
					still
				>
					<BudgetSheet
						category={category}
						value={typed}
						error={parsed.error}
						spentCents={spent(category.id)}
						lastMonthCents={lastMonth}
						averageCents={average}
						transactionCount={transactionCount(category.id)}
						month={month}
						closeHref={budgetCloseHref(category.id)}
						closeAttrs={closeAttrs}
					/>
				</BottomSheet>
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
