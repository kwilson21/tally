// Home's setup during a new family's first week (P125 E, spec §8.8, decision 114): which state Home shows, its five
// lines, and the counts its sentences use. `setupView` is pure over what it's given, so the rules are tested without a
// database; `readSetup` reads the household. The caller shows it in the family app only: the demo never shows setup.
import { dayLabel } from "../dates";
import {
	type FirstTally,
	isSetUp,
	markStroke,
	questionsAnswered,
	readFirstTally,
	STROKES,
} from "../db/first-tally";
import type { StepLine } from "../views/tally-steps";
import {
	banksHistoryIn,
	type GateBank,
	questionsOpen,
	readGateInputs,
} from "./gate";

/**
 * before: no connected bank yet (Link a bank). reading: a bank is linked and the questions are shut (the import is
 * being read). ready: the questions are open (the gate, §8.8). answered: the three questions are done, so only the
 * night's count is left (it stays answered while a newly linked bank is read).
 */
export type SetupPhase = "before" | "reading" | "ready" | "answered";

export type SetupView = {
	phase: SetupPhase;
	/** Strokes drawn so far, 0 to 5. */
	drawn: number;
	/** The five lines, in order (TallySteps). */
	steps: StepLine[];
	/** The first connected bank's name, or null before a bank is linked (stroke one's note names it). */
	bankName: string | null;
	/** The connected banks, not the disconnected ones. Home's reading line names the bank only when there is one. */
	bankCount: number;
	/** Every connected bank's 90-day history is in (banksHistoryIn). Until it is, Home promises no time. */
	historyIn: boolean;
	/** Reading: what Jev still owes the import fits one night's allowance (§8.6), so the questions come by the morning. */
	fitsOneNight: boolean;
	/** Transactions from the banks that Tally has finished with, and how many the banks sent. */
	sorted: number;
	total: number;
};

/** The five lines' names (spec §8.8). */
const NAMES = [
	"Link your bank",
	"Your pay",
	"Your bills",
	"Your budgets",
	"Tomorrow · Tally keeps count on its own",
];

/**
 * The notes of the lines whose stroke isn't drawn, outside the reading phase. Before a bank no line says Next, so each
 * says how long it takes, and the first entry shows only there: stroke one is drawn once a bank is linked. Once the
 * questions are open, the first line not drawn says Next instead (setupSteps).
 */
const QUESTION_NOTES = [
	"About a minute",
	"One question",
	"One question",
	"One tap, or one at a time",
	"Later",
];

/**
 * While the import is read, every bank's history is in, and it fits one night's AI allowance (§8.6): the questions come
 * by the morning.
 */
const MORNING_NOTES = [
	"",
	"Tomorrow morning",
	"Tomorrow morning",
	"Tomorrow morning",
	"Later",
];

/**
 * While an import bigger than one night is read: no time is promised, since the status says "when it's done" (#585: never
 * promise what a failed run can't keep).
 */
const CATCH_UP_NOTES = [
	"",
	"When it's done",
	"When it's done",
	"When it's done",
	"Later",
];

/** Strokes drawn so far: a stroke with a key in the record is drawn, whether or not it has a day. */
export function strokesDrawn(record: FirstTally | null): number {
	return STROKES.filter((stroke) => record?.strokes[stroke] !== undefined)
		.length;
}

export function setupSteps(
	record: FirstTally | null,
	phase: SetupPhase,
	bankName: string | null,
	today: string,
	byMorning: boolean,
): StepLine[] {
	// The line the family acts on now says "Next": the first stroke not yet drawn once the questions are open. Before a
	// bank no line says Next (each says how long it takes), and while the import is read, or once the three questions are
	// answered, there is nothing to act on.
	const next =
		phase === "ready"
			? STROKES.findIndex((stroke) => record?.strokes[stroke] === undefined)
			: -1;
	// byMorning is every bank's history in and the rest fitting one night (setupView): only then is the morning promised.
	const notes =
		phase !== "reading"
			? QUESTION_NOTES
			: byMorning
				? MORNING_NOTES
				: CATCH_UP_NOTES;
	return STROKES.map((stroke, i) => {
		const drawn = record?.strokes[stroke] !== undefined;
		const day = record?.strokes[stroke] ?? null;
		let note = i === next ? "Next" : (notes[i] ?? "");
		if (drawn) {
			note =
				i === 0
					? `${bankName ?? "Your bank"}, linked`
					: day
						? dayLabel(day, today)
						: "";
		}
		return { name: NAMES[i] ?? "", done: drawn, note };
	});
}

/**
 * The setup Home shows, from the record, the connected banks and what Jev still owes; null once the first week is set
 * up. `cap` is the day's Jev allowance, `total` how many transactions the banks sent.
 */
export function setupView({
	record,
	banks,
	waiting,
	total,
	cap,
	today,
}: {
	record: FirstTally | null;
	banks: GateBank[];
	/** Imported transactions still waiting for Jev's category or income answer (countWaitingForJev). */
	waiting: number;
	total: number;
	/** The household's daily Jev allowance (categorize-pending's jevCallLimit). */
	cap: number;
	today: string;
}): SetupView | null {
	if (isSetUp(record)) return null;
	const bankName = banks[0]?.name ?? null;
	const historyIn = banksHistoryIn(banks);
	// Answered is checked before the gate, so a bank linked after the answers (which shuts the gate again) doesn't send
	// the family back to "reading" for questions they have already answered.
	const phase: SetupPhase =
		banks.length === 0
			? "before"
			: questionsAnswered(record)
				? "answered"
				: questionsOpen({
							today,
							strokeOneDay: record?.strokes.bank ?? null,
							banks,
							waiting,
						})
					? "ready"
					: "reading";
	const fitsOneNight = waiting <= cap;
	return {
		phase,
		drawn: strokesDrawn(record),
		steps: setupSteps(
			record,
			phase,
			bankName,
			today,
			historyIn && fitsOneNight,
		),
		bankName,
		bankCount: banks.length,
		historyIn,
		fitsOneNight,
		sorted: Math.max(0, total - waiting),
		total,
	};
}

/** The setup for this household, read from the database, or null once the first week is set up. */
export async function readSetup(
	db: D1Database,
	{ today, cap }: { today: string; cap: number },
): Promise<SetupView | null> {
	let record = await readFirstTally(db);
	if (isSetUp(record)) return null;
	const { banks, waiting } = await readGateInputs(db);
	// A connected bank with no stroke one (linked before the first week shipped, in a household with no budgets, so
	// migration 0057 didn't set it up) draws stroke one today, or the gate would never open. markStroke keeps a stroke
	// already drawn, so this is idempotent.
	if (banks.length > 0 && record?.strokes.bank === undefined) {
		await markStroke(db, "bank", today);
		record = await readFirstTally(db);
	}
	const total =
		(
			await db
				.prepare(
					"SELECT COUNT(*) AS total FROM transactions WHERE plaid_transaction_id IS NOT NULL",
				)
				.first<{ total: number }>()
		)?.total ?? 0;
	return setupView({ record, banks, waiting, total, cap, today });
}
