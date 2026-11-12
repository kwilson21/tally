import { describe, expect, it } from "vitest";
import {
	acceptCategoryGuess,
	answerMoneyMaybe,
	chooseCategory,
	dismissNewCategory,
	type MaybeFacts,
	neverSuggestStores,
} from "../src/rules/suggestions";
import { answerOf, refuse, write } from "./helpers/rule-answers";

// The suggestions area's rules as stories (decisions 187, 206): each row is what was asked, what was stored, and what
// the rule answers. The date and the person are inputs (decision 195); nothing here touches a clock or a database.

const VERSION = "v1";
const TODAY = "2026-11-12";
const WHO = "person@example.com";
const GROCERIES = 3;
const EATING_OUT = 4;

/** A transaction the review asks about, 64% sure, guessed as Groceries. */
const ASKED: MaybeFacts = {
	asked: true,
	confidence: 0.64,
	guessedCategoryId: GROCERIES,
	chosen: null,
	version: VERSION,
};

const ANSWERED = refuse("AlreadyAnswered", "That one was already answered.");
const GONE = refuse("CategoryGone", "That category is gone. Choose another.");
const answeredBy = { transactionId: 7, today: TODAY, who: WHO };

describe("Answer a Maybe income or Maybe transfer", () => {
	it.each([
		["income", "yes"],
		["income", "no"],
		["transfer", "yes"],
		["transfer", "no"],
	] as const)("records a %s %s against the guess", (kind, answer) => {
		const request = { ...answeredBy, kind, answer };

		expect(answerOf(answerMoneyMaybe.decide(request, ASKED))).toEqual(
			write({ ...request, confidence: 0.64, expectedVersion: VERSION }),
		);
	});

	it.each([
		["the review no longer asks", { ...ASKED, asked: false }],
		["the guess is gone", { ...ASKED, confidence: null }],
	])("refuses when %s", (_story, facts) => {
		expect(
			answerOf(
				answerMoneyMaybe.decide(
					{ ...answeredBy, kind: "income", answer: "yes" },
					facts,
				),
			),
		).toEqual(ANSWERED);
	});
});

describe("Say Yes to a Maybe category", () => {
	const ask = (facts: MaybeFacts) =>
		answerOf(
			acceptCategoryGuess.decide(
				{ ...answeredBy, categoryId: GROCERIES },
				facts,
			),
		);

	it("sets the guessed category and records a Yes", () => {
		expect(ask(ASKED)).toEqual(
			write({
				...answeredBy,
				categoryId: GROCERIES,
				record: "yes",
				confidence: 0.64,
				expectedVersion: VERSION,
			}),
		);
	});

	it.each([
		["the review no longer asks", { ...ASKED, asked: false }],
		[
			"Tally now guesses another category",
			{ ...ASKED, guessedCategoryId: EATING_OUT },
		],
	])("refuses when %s", (_story, facts) => {
		expect(ask(facts)).toEqual(ANSWERED);
	});
});

describe("Answer a Maybe category with Something else", () => {
	const ask = (categoryId: number, facts: MaybeFacts) =>
		answerOf(chooseCategory.decide({ ...answeredBy, categoryId }, facts));

	const chose = (id: number, archived = false): MaybeFacts => ({
		...ASKED,
		chosen: { id, name: "Chosen", archived },
	});

	const saves = (categoryId: number, record: "yes" | "something_else") =>
		write({
			...answeredBy,
			categoryId,
			record,
			confidence: 0.64,
			expectedVersion: VERSION,
		});

	it.each([
		[
			"sets another category and records Something else",
			EATING_OUT,
			chose(EATING_OUT),
			saves(EATING_OUT, "something_else"),
		],
		[
			"records a Yes when the chosen category is Tally's guess",
			GROCERIES,
			chose(GROCERIES),
			saves(GROCERIES, "yes"),
		],
		["refuses a category the family does not have", EATING_OUT, ASKED, GONE],
		["refuses an archived category", EATING_OUT, chose(EATING_OUT, true), GONE],
		[
			"refuses when the review no longer asks",
			EATING_OUT,
			{ ...chose(EATING_OUT), asked: false },
			ANSWERED,
		],
		[
			"says the category is gone before it says the question was answered",
			EATING_OUT,
			{ ...ASKED, asked: false },
			GONE,
		],
	])("%s", (_story, categoryId, facts, answer) => {
		expect(ask(categoryId, facts)).toEqual(answer);
	});
});

describe("Say Yes to never suggesting this for a store", () => {
	const ask = (stores: string[], asked: string[]) =>
		answerOf(
			neverSuggestStores.decide(
				{ kind: "new_category", itemId: 5, stores, today: TODAY },
				{ asked, version: VERSION },
			),
		);

	const keeps = (...stores: string[]) =>
		write({
			kind: "new_category",
			itemId: 5,
			stores,
			today: TODAY,
			expectedVersion: VERSION,
		});

	it.each([
		[
			"keeps a line for each store",
			["petco", "chewy"],
			["petco", "chewy"],
			keeps("petco", "chewy"),
		],
		[
			"leaves out a store the question does not ask about",
			["petco", "costco"],
			["petco", "chewy"],
			keeps("petco"),
		],
		[
			"refuses when the question asks about none of them",
			["costco"],
			["petco"],
			ANSWERED,
		],
		["refuses when the question is no longer asked", ["petco"], [], ANSWERED],
	])("%s", (_story, stores, asked, answer) => {
		expect(ask(stores, asked)).toEqual(answer);
	});
});

describe("Say No to a suggested new category", () => {
	const ask = (status: string | null) =>
		answerOf(
			dismissNewCategory.decide(
				{ suggestionId: 5 },
				{ status, name: "Pet Care" },
			),
		);

	const CHANGED = refuse(
		"SuggestionChanged",
		"That suggestion was changed somewhere else. Here's the current list.",
	);

	it("dismisses a waiting suggestion", () => {
		expect(ask("pending")).toEqual(
			write({
				suggestionId: 5,
				status: "dismissed",
				expectedStatus: "pending",
			}),
		);
	});

	it.each([
		["one already made", "created"],
		["one already dismissed", "dismissed"],
		["one that is gone", "none"],
		["one that does not exist", null],
	])("refuses %s", (_story, status) => {
		expect(ask(status)).toEqual(CHANGED);
	});
});
