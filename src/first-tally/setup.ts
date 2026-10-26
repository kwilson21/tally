// Setup during a new family's first week (P125 E, spec §8.8, decisions 114 and 148): which state setup shows, and the
// words its view uses. `setupView` is pure over what it's given, so the rules are tested without a database; `readSetup`
// reads the household. Setup is done at the budgets stroke (decision 148): from then on there is no setup view, and Home
// is plain Home. The caller shows it in the family app only: the demo never shows setup.
import { householdTimeZone } from "../dates";
import {
	type FirstTally,
	isSetUp,
	markStroke,
	readFirstTally,
} from "../db/first-tally";
import type { FlaggedBank } from "../stale-bank";
import {
	BANK_CONNECTED_SQL,
	banksHistoryIn,
	type GateBank,
	questionsOpen,
	readGateInputs,
} from "./gate";

/**
 * before: no connected bank yet (Link a bank). reading: a bank is linked and the questions are shut (the import is
 * being read). ready: the questions are open (the gate, §8.8). A bank linked after the answers takes the questions back
 * (#578), so it is reading again, and setup is not done until the budgets stroke is drawn.
 */
export type SetupPhase = "before" | "reading" | "ready";

export type SetupView = {
	phase: SetupPhase;
	/** The first connected bank's name, or null before a bank is linked. */
	bankName: string | null;
	/** The connected banks, not the disconnected ones. Home's reading line names the bank only when there is one. */
	bankCount: number;
	/** Every connected bank's 90-day history is in (banksHistoryIn). Until it is, Home promises no time. */
	historyIn: boolean;
	/**
	 * Reading, every history in, and something still waiting for Jev: the sort is under way. Setup counts the sorted
	 * transactions and says the questions open when it's done (decision 146).
	 */
	sorting: boolean;
	/**
	 * Sorting, and the newest bank's history came in over an hour ago: Tally keeps trying on its own, and no time is
	 * promised (decision 146). Never while waitsForRun: the run sorts it, and no sort is under way to be slow.
	 */
	slow: boolean;
	/**
	 * Reading, with something moving (a bank still coming in that nothing flags, or the sort once every history is in and it
	 * is not slow) and a bank linked or its history in during the last hour: the page refreshes itself while it can, and says
	 * so (decision 146). A flagged bank still loading, or a stale import, stops it. Never during waitsForRun (decision 150):
	 * Tally isn't sorting then, so there is nothing to refresh, and the 30-second check-in moves the page on.
	 */
	refreshes: boolean;
	/** Transactions from the banks that Tally has finished with, and how many the banks sent. */
	sorted: number;
	total: number;
	/**
	 * The ready email has reached someone: `readyEmailedTo` is not empty (decision 134). While the import is read and this is
	 * false, the reading screen says Tally will email when they're ready.
	 */
	emailed: boolean;
	/**
	 * Reading, every history in, something waiting, and the import left for the daily run's sorting: Sort right away is off, or
	 * the record's mark (waitsForRun in first_tally) says so, since the switch can be turned back on meanwhile (decision 150).
	 * The reading screen says when the run sorts it, with no count and no bar.
	 */
	waitsForRun: boolean;
	/**
	 * The daily 09:00 UTC run's time in the household's time zone, as the reading screen says it ("5 AM"; "10 AM" in London in
	 * summer; "2:30 PM" in Kolkata), from dailyRunTime.
	 */
	runTime: string;
};

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
 * The setup for this household, from the record, the connected banks (with their sync marks) and what Jev still owes; null
 * once the first week is set up (the budgets stroke is drawn, decision 148). `flagged` is the flagged banks Home's caller
 * read for its bank notice (flaggedBanks over the same read): each bank's flag is matched to it by id, so the notice, the
 * Fix line and the refresh all follow that one list. `total` is how many transactions the banks sent, and `nowMs` is the
 * clock the sort's times are read against.
 */
export function setupView({
	record,
	banks,
	flagged,
	waiting,
	total,
	nowMs,
	timeZone,
	sortOnArrival,
}: {
	record: FirstTally | null;
	banks: GateBank[];
	/** The flagged banks the caller read for the bank notice (flaggedBanks), by each bank's id. */
	flagged: FlaggedBank[];
	/** Imported transactions still waiting for Jev's category or income answer (countWaitingForJev). */
	waiting: number;
	total: number;
	/** The clock the sort's times are read against (Date.now in readSetup). */
	nowMs: number;
	/** The household's time zone, in which the reading screen says the daily run's hour (householdTimeZone in readSetup). */
	timeZone: string;
	/** Sort right away (the switch the sync's sort follows): off leaves an import waiting for the daily run (decision 150). */
	sortOnArrival: boolean;
}): SetupView | null {
	if (isSetUp(record)) return null;
	const bankName = banks[0]?.name ?? null;
	const historyIn = banksHistoryIn(banks);
	const phase: SetupPhase =
		banks.length === 0
			? "before"
			: questionsOpen({
						strokeOneDay: record?.strokes.bank ?? null,
						banks,
						waiting,
					})
				? "ready"
				: "reading";
	const sorting = phase === "reading" && historyIn && waiting > 0;
	// With Sort right away off, a sync's sort asks Jev nothing, so the import waits for the daily run (decision 150). The
	// record's mark keeps that while the switch is on again, until the night's run finds nothing waiting.
	const waitsForRun =
		sorting && (!sortOnArrival || record?.waitsForRun === true);
	const historyAt = newestMs(
		banks.map((bank) => storedTimeMs(bank.historyCompleteAt)),
	);
	const slow =
		sorting &&
		!waitsForRun &&
		historyAt !== null &&
		nowMs - historyAt > HOUR_MS;
	const linkedAt = newestMs(banks.map((bank) => storedTimeMs(bank.linkedAt)));
	const recent = newestMs([linkedAt, historyAt]);
	// Something is moving: once every history is in, the sort (not slow). While one is still coming in, a bank that nothing
	// flags: a flagged one waits for a sign-in or a sync that isn't coming, as bankState's paused does. Each bank's flag is the
	// caller's list's entry with its id (never its name), so two banks sharing a name never share a flag.
	const isFlagged = (bank: GateBank) =>
		flagged.some((flag) => flag.id === bank.id);
	const moving =
		phase === "reading" &&
		!waitsForRun &&
		(historyIn
			? sorting && !slow
			: banks.some(
					(bank) => bank.historyCompleteAt === null && !isFlagged(bank),
				));
	const refreshes = moving && recent !== null && nowMs - recent <= HOUR_MS;
	return {
		phase,
		bankName,
		bankCount: banks.length,
		historyIn,
		sorting,
		slow,
		refreshes,
		sorted: Math.max(0, total - waiting),
		total,
		emailed: (record?.readyEmailedTo ?? []).length > 0,
		waitsForRun,
		runTime: dailyRunTime(timeZone, nowMs),
	};
}

/**
 * The setup for this household, read from the database, or null once the first week is set up (the budgets stroke is
 * drawn). A connected bank with no stroke one (linked before the first week shipped) draws stroke one today, so the gate
 * can open. `flagged` is the flagged banks the caller read for its bank notice, so the setup and the notice are drawn from
 * one read (setupView).
 */
export async function readSetup(
	db: D1Database,
	{ today, flagged }: { today: string; flagged: FlaggedBank[] },
): Promise<SetupView | null> {
	let record = await readFirstTally(db);
	if (isSetUp(record)) return null;
	const { banks, waiting, sortOnArrival } = await readGateInputs(db);
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
		nowMs: Date.now(),
		timeZone: await householdTimeZone(db),
		sortOnArrival,
	});
}
