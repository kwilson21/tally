import { describe, expect, it } from "vitest";
import baseline from "./fixtures/sync-page-baseline.json";
import { answerOf } from "./sync-page-answers";
import { syncCases } from "./sync-page-corpus";

// Every case in sync-page-corpus.ts, run through the real syncItem. fixtures/sync-page-baseline.json holds each answer,
// recorded on the code before the accounts answer and the page were read with Effect Schema (#1152). A conversion must not
// move any answer: a sync that ends still ends with the same bank row, accounts and charges, and one that fails still fails
// with nothing written. A failure's class and message are not part of the answer.

const recorded: Record<string, string> = baseline;

describe("the sync's two Plaid answers are taken as they were before (#1152)", () => {
	it("gives every corpus case the answer recorded for it", async () => {
		const list = syncCases();
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
	}, 900_000);
});
