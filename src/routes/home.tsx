import { Hono } from "hono";
import { statusSentence, summarizeMonth } from "../budget";
import { monthName, todayUtc } from "../dates";
import { loadMonth } from "../db/month";
import { formatCents } from "../money";
import { Band } from "../views/band";
import { Icon } from "../views/icons";
import { LedgerIllustration } from "../views/illustration";
import { Layout } from "../views/layout";
import { ProgressRow } from "../views/progress-row";

export const home = new Hono<{ Bindings: Env }>();

// Home: what's safe to spend this month, and how each category is doing (spec §8, feature 1).
home.get("/", async (c) => {
	const month = todayUtc().slice(0, 7);
	const data = await loadMonth(c.env.DB, month);
	// Bills arrive in Phase 3; until then nothing is set aside for them.
	const summary = summarizeMonth({ month, ...data, unpaidDueBillsCents: 0 });
	const looks = new Map(data.categories.map((cat) => [cat.id, cat]));
	const { count, spentCents } = summary.uncategorized;
	const needs = `${count} ${count === 1 ? "transaction needs" : "transactions need"} a category`;

	return c.html(
		<Layout active="home" demo={c.env.DEMO === "true"}>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				{monthName(month)}
			</h1>
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
				<h2 id="budget-title" class="font-serif text-3xl font-semibold">
					Budget
				</h2>
				{summary.categories.length === 0 && count === 0 ? (
					<p class="mt-2 text-muted">No budgets yet.</p>
				) : (
					<ul class="mt-2 divide-y divide-rule">
						{summary.categories.map((cat) => (
							<ProgressRow
								name={cat.name}
								icon={looks.get(cat.id)?.icon ?? "list"}
								color={looks.get(cat.id)?.color ?? ""}
								spentCents={cat.spentCents}
								budgetCents={cat.budgetCents}
							/>
						))}
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
			</section>
		</Layout>,
	);
});
