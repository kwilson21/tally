import { describe, expect, it } from "vitest";
import type { BillSuggestion } from "../src/bills/find";
import { shownBillValue } from "../src/first-tally/bills";
import { type BudgetAsk, shownBudgetValue } from "../src/first-tally/budgets";
import { shownPayValues } from "../src/first-tally/pay";
import {
	type AskedBudgets,
	type AskedMerchant,
	answerOneBudget,
	answerPay,
	answerSavings,
	keepAllBudgets,
	keepFoundBills,
	type OneBudgetRequest,
} from "../src/rules/setup";
import { answerOf, nothingToDo, refuse, write } from "./helpers/rule-answers";

// The setup area's rules as stories (decisions 187, 206): each row is what was asked, what the question asks now, and
// what the rule answers. The person is an input (decision 195); nothing here touches a clock or a database.

const NOT_OPEN = refuse(
	"QuestionsNotOpen",
	"The setup questions are not open.",
);

const MONTH_CHANGED = refuse(
	"BudgetsMonthChanged",
	"Nothing saved. The month changed since the page drew, so the question is asked again below.",
);

describe("Answer whether a merchant's money in is the family's pay", () => {
	const ACME: AskedMerchant = {
		key: "ACME PAYROLL",
		name: "Acme Payroll",
		deposits: [
			{ date: "2026-10-01", cents: 250_000 },
			{ date: "2026-10-15", cents: 250_000 },
		],
		ids: [11, 12],
	};

	const ask = (
		shown: string[],
		merchant: AskedMerchant | null = ACME,
		open = true,
	) =>
		answerOf(
			answerPay.decide(
				{ merchantKey: ACME.key, answer: "yes", shown, who: "me" },
				{ open, merchant },
			),
		);

	const CHANGED = refuse(
		"PayDepositsChanged",
		"Nothing saved. The deposits changed since the page drew, so the question is asked again below.",
	);

	it("saves the answer for the deposits the page showed", () => {
		expect(ask(shownPayValues(ACME))).toEqual(
			write({ merchant: ACME, answer: "yes", who: "me" }),
		);
	});

	it.each([
		[
			"has nothing to do when nothing is left to ask about the merchant",
			shownPayValues(ACME),
			null,
			true,
			nothingToDo(),
		],
		[
			"refuses when the questions are not open",
			shownPayValues(ACME),
			ACME,
			false,
			NOT_OPEN,
		],
		[
			"refuses when the questions are not open, even with nothing left to ask",
			shownPayValues(ACME),
			null,
			false,
			NOT_OPEN,
		],
		[
			"refuses when a deposit arrived since the page drew",
			shownPayValues(ACME).slice(0, 1),
			ACME,
			true,
			CHANGED,
		],
		[
			"refuses when a shown deposit's amount changed",
			shownPayValues({
				...ACME,
				deposits: [
					{ date: "2026-10-01", cents: 1 },
					{ date: "2026-10-15", cents: 250_000 },
				],
			}),
			ACME,
			true,
			CHANGED,
		],
	])("%s", (_story, shown, merchant, open, answer) => {
		expect(ask(shown, merchant, open)).toEqual(answer);
	});
});

describe("Keep the bills Tally found", () => {
	const bill = (rawName: string, amountCents: number): BillSuggestion => ({
		rawName,
		bankText: rawName,
		displayName: rawName,
		amountCents,
		dueDay: 5,
		categoryId: 3,
		chargeCount: 3,
	});

	const NETFLIX = bill("NETFLIX", 1599);
	const GYM = bill("GYM", 4000);

	const ask = (shown: string[], keep: BillSuggestion[], open = true) =>
		answerOf(keepFoundBills.decide({ shown }, { open, keep }));

	it.each([
		[
			"keeps the charges the form showed",
			[NETFLIX, GYM],
			[NETFLIX, GYM],
			write({ keep: [NETFLIX, GYM] }),
		],
		[
			"leaves out a charge found since the page drew",
			[NETFLIX],
			[NETFLIX, GYM],
			write({ keep: [NETFLIX] }),
		],
		[
			"leaves out a charge whose amount changed",
			[bill("GYM", 3500)],
			[GYM],
			write({ keep: [] }),
		],
		["keeps none for an empty form", [], [NETFLIX], write({ keep: [] })],
	])("%s", (_story, shown, keep, answer) => {
		expect(ask(shown.map(shownBillValue), keep)).toEqual(answer);
	});

	it("refuses when the questions are not open", () => {
		expect(ask([shownBillValue(NETFLIX)], [NETFLIX], false)).toEqual(NOT_OPEN);
	});
});

const budgetAsk = (
	id: number,
	name: string,
	cents: number | null,
): BudgetAsk => ({
	id,
	name,
	icon: "tag",
	color: "cat-blue",
	months: [],
	suggestion: cents === null ? null : { amountCents: cents, months: [] },
});

const GROCERIES = budgetAsk(1, "Groceries", 60_000);
const GAS = budgetAsk(2, "Gas", 12_000);
const PETS = budgetAsk(3, "Pets", null);

const STEP: AskedBudgets = {
	month: "2026-11",
	asks: [GROCERIES, GAS, PETS],
	firstDate: "2026-08-01",
};

describe("Keep all the budgets Tally suggests", () => {
	const ask = (
		shown: BudgetAsk[],
		step: AskedBudgets = STEP,
		month = "2026-11",
	) =>
		answerOf(
			keepAllBudgets.decide(
				{ month, shown: shown.map(shownBudgetValue) },
				{ open: true, step },
			),
		);

	const keeps = (...asks: BudgetAsk[]) =>
		write({
			answers: asks.map((a) => ({
				ask: a,
				answer: { kind: "suggested", cents: a.suggestion?.amountCents },
			})),
			firstDate: "2026-08-01",
		});

	it.each([
		[
			"keeps each suggestion the form showed",
			[GROCERIES, GAS],
			STEP,
			"2026-11",
			keeps(GROCERIES, GAS),
		],
		[
			"leaves out a suggestion whose amount moved",
			[budgetAsk(1, "Groceries", 50_000), GAS],
			STEP,
			"2026-11",
			keeps(GAS),
		],
		[
			"never keeps a category with no suggestion",
			[PETS],
			STEP,
			"2026-11",
			keeps(),
		],
		[
			"has nothing to do when the budgets question is not the one asked",
			[GROCERIES],
			null,
			"2026-11",
			nothingToDo(),
		],
		[
			"refuses a form drawn in another month",
			[GROCERIES],
			STEP,
			"2026-10",
			MONTH_CHANGED,
		],
	])("%s", (_story, shown, step, month, answer) => {
		expect(ask(shown, step, month)).toEqual(answer);
	});
});

describe("Answer one category's budget question", () => {
	const ask = (
		categoryId: number,
		answer: OneBudgetRequest["answer"],
		step: AskedBudgets = STEP,
		month = "2026-11",
	) =>
		answerOf(
			answerOneBudget.decide(
				{ month, categoryId, answer },
				{ open: true, step },
			),
		);

	const keeps = (kind: string, cents: number | null) =>
		write({
			answers: [{ ask: GROCERIES, answer: { kind, cents } }],
			firstDate: "2026-08-01",
		});

	const MOVED = refuse(
		"BudgetsMovedOn",
		"Nothing saved. The categories changed since the page drew, so the next one is asked below.",
	);

	it.each([
		[
			"keeps the suggestion on a Yes",
			1,
			{ kind: "yes", shownCents: 60_000 },
			keeps("suggested", 60_000),
		],
		[
			"keeps another amount",
			1,
			{ kind: "another", typed: { cents: 45_000 } },
			keeps("another", 45_000),
		],
		["keeps a skip", 1, { kind: "skip" }, keeps("skipped", null)],
		[
			"has nothing to do for a category that has its answer",
			9,
			{ kind: "skip" },
			nothingToDo(),
		],
		[
			"refuses an answer for a category that is not the first one asked",
			2,
			{ kind: "skip" },
			MOVED,
		],
		[
			"refuses a Yes when the suggestion moved since the page drew",
			1,
			{ kind: "yes", shownCents: 50_000 },
			refuse(
				"BudgetSuggestionChanged",
				"Nothing saved. The suggested budget changed since the page drew, so it is asked again below.",
			),
		],
		[
			"refuses a typed amount that is not a dollar amount",
			1,
			{ kind: "another", typed: { error: "Enter an amount." } },
			refuse("AmountRefused", "Enter a dollar amount."),
		],
	] as const)("%s", (_story, categoryId, answer, expected) => {
		expect(ask(categoryId, answer)).toEqual(expected);
	});

	it("has nothing to do when the budgets question is not the one asked", () => {
		expect(ask(1, { kind: "skip" }, null)).toEqual(nothingToDo());
	});

	it("says the month changed before it looks for the category", () => {
		expect(ask(9, { kind: "skip" }, STEP, "2026-10")).toEqual(MONTH_CHANGED);
	});
});

describe("Answer the savings goal question", () => {
	const ask = (
		answer:
			| { kind: "save"; typed: { cents: number } | { error: string } }
			| { kind: "skip" },
		asked = true,
		formMonth = "2026-11",
	) =>
		answerOf(
			answerSavings.decide(
				{ formMonth, month: "2026-11", answer },
				{ open: true, asked },
			),
		);

	const REFUSED = refuse("AmountRefused", "Enter a dollar amount.");

	it.each([
		[
			"keeps the goal",
			{ kind: "save", typed: { cents: 30_000 } },
			true,
			"2026-11",
			write({ month: "2026-11", goal: 30_000 }),
		],
		[
			"keeps a skip",
			{ kind: "skip" },
			true,
			"2026-11",
			write({ month: "2026-11", goal: "skipped" }),
		],
		[
			"has nothing to do when the savings question is not the one asked",
			{ kind: "skip" },
			false,
			"2026-11",
			nothingToDo(),
		],
		[
			"refuses a form drawn in another month",
			{ kind: "skip" },
			true,
			"2026-10",
			MONTH_CHANGED,
		],
		[
			"refuses a goal of $0",
			{ kind: "save", typed: { cents: 0 } },
			true,
			"2026-11",
			REFUSED,
		],
		[
			"refuses an amount that is not one",
			{ kind: "save", typed: { error: "Enter an amount." } },
			true,
			"2026-11",
			REFUSED,
		],
	] as const)("%s", (_story, answer, asked, formMonth, expected) => {
		expect(ask(answer, asked, formMonth)).toEqual(expected);
	});
});
