import { describe, expect, it } from "vitest";
import * as z from "zod";
import { MAX_BUDGET_CENTS } from "../src/budgets/amount";
import {
	type BudgetFacts,
	nudgeBudget,
	saveBudget,
	saveSavingsGoal,
} from "../src/rules/budgets";
import { nothingToDo, refuse, write } from "../src/rules/rule";

// The budgets area's three rules as stories (decisions 187, 192): each row is what was asked, what was stored, and what
// the rule answers. The month is an input (decision 195); nothing here touches a clock or a database.

const MONTH = "2026-11";
const live = (budgetCents: number | null): BudgetFacts => ({
	category: { archived: false },
	budgetCents,
});
const archived = (budgetCents: number | null): BudgetFacts => ({
	category: { archived: true },
	budgetCents,
});
const missing: BudgetFacts = { category: null, budgetCents: null };
const NOT_ON_BUDGET = refuse(
	"CategoryNotOnBudget",
	"That category isn't on the budget.",
);
const NO_BUDGET = refuse(
	"NoBudgetToAdjust",
	"That category has no budget to adjust yet.",
);

describe("Save a budget", () => {
	const ask = (cents: number, facts: BudgetFacts) =>
		saveBudget.decide({ categoryId: 1, cents, month: MONTH }, facts);
	const saves = (cents: number, expectedBudgetCents: number | null) =>
		write({ categoryId: 1, month: MONTH, cents, expectedBudgetCents });

	it.each([
		["sets a first budget", 65000, live(null), saves(65000, null)],
		["changes a budget", 70000, live(65000), saves(70000, 65000)],
		["sets a budget of $0", 0, live(65000), saves(0, 65000)],
		["sets $0 where there is no budget yet", 0, live(null), saves(0, null)],
		[
			"has nothing to do for the amount it already has",
			65000,
			live(65000),
			nothingToDo(),
		],
		["has nothing to do for $0 again", 0, live(0), nothingToDo()],
		["refuses a category that does not exist", 65000, missing, NOT_ON_BUDGET],
		["refuses an archived category", 70000, archived(65000), NOT_ON_BUDGET],
		[
			"refuses an archived category even for the amount it has",
			65000,
			archived(65000),
			NOT_ON_BUDGET,
		],
	])("%s", (_story, cents, facts, answer) => {
		expect(ask(cents, facts)).toEqual(answer);
	});
});

describe("Nudge a budget", () => {
	const ask = (direction: "up" | "down", facts: BudgetFacts) =>
		nudgeBudget.decide({ categoryId: 1, direction, month: MONTH }, facts);
	const saves = (cents: number, expectedBudgetCents: number) =>
		write({ categoryId: 1, month: MONTH, cents, expectedBudgetCents });

	it.each([
		["moves $712.40 up to $720", "up", live(71240), saves(72000, 71240)],
		["moves $712.40 down to $710", "down", live(71240), saves(71000, 71240)],
		["moves a round $720 up to $730", "up", live(72000), saves(73000, 72000)],
		[
			"moves a round $720 down to $710",
			"down",
			live(72000),
			saves(71000, 72000),
		],
		["moves $5 down to $0", "down", live(500), saves(0, 500)],
		["moves $0 up to $10", "up", live(0), saves(1000, 0)],
		[
			"stops at the largest budget",
			"up",
			live(MAX_BUDGET_CENTS - 1),
			saves(MAX_BUDGET_CENTS, MAX_BUDGET_CENTS - 1),
		],
		["has nothing to do down from $0", "down", live(0), nothingToDo()],
		[
			"has nothing to do up from the largest budget",
			"up",
			live(MAX_BUDGET_CENTS),
			nothingToDo(),
		],
		["refuses a category with no budget", "up", live(null), NO_BUDGET],
		["refuses a category that does not exist", "up", missing, NOT_ON_BUDGET],
		["refuses an archived category", "down", archived(72000), NOT_ON_BUDGET],
		[
			"refuses an archived category at its limit too",
			"down",
			archived(0),
			NOT_ON_BUDGET,
		],
	] as const)("%s", (_story, direction, facts, answer) => {
		expect(ask(direction, facts)).toEqual(answer);
	});
});

describe("Save the savings goal", () => {
	const ask = (cents: number, goalCents: number | null) =>
		saveSavingsGoal.decide({ cents, month: MONTH }, { goalCents });
	const saves = (cents: number, expectedGoalCents: number | null) =>
		write({ month: MONTH, cents, expectedGoalCents });

	it.each([
		["sets a first goal", 20000, null, saves(20000, null)],
		["changes a goal", 30000, 20000, saves(30000, 20000)],
		["removes a goal by saving $0", 0, 20000, saves(0, 20000)],
		[
			"has nothing to do for the goal it already has",
			20000,
			20000,
			nothingToDo(),
		],
		["has nothing to do for $0 with no goal", 0, null, nothingToDo()],
		["has nothing to do for $0 after a goal was removed", 0, 0, nothingToDo()],
	])("%s", (_story, cents, goalCents, answer) => {
		expect(ask(cents, goalCents)).toEqual(answer);
	});
});

describe("the rules' sheet", () => {
	it("names every rule, its conditions in words and what it saves", () => {
		expect(
			[saveBudget, nudgeBudget, saveSavingsGoal].map((rule) => ({
				name: rule.name,
				nothingToDoIf: rule.nothingToDoIf.text,
				refusals: rule.refusals.map(
					(r) => `${r.type}: unless ${r.unless.text}`,
				),
				writes: rule.writesText,
			})),
		).toEqual([
			{
				name: "Save a budget",
				nothingToDoIf:
					"the category is on the budget and its budget is already that amount",
				refusals: ["CategoryNotOnBudget: unless the category is on the budget"],
				writes: "Sets the category's budget to that amount from this month on.",
			},
			{
				name: "Nudge a budget",
				nothingToDoIf:
					"the category is on the budget and its budget is already as far as it goes that way",
				refusals: [
					"CategoryNotOnBudget: unless the category is on the budget",
					"NoBudgetToAdjust: unless the category has a budget",
				],
				writes:
					"Sets the category's budget to the next round $10 that way, from this month on.",
			},
			{
				name: "Save the savings goal",
				nothingToDoIf: "the savings goal is already that amount",
				refusals: [],
				writes: "Sets the savings goal to that amount from this month on.",
			},
		]);
	});

	it("gives every answer one of exactly three kinds (the contract of decision 192)", () => {
		const Answer = z.discriminatedUnion("kind", [
			z.strictObject({ kind: z.literal("write"), write: z.unknown() }),
			z.strictObject({ kind: z.literal("nothingToDo") }),
			z.strictObject({
				kind: z.literal("refuse"),
				type: z.string().min(1),
				say: z.string().min(1),
			}),
		]);
		const answers = [
			saveBudget.decide({ categoryId: 1, cents: 1, month: MONTH }, live(null)),
			saveBudget.decide({ categoryId: 1, cents: 1, month: MONTH }, live(1)),
			saveBudget.decide({ categoryId: 1, cents: 1, month: MONTH }, missing),
			nudgeBudget.decide(
				{ categoryId: 1, direction: "up", month: MONTH },
				live(1),
			),
			nudgeBudget.decide(
				{ categoryId: 1, direction: "down", month: MONTH },
				live(0),
			),
			nudgeBudget.decide(
				{ categoryId: 1, direction: "up", month: MONTH },
				live(null),
			),
			saveSavingsGoal.decide({ cents: 1, month: MONTH }, { goalCents: null }),
			saveSavingsGoal.decide({ cents: 1, month: MONTH }, { goalCents: 1 }),
		];
		for (const answer of answers)
			expect(Answer.safeParse(answer).success).toBe(true);
	});
});
