// The organize area's rules (decisions 187, 206 and 209): file a store's charges in a category, and make that category
// the store's rule. Each takes a typed request and what is stored, and is written as a list of its parts (`rule`, in
// ./terms). The person is an input (decision 195), and nothing here parses, reads a clock or touches the database.
// A store's charges have no cap, so the saves' SQL files them (decision 209); the rules decide the command's answer.
// The saves are in src/transactions/organize.ts (decision 190).
import * as Data from "effect/Data";
import { COLORS, nameKey } from "../settings/category-form";
import { nameSource } from "../transactions/name-suggestions";
import {
	active,
	type CategoryFacts,
	hasRoom,
	lastPlace,
	listHasRoom,
	nameChecks,
	nameIsNotReserved,
	noArchivedCategoryHasTheName,
	noOtherCategoryHasTheName,
} from "./categories";
import { rule, term, unless } from "./terms";

export type FileGroupRequest = {
	/** The store's merchant keys, as Organize's list grouped them, each once. */
	merchantKeys: string[];
	/** The name Organize's list shows for the store. */
	groupName: string;
	/** The category chosen from the list, or the name typed for a new one. */
	target: { categoryId: number } | { name: string };
	/** The name typed for the store. Empty leaves its name as it is. */
	displayName: string;
	who: string;
};

export type FileGroupFacts = CategoryFacts & {
	/** How many of the store's charges still need a category. */
	waiting: number;
};

/** What the rule saves: the new category when one is made, where the charges go, and the store's name when it changes. */
export type FileGroupWrite = {
	merchantKeys: string[];
	create: {
		name: string;
		nameKey: string;
		color: string;
		sortOrder: number;
	} | null;
	/** The category the charges go in when the family already has it. Null when it is the one made here. */
	categoryId: number | null;
	categoryName: string;
	/** The store's new name, or null to leave it. */
	displayName: string | null;
	/** The merchant keys for which that name is Tally's guess kept by a person, which the AI log counts once (spec §8.6). */
	keptGuessFor: string[];
	who: string;
	expectedVersion: string;
};

export class GroupAlreadyFiled extends Data.TaggedError("GroupAlreadyFiled") {
	readonly say = "That merchant already has a category.";
}

export class CategoryNotListed extends Data.TaggedError("CategoryNotListed") {
	readonly say = "Pick a category from the list.";
}

export const fileGroup = rule({
	name: "File a store's charges in a category",
	given: (request: FileGroupRequest, facts: FileGroupFacts) => {
		const { target } = request;
		const named = "name" in target;

		const chosen = named
			? undefined
			: active(facts).find((c) => c.id === target.categoryId);

		const displayName =
			request.displayName !== "" && request.displayName !== request.groupName
				? request.displayName
				: null;

		return {
			...request,
			...(named
				? nameChecks(target.name, facts, null)
				: { reserved: false, archivedHasName: false, activeHasName: false }),
			waiting: facts.waiting,
			listed: named || chosen !== undefined,
			room: !named || hasRoom(facts),
			create: named
				? {
						name: target.name,
						nameKey: nameKey(target.name),
						// SAFETY: COLORS is a fixed, non-empty list and the index is taken modulo its length, so the entry exists.
						color: COLORS[facts.categories.length % COLORS.length] as string,
						sortOrder: lastPlace(facts.categories) + 1,
					}
				: null,
			categoryId: chosen?.id ?? null,
			categoryName: chosen?.name ?? (named ? target.name : ""),
			newName: displayName,
			keptGuessFor:
				displayName === null
					? []
					: request.merchantKeys.filter(
							(key) => nameSource([displayName], key) === "tally",
						),
			version: facts.version,
		};
	},
	refusals: [
		unless(
			term<{ waiting: number }>(
				"at least one of the store's charges still needs a category",
				(g) => g.waiting > 0,
			),
			() => new GroupAlreadyFiled(),
		),
		unless(
			term<{ listed: boolean }>(
				"the chosen category is in the active list",
				(g) => g.listed,
			),
			() => new CategoryNotListed(),
		),
		nameIsNotReserved,
		noArchivedCategoryHasTheName,
		noOtherCategoryHasTheName,
		listHasRoom("add"),
	],
	writes: (g): FileGroupWrite => ({
		merchantKeys: g.merchantKeys,
		create: g.create,
		categoryId: g.categoryId,
		categoryName: g.categoryName,
		displayName: g.newName,
		keptGuessFor: g.keptGuessFor,
		who: g.who,
		expectedVersion: g.version,
	}),
	writesText:
		"Files every charge of the store that needs a category in the chosen category as the person's own choice, making the category first when a new name was typed, and names the store when a new name was given. It makes no rule.",
});

// Organize's question after a save (#353): "Always file this store here?"

export type StoreRuleRequest = { answer: "yes" | "not_now"; who: string };

export type StoreRuleFacts = {
	/** The question as it stands now: the store's charges a person filed in the category. Null when there are none. */
	offer: {
		categoryId: number;
		category: string;
		merchant: string;
		savedIds: number[];
	} | null;
	/** Whether one of those charges looks like a mixed trip, which is never asked about (decision 113). */
	mixed: boolean;
};

/** What the rule saves: the category as the rule of each merchant key of those charges. The save's SQL applies it to the store's other charges, whatever their number. */
export type StoreRuleWrite = {
	categoryId: number;
	category: string;
	merchant: string;
	savedIds: number[];
	who: string;
};

type StoreRuleGiven = StoreRuleRequest & StoreRuleFacts;

export const makeStoreRule = rule({
	name: "Answer Organize's question about a store",
	given: (
		request: StoreRuleRequest,
		facts: StoreRuleFacts,
	): StoreRuleGiven => ({
		...request,
		...facts,
	}),
	nothingToDoIf: term<StoreRuleGiven>(
		"the answer is Not now, or the store has no question to answer: none of its charges is filed there by a person, or one looks like a mixed trip",
		(g) => g.answer !== "yes" || g.offer === null || g.mixed,
	),
	refusals: [],
	writes: (g): StoreRuleWrite => ({
		// SAFETY: the nothing-to-do term answered a null offer before `writes` runs, so it is an offer here.
		...(g.offer as NonNullable<StoreRuleFacts["offer"]>),
		who: g.who,
	}),
	writesText:
		"Makes the category the rule of each merchant key of the store's charges filed there, and applies it to the store's charges no person has chosen.",
});
