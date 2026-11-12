// How the budgets area's rules (src/rules/budgets.ts) read their facts and save what they decide (decision 190). The
// rule decides in TypeScript; the database only checks that what the rule read has not changed since, and raises an
// error when it has, so nothing is saved on stale facts.
import type {
	BudgetFacts,
	BudgetWrite,
	SavingsGoalWrite,
} from "../rules/budgets";
import type { Outcome } from "../rules/rule";
import { type BudgetCategory, budgetCategory } from "./budgets";

/** A category's budget in `month`, as SQL: the latest amount at or before it, or NULL when it has none yet. */
const BUDGET_IN_MONTH =
	"(SELECT amount_cents FROM budget_amounts WHERE category_id = ?1 AND effective_month <= ?2 ORDER BY effective_month DESC LIMIT 1)";

/** The savings goal in `month`, as SQL: the latest amount at or before it, or NULL when there is none yet. */
const GOAL_IN_MONTH =
	"(SELECT amount_cents FROM savings_goal_amounts WHERE effective_month <= ?1 ORDER BY effective_month DESC LIMIT 1)";

/** What the budget rules read, from a category as the budget sheet loads it (or null when there is no such category). */
export function budgetFactsOf(category: BudgetCategory | null): BudgetFacts {
	return category
		? {
				category: { archived: category.archived },
				budgetCents: category.budgetCents,
			}
		: { category: null, budgetCents: null };
}

/** What the budget rules read about a category in `month`. */
export async function budgetFacts(
	db: D1Database,
	categoryId: number,
	month: string,
): Promise<BudgetFacts> {
	return budgetFactsOf(await budgetCategory(db, categoryId, month));
}

/** What the savings rule reads: the goal in `month`, a removed goal being $0 and no goal yet null. */
export async function savingsGoalFacts(
	db: D1Database,
	month: string,
): Promise<{ goalCents: number | null }> {
	const row = await db
		.prepare(`SELECT ${GOAL_IN_MONTH} AS goalCents`)
		.bind(month)
		.first<{ goalCents: number | null }>();

	return { goalCents: row?.goalCents ?? null };
}

/**
 * The statement that saves a budget from its month on, replacing one already set for that month. Its guard: the amount
 * is NULL unless the category is still there and not archived and its budget is still the one the rule read, and the
 * column is NOT NULL, so a miss fails the statement (and the whole batch it is in) with an error changedSinceRead knows.
 * SQLite's RAISE works only inside a trigger, so the NOT NULL failure is how a plain statement raises.
 */
export function budgetSaveStatement(
	db: D1Database,
	save: BudgetWrite,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO budget_amounts (category_id, effective_month, amount_cents)
			SELECT ?1, ?2, CASE WHEN EXISTS (SELECT 1 FROM categories WHERE id = ?1 AND archived = 0)
				AND ${BUDGET_IN_MONTH} IS ?4 THEN CAST(?3 AS INTEGER) END
			WHERE true
			ON CONFLICT (category_id, effective_month) DO UPDATE SET amount_cents = excluded.amount_cents`,
		)
		.bind(save.categoryId, save.month, save.cents, save.expectedBudgetCents);
}

/** The statement that saves the savings goal from its month on, with the same guard: the goal is still the one read. */
export function savingsGoalSaveStatement(
	db: D1Database,
	save: SavingsGoalWrite,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO savings_goal_amounts (effective_month, amount_cents)
			SELECT ?1, CASE WHEN ${GOAL_IN_MONTH} IS ?3 THEN CAST(?2 AS INTEGER) END
			WHERE true
			ON CONFLICT (effective_month) DO UPDATE SET amount_cents = excluded.amount_cents`,
		)
		.bind(save.month, save.cents, save.expectedGoalCents);
}

/** The text of the guards' failure, as D1 passes SQLite's message on. Only the two statements above can write a NULL amount. */
const GUARD_RAISED =
	/NOT NULL constraint failed: (budget_amounts|savings_goal_amounts)\.amount_cents/;

/** Whether a save failed because what the rule read had changed, and not for any other reason. */
export function changedSinceRead(error: Error): boolean {
	return GUARD_RAISED.test(error.message);
}

/**
 * Reads, decides and saves. `decide` reads the facts and asks the rule; a write is saved with `save`. When the guard
 * raises (another writer changed the facts between the read and the save), it reads and decides again, three times in
 * all, so two taps at once both count. It then gives up with an error; any other failure is passed on at once.
 */
export async function decideAndSave<W>(
	decide: () => Promise<Outcome<W>>,
	save: (what: W) => D1PreparedStatement,
): Promise<Outcome<W>> {
	for (let attempt = 1; attempt <= 3; attempt++) {
		const outcome = await decide();

		if (outcome.kind !== "write") return outcome;

		try {
			await save(outcome.write).run();

			return outcome;
		} catch (error) {
			if (!(error instanceof Error && changedSinceRead(error))) throw error;
		}
	}

	throw new Error("The budget kept changing while it was being saved.");
}
