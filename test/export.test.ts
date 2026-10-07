import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});

describe("data exports", () => {
	it("includes category suggestion decisions and transaction links in the JSON export", async () => {
		await env.DB.prepare(
			"INSERT INTO category_suggestions (name,status) VALUES ('Pet Care','dismissed')",
		).run();
		const suggestion = await env.DB.prepare(
			"SELECT id FROM category_suggestions WHERE name='Pet Care'",
		).first<{ id: number }>();
		await env.DB.prepare(
			"UPDATE transactions SET jev_none_fit=1,category_suggestion_id=? WHERE id=1",
		)
			.bind(suggestion?.id)
			.run();
		const data = (await (
			await exports.default.fetch(`${BASE}/settings/export/tally.json`)
		).json()) as {
			category_suggestions: Record<string, unknown>[];
			transactions: Record<string, unknown>[];
		};
		expect(data.category_suggestions).toContainEqual(
			expect.objectContaining({ name: "Pet Care", status: "dismissed" }),
		);
		expect(data.transactions[0]).toMatchObject({
			jev_none_fit: 1,
			category_suggestion_id: suggestion?.id,
		});
	});

	it("includes income and credit review decisions in the JSON transaction export", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET income_source = 'jev', credit_reviewed = 0, credit_reviewed_by = NULL, income_confidence = 0.71, transfer_confidence = 0.62 WHERE id = 1",
		).run();
		const response = await exports.default.fetch(
			`${BASE}/settings/export/tally.json`,
		);
		const data = (await response.json()) as {
			transactions: Record<string, unknown>[];
		};
		expect(data.transactions[0]).toMatchObject({
			income_source: "jev",
			income_confidence: 0.71,
			transfer_confidence: 0.62,
			credit_reviewed: 0,
			credit_reviewed_by: null,
		});
	});
	it("reports transaction columns omitted from the JSON export", async () => {
		const columns = await env.DB.prepare(
			"PRAGMA table_info(transactions)",
		).all<{ name: string }>();
		const data = (await (
			await exports.default.fetch(`${BASE}/settings/export/tally.json`)
		).json()) as { transactions: Record<string, unknown>[] };
		const exported = new Set(Object.keys(data.transactions[0] ?? {}));
		expect(
			columns.results
				.map(({ name }) => name)
				.filter((name) => !exported.has(name)),
		).toEqual(["entry_key"]);
	});

	it("includes Plaid's merchant name and the pending flag in the JSON transaction export", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET merchant_name = 'Target', pending = 1 WHERE id = 1",
		).run();
		const data = (await (
			await exports.default.fetch(`${BASE}/settings/export/tally.json`)
		).json()) as { transactions: Record<string, unknown>[] };

		expect(data.transactions[0]).toMatchObject({
			merchant_name: "Target",
			pending: 1,
		});
	});

	it("shows a merchant's chosen name beside every raw name that shares its merchant name in the CSV", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE transactions SET raw_name = 'ZETA MART 1234', merchant_name = 'Zeta Mart' WHERE id = 1",
			),
			env.DB.prepare(
				"UPDATE transactions SET raw_name = 'ZETA MART 5678', merchant_name = 'Zeta Mart' WHERE id = 2",
			),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('Zeta Mart', 'Zeta Stores')",
			),
		]);

		const csv = await (
			await exports.default.fetch(`${BASE}/settings/export/transactions.csv`)
		).text();

		expect(csv).toMatch(/ZETA MART 1234,Zeta Stores,/);
		expect(csv).toMatch(/ZETA MART 5678,Zeta Stores,/);
	});

	it("neutralizes formulas in CSV text fields without changing numeric amounts", async () => {
		await env.DB.prepare("UPDATE accounts SET name = ? WHERE id = 1")
			.bind("@checking")
			.run();
		await env.DB.prepare("UPDATE categories SET name = ? WHERE id = 1")
			.bind("\rcategory")
			.run();
		await env.DB.prepare(
			"UPDATE transactions SET raw_name = ?, amount_cents = -1234, category_id = 1, note = ? WHERE id = 1",
		)
			.bind("=bank", "\tnote")
			.run();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name) VALUES (?, ?)",
		)
			.bind("=bank", "+merchant")
			.run();
		await env.DB.prepare("UPDATE transactions SET raw_name = ? WHERE id = 2")
			.bind("-bank")
			.run();

		const csv = await (
			await exports.default.fetch(`${BASE}/settings/export/transactions.csv`)
		).text();

		expect(csv).toContain("'=bank");
		expect(csv).toContain("'+merchant");
		expect(csv).toContain("'-bank");
		expect(csv).toContain("'\rcategory");
		expect(csv).toContain("'\tnote");
		expect(csv).toContain("'@checking");
		expect(csv).toContain(",-12.34,");
		expect(csv).not.toContain(",'-12.34,");
	});

	it("exports split children but not their parent transaction", async () => {
		await env.DB.prepare(
			`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, is_split, parent_id)
			 VALUES (9001, 1, '2026-09-20', 3000, 'SPLIT PARENT', 1, NULL),
			        (9002, 1, '2026-09-20', 3000, 'SPLIT CHILD', 0, 9001)`,
		).run();

		const csv = await (
			await exports.default.fetch(`${BASE}/settings/export/transactions.csv`)
		).text();

		expect(csv).not.toContain("SPLIT PARENT");
		expect(csv).toContain("SPLIT CHILD");
	});

	it("downloads RFC 4180 CSV with dollar amounts in Plaid's sign convention", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET raw_name = ?, amount_cents = 12345, note = ? WHERE id = 1",
		)
			.bind('BANK, "NAME"', "first line\nsecond line")
			.run();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name) VALUES (?, ?)",
		)
			.bind('BANK, "NAME"', 'Shown, "merchant"')
			.run();

		const res = await exports.default.fetch(
			`${BASE}/settings/export/transactions.csv`,
		);
		const csv = await res.text();

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/csv");
		expect(res.headers.get("content-disposition")).toBe(
			`attachment; filename="tally-transactions-${todayIn(DEFAULT_TIME_ZONE)}.csv"`,
		);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(csv).toContain("amount (USD; positive = money out)");
		expect(csv).toContain('"BANK, ""NAME"""');
		expect(csv).toContain('"Shown, ""merchant"""');
		expect(csv).toContain('"first line\nsecond line"');
		expect(csv).toContain("123.45");
		expect(csv).toMatch(/\r\n/);
	});

	it("includes every specified table while exposing only safe bank and document fields", async () => {
		await env.DB.prepare(
			"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES ('2026-10', 50000)",
		).run();
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
		]);
		const secret = "never-export-this-token";
		await env.DB.prepare(
			"UPDATE plaid_items SET access_token_encrypted = ? WHERE id = 1",
		)
			.bind(secret)
			.run();
		await env.DB.prepare(
			"INSERT INTO documents (r2_key, filename, size_bytes, uploaded_by, uploaded_at, note) VALUES ('secret-key', 'statement.pdf', 42, 'person@example.com', '2026-09-12 10:30:00', 'private')",
		).run();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO balance_history (account_id, date, balance_cents) VALUES (1, '2020-01-01', 12345)",
			),
			env.DB.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (1, 'Internet', 5000, 1, 'monthly', 'ISP')",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments (id, bill_id, period, transaction_id, matched_by, status) VALUES (1, 1, '2026-09', 1, 'user', 'linked')",
			),
		]);
		await env.DB.prepare(
			"INSERT INTO category_suggestions(name,status) VALUES('Archived idea','dismissed')",
		).run();

		const res = await exports.default.fetch(
			`${BASE}/settings/export/tally.json`,
		);
		const body = await res.text();
		const data = JSON.parse(body) as Record<string, unknown>;

		expect(res.headers.get("content-type")).toContain("application/json");
		expect(res.headers.get("content-disposition")).toBe(
			`attachment; filename="tally-${todayIn(DEFAULT_TIME_ZONE)}.json"`,
		);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(data).toHaveProperty("schema_version", 1);
		expect(data).toHaveProperty("exported_at");
		for (const table of [
			"categories",
			"category_suggestions",
			"budget_amounts",
			"savings_goal_amounts",
			"merchants",
			"accounts",
			"balance_history",
			"transactions",
			"bills",
			"bill_payments",
			"plaid_items",
			"documents",
			"household_settings",
			"household_people",
		]) {
			expect(data[table], table).toBeInstanceOf(Array);
		}
		const exportedColumns = {
			categories: ["archived", "color", "icon", "id", "name", "sort_order"],
			category_suggestions: [
				"created_at",
				"decided_at",
				"id",
				"name",
				"status",
			],
			budget_amounts: ["amount_cents", "category_id", "effective_month"],
			savings_goal_amounts: ["amount_cents", "effective_month"],
			merchants: [
				"default_category_id",
				"display_name",
				"raw_name",
				"suggested_name",
				"suggestion_status",
				"not_a_bill",
			],
			accounts: [
				"balance_cents",
				"bank",
				"bank_disconnected",
				"id",
				"is_liability",
				"mask",
				"name",
				"plaid_account_id",
				"plaid_item_id",
				"subtype",
				"type",
				"updated_at",
			],
			balance_history: ["account_id", "balance_cents", "date"],
			transactions: [
				"account_id",
				"amount_cents",
				"category_confidence",
				"category_id",
				"category_source",
				"category_suggestion_id",
				"details_asked",
				"credit_reviewed",
				"credit_reviewed_by",
				"date",
				"excluded",
				"excluded_source",
				"flag_income",
				"flag_reimbursement",
				"flag_transfer",
				"id",
				"income_confidence",
				"income_source",
				"is_split",
				"jev_category_id",
				"jev_failed_at",
				"jev_none_fit",
				"merchant_name",
				"note",
				"note_guessed",
				"note_tried_at",
				"note_dismissed",
				"kind",
				"kind_guessed",
				"for_person_id",
				"for_person_guessed",
				"parent_id",
				"pending",
				"plaid_category",
				"plaid_transaction_id",
				"raw_name",
				"refund_of_id",
				"split_removed_from_cents",
				"transfer_confidence",
				"updated_at",
				"updated_by",
			],
			bills: [
				"active",
				"amount_cents",
				"anchor_month",
				"category_id",
				"due_day",
				"frequency",
				"id",
				"merchant_raw_name",
				"merchant_raw_text",
				"name",
			],
			bill_payments: [
				"bill_id",
				"created_at",
				"id",
				"matched_by",
				"period",
				"status",
				"transaction_id",
			],
			plaid_items: ["institution_name", "status"],
			documents: ["filename", "uploaded_at"],
			household_settings: ["key", "value"],
			household_people: ["id", "name"],
		} as const;
		for (const [table, columns] of Object.entries(exportedColumns)) {
			expect(
				Object.keys((data[table] as object[])[0] ?? {}).sort(),
				table,
			).toEqual([...columns].sort());
		}
		expect((data.documents as object[])[0]).toEqual({
			filename: "statement.pdf",
			uploaded_at: "2026-09-12 10:30:00",
		});
		expect(data.household_settings).toEqual([
			{ key: "time_zone", value: "America/New_York" },
		]);
		expect(body).not.toContain(secret);
		expect(body).not.toContain("access_token_encrypted");
		expect(body).not.toContain("sync_cursor");
		expect(body).not.toContain("secret-key");
	});

	it("links both downloads from the Your data section", async () => {
		const html = await (await exports.default.fetch(`${BASE}/settings`)).text();
		expect(html).toContain("Your data");
		expect(html).toContain(
			"Everything Tally has stored, to keep or open elsewhere. Bank logins are never included.",
		);
		expect(html).toMatch(
			/<a href="\/settings\/export\/transactions\.csv"[^>]*>Download transactions \(CSV\)<\/a>/,
		);
		expect(html).toMatch(
			/<a href="\/settings\/export\/tally\.json"[^>]*>Download everything \(JSON\)<\/a>/,
		);
	});

	it("exports transaction details and named people in JSON and CSV, including removed people as no one", async () => {
		const person = await env.DB.prepare(
			"INSERT INTO household_people (name) VALUES ('Kids') RETURNING id",
		).first<{ id: number }>();
		await env.DB.prepare(
			"UPDATE transactions SET note = 'Soccer shoes', note_guessed = 1, kind = 'one_off', kind_guessed = 1, for_person_id = ?, for_person_guessed = 1, details_asked = 1, note_tried_at = '2026-10-06 09:00:00' WHERE id = 1",
		)
			.bind(person?.id)
			.run();
		const json = (await (
			await exports.default.fetch(`${BASE}/settings/export/tally.json`)
		).json()) as {
			transactions: Record<string, unknown>[];
			household_people: { id: number; name: string }[];
		};
		expect(json.household_people).toContainEqual({
			id: person?.id,
			name: "Kids",
		});
		expect(json.transactions.find((row) => row.id === 1)).toMatchObject({
			note: "Soccer shoes",
			note_guessed: 1,
			details_asked: 1,
			note_tried_at: "2026-10-06 09:00:00",
			note_dismissed: 0,
			kind: "one_off",
			kind_guessed: 1,
			for_person_id: person?.id,
			for_person_guessed: 1,
		});
		const csv = await (
			await exports.default.fetch(`${BASE}/settings/export/transactions.csv`)
		).text();
		expect(csv).toContain("kind,for,note");
		expect(csv).toContain("One-off,Kids,Soccer shoes");

		await env.DB.prepare("DELETE FROM household_people WHERE id = ?")
			.bind(person?.id)
			.run();
		const removedCsv = await (
			await exports.default.fetch(`${BASE}/settings/export/transactions.csv`)
		).text();
		expect(removedCsv).toContain("One-off,no one,Soccer shoes");
	});

	it("exports a disconnected bank's status as disconnected", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id = 1",
		).run();
		const response = await exports.default.fetch(
			`${BASE}/settings/export/tally.json`,
		);
		const data = (await response.json()) as {
			plaid_items: { status: string }[];
		};
		expect(data.plaid_items[0]?.status).toBe("disconnected");
	});

	it("marks the accounts of a disconnected bank, so kept balances can be told apart", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id = 1",
		).run();
		const response = await exports.default.fetch(
			`${BASE}/settings/export/tally.json`,
		);
		const data = (await response.json()) as {
			accounts: {
				plaid_item_id: number;
				bank: string;
				bank_disconnected: number;
			}[];
		};
		const first = data.accounts.find((a) => a.plaid_item_id === 1);
		const other = data.accounts.find((a) => a.plaid_item_id !== 1);
		expect(first?.bank_disconnected).toBe(1);
		expect(typeof first?.bank).toBe("string");
		if (other) expect(other.bank_disconnected).toBe(0);
	});
});
