// "N more look like this" (decision 157, step A, no AI): after a person files a purchase with "Create and next"
// (decision 156), the purchases still waiting with the same cleaned bank text are offered in one card, every row
// ticked. Nothing moves until the person taps Add. The card is recomputed from the filed purchase's id on every
// draw, so the URL carries only that id, never bank text. No Jev call, no AI call, nothing in the background.

import { groupBySameCleanedText, type SameTextRow } from "../same-text-matches";
import { COUNTED_JOINS } from "./counted-month";
import { merchantKeySql } from "./merchant-key";
import { jevSaysMixedSql } from "./mixed-trip";
import { cardLabel, JOIN_MERCHANT, LABEL_SQL } from "./suggestions-queue";
import { NEEDS_CATEGORY, visibleNoteSql } from "./transactions";

/** A purchase the card offers: the fields a SameTextRow has, plus what the row shows. */
export type MoreRow = SameTextRow & {
	date: string;
	amountCents: number;
	/** What the card calls it: the purchase's own name, else its store's. */
	label: string;
};

/** The card for one filed purchase: its category and the purchases that look like it. */
export type MoreLikeThis = {
	filedId: number;
	categoryId: number;
	categoryName: string;
	rows: MoreRow[];
};

/**
 * The rows that look like the filed one: the other rows of its group in groupBySameCleanedText (same cleaned bank
 * text, the vague-text note rule, mixed trips and blank text left out). Pure. The filed row is never among them.
 */
export function sameTextPeers<T extends SameTextRow>(
	filed: SameTextRow,
	others: readonly T[],
): T[] {
	const group = groupBySameCleanedText([filed, ...others]).find((g) =>
		g.rows.some((r) => r.id === filed.id),
	);
	if (!group) return [];
	const peers = new Set(
		group.rows.filter((r) => r.id !== filed.id).map((r) => r.id),
	);
	return others.filter((r) => peers.has(r.id));
}

/**
 * A purchase still waiting for a category, as the Needs-category count and Organize read it (NEEDS_CATEGORY), and
 * that no person has decided, is not part of a bill, plan or split, and is not pending. Needs `t` and COUNTED_JOINS.
 */
export const WAITING = `${NEEDS_CATEGORY} AND t.category_source IS NULL AND t.parent_id IS NULL AND t.is_split = 0 AND t.pending = 0`;

type FiledRow = {
	id: number;
	rawName: string;
	merchantKey: string;
	mixed: number;
	whatItWasNote: string | null;
	categoryId: number;
	categoryName: string;
	/** 1 when the category was archived after the purchase was filed in it. */
	archived: number;
};

type CandidateRow = {
	id: number;
	date: string;
	amountCents: number;
	rawName: string;
	merchantKey: string;
	mixed: number;
	whatItWasNote: string | null;
	displayName: string | null;
	ownName: string | null;
};

/** The purchase a person filed, in an active category (the only one a card can come from), or null. */
async function filedRow(
	db: D1Database,
	filedId: number,
): Promise<FiledRow | null> {
	return db
		.prepare(
			`SELECT t.id, t.raw_name AS rawName, ${merchantKeySql("t")} AS merchantKey, (${jevSaysMixedSql("t")}) AS mixed,
				${visibleNoteSql(false)} AS whatItWasNote, c.id AS categoryId, c.name AS categoryName, c.archived AS archived
			FROM transactions t JOIN categories c ON c.id = t.category_id
			WHERE t.id = ? AND t.category_source = 'user'`,
		)
		.bind(filedId)
		.first<FiledRow>();
}

/**
 * The purchases the group can hold: every waiting purchase, and the ones whose ids were posted (`extraIds`), whatever
 * their state now, so a ticked purchase someone decided meanwhile is still in the group and is counted as skipped by
 * the write, rather than read as not part of it.
 */
async function candidates(
	db: D1Database,
	extraIds: number[],
): Promise<MoreRow[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS rawName, ${merchantKeySql("t")} AS merchantKey,
				(${jevSaysMixedSql("t")}) AS mixed, ${visibleNoteSql(false)} AS whatItWasNote, ${LABEL_SQL}
			FROM transactions t ${COUNTED_JOINS} ${JOIN_MERCHANT}
			WHERE (${WAITING}) OR t.id IN (SELECT value FROM json_each(?))
			ORDER BY t.date DESC, t.id DESC`,
		)
		.bind(JSON.stringify(extraIds))
		.all<CandidateRow>();
	return results.map((row) => ({
		id: row.id,
		rawName: row.rawName,
		merchantKey: row.merchantKey,
		mixed: row.mixed === 1,
		whatItWasNote: row.whatItWasNote,
		date: row.date,
		amountCents: row.amountCents,
		label: cardLabel(row),
	}));
}

/**
 * The card for a purchase a person filed (its id is the only thing the address carries), or null when it isn't one
 * (not filed by a person, or in a category that is archived or gone), or when no waiting purchase looks like it.
 */
export async function moreLikeThis(
	db: D1Database,
	filedId: number,
): Promise<MoreLikeThis | null> {
	const filed = await filedRow(db, filedId);
	if (!filed || filed.archived === 1) return null;
	const rows = sameTextPeers(
		{ ...filed, mixed: filed.mixed === 1 },
		await candidates(db, []),
	);
	if (rows.length === 0) return null;
	return {
		filedId,
		categoryId: filed.categoryId,
		categoryName: filed.categoryName,
		rows,
	};
}

export type AddResult =
	| { ok: true; name: string; moved: number; skipped: number }
	/** The filed purchase is gone: not filed by a person, or its category is gone. */
	| { ok: false; reason: "gone" }
	/** The card is stale: the purchase moved to another category, or its category was archived. Nothing moved. */
	| { ok: false; reason: "changed" };

/**
 * Add: files the ticked purchases that are in the filed purchase's group into its category, as one D1 statement. A
 * ticked id that isn't in the group is ignored (the ids are checked against the group, never trusted). The write has
 * the waiting check too, so a purchase someone decided meanwhile is left alone and counted as skipped. The SET list
 * is fileInNewCategory's; no answer record is written. `category` is the category the card showed: when the filed
 * purchase is in another one now, or its category is archived, the card is stale and nothing moves.
 */
export async function addMoreLikeThis(
	db: D1Database,
	input: { filedId: number; category: number; ticked: number[]; who: string },
): Promise<AddResult> {
	const filed = await filedRow(db, input.filedId);
	if (!filed) return { ok: false, reason: "gone" };
	if (filed.archived === 1 || filed.categoryId !== input.category)
		return { ok: false, reason: "changed" };
	const ticked = [...new Set(input.ticked)];
	const group = new Set(
		sameTextPeers(
			{ ...filed, mixed: filed.mixed === 1 },
			await candidates(db, ticked),
		).map((row) => row.id),
	);
	const ids = ticked.filter((id) => group.has(id));
	// The filed purchase must still be in the category the card showed, and that category active. The check is a
	// witness read in the same D1 batch as the write, and the write repeats it in its WHERE, so a recategorize or a
	// delete after the read above moves nothing: the batch runs with no write between them.
	const filedHolds = `EXISTS (SELECT 1 FROM transactions f JOIN categories fc ON fc.id = f.category_id
		WHERE f.id = ? AND f.category_source = 'user' AND f.category_id = ? AND fc.archived = 0)`;
	const [witness, write] = await db.batch([
		db
			.prepare(`SELECT ${filedHolds} AS holds`)
			.bind(input.filedId, filed.categoryId),
		db
			.prepare(
				`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL,
					split_removed_from_cents = NULL, split_removed_bills = NULL, updated_by = ?, updated_at = datetime('now')
				WHERE ${filedHolds}
					AND id IN (SELECT value FROM json_each(?))
					AND id IN (SELECT t.id FROM transactions t ${COUNTED_JOINS} WHERE ${WAITING} AND NOT ${jevSaysMixedSql("t")})`,
			)
			.bind(
				filed.categoryId,
				input.who,
				input.filedId,
				filed.categoryId,
				JSON.stringify(ids),
			),
	]);
	const holds = (witness?.results[0] as { holds?: number } | undefined)?.holds;
	if (!holds) return { ok: false, reason: "changed" };
	const moved = write?.meta.changes ?? 0;
	return {
		ok: true,
		name: filed.categoryName,
		moved,
		skipped: ids.length - moved,
	};
}
