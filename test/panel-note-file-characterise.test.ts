import { afterEach, describe, expect, it, vi } from "vitest";
import baseline from "./fixtures/panel-note-file-baseline.json";
import { recordCase, STEPS } from "./panel-note-file-corpus";

// The edit panel's note when a file part is posted in it (after #1109). The lines in
// fixtures/panel-note-file-baseline.json were recorded on the code before the change. A file in `note` or `note_was` now
// means the note was not posted: the saved note stays as it is, so each file row must equal its twin (the same post with
// the saved note in `note`) and keep the saved note. Every other row keeps the answer recorded before the change.

const recorded: Record<string, string> = baseline;

afterEach(() => {
	vi.useRealTimers();
});

describe("the edit panel's note when a file is posted in it", () => {
	it("has a baseline line for every case", () => {
		expect(Object.keys(recorded).sort()).toEqual(
			STEPS.map((step) => step.label).sort(),
		);
	});

	it.each(STEPS.map((step) => [step.label, step] as const))(
		"%s",
		async (label, step) => {
			const line = await recordCase(step);

			console.log(`@@CORPUS@@ ${JSON.stringify([label, line])}`);

			if (!step.file || step.sibling === undefined) {
				expect(line).toBe(recorded[label]);

				return;
			}

			// A file is not a note: the twin's answer, and the purchase's and the cash entry's notes stay as they were.
			const note = step.stored ? '"Saved note"' : "null";

			expect(line).toBe(recorded[step.sibling]);
			expect(line).toContain(`| note ${note} cash-note ${note} |`);
		},
	);
});
