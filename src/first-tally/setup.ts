// Home's setup during a new family's first week (P125 E, spec §8.8, decision 114): which state Home shows, its five
// lines, and the counts its sentences use. `setupView` is pure over what it's given, so the rules are tested without a
// database; `readSetup` reads the household. The caller shows it in the family app only: the demo never shows setup.
import { dayLabel, householdTimeZone } from "../dates";
import {
	type FirstTally,
	isSetUp,
	markStroke,
	type NightCounts,
	questionsAnswered,
	readFirstTally,
	STROKES,
	type Stroke,
} from "../db/first-tally";
import { merchantDisplayNames } from "../db/merchant-names";
import type { FlaggedBank } from "../stale-bank";
import { tidyName } from "../transactions/tidy-name";
import type { StepLine } from "../views/tally-steps";
import { andList } from "./budgets";
import {
	BANK_CONNECTED_SQL,
	banksHistoryIn,
	type GateBank,
	questionsOpen,
	readGateInputs,
} from "./gate";
import { dollarsWords } from "./pay";

/**
 * before: no connected bank yet (Link a bank). reading: a bank is linked and the questions are shut (the import is
 * being read). ready: the questions are open (the gate, §8.8). answered: the three questions are drawn, so only the
 * night's count is left. A bank linked after the answers takes the questions back (#578), so it is reading again.
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
	/**
	 * Reading, every history in, and something still waiting for Jev: the sort is under way. Home counts the sorted
	 * transactions and says the questions open when it's done (decision 146).
	 */
	sorting: boolean;
	/**
	 * Sorting, and the newest bank's history came in over an hour ago: Tally keeps trying on its own, and no time is
	 * promised (decision 146).
	 */
	slow: boolean;
	/**
	 * Reading, with something moving (a bank still coming in that nothing flags, or the sort once every history is in and it
	 * is not slow) and a bank linked or its history in during the last hour: Home refreshes itself while it can, and says so
	 * (decision 146). A flagged bank still loading, or a stale import, stops it.
	 */
	refreshes: boolean;
	/** Transactions from the banks that Tally has finished with, and how many the banks sent. */
	sorted: number;
	total: number;
	/**
	 * The fifth day (#586): set on the day stroke five is drawn, with what the night did. Home shows that day's set-up view
	 * only; from the next household day it is Home. Null on every other day.
	 */
	fifth: NightCounts | null;
	/**
	 * Answered, while a connected bank is reading its history or needs signing in (#671): what Tally waits for, as the
	 * status's clause after "Tally keeps count" ("once Chase's history is in."). Null when nothing is waiting.
	 */
	answeredWaiting: string | null;
	/**
	 * The ready email has reached someone: `readyEmailedTo` is not empty (decision 134). While the import is read and this is
	 * false, Home says Tally will email when they're ready.
	 */
	emailed: boolean;
	/**
	 * Reading, every history in, and the import left for the daily run's sorting (Sort right away off, decision 150): the
	 * reading screen says when the run sorts it, with no count and no bar. Part 2 sets it; until then it is false.
	 */
	waitsForRun: boolean;
	/**
	 * The daily 09:00 UTC run's time in the household's time zone, as the reading screen says it ("5 AM"; "10 AM" in London in
	 * summer; "2:30 PM" in Kolkata), from dailyRunTime.
	 */
	runTime: string;
};

/** The five lines' names (spec §8.8). */
export const NAMES = [
	"Link your bank",
	"Your pay",
	"Your bills",
	"Your budgets",
	"Tomorrow · Tally keeps count on its own",
];

/**
 * The five lines' names once each is drawn (#714): the fifth reads as what it did, since its count is drawn. Undrawn lines
 * keep NAMES, and so does the set-up-before form.
 */
export const DRAWN_NAMES = [
	"Link your bank",
	"Your pay",
	"Your bills",
	"Your budgets",
	"Tally kept count on its own",
];

/**
 * The notes of the lines whose stroke isn't drawn, outside the reading phase. Before a bank no line says Next, so each
 * says how long it takes, and the first entry shows only there: stroke one is drawn once a bank is linked. Once the
 * questions are open, the first line not drawn says Next instead (setupSteps).
 */
export const QUESTION_NOTES = [
	"About a minute",
	"One question",
	"One question",
	"One tap, or one at a time",
	"Later",
];

/**
 * While the import is read (decision 146): no time is promised, since the sort runs as fast as Jev answers. Lines two to
 * four say what follows the sort, and the fifth says Later.
 */
const READING_NOTES = [
	"",
	"After sorting",
	"After sorting",
	"After sorting",
	"Later",
];

/**
 * The guard of stroke five's draw: the night was kept (`$.night` is in the record). It is code, never input (strokeStatement's
 * guard), so a stroke drawn with no kept night draws nothing.
 */
const NIGHT_KEPT_SQL =
	"(SELECT json_type(value, '$.night') FROM household_settings WHERE key = 'first_tally') IS NOT NULL";

/** Strokes drawn so far: a stroke with a key in the record is drawn, whether or not it has a day. */
export function strokesDrawn(record: FirstTally | null): number {
	return STROKES.filter((stroke) => record?.strokes[stroke] !== undefined)
		.length;
}

/**
 * The answered phase's wait (#671): while a connected bank is reading its history or needs signing in, the status says what
 * Tally waits for, in place of tomorrow's promise. A bank that needs signing in is named first, since it has a Fix action.
 * Its sign-in flag is the caller's list's (`flagged`, matched by id), so the wait and the Fix line agree.
 */
export function answeredWaitingFor(
	banks: GateBank[],
	flagged: FlaggedBank[],
): string | null {
	const signIn = banks
		.filter((bank) =>
			flagged.some((flag) => flag.id === bank.id && flag.reason === "sign-in"),
		)
		.map((bank) => bank.name);
	if (signIn.length > 0)
		return `once ${andList(signIn)} ${signIn.length === 1 ? "is" : "are"} signed in again.`;
	const reading = banks.filter((bank) => bank.historyCompleteAt === null);
	if (reading.length === 0) return null;
	return banks.length === 1
		? `once ${reading[0]?.name}'s history is in.`
		: "once your banks' history is in.";
}

export function setupSteps(
	record: FirstTally | null,
	phase: SetupPhase,
	bankName: string | null,
	today: string,
	bankCount: number,
): StepLine[] {
	// The line the family acts on now says "Next": the first stroke not yet drawn once the questions are open. Before a
	// bank no line says Next (each says how long it takes), and while the import is read, or once the three questions are
	// answered, there is nothing to act on.
	const next =
		phase === "ready"
			? STROKES.findIndex((stroke) => record?.strokes[stroke] === undefined)
			: -1;
	const notes = phase !== "reading" ? QUESTION_NOTES : READING_NOTES;
	return STROKES.map((stroke, i) => {
		const drawn = record?.strokes[stroke] !== undefined;
		const day = record?.strokes[stroke] ?? null;
		let note = i === next ? "Next" : (notes[i] ?? "");
		if (drawn) {
			note =
				i === 0
					? stepOneNote(bankName, bankCount)
					: day
						? dayLabel(day, today)
						: "";
		}
		// The re-ask note sits under step one as its own line (#714), so step one's note stays the bank's own.
		const line: StepLine = { name: NAMES[i] ?? "", done: drawn, note };
		if (drawn && i === 0 && record?.reAsk)
			line.reAsk = reAskNote(record.reAsk.bank);
		return line;
	});
}

const count = (n: number) => n.toLocaleString("en-US");

/** Step one's note: the one connected bank's name, or the count of connected banks once there are several (P140 A). */
export function stepOneNote(
	bankName: string | null,
	bankCount: number,
): string {
	return bankCount > 1
		? `${count(bankCount)} banks, linked`
		: `${bankName ?? "Your bank"}, linked`;
}

/** The line under step one when a bank linked during setup took the questions back (#578). */
export function reAskNote(bank: string): string {
	return `${bank} linked: Tally asks again about pay, bills and budgets.`;
}

/**
 * The night's counts in words, the same for the fifth day's sentence and the first week's line: "3 new transactions, all
 * sorted", or "3 new transactions; 1 needs you" (#586).
 */
export function nightCountWords(
	{ brought, needYou }: NightCounts,
	between = "; ",
): string {
	const arrived =
		brought === 0
			? "no new transactions"
			: `${count(brought)} new ${brought === 1 ? "transaction" : "transactions"}`;
	return needYou === 0
		? `${arrived}, all sorted`
		: `${arrived}${between}${count(needYou)} ${needYou === 1 ? "needs" : "need"} you`;
}

/**
 * The names a drawn stroke's line uses (doneNote), read with the record: the first connected bank's name, and the name of
 * each merchant the pay record answered Yes, as the ledger shows it, keyed by the merchant's raw key.
 */
export type FirstWeekNames = {
	bankName: string | null;
	merchants: Record<string, string>;
};

/**
 * What a drawn stroke did, in one plain line (spec §9 item 1), or null when there is nothing to say: the bank, the pay
 * merchant or merchants kept, the bills kept, the budgets set, and the night's counts. A stroke's day is shown beside it,
 * not inside it. Pure over the record and the names, so each kind of answer is tested without a database.
 */
export function doneNote(
	stroke: Stroke,
	record: FirstTally,
	names: FirstWeekNames,
): string | null {
	switch (stroke) {
		case "bank":
			return `${names.bankName ?? "Your bank"}, linked`;
		case "pay": {
			if (!record.pay) return "no paycheck found";
			const kept = Object.entries(record.pay)
				.filter(([, merchant]) => Object.keys(merchant.yes ?? {}).length > 0)
				.sort(([, a], [, b]) => a.at - b.at)
				.map(([key]) => names.merchants[key] ?? key);
			const [first, ...rest] = kept;
			if (first === undefined) return "no paycheck kept";
			return rest.length === 0 ? first : `${first} and ${rest.length} more`;
		}
		case "bills": {
			const kept = record.bills?.kept ?? 0;
			return kept === 0 ? "none kept" : `${count(kept)} kept`;
		}
		case "budgets": {
			const set = Object.values(record.budgets).filter(
				(answer) => answer.cents !== null,
			).length;
			const budgetsWords =
				set === 0
					? "no budgets to set"
					: `${count(set)} ${set === 1 ? "budget" : "budgets"}`;
			// The savings answer (decision 135, #721): a goal kept is named; Not now adds nothing.
			return typeof record.savings === "number"
				? `${budgetsWords}, saving ${dollarsWords(record.savings)} a month`
				: budgetsWords;
		}
		case "count":
			// The line's own joiner (#714): "3 new transactions, 1 needs you", where the fifth-day sentence uses "; ".
			return record.night ? nightCountWords(record.night, ", ") : null;
	}
}

/**
 * The first week's record and its names (FirstWeekNames): the first connected bank, and each Yes merchant's display name
 * from the merchants table (tidyName when it has none), in one query.
 */
export async function readFirstWeek(
	db: D1Database,
): Promise<{ record: FirstTally | null; names: FirstWeekNames }> {
	const record = await readFirstTally(db);
	const bank = await db
		.prepare(
			// The first bank ever linked, disconnected or not (#714): stroke one names it, so a later bank never replaces it.
			"SELECT institution_name AS name FROM plaid_items ORDER BY id LIMIT 1",
		)
		.first<{ name: string }>();
	const keys = Object.entries(record?.pay ?? {})
		.filter(([, merchant]) => Object.keys(merchant.yes ?? {}).length > 0)
		.map(([key]) => key);
	const displays = await merchantDisplayNames(db, keys);
	return {
		record,
		names: {
			bankName: bank?.name ?? null,
			merchants: Object.fromEntries(
				keys.map((key) => [key, displays.get(key) || tidyName(key)]),
			),
		},
	};
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The hour (UTC) of the daily run: wrangler.jsonc's `0 9 * * *` cron, the run that syncs and starts the night's sort
 * (src/index.tsx `runScheduled`).
 */
export const DAILY_RUN_UTC_HOUR = 9;

/**
 * The next daily run's time in `timeZone`, as the reading screen says it: "5 AM", "10 AM" in London in summer, "2:30 PM" in
 * Kolkata (decision 150). The run is today's 09:00 UTC while `nowMs` is before it, otherwise tomorrow's, and the zone's clock
 * is read at that instant. The words are built from the parts: the minutes only when they aren't "00", then a plain space
 * (never the narrow no-break space newer ICU puts before AM and PM), then the day period.
 */
export function dailyRunTime(timeZone: string, nowMs: number): string {
	const now = new Date(nowMs);
	const todayRun = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate(),
		DAILY_RUN_UTC_HOUR,
	);
	const run = nowMs < todayRun ? todayRun : todayRun + DAY_MS;
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour: "numeric",
		minute: "2-digit",
	}).formatToParts(run);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)?.value ?? "";
	const minute = part("minute");
	const clock = minute === "00" ? part("hour") : `${part("hour")}:${minute}`;
	return `${clock} ${part("dayPeriod")}`;
}

/**
 * A stored time as milliseconds: D1's UTC `YYYY-MM-DD HH:MM:SS`, an ISO time ending in Z, or a bare `YYYY-MM-DD` (midnight
 * UTC). Anything else is null, and a null never counts as recent (decision 146).
 */
export function storedTimeMs(value: string | null): number | null {
	if (value === null) return null;
	let iso: string | null = null;
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))
		iso = `${value.replace(" ", "T")}Z`;
	else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value))
		iso = value;
	else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) iso = `${value}T00:00:00Z`;
	if (iso === null) return null;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : null;
}

/** The latest of some times, the nulls left out; null when none is known. */
function newestMs(times: (number | null)[]): number | null {
	const known = times.filter((time): time is number => time !== null);
	return known.length === 0 ? null : Math.max(...known);
}

/**
 * The setup Home shows, from the record, the connected banks (with their sync marks) and what Jev still owes; null once the
 * first week is set up, except on the day stroke five is drawn. `flagged` is the flagged banks Home's caller read for its
 * bank notice (flaggedBanks over the same read): each bank's flag is matched to it by id, so the notice, the Fix line and
 * the refresh all follow that one list. `total` is how many transactions the banks sent, and `nowMs` is the clock the
 * sort's times are read against.
 */
export function setupView({
	record,
	banks,
	flagged,
	waiting,
	total,
	today,
	nowMs,
	timeZone,
}: {
	record: FirstTally | null;
	banks: GateBank[];
	/** The flagged banks the caller read for the bank notice (flaggedBanks), by each bank's id. */
	flagged: FlaggedBank[];
	/** Imported transactions still waiting for Jev's category or income answer (countWaitingForJev). */
	waiting: number;
	total: number;
	today: string;
	/** The clock the sort's times are read against (Date.now in readSetup). */
	nowMs: number;
	/** The household's time zone, in which the reading screen says the daily run's hour (householdTimeZone in readSetup). */
	timeZone: string;
}): SetupView | null {
	const fifthDay =
		record?.strokes.count === today && record.night !== undefined;
	if (isSetUp(record) && !fifthDay) return null;
	const bankName = banks[0]?.name ?? null;
	const historyIn = banksHistoryIn(banks);
	// Answered is checked before the gate: a set of answers that the gate would show as reading stays answered until a
	// bank linked since takes them back (takeBackQuestionStrokes), so the phase follows the strokes.
	const phase: SetupPhase =
		banks.length === 0
			? "before"
			: questionsAnswered(record)
				? "answered"
				: questionsOpen({
							strokeOneDay: record?.strokes.bank ?? null,
							banks,
							waiting,
						})
					? "ready"
					: "reading";
	const sorting = phase === "reading" && historyIn && waiting > 0;
	const historyAt = newestMs(
		banks.map((bank) => storedTimeMs(bank.historyCompleteAt)),
	);
	const slow = sorting && historyAt !== null && nowMs - historyAt > HOUR_MS;
	const linkedAt = newestMs(banks.map((bank) => storedTimeMs(bank.linkedAt)));
	const recent = newestMs([linkedAt, historyAt]);
	// Something is moving: once every history is in, the sort (not slow). While one is still coming in, a bank that nothing
	// flags: a flagged one waits for a sign-in or a sync that isn't coming, as bankState's paused does. Each bank's flag is the
	// caller's list's entry with its id (never its name), so two banks sharing a name never share a flag.
	const isFlagged = (bank: GateBank) =>
		flagged.some((flag) => flag.id === bank.id);
	const moving =
		phase === "reading" &&
		(historyIn
			? sorting && !slow
			: banks.some(
					(bank) => bank.historyCompleteAt === null && !isFlagged(bank),
				));
	const refreshes = moving && recent !== null && nowMs - recent <= HOUR_MS;
	return {
		phase,
		drawn: strokesDrawn(record),
		steps: setupSteps(record, phase, bankName, today, banks.length),
		bankName,
		bankCount: banks.length,
		historyIn,
		sorting,
		slow,
		refreshes,
		sorted: Math.max(0, total - waiting),
		total,
		fifth: fifthDay ? (record?.night ?? null) : null,
		answeredWaiting:
			phase === "answered" ? answeredWaitingFor(banks, flagged) : null,
		emailed: (record?.readyEmailedTo ?? []).length > 0,
		waitsForRun: false,
		runTime: dailyRunTime(timeZone, nowMs),
	};
}

/**
 * The setup for this household, read from the database, or null once the first week is set up (except on the day stroke
 * five is drawn). Stroke five (#586) is drawn here on the first later household day after the night was kept: `today` is
 * later than the budgets stroke's day. json_insert keeps the first day, so repeated Home loads are harmless. `flagged` is the
 * flagged banks the caller read for its bank notice, so the setup and the notice are drawn from one read (setupView).
 */
export async function readSetup(
	db: D1Database,
	{ today, flagged }: { today: string; flagged: FlaggedBank[] },
): Promise<SetupView | null> {
	let record = await readFirstTally(db);
	const budgetsDay = record?.strokes.budgets;
	if (
		record?.night !== undefined &&
		record.strokes.count === undefined &&
		budgetsDay &&
		today > budgetsDay
	) {
		await markStroke(db, "count", today, NIGHT_KEPT_SQL);
		record = await readFirstTally(db);
	}
	// Set up is shown only on the day stroke five is drawn (the fifth-day view); from the next household day, Home is Home.
	if (isSetUp(record) && record?.strokes.count !== today) return null;
	const { banks, waiting } = await readGateInputs(db);
	// A connected bank with no stroke one (linked before the first week shipped, in a household with no budgets, so
	// migration 0057 didn't set it up) draws stroke one today, or the gate would never open. The write checks for a
	// connected bank in the same statement (BANK_CONNECTED_SQL), so a last bank disconnected since the read above draws
	// nothing. markStroke keeps a stroke already drawn, so this is idempotent.
	if (banks.length > 0 && record?.strokes.bank === undefined) {
		await markStroke(db, "bank", today, BANK_CONNECTED_SQL);
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
	return setupView({
		record,
		banks,
		flagged,
		waiting,
		total,
		today,
		nowMs: Date.now(),
		timeZone: await householdTimeZone(db),
	});
}
