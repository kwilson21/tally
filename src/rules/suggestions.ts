// The suggestions area's rules (decisions 187, 206 and 209): the answers to the review's questions. Each takes a typed
// request and what is stored about the item it answers, and is written as a list of its parts (`rule`, in ./terms).
// The household's date and the person are inputs (decision 195), and nothing here parses, reads a clock or touches the
// database. Whether the review still asks a question is the queue's own check (src/db/suggestions-queue.ts), read as a
// fact, so the page and the rule cannot disagree. The saves' guards are in src/db/suggestion-saves.ts (decision 190).
import * as Data from "effect/Data";
import { categorySuggestionMachine } from "../machines/category-suggestion";
import { next } from "../machines/next";
import { COLORS, nameKey, sameName } from "../settings/category-form";
import {
	active,
	type CategoryFacts,
	hasRoom,
	lastPlace,
	listHasRoom,
	nameChecks,
	nameIsNotReserved,
	noArchivedCategoryHasTheName,
} from "./categories";
import { rule, term, unless } from "./terms";

/** What a Maybe's rule reads about its transaction. */
export type MaybeFacts = {
	/** Whether the review still asks this question about the transaction. */
	asked: boolean;
	/** How sure Tally's guess is, as stored (0 to 1): what the answer is recorded against. Null when there is no guess. */
	confidence: number | null;
	/** The category Tally guessed, for a category question. */
	guessedCategoryId: number | null;
	/** The category the answer names, when it names one and the family has it. */
	chosen: { id: number; name: string; archived: boolean } | null;
	/** Stands for everything above as it was read. A save lands only while the stored rows still have this version. */
	version: string;
};

type Answered = {
	transactionId: number;
	/** The household's date (YYYY-MM-DD) the answer is recorded on. */
	today: string;
	who: string;
};

export type MoneyMaybeRequest = Answered & {
	kind: "income" | "transfer";
	answer: "yes" | "no";
};

/** What a money Maybe's rule saves: the answer's record, and the Yes or the No on the transaction. */
export type MoneyMaybeWrite = MoneyMaybeRequest & {
	confidence: number;
	expectedVersion: string;
};

export type CategoryMaybeRequest = Answered & {
	/** The category the card showed as Tally's guess (Yes), or the one the person chose (Something else). */
	categoryId: number;
};

/** What a category Maybe's rule saves: the answer's record, and the category the person set. */
export type CategoryMaybeWrite = CategoryMaybeRequest & {
	/** Yes when the category is Tally's guess, whichever button said so. */
	record: "yes" | "something_else";
	confidence: number;
	expectedVersion: string;
};

// The refusals: one class each, with the sentence a person reads.

export class AlreadyAnswered extends Data.TaggedError("AlreadyAnswered") {
	readonly say = "That one was already answered.";
}

export class CategoryGone extends Data.TaggedError("CategoryGone") {
	readonly say = "That category is gone. Choose another.";
}

// The terms, shared between the rules.

type Asked = { asked: boolean; confidence: number | null };

/** A question the review asks always has a guess; one with none is read as not asked. */
const stillAsked = unless(
	term<Asked>(
		"the review still asks this question",
		(g) => g.asked && g.confidence !== null,
	),
	() => new AlreadyAnswered(),
);

export const answerMoneyMaybe = rule({
	name: "Answer a Maybe income or Maybe transfer",
	given: (request: MoneyMaybeRequest, facts: MaybeFacts) => ({
		...request,
		asked: facts.asked,
		confidence: facts.confidence,
		version: facts.version,
	}),
	refusals: [stillAsked],
	writes: (g): MoneyMaybeWrite => ({
		kind: g.kind,
		answer: g.answer,
		transactionId: g.transactionId,
		today: g.today,
		who: g.who,
		// SAFETY: `stillAsked` refused a null confidence before `writes` runs, so it is a number here.
		confidence: g.confidence as number,
		expectedVersion: g.version,
	}),
	writesText:
		"Records the answer against Tally's guess. A Yes counts the money as income, or leaves the transfer out of the budget, as the person's own choice; a No only stops this one question.",
});

export const acceptCategoryGuess = rule({
	name: "Say Yes to a Maybe category",
	given: (request: CategoryMaybeRequest, facts: MaybeFacts) => ({
		...request,
		asked: facts.asked,
		confidence: facts.confidence,
		sameGuess: facts.guessedCategoryId === request.categoryId,
		version: facts.version,
	}),
	refusals: [
		stillAsked,
		unless(
			term<{ sameGuess: boolean }>(
				"Tally's guess is still the category the card showed",
				(g) => g.sameGuess,
			),
			() => new AlreadyAnswered(),
		),
	],
	writes: (g): CategoryMaybeWrite => ({
		transactionId: g.transactionId,
		categoryId: g.categoryId,
		today: g.today,
		who: g.who,
		record: "yes",
		// SAFETY: `stillAsked` refused a null confidence before `writes` runs, so it is a number here.
		confidence: g.confidence as number,
		expectedVersion: g.version,
	}),
	writesText:
		"Records a Yes against Tally's guess and sets the transaction to that category as the person's own choice.",
});

export const chooseCategory = rule({
	name: "Answer a Maybe category with Something else",
	given: (request: CategoryMaybeRequest, facts: MaybeFacts) => ({
		...request,
		asked: facts.asked,
		confidence: facts.confidence,
		active: facts.chosen?.id === request.categoryId && !facts.chosen.archived,
		record:
			facts.guessedCategoryId === request.categoryId
				? ("yes" as const)
				: ("something_else" as const),
		version: facts.version,
	}),
	refusals: [
		unless(
			term<{ active: boolean }>(
				"the chosen category is in the active list",
				(g) => g.active,
			),
			() => new CategoryGone(),
		),
		stillAsked,
	],
	writes: (g): CategoryMaybeWrite => ({
		transactionId: g.transactionId,
		categoryId: g.categoryId,
		today: g.today,
		who: g.who,
		record: g.record,
		// SAFETY: `stillAsked` refused a null confidence before `writes` runs, so it is a number here.
		confidence: g.confidence as number,
		expectedVersion: g.version,
	}),
	writesText:
		"Sets the transaction to the chosen category as the person's own choice, and records a Yes when that is Tally's guess and Something else when it is not.",
});

// The question after a No (decision 101): "Never suggest this for these stores again?"

export type NeverSuggestRequest = {
	kind: "income" | "transfer" | "new_category";
	/** The item's number: the transaction's, or the suggestion's for a new category. */
	itemId: number;
	/** The stores the form posted, each once. */
	stores: string[];
	/** The household's date (YYYY-MM-DD) the lines are decided on. */
	today: string;
};

export type NeverSuggestFacts = {
	/** The stores the question about this item still asks about. None once the No is taken back or the lines are kept. */
	asked: string[];
	/** Stands for those stores as they were read. A save lands only while the question still asks about the same ones. */
	version: string;
};

/** What the rule saves: one "Never suggest" line for each store. */
export type NeverSuggestWrite = Omit<NeverSuggestRequest, "stores"> & {
	stores: string[];
	expectedVersion: string;
};

export const neverSuggestStores = rule({
	name: "Say Yes to never suggesting this for a store",
	given: (request: NeverSuggestRequest, facts: NeverSuggestFacts) => ({
		...request,
		// Only the question's own stores get a line, whatever the form posted.
		stores: request.stores.filter((store) => facts.asked.includes(store)),
		version: facts.version,
	}),
	refusals: [
		unless(
			term<{ stores: string[] }>(
				"the question still asks about at least one of the stores",
				(g) => g.stores.length > 0,
			),
			() => new AlreadyAnswered(),
		),
	],
	writes: (g): NeverSuggestWrite => ({
		kind: g.kind,
		itemId: g.itemId,
		stores: g.stores,
		today: g.today,
		expectedVersion: g.version,
	}),
	writesText:
		"Keeps one Never suggest line for each of the question's stores, dated today.",
});

// A suggested new category's No. Its states and moves are the category suggestion machine's (decision 206, style 1):
// the rule asks the machine whether a dismiss is allowed, and saves the state the machine names.

export type SuggestionState = {
	/** The suggestion's stored status, or null when there is no such suggestion. */
	status: string | null;
	name: string;
};

/** What the rule saves: the state the machine moved to, landing only while the suggestion still has the status read. */
export type DismissWrite = {
	suggestionId: number;
	status: string;
	expectedStatus: string;
};

export class SuggestionChanged extends Data.TaggedError("SuggestionChanged") {
	readonly say =
		"That suggestion was changed somewhere else. Here's the current list.";
}

type Move = { from: string | null; to: string | null };

const move = (facts: SuggestionState, event: string): Move => ({
	from: facts.status,
	to:
		facts.status === null
			? null
			: next(categorySuggestionMachine, facts.status, event),
});

export const dismissNewCategory = rule({
	name: "Say No to a suggested new category",
	given: (request: { suggestionId: number }, facts: SuggestionState) => ({
		...request,
		...move(facts, "DISMISS"),
	}),
	refusals: [
		unless(
			term<Move>(
				"the suggestion is waiting, so the machine allows a dismiss",
				(g) => g.to !== null,
			),
			() => new SuggestionChanged(),
		),
	],
	writes: (g): DismissWrite => ({
		suggestionId: g.suggestionId,
		// SAFETY: the refusal above answered a null `to`, and a null `from` gives a null `to`, so both are states here.
		status: g.to as string,
		// SAFETY: as above.
		expectedStatus: g.from as string,
	}),
	writesText:
		"Marks the suggestion dismissed, so the name is never suggested again.",
});

// A Maybe category answered with a category of the person's own: one the family has (the one tap), or a name, which
// files the purchase in the active category with that name or makes a new one (decision 156).

export type FileRequest = Answered & {
	target: { categoryId: number } | { name: string };
	/**
	 * True for a name the person typed under Something else: a Never suggest line for a new category stops Tally's
	 * proposal, not the person's own choice, so it does not refuse that name.
	 */
	typedByPerson: boolean;
};

export type FileFacts = CategoryFacts & {
	/** Whether the review still asks about this purchase's category. */
	asked: boolean;
	/** Whether Tally may still propose a new category for the purchase's store (no Never suggest line). */
	mayPropose: boolean;
	confidence: number | null;
	guessedCategoryId: number | null;
};

/** What the rule saves: the new category when one is made, the answer's record, and the purchase's category. */
export type FileWrite = Answered & {
	create: {
		name: string;
		nameKey: string;
		color: string;
		sortOrder: number;
	} | null;
	/** The category the purchase goes in when the family already has it. Null when it is the one made here. */
	categoryId: number | null;
	/** The category's name as the family stored it, or as it is made. */
	name: string;
	record: "yes" | "something_else";
	confidence: number;
	expectedVersion: string;
};

export const fileInCategory = rule({
	name: "Answer a Maybe category with a category of your own",
	given: (request: FileRequest, facts: FileFacts) => {
		const { target } = request;
		const named = "name" in target;

		const existing = active(facts).find((c) =>
			named ? sameName(c.name, target.name) : c.id === target.categoryId,
		);

		const creating = named && !existing;

		return {
			...request,
			...(named
				? nameChecks(target.name, facts, null)
				: { reserved: false, archivedHasName: false, activeHasName: false }),
			active: named || existing !== undefined,
			asked: facts.asked && (request.typedByPerson || facts.mayPropose),
			confidence: facts.confidence,
			room: !creating || hasRoom(facts),
			create: creating
				? {
						name: target.name,
						nameKey: nameKey(target.name),
						// SAFETY: COLORS is a fixed, non-empty list and the index is taken modulo its length, so the entry exists.
						color: COLORS[facts.categories.length % COLORS.length] as string,
						sortOrder: lastPlace(facts.categories) + 1,
					}
				: null,
			categoryId: existing?.id ?? null,
			name: existing?.name ?? (named ? target.name : ""),
			record:
				existing !== undefined && existing.id === facts.guessedCategoryId
					? ("yes" as const)
					: ("something_else" as const),
			version: facts.version,
		};
	},
	refusals: [
		unless(
			term<{ active: boolean }>(
				"the chosen category is in the active list",
				(g) => g.active,
			),
			() => new CategoryGone(),
		),
		nameIsNotReserved,
		noArchivedCategoryHasTheName,
		// A stale answer never reads as the limit, so this is checked before the list's room.
		stillAsked,
		listHasRoom("add"),
	],
	writes: (g): FileWrite => ({
		transactionId: g.transactionId,
		today: g.today,
		who: g.who,
		create: g.create,
		categoryId: g.categoryId,
		name: g.name,
		record: g.record,
		// SAFETY: `stillAsked` refused a null confidence before `writes` runs, so it is a number here.
		confidence: g.confidence as number,
		expectedVersion: g.version,
	}),
	writesText:
		"Files the purchase in the category as the person's own choice, making the category first when no active one has the name, and records a Yes when it is Tally's guess and Something else when it is not.",
});
