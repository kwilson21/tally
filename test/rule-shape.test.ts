import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
	defineRule2,
	handle,
	nothingToDo,
	type Outcome,
	refuse,
	term,
	unless,
	write,
} from "../src/rules/rule";

// The one shape every rule is written in (decision 192): what is already true is nothing to do, then the refusals in
// order, then what to save. A small made-up rule shows it: moving a counter to a number from 0 to 10.

type Given = { asked: number; now: number; locked: boolean };

const alreadyThere = term<Given>(
	"the counter is already at that number",
	(g) => g.asked === g.now,
);

const unlocked = term<Given>("the counter is not locked", (g) => !g.locked);

const inRange = term<Given>(
	"the number is from 0 to 10",
	(g) => g.asked >= 0 && g.asked <= 10,
);

const setCounter = defineRule2({
	name: "Set the counter",
	given: (
		request: { asked: number },
		facts: { now: number; locked: boolean },
	) => ({
		asked: request.asked,
		...facts,
	}),
	nothingToDoIf: alreadyThere,
	refusals: [
		unless(unlocked, "Locked", "That counter is locked."),
		unless(inRange, "OutOfRange", "Choose a number from 0 to 10."),
	],
	writes: (g) => ({ counter: g.asked }),
	writesText: "Sets the counter to the number asked for.",
});

/** What every outcome looks like, whatever the rule: exactly one of three kinds, with only that kind's fields. */
const AnyOutcome = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("write"), write: z.unknown() }),
	z.strictObject({ kind: z.literal("nothingToDo") }),
	z.strictObject({
		kind: z.literal("refuse"),
		type: z.string().min(1),
		say: z.string().min(1),
	}),
]);

describe("the rule shape (decision 192)", () => {
	it("returns what to save when nothing refuses", () => {
		expect(setCounter.decide({ asked: 4 }, { now: 1, locked: false })).toEqual(
			write({ counter: 4 }),
		);
	});

	it("answers nothing to do first, so a repeat is never refused by its own effect or anything else", () => {
		expect(setCounter.decide({ asked: 4 }, { now: 4, locked: true })).toEqual(
			nothingToDo(),
		);
	});

	it("checks the refusals in order, and the first that fails is the answer", () => {
		expect(setCounter.decide({ asked: 40 }, { now: 1, locked: true })).toEqual(
			refuse("Locked", "That counter is locked."),
		);
		expect(setCounter.decide({ asked: 40 }, { now: 1, locked: false })).toEqual(
			refuse("OutOfRange", "Choose a number from 0 to 10."),
		);
	});

	it("keeps the rule's name, its conditions in words and what it saves, for a rule sheet", () => {
		expect(setCounter.name).toBe("Set the counter");
		expect(setCounter.nothingToDoIf.text).toBe(
			"the counter is already at that number",
		);
		expect(
			setCounter.refusals.map((r) => [r.type, r.unless.text, r.say]),
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

	it("gives every outcome one of exactly three kinds, with only that kind's fields", () => {
		const outcomes = [
			setCounter.decide({ asked: 4 }, { now: 1, locked: false }),
			setCounter.decide({ asked: 4 }, { now: 4, locked: false }),
			setCounter.decide({ asked: 4 }, { now: 1, locked: true }),
		];

		expect(outcomes.map((o) => o.kind)).toEqual([
			"write",
			"nothingToDo",
			"refuse",
		]);

		for (const outcome of outcomes)
			expect(AnyOutcome.safeParse(outcome).success).toBe(true);
	});

	it("hands each kind to its own branch, and only that one", () => {
		const said = (outcome: Outcome<{ counter: number }>) =>
			handle(outcome, {
				write: (w) => `saved ${w.counter}`,
				nothingToDo: () => "already",
				refuse: (type, say) => `${type}: ${say}`,
			});

		expect(said(write({ counter: 4 }))).toBe("saved 4");
		expect(said(nothingToDo())).toBe("already");
		expect(said(refuse("Locked", "That counter is locked."))).toBe(
			"Locked: That counter is locked.",
		);
	});

	it("rejects an outcome written by hand, at compile time", () => {
		// @ts-expect-error an outcome is made only by write(), nothingToDo() or refuse(): a literal has no brand.
		const byHand: Outcome<number> = { kind: "write", write: 1 };
		expect(byHand.kind).toBe("write");
	});
});
