import { describe, expect, it } from "vitest";
import baseline from "./fixtures/resort-stored-baseline.json";
import { answerOf } from "./resort-stored-answers";
import { resortStoredCases } from "./resort-stored-corpus";

// Every case in resort-stored-corpus.ts, stored and read back by readRun or readMoved. fixtures/resort-stored-baseline.json
// holds each answer, recorded on the code before the two reads moved from the hand guards to Effect Schema (#1150). The
// move must not change any answer: the same record when it is usable, the same null and the same logged line when it is not.

const recorded: Record<string, string> = baseline;

describe("the stored re-sort records are read as they were before (#1150)", () => {
	it("gives every corpus case the answer recorded for it", async () => {
		const list = resortStoredCases();
		const labels = list.map((item) => item.label);

		expect(new Set(labels).size).toBe(labels.length);
		expect(Object.keys(recorded).sort()).toEqual([...labels].sort());

		const problems: string[] = [];

		for (const item of list) {
			const got = await answerOf(item);

			if (got !== recorded[item.label])
				problems.push(
					`${item.label}\n  want ${recorded[item.label]}\n  got  ${got}`,
				);
		}

		expect(problems).toEqual([]);
	}, 600_000);
});
