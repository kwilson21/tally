// How the suggestions rules (src/rules/suggestions.ts) read their facts and save what they decide (decisions 190 and
// 206). The rule decides in TypeScript; the database only checks that what the rule read has not changed since, and
// raises an error when it has, so an answer is never saved against a question the review no longer asks.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type {
	CategoryMaybeWrite,
	MaybeFacts,
	MoneyMaybeWrite,
	NeverSuggestFacts,
	NeverSuggestRequest,
	NeverSuggestWrite,
} from "../rules/suggestions";
import { Database } from "./database";
import { ChangedSinceRead, decideAndSave } from "./guarded-save";
import { incomeGuessSql, PERSON_INCOME_SET_SQL } from "./income";
import {
	categoryAskedSql,
	incomeAskedSql,
	neverSuggestAskedSql,
	transferAskedSql,
} from "./suggestions-queue";

export type MaybeKind = "income" | "transfer" | "category";

/** The queue's own check for each kind of Maybe, and the guess it is asked about, as SQL over the row `t`. */
const QUESTION: Record<MaybeKind, { asked: string; confidence: string }> = {
	income: { asked: incomeAskedSql("t"), confidence: incomeGuessSql("t") },
	transfer: {
		asked: transferAskedSql("t"),
		confidence: "t.transfer_confidence",
	},
	category: {
		asked: categoryAskedSql("t"),
		confidence: "t.category_confidence",
	},
};

/** The transaction ?1 beside the category ?2 an answer names (no row of it when ?2 is NULL or the family has none). */
const ROW =
	"FROM transactions t LEFT JOIN categories c ON c.id = ?2 WHERE t.id = ?1";

/**
 * Everything a Maybe's rule reads as one text, as SQL: whether the review still asks, the guess, the guessed category,
 * and whether the named category is there and archived. 'none' when the transaction is gone.
 */
const version = (kind: MaybeKind) =>
	`COALESCE((SELECT ${QUESTION[kind].asked} || ':' || COALESCE(${QUESTION[kind].confidence}, '') || ':'
		|| COALESCE(t.jev_category_id, '') || ':' || COALESCE(c.archived, 'none') ${ROW}), 'none')`;

/** What a Maybe's rule reads about a transaction and the category its answer names, with its version, in one statement. */
export async function maybeFacts(
	db: D1Database,
	kind: MaybeKind,
	transactionId: number,
	categoryId: number | null = null,
): Promise<MaybeFacts> {
	const row = await db
		.prepare(
			`SELECT ${version(kind)} AS version, s.* FROM (SELECT 1) LEFT JOIN (SELECT ${QUESTION[kind].asked} AS asked,
				${QUESTION[kind].confidence} AS confidence, t.jev_category_id AS guessedCategoryId, c.id AS chosenId,
				c.name AS chosenName, c.archived AS chosenArchived ${ROW}) s`,
		)
		.bind(transactionId, categoryId)
		.first<{
			version: string;
			asked: number | null;
			confidence: number | null;
			guessedCategoryId: number | null;
			chosenId: number | null;
			chosenName: string | null;
			chosenArchived: number | null;
		}>();

	return {
		asked: row?.asked === 1,
		confidence: row?.confidence ?? null,
		guessedCategoryId: row?.guessedCategoryId ?? null,
		chosen:
			row?.chosenId == null
				? null
				: {
						id: row.chosenId,
						name: row.chosenName ?? "",
						archived: row.chosenArchived === 1,
					},
		version: row?.version ?? "none",
	};
}

/**
 * The guard, the first statement of every Maybe's save: it adds nothing while the row is still as the rule read it, and
 * tries to record an answer with no guess when it is not. The guess is NOT NULL, so that fails the statement and the
 * whole batch with an error maybeChangedSinceRead knows (SQLite's RAISE works only inside a trigger).
 */
const guard = (
	db: D1Database,
	kind: MaybeKind,
	save: {
		transactionId: number;
		today: string;
		expectedVersion: string;
		categoryId?: number;
	},
) =>
	db
		.prepare(
			`INSERT INTO maybe_answers (kind, confidence, answer, household_day)
			SELECT ?3, NULL, 'yes', ?4 WHERE ${version(kind)} IS NOT ?5`,
		)
		.bind(
			save.transactionId,
			save.categoryId ?? null,
			kind,
			save.today,
			save.expectedVersion,
		);

/** The answer's record (decision 155): the guess it was given against, and the household's day. */
const record = (
	db: D1Database,
	kind: MaybeKind,
	answer: string,
	save: { confidence: number; today: string },
) =>
	db
		.prepare(
			"INSERT INTO maybe_answers (kind, confidence, answer, household_day) VALUES (?, ?, ?, ?)",
		)
		.bind(kind, save.confidence, answer, save.today);

/** What each money answer sets on its transaction. A No changes nothing that counts: it hides this one Maybe (decision 101). */
const moneyAnswer = (db: D1Database, save: MoneyMaybeWrite) => {
	const id = save.transactionId;

	if (save.answer === "no")
		return db
			.prepare(
				save.kind === "income"
					? "UPDATE transactions SET income_maybe_declined = 1 WHERE id = ?"
					: "UPDATE transactions SET transfer_maybe_declined = 1 WHERE id = ?",
			)
			.bind(id);

	return save.kind === "income"
		? db
				.prepare(
					`UPDATE transactions SET ${PERSON_INCOME_SET_SQL} WHERE id = ?`,
				)
				.bind(1, save.who, id)
		: db
				.prepare(
					`UPDATE transactions SET excluded = 1, excluded_source = 'user', transfer_confidence = NULL,
						updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
				)
				.bind(save.who, id);
};

/** A money Maybe's save, one batch: the guard, the answer's record, and the Yes or the No on the transaction. */
export const moneyMaybeStatements = (db: D1Database, save: MoneyMaybeWrite) => [
	guard(db, save.kind, save),
	record(db, save.kind, save.answer, save),
	moneyAnswer(db, save),
];

/** A category Maybe's save, one batch: the guard, the answer's record, and the category the person set. */
export const categoryMaybeStatements = (
	db: D1Database,
	save: CategoryMaybeWrite,
) => [
	guard(db, "category", save),
	record(db, "category", save.record, save),
	db
		.prepare(
			`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL,
				split_removed_from_cents = NULL, split_removed_bills = NULL, updated_by = ?, updated_at = datetime('now')
			WHERE id = ?`,
		)
		.bind(save.categoryId, save.who, save.transactionId),
];

/** The text of the guard's failure, as D1 passes SQLite's message on. Only the guard can try to record a NULL guess. */
const GUARD_RAISED = /NOT NULL constraint failed: maybe_answers\.confidence/;

/** Whether a save failed because what the rule read had changed, and not for any other reason. */
export function maybeChangedSinceRead(error: Error): boolean {
	return GUARD_RAISED.test(error.message);
}

/** Only the Never suggest guard can try to keep a line with no date. */
const NEVER_SUGGEST_GUARD_RAISED =
	/NOT NULL constraint failed: never_suggest_rules\.decided_on/;

/** Whether a save failed because what the rule read had changed, and not for any other reason. */
export function neverSuggestChangedSinceRead(error: Error): boolean {
	return NEVER_SUGGEST_GUARD_RAISED.test(error.message);
}

/** Runs a save's batch, and reads a guard's error as ChangedSinceRead; any other failure is a defect. */
const saveBatch = (db: D1Database, statements: D1PreparedStatement[]) =>
	Effect.tryPromise({
		try: () => db.batch(statements),
		catch: (cause) => cause,
	}).pipe(
		Effect.catch((cause) =>
			cause instanceof Error &&
			(maybeChangedSinceRead(cause) || neverSuggestChangedSinceRead(cause))
				? Effect.fail(new ChangedSinceRead())
				: Effect.die(cause),
		),
	);

const GAVE_UP = "A suggestion kept changing while its answer was being saved.";

type Decides<Request, W, E> = {
	decide: (
		request: Request,
		facts: MaybeFacts,
	) => Effect.Effect<Option.Option<W>, E>;
};

/**
 * Reads a money Maybe's facts, asks the rule and saves what it decides in one batch, asking again on fresh facts when
 * the guard raises (decideAndSave).
 */
export const decideMoneyMaybe = <
	Request extends { kind: "income" | "transfer"; transactionId: number },
	E,
>(
	maybeRule: Decides<Request, MoneyMaybeWrite, E>,
	request: Request,
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		return yield* decideAndSave({
			facts: Effect.promise(() =>
				maybeFacts(db, request.kind, request.transactionId),
			),
			decide: (facts) => maybeRule.decide(request, facts),
			save: (write) => saveBatch(db, moneyMaybeStatements(db, write)),
			gaveUp: GAVE_UP,
		});
	});

/** The same for a category Maybe, whose facts also say whether the category the answer names is active. */
export const decideCategoryMaybe = <
	Request extends { transactionId: number; categoryId: number },
	E,
>(
	maybeRule: Decides<Request, CategoryMaybeWrite, E>,
	request: Request,
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		return yield* decideAndSave({
			facts: Effect.promise(() =>
				maybeFacts(db, "category", request.transactionId, request.categoryId),
			),
			decide: (facts) => maybeRule.decide(request, facts),
			save: (write) => saveBatch(db, categoryMaybeStatements(db, write)),
			gaveUp: GAVE_UP,
		});
	});

/** The stores the question about item ?1 still asks about, in order, as one text: what the Never suggest rule reads. */
const askedStores = (kind: NeverSuggestRequest["kind"]) =>
	`COALESCE((SELECT group_concat(hex(key), '|') FROM (SELECT key FROM (${neverSuggestAskedSql(kind)}) ORDER BY key)), '')`;

/** What the Never suggest rule reads: the stores the question still asks about, and their version. */
export async function neverSuggestFacts(
	db: D1Database,
	kind: NeverSuggestRequest["kind"],
	itemId: number,
): Promise<NeverSuggestFacts> {
	// SAFETY: the batch below lists exactly two statements, so its results are the two D1Results typed here. A batch is
	// one transaction, so the version is of the very stores read beside it.
	const [stores, version] = (await db.batch([
		db.prepare(`SELECT key FROM (${neverSuggestAskedSql(kind)})`).bind(itemId),
		db.prepare(`SELECT ${askedStores(kind)} AS version`).bind(itemId),
	])) as [D1Result<{ key: string }>, D1Result<{ version: string }>];

	return {
		asked: stores.results.map((row) => row.key),
		version: version.results[0]?.version ?? "",
	};
}

/**
 * The Never suggest save, one batch: the guard, which tries to keep a line with no date when the question's stores have
 * changed since the rule read them, then the lines. The stores go in as one JSON value, so any number of them is one
 * bound value; the unique index stays as the backstop (INSERT OR IGNORE).
 */
export const neverSuggestStatements = (
	db: D1Database,
	save: NeverSuggestWrite,
) => [
	db
		.prepare(
			`INSERT INTO never_suggest_rules (merchant_key, kind, decided_on)
			SELECT 'guard', ?2, NULL WHERE ${askedStores(save.kind)} IS NOT ?3`,
		)
		.bind(save.itemId, save.kind, save.expectedVersion),
	db
		.prepare(
			`INSERT OR IGNORE INTO never_suggest_rules (merchant_key, kind, decided_on)
			SELECT value, ?1, ?2 FROM json_each(?3)`,
		)
		.bind(save.kind, save.today, JSON.stringify(save.stores)),
];

/**
 * Reads the question's stores, asks the rule and keeps the lines it decides in one batch, asking again on fresh stores
 * when the guard raises (decideAndSave). Answers with the stores that got a line.
 */
export const decideNeverSuggest = <E>(
	storesRule: {
		decide: (
			request: NeverSuggestRequest,
			facts: NeverSuggestFacts,
		) => Effect.Effect<Option.Option<NeverSuggestWrite>, E>;
	},
	request: NeverSuggestRequest,
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		const { decided } = yield* decideAndSave({
			facts: Effect.promise(() =>
				neverSuggestFacts(db, request.kind, request.itemId),
			),
			decide: (facts) => storesRule.decide(request, facts),
			save: (write) => saveBatch(db, neverSuggestStatements(db, write)),
			gaveUp: GAVE_UP,
		});

		return Option.getOrUndefined(decided)?.stores ?? [];
	});
