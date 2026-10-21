import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { addressOf } from "../address";
import { JEV_THRESHOLD } from "../ai/categorize";
import {
	BILL_FIND_AMOUNT_PERCENT,
	BILL_FIND_MAX_DAYS,
	BILL_FIND_MIN_DAYS,
	BILL_FIND_MONTHS,
} from "../bills/find";
import { BILL_AMOUNT_TOLERANCE, BILL_DATE_WINDOW_DAYS } from "../bills/match";
import { loadBillRows } from "../bills/rows";
import { WEEKLY_BILL_DATE_WINDOW_DAYS } from "../bills/status";
import { billTotalsForRows } from "../bills/totals";
import { summarizeMonth } from "../budget";
import { householdToday, monthName } from "../dates";
import { accountsByBank } from "../db/accounts";
import { readAiTally } from "../db/ai-log";
import { namesToReview } from "../db/merchant-names";
import { loadMonth } from "../db/month";
import { plansSetAsideCents } from "../db/planned-expenses";
import {
	bankDatedCount,
	excludedBreakdown,
	monthCounts,
	startHereRows,
} from "../db/transactions";
import { loadTrends } from "../db/trends";
import { readFirstWeek } from "../first-tally/setup";
import { FORECAST_START_DAY } from "../home-forecast";
import {
	billStatusExamples,
	budgetExample,
	categorizationExample,
	excludedTotal,
	exclusionsExample,
	netWorthExample,
	transactionsExample,
	trendsExample,
} from "../how-it-works/examples";
import { formatCents } from "../money";
import { buildTrends, RUN_MONTHS, sameDaysCaption } from "../trends";
import { TallyMark } from "../views/brand";
import { FirstWeekPart } from "../views/first-week";
import { FoldedRow } from "../views/folded-row";
import {
	BillsDiagram,
	BudgetDiagram,
	CategoriesDiagram,
	ExclusionsDiagram,
	TransactionsDiagram,
} from "../views/how-diagrams";
import { Layout } from "../views/layout";
import { StartHere } from "../views/start-here";
import { SystemDiagram } from "../views/system-diagram";

export const howItWorks = new Hono<{ Bindings: Env }>();

// Spec §4, word for word: each part and its job in one sentence.
const PARTS: [string, string][] = [
	[
		"Cloudflare Worker (Hono, TypeScript)",
		"Handles every request: builds pages, receives Plaid webhooks, and runs scheduled jobs.",
	],
	[
		"HTMX",
		"When you click something, HTMX asks the server for a piece of new HTML and swaps it into the page.",
	],
	[
		"Tailwind CSS",
		"Styles the pages with utility classes, compiled into one CSS file.",
	],
	["Workers static assets", "Serves the CSS file, htmx.js, and icons."],
	["D1 (SQLite)", "Stores all data."],
	[
		"Plaid (REST over fetch)",
		"Supplies accounts, transactions, and balances from the family's banks.",
	],
	[
		"Jev (TypeSafe AI)",
		"Picks a category and flags for each transaction, with a confidence score.",
	],
	[
		"Workers AI",
		"Suggests a clean merchant name, which a person accepts or rejects.",
	],
	[
		"Resend",
		"Sends bank sign-in reminder emails and the first week's ready email; Cloudflare Email Service is the best-effort fallback for destinations verified in Cloudflare Email Routing (decision 86), except for a ready email Resend may already have accepted (decision 146).",
	],
	[
		"Cron Triggers",
		"Run the daily bank sync (a backup for webhooks), one bank at a time so one failure doesn't stop the others, skipping any bank that needs reconnecting; then retry uncategorized transactions. Each minute, in the family app, it checks whether a new family's first questions have opened and emails each person who left the page 10 minutes ago, once; the 10:00 run sends due reconnect reminders and checks again. The demo has no bank sync or email: each night it resets to the seed data, then retries uncategorized transactions.",
	],
	[
		"Cloudflare Workflows",
		"Sorts transactions with Jev in small steps and keeps each answer for a few days, so a step that has to run again doesn't ask twice.",
	],
	[
		"Cloudflare Access",
		"A login wall with the family's emails in front of the family app; the app has no login code of its own.",
	],
	[
		"Wrangler",
		"The command-line tool that deploys the Worker and stores secrets.",
	],
];

/**
 * The four Bills groups in the words How Tally works uses for them (#341, decision 62), in the order Bills shows
 * them. Each rule is followed by its example from the household's own bills.
 */
const BILL_STATUSES = [
	[
		"overdue",
		"Overdue",
		"Its due date has passed and it isn't paid. A monthly, yearly or quarterly bill stays overdue until it's paid or the next one is due. If it was due this month, its amount is set aside until it's paid or the month ends. A weekly or every-two-weeks bill stays overdue until it's paid, within the month it was due.",
	],
	[
		"due",
		"Due in the next 7 days",
		"It isn't paid, and its due date is within the next 7 days.",
	],
	[
		"upcoming",
		"Upcoming",
		"It isn't paid, and its due date is more than 7 days away.",
	],
	[
		"paid",
		"Paid this month",
		"A payment is linked to the occurrence Bills shows.",
	],
] as const;

function Section({
	id,
	title,
	children,
}: {
	id: string;
	title: string;
	children?: Child;
}) {
	return (
		<section id={id} aria-labelledby={`${id}-title`} class="mt-10">
			<h2 id={`${id}-title`} class="font-serif text-3xl font-semibold">
				{title}
			</h2>
			{children}
		</section>
	);
}

/** A section's diagram, drawn from the same numbers as its worked example. */
function Diagram({ children }: { children?: Child }) {
	return <div class="mt-4">{children}</div>;
}

/** A worked example: the rule applied to this household's numbers, naming the month it uses. */
function Example({
	children,
	demo,
	monthName,
	label,
}: {
	children?: Child;
	demo: boolean;
	monthName: string;
	label?: string;
}) {
	return (
		<p class="mt-3 bg-band px-4 py-3">
			<span class="font-semibold">
				{label ??
					(demo
						? `In the demo for ${monthName}: `
						: `With your numbers for ${monthName}: `)}
			</span>
			{children}
		</p>
	);
}

/**
 * A section's exact rules, closed under its diagram and example, with the rule count (P137 A, decision 126).
 */
function RulesFold({ count, children }: { count: number; children?: Child }) {
	return (
		<div class="mt-3">
			<FoldedRow
				label="The exact rules"
				value={
					<span class="text-muted">
						{count} {count === 1 ? "rule" : "rules"}
					</span>
				}
			>
				{children}
			</FoldedRow>
		</div>
	);
}

// How Tally works (spec §9): the demo adds architecture; both environments show shipped features.
howItWorks.get("/how-it-works", async (c) => {
	const demo = c.env.DEMO === "true";

	const today = await householdToday(c.env.DB);
	const month = today.slice(0, 7);
	const monthLabel = monthName(month);
	// Screens call the AI "Tally"; only the demo's page names Jev (decision 64).
	const ai: "Jev" | "Tally" = demo ? "Jev" : "Tally";
	const [
		data,
		counts,
		excluded,
		billData,
		bankDated,
		trendsData,
		waitingNames,
		aiTally,
	] = await Promise.all([
		loadMonth(c.env.DB, month),
		monthCounts(c.env.DB, month),
		excludedBreakdown(c.env.DB, month),
		loadBillRows(c.env.DB, today),
		bankDatedCount(c.env.DB, month),
		loadTrends(c.env.DB, today),
		namesToReview(c.env.DB),
		readAiTally(c.env.DB, today),
	]);
	const trendsExampleText = trendsExample(buildTrends(trendsData));
	const hasTransactions =
		demo || counts.counted + excludedTotal(excluded) > 0 || bankDated > 0;
	// The same totals Home and Bills show, so this page's set-aside amount is Safe to spend's (decision 123).
	const unpaidDueBillsCents = billTotalsForRows(
		month,
		billData.rows,
	).setAsideCents;
	// Planned expenses are set aside in the current month only, as Home sets them (spec §8.4).
	const unpaidPlansCents =
		month === today.slice(0, 7) ? await plansSetAsideCents(c.env.DB, month) : 0;
	const summary = summarizeMonth({
		month,
		...data,
		unpaidDueBillsCents,
		unpaidPlansCents,
	});
	const budgeted = new Set(summary.categories.map((category) => category.id));
	const unbudgetedCents = data.transactions
		.filter(
			(transaction) =>
				!transaction.income &&
				transaction.categoryId !== null &&
				!budgeted.has(transaction.categoryId),
		)
		.reduce((sum, transaction) => sum + transaction.amountCents, 0);
	const netWorthText = netWorthExample(
		(await accountsByBank(c.env.DB)).flatMap((bank) => bank.accounts),
	);
	const threshold = `${Math.round(JEV_THRESHOLD * 100)}%`;
	const paidBill = billData.rows.find(
		(bill) =>
			bill.active &&
			bill.status === "paid" &&
			bill.paidDate &&
			(!demo || bill.name === "Water"),
	);
	const billExamples = billStatusExamples(billData.rows, today);
	// Start here's bank lines (spec §8.8) exist only in the demo. Its lines come from the seed's month, so its
	// "See every line" link names that month when it isn't today's (the list's count is the heading's N).
	const startRows = demo ? await startHereRows(c.env.DB, month) : null;
	const startRawHref =
		startRows && startRows.month !== month
			? `/transactions?raw=1&month=${startRows.month}`
			: "/transactions?raw=1";
	// The family app's "Your first week" part (P125 E, spec §9): the five strokes with their days, from the first_tally record.
	const firstWeek = demo ? null : await readFirstWeek(c.env.DB);

	return c.html(
		<Layout
			title="How Tally works · Tally"
			active="how"
			demo={demo}
			currentPath={addressOf(c)}
		>
			<div class="lg:max-w-3xl">
				<h1 class="font-serif text-5xl font-semibold tracking-tight">
					How Tally works
				</h1>
				{startRows && (
					<StartHere
						storyMonthName={monthName(startRows.month)}
						monthName={monthLabel}
						rawHref={startRawHref}
						lines={startRows}
						safeToSpendCents={summary.safeToSpendCents}
					/>
				)}
				<p class="mt-4 text-lg">
					Tally is a small family budgeting app. One server builds every page
					and a database keeps the numbers.{" "}
					{demo
						? "AI helps with names and categories: Jev picks categories today, and Workers AI suggests merchant names today."
						: "AI helps with categories and store names, and a person can always change them."}{" "}
					Code does all the math.
				</p>
				{firstWeek && (
					<Section id="first-week" title="Your first week">
						<FirstWeekPart
							record={firstWeek.record}
							names={firstWeek.names}
							today={today}
						/>
					</Section>
				)}
				<Section id="budget" title="Budget and safe to spend">
					<p class="mt-2">
						Home shows how much of this month's budget is left, for each
						category and in total.
					</p>
					{!demo && summary.categories.length === 0 && (
						<p class="mt-3">No budgets have been set yet.</p>
					)}
					{demo ||
					summary.categories.length > 0 ||
					summary.totalSpentCents !== 0 ||
					unpaidDueBillsCents > 0 ||
					(summary.savingsGoalCents ?? 0) > 0 ||
					summary.plannedCents > 0 ? (
						<>
							<Diagram>
								<BudgetDiagram {...summary} />
							</Diagram>
							<Example demo={demo} monthName={monthLabel}>
								{budgetExample({
									...summary,
									unbudgetedCents,
									billsDueCents: unpaidDueBillsCents,
									plannedCents: unpaidPlansCents,
								})}
							</Example>
						</>
					) : null}
					<RulesFold count={8}>
						<ul class="mt-3 list-disc space-y-1 pl-5">
							<li>
								A category's budget for a month is its latest amount set on or
								before that month.
							</li>
							<li>
								Spent is the sum of the month's counted transactions in that
								category; refunds reduce it.
							</li>
							<li>Left is budget minus spent.</li>
							<li>Income counts only toward Income, not spending.</li>
							<li>
								Cash transactions count in spending, but Cash is not part of net
								worth.
							</li>
							<li>
								Safe to spend is the whole month's budget, minus all counted
								spending (including uncategorized and unbudgeted), minus this
								month's bills that are due or overdue and not yet paid, minus
								the full monthly savings goal from the 1st, and minus planned
								one-time expenses.
							</li>
							<li>
								A planned one-time expense is set aside for its whole month, and
								one from an earlier month stays set aside until it is paid,
								moved or dropped; once a payment is linked on Bills, it stops
								being set aside.
							</li>
							<li>
								Before day {FORECAST_START_DAY}, Home shows the daily amount:
								Safe to spend divided by the days left, today included, with any
								partial cent left out. From day {FORECAST_START_DAY}, it shows
								the month-end forecast.
							</li>
						</ul>
					</RulesFold>
				</Section>

				<Section id="transactions" title="Transactions">
					<p class="mt-2">
						Every transaction, with search and filters, and a panel to fix its
						category, merchant name, or note.
					</p>
					{hasTransactions ? (
						<>
							<Diagram>
								<TransactionsDiagram
									counted={counts.counted}
									excluded={excludedTotal(excluded)}
									heldForReview={counts.heldForReview}
									needsCategory={counts.needsCategory}
								/>
							</Diagram>
							<Example demo={demo} monthName={monthLabel}>
								{transactionsExample(counts)}
							</Example>
						</>
					) : (
						<p class="mt-3">There are no transactions this month yet.</p>
					)}
					<RulesFold count={5}>
						<ul class="mt-3 list-disc space-y-1 pl-5">
							<li>
								A counted transaction is in the month, not excluded (unless it
								pays a bill or a planned expense), and not a split parent (its
								parts count instead) or a credit held for review (below).
							</li>
							<li>
								An unreviewed bank credit that isn't income is held out of
								spending, uncategorized, and safe to spend until Tally
								confidently categorizes it as non-income or a person marks it
								reviewed as a refund or other non-income credit.
							</li>
							<li>
								A refund linked to its purchase counts in that purchase's month
								and category while the purchase counts; if the purchase is
								excluded, the refund counts on its own date and category.
							</li>
							<li>
								"Needs a category" counts exactly the transactions Home counts
								as uncategorized.
							</li>
							<li>
								Search matches the merchant name, the bank's name, the note, and
								a category's name. A number such as 42.17 or $42 finds amounts,
								and a search looks in every month.
							</li>
						</ul>
					</RulesFold>
				</Section>

				<Section id="exclusions" title="Excluding transactions">
					<p class="mt-2">
						Some transactions aren't spending, like moving money between your
						own accounts or being paid back. Excluding one leaves it out of the
						budget.
					</p>
					{hasTransactions ? (
						<>
							<Diagram>
								<ExclusionsDiagram
									counted={counts.counted}
									heldForReview={counts.heldForReview}
									breakdown={excluded}
								/>
							</Diagram>
							<Example demo={demo} monthName={monthLabel}>
								{exclusionsExample(excluded)}
							</Example>
						</>
					) : (
						<p class="mt-3">There are no transactions this month yet.</p>
					)}
					<RulesFold count={5}>
						<ul class="mt-3 list-disc space-y-1 pl-5">
							<li>
								Transactions flagged as a transfer or a reimbursement start
								excluded.
							</li>
							<li>
								A person can exclude or include any transaction from its edit
								panel.
							</li>
							<li>
								An excluded transaction doesn't count toward spending,
								uncategorized, or safe to spend, unless it pays a bill or a
								planned expense: a payment linked to either always counts.
							</li>
							<li>
								A credit held for review isn't excluded: it waits until Tally
								confidently sorts it as non-income or a person reviews it, and
								once a person marks it as income it counts toward Income
								instead, unless it's excluded too (see Transactions).
							</li>
							<li>
								Choose Excluded in the Show choice on Transactions to see only
								the excluded ones.
							</li>
						</ul>
					</RulesFold>
				</Section>

				<Section id="categorization" title="Categories">
					<p class="mt-2">
						Each transaction's category comes from the first of these that
						applies. A person can always change it.
					</p>
					{hasTransactions ? (
						<>
							<Diagram>
								<CategoriesDiagram
									user={counts.user}
									merchantRule={counts.merchantRule}
									bill={counts.bill}
									jev={counts.jev}
									waiting={counts.needsCategory + counts.linkedWaiting}
									income={counts.income}
									threshold={threshold}
									ai={ai}
								/>
							</Diagram>
							<Example demo={demo} monthName={monthLabel}>
								{categorizationExample(counts, ai)}
							</Example>
						</>
					) : (
						<p class="mt-3">There are no transactions this month yet.</p>
					)}
					<RulesFold count={9}>
						<ol class="mt-3 list-decimal space-y-1 pl-5">
							<li>A person's choice, which nothing overwrites.</li>
							<li>
								A merchant rule: "Always use this category for this merchant,"
								set by ticking "Use this category for … from now on" in the edit
								panel. It replaces a bill category or Tally's unconfirmed guess,
								but never a person's choice. Ticking it on a transaction that
								does not match the rule changes the rule for that merchant; to
								remove a rule, untick it and save.
							</li>
							<li>
								A bill: a payment linked by the matcher or by hand takes its
								bill's category when it has none, a Tally pick or an earlier
								bill's category. A person's choice is never replaced, and
								unlinking leaves the category.
							</li>
							<li>
								{demo
									? `Jev, an AI model, which each night picks a category for what's left. Tally applies Jev's pick only when Jev is at least ${threshold} sure, and never when Jev says none of the categories fit; anything else waits for a person.`
									: `An AI model, which each night picks a category for what's left. Tally applies its pick only when it is at least ${threshold} sure, and never when it says none of the categories fit; anything else waits for a person.`}
							</li>
						</ol>
						<p class="mt-3">
							After a person picks the same category for the same merchant three
							times, Tally asks whether to always use it. Yes makes it the
							merchant's rule, and Not now changes nothing. Tally doesn't ask on
							a trip that looks mixed, or on an Organize save that filed one.
						</p>
						<p class="mt-3">
							A trip looks mixed when {ai} says it spans more than one category,
							and the other category it names is one of this household's. Its
							line under the category says so, with “Split this one?”, which
							opens a split with those two categories as Tally's guess: dashed,
							with the amounts empty, since the bank sends only the total. Tally
							never fills in an amount, and the split saves only when its parts
							add up exactly. Once a person picks the trip's category, the line
							goes.
						</p>
						<p class="mt-3">
							See every rule in Settings under Tally's rules. Removing a rule
							doesn't change transactions it already sorted.
						</p>
						<p class="mt-3">
							A suggested category is only an idea; nothing is created until a
							person says so.
						</p>
						<p class="mt-3">
							With Fill in details on, Tally can also guess what a purchase was,
							its kind, and who it was for. Tally writes “What it was” only when
							it can say more than the store's name. These stay Tally's guess
							until a person changes or keeps them. Turning the switch off hides
							unkept guesses and keeps a person's choices visible. A person's
							choices always win.
						</p>
					</RulesFold>
				</Section>

				<Section id="names" title="Store names">
					<p class="mt-2">
						The list shows what your bank printed, tidied by code. Names can be
						suggested for it, and you decide whether to use them.
					</p>
					<Example
						demo={demo}
						monthName={monthLabel}
						label={demo ? "In the demo, " : "With your numbers, "}
					>
						{waitingNames.length === 0
							? "No merchant names are waiting for a choice."
							: `${waitingNames.length} merchant name${waitingNames.length === 1 ? " is" : "s are"} waiting for a choice.`}
					</Example>
					<RulesFold count={4}>
						<ul class="mt-3 list-disc space-y-1 pl-5">
							<li>
								Your bank sometimes sends a clean name of its own. That is the
								first suggestion, and it says "From your bank".
							</li>
							<li>
								When it sends none, Tally guesses one. A name Tally guessed
								shows with a sparkles icon and a dashed underline. It stays a
								guess: nothing is renamed until you choose it.
							</li>
							<li>
								You choose in a transaction's edit panel, or in Settings under
								Suggestions. Pick a suggestion, keep the bank's name, or type
								your own. A name you typed always wins.
							</li>
							<li>
								Tally asks once for each bank text, overnight. Turn it off with
								Suggest store names in Settings: its guesses are hidden until
								you turn it back on, and the bank's own names still show.
							</li>
						</ul>
					</RulesFold>
				</Section>

				<Section id="bills" title="Bills">
					<p class="mt-2">
						Tally matches each bill occurrence to one payment, while you stay in
						control of every link. A bill paid in parts takes more: you link
						each extra payment by hand, and the month is Paid once they reach
						90% of its amount.
					</p>
					<p class="mt-3">Bills puts each active bill in one of four groups:</p>
					<dl class="mt-3 divide-y divide-rule border-y border-rule">
						{BILL_STATUSES.map(([status, term, rule]) => (
							<div class="grid gap-1 py-3 sm:grid-cols-[14rem_1fr] sm:gap-4">
								<dt class="font-semibold">{term}</dt>
								<dd>
									{rule} {billExamples[status]}
								</dd>
							</div>
						))}
					</dl>
					{paidBill && (
						<>
							<Diagram>
								<BillsDiagram
									amount={formatCents(paidBill.amountCents)}
									due={shortBillDate(paidBill.dueDate)}
									paid={shortBillDate(paidBill.paidDate ?? paidBill.dueDate)}
									windowDays={BILL_DATE_WINDOW_DAYS}
									tolerance={`${Math.round(BILL_AMOUNT_TOLERANCE * 100)}%`}
								/>
							</Diagram>
							<Example
								demo={demo}
								monthName={monthName(paidBill.dueDate.slice(0, 7))}
							>
								{paidBill.name} is {formatCents(paidBill.amountCents)}, due{" "}
								{shortBillDate(paidBill.dueDate)}; its{" "}
								{demo ? "demo payment" : "payment"} is{" "}
								{shortBillDate(paidBill.paidDate ?? paidBill.dueDate)}
								{(paidBill.paidDate ?? paidBill.dueDate).slice(0, 7) >
								paidBill.dueDate.slice(0, 7)
									? " and counts in the month of the bill it paid, not the month it reached the bank."
									: ", so it counts in the month it reached the bank."}
							</Example>
						</>
					)}
					<RulesFold count={12}>
						<ul class="mt-3 list-disc space-y-1 pl-5">
							<li>
								A match has the same merchant, is within{" "}
								{Math.round(BILL_AMOUNT_TOLERANCE * 100)}% of the bill amount,
								and is within {WEEKLY_BILL_DATE_WINDOW_DAYS} days of its due
								date for a weekly bill, or {BILL_DATE_WINDOW_DAYS} days for the
								other bills.
							</li>
							<li>
								Tally suggests a possible bill when a merchant's latest
								money-out charge in the last {BILL_FIND_MONTHS} months repeats
								an earlier one {BILL_FIND_MIN_DAYS}–{BILL_FIND_MAX_DAYS} days
								before it, within {BILL_FIND_AMOUNT_PERCENT}% of that earlier
								charge's amount.
							</li>
							<li>
								Card payments and moves between your own accounts are never
								suggested while they're left out of the budget: what you bought
								on the card already counts, and saving each month is what the
								savings goal on Home is for.
							</li>
							<li>
								A steady loan payment, such as a car, mortgage or student loan
								that your bank marks as one, is suggested even while it's left
								out of the budget.
							</li>
							<li>
								A merchant whose payment is already linked to a bill isn't
								suggested until two monthly payments in a row are left unlinked.
							</li>
							<li>
								A payment from the same merchant that is outside that{" "}
								{Math.round(BILL_AMOUNT_TOLERANCE * 100)}% is not matched. Tally
								asks "Price changed?" on the bill instead, and nothing changes
								until you update the bill or say it is not this bill.
							</li>
							<li>
								A payment you left out of the budget can still pay a bill, and
								once it's linked it counts in the budget, so the bill counts
								once. Unlinking it leaves it excluded, as it was.
							</li>
							<li>A payment can pay only one bill occurrence.</li>
							<li>
								Bills can repeat monthly, yearly, weekly, every two weeks or
								quarterly. A missed weekly or every-two-weeks occurrence from an
								earlier month says “Not paid” and is no longer set aside. A due
								date from before the day a bill was added is not counted as
								missed. Safe to spend sets aside every due or overdue occurrence
								due this month that is unpaid; one due next month waits for its
								month.
							</li>
							<li>
								A late payment counts in the month of the bill it paid, instead
								of the month when it appeared at the bank.
							</li>
							<li>
								A bill's amount for a month is its latest amount set on or
								before that month, as a budget's is. A changed price applies
								from the month it's changed in, and earlier months keep theirs.
							</li>
							<li>
								You can link a payment to a chosen month, or reject a wrong
								match so Tally will not suggest it again.
							</li>
						</ul>
					</RulesFold>
				</Section>

				<Section id="trends" title="Trends">
					<p class="mt-2">
						Trends compares this month with last month and shows which
						categories are going well.
					</p>
					{trendsExampleText ? (
						<Example demo={demo} monthName={monthLabel}>
							{trendsExampleText}
						</Example>
					) : (
						<p class="mt-3">
							Trends fill in as months pass, so there is nothing to compare yet.
						</p>
					)}
					<RulesFold count={6}>
						<ul class="mt-3 list-disc space-y-1 pl-5">
							<li>
								This month so far is compared with the same days of last month (
								{sameDaysCaption(today)}).
							</li>
							<li>
								Spending counts exactly as it does on Home: refunds reduce it,
								and income, excluded transactions and credits held for review
								are left out.
							</li>
							<li>
								Going well: under budget {RUN_MONTHS} or more months running.
							</li>
							<li>
								Worth a look: spending up {RUN_MONTHS} or more months running. A
								category that is both is worth a look.
							</li>
							<li>
								The month still going is drawn dashed and isn't judged against
								its budget until it's over. When Tally's history starts after
								the 1st of a month, that month is only partly there, so it's
								drawn striped but never judged or compared; one that starts on
								the 1st counts like any other.
							</li>
							<li>Code writes these sentences, not AI.</li>
						</ul>
					</RulesFold>
				</Section>

				<Section id="what-ai-did" title="What Tally did with AI">
					<p class="mt-2">
						Tally keeps a small record of the AI work it applies: a transaction
						it gave a category, a paycheck it marked as income, and a store name
						you kept. The record has no amounts, and code does the counting,
						never the AI.
					</p>
					<Example demo={demo} monthName={monthName(aiTally.month)}>
						{`Tally sorted ${aiTally.sorted} ${aiTally.sorted === 1 ? "transaction" : "transactions"} and you changed ${aiTally.changed}, cleaned ${aiTally.named} ${aiTally.named === 1 ? "merchant name" : "merchant names"} and found ${aiTally.paychecks} ${aiTally.paychecks === 1 ? "paycheck" : "paychecks"}.`}
					</Example>
					<RulesFold count={5}>
						<ul class="mt-3 list-disc space-y-1 pl-5">
							<li>
								Sorted counts the transactions Tally gave a category this month.
								You changed counts the ones you changed afterwards, by picking
								another category, splitting it with a part in another category,
								or with an Always rule you made. A bill's category never counts.
							</li>
							<li>
								Cleaned counts the store names Tally guessed that you kept. A
								name from your bank isn't counted.
							</li>
							<li>
								Found counts the paychecks Tally marked as income this month.
							</li>
							<li>
								The record starts the day this feature shipped, and each month
								counts its own days. Early in a month with nothing yet, last
								month's counts are shown, labelled with its name.
							</li>
							<li>
								A feature you've switched off shows Off in place of its count.
								Download everything includes the record.
							</li>
						</ul>
					</RulesFold>
				</Section>

				<Section id="net-worth" title="Net worth">
					<p class="mt-2">
						Accounts shows what everything you've linked adds up to, and a line
						of how it has moved over the last 6 months.
					</p>
					{netWorthText ? (
						<Example demo={demo} monthName={monthLabel}>
							{netWorthText}
						</Example>
					) : (
						<p class="mt-3">There are no accounts to add up yet.</p>
					)}
					<RulesFold count={5}>
						<ul class="mt-3 list-disc space-y-1 pl-5">
							<li>
								Net worth is what you have minus what you owe: every account's
								balance, where credit card and loan balances are subtracted.
							</li>
							<li>
								The Cash account and any disconnected bank are left out, so the
								line ends on the number at the top of Accounts.
							</li>
							<li>
								Each time a bank syncs, Tally saves one balance per account for
								that day, in your household's time zone. A later sync the same
								day replaces it, so a day has one.
								{demo &&
									" This demo has no bank connection, so its six months of balances come with the made-up data."}
							</li>
							<li>
								The line has a point for each day with a balance, this month
								included. It starts on the first day every account has a
								balance, so linking another bank doesn't look like your net
								worth jumped. Until every account has a balance there is no
								line, only a note saying it is waiting.
							</li>
							<li>
								Code writes the sentence under the number, like "Up $3,600 since
								May.", from the line's first and last day. It isn't AI.
							</li>
						</ul>
					</RulesFold>
				</Section>

				{demo && (
					<Section id="architecture" title="How it's built">
						<div class="mt-4">
							<SystemDiagram />
						</div>
						<dl class="mt-6 divide-y divide-rule border-y border-rule">
							{PARTS.map(([part, job]) => (
								<div class="grid gap-1 py-3 sm:grid-cols-[14rem_1fr] sm:gap-4">
									<dt class="font-semibold">{part}</dt>
									<dd class="text-muted">{job}</dd>
								</div>
							))}
						</dl>
					</Section>
				)}

				<div class="mt-10">
					<TallyMark class="size-9" />
				</div>
			</div>
		</Layout>,
	);
});

function shortBillDate(date: string) {
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${date}T00:00:00Z`));
}
