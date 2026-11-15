// Forgets a learned line and undoes a Forget the way the Settings page does: through the forget and undo rules and
// their saves (the live path), with the clock passed in. Tests use these instead of writing the forgotten row by hand.
import * as Effect from "effect/Effect";
import { runWith } from "../src/db/database";
import { loadLearnedLines } from "../src/db/learned-lines";
import {
	decideSetting,
	forgetStatements,
	textVersion,
	undoForgetFacts,
	undoForgetStatements,
} from "../src/db/settings-saves";
import { forgetLine, undoForget } from "../src/rules/settings";

/**
 * Forgets the text at `now` (ms). Answers with the Forget's row id, which the Undo names; 0 when the text has no
 * learned line to forget (the rule's nothing-to-do), so nothing is written.
 */
export const forgetOn = (db: D1Database, text: string, now: number) =>
	runWith(
		db,
		decideSetting(
			forgetLine,
			{ text, now },
			async (d) => ({
				learned: (await loadLearnedLines(d)).some(
					(line) => line.cleanedText === text,
				),
				version: await textVersion(d, text),
			}),
			forgetStatements,
		).pipe(
			// SAFETY: the forget's batch ends in the RETURNING id statement, so its first row, when there is one, has an id.
			Effect.map(
				({ saved }) =>
					(saved?.[1]?.results[0] as { id: number } | undefined)?.id ?? 0,
			),
		),
	);

/**
 * Undoes the Forget with row `id` at `now` (ms): "undone" puts the line back as it was; "expired" when ten seconds have
 * passed; "gone" when there is no such Forget (already undone, or never written).
 */
export const undoOn = (db: D1Database, id: number, now: number) =>
	runWith(
		db,
		decideSetting(
			undoForget,
			{ id, now },
			(d) => undoForgetFacts(d, id),
			undoForgetStatements,
		).pipe(
			Effect.as("undone" as const),
			Effect.catchTags({
				ForgetUndoExpired: () => Effect.succeed("expired" as const),
				NothingToUndo: () => Effect.succeed("gone" as const),
			}),
		),
	);
