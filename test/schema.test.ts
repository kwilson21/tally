import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const db = env.DB;

async function tables() {
	const { results } = await db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
		)
		.all<{ name: string }>();
	return results.map((r) => r.name);
}

beforeEach(async () => {
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM bills"),
		db.prepare("DELETE FROM budget_amounts"),
		db.prepare("DELETE FROM merchants"),
		db.prepare("DELETE FROM categories"),
		db.prepare("DELETE FROM accounts"),
	]);
	await db.batch([
		db.prepare(
			"INSERT INTO categories (id, name, icon, color) VALUES (1, 'Groceries', 'groceries', 'cat-blue')",
		),
		db.prepare(
			"INSERT INTO accounts (id, name, type) VALUES (1, 'Checking', 'depository')",
		),
		db.prepare(
			"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (1, 'Internet', 8000, 5, 'monthly', 'COMCAST')",
		),
		db.prepare(
			"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (1, 1, '2026-09-05', 8000, 'COMCAST')",
		),
		db.prepare(
			"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (2, 1, '2026-10-05', 8000, 'COMCAST')",
		),
	]);
});

describe("schema", () => {
	it("creates every table from spec §5", async () => {
		expect(await tables()).toEqual([
			"accounts",
			"balance_history",
			"bill_payments",
			"bills",
			"budget_amounts",
			"cash_delete_holds",
			"categories",
			"category_suggestions",
			"documents",
			"feedback",
			"household_people",
			"household_settings",
			"merchants",
			"plaid_items",
			"savings_goal_amounts",
			"transactions",
		]);
	});

	it("records the optional category archive date", async () => {
		const { results } = await db
			.prepare("PRAGMA table_info(categories)")
			.all<{ name: string; notnull: number }>();
		expect(
			results.find((column) => column.name === "archived_on"),
		).toMatchObject({
			notnull: 0,
		});
	});

	it("rejects duplicate Plaid item ids", async () => {
		const token = new Uint8Array([1, 2, 3]);
		await db
			.prepare(
				"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'First Bank', 'family@example.com', 'item-duplicate')",
			)
			.bind(token)
			.run();
		await expect(
			db
				.prepare(
					"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Second Bank', 'family@example.com', 'item-duplicate')",
				)
				.bind(token)
				.run(),
		).rejects.toThrow();
	});

	it("stores money as integers and rejects fractional cents", async () => {
		await expect(
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, '2026-09-01', 12.5, 'X')",
				)
				.run(),
		).rejects.toThrow();
	});

	it("rejects a malformed transaction date", async () => {
		await expect(
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, '9/1/2026', 100, 'X')",
				)
				.run(),
		).rejects.toThrow();
	});

	it("enforces foreign keys", async () => {
		await expect(
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (999, '2026-09-01', 100, 'X')",
				)
				.run(),
		).rejects.toThrow();
	});

	it("allows only one linked payment per bill period", async () => {
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (1, '2026-09', 1, 'auto', 'linked')",
			)
			.run();
		await expect(
			db
				.prepare(
					"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (1, '2026-09', 2, 'auto', 'linked')",
				)
				.run(),
		).rejects.toThrow();
	});

	it("enforces one pending suggestion per name, ignoring case", async () => {
		await db
			.prepare(
				"INSERT INTO category_suggestions (name,status) VALUES ('Pet Care','pending')",
			)
			.run();
		await expect(
			db
				.prepare(
					"INSERT INTO category_suggestions (name,status) VALUES ('pet care','pending')",
				)
				.run(),
		).rejects.toThrow();
		await db
			.prepare(
				"INSERT INTO category_suggestions (name,status) VALUES ('pet care','dismissed')",
			)
			.run();
	});

	it("lets a transaction pay only one bill occurrence, but allows dismissed rows", async () => {
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (1, '2026-09', 1, 'auto', 'linked')",
			)
			.run();
		await expect(
			db
				.prepare(
					"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (1, '2026-10', 1, 'auto', 'linked')",
				)
				.run(),
		).rejects.toThrow();
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (1, '2026-10', 1, 'user', 'dismissed')",
			)
			.run();
	});
});
