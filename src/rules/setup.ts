// The setup area's rules (decisions 187, 206 and 209): the answers to the first-run questions about pay, bills, budgets
// and a savings goal (spec §8.8). Each takes a typed request and the question as the page reads it now, and is written
// as a list of its parts (`rule`, in ./terms). The person is an input (decision 195), and nothing here parses, reads a
// clock or touches the database. What a question still asks is the page's own read (src/first-tally/first-page.ts),
// handed in as a fact, so the page and the rule cannot disagree. The deposits, bills and budgets an answer writes have
// no cap, so the saves' SQL writes them and re-checks each row as it does (decision 209).
import * as Data from "effect/Data";
import type { BillSuggestion } from "../bills/find";
import { keepShown } from "../first-tally/bills";
import {
	type BudgetAsk,
	budgetsMonthChangedWords,
	budgetsMovedOnWords,
	keepShownBudgets,
} from "../first-tally/budgets";
import { type PayDeposit, payShown } from "../first-tally/pay";
import { rule, term, unless } from "./terms";

/** A merchant whose money in the pay question asks about, with the deposits behind it. */
export type AskedMerchant = {
	key: string;
	name: string;
	deposits: PayDeposit[];
	ids: number[];
};

/** A budget answer as the record keeps it. */
export type BudgetAnswer =
	| { kind: "suggested" | "another"; cents: number }
	| { kind: "skipped"; cents: null };

/** A typed amount as the edge read it: its cents, or the sentence that says why it is not an amount. */
export type TypedAmount = { cents: number } | { error: string };

// The refusals: one class each, with the sentence a person reads. Where the page names a merchant or a category in
// the sentence, the class says so.

export class QuestionsNotOpen extends Data.TaggedError("QuestionsNotOpen") {
	readonly say = "The setup questions are not open.";
}

/** The page names the merchant in this sentence. */
export class PayDepositsChanged extends Data.TaggedError("PayDepositsChanged") {
	readonly say =
		"Nothing saved. The deposits changed since the page drew, so the question is asked again below.";
}

export class BudgetsMonthChanged extends Data.TaggedError(
	"BudgetsMonthChanged",
) {
	readonly say = budgetsMonthChangedWords();
}

export class BudgetsMovedOn extends Data.TaggedError("BudgetsMovedOn") {
	readonly say = budgetsMovedOnWords();
}

/** The page names the category in this sentence. */
export class BudgetSuggestionChanged extends Data.TaggedError(
	"BudgetSuggestionChanged",
) {
	readonly say =
		"Nothing saved. The suggested budget changed since the page drew, so it is asked again below.";
}

/** The page shows the edge's own sentence for the amount typed. */
export class AmountRefused extends Data.TaggedError("AmountRefused") {
	readonly say = "Enter a dollar amount.";
}

const questionsAreOpen = unless(
	term<{ open: boolean }>("the setup questions are open", (g) => g.open),
	() => new QuestionsNotOpen(),
);

// Pay.

export type PayRequest = {
	merchantKey: string;
	answer: "yes" | "no";
	/** The deposits the form showed, as it carried them. */
	shown: string[];
	who: string;
};

export type PayFacts = {
	open: boolean;
	/** The merchant as the question asks about it now, or null when nothing is left to ask about it. */
	merchant: AskedMerchant | null;
};

export type PayWrite = {
	merchant: AskedMerchant;
	answer: "yes" | "no";
	who: string;
};

type PayGiven = PayRequest & PayFacts;

export const answerPay = rule({
	name: "Answer whether a merchant's money in is the family's pay",
	given: (request: PayRequest, facts: PayFacts): PayGiven => ({
		...request,
		...facts,
	}),
	nothingToDoIf: term<PayGiven>(
		"the questions are open and nothing is left to ask about the merchant",
		(g) => g.open && g.merchant === null,
	),
	refusals: [
		questionsAreOpen,
		unless(
			term<PayGiven>(
				"the deposits the form showed are the merchant's deposits now, each with its day and amount",
				(g) => g.merchant !== null && payShown(g.merchant, g.shown),
			),
			() => new PayDepositsChanged(),
		),
	],
	writes: (g): PayWrite => ({
		// SAFETY: the nothing-to-do term and the refusals answered a null merchant before `writes` runs.
		merchant: g.merchant as AskedMerchant,
		answer: g.answer,
		who: g.who,
	}),
	writesText:
		"Marks each deposit the question showed as income or not, as the person's own choice, and records the answer under the merchant.",
});

// Bills.

export type KeepBillsFacts = {
	open: boolean;
	/** The found charges the page can keep now. */
	keep: BillSuggestion[];
};

export type KeepBillsWrite = { keep: BillSuggestion[] };

export const keepFoundBills = rule({
	name: "Keep the bills Tally found",
	given: (request: { shown: string[] }, facts: KeepBillsFacts) => ({
		...request,
		...facts,
	}),
	refusals: [questionsAreOpen],
	// Only the charges the form showed are kept, each re-checked against the charges now: an empty form keeps none.
	writes: (g): KeepBillsWrite => ({ keep: keepShown(g.keep, g.shown) }),
	writesText:
		"Adds a bill for each found charge the form showed that is still found as it was shown, and draws the bills step.",
});

// Budgets.

/** The budgets question as the page reads it now: null when pay or bills still ask, or the step is done. */
export type AskedBudgets = {
	month: string;
	asks: BudgetAsk[];
	firstDate: string | null;
} | null;

export type BudgetsFacts = { open: boolean; step: AskedBudgets };

/** What a budgets answer saves: an answer for each category named, written against the history the step read. */
export type BudgetsWrite = {
	answers: { ask: BudgetAsk; answer: BudgetAnswer }[];
	firstDate: string | null;
};

type KeepAllGiven = { month: string; shown: string[] } & BudgetsFacts;

const formIsForThisMonth = unless(
	term<{ month: string; step: AskedBudgets }>(
		"the form was drawn in this household month",
		(g) => g.step !== null && g.month === g.step.month,
	),
	() => new BudgetsMonthChanged(),
);

export const keepAllBudgets = rule({
	name: "Keep all the budgets Tally suggests",
	given: (
		request: { month: string; shown: string[] },
		facts: BudgetsFacts,
	): KeepAllGiven => ({ ...request, ...facts }),
	nothingToDoIf: term<KeepAllGiven>(
		"the questions are open and the budgets question is not the one asked",
		(g) => g.open && g.step === null,
	),
	refusals: [questionsAreOpen, formIsForThisMonth],
	writes: (g): BudgetsWrite => ({
		// Only the suggestions the form showed are kept, each re-checked against the suggestion now.
		answers: keepShownBudgets(
			(g.step?.asks ?? []).filter((ask) => ask.suggestion !== null),
			g.shown,
		).flatMap((ask) =>
			ask.suggestion
				? [
						{
							ask,
							answer: {
								kind: "suggested" as const,
								cents: ask.suggestion.amountCents,
							},
						},
					]
				: [],
		),
		firstDate: g.step?.firstDate ?? null,
	}),
	writesText:
		"Keeps each suggested budget the form showed that is still suggested at that amount, from this month on.",
});

export type OneBudgetRequest = {
	month: string;
	categoryId: number;
	answer:
		| { kind: "yes"; shownCents: number }
		| { kind: "another"; typed: TypedAmount }
		| { kind: "skip" };
};

/** The answer as the record keeps it. A typed amount that is not one was refused before this is asked, so its cents are there. */
function keptAnswer(answer: OneBudgetRequest["answer"]): BudgetAnswer {
	if (answer.kind === "skip") return { kind: "skipped", cents: null };

	if (answer.kind === "yes")
		return { kind: "suggested", cents: answer.shownCents };

	return {
		kind: "another",
		cents: "cents" in answer.typed ? answer.typed.cents : 0,
	};
}

type OneBudgetGiven = OneBudgetRequest &
	BudgetsFacts & { ask: BudgetAsk | undefined };

export const answerOneBudget = rule({
	name: "Answer one category's budget question",
	given: (request: OneBudgetRequest, facts: BudgetsFacts): OneBudgetGiven => ({
		...request,
		...facts,
		ask: facts.step?.asks.find((ask) => ask.id === request.categoryId),
	}),
	nothingToDoIf: term<OneBudgetGiven>(
		"the questions are open and the budgets question is not the one asked, or the form is this month's and the category has its answer",
		(g) =>
			g.open &&
			(g.step === null || (g.month === g.step.month && g.ask === undefined)),
	),
	refusals: [
		questionsAreOpen,
		formIsForThisMonth,
		// Only the question on the screen is answered: a stale tab's answer for another category writes nothing.
		unless(
			term<OneBudgetGiven>(
				"the category is the first one still asked",
				(g) => g.step?.asks[0]?.id === g.categoryId,
			),
			() => new BudgetsMovedOn(),
		),
		unless(
			term<OneBudgetGiven>(
				"a Yes is for the suggestion the page showed, at the amount it showed",
				(g) =>
					g.answer.kind !== "yes" ||
					g.ask?.suggestion?.amountCents === g.answer.shownCents,
			),
			() => new BudgetSuggestionChanged(),
		),
		unless(
			term<OneBudgetGiven>(
				"a typed amount is a dollar amount",
				(g) => g.answer.kind !== "another" || "cents" in g.answer.typed,
			),
			() => new AmountRefused(),
		),
	],
	writes: (g): BudgetsWrite => ({
		// SAFETY: the nothing-to-do term and the refusals answered a category that is not asked before `writes` runs.
		answers: [{ ask: g.ask as BudgetAsk, answer: keptAnswer(g.answer) }],
		firstDate: g.step?.firstDate ?? null,
	}),
	writesText:
		"Keeps the category's budget from this month on (the suggestion, or the amount typed), or keeps that it was skipped.",
});

// Savings.

export type SavingsRequest = {
	/** The month the form was drawn in, and the household month now. */
	formMonth: string;
	month: string;
	answer: { kind: "save"; typed: TypedAmount } | { kind: "skip" };
};

export type SavingsFacts = {
	open: boolean;
	/** Whether the savings question is the one the page asks now: pay, bills and budgets ask nothing, and it has no answer. */
	asked: boolean;
};

export type SavingsWrite = { month: string; goal: number | "skipped" };

type SavingsGiven = SavingsRequest & SavingsFacts;

export const answerSavings = rule({
	name: "Answer the savings goal question",
	given: (request: SavingsRequest, facts: SavingsFacts): SavingsGiven => ({
		...request,
		...facts,
	}),
	nothingToDoIf: term<SavingsGiven>(
		"the questions are open and the savings question is not the one asked",
		(g) => g.open && !g.asked,
	),
	refusals: [
		questionsAreOpen,
		unless(
			term<SavingsGiven>(
				"the form was drawn in this household month",
				(g) => g.formMonth === g.month,
			),
			() => new BudgetsMonthChanged(),
		),
		unless(
			term<SavingsGiven>(
				"a goal to save is a dollar amount above $0",
				(g) =>
					g.answer.kind !== "save" ||
					("cents" in g.answer.typed && g.answer.typed.cents > 0),
			),
			() => new AmountRefused(),
		),
	],
	writes: (g): SavingsWrite => ({
		month: g.month,
		goal:
			g.answer.kind === "save" && "cents" in g.answer.typed
				? g.answer.typed.cents
				: "skipped",
	}),
	writesText:
		"Keeps the goal from this month on, or keeps that it was skipped. A goal already set on Home stays as it is.",
});
