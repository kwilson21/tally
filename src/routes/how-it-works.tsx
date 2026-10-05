import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { JEV_THRESHOLD } from "../ai/categorize";
import {
	BILL_FIND_AMOUNT_PERCENT,
	BILL_FIND_MAX_DAYS,
	BILL_FIND_MIN_DAYS,
	BILL_FIND_MONTHS,
} from "../bills/find";
import { BILL_AMOUNT_TOLERANCE, BILL_DATE_WINDOW_DAYS } from "../bills/match";
import { summarizeMonth } from "../budget";
import { monthName, todayUtc } from "../dates";
import { loadMonth } from "../db/month";
import {
	bankDatedCount,
	excludedBreakdown,
	monthCounts,
} from "../db/transactions";
import {
	budgetExample,
	categorizationExample,
	excludedTotal,
	exclusionsExample,
	transactionsExample,
} from "../how-it-works/examples";
import { formatCents } from "../money";
import { TallyMark } from "../views/brand";
import {
	BillsDiagram,
	BudgetDiagram,
	CategoriesDiagram,
	ExclusionsDiagram,
	TransactionsDiagram,
} from "../views/how-diagrams";
import { Layout } from "../views/layout";
import { SystemDiagram } from "../views/system-diagram";
import { loadBillRows } from "./bills";

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
		"Cron Triggers",
		"Run the daily bank sync (a backup for webhooks), one bank at a time so one failure doesn't stop the others, skipping any bank that needs reconnecting; then retry uncategorized transactions. The demo has no bank sync: each night it resets to the seed data, then retries uncategorized transactions.",
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
}: {
	children?: Child;
	demo: boolean;
	monthName: string;
}) {
	return (
		<p class="mt-3 bg-band px-4 py-3">
			<span class="font-semibold">
				{demo
					? `In the demo for ${monthName}: `
					: `With your numbers for ${monthName}: `}
			</span>
			{children}
		</p>
	);
}

// How Tally works (spec §9): the demo adds architecture; both environments show shipped features.
howItWorks.get("/how-it-works", async (c) => {
	const demo = c.env.DEMO === "true";

	const month = todayUtc().slice(0, 7);
	const monthLabel = monthName(month);
	// Screens call the AI "Tally"; only the demo's page names Jev (decision 64).
	const ai: "Jev" | "Tally" = demo ? "Jev" : "Tally";
	const [data, counts, excluded, billData, bankDated] = await Promise.all([
		loadMonth(c.env.DB, month),
		monthCounts(c.env.DB, month),
		excludedBreakdown(c.env.DB, month),
		loadBillRows(c.env.DB),
		bankDatedCount(c.env.DB, month),
	]);
	const hasTransactions =
		demo || counts.counted + excludedTotal(excluded) > 0 || bankDated > 0;
	const unpaidDueBillsCents = billData.rows
		.filter(
			(bill) =>
				bill.active && (bill.status === "due" || bill.status === "overdue"),
		)
		.reduce((sum, bill) => sum + bill.amountCents, 0);
	const summary = summarizeMonth({ month, ...data, unpaidDueBillsCents });
	const threshold = `${Math.round(JEV_THRESHOLD * 100)}%`;
	const paidBill = billData.rows.find(
		(bill) =>
			bill.active &&
			bill.status === "paid" &&
			bill.paidDate &&
			(!demo || bill.name === "Water"),
	);

	return c.html(
		<Layout
			title="How Tally works · Tally"
			demo={demo}
			currentPath={c.req.path + new URL(c.req.url).search}
		>
			<div class="lg:max-w-3xl">
				<h1 class="font-serif text-5xl font-semibold tracking-tight">
					How Tally works
				</h1>
				<p class="mt-4 text-lg">
					Tally is a small family budgeting app. One server builds every page
					and a database keeps the numbers.{" "}
					{demo
						? "AI helps with names and categories: Jev picks categories today, and Workers AI will suggest merchant names later."
						: "AI helps by suggesting categories, and a person can always change them."}{" "}
					Code does all the math.
				</p>
				{demo && (
					<p class="mt-2 text-muted">
						This demo has no bank connection. It runs on a made-up household,
						the Riveras, and resets every night.
					</p>
				)}

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

				<Section id="budget" title="Budget and safe to spend">
					<p class="mt-2">
						Home shows how much of this month's budget is left, for each
						category and in total.
					</p>
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
							spending (including uncategorized and unbudgeted), minus bills
							that are due or overdue and not yet paid.
						</li>
					</ul>
					{!demo && summary.categories.length === 0 && (
						<p class="mt-3">No budgets have been set yet.</p>
					)}
					{demo ||
					summary.categories.length > 0 ||
					summary.totalSpentCents !== 0 ||
					unpaidDueBillsCents > 0 ? (
						<>
							<Diagram>
								<BudgetDiagram {...summary} />
							</Diagram>
							<Example demo={demo} monthName={monthLabel}>
								{budgetExample(summary)} This includes{" "}
								{demo ? "the demo's " : ""}
								due and overdue, unpaid bills.
							</Example>
						</>
					) : null}
				</Section>

				<Section id="transactions" title="Transactions">
					<p class="mt-2">
						Every transaction, with search and filters, and a panel to fix its
						category, merchant name, or note.
					</p>
					<ul class="mt-3 list-disc space-y-1 pl-5">
						<li>
							A counted transaction is in the month, not excluded, and not a
							split parent (its parts count instead).
						</li>
						<li>
							A refund linked to its purchase counts in that purchase's month
							and category.
						</li>
						<li>
							"Needs a category" counts exactly the transactions Home counts as
							uncategorized.
						</li>
						<li>
							Search matches the merchant name, the bank's name, and the note.
						</li>
					</ul>
					{hasTransactions ? (
						<>
							<Diagram>
								<TransactionsDiagram
									counted={counts.counted}
									excluded={excludedTotal(excluded)}
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
				</Section>

				<Section id="exclusions" title="Excluding transactions">
					<p class="mt-2">
						Some transactions aren't spending, like moving money between your
						own accounts or being paid back. Excluding one leaves it out of the
						budget.
					</p>
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
							uncategorized, or safe to spend.
						</li>
						<li>The Excluded filter shows only excluded transactions.</li>
					</ul>
					{hasTransactions ? (
						<>
							<Diagram>
								<ExclusionsDiagram
									counted={counts.counted}
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
				</Section>

				<Section id="categorization" title="Categories">
					<p class="mt-2">
						Each transaction's category comes from the first of these that
						applies. A person can always change it.
					</p>
					<ol class="mt-3 list-decimal space-y-1 pl-5">
						<li>A person's choice, which nothing overwrites.</li>
						<li>
							A merchant rule: "Always use this category for this merchant," set
							with "Always for this merchant" in the edit panel.
						</li>
						<li>
							{demo
								? `Jev, an AI model, which each night picks a category for what's left. Tally applies Jev's pick only when Jev is at least ${threshold} sure, and never when Jev says none of the categories fit; anything else waits for a person.`
								: `An AI model, which each night picks a category for what's left. Tally applies its pick only when it is at least ${threshold} sure, and never when it says none of the categories fit; anything else waits for a person.`}
						</li>
					</ol>
					{hasTransactions ? (
						<>
							<Diagram>
								<CategoriesDiagram
									user={counts.user}
									merchantRule={counts.merchantRule}
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
				</Section>

				<Section id="bills" title="Bills">
					<p class="mt-2">
						Tally matches each bill occurrence to at most one payment, while you
						stay in control of every link.
					</p>
					<ul class="mt-3 list-disc space-y-1 pl-5">
						<li>
							A match has the same merchant, is within{" "}
							{Math.round(BILL_AMOUNT_TOLERANCE * 100)}% of the bill amount, and
							is within {BILL_DATE_WINDOW_DAYS} days of its due date.
						</li>
						<li>
							Tally suggests a possible bill when at least two money-out charges
							in the last {BILL_FIND_MONTHS} months are {BILL_FIND_MIN_DAYS}–
							{BILL_FIND_MAX_DAYS} days apart and within{" "}
							{BILL_FIND_AMOUNT_PERCENT}% in amount.
						</li>
						<li>A payment can pay only one bill occurrence.</li>
						<li>
							A late payment counts in the month of the bill it paid, instead of
							the month when it appeared at the bank.
						</li>
						<li>
							You can link a payment to a chosen month, or reject a wrong match
							so Tally will not suggest it again.
						</li>
					</ul>
					{paidBill ? (
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
							<Example demo={demo} monthName={monthLabel}>
								{paidBill.name} is {formatCents(paidBill.amountCents)}, due{" "}
								{shortBillDate(paidBill.dueDate)}; its{" "}
								{demo ? "demo payment" : "payment"} is{" "}
								{shortBillDate(paidBill.paidDate ?? paidBill.dueDate)} and
								counts in the month of the bill it paid.
							</Example>
						</>
					) : (
						<p class="mt-3">No bill has been paid yet this month.</p>
					)}
				</Section>

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
