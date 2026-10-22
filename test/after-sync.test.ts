import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { afterSync, afterSyncSteps } from "../src/plaid/after-sync";

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
		await env.DB.batch([
			env.DB.prepare("DROP TRIGGER IF EXISTS fail_rules"),
			env.DB.prepare("DROP TRIGGER IF EXISTS fail_bills"),
		]);
	});

	// Makes the merchant rule's update fail, standing in for any rule error.
	const failRules = () =>
		env.DB.prepare(
			"CREATE TRIGGER fail_rules BEFORE UPDATE OF category_id ON transactions BEGIN SELECT RAISE(ABORT, 'rules nope'); END",
		).run();
	// Makes the bill matcher's insert fail, standing in for any bill error.
	const failBills = () =>
		env.DB.prepare(
			"CREATE TRIGGER fail_bills BEFORE INSERT ON bill_payments BEGIN SELECT RAISE(ABORT, 'bills nope'); END",
		).run();
	const linkedPayments = async () =>
		(
			await env.DB.prepare(
				"SELECT transaction_id FROM bill_payments WHERE status = 'linked'",
			).all<{ transaction_id: number }>()
		).results;
	const ruleSource = async () =>
		(
			await env.DB.prepare(
				"SELECT category_source FROM transactions WHERE id = 1",
			).first<{ category_source: string }>()
		)?.category_source;

	it("still matches bills when the merchant rules fail, then reports the failure", async () => {
		await failRules();

		await expect(afterSync(env.DB)).rejects.toThrow();

		expect(await linkedPayments()).toEqual([{ transaction_id: 1 }]);
	});

	it("runs the rules, then matches bills", async () => {
		await afterSync(env.DB);
		expect(await ruleSource()).toBe("merchant_rule");
		const linked = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM bill_payments WHERE status = 'linked'",
		).first<{ n: number }>();
		expect(linked?.n).toBe(1);
	});

	it("reports no failure when the rules and the bills both work", async () => {
		const steps = await afterSyncSteps(env.DB);
		expect(steps).toMatchObject({ rulesFailed: false, billsFailed: false });
		expect(steps.error).toBeUndefined();
	});

	it("runs the bills when the merchant rules fail, and reports only the rules' failure", async () => {
		await failRules();

		const steps = await afterSyncSteps(env.DB);

		expect(steps).toMatchObject({ rulesFailed: true, billsFailed: false });
		expect(steps.error).toBeDefined();
		expect(await linkedPayments()).toEqual([{ transaction_id: 1 }]);
	});

	it("runs the rules when bill matching fails, and reports only the bills' failure", async () => {
		await failBills();

		const steps = await afterSyncSteps(env.DB);

		expect(steps).toMatchObject({ rulesFailed: false, billsFailed: true });
		expect(steps.error).toBeDefined();
		expect(await ruleSource()).toBe("merchant_rule");
		expect(await linkedPayments()).toEqual([]);
	});

	it("throws when only bill matching fails", async () => {
		await failBills();

		await expect(afterSync(env.DB)).rejects.toThrow("bills nope");
	});

	it("throws the first failure, the rules', when both steps fail", async () => {
		await failRules();
		await failBills();

		await expect(afterSync(env.DB)).rejects.toThrow("rules nope");
	});
});
