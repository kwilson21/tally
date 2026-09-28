import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";

beforeEach(async () => {
	await resetDemo(env.DB, todayUtc());
});

describe("data exports", () => {
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
			`attachment; filename="tally-transactions-${todayUtc()}.csv"`,
		);
		expect(csv).toContain("amount (USD; positive = money out)");
		expect(csv).toContain('"BANK, ""NAME"""');
		expect(csv).toContain('"Shown, ""merchant"""');
		expect(csv).toContain('"first line\nsecond line"');
		expect(csv).toContain("123.45");
		expect(csv).toMatch(/\r\n/);
	});

	it("includes every specified table while exposing only safe bank and document fields", async () => {
		const secret = "never-export-this-token";
		await env.DB.prepare(
			"UPDATE plaid_items SET access_token_encrypted = ? WHERE id = 1",
		)
			.bind(secret)
			.run();
		await env.DB.prepare(
			"INSERT INTO documents (r2_key, filename, size_bytes, uploaded_by, uploaded_at, note) VALUES ('secret-key', 'statement.pdf', 42, 'person@example.com', '2026-09-12 10:30:00', 'private')",
		).run();

		const res = await exports.default.fetch(
			`${BASE}/settings/export/tally.json`,
		);
		const body = await res.text();
		const data = JSON.parse(body) as Record<string, unknown>;

		expect(res.headers.get("content-type")).toContain("application/json");
		expect(res.headers.get("content-disposition")).toBe(
			`attachment; filename="tally-${todayUtc()}.json"`,
		);
		expect(data).toHaveProperty("schema_version", 1);
		expect(data).toHaveProperty("exported_at");
		for (const table of [
			"categories",
			"budget_amounts",
			"merchants",
			"accounts",
			"balance_history",
			"transactions",
			"bills",
			"bill_payments",
			"plaid_items",
			"documents",
		]) {
			expect(data[table], table).toBeInstanceOf(Array);
		}
		expect(Object.keys((data.plaid_items as object[])[0] ?? {}).sort()).toEqual(
			["id", "institution_name", "status"],
		);
		expect((data.documents as object[])[0]).toEqual({
			filename: "statement.pdf",
			uploaded_at: "2026-09-12 10:30:00",
		});
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
});
