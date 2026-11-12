// The budgets area's rules (decisions 187 and 206): save a budget, nudge a budget, save the savings goal. Each takes a
// typed request and the stored facts, and is written as a list of its parts (`rule`, in ./terms). The month is an input
// (decision 195), and nothing here parses, reads a clock or touches the database. The save's guard is in
// src/db/budget-saves.ts (decision 190).

import * as Data from "effect/Data";
import { nudgeCents } from "../budgets/nudge";
import { rule, term, unless } from "./terms";

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

// The refusals: one class each, with the sentence a person reads.

export class CategoryNotOnBudget extends Data.TaggedError(
	"CategoryNotOnBudget",
) {
	readonly say = "That category isn't on the budget.";
}

export class NoBudgetToAdjust extends Data.TaggedError("NoBudgetToAdjust") {
	readonly say = "That category has no budget to adjust yet.";
}

const onBudget = (facts: BudgetFacts) =>
	facts.category !== null && !facts.category.archived;

const categoryIsOnBudget = unless(
	term<{ onBudget: boolean }>(
		"the category is on the budget",
		(g) => g.onBudget,
	),
	() => new CategoryNotOnBudget(),
);

export const saveBudget = rule({
	name: "Save a budget",
	given: (
		request: { categoryId: number; cents: number; month: string },
		facts: BudgetFacts,
	) => ({ ...request, onBudget: onBudget(facts), now: facts.budgetCents }),
	nothingToDoIf: term<{ onBudget: boolean; now: number | null; cents: number }>(
		"the category is on the budget and its budget is already that amount",
		(g) => g.onBudget && g.now === g.cents,
	),
	refusals: [categoryIsOnBudget],
	writes: (g): BudgetWrite => ({
		categoryId: g.categoryId,
		month: g.month,
		cents: g.cents,
		expectedBudgetCents: g.now,
	}),
	writesText: "Sets the category's budget to that amount from this month on.",
});

/** What a nudge is decided from. `next` is where one tap takes the budget, or null when there is none to move. */
type NudgeGiven = {
	onBudget: boolean;
	now: number | null;
	next: number | null;
};

export const nudgeBudget = rule({
	name: "Nudge a budget",
	given: (
		request: { categoryId: number; direction: "up" | "down"; month: string },
		facts: BudgetFacts,
	) => ({
		...request,
		onBudget: onBudget(facts),
		now: facts.budgetCents,
		next:
			facts.budgetCents === null
				? null
				: nudgeCents(facts.budgetCents, request.direction),
	}),
	nothingToDoIf: term<NudgeGiven>(
		"the category is on the budget and its budget is already as far as it goes that way",
		(g) => g.onBudget && g.now !== null && g.next === g.now,
	),
	refusals: [
		categoryIsOnBudget,
		unless(
			term<NudgeGiven>("the category has a budget", (g) => g.now !== null),
			() => new NoBudgetToAdjust(),
		),
	],
	writes: (g): BudgetWrite => {
		// The refusals above have already answered for a category with no budget, so there is a next amount here.
		if (g.next === null) throw new Error("A nudge with no budget to move.");

		return {
			categoryId: g.categoryId,
			month: g.month,
			cents: g.next,
			expectedBudgetCents: g.now,
		};
	},
	writesText:
		"Sets the category's budget to the next round $10 that way, from this month on.",
});

export const saveSavingsGoal = rule({
	name: "Save the savings goal",
	given: (
		request: { cents: number; month: string },
		facts: { goalCents: number | null },
	) => ({ ...request, now: facts.goalCents }),
	// Saving $0 removes the goal, so no goal and a $0 goal are the same thing.
	nothingToDoIf: term<{ now: number | null; cents: number }>(
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
