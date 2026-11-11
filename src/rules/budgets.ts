// The budgets area's rules (decisions 187 and 192): save a budget, nudge a budget, save the savings goal. Each takes a
// typed request and the stored facts and answers what to save. The month is an input (decision 195), and nothing here
// parses, reads a clock or touches the database. The save's guard is in src/db/budget-saves.ts (decision 190).
import { nudgeCents } from "../budgets/nudge";
import { defineRule2, term, unless } from "./rule";

/** What the budget rules read about a category: whether it exists and is archived, and its budget in the month. */
export type BudgetFacts = {
	category: { archived: boolean } | null;
	/** The category's budget in the request's month, or null when it has none yet. */
	budgetCents: number | null;
};

/** What a budget rule saves: the amount from `month` on, good only while the budget it read is still the budget. */
export type BudgetWrite = {
	categoryId: number;
	month: string;
	cents: number;
	expectedBudgetCents: number | null;
};

/** What the savings rule saves: the goal from `month` on, good only while the goal it read is still the goal. */
export type SavingsGoalWrite = {
	month: string;
	cents: number;
	expectedGoalCents: number | null;
};

const onBudget = (facts: BudgetFacts) =>
	facts.category !== null && !facts.category.archived;

const categoryIsOnBudget = term<{ onBudget: boolean }>(
	"the category is on the budget",
	(g) => g.onBudget,
);
const notOnBudget = unless(
	categoryIsOnBudget,
	"CategoryNotOnBudget",
	"That category isn't on the budget.",
);

type SaveBudgetGiven = {
	categoryId: number;
	cents: number;
	month: string;
	onBudget: boolean;
	now: number | null;
};
type NudgeBudgetGiven = {
	categoryId: number;
	direction: "up" | "down";
	month: string;
	onBudget: boolean;
	now: number | null;
	/** Where one tap takes the budget, or null when there is none to move. */
	next: number | null;
};
type SavingsGoalGiven = { cents: number; month: string; now: number | null };

export const saveBudget = defineRule2({
	name: "Save a budget",
	given: (
		request: { categoryId: number; cents: number; month: string },
		facts: BudgetFacts,
	): SaveBudgetGiven => ({
		...request,
		onBudget: onBudget(facts),
		now: facts.budgetCents,
	}),
	nothingToDoIf: term<SaveBudgetGiven>(
		"the category is on the budget and its budget is already that amount",
		(g) => g.onBudget && g.now === g.cents,
	),
	refusals: [notOnBudget],
	writes: (g): BudgetWrite => ({
		categoryId: g.categoryId,
		month: g.month,
		cents: g.cents,
		expectedBudgetCents: g.now,
	}),
	writesText: "Sets the category's budget to that amount from this month on.",
});

export const nudgeBudget = defineRule2({
	name: "Nudge a budget",
	given: (
		request: { categoryId: number; direction: "up" | "down"; month: string },
		facts: BudgetFacts,
	): NudgeBudgetGiven => ({
		...request,
		onBudget: onBudget(facts),
		now: facts.budgetCents,
		next:
			facts.budgetCents === null
				? null
				: nudgeCents(facts.budgetCents, request.direction),
	}),
	nothingToDoIf: term<NudgeBudgetGiven>(
		"the category is on the budget and its budget is already as far as it goes that way",
		(g) => g.onBudget && g.now !== null && g.next === g.now,
	),
	refusals: [
		notOnBudget,
		unless(
			term<NudgeBudgetGiven>(
				"the category has a budget",
				(g) => g.now !== null,
			),
			"NoBudgetToAdjust",
			"That category has no budget to adjust yet.",
		),
	],
	writes: (g): BudgetWrite => ({
		categoryId: g.categoryId,
		month: g.month,
		// The refusals above have already answered for a category with no budget.
		cents: g.next as number,
		expectedBudgetCents: g.now,
	}),
	writesText:
		"Sets the category's budget to the next round $10 that way, from this month on.",
});

export const saveSavingsGoal = defineRule2({
	name: "Save the savings goal",
	given: (
		request: { cents: number; month: string },
		facts: { goalCents: number | null },
	): SavingsGoalGiven => ({ ...request, now: facts.goalCents }),
	// Saving $0 removes the goal, so no goal and a $0 goal are the same thing.
	nothingToDoIf: term<SavingsGoalGiven>(
		"the savings goal is already that amount",
		(g) => (g.now ?? 0) === g.cents,
	),
	refusals: [],
	writes: (g): SavingsGoalWrite => ({
		month: g.month,
		cents: g.cents,
		expectedGoalCents: g.now,
	}),
	writesText: "Sets the savings goal to that amount from this month on.",
});
