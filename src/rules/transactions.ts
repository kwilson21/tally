// The transactions area's rules in style 3 (decisions 187, 206 and 210): set a category or exclude for a selection, add
// cash, split and remove a split, the edit panel's save, add the likely ones, always use a category, and delete a cash
// entry with its Undo. Each takes a typed request and what is stored, and is written as a list of its parts (`rule`,
// in ./terms). Nothing here parses, reads a clock or touches the database. The saves are the older functions that
// re-check each row in SQL as they write (decision 209), so a change between the read and the save is refused there.
import * as Data from "effect/Data";
import {
	MAX_SELECTED,
	MAX_UNTICKED,
	TOO_MANY,
	TOO_MANY_UNTICKED,
} from "../views/selection-action-bar";
import { rule, term, unless } from "./terms";

// A selection's refusals, shared by its two actions. Over a limit the words win, even when nothing is left selected.

export class TooManySelected extends Data.TaggedError("TooManySelected") {
	readonly say = TOO_MANY;
}

export class TooManyUnticked extends Data.TaggedError("TooManyUnticked") {
	readonly say = TOO_MANY_UNTICKED;
}

export class NoneSelected extends Data.TaggedError("NoneSelected") {
	readonly say = "Select at least one transaction.";
}

export class CategoryNotOnTheList extends Data.TaggedError(
	"CategoryNotOnTheList",
) {
	readonly say = "Pick a category from the list.";
}

/** A selection as counted: the rows ticked by hand, the rows unticked from a whole set, and the rows it comes to. */
export type SelectionFacts = {
	ticks: number;
	unticked: number;
	chosen: number;
};

const selectionRefusals = [
	unless(
		term<SelectionFacts>(
			`no more than ${MAX_SELECTED} rows are ticked`,
			(g) => g.ticks <= MAX_SELECTED,
		),
		() => new TooManySelected(),
	),
	unless(
		term<SelectionFacts>(
			`no more than ${MAX_UNTICKED} rows are unticked from a whole set`,
			(g) => g.unticked <= MAX_UNTICKED,
		),
		() => new TooManyUnticked(),
	),
	unless(
		term<SelectionFacts>("at least one row is selected", (g) => g.chosen > 0),
		() => new NoneSelected(),
	),
] as const;

export type SelectionCategoryWrite = { categoryId: number };

type SelectionCategoryGiven = SelectionFacts & {
	categoryId: number;
	categoryListed: boolean | null;
};

export const setSelectionCategory = rule({
	name: "Set a category for the selected transactions",
	given: (
		request: { categoryId: number },
		/** `categoryListed` is read only for a selection that can be acted on, and is null otherwise. */
		facts: SelectionFacts & { categoryListed: boolean | null },
	): SelectionCategoryGiven => ({ ...request, ...facts }),
	refusals: [
		...selectionRefusals,
		unless(
			term<SelectionCategoryGiven>(
				"the category is listed",
				(g) => g.categoryListed === true,
			),
			() => new CategoryNotOnTheList(),
		),
	],
	writes: (g): SelectionCategoryWrite => ({ categoryId: g.categoryId }),
	writesText:
		"Sets the category on each selected row as the person's own choice. A refund that follows its purchase moves the purchase instead, which the save reads as it writes.",
});

/** Excluding saves nothing of its own to name: the rows are the selection's. */
export type ExcludeWrite = { exclude: true };

export const excludeSelection = rule({
	name: "Exclude the selected transactions",
	given: (_request: Record<never, never>, facts: SelectionFacts) => facts,
	refusals: selectionRefusals,
	writes: (): ExcludeWrite => ({ exclude: true }),
	writesText:
		"Excludes each selected row that is not excluded yet. A row the filters no longer match takes its whole purchase.",
});

// Add cash.

/** The page shows the edge's own sentence under each field. */
export class CashFormNotRead extends Data.TaggedError("CashFormNotRead") {
	readonly say = "Check the cash entry's fields.";
}

/** Built for the entry as the cash form's reader gives it. */
export const addCash = <Entry>() =>
	rule({
		name: "Add cash spending",
		given: (request: { entry: Entry | null }, _facts: null) => request,
		refusals: [
			unless(
				term<{ entry: Entry | null }>(
					"the edge read every field",
					(g) => g.entry !== null,
				),
				() => new CashFormNotRead(),
			),
		],
		writes: (g): CashWrite<Entry> => ({
			// SAFETY: the refusal above answered a form the edge could not read, so the entry is there.
			entry: g.entry as Entry,
		}),
		writesText:
			"Stores the cash entry once: the same form posted again changes nothing, which the save checks by the form's own key.",
	});

export type CashWrite<Entry> = { entry: Entry };

// Split, and remove a split.

export class IncomeCantBeSplit extends Data.TaggedError("IncomeCantBeSplit") {
	readonly say = "Income can't be split.";
}

/** The page shows the edge's sentence, which names the part. */
export class SplitPartsNotRead extends Data.TaggedError("SplitPartsNotRead") {
	readonly say = "Check the parts.";
}

/** The page shows the sentence that names the refund and the part. */
export class RefundAnswersWrong extends Data.TaggedError("RefundAnswersWrong") {
	readonly say = "Check which part each refund goes with.";
}

/** The transaction is not split: the page answers 404. */
export class NotSplit extends Data.TaggedError("NotSplit") {
	readonly say = "That transaction isn't split.";
}

export type SplitRequest = {
	/** "Add a part" was pressed: the sheet is drawn again with one more part, and nothing is saved. */
	addPart: boolean;
	/** A cash entry's split is being corrected at a new total, not split for the first time. */
	correction: boolean;
	/** The correction came from the edit panel, whose own changes are saved with it. */
	pendingEdit: boolean;
	/** Whether the edge read the parts. */
	partsRead: boolean;
	/** Whether each linked refund's answer names a part with room for it. Read only once the parts are. */
	refundAnswersFit: boolean;
};

/** Which of the three saves runs. */
export type SplitWrite = {
	save: "split" | "correction" | "correctionWithEdit";
};

type SplitGiven = SplitRequest & { income: boolean };

const incomeRefused = (g: SplitGiven) => g.income && !g.correction;

export const splitTransaction = rule({
	name: "Split a transaction",
	given: (request: SplitRequest, facts: { income: boolean }): SplitGiven => ({
		...request,
		...facts,
	}),
	nothingToDoIf: term<SplitGiven>(
		"a part is being added to a transaction that can be split",
		(g) => g.addPart && !incomeRefused(g),
	),
	refusals: [
		unless(
			term<SplitGiven>(
				"the transaction is not income, or a cash split is being corrected",
				(g) => !incomeRefused(g),
			),
			() => new IncomeCantBeSplit(),
		),
		unless(
			term<SplitGiven>("the edge read the parts", (g) => g.partsRead),
			() => new SplitPartsNotRead(),
		),
		unless(
			term<SplitGiven>(
				"each linked refund goes with a part that has room for it, or is not linked",
				(g) => g.refundAnswersFit,
			),
			() => new RefundAnswersWrong(),
		),
	],
	writes: (g): SplitWrite => ({ save: splitSave(g) }),
	writesText:
		"Saves the parts in place of the transaction's one category, or corrects a cash split at its new total. The save refuses an amount, a bill payment or a planned expense that changed meanwhile.",
});

function splitSave(g: SplitGiven): SplitWrite["save"] {
	if (!g.correction) return "split";

	return g.pendingEdit ? "correctionWithEdit" : "correction";
}

export type RemoveSplitWrite = { remove: true };

export const removeSplit = rule({
	name: "Remove a split",
	given: (_request: Record<never, never>, facts: { split: boolean }) => facts,
	refusals: [
		unless(
			term<{ split: boolean }>("the transaction is split", (g) => g.split),
			() => new NotSplit(),
		),
	],
	writes: (): RemoveSplitWrite => ({ remove: true }),
	writesText:
		"Deletes the parts and makes the transaction one row again; refunds linked to a part are unlinked.",
});

// The edit panel's save.

/** The page shows the edge's own sentence under each field. */
export class EditFormNotRead extends Data.TaggedError("EditFormNotRead") {
	readonly say = "Check the fields.";
}

/** The page names the refunds' total. */
export class RefundsExceedAmount extends Data.TaggedError(
	"RefundsExceedAmount",
) {
	readonly say = "Linked refunds add up to more than that amount.";
}

/** The page names both totals, or offers the parts at the new total. */
export class PartsDontAddUp extends Data.TaggedError("PartsDontAddUp") {
	readonly say = "The parts don't add up to that amount.";
}

export type EditRequest = {
	/** Whether the edge read every field. */
	read: boolean;
	/**
	 * A split cash entry's new amount, with what is stored against it. Null for every other save, and for a correction,
	 * whose own save checks the same two things as it writes.
	 */
	cashSplit: {
		amountCents: number;
		linkedRefundsCents: number;
		partsCents: number;
	} | null;
};

export type EditWrite = { save: true };

export const editTransaction = rule({
	name: "Save the edit panel",
	given: (request: EditRequest, _facts: null) => request,
	refusals: [
		unless(
			term<EditRequest>("the edge read every field", (g) => g.read),
			() => new EditFormNotRead(),
		),
		unless(
			term<EditRequest>(
				"a split cash entry's linked refunds are no more than its new amount",
				(g) =>
					g.cashSplit === null ||
					g.cashSplit.linkedRefundsCents <= g.cashSplit.amountCents,
			),
			() => new RefundsExceedAmount(),
		),
		unless(
			term<EditRequest>(
				"a split cash entry's parts add up to its new amount",
				(g) =>
					g.cashSplit === null ||
					g.cashSplit.partsCents === g.cashSplit.amountCents,
			),
			() => new PartsDontAddUp(),
		),
	],
	writes: (): EditWrite => ({ save: true }),
	writesText:
		"Saves what the panel changed in one batch. The save refuses a refund that no longer fits, a person who was removed, and a cash amount its parts or refunds no longer allow.",
});

// The likely panel's Add.

export type LikelyWrite = { categoryId: number };

type LikelyGiven = { category: { id: number } | null };

export const addLikely = rule({
	name: "Add the likely transactions to a new category",
	given: (_request: Record<never, never>, facts: LikelyGiven): LikelyGiven =>
		facts,
	nothingToDoIf: term<LikelyGiven>(
		"the category was archived since the panel opened",
		(g) => g.category === null,
	),
	refusals: [],
	writes: (g): LikelyWrite => ({
		// Nothing-to-do answered a category that is gone, so this 0 is never used.
		categoryId: g.category?.id ?? 0,
	}),
	writesText:
		"Files the ticked rows the panel's rules still allow. The save checks each row, and the category's name, as it writes.",
});

// The rule offer's Yes.

export type AlwaysUseRequest = { merchantKey: string; categoryId: number };

export type AlwaysUseFacts = {
	categoryListed: boolean;
	/** The merchant the question would be asked about now, for the same trip and category, or null when it would not be asked. */
	offeredFor: string | null;
};

type AlwaysUseGiven = AlwaysUseRequest & AlwaysUseFacts;

export const alwaysUseCategory = rule({
	name: "Always use a category for a merchant",
	given: (
		request: AlwaysUseRequest,
		facts: AlwaysUseFacts,
	): AlwaysUseGiven => ({
		...request,
		...facts,
	}),
	nothingToDoIf: term<AlwaysUseGiven>(
		"the question is no longer the one that would be asked",
		(g) =>
			!g.categoryListed ||
			g.merchantKey === "" ||
			g.offeredFor !== g.merchantKey,
	),
	refusals: [],
	writes: (g): AlwaysUseRequest => ({
		merchantKey: g.merchantKey,
		categoryId: g.categoryId,
	}),
	writesText:
		"Saves the merchant's rule and applies it to the merchant's rows that no person has chosen a category for.",
});

// Delete a cash entry, and its Undo.

/** Not a cash entry of its own: the page answers 404. */
export class NotACashEntry extends Data.TaggedError("NotACashEntry") {
	readonly say = "That isn't a cash entry.";
}

export class CashUndoExpired extends Data.TaggedError("CashUndoExpired") {
	readonly say = "Undo expired. The cash entry stays deleted.";
}

export type DeleteCashWrite = { delete: true };

type DeleteCashGiven = { confirmed: boolean; cashEntry: boolean };

export const deleteCashEntry = rule({
	name: "Delete a cash entry",
	given: (
		request: { confirmed: boolean },
		facts: { cashEntry: boolean },
	): DeleteCashGiven => ({ ...request, ...facts }),
	nothingToDoIf: term<DeleteCashGiven>(
		"the delete is not confirmed yet",
		(g) => g.cashEntry && !g.confirmed,
	),
	refusals: [
		unless(
			term<DeleteCashGiven>(
				"the transaction is a cash entry, not a part of one",
				(g) => g.cashEntry,
			),
			() => new NotACashEntry(),
		),
	],
	writes: (): DeleteCashWrite => ({ delete: true }),
	writesText:
		"Deletes the entry and holds a copy for ten seconds, with what was linked to it, so Undo can put it back.",
});

/** A token's shape: 36 characters of hex digits and hyphens. */
const TOKEN = /^[0-9a-f-]{36}$/i;

export type UndoCashWrite = { token: string };

type UndoCashGiven = { token: string | null };

export const undoCashDelete = rule({
	name: "Undo a cash delete",
	given: (request: UndoCashGiven, _facts: null) => request,
	refusals: [
		unless(
			term<UndoCashGiven>(
				"the Undo names a token",
				(g) => g.token !== null && TOKEN.test(g.token),
			),
			() => new CashUndoExpired(),
		),
	],
	writes: (g): UndoCashWrite => ({
		// The refusal answered a request with no token, so this blank is never used.
		token: g.token ?? "",
	}),
	writesText:
		"Puts the entry back with the links that still fit. The save checks the ten seconds, and that the entry is not back already, as it writes.",
});
