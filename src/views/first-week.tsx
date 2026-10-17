// How Tally works' "Your first week" part (P125 E, decision 114, spec §9): the five strokes of a new family's first week in
// words, each with the day it was drawn and one plain line on what it did (doneNote), and how a first budget is suggested
// (§6). The family app only: the demo never shows it. A household set up before the feature shipped has no days (migration
// 0057), so its strokes read as done with no day and no line, under a sentence that says so.
import { shortDay } from "../dates";
import { type FirstTally, isSetUp, STROKES } from "../db/first-tally";
import {
	doneNote,
	type FirstWeekNames,
	NAMES,
	QUESTION_NOTES,
} from "../first-tally/setup";

/** The part's body: the ordered list of the five strokes, then how a first budget is suggested. */
export function FirstWeekPart({
	record,
	names,
	today,
}: {
	record: FirstTally | null;
	names: FirstWeekNames;
	today: string;
}) {
	// Set up before this page existed: every stroke drawn with no day (migration 0057's marker).
	const setUpBefore =
		isSetUp(record) &&
		STROKES.every((stroke) => record?.strokes[stroke] === null);
	return (
		<>
			<ol class="mt-3 list-decimal space-y-1 pl-5">
				{STROKES.map((stroke, i) => {
					const day = record?.strokes[stroke];
					const what = record && day ? doneNote(stroke, record, names) : null;
					const note =
						day === undefined
							? QUESTION_NOTES[i]
							: day
								? `${what ? `${what} · ` : ""}done ${shortDay(day, today)}`
								: "done";
					return (
						<li key={stroke}>
							{NAMES[i]}: {note}
						</li>
					);
				})}
			</ol>
			{setUpBefore && (
				<p class="mt-3 text-muted">
					Tally set up your household before this page existed.
				</p>
			)}
			<p class="mt-4">
				A first budget is suggested from what your bank shows a category spent
				in up to its last three full months: their average, rounded up to the
				next $10, with the months it came from. Nothing is saved until you say
				yes.
			</p>
		</>
	);
}
