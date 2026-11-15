// Which lookup texts may later be searched on the web (spec §7, "Store lookup"). The decision is pure; the read gathers one
// row per transaction in one batch and decides each row's facts in TypeScript. Nothing here writes, asks Jev or searches.

import { cleanBankText } from "../clean-bank-text";
import { FOLLOWS_PURCHASE } from "../db/counted-month";
import { merchantKeySql } from "../db/merchant-key";
import {
	type JevSeenColumns,
	jevSeenColumnsSql,
	jevSeenOf,
} from "../db/transactions";
import { retryStateOf } from "../machines/jev-retry";
import { inputMark, markState } from "./input-mark";
import {
	isPrivatePlaidCategory,
	lookupTextOf,
	privateTextReason,
} from "./lookup-text";
import { MAYBE_IN_RANGE_SQL } from "./texts";

/** One transaction, as the decision reads it. */
export type EligibilityRow = {
	id: number;
	lookupText: string;
	private: boolean;
	sign: boolean;
	jev: "waiting" | "gave_up" | "answered" | "never";
	mark: "cleared" | "asked" | "owed";
	ruleSettled: boolean;
};

export type Eligibility =
	| { kind: "private" }
	| {
			kind: "not_yet";
			why: "no_sign" | "rule" | "rows" | "no_cleared";
			owed: number[];
	  }
	| { kind: "may_search" };

/**
 * The decision for each lookup text, from its rows, checked in this order: private when any row of any key that shares
 * the text is private; not_yet `no_sign` when no row is a sign of a store; not_yet `rule` when every row is settled by a
 * rule; not_yet `rows` when a row is still waiting, has given up, or is answered but not cleared (its mark is asked or
 * owed); not_yet `no_cleared` when no answered row is cleared; otherwise may_search. A `never` row blocks nothing and
 * clears nothing. `owed` lists the answered rows whose mark is owed, and is empty for the other reasons.
 */
export function eligibility(rows: EligibilityRow[]): Map<string, Eligibility> {
	const byText = new Map<string, EligibilityRow[]>();

	for (const row of rows) {
		const group = byText.get(row.lookupText);

		if (group) group.push(row);
		else byText.set(row.lookupText, [row]);
	}

	return new Map(
		[...byText].map(([text, group]) => [text, decideText(group)] as const),
	);
}

function decideText(rows: EligibilityRow[]): Eligibility {
	if (rows.some((row) => row.private)) return { kind: "private" };

	const owed = rows.flatMap((row) =>
		row.jev === "answered" && row.mark === "owed" ? [row.id] : [],
	);

	if (!rows.some((row) => row.sign))
		return { kind: "not_yet", why: "no_sign", owed: [] };

	if (rows.every((row) => row.ruleSettled))
		return { kind: "not_yet", why: "rule", owed: [] };

	const asked = rows.some(
		(row) =>
			row.jev === "waiting" ||
			row.jev === "gave_up" ||
			(row.jev === "answered" && row.mark !== "cleared"),
	);

	if (asked) return { kind: "not_yet", why: "rows", owed };

	if (!rows.some((row) => row.jev === "answered" && row.mark === "cleared"))
		return { kind: "not_yet", why: "no_cleared", owed };

	return { kind: "may_search" };
}

/**
 * True when the row holds a Jev answer: any column Jev's answer writes (saveJevResultStatements), read from the row
 * itself. A person's choice on its own is not one of them, so a row a person filed and Jev never asked does not hold one.
 */
export function holdsJevAnswerSql(alias: string): string {
	return `(${alias}.category_confidence IS NOT NULL OR ${alias}.jev_category_id IS NOT NULL
		OR ${alias}.jev_also_category_id IS NOT NULL OR ${alias}.income_confidence IS NOT NULL
		OR ${alias}.transfer_confidence IS NOT NULL OR ${alias}.category_source = 'jev'
		OR ${alias}.income_source = 'jev' OR ${alias}.excluded_source = 'jev'
		OR ${alias}.jev_none_fit = 1 OR ${alias}.jev_mixed IS NOT NULL OR ${alias}.details_asked = 1
		OR (${alias}.credit_reviewed = 1 AND ${alias}.credit_reviewed_by IS NULL))`;
}

/**
 * A read row's privacy and sign, pure: `privateText` judges a text (privateTextReason) and is passed in so each distinct text is
 * judged once. A row with no account is never a sign (the LEFT JOIN leaves its account empty), but its privacy facts still apply.
 */
export function readRowFacts(
	row: ReadRow,
	privateText: (text: string) => boolean,
) {
	const isPrivate =
		row.flagTransfer === 1 ||
		row.flagIncome === 1 ||
		row.flagReimbursement === 1 ||
		row.excluded === 1 ||
		row.transferKind === 1 ||
		row.maybe === 1 ||
		isPrivatePlaidCategory(row.plaidColumn) ||
		row.storedPrivate === 1 ||
		privateText(row.merchantKey) ||
		privateText(row.rawName);

	const sign =
		row.accountType !== null &&
		row.parentId === null &&
		row.accountType !== "cash" &&
		row.accountSubtype !== "apple_card" &&
		row.plaidTransactionId !== null &&
		row.plaidColumn !== null &&
		!isPrivatePlaidCategory(row.plaidColumn);

	return { private: isPrivate, sign };
}

/** One transaction's columns for the read: its live facts, its stored mark, and what Jev is told (jevSeenColumnsSql). */
export type ReadRow = JevSeenColumns & {
	id: number;
	rawName: string;
	plaidColumn: string | null;
	plaidTransactionId: string | null;
	flagTransfer: number;
	flagIncome: number;
	flagReimbursement: number;
	excluded: number;
	transferKind: number;
	maybe: number | null;
	parentId: number | null;
	isSplit: number;
	/** FOLLOWS_PURCHASE: a refund that follows its linked purchase, which pendingForJev never selects. */
	followsPurchase: number;
	accountSubtype: string | null;
	categoryId: number | null;
	categorySource: string | null;
	categoryConfidence: number | null;
	attempts: number;
	holdsAnswer: number;
	storedPrivate: number | null;
	merchantRule: number;
	markInput: string | null;
	markCleared: number | null;
};

const READ_SQL = `SELECT t.id AS id, t.raw_name AS rawName, t.plaid_category AS plaidColumn,
		t.plaid_transaction_id AS plaidTransactionId, t.flag_transfer AS flagTransfer,
		t.flag_income AS flagIncome, t.flag_reimbursement AS flagReimbursement, t.excluded AS excluded,
		(t.kind = 'transfer') AS transferKind, (${MAYBE_IN_RANGE_SQL}) AS maybe,
		t.parent_id AS parentId, t.is_split AS isSplit, (${FOLLOWS_PURCHASE}) AS followsPurchase, a.subtype AS accountSubtype,
		t.category_id AS categoryId, t.category_source AS categorySource,
		t.category_confidence AS categoryConfidence, t.jev_attempts AS attempts,
		${holdsJevAnswerSql("t")} AS holdsAnswer, mlt.private AS storedPrivate,
		EXISTS (SELECT 1 FROM merchants m JOIN categories c ON c.id = m.default_category_id
			WHERE m.raw_name = ${merchantKeySql("t")} AND c.archived = 0) AS merchantRule,
		lc.input_mark AS markInput, lc.cleared AS markCleared,
		${jevSeenColumnsSql()}
	FROM transactions t
	LEFT JOIN accounts a ON a.id = t.account_id
	LEFT JOIN household_people hp ON hp.id = t.for_person_id
	LEFT JOIN transactions rp ON rp.id = t.refund_of_id
	LEFT JOIN merchant_lookup_texts mlt ON mlt.merchant_key = ${merchantKeySql("t")}
	LEFT JOIN lookup_cleared lc ON lc.transaction_id = t.id`;

/** The bank-text rules that settle a text: the cleaned text of each rule whose category is not archived. */
const RULES_SQL = `SELECT r.cleaned_text AS cleanedText FROM bank_text_rules r
	JOIN categories c ON c.id = r.category_id WHERE c.archived = 0`;

/** The jev state of a row, from its retry columns (retryStateOf), a split parent is never asked, and a filed row counts as answered only when it holds an answer or a mark. */
function jevOf(row: ReadRow): EligibilityRow["jev"] {
	// A split parent has no category of its own and Jev is not asked about it again, so it is never waiting. It still keeps
	// its mark: answered when it has a lookup_cleared row or holds a Jev answer, otherwise never.
	// A refund that follows its purchase is never asked (pendingForJev leaves it out), so it is never waiting either: it is
	// answered when it has a lookup_cleared row or holds a Jev answer, otherwise never, as a split parent is.
	if (row.isSplit === 1 || row.followsPurchase === 1)
		return row.holdsAnswer === 1 || row.markInput !== null
			? "answered"
			: "never";

	const state = retryStateOf({
		attempts: row.attempts,
		categoryId: row.categoryId,
		categorySource: row.categorySource,
		confidence: row.categoryConfidence,
	});

	if (state === "waiting") return "waiting";

	// A row Jev gave up on after a privacy answer keeps that answer: its mark decides, as for any answered row. Without a mark,
	// it is still gave_up, and holds its store back (BUG_GAVE_UP_OK).
	if (state === "gave_up")
		return row.markInput !== null ? "answered" : "gave_up";

	if (state === "unsure") return "answered";

	return row.holdsAnswer === 1 || row.markInput !== null ? "answered" : "never";
}

/**
 * The read: one batch over every transaction and the live rules, decided in TypeScript. `only` filters the output, by the
 * live lookup text of each key, after the read, so a key is never dropped because its stored text is stale.
 */
export async function readEligibilityRows(
	db: D1Database,
	only?: { lookupTexts: string[] },
): Promise<EligibilityRow[]> {
	const batch = await db.batch([db.prepare(READ_SQL), db.prepare(RULES_SQL)]);

	// SAFETY: READ_SQL selects exactly the ReadRow columns, and RULES_SQL selects cleanedText, so each result has its shape.
	const readRows = (batch[0]?.results ?? []) as ReadRow[];
	// SAFETY: see above; RULES_SQL's rows are { cleanedText }.
	const ruleRows = (batch[1]?.results ?? []) as { cleanedText: string }[];

	const rules = new Set(ruleRows.map((rule) => rule.cleanedText));

	const textReasons = new Map<string, boolean>();

	const privateText = (text: string) => {
		let known = textReasons.get(text);

		if (known === undefined) {
			known = privateTextReason(text) !== null;
			textReasons.set(text, known);
		}

		return known;
	};

	const wanted = only ? new Set(only.lookupTexts) : null;

	const decided = await Promise.all(
		readRows.map(async (row): Promise<EligibilityRow | null> => {
			const merchantKey = row.merchantKey;
			const lookupText = lookupTextOf(merchantKey);

			if (wanted && !wanted.has(lookupText)) return null;

			const { private: isPrivate, sign } = readRowFacts(row, privateText);

			const stored =
				row.markInput === null
					? null
					: { inputMark: row.markInput, cleared: row.markCleared ?? 0 };

			const mark =
				stored === null
					? "owed"
					: markState(stored, await inputMark(jevSeenOf(row)));

			return {
				id: row.id,
				lookupText,
				private: isPrivate,
				sign,
				jev: jevOf(row),
				mark,
				ruleSettled:
					row.merchantRule === 1 || rules.has(cleanBankText(row.rawName)),
			};
		}),
	);

	return decided.filter((row): row is EligibilityRow => row !== null);
}

/** The read, then the decision: each lookup text's eligibility (`only` as readEligibilityRows takes it). */
export async function readEligibility(
	db: D1Database,
	only?: { lookupTexts: string[] },
): Promise<Map<string, Eligibility>> {
	return eligibility(await readEligibilityRows(db, only));
}
