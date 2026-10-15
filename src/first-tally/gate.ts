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
 * True when the questions may open. Each condition is checked on its own: the day after stroke one, a connected bank
 * (zero banks is never open, since "every bank is synced" would be true of none), every bank done, and nothing waiting.
 */
export function questionsOpen(facts: QuestionsFacts): boolean {
	if (facts.strokeOneDay === null || facts.today <= facts.strokeOneDay)
		return false;
	if (facts.banks.length === 0) return false;
	if (
		!facts.banks.every(
			(bank) => bank.lastSyncedAt !== null && bank.historyCompleteAt !== null,
		)
	)
		return false;
	return facts.waiting === 0;
}

/** The gate read from the household's database, with the AI switches that decide what Jev is still owed. */
export async function readQuestionsGate(
	db: D1Database,
	today: string,
): Promise<boolean> {
	const record = await readFirstTally(db);
	const { results: banks } = await db
		.prepare(
			"SELECT last_synced_at AS lastSyncedAt, history_complete_at AS historyCompleteAt FROM plaid_items WHERE disconnected_at IS NULL",
		)
		.all<{ lastSyncedAt: string | null; historyCompleteAt: string | null }>();
	const switches = await readAiSwitches(db);
	const waiting = await countWaitingForJev(db, {
		categories: switches.categories,
		income: switches.income,
	});
	return questionsOpen({
		today,
		strokeOneDay: record?.strokes.bank ?? null,
		banks,
		waiting,
	});
}
