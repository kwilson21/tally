import { describe, expect, it } from "vitest";
import baseline from "./fixtures/stored-json-baseline.json";
import { answerOf } from "./stored-json-answers";
import { cases } from "./stored-json-corpus";

// Every case in stored-json-corpus.ts, run through the reader it names. fixtures/stored-json-baseline.json holds each
// answer, recorded on the code before any stored-JSON read moved to Effect Schema (#1120). A conversion must not move
// any answer: the same values, the same refusals and the same thrown classes.

const recorded: Record<string, string> = baseline;

describe("the stored JSON reads answer as they did before (#1120)", () => {
	it("gives every corpus case the answer recorded for it", () => {
		const list = cases();
		const labels = list.map((item) => item.label);

		expect(new Set(labels).size).toBe(labels.length);
		expect(Object.keys(recorded).sort()).toEqual([...labels].sort());

		const problems: string[] = [];

		for (const item of list) {
			const got = answerOf(item);

			if (got !== recorded[item.label])
				problems.push(
					`${item.label}\n  want ${recorded[item.label]}\n  got  ${got}`,
				);
		}

		expect(problems).toEqual([]);
	});
});
