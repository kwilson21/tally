import { afterEach, describe, expect, it, vi } from "vitest";
import baseline from "./fixtures/panel-note-file-baseline.json";
import { recordCase, STEPS } from "./panel-note-file-corpus";

// The edit panel's note when a file part is posted in it (after #1109). The lines in
// fixtures/panel-note-file-baseline.json were recorded on the code before the change. A file in `note` or `note_was` now
// means the note was not posted: the saved note stays as it is, so each file row must equal its twin (the same post with
// the saved note in `note`, or, for a file in `note_was` alone, with `note_was` left out) and keep the saved note when the
// file is in `note`. Every other row keeps the answer recorded before the change.

const recorded: Record<string, string> = baseline;

/** A Change the parts answer without the sheet's body hash (the sheet's pending edit differs by the marker). */
const sheetless = (line: string, replay: boolean) =>
	replay
		? line.replace(
				/^(.*?) \|\| /,
				(_, panel: string) =>
					`${panel.replace(/body [0-9a-f]+/, "body -")} || `,
			)
		: line;

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

			const twin = step.sibling;

			if (!step.file || twin === undefined) {
				expect(line).toBe(recorded[label]);

				return;
			}

			// The twin's answer. The sheet a Change the parts answer draws carries its pending edit, which holds the file's
			// marker, so only the sheet's body is left out of that comparison; its status and headers must match. A file in
			// the note is no note: the purchase's and the cash entry's notes stay as they were.
			expect(sheetless(line, step.replay)).toBe(
				sheetless(recorded[twin] ?? "", step.replay),
			);

			if (step.fileNote) {
				const note = step.stored ? '"Saved note"' : "null";

				expect(line).toContain(`| note ${note} cash-note ${note} |`);
			}
		},
	);
});
