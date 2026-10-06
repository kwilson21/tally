import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { transactions } from "../src/routes/transactions";
import {
	holdCashDelete,
	restoreCashDelete,
} from "../src/transactions/cash-undo";

const BASE = "http://tally.test";
const request = async (path: string, init?: RequestInit) => {
	const res = await exports.default.fetch(BASE + path, init);
	return { res, html: await res.text() };
};

beforeEach(() => resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE)));

async function cashEntry() {
	const row = await env.DB.prepare(
		"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type='cash' LIMIT 1",
	).first<{ id: number }>();
	if (!row) throw new Error("cash seed missing");
	return row.id;
}

function countingDb() {
	let statements = 0;
	const db = new Proxy(env.DB, {
		get(target, property) {
			const value = Reflect.get(target, property);
			if (property === "prepare")
				return (sql: string) => {
					statements++;
					return target.prepare(sql);
				};
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { db: db as D1Database, statements: () => statements };
}

type TestApp = { Bindings: Env; Variables: { actor: string } };
const deleteRoute = new Hono<TestApp>();
deleteRoute.use("*", async (c, next) => {
	c.set("actor", "demo");
	await next();
});
deleteRoute.route("/", transactions as unknown as Hono<TestApp>);
const deleteRequest = async (id: number, db: D1Database) =>
	deleteRoute.request(
		`/transactions/${id}/delete`,
		{
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "back=%2Ftransactions&confirm=1",
		},
		{ ...env, DB: db },
	);

describe("cash delete undo", () => {
	it("restores every transaction and split field exactly as deleted", async () => {
		const id = await cashEntry();
		await env.DB.prepare(
			"UPDATE transactions SET category_source='user', note='parent note', excluded=1, flag_transfer=1, flag_reimbursement=1, flag_income=1 WHERE id=?",
		)
			.bind(id)
			.run();
		await env.DB.prepare(
			"UPDATE transactions SET category_source='merchant_rule', note='part note', excluded=1, flag_transfer=1, flag_reimbursement=1, flag_income=1 WHERE parent_id=?",
		)
			.bind(id)
			.run();
		const before = {
			parent: await env.DB.prepare("SELECT * FROM transactions WHERE id=?")
				.bind(id)
				.first(),
			parts: (
				await env.DB.prepare(
					"SELECT * FROM transactions WHERE parent_id=? ORDER BY id",
				)
					.bind(id)
					.all()
			).results,
		};
		const token = await holdCashDelete(env.DB, id, "Market");
		expect(token).toBeTruthy();
		expect(await restoreCashDelete(env.DB, token as string)).not.toBeNull();
		expect(
			await env.DB.prepare("SELECT * FROM transactions WHERE id=?")
				.bind(id)
				.first(),
		).toEqual(before.parent);
		expect(
			(
				await env.DB.prepare(
					"SELECT * FROM transactions WHERE parent_id=? ORDER BY id",
				)
					.bind(id)
					.all()
			).results,
		).toEqual(before.parts);
	});

	it("restores a bill payment so the bill occurrence is paid again", async () => {
		const id = await cashEntry();
		const bill = await env.DB.prepare(
			"SELECT id, name FROM bills WHERE active=1 AND id NOT IN (SELECT bill_id FROM bill_payments WHERE period='2026-10' AND status='linked') LIMIT 1",
		).first<{ id: number; name: string }>();
		if (!bill) throw new Error("bill seed missing");
		await env.DB.prepare(
			"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026-10', ?, 'user', 'linked')",
		)
			.bind(bill.id, id)
			.run();
		const token = await holdCashDelete(env.DB, id, "Market");
		await restoreCashDelete(env.DB, token as string);
		const response = await request(`/bills/${bill.id}`);
		expect(response.html).toContain(bill.name);
		expect(response.html).toContain("Paid");
		expect(
			await env.DB.prepare(
				"SELECT status FROM bill_payments WHERE bill_id=? AND period='2026-10'",
			)
				.bind(bill.id)
				.first(),
		).toEqual({ status: "linked" });
	});

	it("rolls back restored rows when consuming the token fails", async () => {
		const id = await cashEntry();
		const token = await holdCashDelete(env.DB, id, "Market");
		if (!token) throw new Error("cash delete token missing");
		const failingDb = new Proxy(env.DB, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "prepare")
					return (sql: string) =>
						target.prepare(
							sql.includes("DELETE FROM cash_delete_holds")
								? "DELETE FROM missing_cash_delete_holds"
								: sql,
						);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as D1Database;

		await expect(restoreCashDelete(failingDb, token)).resolves.toBeNull();
		expect(
			await env.DB.prepare("SELECT id FROM transactions WHERE id=?")
				.bind(id)
				.first(),
		).toBeNull();
		expect(
			await env.DB.prepare("SELECT token FROM cash_delete_holds WHERE token=?")
				.bind(token)
				.first(),
		).toEqual({ token });
	});

	it("restores a token only once when two restores race", async () => {
		const id = await cashEntry();
		const token = await holdCashDelete(env.DB, id, "Market");
		if (!token) throw new Error("cash delete token missing");

		const results = await Promise.all([
			restoreCashDelete(env.DB, token),
			restoreCashDelete(env.DB, token),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(results.filter((result) => result === null)).toHaveLength(1);
		expect(
			await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions WHERE id=?")
				.bind(id)
				.first(),
		).toEqual({ n: 1 });
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM cash_delete_holds WHERE token=?",
			)
				.bind(token)
				.first(),
		).toEqual({ n: 0 });
	});

	it("names an omitted refund link when its purchase row is gone", async () => {
		const id = await cashEntry();
		const bank = await env.DB.prepare(
			"SELECT id FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE type!='cash') AND amount_cents>0 LIMIT 1",
		).first<{ id: number }>();
		if (!bank) throw new Error("bank transaction seed missing");
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents=-500, raw_name='Missing partner refund', refund_of_id=? WHERE id=?",
		)
			.bind(bank.id, id)
			.run();
		const deleted = await request(`/transactions/${id}/delete`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "back=%2Ftransactions&confirm=1",
		});
		const token = JSON.parse(deleted.res.headers.get("HX-Trigger") ?? "{}")
			.toast.undo as string;
		await env.DB.prepare("DELETE FROM transactions WHERE id=?")
			.bind(bank.id)
			.run();
		const restored = await request("/transactions/undo-cash-delete", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ token, back: "/transactions" }),
		});
		const message = JSON.parse(restored.res.headers.get("HX-Trigger") ?? "{}")
			.toast.message as string;
		expect(message).toContain("Missing partner refund");
		expect(
			(
				await env.DB.prepare("SELECT refund_of_id FROM transactions WHERE id=?")
					.bind(id)
					.first<{ refund_of_id: number | null }>()
			)?.refund_of_id,
		).toBeNull();
	});

	it("restores only split refund links that still fit", async () => {
		const id = await cashEntry();
		const account = await env.DB.prepare(
			"SELECT id FROM accounts WHERE type='cash'",
		).first<{ id: number }>();
		const bankAccount = await env.DB.prepare(
			"SELECT id FROM accounts WHERE type!='cash' LIMIT 1",
		).first<{ id: number }>();
		if (!account || !bankAccount) throw new Error("account seed missing");
		const purchases = await env.DB.batch(
			["Reduced purchase", "Still fits purchase", "Deleted purchase"].map(
				(raw_name) =>
					env.DB.prepare(
						"INSERT INTO transactions (account_id,date,amount_cents,raw_name,updated_by) VALUES (?, '2026-10-01', 1000, ?, 'test')",
					).bind(bankAccount.id, raw_name),
			),
		);
		const purchaseIds = purchases.map((purchase) =>
			Number(purchase.meta.last_row_id),
		);
		const purchaseId = (index: number) => {
			const value = purchaseIds[index];
			if (value === undefined) throw new Error("purchase insert missing");
			return value;
		};
		const partIds: number[] = [];
		for (let index = 0; index < purchaseIds.length; index++) {
			const part = await env.DB.prepare(
				"INSERT INTO transactions (account_id,date,amount_cents,raw_name,parent_id,refund_of_id,updated_by) VALUES (?, '2026-10-02', -200, ?, ?, ?, 'test')",
			)
				.bind(account.id, `Split refund ${index + 1}`, id, purchaseId(index))
				.run();
			partIds.push(Number(part.meta.last_row_id));
		}
		await env.DB.prepare("UPDATE transactions SET is_split=1 WHERE id=?")
			.bind(id)
			.run();
		const deleted = await deleteRequest(id, env.DB);
		const token = JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}").toast
			.undo as string;
		await env.DB.prepare("UPDATE transactions SET amount_cents=100 WHERE id=?")
			.bind(purchaseId(0))
			.run();
		await env.DB.prepare("DELETE FROM transactions WHERE id=?")
			.bind(purchaseId(2))
			.run();
		const restored = await request("/transactions/undo-cash-delete", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ token, back: "/transactions" }),
		});
		const message = JSON.parse(restored.res.headers.get("HX-Trigger") ?? "{}")
			.toast.message as string;
		const parts = await env.DB.prepare(
			"SELECT id, refund_of_id FROM transactions WHERE id IN (?, ?, ?) ORDER BY id",
		)
			.bind(...partIds)
			.all<{ id: number; refund_of_id: number | null }>();
		expect(parts.results).toEqual([
			{ id: partIds[0], refund_of_id: null },
			{ id: partIds[1], refund_of_id: purchaseId(1) },
			{ id: partIds[2], refund_of_id: null },
		]);
		expect(message).toContain("Split refund 1");
		expect(message).toContain("Split refund 3");
	});

	it("uses a fixed number of statements for 30 split parts, 30 refund links and 3 payments", async () => {
		const id = await cashEntry();
		const account = await env.DB.prepare(
			"SELECT id FROM accounts WHERE type='cash'",
		).first<{ id: number }>();
		const bankAccount = await env.DB.prepare(
			"SELECT id FROM accounts WHERE type!='cash' LIMIT 1",
		).first<{ id: number }>();
		if (!account || !bankAccount) throw new Error("account seed missing");
		await env.DB.prepare("UPDATE transactions SET is_split=1 WHERE id=?")
			.bind(id)
			.run();
		await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<30)
			INSERT INTO transactions (account_id,date,amount_cents,raw_name,parent_id,category_id,updated_by)
			SELECT ?, '2026-10-01', i*100, 'Part '||i, ?, 1, 'test' FROM n`)
			.bind(account.id, id)
			.run();
		await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<30)
			INSERT INTO transactions (account_id,date,amount_cents,raw_name,refund_of_id,updated_by)
			SELECT ?, '2026-10-01', -100, 'Refund '||i, ?, 'test' FROM n`)
			.bind(bankAccount.id, id)
			.run();
		const bill = await env.DB.prepare("SELECT id FROM bills LIMIT 1").first<{
			id: number;
		}>();
		if (!bill) throw new Error("bill seed missing");
		await env.DB.batch(
			[0, 1, 2].map((i) =>
				env.DB.prepare(
					"INSERT INTO bill_payments (bill_id,period,transaction_id,matched_by,status) VALUES (?,? ,?,'user','dismissed')",
				).bind(bill.id, `2026-${String(i + 1).padStart(2, "0")}`, id),
			),
		);
		const token = await holdCashDelete(env.DB, id, "Market");
		const counted = countingDb();
		await restoreCashDelete(counted.db, token as string);
		expect(counted.statements()).toBeLessThanOrEqual(12);
		expect(counted.statements()).toBe(8);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE parent_id=?",
				)
					.bind(id)
					.first<{ n: number }>()
			)?.n,
		).toBe(30);
		const small = await env.DB.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name) SELECT id,'2026-10-06',100,'Small undo' FROM accounts WHERE type='cash' LIMIT 1",
		).run();
		const smallToken = await holdCashDelete(
			env.DB,
			Number(small.meta.last_row_id),
			"Small undo",
		);
		const smallCount = countingDb();
		await restoreCashDelete(smallCount.db, smallToken as string);
		expect(smallCount.statements()).toBe(7);
		expect(counted.statements() - smallCount.statements()).toBeLessThanOrEqual(
			1,
		);
	});

	it("deletes a cash entry with 30 parts, links, and 3 payments in a fixed number of statements", async () => {
		const id = await cashEntry();
		const account = await env.DB.prepare(
			"SELECT id FROM accounts WHERE type='cash'",
		).first<{ id: number }>();
		const bankAccount = await env.DB.prepare(
			"SELECT id FROM accounts WHERE type!='cash' LIMIT 1",
		).first<{ id: number }>();
		if (!account || !bankAccount) throw new Error("account seed missing");
		await env.DB.prepare("UPDATE transactions SET is_split=1 WHERE id=?")
			.bind(id)
			.run();
		await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<30)
			INSERT INTO transactions (account_id,date,amount_cents,raw_name,parent_id,category_id,updated_by)
			SELECT ?, '2026-10-01', i*100, 'Part '||i, ?, 1, 'test' FROM n`)
			.bind(account.id, id)
			.run();
		await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<30)
			INSERT INTO transactions (account_id,date,amount_cents,raw_name,refund_of_id,updated_by)
			SELECT ?, '2026-10-01', -100, 'Refund '||i, ?, 'test' FROM n`)
			.bind(bankAccount.id, id)
			.run();
		const bill = await env.DB.prepare("SELECT id FROM bills LIMIT 1").first<{
			id: number;
		}>();
		if (!bill) throw new Error("bill seed missing");
		await env.DB.batch(
			[0, 1, 2].map((i) =>
				env.DB.prepare(
					"INSERT INTO bill_payments (bill_id,period,transaction_id,matched_by,status) VALUES (?,? ,?,'user','dismissed')",
				).bind(bill.id, `2026-${String(i + 1).padStart(2, "0")}`, id),
			),
		);

		const counted = countingDb();
		const deleted = await deleteRequest(id, counted.db);
		expect(deleted.status).toBe(200);
		expect(counted.statements()).toBeLessThanOrEqual(20);

		const small = await env.DB.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name) SELECT id,'2026-10-06',100,'Small delete' FROM accounts WHERE type='cash' LIMIT 1",
		).run();
		const smallCount = countingDb();
		await deleteRequest(Number(small.meta.last_row_id), smallCount.db);
		expect(
			Math.abs(smallCount.statements() - counted.statements()),
		).toBeLessThanOrEqual(3);
	});
});
