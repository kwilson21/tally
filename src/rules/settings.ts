// The settings area's rules (decisions 187, 206 and 209): the AI switches, the time zone, bank sign-in emails, the
// people of the household, Tally's rules (Always and Never suggest lines) and the learned lines. Each takes a typed
// request and what is stored, and is written as a list of its parts (`rule`, in ./terms). The time and the person are
// inputs (decision 195), and nothing here parses, reads a clock or touches the database. The saves' guards are in
// src/db/settings-saves.ts (decision 190).
import * as Data from "effect/Data";
import { rule, term, unless } from "./terms";

// The AI switches (spec §8.6, decision 73).

export type Switch =
	| "names"
	| "details"
	| "categories"
	| "income"
	| "sortOnArrival";

export type Switches = Record<Switch, boolean>;

export type AiSwitchesRequest = {
	/** The switches the form posted, each On or Off. A switch the page greyed out is not among them. */
	posted: Partial<Switches>;
	/** The switches the page drew as On. */
	drawnOn: Switch[];
	/** The switch a flip posted on its own, which is always written. */
	flipped: Switch | undefined;
};

export type AiSwitchesFacts = {
	switches: Switches;
	/** Stands for the switches as they were read. A save lands only while they still have this version. */
	version: string;
};

/** What the rule saves: the switches that changed, and what the rows left by Sort on arrival wait for when it comes back on. */
export type AiSwitchesWrite = {
	changed: Partial<Switches>;
	/** Set when Sort on arrival turns back on (decision 150): the rows it left wait for the daily run, under the switches as they will be. */
	rowsWaitFor: { categories: boolean; income: boolean } | null;
	expectedVersion: string;
};

type AiGiven = { changed: Partial<Switches> };

export const saveAiSwitches = rule({
	name: "Save the AI suggestions switches",
	given: (request: AiSwitchesRequest, facts: AiSwitchesFacts) => {
		// A flip that replaced an earlier one in the browser can still arrive after it, so the switch just flipped is
		// always written, even when its value matches what the page drew.
		const changed = Object.fromEntries(
			Object.entries(request.posted).filter(
				([name, on]) =>
					on !== request.drawnOn.some((drawn) => drawn === name) ||
					name === request.flipped,
			),
		);

		const after = { ...facts.switches, ...changed };

		return {
			changed,
			rowsWaitFor:
				!facts.switches.sortOnArrival && changed.sortOnArrival === true
					? { categories: after.categories, income: after.income }
					: null,
			version: facts.version,
		};
	},
	nothingToDoIf: term<AiGiven>(
		"no switch differs from what the page drew, and none was just flipped",
		(g) => Object.keys(g.changed).length === 0,
	),
	refusals: [],
	writes: (g): AiSwitchesWrite => ({
		changed: g.changed,
		rowsWaitFor: g.rowsWaitFor,
		expectedVersion: g.version,
	}),
	writesText:
		"Saves the switches that changed and leaves the rest. When Sort on arrival comes back on, the rows it left wait for the daily run.",
});

// The time zone and the bank sign-in emails switch: one stored value each, read from nothing.

export const saveTimeZone = rule({
	name: "Save the household's time zone",
	given: (request: { zone: string }, _facts: null) => request,
	refusals: [],
	writes: (g): { zone: string } => g,
	writesText:
		'Saves the zone, which "today" follows from then on. No transaction\'s date changes.',
});

export const saveBankSignInEmails = rule({
	name: "Turn bank sign-in emails on or off",
	given: (request: { on: boolean }, _facts: null) => request,
	refusals: [],
	writes: (g): { on: boolean } => g,
	writesText: "Saves the switch.",
});

export class AddressNotFound extends Data.TaggedError("AddressNotFound") {
	readonly say = "Address not found.";
}

/** What removing an address saves: the address, and the time (ms) it is removed at. */
export type RemoveAddressWrite = {
	email: string;
	now: number;
	expectedVersion: string;
};

export const removeSignInAddress = rule({
	name: "Remove a sign-in address from bank sign-in emails",
	given: (
		request: { email: string; now: number },
		facts: { known: boolean; version: string },
	) => ({ ...request, ...facts }),
	refusals: [
		unless(
			term<{ known: boolean }>(
				"the address is one of the household's sign-in addresses",
				(g) => g.known,
			),
			() => new AddressNotFound(),
		),
	],
	writes: (g): RemoveAddressWrite => ({
		email: g.email,
		now: g.now,
		expectedVersion: g.version,
	}),
	writesText:
		"Marks the address removed, and drops the devices it turned notifications on for.",
});

// The people of the household (the "for" of a purchase).

export class PersonNameTaken extends Data.TaggedError("PersonNameTaken") {
	readonly say = "That name is already in your household.";
}

export class PersonGone extends Data.TaggedError("PersonGone") {
	readonly say = "That person is no longer in your household.";
}

export type PersonFacts = {
	/** The person's name, or null when there is no such person. */
	name: string | null;
	version: string;
};

const personExists = unless(
	term<{ stored: string | null }>(
		"the person is in the household",
		(g) => g.stored !== null,
	),
	() => new PersonGone(),
);

/** Adding reads nothing: the table's own index refuses a name the household has, in any capitals (PersonNameTaken). */
export const addPerson = rule({
	name: "Add a person to the household",
	given: (request: { name: string }, _facts: null) => request,
	refusals: [],
	writes: (g): { name: string } => g,
	writesText: "Adds the person.",
});

export type RenamePersonWrite = {
	id: number;
	name: string;
	expectedVersion: string;
};

export const renamePerson = rule({
	name: "Rename a person",
	given: (request: { id: number; name: string }, facts: PersonFacts) => ({
		...request,
		stored: facts.name,
		version: facts.version,
	}),
	refusals: [personExists],
	writes: (g): RenamePersonWrite => ({
		id: g.id,
		name: g.name,
		expectedVersion: g.version,
	}),
	writesText: "Sets the person's name.",
});

/** What removing a person saves. The save's SQL clears them from their purchases, whatever their number. */
export type RemovePersonWrite = {
	id: number;
	name: string;
	who: string;
	expectedVersion: string;
};

export const removePerson = rule({
	name: "Remove a person from the household",
	given: (request: { id: number; who: string }, facts: PersonFacts) => ({
		...request,
		stored: facts.name,
		version: facts.version,
	}),
	refusals: [personExists],
	writes: (g): RemovePersonWrite => ({
		id: g.id,
		name: g.stored ?? "",
		who: g.who,
		expectedVersion: g.version,
	}),
	writesText:
		"Removes the person, and every purchase that was for them now says no one.",
});

// Tally's rules: an Always line (a merchant's rule) and a Never suggest line.

export type AlwaysRuleFacts = {
	/** The merchant's name as Settings shows it, when the merchant has a rule. Null when it has none. */
	merchant: string | null;
	version: string;
};

export type RemoveAlwaysRuleWrite = {
	merchantKey: string;
	merchant: string;
	expectedVersion: string;
};

export const removeAlwaysRule = rule({
	name: "Remove a merchant's Always rule",
	given: (request: { merchantKey: string }, facts: AlwaysRuleFacts) => ({
		...request,
		...facts,
	}),
	nothingToDoIf: term<{ merchant: string | null }>(
		"the merchant has no rule now",
		(g) => g.merchant === null,
	),
	refusals: [],
	writes: (g): RemoveAlwaysRuleWrite => ({
		merchantKey: g.merchantKey,
		merchant: g.merchant ?? "",
		expectedVersion: g.version,
	}),
	writesText:
		"Clears the rule. Transactions already sorted under it stay as they are.",
});

export type NeverSuggestLineFacts<Line> = {
	/** The clicked line, when it is still there for that store and kind. Null when it is gone, or its id now names another line. */
	line: Line | null;
	version: string;
};

export type RemoveNeverSuggestWrite<Line> = {
	line: Line;
	expectedVersion: string;
};

/** Built for the line as Settings draws it, so the answer can name it. */
export const removeNeverSuggestLine = <Line>() =>
	rule({
		name: "Remove a Never suggest line",
		given: (_request: { id: number }, facts: NeverSuggestLineFacts<Line>) =>
			facts,
		nothingToDoIf: term<NeverSuggestLineFacts<Line>>(
			"the line is already gone",
			(g) => g.line === null,
		),
		refusals: [],
		writes: (g): RemoveNeverSuggestWrite<Line> => ({
			// SAFETY: the nothing-to-do term answered a null line before `writes` runs, so it is a line here.
			line: g.line as Line,
			expectedVersion: g.version,
		}),
		writesText:
			"Removes the line and the store's other lines of the same kind, under every name the store goes by. Tally may suggest that again.",
	});

// The learned lines (decisions 162 and 163).

/** How long a Forget's Undo stays open, in milliseconds (decision 162). */
export const FORGET_UNDO_MS = 10_000;

export type ForgetWrite = {
	text: string;
	now: number;
	expectedVersion: string;
};

export const forgetLine = rule({
	name: "Forget a learned line",
	given: (
		request: { text: string; now: number },
		facts: { learned: boolean; version: string },
	) => ({ ...request, ...facts }),
	nothingToDoIf: term<{ learned: boolean }>(
		"the text has no learned line now",
		(g) => !g.learned,
	),
	refusals: [],
	writes: (g): ForgetWrite => ({
		text: g.text,
		now: g.now,
		expectedVersion: g.version,
	}),
	writesText:
		"Forgets the text from now, remembering the rule it had and the time of an earlier Forget, so Undo can put the line back as it was.",
});

export class NothingToUndo extends Data.TaggedError("NothingToUndo") {
	readonly say = "Nothing to undo.";
}

export class ForgetUndoExpired extends Data.TaggedError("ForgetUndoExpired") {
	readonly say = "Undo expired. The line stays forgotten.";
}

export type UndoForgetFacts = {
	/** The Forget's row: when it was forgotten (ms) and whether an earlier Forget's time is kept. Null when it is gone. */
	forgotten: { atMs: number; hadEarlier: boolean } | null;
	version: string;
};

export type UndoForgetWrite = {
	id: number;
	/** True to put back the earlier Forget's time; false to remove the row. */
	backToEarlier: boolean;
	expectedVersion: string;
};

type UndoForgetGiven = { id: number; now: number } & UndoForgetFacts;

export const undoForget = rule({
	name: "Undo a Forget",
	given: (
		request: { id: number; now: number },
		facts: UndoForgetFacts,
	): UndoForgetGiven => ({ ...request, ...facts }),
	refusals: [
		unless(
			term<UndoForgetGiven>(
				"the Forget is still there to undo",
				(g) => g.forgotten !== null,
			),
			() => new NothingToUndo(),
		),
		unless(
			term<UndoForgetGiven>(
				"its ten seconds have not passed",
				(g) =>
					g.forgotten !== null && g.now - g.forgotten.atMs < FORGET_UNDO_MS,
			),
			() => new ForgetUndoExpired(),
		),
	],
	writes: (g): UndoForgetWrite => ({
		id: g.id,
		backToEarlier: g.forgotten?.hadEarlier === true,
		expectedVersion: g.version,
	}),
	writesText:
		"Puts the line back as it was before that Forget, with the rule it had unless the text has a newer one.",
});

export class NoLineToChange extends Data.TaggedError("NoLineToChange") {
	readonly say = "Choose a line to change.";
}

/** The page names the line in this sentence; a rule sheet has no line to name. */
export class LineTooVague extends Data.TaggedError("LineTooVague") {
	readonly say =
		"The line covers more than one kind of purchase, so a rule can't be made for it.";
}

export class NoCategoryChosen extends Data.TaggedError("NoCategoryChosen") {
	readonly say = "Choose a category.";
}

export type ChangeLineFacts = {
	/** The learned line for the text, or null when it has none now. */
	line: { name: string; vague: boolean } | null;
	/** The chosen category, when the family has it. */
	category: { id: number; name: string; archived: boolean } | null;
	version: string;
};

/** What a Change saves: a rule on the cleaned bank text. The save's SQL applies it to what nothing has filled, whatever the number. */
export type ChangeLineWrite = {
	text: string;
	categoryId: number;
	lineName: string;
	categoryName: string;
	expectedVersion: string;
};

type ChangeGiven = { text: string; categoryId: number } & ChangeLineFacts;

export const changeLine = rule({
	name: "Change a learned line's category",
	given: (
		request: { text: string; categoryId: number },
		facts: ChangeLineFacts,
	): ChangeGiven => ({ ...request, ...facts }),
	refusals: [
		unless(
			term<ChangeGiven>("the text has a learned line", (g) => g.line !== null),
			() => new NoLineToChange(),
		),
		unless(
			term<ChangeGiven>(
				"the line covers one kind of purchase",
				(g) => g.line?.vague !== true,
			),
			() => new LineTooVague(),
		),
		unless(
			term<ChangeGiven>(
				"the chosen category is in the active list",
				(g) => g.category !== null && !g.category.archived,
			),
			() => new NoCategoryChosen(),
		),
	],
	writes: (g): ChangeLineWrite => ({
		text: g.text,
		categoryId: g.categoryId,
		lineName: g.line?.name ?? "",
		categoryName: g.category?.name ?? "",
		expectedVersion: g.version,
	}),
	writesText:
		"Saves a rule that sends the cleaned bank text to the category every time, and applies it at once to what nothing has filled. It never changes a merchant rule.",
});
