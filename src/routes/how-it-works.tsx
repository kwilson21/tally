import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { JEV_THRESHOLD } from "../ai/categorize";
import { summarizeMonth } from "../budget";
import { todayUtc } from "../dates";
import { loadMonth } from "../db/month";
import { excludedCount, monthCounts } from "../db/transactions";
import {
	budgetExample,
	categorizationExample,
	exclusionsExample,
	transactionsExample,
} from "../how-it-works/examples";
import { TallyMark } from "../views/brand";
import { Layout } from "../views/layout";
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
	["R2", "Stores document PDFs; D1 keeps only each file's name and details."],
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
		"Run the daily Plaid sync (a backup for webhooks), retry uncategorized transactions, and reset the demo nightly.",
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

/** A worked example: the rule applied to the demo's own numbers. */
function Example({ children }: { children?: Child }) {
	return (
		<p class="mt-3 bg-band px-4 py-3">
			<span class="font-semibold">In the demo: </span>
			{children}
		</p>
	);
}

// How Tally works (spec §9): the architecture, then one section per shipped feature. Demo only.
howItWorks.get("/how-it-works", async (c) => {
	if (c.env.DEMO !== "true") return c.notFound();

	const month = todayUtc().slice(0, 7);
	const [data, counts, excluded] = await Promise.all([
		loadMonth(c.env.DB, month),
		monthCounts(c.env.DB, month),
		excludedCount(c.env.DB, month),
	]);
	// Bills arrive in Phase 3; until then nothing is set aside for them, as on Home.
	const summary = summarizeMonth({ month, ...data, unpaidDueBillsCents: 0 });
	const threshold = `${Math.round(JEV_THRESHOLD * 100)}%`;

	return c.html(
		<Layout title="How Tally works · Tally" demo>
			<div class="lg:max-w-3xl">
				<h1 class="font-serif text-5xl font-semibold tracking-tight">
					How Tally works
				</h1>
				<p class="mt-4 text-lg">
					Tally is a small family budgeting app. One server builds every page
					and a database keeps the numbers. AI helps with names and categories:
					Jev picks categories today, and Workers AI will suggest merchant names
					later. Code does all the math.
				</p>
				<p class="mt-2 text-muted">
					This demo has no bank connection. It runs on a made-up household, the
					Riveras, and resets every night.
				</p>

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
							Safe to spend is the whole month's budget, minus all counted
							spending (including uncategorized and unbudgeted), minus bills
							that are due or overdue and not yet paid.
						</li>
					</ul>
					<Example>
						{budgetExample(summary)} Bills that are due or overdue are also set
						aside; the demo adds bills in a later phase.
					</Example>
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
							"Needs a category" counts exactly the transactions Home counts as
							uncategorized.
						</li>
						<li>
							Search matches the merchant name, the bank's name, and the note.
						</li>
					</ul>
					<Example>{transactionsExample(counts)}</Example>
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
					<Example>{exclusionsExample(excluded)}</Example>
				</Section>

				<Section id="categorization" title="Categories">
					<p class="mt-2">
						Each transaction's category comes from the first of these that
						applies. A person can always change it.
					</p>
					<ol class="mt-3 list-decimal space-y-1 pl-5">
						<li>A person's choice, which nothing overwrites.</li>
						<li>
							A merchant rule: "Always use this category for this merchant."
						</li>
						<li>
							Jev, an AI model, which each night picks a category for what's
							left. Tally applies Jev's pick only when Jev is at least{" "}
							{threshold} sure, and never when Jev says none of the categories
							fit; anything else waits for a person.
						</li>
					</ol>
					<Example>{categorizationExample(counts)}</Example>
				</Section>

				<div class="mt-10">
					<TallyMark class="size-9" />
				</div>
			</div>
		</Layout>,
	);
});
