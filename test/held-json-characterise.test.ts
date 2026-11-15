import { describe, expect, it } from "vitest";
import baseline from "./fixtures/held-json-baseline.json";
import { answerOf } from "./held-json-answers";
import { cases } from "./held-json-corpus";

// Every case in held-json-corpus.ts, run through the reader it names. fixtures/held-json-baseline.json holds each answer,
// recorded on the code before the lookup texts, the reminders' accounts and the cash delete hold moved to Effect Schema
// (#1120). A conversion must not move any answer: the same values, the same thrown classes and the same deep values.

const recorded: Record<string, string> = baseline;

describe("the held stored JSON reads answer as they did before (#1120)", () => {
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
