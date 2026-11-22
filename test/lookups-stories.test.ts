import { describe, expect, it } from "vitest";
import {
	type DontUseFacts,
	dontUseLine,
	GuessChanged,
	LineNotInUse,
} from "../src/rules/lookups";
import { decided } from "../src/rules/terms";

// #988: "Don't use this" on a store's lookup line, one story per row of the rule's truth table (spec §7; plan Task 4).

const ask = (facts: DontUseFacts) =>
	decided(dontUseLine.decide({ transactionId: 1 }, facts));

const found: DontUseFacts = {
	lookupText: "LUPITAS",
	status: "found",
	lineBacked: true,
};

describe("Don't use a store's lookup line, by its facts", () => {
	it("refuses when no lookup answer asked the transaction with a line", () => {
		const answer = ask({ lookupText: null, status: null, lineBacked: false });

		expect(answer.kind).toBe("refuse");
		expect(answer).toMatchObject({
			refusal: expect.any(LineNotInUse),
		});
	});

	it("has nothing to do when the store's line is already dropped", () => {
		expect(ask({ ...found, status: "skipped" })).toEqual({
			kind: "nothingToDo",
		});
	});

	it("writes the text when the found line is the guess's own", () => {
		expect(ask(found)).toEqual({
			kind: "write",
			save: { lookupText: "LUPITAS" },
		});
	});

	it("writes when the text's key is private too: the press is the same end state as the privacy skip", () => {
		// A private key is not a fact the rule reads: the save is the same either way (plan Task 4).
		expect(ask(found).kind).toBe("write");
	});

	it("refuses with GuessChanged when the row no longer holds the guess made with the line", () => {
		const answer = ask({ ...found, lineBacked: false });

		expect(answer).toMatchObject({
			kind: "refuse",
			refusal: expect.any(GuessChanged),
		});
	});

	it.each([
		["pending", "a search is under way"],
		["nothing_found", "the search found nothing"],
		["gave_up", "Tally gave up on the search"],
		[null, "there is no stored lookup"],
	])("refuses with LineNotInUse when the lookup is %s (%s)", (status) => {
		const answer = ask({ ...found, status });

		expect(answer).toMatchObject({
			kind: "refuse",
			refusal: expect.any(LineNotInUse),
		});
	});

	it("says the refusal in the sentence a person reads", () => {
		const answer = ask({ ...found, lineBacked: false });

		expect(answer.kind === "refuse" && answer.refusal.say).toBe(
			"That guess has changed, so nothing was dropped.",
		);
	});
});
