import { describe, expect, it } from "vitest";
import { parseAppleCsv } from "../src/apple-card/csv";
import { cases } from "./apple-card-csv-corpus";
import baseline from "./fixtures/apple-card-csv-baseline.json";

// Every input in apple-card-csv-corpus.ts, run through parseAppleCsv. fixtures/apple-card-csv-baseline.json holds each
// answer as JSON, recorded on the code before the Effect Schema change (#1120). The change must not move any answer:
// the same rows, the same line numbers and order, and the same sentence for each refusal.

const recorded: Record<string, string> = baseline;

describe("the Apple Card CSV reader answers as it did before (#1120)", () => {
	it("gives every corpus input the answer recorded for it", () => {
		const list = cases();
		const labels = list.map((item) => item.label);

		expect(new Set(labels).size).toBe(labels.length);
		expect(Object.keys(recorded).sort()).toEqual([...labels].sort());

		const problems: string[] = [];

		for (const item of list) {
			const got = JSON.stringify(parseAppleCsv(item.text));

			if (got !== recorded[item.label])
				problems.push(
					`${item.label}\n  want ${recorded[item.label]}\n  got  ${got}`,
				);
		}

		expect(problems).toEqual([]);
	});
});
