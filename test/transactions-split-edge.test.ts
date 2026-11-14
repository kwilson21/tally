import { afterEach, describe, expect, it, vi } from "vitest";
import baseline from "./fixtures/transactions-split-edge-baseline.json";
import { isIntended, recordCase, STEPS } from "./split-edge-corpus";

// The split routes and the category lock, read at the edge (#1006, PR 11). Each case posts or gets one input a
// person's browser can send and records the answer, the rows it can touch and the page. The lines in
// fixtures/transactions-split-edge-baseline.json were recorded on the code before the edge: every answer must stay the
// same, except a padded address id on a real transaction (a leading zero), which now answers as a missing transaction
// and writes nothing (intended difference 1, checked on its own below).

const recorded: Record<string, string> = baseline;

afterEach(() => {
	vi.useRealTimers();
});

describe("the split routes and the category lock, read at the edge (#1006, PR 11)", () => {
	it("has a baseline line for every case", () => {
		expect(Object.keys(recorded).sort()).toEqual(
			STEPS.map((step) => step.label).sort(),
		);
	});

	it.each(STEPS.map((step) => [step.label, step] as const))(
		"%s keeps its answer",
		async (label, step) => {
			const { line, changed } = await recordCase(step);

			if (isIntended(step)) {
				// A padded id is a missing transaction: a 404 on every route, and no row changed.
				expect(line.split(" | ")[0]).toBe("404");
				expect(changed).toBe(false);

				return;
			}

			expect(line).toBe(recorded[label]);
		},
	);
});
