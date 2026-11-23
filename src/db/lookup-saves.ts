// The saves a person makes on a store's lookup line (#988): "Don't use this" on the review card and in the edit panel.
import {
	type DontUseFacts,
	type DontUseWrite,
	dontUseLine,
	type GuessChanged,
	type LineNotInUse,
} from "../rules/lookups";
import { type Decided, decided } from "../rules/terms";
import { dontUseStatements } from "./store-lookups";
import { lineGuessSql, onCurrentStoreSql } from "./suggestions-queue";

/** The facts "Don't use this" is decided from: the text the row was asked with, its stored status, whether it still holds the line-backed guess, and whether its current store is the one that text stands for. */
export async function dontUseFacts(
	db: D1Database,
	transactionId: number,
): Promise<DontUseFacts> {
	const row = await db
		.prepare(
			`SELECT a.lookup_text AS lookupText, ml.status AS status,
				${lineGuessSql("t")} AS lineBacked,
				${onCurrentStoreSql("t", "a.lookup_text")} AS onCurrentStore
			FROM transactions t
			JOIN lookup_answers a ON a.transaction_id = t.id
			LEFT JOIN merchant_lookups ml ON ml.lookup_text = a.lookup_text
			WHERE t.id = ?`,
		)
		.bind(transactionId)
		.first<{
			lookupText: string;
			status: string | null;
			lineBacked: number;
			onCurrentStore: number;
		}>();

	if (!row)
		return {
			lookupText: null,
			status: null,
			lineBacked: false,
			onCurrentStore: false,
		};

	return {
		lookupText: row.lookupText,
		status: row.status,
		lineBacked: row.lineBacked === 1,
		onCurrentStore: row.onCurrentStore === 1,
	};
}

/** Drops the store's line for good, when the rule allows it, and says what it did. */
export async function dontUse(
	db: D1Database,
	transactionId: number,
): Promise<Decided<DontUseWrite, LineNotInUse | GuessChanged>> {
	const answer = decided(
		dontUseLine.decide(
			{ transactionId },
			await dontUseFacts(db, transactionId),
		),
	);

	if (answer.kind === "write") {
		await db.batch(dontUseStatements(db, answer.save.lookupText));
	}

	return answer;
}
