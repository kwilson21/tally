import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { afterSync } from "../src/plaid/after-sync";

describe("afterSync", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare(
				"INSERT INTO accounts(id,name,type,balance_cents) VALUES(1,'Checking','depository',0)",
			),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(1,'Rent',10000,10,'monthly','LANDLORD')",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(1,1,'2026-03-10',10000,'LANDLORD')",
			),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES ('LANDLORD', (SELECT id FROM categories ORDER BY id LIMIT 1))",
			),
		]);
	});

	afterEach(async () => {
		await env.DB.prepare("DROP TRIGGER IF EXISTS fail_rules").run();
	});

	it("still matches bills when the merchant rules fail, then reports the failure", async () => {
		// Makes the merchant rule's update fail, standing in for any rule error.
		await env.DB.prepare(
			"CREATE TRIGGER fail_rules BEFORE UPDATE OF category_id ON transactions BEGIN SELECT RAISE(ABORT, 'nope'); END",
		).run();

		await expect(afterSync(env.DB)).rejects.toThrow();

		const linked = await env.DB.prepare(
			"SELECT transaction_id FROM bill_payments WHERE status = 'linked'",
		).all<{ transaction_id: number }>();
		expect(linked.results).toEqual([{ transaction_id: 1 }]);
	});

	it("runs the rules, then matches bills", async () => {
		await afterSync(env.DB);
		const row = await env.DB.prepare(
			"SELECT category_source FROM transactions WHERE id = 1",
		).first<{ category_source: string }>();
		expect(row?.category_source).toBe("merchant_rule");
		const linked = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM bill_payments WHERE status = 'linked'",
		).first<{ n: number }>();
		expect(linked?.n).toBe(1);
	});
});
