// "N more look like this" (decision 157, step A, no AI): after a person files a purchase with "Create and next"
// (decision 156), the purchases still waiting with the same cleaned bank text are offered in one card, every row
// ticked. Nothing moves until the person taps Add. The card is recomputed from the filed purchase's id on every
// draw, so the URL carries only that id, never bank text. No Jev call, no AI call, nothing in the background.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
	addMoreLikeThis as addMore,
	type MoreFacts,
	type MoreRequest,
	type MoreWrite,
} from "../rules/suggestions";
import { groupBySameCleanedText, type SameTextRow } from "../same-text-matches";
import { COUNTED_JOINS } from "./counted-month";
import { Database, runWith } from "./database";
import { ChangedSinceRead, decideAndSave } from "./guarded-save";
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

/** The filed purchase ?1's category, when a person filed it. */
const FILED = `FROM transactions f JOIN categories fc ON fc.id = f.category_id WHERE f.id = ?1 AND f.category_source = 'user'`;

/** Each posted id (?2, a JSON list) with whether that purchase still waits for a category and is not a mixed trip, as SQL. */
const TICKED_NOW = `SELECT v.value AS id, (v.value IN (SELECT t.id FROM transactions t ${COUNTED_JOINS}
	WHERE ${WAITING} AND NOT ${jevSaysMixedSql("t")})) AS waiting FROM json_each(?2) v`;

/** Everything the Add rule reads as one text, as SQL: the filed purchase's category and each posted purchase's state. */
const MORE_VERSION = `(COALESCE((SELECT f.category_id || ':' || fc.archived ${FILED}), 'none') || '/'
	|| COALESCE((SELECT group_concat(id || ':' || waiting, '|') FROM (${TICKED_NOW})), ''))`;

/**
 * What the Add rule reads, with its version. The filed purchase's category, the posted purchases' states and the
 * version come from one batch. Which posted purchases look like the filed one is worked out from their bank text, as
 * the card works it out (sameTextPeers): an id that is not in the group is left out, never trusted.
 */
export async function moreFacts(
	db: D1Database,
	filedId: number,
	posted: number[],
): Promise<MoreFacts> {
	const ids = JSON.stringify([...new Set(posted)].sort((a, b) => a - b));

	// SAFETY: the batch below lists exactly three statements, so its results are the three D1Results typed here.
	const [filedNow, tickedNow, version] = (await db.batch([
		db
			.prepare(
				`SELECT f.category_id AS categoryId, fc.name AS categoryName, fc.archived AS archived ${FILED}`,
			)
			.bind(filedId),
		db.prepare(TICKED_NOW).bind(filedId, ids),
		db.prepare(`SELECT ${MORE_VERSION} AS version`).bind(filedId, ids),
	])) as [
		D1Result<{ categoryId: number; categoryName: string; archived: number }>,
		D1Result<{ id: number; waiting: number }>,
		D1Result<{ version: string }>,
	];

	const filed = await filedRow(db, filedId);

	const group = filed
		? new Set(
				sameTextPeers(
					{ ...filed, mixed: filed.mixed === 1 },
					await candidates(db, posted),
				).map((row) => row.id),
			)
		: new Set<number>();

	const category = filedNow.results[0];

	return {
		filed: category ? { ...category, archived: category.archived === 1 } : null,
		ticked: tickedNow.results
			.filter((row) => group.has(row.id))
			.map((row) => ({ id: row.id, waiting: row.waiting === 1 })),
		version: version.results[0]?.version ?? "",
	};
}

/**
 * The Add's save, one batch. First the guard: it records nothing while the filed purchase and the posted purchases are
 * still as the rule read them, and tries to record an answer with no guess when they are not, which fails the batch
 * (maybe_answers.confidence is NOT NULL; SQLite's RAISE works only inside a trigger). Then the purchases the rule
 * named are filed; their ids go in as one JSON value. No answer record is written.
 */
export const moreStatements = (
	db: D1Database,
	save: MoreWrite,
	posted: number[],
) => [
	db
		.prepare(
			`INSERT INTO maybe_answers (kind, confidence, answer, household_day)
			SELECT 'category', NULL, 'yes', '2000-01-01' WHERE ${MORE_VERSION} IS NOT ?3`,
		)
		.bind(
			save.filedId,
			JSON.stringify([...new Set(posted)].sort((a, b) => a - b)),
			save.expectedVersion,
		),
	db
		.prepare(
			`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL,
				split_removed_from_cents = NULL, split_removed_bills = NULL, updated_by = ?, updated_at = datetime('now')
			WHERE id IN (SELECT value FROM json_each(?))`,
		)
		.bind(save.categoryId, save.who, JSON.stringify(save.move)),
];

/** The text of the guard's failure, as D1 passes SQLite's message on. */
const GUARD_RAISED = /NOT NULL constraint failed: maybe_answers\.confidence/;

/**
 * Reads the Add's facts, asks the rule and saves what it decides in one batch, asking again on fresh facts when the
 * guard raises (decideAndSave). Answers with the category's name, how many purchases moved and how many were left.
 */
export const decideMore = <E>(
	moreRule: {
		decide: (
			request: MoreRequest,
			facts: MoreFacts,
		) => Effect.Effect<Option.Option<MoreWrite>, E>;
	},
	request: MoreRequest,
	posted: number[],
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		const { decided } = yield* decideAndSave({
			facts: Effect.promise(() => moreFacts(db, request.filedId, posted)),
			decide: (facts) => moreRule.decide(request, facts),
			save: (write) =>
				Effect.tryPromise({
					try: () => db.batch(moreStatements(db, write, posted)),
					catch: (cause) => cause,
				}).pipe(
					Effect.catch((cause) =>
						cause instanceof Error && GUARD_RAISED.test(cause.message)
							? Effect.fail(new ChangedSinceRead())
							: Effect.die(cause),
					),
				),
			gaveUp: "The purchases kept changing while they were being added.",
		});

		const write = Option.getOrUndefined(decided);

		return {
			name: write?.name ?? "",
			moved: write?.move.length ?? 0,
			skipped: write?.skipped ?? 0,
		};
	});

/**
 * Add, as the rule decides it (decision 157): files the ticked purchases that are in the filed purchase's group into
 * its category. `category` is the category the card showed: when the filed purchase is in another one now, or its
 * category is archived, the card is stale and nothing moves.
 */
export const addMoreLikeThis = (
	db: D1Database,
	input: { filedId: number; category: number; ticked: number[]; who: string },
): Promise<AddResult> =>
	runWith(
		db,
		decideMore(
			addMore,
			{ filedId: input.filedId, categoryId: input.category, who: input.who },
			input.ticked,
		).pipe(
			Effect.match({
				onSuccess: (added): AddResult => ({ ok: true, ...added }),
				onFailure: (refusal): AddResult => ({
					ok: false,
					reason: Predicate.isTagged(refusal, "CardChanged")
						? "changed"
						: "gone",
				}),
			}),
		),
	);
