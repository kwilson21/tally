import { describe, expect, it } from "vitest";
import type { BillSuggestion } from "../src/bills/find";
import type { BudgetAsk, NothingAsked } from "../src/first-tally/budgets";
import type {
	BudgetsStep,
	FirstPageModel,
} from "../src/first-tally/first-page";
import {
	type SkippedNote,
	skippedBills,
	skippedBudgets,
	skippedNotes,
	skippedPay,
} from "../src/first-tally/skipped";

// A setup step with nothing to ask says so on the next screen (P142 A, #773): a skipped note names the step, says why in
// today's words, and counts what waits in Possible bills.

describe("skippedPay", () => {
	it("says Tally didn't spot a paycheck, with nothing waiting", () => {
		expect(skippedPay()).toEqual({
			step: "Your pay",
			text: "Tally didn't spot a paycheck. You can mark one from any transaction later.",
			waiting: 0,
		});
	});
});

describe("skippedBills", () => {
	it("says there is nothing to keep in one tap, and counts what waits", () => {
		expect(skippedBills(2)).toEqual({
			step: "Your bills",
			text: "Nothing here to keep in one tap.",
			waiting: 2,
		});
	});

	it("waits for nothing when no charge waits either", () => {
		expect(skippedBills(0).waiting).toBe(0);
	});
});

describe("skippedBudgets", () => {
	it("says why the budgets step asked nothing, from the reason", () => {
		expect(skippedBudgets("every-category-budgeted")).toEqual({
			step: "Your budgets",
			text: "Every category already has a budget.",
			waiting: 0,
		});
		expect(skippedBudgets("no-categories")).toEqual({
			step: "Your budgets",
			text: "No categories to budget yet.",
			waiting: 0,
		});
	});
});

// The notes a setup screen draws under its step bar (P142 A, #773): the steps that asked nothing, run back from the step before
// the screen, stopping at the first step that asked something. A budgets screen shows its notes only on the step's first screen.

const ask: BudgetAsk = {
	id: 1,
	name: "Groceries",
	icon: "groceries",
	color: "cat-blue",
	months: [],
	suggestion: null,
};

/** A not-done budgets step: asked (one category to answer), or nothing asked for the given reason. */
const budgetsAsked = (
	over: Partial<Extract<BudgetsStep, { done: false }>> = {},
) =>
	({
		done: false,
		month: "2026-10",
		asks: [ask],
		keepAllOpen: false,
		needs: null,
		firstDate: "2026-08-01",
		nothingAsked: null,
		...over,
	}) as BudgetsStep;

/** The budgets step with nothing to ask: no category left, and the reason the step says (null when it was answered). */
const budgetsNothing = (nothingAsked: NothingAsked | null) =>
	budgetsAsked({ asks: [], nothingAsked });

/** A model: the pay, bills and budgets steps as the arguments say, with nothing else on the page. */
const modelOf = (over: Partial<FirstPageModel> = {}): FirstPageModel => ({
	drawn: 2,
	head: null,
	ledger: [],
	payAnswered: false,
	pay: [],
	keep: [],
	waiting: [],
	budgets: null,
	budgetsAnswered: false,
	watching: false,
	...over,
});

const PAY_ANSWERED = { payAnswered: true };
const BILLS_KEPT = {
	ledger: [{ id: "bills", text: "Bills · 1 kept, about $15 a month" }],
};
const BILL: BillSuggestion = {
	rawName: "NETFLIX",
	displayName: "Netflix",
	amountCents: 1549,
	dueDay: 5,
	categoryId: 1,
} as BillSuggestion;

const stepsOf = (notes: SkippedNote[]) => notes.map((note) => note.step);

describe("skippedNotes", () => {
	it("draws nothing on the pay screen, the first question", () => {
		const pay = [{ key: "ACME", name: "Acme", deposits: [], ids: [] }];
		expect(skippedNotes(modelOf({ pay }))).toEqual([]);
	});

	it("draws the pay note on the bills screen when pay asked nothing", () => {
		expect(skippedNotes(modelOf({ keep: [BILL] }))).toEqual([skippedPay()]);
	});

	it("draws no note on the bills screen when pay asked something", () => {
		expect(skippedNotes(modelOf({ keep: [BILL], ...PAY_ANSWERED }))).toEqual(
			[],
		);
	});

	it("draws the bills note with its waiting count on the first budgets screen, after the pay note", () => {
		const notes = skippedNotes(
			modelOf({ budgets: budgetsAsked(), waiting: [BILL, BILL] }),
		);
		expect(notes).toEqual([skippedPay(), skippedBills(2)]);
	});

	it("draws only the bills note when pay asked something", () => {
		expect(
			skippedNotes(
				modelOf({ budgets: budgetsAsked(), ...PAY_ANSWERED, waiting: [] }),
			),
		).toEqual([skippedBills(0)]);
	});

	it("draws no note on a budgets screen when bills asked something, even with pay asking nothing", () => {
		expect(
			skippedNotes(modelOf({ budgets: budgetsAsked(), ...BILLS_KEPT })),
		).toEqual([]);
	});

	it("draws no note on a budgets screen once a category is answered, so later categories show none", () => {
		expect(
			skippedNotes(
				modelOf({
					budgets: budgetsAsked(),
					budgetsAnswered: true,
					...PAY_ANSWERED,
				}),
			),
		).toEqual([]);
		expect(
			skippedNotes(modelOf({ budgets: budgetsAsked(), budgetsAnswered: true })),
		).toEqual([]);
	});

	it("draws no note on the ruled-off total", () => {
		const done = { done: true, safeCents: 70000, nothingAsked: null } as const;
		expect(skippedNotes(modelOf({ budgets: done }))).toEqual([]);
	});

	it("draws nothing before the budgets step is read", () => {
		expect(skippedNotes(modelOf())).toEqual([]);
	});

	describe("the savings screen, the run ending at budgets", () => {
		// Each step asked something (true) or nothing (false), as the savings screen finds them.
		const cases: {
			pay: boolean;
			bills: boolean;
			budgets: boolean;
			notes: string[];
		}[] = [
			{ pay: true, bills: true, budgets: true, notes: [] },
			{ pay: true, bills: true, budgets: false, notes: ["Your budgets"] },
			{ pay: true, bills: false, budgets: true, notes: [] },
			{
				pay: true,
				bills: false,
				budgets: false,
				notes: ["Your bills", "Your budgets"],
			},
			{ pay: false, bills: true, budgets: true, notes: [] },
			{ pay: false, bills: true, budgets: false, notes: ["Your budgets"] },
			{ pay: false, bills: false, budgets: true, notes: [] },
			{
				pay: false,
				bills: false,
				budgets: false,
				notes: ["Your pay", "Your bills", "Your budgets"],
			},
		];
		it.each(cases)(
			"pay asked $pay, bills asked $bills, budgets asked $budgets: $notes",
			({ pay, bills, budgets, notes }) => {
				const model = modelOf({
					...(pay ? PAY_ANSWERED : {}),
					...(bills ? BILLS_KEPT : {}),
					budgets: budgetsNothing(budgets ? null : "every-category-budgeted"),
					budgetsAnswered: budgets,
					waiting: [],
				});
				expect(stepsOf(skippedNotes(model))).toEqual(notes);
			},
		);

		it("gives the no-categories reason its own words for the budgets note", () => {
			const notes = skippedNotes(
				modelOf({ budgets: budgetsNothing("no-categories") }),
			);
			expect(notes.at(-1)).toEqual(skippedBudgets("no-categories"));
		});

		it("counts the waiting charges on the bills note", () => {
			const notes = skippedNotes(
				modelOf({
					budgets: budgetsNothing("every-category-budgeted"),
					...PAY_ANSWERED,
					waiting: [BILL, BILL, BILL],
				}),
			);
			expect(notes).toEqual([
				skippedBills(3),
				skippedBudgets("every-category-budgeted"),
			]);
		});
	});
});
