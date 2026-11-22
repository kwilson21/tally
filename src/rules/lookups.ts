// "Don't use this" on a store's lookup line (spec §7; P146 B, #988): the one press that drops the line for a store for good.
import * as Data from "effect/Data";
import { next } from "../machines/next";
import {
	type StoreLookupState,
	storeLookupMachine,
} from "../machines/store-lookup";
import { rule, term, unless } from "./terms";

export type DontUseRequest = { transactionId: number };

export type DontUseFacts = {
	/** The lookup text the row was asked with (its lookup_answers row); null when there is none, or no such transaction. */
	lookupText: string | null;
	/** merchant_lookups.status for that text as stored; null when no row. */
	status: string | null;
	/** The row still holds its kept line-backed guess (lineGuessSql). */
	lineBacked: boolean;
};

export type DontUseGiven = {
	lookupText: string | null;
	/** The state the stored status is in. Both pending states are `to_retry` here, since both refuse the press (decision 195). */
	state: StoreLookupState;
	lineBacked: boolean;
};

export type DontUseWrite = { lookupText: string };

/** The sentence a person reads when the line is already gone, or was never asked with one. */
export class LineNotInUse extends Data.TaggedError("LineNotInUse") {
	readonly say = "That line is already gone.";
}

/** The sentence a person reads when the guess has changed since the page was drawn. */
export class GuessChanged extends Data.TaggedError("GuessChanged") {
	readonly say = "That guess has changed, so nothing was dropped.";
}

const stateOf = (status: string | null): StoreLookupState => {
	if (status === null) return "none";
	if (status === "pending") return "to_retry";

	return status as StoreLookupState;
};

export const dontUseLine = rule({
	name: "Don't use a store's lookup line",
	given: (_request: DontUseRequest, facts: DontUseFacts): DontUseGiven => ({
		lookupText: facts.lookupText,
		state: stateOf(facts.status),
		lineBacked: facts.lineBacked,
	}),
	nothingToDoIf: term<DontUseGiven>(
		"the store's line is already dropped",
		(g) => g.lookupText !== null && g.state === "skipped",
	),
	refusals: [
		unless(
			term<DontUseGiven>(
				"the transaction was asked with a store's line, and the lookup allows Don't use this",
				(g) =>
					g.lookupText !== null &&
					next(storeLookupMachine, g.state, "DONT_USE") !== null,
			),
			() => new LineNotInUse(),
		),
		unless(
			term<DontUseGiven>(
				"the row still holds the guess made with the line",
				(g) => g.lineBacked,
			),
			() => new GuessChanged(),
		),
	],
	// The refusals above rule out a missing text, so the write always has one.
	writes: (g): DontUseWrite => ({ lookupText: g.lookupText ?? "" }),
	writesText:
		"Moves the store's lookup from found to skipped and drops its line, clears every open guess made with it so the next sort asks again without it, and withdraws the names Tally guessed for the store that nobody chose.",
});
