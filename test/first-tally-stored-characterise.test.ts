import { describe, expect, it } from "vitest";
import { answerOf } from "./first-tally-stored-answers";
import { firstTallyCases } from "./first-tally-stored-corpus";
import baseline from "./fixtures/first-tally-stored-baseline.json";

// Every case in first-tally-stored-corpus.ts, read by parseFirstTally. fixtures/first-tally-stored-baseline.json holds each
// answer, recorded on the code before the read moved from hand checks to Effect Schema (#1181). The move must not change any
// answer: the same record, the same parts left out, the same key order, the same fixed sentence for a text that is not a
// record, and the same ordinary prototype on every part (a key named __proto__ never sets one).

const recorded: Record<string, string> = baseline;

describe("the first week's record is read as it was before (#1181)", () => {
	it("gives every corpus case the answer recorded for it", async () => {
		const list = firstTallyCases();
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
