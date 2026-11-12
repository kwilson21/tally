import * as Data from "effect/Data";
import { describe, expect, it } from "vitest";
import { rule, term, unless } from "../src/rules/terms";
import { answerOf, nothingToDo, refuse, write } from "./helpers/rule-answers";

// The one form every Effect rule is written in (decision 206): what is already true is nothing to do, then the
// refusals in order, then what to save. A small made-up rule shows it: moving a counter to a number from 0 to 10.

class Locked extends Data.TaggedError("Locked") {
	readonly say = "That counter is locked.";
}

class OutOfRange extends Data.TaggedError("OutOfRange") {
	readonly say = "Choose a number from 0 to 10.";
}

type Given = { asked: number; now: number; locked: boolean };

const setCounter = rule({
	name: "Set the counter",
	given: (
		request: { asked: number },
		facts: { now: number; locked: boolean },
	) => ({ asked: request.asked, ...facts }),
	nothingToDoIf: term<Given>(
		"the counter is already at that number",
		(g) => g.asked === g.now,
	),
	refusals: [
		unless(
			term<Given>("the counter is not locked", (g) => !g.locked),
			() => new Locked(),
		),
		unless(
			term<Given>(
				"the number is from 0 to 10",
				(g) => g.asked >= 0 && g.asked <= 10,
			),
			() => new OutOfRange(),
		),
	],
	writes: (g) => ({ counter: g.asked }),
	writesText: "Sets the counter to the number asked for.",
});

/** A rule with no nothing-to-do term: it always has something to do. */
const addOne = rule({
	name: "Add one",
	given: (_request: { by: 1 }, facts: { now: number }) => facts,
	refusals: [],
	writes: (g) => ({ counter: g.now + 1 }),
	writesText: "Adds one to the counter.",
});

const ask = (asked: number, facts: { now: number; locked: boolean }) =>
	answerOf(setCounter.decide({ asked }, facts));

describe("the rule form (decision 206)", () => {
	it("answers what to save when nothing refuses", () => {
		expect(ask(4, { now: 1, locked: false })).toEqual(write({ counter: 4 }));
	});

	it("answers nothing to do first, so a repeat is never refused by its own effect or anything else", () => {
		expect(ask(4, { now: 4, locked: true })).toEqual(nothingToDo());
	});

	it("checks the refusals in order, and fails with the first whose term does not hold", () => {
		expect(ask(40, { now: 1, locked: true })).toEqual(
			refuse("Locked", "That counter is locked."),
		);
		expect(ask(40, { now: 1, locked: false })).toEqual(
			refuse("OutOfRange", "Choose a number from 0 to 10."),
		);
	});

	it("works out what to save only once every check has passed", () => {
		let worked = 0;

		const counted = rule({
			...setCounter,
			writes: (g: Given) => {
				worked += 1;

				return { counter: g.asked };
			},
		});

		answerOf(counted.decide({ asked: 40 }, { now: 1, locked: true }));
		answerOf(counted.decide({ asked: 4 }, { now: 4, locked: false }));
		expect(worked).toBe(0);
		answerOf(counted.decide({ asked: 4 }, { now: 1, locked: false }));
		expect(worked).toBe(1);
	});

	it("always has something to do when the rule names no nothing-to-do term", () => {
		expect(addOne.nothingToDoIf).toBeUndefined();
		expect(answerOf(addOne.decide({ by: 1 }, { now: 4 }))).toEqual(
			write({ counter: 5 }),
		);
	});

	it("keeps the rule's name, its conditions in words and what it saves, for a rule sheet", () => {
		expect(setCounter.name).toBe("Set the counter");
		expect(setCounter.nothingToDoIf?.text).toBe(
			"the counter is already at that number",
		);
		expect(
			setCounter.refusals.map((r) => [
				r.refuse()._tag,
				r.unless.text,
				r.refuse().say,
			]),
		).toEqual([
			["Locked", "the counter is not locked", "That counter is locked."],
			[
				"OutOfRange",
				"the number is from 0 to 10",
				"Choose a number from 0 to 10.",
			],
		]);
		expect(setCounter.writesText).toBe(
			"Sets the counter to the number asked for.",
		);
	});
});
