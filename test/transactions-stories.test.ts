import { describe, expect, it } from "vitest";
import {
	addCash,
	addLikely,
	alwaysUseCategory,
	deleteCashEntry,
	editTransaction,
	excludeSelection,
	removeSplit,
	type SplitRequest,
	setSelectionCategory,
	splitTransaction,
	undoCashDelete,
} from "../src/rules/transactions";
import { answerOf, nothingToDo, refuse, write } from "./helpers/rule-answers";

// The transactions area's style 3 rules as stories (decisions 187, 206, 210).

const TOO_MANY = refuse("TooManySelected", "Select 100 or fewer transactions.");

const TOO_MANY_UNTICKED = refuse(
	"TooManyUnticked",
	"Untick 100 or fewer. To leave out more, filter the list first.",
);

const NONE = refuse("NoneSelected", "Select at least one transaction.");
const SOME = { ticks: 2, unticked: 0, chosen: 2 };

const SELECTIONS = [
	[
		"more than 100 ticked rows",
		{ ticks: 101, unticked: 0, chosen: 0 },
		TOO_MANY,
	],
	[
		"more than 100 unticked rows",
		{ ticks: 0, unticked: 101, chosen: 0 },
		TOO_MANY_UNTICKED,
	],
	[
		"both limits passed: the ticks are said first",
		{ ticks: 101, unticked: 101, chosen: 0 },
		TOO_MANY,
	],
	["nothing selected", { ticks: 0, unticked: 3, chosen: 0 }, NONE],
] as const;

describe("Set a category for the selected transactions", () => {
	it("sets the category for a selection that can be acted on", () => {
		expect(
			answerOf(
				setSelectionCategory.decide(
					{ categoryId: 4 },
					{ ...SOME, categoryListed: true },
				),
			),
		).toEqual(write({ categoryId: 4 }));
	});

	it("allows exactly 100 ticked and 100 unticked", () => {
		expect(
			answerOf(
				setSelectionCategory.decide(
					{ categoryId: 4 },
					{ ticks: 100, unticked: 100, chosen: 100, categoryListed: true },
				),
			).kind,
		).toBe("write");
	});

	it.each(SELECTIONS)("refuses %s", (_story, selection, answer) => {
		expect(
			answerOf(
				setSelectionCategory.decide(
					{ categoryId: 4 },
					{ ...selection, categoryListed: null },
				),
			),
		).toEqual(answer);
	});

	it("refuses a category that is not listed", () => {
		expect(
			answerOf(
				setSelectionCategory.decide(
					{ categoryId: 4 },
					{ ...SOME, categoryListed: false },
				),
			),
		).toEqual(refuse("CategoryNotOnTheList", "Pick a category from the list."));
	});
});

describe("Exclude the selected transactions", () => {
	it("excludes a selection that can be acted on", () => {
		expect(answerOf(excludeSelection.decide({}, SOME))).toEqual(
			write({ exclude: true }),
		);
	});

	it.each(SELECTIONS)("refuses %s", (_story, selection, answer) => {
		expect(answerOf(excludeSelection.decide({}, selection))).toEqual(answer);
	});
});

describe("Add cash spending", () => {
	const add = addCash<{ cents: number }>();

	it.each([
		[
			"stores an entry the edge read",
			{ cents: 450 },
			write({ entry: { cents: 450 } }),
		],
		[
			"refuses a form the edge could not read",
			null,
			refuse("CashFormNotRead", "Check the cash entry's fields."),
		],
	])("%s", (_story, entry, answer) => {
		expect(answerOf(add.decide({ entry }, null))).toEqual(answer);
	});
});

describe("Split a transaction", () => {
	const request = (over: Partial<SplitRequest> = {}): SplitRequest => ({
		addPart: false,
		correction: false,
		pendingEdit: false,
		partsRead: true,
		refundAnswersFit: true,
		...over,
	});

	const ask = (over: Partial<SplitRequest>, income = false) =>
		answerOf(splitTransaction.decide(request(over), { income }));

	const INCOME = refuse("IncomeCantBeSplit", "Income can't be split.");

	it.each([
		["saves a new split", {}, false, write({ save: "split" })],
		[
			"corrects a cash split",
			{ correction: true },
			false,
			write({ save: "correction" }),
		],
		[
			"corrects a cash split with the panel's own changes",
			{ correction: true, pendingEdit: true },
			false,
			write({ save: "correctionWithEdit" }),
		],
		[
			"corrects a cash split that is marked income",
			{ correction: true },
			true,
			write({ save: "correction" }),
		],
		[
			"has nothing to save when a part is being added",
			{ addPart: true, partsRead: false },
			false,
			nothingToDo(),
		],
		["refuses income", {}, true, INCOME],
		["refuses income before it adds a part", { addPart: true }, true, INCOME],
		[
			"refuses parts the edge could not read",
			{ partsRead: false },
			false,
			refuse("SplitPartsNotRead", "Check the parts."),
		],
		[
			"refuses a refund that goes with no part",
			{ refundAnswersFit: false },
			false,
			refuse("RefundAnswersWrong", "Check which part each refund goes with."),
		],
	])("%s", (_story, over, income, answer) => {
		expect(ask(over, income)).toEqual(answer);
	});
});

describe("Remove a split", () => {
	it.each([
		["removes a split", true, write({ remove: true })],
		[
			"refuses a transaction that is not split",
			false,
			refuse("NotSplit", "That transaction isn't split."),
		],
	])("%s", (_story, split, answer) => {
		expect(answerOf(removeSplit.decide({}, { split }))).toEqual(answer);
	});
});

describe("Save the edit panel", () => {
	const cash = (linkedRefundsCents: number, partsCents: number) => ({
		amountCents: 1_000,
		linkedRefundsCents,
		partsCents,
	});

	const REFUNDS = refuse(
		"RefundsExceedAmount",
		"Linked refunds add up to more than that amount.",
	);

	const PARTS = refuse(
		"PartsDontAddUp",
		"The parts don't add up to that amount.",
	);

	it.each([
		["saves a form the edge read", true, null, write({ save: true })],
		[
			"saves a split cash entry whose parts and refunds fit",
			true,
			cash(1_000, 1_000),
			write({ save: true }),
		],
		[
			"refuses a form the edge could not read",
			false,
			null,
			refuse("EditFormNotRead", "Check the fields."),
		],
		[
			"refuses a cash amount under its linked refunds",
			true,
			cash(1_001, 1_000),
			REFUNDS,
		],
		[
			"refuses a cash amount its parts fall short of",
			true,
			cash(0, 999),
			PARTS,
		],
		["refuses a cash amount its parts go over", true, cash(0, 1_001), PARTS],
		["says the refunds before the parts", true, cash(1_001, 999), REFUNDS],
	])("%s", (_story, read, cashSplit, answer) => {
		expect(answerOf(editTransaction.decide({ read, cashSplit }, null))).toEqual(
			answer,
		);
	});
});

describe("Add the likely transactions to a new category", () => {
	it.each([
		[
			"files into a category that is listed",
			{ id: 6 },
			write({ categoryId: 6 }),
		],
		["has nothing to do when the category was archived", null, nothingToDo()],
	])("%s", (_story, category, answer) => {
		expect(answerOf(addLikely.decide({}, { category }))).toEqual(answer);
	});
});

describe("Always use a category for a merchant", () => {
	const ask = (
		merchantKey: string,
		categoryListed: boolean,
		offeredFor: string | null,
	) =>
		answerOf(
			alwaysUseCategory.decide(
				{ merchantKey, categoryId: 6 },
				{ categoryListed, offeredFor },
			),
		);

	it.each([
		[
			"saves the rule while the question would still be asked",
			"costco",
			true,
			"costco",
			write({ merchantKey: "costco", categoryId: 6 }),
		],
		[
			"has nothing to do when the question would not be asked now",
			"costco",
			true,
			null,
			nothingToDo(),
		],
		[
			"has nothing to do when it would be asked about another merchant",
			"costco",
			true,
			"target",
			nothingToDo(),
		],
		[
			"has nothing to do when the category is gone",
			"costco",
			false,
			"costco",
			nothingToDo(),
		],
		[
			"has nothing to do when no merchant is named",
			"",
			true,
			null,
			nothingToDo(),
		],
	])("%s", (_story, merchantKey, listed, offeredFor, answer) => {
		expect(ask(merchantKey, listed, offeredFor)).toEqual(answer);
	});
});

describe("Delete a cash entry", () => {
	const NOT_CASH = refuse("NotACashEntry", "That isn't a cash entry.");

	it.each([
		["deletes a confirmed cash entry", true, true, write({ delete: true })],
		[
			"has nothing to save until the delete is confirmed",
			false,
			true,
			nothingToDo(),
		],
		["refuses a row that is not a cash entry", true, false, NOT_CASH],
		[
			"refuses a row that is not a cash entry before it asks to confirm",
			false,
			false,
			NOT_CASH,
		],
	])("%s", (_story, confirmed, cashEntry, answer) => {
		expect(
			answerOf(deleteCashEntry.decide({ confirmed }, { cashEntry })),
		).toEqual(answer);
	});
});

describe("Undo a cash delete", () => {
	const TOKEN = "0f8fad5b-d9cb-469f-a165-70867728950e";

	const EXPIRED = refuse(
		"CashUndoExpired",
		"Undo expired. The cash entry stays deleted.",
	);

	it.each([
		["asks the save to put the entry back", TOKEN, write({ token: TOKEN })],
		[
			"takes a token in capitals",
			TOKEN.toUpperCase(),
			write({ token: TOKEN.toUpperCase() }),
		],
		["refuses text that is not a token", "not-a-token", EXPIRED],
		["refuses a request with no token", null, EXPIRED],
	])("%s", (_story, token, answer) => {
		expect(answerOf(undoCashDelete.decide({ token }, null))).toEqual(answer);
	});
});
