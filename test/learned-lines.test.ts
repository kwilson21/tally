import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type AnswerRow,
	learnedLines,
	loadLearnedLines,
} from "../src/db/learned-lines";
import { resetDemo } from "../src/demo/reset";

// "What Tally has learned" (decisions 156 and 162): one line per cleaned bank text, derived from the person's own
// confirmed answers. The pure part is tested over rows; the loader is tested against the database's filters.

const db = env.DB;

const ENTERTAINMENT = {
	categoryId: 11,
	categoryName: "Entertainment",
	icon: "entertainment",
	color: "cat-blue",
};

const BOOKS = {
	categoryId: 40,
	categoryName: "Books & audio",
	icon: "books",
	color: "cat-plum",
};

const GROCERIES = {
	categoryId: 1,
	categoryName: "Groceries",
	icon: "groceries",
	color: "cat-blue",
};

function answer(
	id: number,
	rawName: string,
	category: typeof ENTERTAINMENT,
	date = `2026-10-${String(id).padStart(2, "0")}`,
	updatedAt = `${date} 12:00:00`,
): AnswerRow {
	return { id, date, rawName, updatedAt, ...category };
}

describe("learnedLines: grouping by cleaned bank text", () => {
	it("groups two Audible texts that differ only in their reference and date into one line", () => {
		const lines = learnedLines([
			answer(1, "AUDIBLE*TE3E10I7 WA 07/26", BOOKS, "2026-07-26"),
			answer(2, "AUDIBLE*ZZ99X1 WA 08/04", BOOKS, "2026-08-04"),
		]);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			cleanedText: "audible",
			name: "Audible",
			categoryName: "Books & audio",
			answers: 2,
			vague: false,
		});
	});

	it("keeps the same merchant with different bank texts as different lines", () => {
		const lines = learnedLines([
			answer(1, "AMAZON MKTPLACE PMTS", GROCERIES),
			answer(2, "AMAZON.COM*RT4K2", ENTERTAINMENT),
		]);

		expect(lines.map((line) => line.cleanedText)).toEqual([
			"amazon mktplace pmts",
			"amazon.com",
		]);
	});

	it("never makes a line from text that cleans to nothing", () => {
		expect(learnedLines([answer(1, "POS DEBIT", GROCERIES)])).toEqual([]);
	});

	it("is empty when there are no answers", () => {
		expect(learnedLines([])).toEqual([]);
	});

	it("tidies the name for people, and never shows the raw bank text", () => {
		const [line] = learnedLines([answer(1, "NETFLIX.COM", ENTERTAINMENT)]);
		expect(line?.name).toBe("Netflix.com");
	});
});

describe("learnedLines: the category and the count", () => {
	it("takes the most common category among the last five answers, and counts it", () => {
		// Newest first: E E S S S, then an older E. Only the last five count, so Shopping's three win.
		const rows = [
			answer(6, "NETFLIX.COM", ENTERTAINMENT, "2026-10-06"),
			answer(5, "NETFLIX.COM", ENTERTAINMENT, "2026-10-05"),
			answer(4, "NETFLIX.COM", GROCERIES, "2026-10-04"),
			answer(3, "NETFLIX.COM", GROCERIES, "2026-10-03"),
			answer(2, "NETFLIX.COM", GROCERIES, "2026-10-02"),
			answer(1, "NETFLIX.COM", ENTERTAINMENT, "2026-10-01"),
		];

		const [line] = learnedLines(rows);
		expect(line?.categoryName).toBe("Groceries");
		expect(line?.answers).toBe(3);
	});

	it("breaks a tie with the latest answer", () => {
		// Newest first: Entertainment, Books, Entertainment, Books, Groceries. Two each; Entertainment is newest.
		const rows = [
			answer(5, "NETFLIX.COM", ENTERTAINMENT, "2026-10-05"),
			answer(4, "NETFLIX.COM", BOOKS, "2026-10-04"),
			answer(3, "NETFLIX.COM", ENTERTAINMENT, "2026-10-03"),
			answer(2, "NETFLIX.COM", BOOKS, "2026-10-02"),
			answer(1, "NETFLIX.COM", GROCERIES, "2026-10-01"),
		];

		const [line] = learnedLines(rows);
		expect(line?.categoryName).toBe("Entertainment");
		expect(line?.answers).toBe(2);
	});

	it("says From 1 when a single answer is all there is", () => {
		const [line] = learnedLines([answer(1, "NETFLIX.COM", ENTERTAINMENT)]);
		expect(line?.answers).toBe(1);
	});

	it("orders answers on the same day by id, newest first", () => {
		const rows = [
			answer(1, "NETFLIX.COM", GROCERIES, "2026-10-05"),
			answer(2, "NETFLIX.COM", ENTERTAINMENT, "2026-10-05"),
		];

		expect(learnedLines(rows)[0]?.categoryName).toBe("Entertainment");
	});
});

describe("learnedLines: Forget", () => {
	const forgotAt = "2026-10-10 09:00:00";

	it("drops answers made no later than the Forget, so no line shows", () => {
		const rows = [
			answer(
				1,
				"NETFLIX.COM",
				ENTERTAINMENT,
				"2026-10-09",
				"2026-10-09 08:00:00",
			),
		];

		expect(
			learnedLines(rows, [
				{ cleanedText: "netflix.com", forgottenAt: forgotAt },
			]),
		).toEqual([]);
	});

	it("brings the line back from an answer changed after the Forget, and counts only those", () => {
		const rows = [
			answer(3, "NETFLIX.COM", BOOKS, "2026-10-11", "2026-10-11 10:00:00"),
			answer(
				2,
				"NETFLIX.COM",
				ENTERTAINMENT,
				"2026-10-09",
				"2026-10-09 08:00:00",
			),
			answer(
				1,
				"NETFLIX.COM",
				ENTERTAINMENT,
				"2026-10-08",
				"2026-10-08 08:00:00",
			),
		];

		const [line] = learnedLines(rows, [
			{ cleanedText: "netflix.com", forgottenAt: forgotAt },
		]);

		expect(line?.categoryName).toBe("Books & audio");
		expect(line?.answers).toBe(1);
	});

	it("leaves other texts alone", () => {
		const rows = [
			answer(1, "NETFLIX.COM", ENTERTAINMENT),
			answer(2, "AUDIBLE WA", BOOKS),
		];

		const lines = learnedLines(rows, [
			{ cleanedText: "netflix.com", forgottenAt: forgotAt },
		]);

		expect(lines.map((line) => line.cleanedText)).toEqual(["audible"]);
	});
});

describe("learnedLines: a known-vague text", () => {
	it("still gets a line, marked vague", () => {
		const [line] = learnedLines([
			answer(1, "APPLE.COM/BILL 09/30", ENTERTAINMENT),
		]);

		expect(line).toMatchObject({ cleanedText: "apple.com/bill", vague: true });
	});

	it("is not vague for a text that only starts with the same letters", () => {
		const [line] = learnedLines([
			answer(1, "APPLE.COM/BILLING INC", ENTERTAINMENT),
		]);

		expect(line?.vague).toBe(false);
	});
});

// The loader reads the database, so its filters are tested on real rows. Each test starts from a clean ledger.
beforeEach(async () => {
	await resetDemo(db, "2026-10-15");
	// The demo has no Entertainment category; the default list does, and these tests file rows under it.
	await db.batch([
		db.prepare(
			"INSERT OR IGNORE INTO categories (name, name_key, icon, color, sort_order) VALUES ('Entertainment', 'entertainment', 'entertainment', 'cat-blue', 90)",
		),
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

async function tx(fields: {
	raw: string;
	category?: string | null;
	source?: string | null;
	date?: string;
	excluded?: number;
	pending?: number;
	isSplit?: number;
	parentId?: number | null;
}): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, category_id,
				category_source, excluded, pending, is_split, parent_id)
			VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), ?, 1499, ?, ?, ?, ?, ?, ?, ?)
			RETURNING id`,
		)
		.bind(
			`plaid-${crypto.randomUUID()}`,
			fields.date ?? "2026-10-02",
			fields.raw,
			fields.category === null || fields.category === undefined
				? null
				: await categoryId(fields.category),
			fields.source ?? null,
			fields.excluded ?? 0,
			fields.pending ?? 0,
			fields.isSplit ?? 0,
			fields.parentId ?? null,
		)
		.first<{ id: number }>();

	return row?.id ?? 0;
}

describe("loadLearnedLines: which rows are evidence", () => {
	it("counts a person's answer and a merchant rule, and never Jev's own guess", async () => {
		await tx({ raw: "NETFLIX.COM", category: "Entertainment", source: "user" });
		await tx({
			raw: "SPOTIFY USA",
			category: "Entertainment",
			source: "merchant_rule",
		});
		await tx({ raw: "TRADER JOES 0412", category: "Groceries", source: "jev" });
		const lines = await loadLearnedLines(db);
		expect(lines.map((line) => line.cleanedText)).toEqual([
			"netflix.com",
			"spotify usa",
		]);
	});

	it("does not count an archived category, a pending row, an excluded row or a split parent", async () => {
		await db
			.prepare(
				"INSERT OR IGNORE INTO categories (name, name_key, icon, color, sort_order, archived) VALUES ('Retired', 'retired', 'tag', 'cat-blue', 91, 1)",
			)
			.run();
		await tx({ raw: "HULU 1111", category: "Retired", source: "user" });
		await tx({
			raw: "HULU 1111",
			category: "Entertainment",
			source: "user",
			pending: 1,
		});
		await tx({
			raw: "HULU 1111",
			category: "Entertainment",
			source: "user",
			excluded: 1,
		});
		await tx({
			raw: "HULU 1111",
			category: "Entertainment",
			source: "user",
			isSplit: 1,
		});
		expect(await loadLearnedLines(db)).toEqual([]);
	});

	it("counts a split part, whose own row is not the parent", async () => {
		const parent = await tx({
			raw: "COSTCO WHSE 0231",
			category: null,
			source: null,
			isSplit: 1,
		});

		await tx({
			raw: "COSTCO WHSE 0231",
			category: "Groceries",
			source: "user",
			parentId: parent,
		});
		const [line] = await loadLearnedLines(db);
		expect(line).toMatchObject({
			cleanedText: "costco whse 0231",
			categoryName: "Groceries",
			answers: 1,
		});
	});

	it("forgets a line when its text is forgotten, and brings it back from a later answer", async () => {
		await tx({
			raw: "NETFLIX.COM",
			category: "Entertainment",
			source: "user",
			date: "2026-10-02",
		});
		// Forgotten in the future, so the answer's real updated_at is earlier than the Forget: the line stays hidden.
		await db
			.prepare(
				"INSERT INTO forgotten_texts (cleaned_text, forgotten_at) VALUES ('netflix.com', '2099-01-01 00:00:00')",
			)
			.run();
		expect(await loadLearnedLines(db)).toEqual([]);
		await db
			.prepare(
				"UPDATE transactions SET updated_at = '2099-01-02 09:00:00' WHERE raw_name = 'NETFLIX.COM'",
			)
			.run();
		expect(
			(await loadLearnedLines(db)).map((line) => line.cleanedText),
		).toEqual(["netflix.com"]);
	});
});
