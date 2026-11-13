import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	bankClearsCategorySql,
	jevGuessClearedByAmountSql,
	setCategoryClearedByBankSql,
} from "../src/plaid/category-clear";
import { present } from "./helpers/present";

// A bank correction clears a category in two cases, and the sync's three SQL statements say it from one definition
// (src/plaid/category-clear.ts, audit finding). This file states the two cases in plain TypeScript and checks the SQL
// against it over every row shape and every kind of change.
//
//   1. Jev's guess is cleared when the amount changes, on a whole transaction that was not split away.
//   2. A merchant rule's pick is cleared when the merchant changes, unless a changed amount just un-split the row.
//
// A person's pick, a bill's, and a row with no category are never cleared by the bank.

type Row = {
	isSplit: 0 | 1;
	source: "jev" | "merchant_rule" | "user" | "bill" | null;
	splitRemovedFrom: number | null;
};

type Change = { amount: boolean; merchant: boolean };

const clearsCategory = (row: Row, change: Change) =>
	(row.isSplit === 0 &&
		row.source === "jev" &&
		row.splitRemovedFrom === null &&
		change.amount) ||
	(!(row.isSplit === 1 && change.amount) &&
		row.splitRemovedFrom === null &&
		row.source === "merchant_rule" &&
		change.merchant);

const jevGuessCleared = (row: Row, amountChanged: boolean) =>
	row.isSplit === 0 &&
	row.source === "jev" &&
	row.splitRemovedFrom === null &&
	amountChanged;

const ROWS: Row[] = [];

for (const isSplit of [0, 1] as const)
	for (const source of ["jev", "merchant_rule", "user", "bill", null] as const)
		for (const splitRemovedFrom of [null, 1250])
			ROWS.push({ isSplit, source, splitRemovedFrom });

const CHANGES: Change[] = [
	{ amount: false, merchant: false },
	{ amount: true, merchant: false },
	{ amount: false, merchant: true },
	{ amount: true, merchant: true },
];

const SYNC = present(
	Object.values(
		import.meta.glob("../src/plaid/sync.ts", {
			query: "?raw",
			import: "default",
			eager: true,
		}),
	)[0],
);

const flag = (yes: boolean) => (yes ? "1" : "0");
const ref = (column: string) => `r.${column}`;

/** The SQL's answer for one row and one change, as the fragments are used in the sync's statements. */
async function sqlClears(row: Row, change: Change): Promise<boolean> {
	const answer = await env.DB.prepare(
		`SELECT CASE WHEN ${bankClearsCategorySql(ref, { amount: flag(change.amount), merchant: flag(change.merchant) })} THEN 1 ELSE 0 END AS cleared
		 FROM (SELECT ? AS is_split, ? AS category_source, ? AS split_removed_from_cents) r`,
	)
		.bind(row.isSplit, row.source, row.splitRemovedFrom)
		.first<{ cleared: number }>();

	return present(answer).cleared === 1;
}

describe("a bank correction clears a category (bankClearsCategorySql)", () => {
	it("agrees with the plain statement of the two cases, for every row shape and every change", async () => {
		const wrong: string[] = [];

		for (const row of ROWS)
			for (const change of CHANGES)
				if ((await sqlClears(row, change)) !== clearsCategory(row, change))
					wrong.push(`${JSON.stringify(row)} ${JSON.stringify(change)}`);

		expect(wrong).toEqual([]);
	});

	it("clears something in some cases and leaves something in others (no vacuous pass)", () => {
		const answers = ROWS.flatMap((row) =>
			CHANGES.map((change) => clearsCategory(row, change)),
		);

		expect(answers).toContain(true);
		expect(answers).toContain(false);
	});
});

describe("Jev's guess is let go of when the amount changes (jevGuessClearedByAmountSql)", () => {
	it("agrees with the Jev case alone, for every row shape", async () => {
		const wrong: string[] = [];

		for (const row of ROWS)
			for (const amountChanged of [false, true]) {
				const answer = await env.DB.prepare(
					`SELECT CASE WHEN ${jevGuessClearedByAmountSql(ref, flag(amountChanged))} THEN 1 ELSE 0 END AS cleared
					 FROM (SELECT ? AS is_split, ? AS category_source, ? AS split_removed_from_cents) r`,
				)
					.bind(row.isSplit, row.source, row.splitRemovedFrom)
					.first<{ cleared: number }>();

				if (
					(present(answer).cleared === 1) !==
					jevGuessCleared(row, amountChanged)
				)
					wrong.push(`${JSON.stringify(row)} amountChanged=${amountChanged}`);
			}

		expect(wrong).toEqual([]);
	});
});

describe("both columns are cleared together (setCategoryClearedByBankSql)", () => {
	it("sets category_id and category_source to NULL on the same condition and keeps both otherwise, in a real UPDATE", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO accounts (name, type, subtype, is_liability, balance_cents) VALUES ('Clearing','depository','checking',0,0)",
			),
			env.DB.prepare(
				"INSERT INTO categories (id, name, icon, color) VALUES (901,'ClearCat','a','#000')",
			),
		]);

		const account = present(
			await env.DB.prepare(
				"SELECT id FROM accounts WHERE name = 'Clearing'",
			).first<{
				id: number;
			}>(),
		);

		const wrong: string[] = [];
		let id = 0;

		for (const row of ROWS)
			for (const change of CHANGES) {
				id += 1;
				await env.DB.prepare(
					`INSERT INTO transactions (id, account_id, date, raw_name, amount_cents, is_split, category_id, category_source, split_removed_from_cents)
					 VALUES (?, ?, '2026-10-05', 'x', 100, ?, 901, ?, ?)`,
				)
					.bind(id, account.id, row.isSplit, row.source, row.splitRemovedFrom)
					.run();
				await env.DB.prepare(
					`UPDATE transactions SET ${setCategoryClearedByBankSql((column) => `transactions.${column}`, { amount: flag(change.amount), merchant: flag(change.merchant) })} WHERE id = ?`,
				)
					.bind(id)
					.run();

				const after = present(
					await env.DB.prepare(
						"SELECT category_id, category_source FROM transactions WHERE id = ?",
					)
						.bind(id)
						.first<{
							category_id: number | null;
							category_source: string | null;
						}>(),
				);

				const cleared = clearsCategory(row, change);

				if (
					after.category_id !== (cleared ? null : 901) ||
					after.category_source !== (cleared ? null : row.source)
				)
					wrong.push(`${JSON.stringify(row)} ${JSON.stringify(change)}`);
			}

		expect(wrong).toEqual([]);
	});
});

describe("the sync does not say the two cases itself", () => {
	it("names no category source in its SQL: src/plaid/sync.ts reaches them only through src/plaid/category-clear.ts", () => {
		expect(SYNC).not.toMatch(/category_source\s*=\s*'(?:jev|merchant_rule)'/);
	});
});
