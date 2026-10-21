import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppleRow, parseAppleCsv } from "../src/apple-card/csv";
import {
	historyStart,
	type ImportResult,
	importAppleCard,
} from "../src/apple-card/import";
import { rowKey } from "../src/apple-card/plan";
import { daysBefore } from "../src/dates";
import { merchantsToAsk, namesStillAsked } from "../src/db/merchant-names";
import { pendingForJev, saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;
const TODAY = "2026-09-22";
const BY = "pat@example.test";
const HEADER =
	"Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By";

/** One made-up row in Apple's layout (Pat Rivera's card). Dates are Apple's MM/DD/YYYY. */
function row({
	tx = "09/24/2026",
	clear = "09/25/2026",
	desc = "PAT CAFE #12",
	merchant = "Pat Cafe",
	category = "Dining",
	type = "Purchase",
	amount = "12.00",
}: {
	tx?: string;
	clear?: string;
	desc?: string;
	merchant?: string;
	category?: string;
	type?: string;
	amount?: string;
} = {}): string {
	return `${tx},${clear},"${desc}","${merchant}","${category}","${type}","${amount}","Pat Rivera"`;
}

const csvOf = (...rows: string[]) => `${HEADER}\n${rows.join("\n")}\n`;

async function upload(
	text: string,
	options: { today?: string; balanceCents?: number | null } = {},
) {
	const parsed = parseAppleCsv(text);
	if (!parsed.ok) throw new Error(parsed.error);
	return importAppleCard(db, parsed.rows, {
		by: BY,
		today: options.today ?? TODAY,
		balanceCents: options.balanceCents ?? null,
	});
}

async function uploadOk(
	text: string,
	options: { today?: string; balanceCents?: number | null } = {},
): Promise<ImportResult> {
	const result = await upload(text, options);
	if (!result.ok) throw new Error(result.error);
	return result;
}

type Card = {
	id: number;
	name: string;
	type: string;
	subtype: string | null;
	is_liability: number;
	plaid_item_id: number | null;
	plaid_account_id: string | null;
	uploaded_on: string | null;
	balance_on: string | null;
	balance_cents: number;
	removed_at: string | null;
	counted_from: string | null;
};

const card = () =>
	db
		.prepare("SELECT * FROM accounts WHERE subtype = 'apple_card'")
		.first<Card>();

const cardRows = () =>
	db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS rawName, t.merchant_name AS merchantName,
				t.apple_category AS appleCategory, t.plaid_category AS plaidCategory, t.pending, t.excluded,
				t.excluded_source AS excludedSource, t.credit_reviewed AS creditReviewed, t.upload_key AS uploadKey,
				t.upload_twin AS uploadTwin, t.updated_by AS updatedBy
			FROM transactions t JOIN accounts a ON a.id = t.account_id
			WHERE a.subtype = 'apple_card' ORDER BY t.id`,
		)
		.all<{
			id: number;
			date: string;
			amountCents: number;
			rawName: string;
			merchantName: string | null;
			appleCategory: string | null;
			plaidCategory: string | null;
			pending: number;
			excluded: number;
			excludedSource: string | null;
			creditReviewed: number | null;
			uploadKey: string | null;
			uploadTwin: number | null;
			updatedBy: string | null;
		}>()
		.then((result) => result.results);

const countCardRows = async () =>
	Number(
		(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.subtype = 'apple_card'",
				)
				.first<{ n: number }>()
		)?.n,
	);

/** The earliest date among the household's Plaid rows, kept rows included. */
const bankEarliest = async () =>
	(
		await db
			.prepare(
				"SELECT MIN(t.date) AS d FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.plaid_item_id IS NOT NULL",
			)
			.first<{ d: string | null }>()
	)?.d ?? null;

beforeEach(async () => {
	await resetDemo(db, TODAY);
});

afterEach(async () => {
	await db.prepare("DROP TRIGGER IF EXISTS apple_test_boom").run();
});

describe("importAppleCard: the account", () => {
	it("creates one Apple Card account, and a second upload reuses it", async () => {
		await uploadOk(csvOf(row()));
		const first = await card();
		expect(first).toMatchObject({
			name: "Apple Card",
			type: "credit",
			subtype: "apple_card",
			is_liability: 1,
			plaid_item_id: null,
			plaid_account_id: null,
		});
		await uploadOk(csvOf(row({ desc: "OTHER CAFE", merchant: "Other Cafe" })));
		const again = await card();
		expect(again?.id).toBe(first?.id);
		const count = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM accounts WHERE subtype = 'apple_card'",
			)
			.first<{ n: number }>();
		expect(count?.n).toBe(1);
	});
});

describe("importAppleCard: a stored row", () => {
	it("stores the clearing date, Apple's Category in its own column, and the bank's fields the way sync sets them", async () => {
		const result = await uploadOk(
			csvOf(row(), row({ clear: "", tx: "09/23/2026", desc: "UNCLEARED" })),
		);
		expect(result.notCleared).toBe(1);
		const [stored] = await cardRows();
		expect(stored).toMatchObject({
			date: "2026-09-25",
			rawName: "PAT CAFE #12",
			merchantName: "Pat Cafe",
			appleCategory: "Dining",
			plaidCategory: null,
			pending: 0,
			excluded: 0,
			uploadTwin: 1,
			updatedBy: BY,
			amountCents: 1200,
			creditReviewed: 1,
		});
		expect(stored?.uploadKey).toBe(
			rowKey({
				line: 2,
				transactionDate: "2026-09-24",
				clearingDate: "2026-09-25",
				description: "PAT CAFE #12",
				merchant: "Pat Cafe",
				category: "Dining",
				type: "Purchase",
				amountCents: 1200,
			}),
		);
	});

	it("marks money in as not reviewed as a credit, as sync does", async () => {
		await uploadOk(
			csvOf(
				row({
					desc: "RETURN",
					merchant: "Pat Cafe",
					type: "Credit",
					amount: "-5.00",
				}),
			),
		);
		const [stored] = await cardRows();
		expect(stored).toMatchObject({ amountCents: -500, creditReviewed: 0 });
	});

	it("leaves a Payment out, with the bank's exclusion, and counts a Credit", async () => {
		await uploadOk(
			csvOf(
				row({
					desc: "Payment Thank You",
					merchant: "Apple",
					category: "Payment",
					type: "Payment",
					amount: "-50.00",
				}),
				row({ desc: "STORE CREDIT", type: "Credit", amount: "-5.00" }),
			),
		);
		const [payment, credit] = await cardRows();
		expect(payment).toMatchObject({
			excluded: 1,
			excludedSource: "plaid",
		});
		expect(credit).toMatchObject({ excluded: 0, excludedSource: null });
	});

	it("leaves out a bounced payment and its reversal, so the pair adds nothing to the month, and counts a money-in REVERSAL row", async () => {
		await uploadOk(
			csvOf(
				row({
					tx: "09/10/2026",
					clear: "09/11/2026",
					desc: "Payment Thank You",
					merchant: "Apple",
					category: "Payment",
					type: "Payment",
					amount: "-50.00",
				}),
				row({
					tx: "09/14/2026",
					clear: "09/15/2026",
					desc: "ACH DEPOSIT INTERNET TRANSFER FROM ACCOUNT ENDING IN 1234 (REVERSAL - INSUFFICIENT FUNDS)",
					merchant: "Apple",
					category: "Other",
					type: "Other",
					amount: "50.00",
				}),
				row({
					tx: "09/16/2026",
					clear: "09/17/2026",
					desc: "PAT CAFE REVERSAL",
					merchant: "Pat Cafe",
					category: "Dining",
					type: "Other",
					amount: "-8.00",
				}),
			),
		);
		const rows = await cardRows();
		expect(rows.map((stored) => stored.excluded)).toEqual([1, 1, 0]);
		expect(rows.map((stored) => stored.excludedSource)).toEqual([
			"plaid",
			"plaid",
			null,
		]);
		const counted = await db
			.prepare(
				`SELECT COALESCE(SUM(t.amount_cents), 0) AS total FROM transactions t
				 JOIN accounts a ON a.id = t.account_id
				 WHERE a.subtype = 'apple_card' AND t.excluded = 0`,
			)
			.first<{ total: number }>();
		// The money-in REVERSAL row counts by its sign: -$8.00, not left out with the pair.
		expect(counted?.total).toBe(-800);
	});
});

describe("importAppleCard: nothing counted twice", () => {
	it("uploading the same file twice adds nothing the second time", async () => {
		const text = csvOf(
			row(),
			row({ desc: "OTHER CAFE", merchant: "Other Cafe" }),
		);
		expect((await uploadOk(text)).added).toBe(2);
		const again = await uploadOk(text);
		expect(again).toMatchObject({ added: 0, already: 2 });
		expect(await countCardRows()).toBe(2);
	});

	it("two uploads at once add each row once between them", async () => {
		const text = csvOf(
			row(),
			row({ desc: "OTHER CAFE", merchant: "Other Cafe" }),
		);
		const [a, b] = await Promise.all([uploadOk(text), uploadOk(text)]);
		expect(a.added + b.added).toBe(2);
		expect(await countCardRows()).toBe(2);
	});

	it("adds only the twins beyond what Tally holds", async () => {
		expect((await uploadOk(csvOf(row(), row()))).added).toBe(2);
		const third = await uploadOk(csvOf(row(), row(), row()));
		expect(third).toMatchObject({ added: 1, already: 2 });
		const twins = (await cardRows()).map((stored) => stored.uploadTwin);
		expect(twins.sort()).toEqual([1, 2, 3]);
	});

	it("a split purchase isn't added again, because only the parent carries the key", async () => {
		await uploadOk(
			csvOf(
				row({
					amount: "45.25",
					category: "Grocery",
					desc: "GREENLEAF MARKET",
					merchant: "Greenleaf Market",
				}),
			),
		);
		const [parent] = await cardRows();
		const categories = await db
			.prepare(
				"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 2",
			)
			.all<{ id: number }>();
		const [first, second] = categories.results;
		const split = await saveSplit(
			db,
			Number(parent?.id),
			[
				{ categoryId: Number(first?.id), amountCents: 2000 },
				{ categoryId: Number(second?.id), amountCents: 2525 },
			],
			BY,
		);
		expect(split.saved).toBe(true);
		const again = await uploadOk(
			csvOf(
				row({
					amount: "45.25",
					category: "Grocery",
					desc: "GREENLEAF MARKET",
					merchant: "Greenleaf Market",
				}),
			),
		);
		expect(again).toMatchObject({ added: 0, already: 1 });
		const children = await db
			.prepare("SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?")
			.bind(parent?.id)
			.first<{ n: number }>();
		expect(children?.n).toBe(2);
	});

	it("an upload never changes a row it holds, so a Payment counted back in stays counted", async () => {
		const payment = row({
			desc: "Payment Thank You",
			merchant: "Apple",
			category: "Payment",
			type: "Payment",
			amount: "-50.00",
		});
		await uploadOk(csvOf(payment));
		const [stored] = await cardRows();
		await db
			.prepare(
				"UPDATE transactions SET excluded = 0, excluded_source = NULL WHERE id = ?",
			)
			.bind(stored?.id)
			.run();
		const again = await uploadOk(csvOf(payment));
		expect(again.added).toBe(0);
		const [after] = await cardRows();
		expect(after).toMatchObject({ excluded: 0, excludedSource: null });
	});
});

describe("importAppleCard: a removed card reopens", () => {
	it("reopens the same account with its kept rows counted as held, and nothing doubles", async () => {
		await uploadOk(
			csvOf(row(), row({ desc: "OTHER CAFE", merchant: "Other Cafe" })),
			{ balanceCents: 100000 },
		);
		const before = await card();
		await db
			.prepare(
				"UPDATE accounts SET removed_at = ?, balance_on = NULL WHERE id = ?",
			)
			.bind("2026-09-22", before?.id)
			.run();
		const again = await uploadOk(
			csvOf(row(), row({ desc: "OTHER CAFE", merchant: "Other Cafe" })),
		);
		expect(again).toMatchObject({ added: 0, already: 2 });
		const reopened = await card();
		expect(reopened).toMatchObject({ id: before?.id, removed_at: null });
		expect(await countCardRows()).toBe(2);
	});

	it("a reopening upload with a balance counts the card again from that day, and one without leaves it out", async () => {
		await uploadOk(csvOf(row()), { balanceCents: 100000, today: "2026-09-10" });
		const kept = await card();
		expect(kept?.counted_from).toBe("2026-09-10");
		await db
			.prepare(
				"UPDATE accounts SET removed_at = ?, balance_on = NULL WHERE id = ?",
			)
			.bind("2026-09-15", kept?.id)
			.run();
		await uploadOk(csvOf(row()), { today: "2026-09-20" });
		expect(await card()).toMatchObject({
			balance_on: null,
			counted_from: "2026-09-10",
			removed_at: null,
		});
		await db
			.prepare(
				"UPDATE accounts SET removed_at = ?, balance_on = NULL WHERE id = ?",
			)
			.bind("2026-09-21", kept?.id)
			.run();
		await uploadOk(csvOf(row()), { today: "2026-09-22", balanceCents: 90000 });
		expect(await card()).toMatchObject({
			balance_on: "2026-09-22",
			counted_from: "2026-09-22",
			balance_cents: 90000,
		});
	});
});

describe("importAppleCard: all or nothing", () => {
	it("saves nothing when a statement fails: the day, the balance and the rows are unchanged", async () => {
		await uploadOk(csvOf(row()), { today: "2026-09-20", balanceCents: 100000 });
		const before = await card();
		const rowsBefore = await cardRows();
		await db
			.prepare(
				"CREATE TRIGGER apple_test_boom BEFORE INSERT ON transactions WHEN NEW.raw_name = 'BOOM FAIL' BEGIN SELECT RAISE(ABORT, 'boom'); END",
			)
			.run();
		await expect(
			upload(
				csvOf(
					row({ desc: "OTHER CAFE", merchant: "Other Cafe" }),
					row({ desc: "BOOM FAIL", merchant: "Boom" }),
				),
				{ today: "2026-09-22", balanceCents: 200000 },
			),
		).rejects.toThrow();
		const after = await card();
		expect(after).toMatchObject({
			uploaded_on: "2026-09-20",
			balance_on: "2026-09-20",
			balance_cents: 100000,
		});
		expect(after?.uploaded_on).toBe(before?.uploaded_on);
		expect(await cardRows()).toEqual(rowsBefore);
	});
});

describe("importAppleCard: the balance", () => {
	it("saves a typed balance, its day's balance_history row, and replaces that row on a second upload the same day", async () => {
		await uploadOk(csvOf(row()), { today: "2026-09-22", balanceCents: 124018 });
		const day = (date: string) =>
			db
				.prepare(
					"SELECT b.balance_cents AS cents FROM balance_history b JOIN accounts a ON a.id = b.account_id WHERE a.subtype = 'apple_card' AND b.date = ?",
				)
				.bind(date)
				.first<{ cents: number }>();
		expect(await card()).toMatchObject({
			balance_cents: 124018,
			balance_on: "2026-09-22",
		});
		expect((await day("2026-09-22"))?.cents).toBe(124018);
		await uploadOk(csvOf(row({ desc: "OTHER CAFE", merchant: "Other Cafe" })), {
			today: "2026-09-22",
			balanceCents: 130000,
		});
		expect((await day("2026-09-22"))?.cents).toBe(130000);
	});

	it("stores a credit balance with its minus, and a blank balance keeps the last one", async () => {
		await uploadOk(csvOf(row()), { today: "2026-09-22", balanceCents: 124018 });
		await uploadOk(csvOf(row()), { today: "2026-09-23", balanceCents: -1200 });
		expect(await card()).toMatchObject({
			balance_cents: -1200,
			balance_on: "2026-09-23",
		});
		await uploadOk(csvOf(row()), { today: "2026-09-24", balanceCents: null });
		expect(await card()).toMatchObject({
			balance_cents: -1200,
			balance_on: "2026-09-23",
		});
	});

	it("sets counted_from to the day a balance is first typed, and leaves it alone after", async () => {
		await uploadOk(csvOf(row()), { today: "2026-09-22", balanceCents: null });
		expect((await card())?.counted_from).toBeNull();
		await uploadOk(csvOf(row()), { today: "2026-09-23", balanceCents: 5000 });
		expect(await card()).toMatchObject({ counted_from: "2026-09-23" });
		await uploadOk(csvOf(row()), { today: "2026-09-24", balanceCents: 6000 });
		expect(await card()).toMatchObject({
			counted_from: "2026-09-23",
			balance_on: "2026-09-24",
		});
	});

	it("sets uploaded_on to the household's day, whatever the balance", async () => {
		await uploadOk(csvOf(row()), { today: "2026-09-22", balanceCents: null });
		expect((await card())?.uploaded_on).toBe("2026-09-22");
	});
});

describe("importAppleCard: names", () => {
	it("suggests Apple's Merchant as the store's name, but not a name the Description already shows", async () => {
		await uploadOk(
			csvOf(
				row(),
				row({
					desc: "CORNER SHOP",
					merchant: "CORNER SHOP",
					category: "Shopping",
				}),
			),
		);
		const suggested = await db
			.prepare(
				"SELECT suggested_name AS s, suggestion_status AS st FROM merchants WHERE raw_name = 'Pat Cafe'",
			)
			.first<{ s: string | null; st: string | null }>();
		expect(suggested).toEqual({ s: "Pat Cafe", st: "pending" });
		const none = await db
			.prepare("SELECT raw_name FROM merchants WHERE raw_name = 'CORNER SHOP'")
			.first();
		expect(none).toBeNull();
	});

	it("doesn't suggest Apple's Merchant when it is the Description tidied, as sync doesn't", async () => {
		// tidyName("HARBOR DELI #7") is "Harbor deli", so that Merchant is what the list would show already.
		await uploadOk(
			csvOf(
				row({
					desc: "HARBOR DELI #7",
					merchant: "Harbor deli",
					category: "Dining",
				}),
			),
		);
		const none = await db
			.prepare("SELECT raw_name FROM merchants WHERE raw_name = 'Harbor deli'")
			.first();
		expect(none).toBeNull();
	});

	it("leaves a merchant a person named alone", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('Pat Cafe', 'Our Cafe')",
			)
			.run();
		await uploadOk(csvOf(row()));
		const named = await db
			.prepare(
				"SELECT display_name AS d, suggestion_status AS st, suggested_name AS s FROM merchants WHERE raw_name = 'Pat Cafe'",
			)
			.first<{ d: string; st: string; s: string | null }>();
		expect(named).toEqual({ d: "Our Cafe", st: "none", s: null });
	});

	it("never asks Workers AI about an Apple row, including one with a blank Merchant", async () => {
		await uploadOk(
			csvOf(
				row(),
				row({
					desc: "BLANK MERCHANT SHOP",
					merchant: "",
					category: "Shopping",
				}),
			),
		);
		const asked = await merchantsToAsk(db, 1000);
		expect(asked).not.toContain("PAT CAFE #12");
		expect(asked).not.toContain("BLANK MERCHANT SHOP");
	});

	it("keeps Apple rows out of the night's count of names still waiting", async () => {
		const before = await namesStillAsked(db);
		await uploadOk(
			csvOf(
				row({
					desc: "BLANK MERCHANT SHOP",
					merchant: "",
					category: "Shopping",
				}),
			),
		);
		expect(await namesStillAsked(db)).toBe(before);
	});
});

describe("importAppleCard: Jev's hint", () => {
	it("gives Jev Apple's category as the hint, as plaid_category", async () => {
		await uploadOk(
			csvOf(
				row({
					category: "Grocery",
					desc: "GREENLEAF MARKET",
					merchant: "Greenleaf Market",
				}),
			),
		);
		const [stored] = await cardRows();
		const pending = await pendingForJev(db, 10, { ids: [Number(stored?.id)] });
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ plaidCategory: "Grocery" });
	});
});

describe("importAppleCard: size", () => {
	const bulk = (count: number, text: (i: number) => string): AppleRow[] =>
		Array.from({ length: count }, (_, i) => ({
			line: i + 2,
			transactionDate: "2026-09-24",
			clearingDate: "2026-09-25",
			description: text(i),
			merchant: `Shop ${i}`,
			category: "Shopping",
			type: "Purchase",
			amountCents: 100 + i,
		}));

	function countingDb() {
		const insertStatements: string[] = [];
		const wrapped = {
			prepare: (sql: string) => {
				if (sql.startsWith("INSERT INTO transactions"))
					insertStatements.push(sql);
				return db.prepare(sql);
			},
			batch: (statements: D1PreparedStatement[]) => db.batch(statements),
		};
		return { wrapped: wrapped as unknown as D1Database, insertStatements };
	}

	it("stores 250 rows in one call, and returns their ids", async () => {
		const result = await importAppleCard(
			db,
			bulk(250, (i) => `SHOP ${i}`),
			{
				by: BY,
				today: TODAY,
				balanceCents: null,
			},
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.added).toBe(250);
		expect(result.addedIds).toHaveLength(250);
		expect(await countCardRows()).toBe(250);
	});

	it("stores 1,001 rows in at least three statements, and gathers every id", async () => {
		const { wrapped, insertStatements } = countingDb();
		const result = await importAppleCard(
			wrapped,
			bulk(1001, (i) => `SHOP ${i}`),
			{
				by: BY,
				today: TODAY,
				balanceCents: null,
			},
		);
		if (!result.ok) throw new Error(result.error);
		expect(insertStatements.length).toBeGreaterThanOrEqual(3);
		expect(result.addedIds).toHaveLength(1001);
		expect(new Set(result.addedIds).size).toBe(1001);
	});

	it("splits rows by size as well as by count: 500 long rows need at least two statements", async () => {
		const { wrapped, insertStatements } = countingDb();
		const long = (i: number) =>
			`${"L".repeat(990)}${String(i).padStart(4, "0")}`;
		const result = await importAppleCard(wrapped, bulk(500, long), {
			by: BY,
			today: TODAY,
			balanceCents: null,
		});
		if (!result.ok) throw new Error(result.error);
		expect(insertStatements.length).toBeGreaterThanOrEqual(2);
		expect(result.added).toBe(500);
	});
});

describe("importAppleCard: the day it starts", () => {
	it("leaves out a row cleared before the day Tally's history starts, and the result names that day", async () => {
		const start = await bankEarliest();
		await db
			.prepare("UPDATE plaid_items SET history_complete_at = datetime('now')")
			.run();
		const result = await uploadOk(
			csvOf(
				row({ clear: "09/25/2026" }),
				row({ clear: "01/05/2020", desc: "OLD CAFE", merchant: "Old Cafe" }),
			),
		);
		expect(result.historyStart).toBe(start);
		expect(result).toMatchObject({ added: 1, beforeHistory: 1 });
	});
});

describe("historyStart", () => {
	const ninety = () => daysBefore(TODAY, 90);

	it("is the earliest Plaid row once every connected bank has its history, when that row is later than 90 days back", async () => {
		// Only the seed's Plaid rows before Aug 1 go, so the bank's earliest row is later than 90 days back (2026-06-24).
		await db
			.prepare(
				"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id IS NOT NULL) AND date < '2026-08-01'",
			)
			.run();
		await db
			.prepare("UPDATE plaid_items SET history_complete_at = datetime('now')")
			.run();
		const earliest = await bankEarliest();
		expect(earliest !== null && earliest > ninety()).toBe(true);
		expect(await historyStart(db, TODAY)).toBe(earliest);
	});

	it("is the bank's earliest row while a connected bank's history isn't complete, when that row is older than 90 days", async () => {
		await db
			.prepare(
				"UPDATE plaid_items SET history_complete_at = datetime('now') WHERE id <> 1",
			)
			.run();
		await db
			.prepare("UPDATE plaid_items SET history_complete_at = NULL WHERE id = 1")
			.run();
		const earliest = await bankEarliest();
		expect(earliest !== null && earliest < ninety()).toBe(true);
		expect(await historyStart(db, TODAY)).toBe(earliest);
	});

	it("is 90 days back while a connected bank's history isn't complete and every bank row is later than that day", async () => {
		// Only the seed's Plaid rows before Aug 1 go, so the bank's earliest row is later than 90 days back (2026-06-24).
		await db
			.prepare(
				"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id IS NOT NULL) AND date < '2026-08-01'",
			)
			.run();
		await db
			.prepare(
				"UPDATE plaid_items SET history_complete_at = datetime('now') WHERE id <> 1",
			)
			.run();
		await db
			.prepare("UPDATE plaid_items SET history_complete_at = NULL WHERE id = 1")
			.run();
		const earliest = await bankEarliest();
		expect(earliest !== null && earliest > ninety()).toBe(true);
		expect(await historyStart(db, TODAY)).toBe("2026-06-24");
	});

	it("is 90 days back for a connected bank whose history is complete but has no rows yet", async () => {
		await db
			.prepare("UPDATE plaid_items SET history_complete_at = datetime('now')")
			.run();
		await db
			.prepare(
				"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id IS NOT NULL)",
			)
			.run();
		expect(await card()).toBeNull();
		expect(await historyStart(db, TODAY)).toBe("2026-06-24");
	});

	it("is the kept rows' earliest date once the last bank is disconnected with its rows kept", async () => {
		await db
			.prepare(
				"UPDATE plaid_items SET history_complete_at = datetime('now'), disconnected_at = datetime('now')",
			)
			.run();
		expect(await historyStart(db, TODAY)).toBe(await bankEarliest());
		const result = await upload(csvOf(row()));
		expect(result.ok).toBe(true);
	});

	it("is the card's own earliest row when no bank is connected or has rows", async () => {
		await db
			.prepare("UPDATE plaid_items SET disconnected_at = datetime('now')")
			.run();
		await db
			.prepare(
				"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id IS NOT NULL)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO accounts (name, type, subtype, is_liability) VALUES ('Apple Card', 'credit', 'apple_card', 1)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) SELECT id, '2026-08-15', 1200, 'OLD' FROM accounts WHERE subtype = 'apple_card'",
			)
			.run();
		expect(await historyStart(db, TODAY)).toBe("2026-08-15");
	});

	it("is 90 days back while the card exists and has no rows", async () => {
		await db
			.prepare("UPDATE plaid_items SET disconnected_at = datetime('now')")
			.run();
		await db
			.prepare(
				"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id IS NOT NULL)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO accounts (name, type, subtype, is_liability) VALUES ('Apple Card', 'credit', 'apple_card', 1)",
			)
			.run();
		expect(await historyStart(db, TODAY)).toBe(ninety());
	});

	it("with no bank, no bank history and no card, saves nothing and says to link a bank", async () => {
		await db
			.prepare("UPDATE plaid_items SET disconnected_at = datetime('now')")
			.run();
		await db
			.prepare(
				"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id IS NOT NULL)",
			)
			.run();
		const result = await upload(csvOf(row()));
		expect(result).toEqual({
			ok: false,
			error: "Link a bank first. Tally's history starts with your bank's.",
		});
		expect(await card()).toBeNull();
		expect(await countCardRows()).toBe(0);
	});
});
