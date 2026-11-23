// "Don't use this" on a store's lookup line (spec §7; P146 B, #988): the one press that drops the line for a store for good.
import * as Data from "effect/Data";
import { next } from "../machines/next";
import {
	type StoreLookupState,
	storeLookupMachine,
} from "../machines/store-lookup";
import { type Decided, rule, term, unless } from "./terms";

export type DontUseRequest = { transactionId: number };

export type DontUseFacts = {
	/** The lookup text the row was asked with (its lookup_answers row); null when there is none, or no such transaction. */
	lookupText: string | null;
	/** merchant_lookups.status for that text as stored; null when no row. */
	status: string | null;
	/** The row still holds its kept line-backed guess (lineGuessSql). */
	lineBacked: boolean;
	/** The transaction's current store is still the one its lookup text stands for (onCurrentStoreSql); false when there is no text. */
	onCurrentStore: boolean;
};

export type DontUseGiven = {
	lookupText: string | null;
	/** The state the stored status is in. Both pending states are `to_retry` here, since both refuse the press (decision 195). */
	state: StoreLookupState;
	lineBacked: boolean;
	onCurrentStore: boolean;
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

	// SAFETY: every other stored status is the name of the state it stands for (STORE_LOOKUP_ROWS: found, nothing_found, skipped, gave_up).
	return status as StoreLookupState;
};

export const dontUseLine = rule({
	name: "Don't use a store's lookup line",
	given: (_request: DontUseRequest, facts: DontUseFacts): DontUseGiven => ({
		lookupText: facts.lookupText,
		state: stateOf(facts.status),
		lineBacked: facts.lineBacked,
		onCurrentStore: facts.onCurrentStore,
	}),
	nothingToDoIf: term<DontUseGiven>(
		"the store's line is already dropped, and the transaction is still on that store",
		(g) => g.lookupText !== null && g.state === "skipped" && g.onCurrentStore,
	),
	refusals: [
		// A moved transaction is refused first, whatever the old store's line now is: its guess is not the store's to drop.
		unless(
			term<DontUseGiven>(
				"the transaction is still on the store its line was asked for",
				(g) => g.lookupText === null || g.onCurrentStore,
			),
			() => new GuessChanged(),
		),
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

/** The sentence and toast type for a decided "Don't use this": the refusal's sentence as info, or the store's as success. */
export type DontUseReply = { message: string; type: "success" | "info" };

export function dontUseReply(
	store: string,
	asked: Decided<DontUseWrite, LineNotInUse | GuessChanged>,
): DontUseReply {
	if (asked.kind === "refuse")
		return { message: asked.refusal.say, type: "info" };

	return {
		message: `Tally won't use the web for ${store} again.`,
		type: "success",
	};
}
