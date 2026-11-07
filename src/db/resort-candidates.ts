// The re-sort's candidates (decision 157, decision 160): when a person creates a category from Tally's suggestion, the
// rows still waiting for a category that it could now fit. A candidate is a row the "N more look like this" card would
// read as waiting (WAITING in more-like-this.ts), whose stored confidence is NULL or under the 0.80 threshold (never
// asked, left uncategorised, or a Maybe), and that either shares the filed row's Plaid category hint (the hint Jev's
// question uses) or whose Jev category is the one the filed row's guess was. Pure ordering, then one read. No Jev or
// AI call: the run that uses these rows is the only one that asks, and it's a later step (#820).

import { JEV_THRESHOLD } from "../ai/categorize";
import { BASIS_POINTS, confidenceBasisPoints } from "../ai/confidence";
import { COUNTED_JOINS } from "./counted-month";
import { merchantKeySql } from "./merchant-key";
import { jevSaysMixedSql } from "./mixed-trip";
import { WAITING } from "./more-like-this";
import { jevCategoryHintSql, visibleNoteSql } from "./transactions";

/** The most candidates one run may hold (decision 160). */
export const RESORT_CANDIDATE_MAX = 100;

/**
 * A candidate's Jev state before the run, the eight columns a category-only ask writes plus the row's id. Undo puts
 * exactly these back (resort-run.ts). Values are as stored: a NULL is NULL.
 */
export type ResortSnapshot = {
	id: number;
	category_id: number | null;
	category_source: string | null;
	category_confidence: number | null;
	jev_category_id: number | null;
	jev_none_fit: number;
	jev_mixed: number | null;
	jev_also_category_id: number | null;
	jev_failed_at: string | null;
	/** The row's failure counter (decision 182): Undo puts it back, so a run's own failure is not kept twice. */
	jev_attempts: number;
};

/** A candidate row: what clustering needs, the date for ordering, and its pre-run snapshot. */
export type ResortCandidate = {
	id: number;
	date: string;
	amountCents: number;
	/** The row's Plaid id as this read saw it: the identity a run stores with the snapshot (resort-run.ts). */
	plaidTransactionId: string | null;
	rawName: string;
	merchantKey: string;
	mixed: boolean;
	whatItWasNote: string | null;
	snapshot: ResortSnapshot;
};

type CandidateRow = {
	id: number;
	date: string;
	amountCents: number;
	plaidTransactionId: string | null;
	rawName: string;
	merchantKey: string;
	mixed: number;
	whatItWasNote: string | null;
	categoryId: number | null;
	categorySource: string | null;
	categoryConfidence: number | null;
	jevCategoryId: number | null;
	jevNoneFit: number;
	jevMixed: number | null;
	jevAlsoCategoryId: number | null;
	jevFailedAt: string | null;
	jevAttempts: number;
};

/**
 * The candidates in run order: rows in `queueIds` first, in that order (the review queue's transactions, skipping any
 * that aren't candidates), then the rest by date newest first and id newest first. Pure.
 */
export function orderCandidates<T extends { id: number; date: string }>(
	rows: readonly T[],
	queueIds: readonly number[],
): T[] {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const seen = new Set<number>();
	const queued: T[] = [];
	for (const id of queueIds) {
		const row = byId.get(id);
		if (row && !seen.has(id)) {
			seen.add(id);
			queued.push(row);
		}
	}
	const rest = rows
		.filter((row) => !seen.has(row.id))
		.sort((a, b) => {
			if (a.date !== b.date) return a.date < b.date ? 1 : -1;
			return b.id - a.id;
		});
	return [...queued, ...rest];
}

/**
 * The rows a re-sort would consider for a new category, in run order, at most RESORT_CANDIDATE_MAX. `newCategoryId`
 * must be an active category, or there are none. `cameFromCategoryId` is the category the filed row's Jev guess was
 * (read before the filing overwrote it), or null. `queueIds` are the review queue's transaction ids in queue order.
 */
export async function resortCandidates(
	db: D1Database,
	{
		filedId,
		newCategoryId,
		cameFromCategoryId = null,
		queueIds = [],
	}: {
		filedId: number;
		newCategoryId: number;
		cameFromCategoryId?: number | null;
		queueIds?: readonly number[];
	},
): Promise<ResortCandidate[]> {
	const active = await db
		.prepare("SELECT id FROM categories WHERE id = ? AND archived = 0")
		.bind(newCategoryId)
		.first<{ id: number }>();
	if (!active) return [];

	const { results } = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.plaid_transaction_id AS plaidTransactionId, t.raw_name AS rawName,
				${merchantKeySql("t")} AS merchantKey, (${jevSaysMixedSql("t")}) AS mixed,
				${visibleNoteSql(false)} AS whatItWasNote,
				t.category_id AS categoryId, t.category_source AS categorySource,
				t.category_confidence AS categoryConfidence, t.jev_category_id AS jevCategoryId,
				t.jev_none_fit AS jevNoneFit, t.jev_mixed AS jevMixed,
				t.jev_also_category_id AS jevAlsoCategoryId, t.jev_failed_at AS jevFailedAt,
				t.jev_attempts AS jevAttempts
			FROM transactions t ${COUNTED_JOINS}
			WHERE (${WAITING}) AND t.id <> ?1 AND t.jev_failed_at IS NULL
				AND (t.category_confidence IS NULL
					OR CAST(t.category_confidence * ${BASIS_POINTS} AS INTEGER) < ${confidenceBasisPoints(JEV_THRESHOLD)})
				AND (
					(${jevCategoryHintSql("t")} IS NOT NULL
						AND ${jevCategoryHintSql("t")} = (SELECT ${jevCategoryHintSql("f")} FROM transactions f WHERE f.id = ?1))
					OR (?2 IS NOT NULL AND t.jev_category_id = ?2)
				)
			ORDER BY t.date DESC, t.id DESC`,
		)
		.bind(filedId, cameFromCategoryId)
		.all<CandidateRow>();

	const rows: ResortCandidate[] = results.map((row) => ({
		id: row.id,
		date: row.date,
		amountCents: row.amountCents,
		plaidTransactionId: row.plaidTransactionId,
		rawName: row.rawName,
		merchantKey: row.merchantKey,
		mixed: row.mixed === 1,
		whatItWasNote: row.whatItWasNote,
		snapshot: {
			id: row.id,
			category_id: row.categoryId,
			category_source: row.categorySource,
			category_confidence: row.categoryConfidence,
			jev_category_id: row.jevCategoryId,
			jev_none_fit: row.jevNoneFit,
			jev_mixed: row.jevMixed,
			jev_also_category_id: row.jevAlsoCategoryId,
			jev_failed_at: row.jevFailedAt,
			jev_attempts: row.jevAttempts,
		},
	}));
	return orderCandidates(rows, queueIds).slice(0, RESORT_CANDIDATE_MAX);
}

/**
 * The grouping inputs of these rows as they are now (decision 158): the text, note, mixed reading and amount that
 * buildClusters reads. A re-ask checks its clusters against these at read time, since a row may have changed since the
 * run's clusters were built.
 */
export async function currentClusterRows(
	db: D1Database,
	ids: readonly number[],
): Promise<
	(Pick<
		ResortCandidate,
		"id" | "amountCents" | "rawName" | "merchantKey" | "whatItWasNote"
	> & {
		mixed: boolean;
	})[]
> {
	if (ids.length === 0) return [];
	const { results } = await db
		.prepare(
			`SELECT t.id, t.amount_cents AS amountCents, t.raw_name AS rawName, ${merchantKeySql("t")} AS merchantKey,
				(${jevSaysMixedSql("t")}) AS mixed, ${visibleNoteSql(false)} AS whatItWasNote
			FROM transactions t ${COUNTED_JOINS}
			WHERE t.id IN (SELECT value FROM json_each(?))`,
		)
		.bind(JSON.stringify([...new Set(ids)]))
		.all<{
			id: number;
			amountCents: number;
			rawName: string;
			merchantKey: string;
			mixed: number;
			whatItWasNote: string | null;
		}>();
	return results.map((row) => ({ ...row, mixed: row.mixed === 1 }));
}
