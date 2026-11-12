import { describe, expect, it } from "vitest";
import {
	acceptCategoryGuess,
	addMoreLikeThis,
	answerMoneyMaybe,
	answerNameSuggestion,
	type CreateFacts,
	type CreateRequest,
	type CreateWrite,
	chooseCategory,
	createFromSuggestion,
	dismissNewCategory,
	type FileFacts,
	fileInCategory,
	type MaybeFacts,
	type MoreFacts,
	type NameFacts,
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

describe("Answer a Maybe category with a category of your own", () => {
	/** The family's list: Groceries and Eating Out active, Pets archived, and a purchase the review asks about. */
	const HOUSE: FileFacts = {
		categories: [
			{ id: GROCERIES, name: "Groceries", archived: false, sortOrder: 1 },
			{ id: EATING_OUT, name: "Eating Out", archived: false, sortOrder: 2 },
			{ id: 9, name: "Pets", archived: true, sortOrder: 3 },
		],
		asked: true,
		mayPropose: true,
		confidence: 0.64,
		guessedCategoryId: GROCERIES,
		version: VERSION,
	};

	const FULL: FileFacts = {
		...HOUSE,
		categories: Array.from({ length: 50 }, (_, i) => ({
			id: i + 1,
			name: `Category ${i + 1}`,
			archived: false,
			sortOrder: i + 1,
		})),
	};

	const ask = (
		target: { categoryId: number } | { name: string },
		facts: FileFacts = HOUSE,
		typedByPerson = false,
	) =>
		answerOf(
			fileInCategory.decide({ ...answeredBy, target, typedByPerson }, facts),
		);

	const files = (
		categoryId: number | null,
		name: string,
		record: "yes" | "something_else",
		create: { color: string; sortOrder: number } | null = null,
	) =>
		write({
			...answeredBy,
			create: create && { name, nameKey: name.toLowerCase(), ...create },
			categoryId,
			name,
			record,
			confidence: 0.64,
			expectedVersion: VERSION,
		});

	it.each([
		[
			"files it in the category tapped",
			{ categoryId: EATING_OUT },
			files(EATING_OUT, "Eating Out", "something_else"),
		],
		[
			"records a Yes when the category tapped is Tally's guess",
			{ categoryId: GROCERIES },
			files(GROCERIES, "Groceries", "yes"),
		],
		[
			"files it in the active category with the typed name, as the family stored it",
			{ name: "eating out" },
			files(EATING_OUT, "Eating Out", "something_else"),
		],
		[
			"makes a new category for a new name, at the end with the next colour",
			{ name: "Travel" },
			files(null, "Travel", "something_else", {
				color: "cat-ochre",
				sortOrder: 4,
			}),
		],
		["refuses a tapped category that is archived", { categoryId: 9 }, GONE],
		["refuses a tapped category that does not exist", { categoryId: 99 }, GONE],
		[
			"refuses Jev's reserved name",
			{ name: "None of these fit" },
			refuse("NameReserved", "That name is reserved for Tally. Pick another."),
		],
		[
			"refuses a name an archived category has",
			{ name: "pets" },
			refuse(
				"NameArchived",
				"An archived category has that name. Restore it instead.",
			),
		],
	])("%s", (_story, target, answer) => {
		expect(ask(target)).toEqual(answer);
	});

	it("refuses a 51st active category, and still adds to one the family has", () => {
		expect(ask({ name: "Travel" }, FULL)).toEqual(
			refuse(
				"ListFull",
				"Tally has room for 50 categories. Archive one to add another.",
			),
		);
		expect(ask({ name: "category 7" }, FULL)).toMatchObject({
			kind: "write",
			save: { categoryId: 7, create: null },
		});
	});

	it("says the question was answered before it says the list is full", () => {
		expect(ask({ name: "Travel" }, { ...FULL, asked: false })).toEqual(
			ANSWERED,
		);
	});

	it("refuses Tally's own proposal for a store with a Never suggest line, and not a name the person typed", () => {
		const hidden = { ...HOUSE, mayPropose: false };

		expect(ask({ name: "Travel" }, hidden)).toEqual(ANSWERED);
		expect(ask({ name: "Travel" }, hidden, true)).toMatchObject({
			kind: "write",
		});
	});
});

describe("Add the purchases that look like the one just filed", () => {
	const FILED: MoreFacts = {
		filed: {
			categoryId: GROCERIES,
			categoryName: "Groceries",
			archived: false,
		},
		ticked: [
			{ id: 11, waiting: true },
			{ id: 12, waiting: false },
			{ id: 13, waiting: true },
		],
		version: VERSION,
	};

	const request = { filedId: 7, categoryId: GROCERIES, who: WHO };

	const ask = (facts: MoreFacts) =>
		answerOf(addMoreLikeThis.decide(request, facts));

	const CHANGED = refuse(
		"CardChanged",
		"That purchase was changed somewhere else, so nothing moved.",
	);

	it("files the ticked purchases that still wait, and counts the ones someone decided", () => {
		expect(ask(FILED)).toEqual(
			write({
				...request,
				name: "Groceries",
				move: [11, 13],
				skipped: 1,
				expectedVersion: VERSION,
			}),
		);
	});

	it("moves nothing when nothing ticked looks like it", () => {
		expect(ask({ ...FILED, ticked: [] })).toMatchObject({
			save: { move: [], skipped: 0 },
		});
	});

	it.each([
		[
			"the purchase is gone, or no person filed it",
			{ ...FILED, filed: null },
			ANSWERED,
		],
		[
			"the purchase moved to another category",
			{
				...FILED,
				filed: {
					categoryId: EATING_OUT,
					categoryName: "Eating Out",
					archived: false,
				},
			},
			CHANGED,
		],
		[
			"its category was archived",
			{
				...FILED,
				filed: {
					categoryId: GROCERIES,
					categoryName: "Groceries",
					archived: true,
				},
			},
			CHANGED,
		],
	])("refuses when %s", (_story, facts, answer) => {
		expect(ask(facts)).toEqual(answer);
	});
});

describe("Answer a suggested name for a merchant", () => {
	const KEY = "BLUE BOTTLE COF";

	const WAITING: NameFacts = {
		suggestion: {
			status: "pending",
			namesAsked: false,
			names: ["Blue Bottle Coffee", "Blue Bottle"],
		},
		named: false,
		version: VERSION,
	};

	const ask = (
		choice: { kind: "name"; name: string } | { kind: "keep" },
		facts: NameFacts = WAITING,
	) =>
		answerOf(
			answerNameSuggestion.decide(
				{ merchantKey: KEY, choice, today: TODAY },
				facts,
			),
		);

	const settles = (
		status: string,
		displayName: string | null,
		logKeptGuess: boolean,
	) =>
		write({
			merchantKey: KEY,
			status,
			displayName,
			logKeptGuess,
			today: TODAY,
			expectedVersion: VERSION,
		});

	it.each([
		[
			"accepts a name Tally offered, and logs the kept guess",
			{ kind: "name", name: "Blue Bottle" },
			settles("accepted", "Blue Bottle", true),
		],
		[
			"turns the suggestion down for a name of the person's own",
			{ kind: "name", name: "Coffee place" },
			settles("rejected", "Coffee place", true),
		],
		[
			"turns the suggestion down and sets no name for Keep the bank's",
			{ kind: "keep" },
			settles("rejected", null, false),
		],
	] as const)("%s", (_story, choice, answer) => {
		expect(ask(choice)).toEqual(answer);
	});

	it.each<[string, NameFacts]>([
		[
			"the suggestion was already accepted",
			{
				...WAITING,
				suggestion: {
					status: "accepted",
					namesAsked: false,
					names: ["Blue Bottle"],
				},
			},
		],
		[
			"Tally has no suggestion for the merchant",
			{
				...WAITING,
				suggestion: { status: "none", namesAsked: true, names: [] },
			},
		],
		["there is no such merchant", { ...WAITING, suggestion: null }],
		["a person already chose a name", { ...WAITING, named: true }],
	])("refuses when %s", (_story, facts) => {
		expect(ask({ kind: "keep" }, facts)).toEqual(ANSWERED);
	});
});

describe("Say Yes to a suggested new category", () => {
	/** "Pet Care" waits, holding purchases 11, 12 and 13; the family has Groceries, Eating Out and an archived Pets. */
	const WAITING: CreateFacts = {
		suggestion: { status: "pending", name: "Pet Care" },
		suggested: [11, 12, 13],
		categories: [
			{ id: GROCERIES, name: "Groceries", archived: false, sortOrder: 1 },
			{ id: EATING_OUT, name: "Eating Out", archived: false, sortOrder: 2 },
			{ id: 9, name: "Pets", archived: true, sortOrder: 3 },
		],
		version: VERSION,
	};

	const named = (name: string): CreateFacts => ({
		...WAITING,
		suggestion: { status: "pending", name },
	});

	const full = (facts: CreateFacts): CreateFacts => ({
		...facts,
		categories: [
			...Array.from({ length: 50 }, (_, i) => ({
				id: 100 + i,
				name: `Category ${i + 1}`,
				archived: false,
				sortOrder: i + 1,
			})),
			{ id: 9, name: "Pets", archived: true, sortOrder: 51 },
		],
	});

	const request: CreateRequest = {
		suggestionId: 5,
		shown: [11, 12, 13],
		ticked: [13, 11],
		notes: { 12: "  the vet  ", 11: "ignored: it is ticked" },
		whole: false,
		today: TODAY,
		who: WHO,
	};

	const ask = (facts: CreateFacts, changes: Partial<CreateRequest> = {}) =>
		answerOf(createFromSuggestion.decide({ ...request, ...changes }, facts));

	const saves = (category: CreateWrite["category"]) =>
		write({
			suggestionId: 5,
			status: "created",
			category,
			file: [11, 13],
			leftOut: [12],
			notes: [{ id: 12, note: "the vet" }],
			who: WHO,
			expectedVersion: VERSION,
		});

	const NOTHING = refuse(
		"NothingTicked",
		"Tick at least one transaction, or say No to this suggestion.",
	);

	it.each([
		[
			"makes the category, files the ticked purchases and keeps the unticked one's note",
			WAITING,
			saves({
				kind: "create",
				name: "Pet Care",
				nameKey: "pet care",
				color: "cat-ochre",
				sortOrder: 4,
			}),
		],
		[
			"adds them to the active category with that name, as the family stored it",
			named("eating out"),
			saves({ kind: "attach", id: EATING_OUT, name: "Eating Out" }),
		],
		[
			"brings back an archived category with that name, at the end of the active list",
			named("PETS"),
			saves({ kind: "restore", id: 9, name: "Pets", sortOrder: 3, on: TODAY }),
		],
	])("%s", (_story, facts, answer) => {
		expect(ask(facts)).toEqual(answer);
	});

	it("files only ticked purchases the suggestion still holds, each once", () => {
		expect(
			ask({ ...WAITING, suggested: [11, 12] }, { ticked: [11, 11, 13, 99] }),
		).toMatchObject({ save: { file: [11], leftOut: [12] } });
	});

	it.each([
		[
			"a suggestion that was already answered",
			{ ...WAITING, suggestion: { status: "dismissed", name: "Pet Care" } },
			{},
			refuse(
				"SuggestionChanged",
				"That suggestion was changed somewhere else. Here's the current list.",
			),
		],
		["nothing ticked", WAITING, { ticked: [] }, NOTHING],
		[
			"ticks the suggestion no longer holds",
			{ ...WAITING, suggested: [12] },
			{},
			NOTHING,
		],
		[
			"Organize's Create when a shown purchase is no longer suggested",
			{ ...WAITING, suggested: [11, 13] },
			{ whole: true },
			NOTHING,
		],
		[
			"a note that is too long",
			WAITING,
			{ notes: { 12: "x".repeat(501) } },
			refuse("NoteTooLong", "Keep each note under 500 characters."),
		],
		[
			"a 51st active category",
			full(WAITING),
			{},
			refuse(
				"ListFull",
				"Tally has room for 50 categories. Archive one to add another.",
			),
		],
		[
			"bringing a category back into a full list",
			full(named("Pets")),
			{},
			refuse(
				"ListFull",
				"Tally has room for 50 categories. Archive one to restore another.",
			),
		],
	])("refuses %s", (_story, facts, changes, answer) => {
		expect(ask(facts, changes)).toEqual(answer);
	});

	it("still adds to an active category when the list is full", () => {
		expect(ask(full(named("category 7")))).toMatchObject({
			save: { category: { kind: "attach", id: 106 } },
		});
	});
});
