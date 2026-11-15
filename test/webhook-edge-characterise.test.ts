import { describe, expect, it } from "vitest";
import baseline from "./fixtures/webhook-edge-baseline.json";
import { recordSorting } from "./record-sorting";
import { answerOf } from "./webhook-edge-answers";
import { cases } from "./webhook-edge-corpus";

// Every case in webhook-edge-corpus.ts, run through the real verifier or the real route. fixtures/webhook-edge-baseline.json
// holds each answer, recorded on the code before the token's parts, Plaid's key answer and the webhook's body moved to
// Effect Schema (#1149). A conversion must not move any answer: the same word from the verifier, the same status from the
// route, the same change to the bank's row, and the same calls to Plaid.

recordSorting({ sort: true });

const recorded: Record<string, string> = baseline;

describe("the Plaid webhook's outside reads answer as they did before (#1149)", () => {
	it("gives every corpus case the answer recorded for it", async () => {
		const list = cases();
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
