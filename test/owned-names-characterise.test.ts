import { describe, expect, it } from "vitest";
import baseline from "./fixtures/owned-names-baseline.json";
import { answerOf } from "./owned-names-answers";
import { ownedNamesCases } from "./owned-names-corpus";

// Every case in owned-names-corpus.ts, read by ownedNamesOf. fixtures/owned-names-baseline.json holds each answer, recorded on
// the code before the read moved from a cast to Effect Schema (#1180). The SQL always writes a list of {name, date, part}
// rows, so the cases here are texts it never writes; the move may refuse some of them, and each one it moves is named below.

const recorded: Record<string, string> = baseline;

describe("the owned names are read as they were before (#1180)", () => {
	it("gives every corpus case the answer recorded for it", async () => {
		const list = ownedNamesCases();
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
