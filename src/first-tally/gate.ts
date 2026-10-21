// When the first week's questions open (spec §8.8, decision 146): once stroke one is drawn, every connected bank's first
// sync and its 90-day history done, and no imported transaction still waiting for Jev's category or income answer. There
// is no wait for a later day. Nothing here polls; the pages that show it do. Once the first week is set up they stay shut
// (readQuestionsGate).
import { readAiSwitches } from "../db/ai-switches";
import { isSetUp, readFirstTally } from "../db/first-tally";
import { countWaitingForJev } from "../db/transactions";

export type QuestionsFacts = {
	/** Stroke one's household day, or null when stroke one is drawn with no day (or not drawn). */
	strokeOneDay: string | null;
	/** Each connected, not disconnected, bank: when its last sync finished and when Plaid's history was in. */
	banks: { lastSyncedAt: string | null; historyCompleteAt: string | null }[];
	/** Imported transactions still waiting for Jev's category or income answer (countWaitingForJev). */
	waiting: number;
};

/**
 * True when every connected bank's 90-day history is in: each has finished its first sync and Plaid's history mark.
 * Zero banks is never in, since "every bank is done" would be true of none. Home's setup promises no time until this holds.
 */
export function banksHistoryIn(banks: QuestionsFacts["banks"]): boolean {
	return (
		banks.length > 0 &&
		banks.every(
			(bank) => bank.lastSyncedAt !== null && bank.historyCompleteAt !== null,
		)
	);
}

/**
 * True when the questions may open. Each condition is checked on its own: stroke one drawn with its day, every connected bank
 * with its history in (banksHistoryIn), and nothing waiting. A household with a bank and no stroke one (no first_tally
 * record) is shut.
 */
export function questionsOpen(facts: QuestionsFacts): boolean {
	if (facts.strokeOneDay === null) return false;
	if (!banksHistoryIn(facts.banks)) return false;
	return facts.waiting === 0;
}

/** A connected bank as the gate and Home's setup read it: its name, and the two sync marks the gate needs. */
export type GateBank = QuestionsFacts["banks"][number] & {
	name: string;
	/** When the bank was linked (plaid_items.created_at, UTC `YYYY-MM-DD HH:MM:SS`). */
	linkedAt: string | null;
};

/**
 * True while a bank is connected, as SQL for a write's guard (markStroke): the same predicate readGateInputs reads the banks
 * with, so a write checked with it draws only while a bank is connected. takeBackBankStrokes checks the same predicate
 * when the last bank goes, so the draw and the take-back agree.
 */
export const BANK_CONNECTED_SQL =
	"EXISTS (SELECT 1 FROM plaid_items WHERE disconnected_at IS NULL)";

/**
 * What the gate reads besides the record: each connected bank, and what Jev is still owed, counted with the AI switches
 * that decide it. One place, so Home's setup and the gate count the same things.
 */
export async function readGateInputs(
	db: D1Database,
): Promise<{ banks: GateBank[]; waiting: number }> {
	const { results: banks } = await db
		.prepare(
			"SELECT institution_name AS name, created_at AS linkedAt, last_synced_at AS lastSyncedAt, history_complete_at AS historyCompleteAt FROM plaid_items WHERE disconnected_at IS NULL ORDER BY id",
		)
		.all<GateBank>();
	const switches = await readAiSwitches(db);
	const waiting = await countWaitingForJev(db, {
		categories: switches.categories,
		income: switches.income,
	});
	return { banks, waiting };
}

/**
 * The gate read from the household's database, which the question page's routes read. Closed again once the first week is
 * set up (isSetUp: all five strokes drawn), so a set-up household is sent Home and its questions are not asked again (#647).
 * Home's setup doesn't come through here: it checks isSetUp itself and reads questionsOpen and the inputs directly.
 */
export async function readQuestionsGate(db: D1Database): Promise<boolean> {
	const record = await readFirstTally(db);
	if (isSetUp(record)) return false;
	const { banks, waiting } = await readGateInputs(db);
	return questionsOpen({
		strokeOneDay: record?.strokes.bank ?? null,
		banks,
		waiting,
	});
}
