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
	it("restores the deleted maximum id after another transaction takes it", async () => {
		const account = await env.DB.prepare(
			"SELECT id FROM accounts WHERE type='cash' LIMIT 1",
		).first<{ id: number }>();
		if (!account) throw new Error("cash account missing");
		const inserted = await env.DB.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name,updated_by) VALUES (?, '2026-10-06', 1250, 'Latest cash', 'test')",
		)
			.bind(account.id)
			.run();
		const originalId = Number(inserted.meta.last_row_id);
		const token = await holdCashDelete(env.DB, originalId, "Latest cash");
		if (!token) throw new Error("cash delete token missing");
		const replacement = await env.DB.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name,updated_by) VALUES (?, '2026-10-06', 500, 'New cash', 'test')",
		)
			.bind(account.id)
			.run();
		expect(Number(replacement.meta.last_row_id)).toBe(originalId);

		expect(await restoreCashDelete(env.DB, token)).toMatchObject({
			name: "Latest cash",
			alreadyRestored: false,
		});
		expect(
			await env.DB.prepare("SELECT raw_name FROM transactions WHERE id=?")
				.bind(originalId)
				.first(),
		).toEqual({ raw_name: "New cash" });
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE raw_name='Latest cash'",
			).first(),
		).toEqual({ n: 1 });
	});

	it("remaps two reused ids and keeps split, refund, and bill links intact", async () => {
		const account = await env.DB.prepare(
			"SELECT id FROM accounts WHERE type='cash' LIMIT 1",
		).first<{ id: number }>();
		const bank = await env.DB.prepare(
			"SELECT id FROM accounts WHERE type!='cash' LIMIT 1",
		).first<{ id: number }>();
		const bill = await env.DB.prepare(
			"SELECT id FROM bills WHERE active=1 AND id NOT IN (SELECT bill_id FROM bill_payments WHERE period='2026-10' AND status='linked') LIMIT 1",
		).first<{ id: number }>();
		if (!account || !bank || !bill) throw new Error("undo fixture missing");
		const purchaseInsert = await env.DB.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name,updated_by) VALUES (?, '2026-10-01', 1000, 'Collision purchase', 'test')",
		)
			.bind(bank.id)
			.run();
		const purchaseId = Number(purchaseInsert.meta.last_row_id);
		const parentInsert = await env.DB.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name,updated_by) VALUES (?, '2026-10-06', 1000, 'Collision parent', 'test')",
		)
			.bind(account.id)
			.run();
		const oldParentId = Number(parentInsert.meta.last_row_id);
		await env.DB.prepare("UPDATE transactions SET is_split=1 WHERE id=?")
			.bind(oldParentId)
			.run();
		const partInsert = await env.DB.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name,parent_id,refund_of_id,updated_by) VALUES (?, '2026-10-06', -200, 'Collision refund', ?, ?, 'test')",
		)
			.bind(account.id, oldParentId, purchaseId)
			.run();
		const oldPartId = Number(partInsert.meta.last_row_id);
		await env.DB.prepare(
			"INSERT INTO bill_payments (bill_id,period,transaction_id,matched_by,status) VALUES (?, '2026-10', ?, 'user', 'linked')",
		)
			.bind(bill.id, oldParentId)
			.run();
		const deleted = await deleteRequest(oldParentId, env.DB);
		const token = JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}").toast
			.undo as string;
		const replacements = await env.DB.batch(
			["Reuse parent id", "Reuse part id"].map((raw_name) =>
				env.DB.prepare(
					"INSERT INTO transactions (account_id,date,amount_cents,raw_name,updated_by) VALUES (?, '2026-10-06', 100, ?, 'test')",
				).bind(account.id, raw_name),
			),
		);
		expect(replacements.map((row) => Number(row.meta.last_row_id))).toEqual([
			oldParentId,
			oldPartId,
		]);

		const response = await request("/transactions/undo-cash-delete", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ token, back: "/transactions" }),
		});
		const parent = await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name='Collision parent'",
		).first<{ id: number }>();
		const part = await env.DB.prepare(
			"SELECT id, parent_id, refund_of_id FROM transactions WHERE raw_name='Collision refund'",
		).first<{ id: number; parent_id: number; refund_of_id: number }>();
		expect(parent?.id).not.toBe(oldParentId);
		expect(part).toEqual({
			id: expect.any(Number),
			parent_id: parent?.id,
			refund_of_id: purchaseId,
		});
		expect(part?.id).not.toBe(oldPartId);
		expect(
			await env.DB.prepare(
				"SELECT transaction_id, status FROM bill_payments WHERE bill_id=? AND period='2026-10'",
			)
				.bind(bill.id)
				.first(),
		).toEqual({ transaction_id: parent?.id, status: "linked" });
		expect(
			JSON.parse(response.res.headers.get("HX-Trigger") ?? "{}").toast.message,
		).toBe("Restored Collision parent.");
		expect(response.res.headers.get("HX-Trigger")).not.toContain(
			String(oldParentId),
		);
	});

	it("sends the remaining server deadline computed from the stored hold time", async () => {
		const id = await cashEntry();
		const delayedDb = new Proxy(env.DB, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "batch")
					return async (statements: D1PreparedStatement[]) => {
						const result = await target.batch(statements);
						const hold = await env.DB.prepare(
							"SELECT token FROM cash_delete_holds ORDER BY rowid DESC LIMIT 1",
						).first<{ token: string }>();
						if (hold)
							await env.DB.prepare(
								"UPDATE cash_delete_holds SET created_at=? WHERE token=?",
							)
								.bind(Date.now() - 3000, hold.token)
								.run();
						return result;
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as D1Database;
		const deleted = await deleteRequest(id, delayedDb);
		const feedback = JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}");
		expect(feedback.toast.undoExpiresInMs).toBeLessThanOrEqual(7000);
		expect(feedback.toast.undoExpiresInMs).toBeGreaterThan(6800);
	});

	it("says the restored entry is already back when its Undo token is reused", async () => {
		const id = await cashEntry();
		const deleted = await deleteRequest(id, env.DB);
		const token = JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}").toast
			.undo as string;
		const body = new URLSearchParams({ token, back: "/transactions" });
		let response = await request("/transactions/undo-cash-delete", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body,
		});
		response = await request("/transactions/undo-cash-delete", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body,
		});
		const feedback = JSON.parse(response.res.headers.get("HX-Trigger") ?? "{}");
		expect(feedback.toast.message).toBe("That cash entry is already back.");
	});

	it("clears undo holds on demo reset and leaves the deleted entry expired", async () => {
		const id = await cashEntry();
		const deleted = await deleteRequest(id, env.DB);
		const token = JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}").toast
			.undo as string;
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		const restored = await request("/transactions/undo-cash-delete", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ token, back: "/transactions" }),
		});
		const feedback = JSON.parse(restored.res.headers.get("HX-Trigger") ?? "{}");
		expect(feedback.toast.message).toBe(
			"Undo expired. The cash entry stays deleted.",
		);
		expect(
			await env.DB.prepare("SELECT token FROM cash_delete_holds WHERE token=?")
				.bind(token)
				.first(),
		).toBeNull();
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE id=?",
				)
					.bind(id)
					.first<{ n: number }>()
			)?.n,
		).toBe(1);
	});

	it("snapshots parts added immediately before the atomic delete batch", async () => {
		const id = await cashEntry();
		const cashAccount = await env.DB.prepare(
			"SELECT id FROM accounts WHERE type='cash'",
		).first<{ id: number }>();
		if (!cashAccount) throw new Error("cash account missing");
		let added = false;
		const interleavedDb = new Proxy(env.DB, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "batch")
					return async (statements: D1PreparedStatement[]) => {
						if (!added) {
							added = true;
							await env.DB.prepare(
								"INSERT INTO transactions (account_id,date,amount_cents,raw_name,parent_id,updated_by) VALUES (?, '2026-10-06', 100, 'Late split', ?, 'test')",
							)
								.bind(cashAccount.id, id)
								.run();
						}
						return target.batch(statements);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as D1Database;
		const token = await holdCashDelete(interleavedDb, id, "Market");
		if (!token) throw new Error("cash delete token missing");

		await restoreCashDelete(env.DB, token);
		expect(
			await env.DB.prepare(
				"SELECT raw_name FROM transactions WHERE raw_name='Late split'",
			).first(),
		).toEqual({ raw_name: "Late split" });
	});

	it("restores only the first of two individually fitting refunds when their sum exceeds the purchase", async () => {
		const id = await cashEntry();
		const account = await env.DB.prepare(
			"SELECT id FROM accounts WHERE type='cash'",
		).first<{ id: number }>();
		const bankAccount = await env.DB.prepare(
			"SELECT id FROM accounts WHERE type!='cash' LIMIT 1",
		).first<{ id: number }>();
		if (!account || !bankAccount) throw new Error("account seed missing");
		const purchase = await env.DB.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name,updated_by) VALUES (?, '2026-10-01', 1000, 'Purchase', 'test')",
		)
			.bind(bankAccount.id)
			.run();
		const purchaseId = Number(purchase.meta.last_row_id);
		await env.DB.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name,refund_of_id,updated_by) VALUES (?, '2026-10-01', -500, 'Existing refund', ?, 'test')",
		)
			.bind(bankAccount.id, purchaseId)
			.run();
		await env.DB.prepare("UPDATE transactions SET is_split=1 WHERE id=?")
			.bind(id)
			.run();
		await env.DB.batch(
			["First deleted refund", "Second deleted refund"].map((raw_name) =>
				env.DB.prepare(
					"INSERT INTO transactions (account_id,date,amount_cents,raw_name,parent_id,refund_of_id,updated_by) VALUES (?, '2026-10-02', -400, ?, ?, ?, 'test')",
				).bind(account.id, raw_name, id, purchaseId),
			),
		);
		const deleted = await deleteRequest(id, env.DB);
		const token = JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}").toast
			.undo as string;
		const restored = await request("/transactions/undo-cash-delete", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ token, back: "/transactions" }),
		});
		expect(
			JSON.parse(restored.res.headers.get("HX-Trigger") ?? "{}").toast.message,
		).toBe(
			"Restored Farmers market. Second deleted refund no longer fits and was left off.",
		);
		expect(
			(
				await env.DB.prepare(
					"SELECT raw_name FROM transactions WHERE refund_of_id=? ORDER BY id",
				)
					.bind(purchaseId)
					.all()
			).results.map((row) => row.raw_name),
		).toEqual(["Existing refund", "First deleted refund"]);
	});

	it.each([
		{ left: 0, amounts: [400, 400], expected: 0 },
		{ left: 400, amounts: [400], expected: 1 },
		{ left: 500, amounts: [400, 400], expected: 1 },
		{ left: 800, amounts: [400, 400], expected: 2 },
	])(
		"restores $expected deleted refund links when $left cents remain",
		async ({ left, amounts, expected }) => {
			const id = await cashEntry();
			const account = await env.DB.prepare(
				"SELECT id FROM accounts WHERE type='cash'",
			).first<{ id: number }>();
			const bankAccount = await env.DB.prepare(
				"SELECT id FROM accounts WHERE type!='cash' LIMIT 1",
			).first<{ id: number }>();
			if (!account || !bankAccount) throw new Error("account seed missing");
			const purchase = await env.DB.prepare(
				"INSERT INTO transactions (account_id,date,amount_cents,raw_name,updated_by) VALUES (?, '2026-10-01', 1000, 'Purchase', 'test')",
			)
				.bind(bankAccount.id)
				.run();
			const purchaseId = Number(purchase.meta.last_row_id);
			if (left < 1000)
				await env.DB.prepare(
					"INSERT INTO transactions (account_id,date,amount_cents,raw_name,refund_of_id,updated_by) VALUES (?, '2026-10-01', ?, 'Existing refund', ?, 'test')",
				)
					.bind(bankAccount.id, -(1000 - left), purchaseId)
					.run();
			await env.DB.prepare("UPDATE transactions SET is_split=1 WHERE id=?")
				.bind(id)
				.run();
			await env.DB.batch(
				amounts.map((amount, index) =>
					env.DB.prepare(
						"INSERT INTO transactions (account_id,date,amount_cents,raw_name,parent_id,refund_of_id,updated_by) VALUES (?, '2026-10-02', ?, ?, ?, ?, 'test')",
					).bind(
						account.id,
						-amount,
						`Deleted refund ${index + 1}`,
						id,
						purchaseId,
					),
				),
			);
			const token = await holdCashDelete(env.DB, id, "Market");
			if (!token) throw new Error("cash delete token missing");
			await restoreCashDelete(env.DB, token);
			expect(
				(
					await env.DB.prepare(
						"SELECT COUNT(*) AS n FROM transactions WHERE refund_of_id=? AND raw_name LIKE 'Deleted refund %'",
					)
						.bind(purchaseId)
						.first<{ n: number }>()
				)?.n,
			).toBe(expected);
		},
	);
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
		const restoredParent = await env.DB.prepare(
			"SELECT * FROM transactions WHERE note='parent note'",
		).first<Record<string, unknown>>();
		const restoredParts = (
			await env.DB.prepare(
				"SELECT * FROM transactions WHERE note='part note' ORDER BY raw_name",
			).all<Record<string, unknown>>()
		).results;
		const withoutIds = ({
			id: _id,
			parent_id: _parentId,
			...row
		}: Record<string, unknown>) => row;
		expect(restoredParent).not.toBeNull();
		expect(withoutIds(restoredParent as Record<string, unknown>)).toEqual(
			withoutIds(before.parent as Record<string, unknown>),
		);
		expect(restoredParts.map(withoutIds)).toEqual(
			(before.parts as Record<string, unknown>[]).map(withoutIds),
		);
		expect(
			restoredParts.every((part) => part.parent_id === restoredParent?.id),
		).toBe(true);
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
							sql.includes("UPDATE cash_delete_holds SET restore_marker")
								? "UPDATE missing_cash_delete_holds SET restore_marker"
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
			await env.DB.prepare(
				"SELECT token, restore_marker FROM cash_delete_holds WHERE token=?",
			)
				.bind(token)
				.first(),
		).toEqual({ token, restore_marker: null });
	});

	it("restores a token only once when two restores race", async () => {
		const id = await cashEntry();
		await env.DB.prepare(
			"UPDATE transactions SET note='race restore' WHERE id=?",
		)
			.bind(id)
			.run();
		const token = await holdCashDelete(env.DB, id, "Market");
		if (!token) throw new Error("cash delete token missing");

		const results = await Promise.all([
			restoreCashDelete(env.DB, token),
			restoreCashDelete(env.DB, token),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(results.filter((result) => result === null)).toHaveLength(1);
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE note='race restore'",
			).first(),
		).toEqual({ n: 1 });
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM cash_delete_holds WHERE token=? AND restore_marker IS NOT NULL",
			)
				.bind(token)
				.first(),
		).toEqual({ n: 1 });
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
				await env.DB.prepare(
					"SELECT refund_of_id FROM transactions WHERE raw_name='Missing partner refund'",
				).first<{ refund_of_id: number | null }>()
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
		for (let index = 0; index < purchaseIds.length; index++) {
			await env.DB.prepare(
				"INSERT INTO transactions (account_id,date,amount_cents,raw_name,parent_id,refund_of_id,updated_by) VALUES (?, '2026-10-02', -200, ?, ?, ?, 'test')",
			)
				.bind(account.id, `Split refund ${index + 1}`, id, purchaseId(index))
				.run();
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
			"SELECT raw_name, refund_of_id FROM transactions WHERE raw_name LIKE 'Split refund %' ORDER BY raw_name",
		).all<{ raw_name: string; refund_of_id: number | null }>();
		expect(parts.results).toEqual([
			{ raw_name: "Split refund 1", refund_of_id: null },
			{ raw_name: "Split refund 2", refund_of_id: purchaseId(1) },
			{ raw_name: "Split refund 3", refund_of_id: null },
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
		expect(counted.statements()).toBe(7);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE parent_id=(SELECT MAX(id) FROM transactions WHERE raw_name='Farmers market')",
				).first<{ n: number }>()
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
		expect(smallCount.statements()).toBe(6);
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
		expect(counted.statements()).toBe(15);

		const small = await env.DB.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name) SELECT id,'2026-10-06',100,'Small delete' FROM accounts WHERE type='cash' LIMIT 1",
		).run();
		const smallCount = countingDb();
		await deleteRequest(Number(small.meta.last_row_id), smallCount.db);
		expect(smallCount.statements()).toBe(15);
		expect(
			Math.abs(smallCount.statements() - counted.statements()),
		).toBeLessThanOrEqual(3);
	});
});
