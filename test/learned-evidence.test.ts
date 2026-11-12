import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadLearnedLines } from "../src/db/learned-lines";
import { resetDemo } from "../src/demo/reset";

// Which confirmed answers may make a learned line (decisions 156 and 162): not excluded, even when a bill or plan is
// linked to it; not a trip Jev calls mixed (a split part follows its parent); not pending, archived or a split parent.

const db = env.DB;

beforeEach(async () => {
	await resetDemo(db, "2026-10-15");
	await db.batch([
		db.prepare(
			"INSERT OR IGNORE INTO categories (name, name_key, icon, color, sort_order) VALUES ('Entertainment', 'entertainment', 'entertainment', 'cat-blue', 90)",
		),
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM forgotten_texts"),
	]);
});

async function categoryId(name: string) {
	const row = await db
		.prepare("SELECT id FROM categories WHERE name = ?")
		.bind(name)
		.first<{ id: number }>();

	return row?.id ?? 0;
}

/** A confirmed answer: a row with the given category, source and Jev's fields. */
async function tx(fields: {
	raw: string;
	category?: string;
	source?: string | null;
	excluded?: number;
	jevMixed?: number | null;
	jevCategory?: string | null;
	jevAlso?: string | null;
	isSplit?: number;
	parentId?: number | null;
}): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, category_id,
				category_source, excluded, jev_mixed, jev_category_id, jev_also_category_id, is_split, parent_id)
			VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', 1499, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING id`,
		)
		.bind(
			`plaid-${crypto.randomUUID()}`,
			fields.raw,
			fields.category ? await categoryId(fields.category) : null,
			fields.source ?? "user",
			fields.excluded ?? 0,
			fields.jevMixed ?? null,
			fields.jevCategory ? await categoryId(fields.jevCategory) : null,
			fields.jevAlso ? await categoryId(fields.jevAlso) : null,
			fields.isSplit ?? 0,
			fields.parentId ?? null,
		)
		.first<{ id: number }>();

	return row?.id ?? 0;
}

describe("learned lines: excluded rows", () => {
	it("an excluded row linked to a bill makes no line; a counted one does", async () => {
		const bill = await db
			.prepare("SELECT id FROM bills ORDER BY id LIMIT 1")
			.first<{ id: number }>();

		const excluded = await tx({
			raw: "PG&E 0930",
			category: "Entertainment",
			excluded: 1,
		});

		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026-10', ?, 'user', 'linked')",
			)
			.bind(bill?.id ?? 0, excluded)
			.run();
		expect(await loadLearnedLines(db)).toEqual([]);

		await tx({ raw: "NETFLIX.COM", category: "Entertainment" });
		expect(
			(await loadLearnedLines(db)).map((line) => line.cleanedText),
		).toEqual(["netflix.com"]);
	});
});

describe("learned lines: trips Jev calls mixed", () => {
	it("a row Jev marked mixed makes no line even when a person chose its category; an unmarked row does", async () => {
		await tx({
			raw: "COSTCO WHSE 0231",
			category: "Groceries",
			jevMixed: 0.99,
			jevCategory: "Groceries",
			jevAlso: "Entertainment",
		});
		expect(await loadLearnedLines(db)).toEqual([]);

		await tx({
			raw: "NETFLIX.COM",
			category: "Entertainment",
			jevMixed: null,
			jevCategory: "Entertainment",
		});
		expect(
			(await loadLearnedLines(db)).map((line) => line.cleanedText),
		).toEqual(["netflix.com"]);
	});

	it("a split part follows its parent: a part of a trip Jev called mixed makes no line", async () => {
		const parent = await tx({
			raw: "TARGET 0412",
			source: null,
			isSplit: 1,
			jevMixed: 0.99,
			jevCategory: "Groceries",
			jevAlso: "Entertainment",
		});

		await tx({ raw: "TARGET 0412", category: "Groceries", parentId: parent });
		expect(await loadLearnedLines(db)).toEqual([]);
	});
});
