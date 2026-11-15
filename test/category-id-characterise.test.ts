import { afterEach, describe, expect, it, vi } from "vitest";
import { cases, runCase } from "./category-id-corpus";
import baseline from "./fixtures/category-id-baseline.json";

// Every route that reads a category id with CategoryId (#1111). Each case below posts or gets one input a browser can
// send and records what comes back. The lines in fixtures/category-id-baseline.json were recorded on the code before the
// change; every answer must stay the same.

const recorded: Record<string, string> = baseline;

afterEach(() => {
	vi.useRealTimers();
});

describe("the routes that read a category id (#1111)", () => {
	it("answers every recorded case the same as before the change", async () => {
		const problems: string[] = [];

		for (const req of await cases()) {
			const line = await runCase(req);

			console.log(`@@CORPUS@@ ${JSON.stringify([req.label, line])}`);

			if (recorded[req.label] !== line)
				problems.push(
					`${req.label}\n  want ${recorded[req.label]}\n  got  ${line}`,
				);
		}

		expect(problems).toEqual([]);
	}, 1_800_000);
});
