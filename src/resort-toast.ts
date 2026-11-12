// The words of the re-sort's closing toast and of its Undo answer (decision 159, decision 160). Pure: the routes and the
// catalog read these, so the copy is written once. Category names are the family's own text; no bank text is ever here.

/** What a finished run's record says the closing toast needs. */
export type ClosingCounts = {
	/** Rows the run moved (Undo's rows). */
	moved: number;
	/** Rows of the run still waiting for a person's answer after it. */
	needAnswer: number;
	/** Where the moved rows went: one entry is the single-destination wording. */
	byCategory: { name: string; count: number }[];
};

export type ToastWords = {
	message: string;
	type: "success" | "info";
	/** True when Undo is offered: it puts the moved rows back, so there must be some. */
	undo: boolean;
};

/** The "N need your answer" clause, or nothing when none wait. */
const waitingClause = (waiting: number): string =>
	waiting === 0
		? ""
		: ` ${waiting} ${waiting === 1 ? "needs" : "need"} your answer.`;

/**
 * The closing toast: "Moved 14 to Books & audio. 3 need your answer." (one destination), "Moved 14 rows. …" (several),
 * "Nothing moved. 3 need your answer." (none moved, some waiting). Null when nothing moved and nothing waits: no toast,
 * and the line just ends (see `finishedAnnouncement`).
 */
export function closingToast(counts: ClosingCounts): ToastWords | null {
	const waiting = waitingClause(counts.needAnswer);

	if (counts.moved === 0) {
		if (counts.needAnswer === 0) return null;

		return { message: `Nothing moved.${waiting}`, type: "info", undo: false };
	}

	const [only] = counts.byCategory;

	const head =
		counts.byCategory.length === 1 && only
			? `Moved ${counts.moved} to ${only.name}.`
			: `Moved ${counts.moved} ${counts.moved === 1 ? "row" : "rows"}.`;

	return { message: `${head}${waiting}`, type: "success", undo: true };
}

/** What the announcer says when the run ends with no toast. */
export const FINISHED_ANNOUNCEMENT = "Tally finished re-checking.";

/** What the announcer says when a Create starts a run, beside the Create's own words. */
export const STARTED_ANNOUNCEMENT = "Tally is re-checking related rows.";

/** What an Undo that is no longer open says. */
export const TOO_LATE_TO_UNDO = "Too late to undo that.";

/** What Undo says: how many went back, and how many changed since the run and stayed where they are. */
export type UndoOutcome = {
	expired: boolean;
	restored: number;
	changedSince: number;
};

/** What an Undo answer says on screen, and whether it is a success, an info note or an error. */
type UndoWords = {
	message: string;
	type: "success" | "info" | "error";
};

/** The Undo answer's words and type. An expired Undo is an error, as a refused answer is elsewhere in the app. */
export function undoWords(outcome: UndoOutcome): UndoWords {
	if (outcome.expired) return { message: TOO_LATE_TO_UNDO, type: "error" };

	const stayed =
		outcome.changedSince === 0
			? ""
			: ` ${outcome.changedSince} changed since, so ${outcome.changedSince === 1 ? "it" : "they"} stayed.`;

	if (outcome.restored === 0)
		return { message: `Nothing put back.${stayed}`, type: "info" };

	return { message: `Put ${outcome.restored} back.${stayed}`, type: "success" };
}
