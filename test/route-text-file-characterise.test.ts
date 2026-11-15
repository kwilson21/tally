import { afterEach, describe, expect, it, vi } from "vitest";
import baseline from "./fixtures/route-text-file-baseline.json";
import { recordCase, STEPS } from "./route-text-file-corpus";

// The text fields the write routes read as text (#1109): each case posts one input a browser can send and records the
// answer and the state of every table. The lines in fixtures/route-text-file-baseline.json were recorded on the code
// before the change, and every answer must stay the same.

const recorded: Record<string, string> = baseline;

afterEach(() => {
	vi.useRealTimers();
});

describe("the text fields the write routes read (#1109)", () => {
	it("has a baseline line for every case", () => {
		expect(Object.keys(recorded).sort()).toEqual(
			STEPS.map((step) => step.label).sort(),
		);
	});

	// A file in a changed field is read as the missing field is: its row must equal the missing field's recorded row.
	// Every other row keeps the answer recorded before the change.
	it.each(STEPS.map((step) => [step.label, step] as const))(
		"%s keeps its answer",
		async (label, step) => {
			const line = await recordCase(step);

			console.log(`@@CORPUS@@ ${JSON.stringify([label, line])}`);

			const want = step.missingSibling
				? recorded[step.missingSibling.label]
				: recorded[label];

			expect(line).toBe(want);
		},
	);
});
