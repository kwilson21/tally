import { describe, expect, it } from "vitest";
import {
	type FileGroupFacts,
	type FileGroupRequest,
	fileGroup,
	makeStoreRule,
	type StoreRuleFacts,
} from "../src/rules/organize";
import { answerOf, nothingToDo, refuse, write } from "./helpers/rule-answers";

// The organize area's rules as stories (decisions 187, 206): each row is what was asked, what was stored, and what the
// rule answers. The person is an input (decision 195); nothing here touches a clock or a database.

const VERSION = "v1";
const WHO = "person@example.com";
const GROCERIES = 3;

/** Groceries and Eating Out active, Pets archived, and a store with four charges that need a category. */
const HOUSE: FileGroupFacts = {
	categories: [
		{ id: GROCERIES, name: "Groceries", archived: false, sortOrder: 1 },
		{ id: 4, name: "Eating Out", archived: false, sortOrder: 2 },
		{ id: 9, name: "Pets", archived: true, sortOrder: 3 },
	],
	waiting: 4,
	version: VERSION,
};

const FULL: FileGroupFacts = {
	...HOUSE,
	categories: Array.from({ length: 50 }, (_, i) => ({
		id: i + 1,
		name: `Category ${i + 1}`,
		archived: false,
		sortOrder: i + 1,
	})),
};

const request: FileGroupRequest = {
	merchantKeys: ["TRADER JOES #552", "TRADER JOES #19"],
	groupName: "Trader joes",
	target: { categoryId: GROCERIES },
	displayName: "",
	who: WHO,
};

describe("File a store's charges in a category", () => {
	const ask = (
		changes: Partial<FileGroupRequest> = {},
		facts: FileGroupFacts = HOUSE,
	) => answerOf(fileGroup.decide({ ...request, ...changes }, facts));

	const files = {
		merchantKeys: request.merchantKeys,
		create: null,
		categoryId: GROCERIES,
		categoryName: "Groceries",
		displayName: null,
		keptGuessFor: [],
		who: WHO,
		expectedVersion: VERSION,
	};

	it("files the store in the chosen category and leaves its name", () => {
		expect(ask()).toEqual(write(files));
	});

	it("leaves the name when the one typed is the name the list already shows", () => {
		expect(ask({ displayName: "Trader joes" })).toEqual(write(files));
	});

	it("names the store, and counts the name as a kept guess for each of its keys", () => {
		expect(ask({ displayName: "Trader Joe's" })).toEqual(
			write({
				...files,
				displayName: "Trader Joe's",
				keptGuessFor: request.merchantKeys,
			}),
		);
	});

	it("makes a new category for a typed name, at the end with the next colour", () => {
		expect(ask({ target: { name: "Travel" } })).toEqual(
			write({
				...files,
				create: {
					name: "Travel",
					nameKey: "travel",
					color: "cat-ochre",
					sortOrder: 4,
				},
				categoryId: null,
				categoryName: "Travel",
			}),
		);
	});

	it.each([
		[
			"a store another save already filed",
			{},
			{ ...HOUSE, waiting: 0 },
			refuse("GroupAlreadyFiled", "That merchant already has a category."),
		],
		[
			"a category that is archived",
			{ target: { categoryId: 9 } },
			HOUSE,
			refuse("CategoryNotListed", "Pick a category from the list."),
		],
		[
			"a category that does not exist",
			{ target: { categoryId: 99 } },
			HOUSE,
			refuse("CategoryNotListed", "Pick a category from the list."),
		],
		[
			"Jev's reserved name",
			{ target: { name: "None of these fit" } },
			HOUSE,
			refuse("NameReserved", "That name is reserved for Tally. Pick another."),
		],
		[
			"a new name an archived category has",
			{ target: { name: "pets" } },
			HOUSE,
			refuse(
				"NameArchived",
				"An archived category has that name. Restore it instead.",
			),
		],
		[
			"a new name an active category has",
			{ target: { name: "groceries" } },
			HOUSE,
			refuse("NameTaken", "That name is taken."),
		],
		[
			"a 51st active category",
			{ target: { name: "Travel" } },
			FULL,
			refuse(
				"ListFull",
				"Tally has room for 50 categories. Archive one to add another.",
			),
		],
	])("refuses %s", (_story, changes, facts, answer) => {
		expect(ask(changes, facts)).toEqual(answer);
	});

	it("says the store was already filed before anything about the category", () => {
		expect(
			ask({ target: { categoryId: 99 } }, { ...HOUSE, waiting: 0 }),
		).toMatchObject({ type: "GroupAlreadyFiled" });
	});
});

describe("Answer Organize's question about a store", () => {
	const ASKED: StoreRuleFacts = {
		offer: {
			categoryId: GROCERIES,
			category: "Groceries",
			merchant: "Trader Joe's",
			savedIds: [11, 12],
		},
		mixed: false,
	};

	const ask = (answer: "yes" | "not_now", facts: StoreRuleFacts = ASKED) =>
		answerOf(makeStoreRule.decide({ answer, who: WHO }, facts));

	it("makes the rule on a Yes", () => {
		expect(ask("yes")).toEqual(
			write({
				categoryId: GROCERIES,
				category: "Groceries",
				merchant: "Trader Joe's",
				savedIds: [11, 12],
				who: WHO,
			}),
		);
	});

	it.each([
		["Not now", "not_now", ASKED],
		[
			"a Yes when the store has no charges filed there",
			"yes",
			{ offer: null, mixed: false },
		],
		["a Yes when a trip looks mixed", "yes", { ...ASKED, mixed: true }],
	] as const)("has nothing to do for %s", (_story, answer, facts) => {
		expect(ask(answer, facts)).toEqual(nothingToDo());
	});
});
