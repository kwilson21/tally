// When the first week's questions open (spec §8.8, decision 114): the household day after stroke one, every connected
// bank's first sync and its 90-day history done, and no imported transaction still waiting for Jev's category or income
// answer. Nothing polls; the page reads this when it's drawn.
import { readAiSwitches } from "../db/ai-switches";
import { readFirstTally } from "../db/first-tally";
import { countWaitingForJev } from "../db/transactions";

export type QuestionsFacts = {
	/** The household's day now (YYYY-MM-DD). */
	today: string;
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
 * True when the questions may open. Each condition is checked on its own: the day after stroke one, every connected bank
 * with its history in (banksHistoryIn), and nothing waiting.
 */
export function questionsOpen(facts: QuestionsFacts): boolean {
	if (facts.strokeOneDay === null || facts.today <= facts.strokeOneDay)
		return false;
	if (!banksHistoryIn(facts.banks)) return false;
	return facts.waiting === 0;
}

/** A connected bank as the gate and Home's setup read it: its name, and the two sync marks the gate needs. */
export type GateBank = QuestionsFacts["banks"][number] & { name: string };

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
			"SELECT institution_name AS name, last_synced_at AS lastSyncedAt, history_complete_at AS historyCompleteAt FROM plaid_items WHERE disconnected_at IS NULL ORDER BY id",
		)
		.all<GateBank>();
	const switches = await readAiSwitches(db);
	const waiting = await countWaitingForJev(db, {
		categories: switches.categories,
		income: switches.income,
	});
	return { banks, waiting };
}

/** The gate read from the household's database. */
export async function readQuestionsGate(
	db: D1Database,
	today: string,
): Promise<boolean> {
	const record = await readFirstTally(db);
	const { banks, waiting } = await readGateInputs(db);
	return questionsOpen({
		today,
		strokeOneDay: record?.strokes.bank ?? null,
		banks,
		waiting,
	});
}
