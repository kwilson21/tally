import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadMonth } from "../src/db/month";
import { saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";
beforeEach(() => resetDemo(env.DB, "2026-09-22"));

async function ensureIncomeReviewColumns() {
	const columns = await env.DB.prepare("PRAGMA table_info(transactions)").all<{
		name: string;
	}>();
	const existing = new Set(columns.results.map((column) => column.name));
	if (!existing.has("income_source"))
		await env.DB.prepare(
			"ALTER TABLE transactions ADD COLUMN income_source TEXT CHECK (income_source IN ('user', 'jev'))",
		).run();
	if (!existing.has("credit_reviewed"))
		await env.DB.prepare(
			"ALTER TABLE transactions ADD COLUMN credit_reviewed INTEGER CHECK (credit_reviewed IN (0, 1))",
		).run();
	if (!existing.has("credit_reviewed_by"))
		await env.DB.prepare(
			"ALTER TABLE transactions ADD COLUMN credit_reviewed_by TEXT CHECK (credit_reviewed_by IN ('user'))",
		).run();
	const installed = await env.DB.prepare(
		"PRAGMA table_info(transactions)",
	).all<{ name: string }>();
	for (const name of ["income_source", "credit_reviewed", "credit_reviewed_by"])
		expect(installed.results.some((column) => column.name === name)).toBe(true);
}

async function post(path: string, fields: [string, string][]) {
	return exports.default.fetch(BASE + path, {
		method: "POST",
		headers: {
			Origin: BASE,
			"HX-Request": "true",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(fields),
	});
}

describe("transaction splits", () => {
	it("uses the legacy split insert shape with isolated legacy schema metadata", async () => {
		const refund = await env.DB.prepare(
			"SELECT id, amount_cents AS amountCents FROM transactions WHERE amount_cents < 0 AND parent_id IS NULL AND flag_income = 0 LIMIT 1",
		).first<{ id: number; amountCents: number }>();
		const half = Math.trunc((refund?.amountCents as number) / 2);
		expect(
			await saveSplit(
				{
					prepare(query: string) {
						if (query !== "PRAGMA table_info(transactions)")
							return env.DB.prepare(query);
						return {
							all: async () => {
								const columns = await env.DB.prepare(query).all<{
									name: string;
								}>();
								return {
									...columns,
									results: columns.results.filter(
										(column) =>
											!new Set([
												"income_source",
												"credit_reviewed",
												"credit_reviewed_by",
											]).has(column.name),
									),
								};
							},
						} as unknown as D1PreparedStatement;
					},
					batch: env.DB.batch.bind(env.DB),
				} as unknown as D1Database,
				refund?.id as number,
				[
					{ categoryId: 1, amountCents: half },
					{
						categoryId: 5,
						amountCents: (refund?.amountCents as number) - half,
					},
				],
				"synthetic-test",
			),
		).toMatchObject({ saved: true });
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?",
			)
				.bind(refund?.id)
				.first(),
		).toEqual({ n: 2 });
	});

	it("renders two labeled parts and the server-computed live line", async () => {
		const bakery = await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number }>();
		const html = await (
			await exports.default.fetch(`${BASE}/transactions/${bakery?.id}/split`)
		).text();
		expect(html).toContain("$12.00 left to assign");
		expect(html.match(/name="part_category"/g)).toHaveLength(2);
		expect(html).toContain('hx-trigger="input delay:300ms"');
		// The amount request is nested inside a form that selects #page. Override that inherited
		// selector so its partial response can update the live total.
		expect(html).toMatch(/hx-select="#split-line (>|&gt;) \*"/);
		// Both parts' requests share one queue, and only the newest waiting one is sent after the one
		// in flight, so a late answer about older amounts can't be the last word on the line.
		expect(html.match(/hx-sync="#split-line:queue last"/g)).toHaveLength(2);
	});

	it("does not offer or allow splitting income", async () => {
		const income = await env.DB.prepare(
			"SELECT id FROM transactions WHERE flag_income = 1 LIMIT 1",
		).first<{ id: number }>();
		const edit = await (
			await exports.default.fetch(`${BASE}/transactions/${income?.id}`)
		).text();
		expect(edit).not.toContain(`/transactions/${income?.id}/split?`);
		const form = await exports.default.fetch(
			`${BASE}/transactions/${income?.id}/split`,
		);
		expect(form.status).toBe(404);
		const response = await post(`/transactions/${income?.id}/split`, [
			["back", "/transactions"],
		]);
		expect(response.status).toBe(422);
		const html = await response.text();
		expect(html).toContain('id="split-title"');
		expect(html).toMatch(
			/<p role="alert" class="text-sm text-over">Income can&#39;t be split\.<\/p>/,
		);
	});

	it("refuses a split posted for a row a bank change made income, on the sheet with a field error", async () => {
		const bakery = await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number }>();
		const id = bakery?.id as number;
		await env.DB.prepare("UPDATE transactions SET flag_income = 1 WHERE id = ?")
			.bind(id)
			.run();
		const response = await post(`/transactions/${id}/split`, [
			["part_category", "1"],
			["part_category", "5"],
			["part_amount", "5"],
			["part_amount", "7"],
			["back", "/transactions"],
		]);
		expect(response.status).toBe(422);
		const html = await response.text();
		expect(html).toContain("Income can&#39;t be split.");
		expect(html).toContain('role="alert"');
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?",
				)
					.bind(id)
					.first<{ n: number }>()
			)?.n,
		).toBe(0);
	});

	it("copies current parent date, exclusion and credit review from inside the batch", async () => {
		await ensureIncomeReviewColumns();
		const bakery = await env.DB.prepare(
			"SELECT id, amount_cents AS cents FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number; cents: number }>();
		const id = bakery?.id as number;
		const first = Math.trunc((bakery?.cents as number) / 2);
		const second = (bakery?.cents as number) - first;
		let raced = false;
		const db = {
			prepare: (query: string) => env.DB.prepare(query),
			batch: async (statements: D1PreparedStatement[]) => {
				if (!raced) {
					raced = true;
					await env.DB.prepare(
						"UPDATE transactions SET date = '2026-09-30', excluded = 1, excluded_source = 'user', income_source = 'user', credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = ?",
					)
						.bind(id)
						.run();
				}
				return env.DB.batch(statements);
			},
		} as unknown as D1Database;
		expect(
			await saveSplit(
				db,
				id,
				[
					{ categoryId: 1, amountCents: first },
					{ categoryId: 5, amountCents: second },
				],
				"synthetic-test",
			),
		).toMatchObject({ saved: true });
		expect(
			await env.DB.prepare(
				"SELECT date, excluded, excluded_source, income_source, credit_reviewed, credit_reviewed_by FROM transactions WHERE parent_id = ? ORDER BY id",
			)
				.bind(id)
				.all(),
		).toMatchObject({
			results: [
				{
					date: "2026-09-30",
					excluded: 1,
					excluded_source: "user",
					income_source: "user",
					credit_reviewed: 1,
					credit_reviewed_by: "user",
				},
				{
					date: "2026-09-30",
					excluded: 1,
					excluded_source: "user",
					income_source: "user",
					credit_reviewed: 1,
					credit_reviewed_by: "user",
				},
			],
		});
	});

	it("keeps the purchase's category and its source when it is split, so a bank change can go back to it", async () => {
		const bakery = await env.DB.prepare(
			"SELECT id, amount_cents AS cents FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number; cents: number }>();
		const id = bakery?.id as number;
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 2, category_source = 'jev' WHERE id = ?",
		)
			.bind(id)
			.run();
		const first = Math.trunc((bakery?.cents as number) / 2);
		const second = (bakery?.cents as number) - first;
		expect(
			await saveSplit(
				env.DB,
				id,
				[
					{ categoryId: 1, amountCents: first },
					{ categoryId: 5, amountCents: second },
				],
				"synthetic-test",
			),
		).toMatchObject({ saved: true });
		expect(
			await env.DB.prepare(
				"SELECT category_id, category_source FROM transactions WHERE id = ?",
			)
				.bind(id)
				.first(),
		).toEqual({ category_id: 2, category_source: "jev" });
	});

	it("rejects a mismatch, then saves children and removes them atomically", async () => {
		const bakery = await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number }>();
		const id = bakery?.id as number;
		const bad = await post(`/transactions/${id}/split`, [
			["part_category", "1"],
			["part_category", "5"],
			["part_amount", "5"],
			["part_amount", "6"],
			["back", "/transactions"],
		]);
		expect(bad.status).toBe(422);
		expect(await bad.text()).toContain('role="alert"');
		const saved = await post(`/transactions/${id}/split`, [
			["part_category", "1"],
			["part_category", "5"],
			["part_amount", "5"],
			["part_amount", "7"],
			["back", "/transactions"],
		]);
		expect(saved.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?",
			)
				.bind(id)
				.first<{ n: number }>(),
		).toEqual({ n: 2 });
		expect(
			(
				await env.DB.prepare("SELECT is_split FROM transactions WHERE id = ?")
					.bind(id)
					.first<{ is_split: number }>()
			)?.is_split,
		).toBe(1);
		await post(`/transactions/${id}/split/remove`, [["back", "/transactions"]]);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?",
				)
					.bind(id)
					.first<{ n: number }>()
			)?.n,
		).toBe(0);
	});

	it("excluding a split parent excludes its children", async () => {
		const costco = await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'COSTCO WHSE #0431' AND is_split = 1",
		).first<{ id: number }>();
		await post(`/transactions/${costco?.id}`, [
			["merchant", "Costco"],
			["note", ""],
			["excluded", "1"],
			["back", "/transactions"],
		]);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ? AND excluded = 1",
				)
					.bind(costco?.id)
					.first<{ n: number }>()
			)?.n,
		).toBe(2);
	});

	it("writes nothing when the bank changed the amount after the parts were checked", async () => {
		const bakery = await env.DB.prepare(
			"SELECT id, amount_cents AS cents FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number; cents: number }>();
		const id = bakery?.id as number;
		const stale = [
			{ categoryId: 1, amountCents: 500 },
			{ categoryId: 5, amountCents: (bakery?.cents as number) - 400 },
		];
		expect(await saveSplit(env.DB, id, stale, "test")).toEqual({
			saved: false,
			unlinked: [],
			bills: [],
		});
		expect(
			await env.DB.prepare(
				"SELECT is_split AS split, (SELECT COUNT(*) FROM transactions WHERE parent_id = ?1) AS parts FROM transactions WHERE id = ?1",
			)
				.bind(id)
				.first(),
		).toEqual({ split: 0, parts: 0 });
	});

	it("preserves reviewed credit metadata when income review columns are installed", async () => {
		await ensureIncomeReviewColumns();

		const refund = await env.DB.prepare(
			"SELECT id, amount_cents AS amountCents FROM transactions WHERE amount_cents < 0 AND parent_id IS NULL AND flag_income = 0 LIMIT 1",
		).first<{ id: number; amountCents: number }>();
		const id = refund?.id as number;
		await env.DB.prepare(
			"UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user', income_source = 'user' WHERE id = ?",
		)
			.bind(id)
			.run();
		const total = Math.abs(refund?.amountCents as number);
		const before = await loadMonth(env.DB, "2026-09");
		const totalBefore = before.transactions.reduce(
			(sum, tx) => sum + tx.amountCents,
			0,
		);
		const first = Math.trunc(total / 2);
		const second = total - first;
		for (let save = 0; save < 2; save++) {
			const response = await post(`/transactions/${id}/split`, [
				["part_category", "1"],
				["part_category", "5"],
				["part_amount", (first / 100).toFixed(2)],
				["part_amount", (second / 100).toFixed(2)],
				["back", "/transactions"],
			]);
			expect(response.status).toBe(200);
		}
		const children = await env.DB.prepare(
			"SELECT flag_income, income_source, credit_reviewed, credit_reviewed_by FROM transactions WHERE parent_id = ?",
		)
			.bind(id)
			.all();
		expect(children.results).toHaveLength(2);
		for (const child of children.results as Array<Record<string, unknown>>) {
			expect(child).toMatchObject({
				flag_income: 0,
				income_source: "user",
				credit_reviewed: 1,
				credit_reviewed_by: "user",
			});
		}
		const during = await loadMonth(env.DB, "2026-09");
		expect(
			during.transactions.reduce((sum, tx) => sum + tx.amountCents, 0),
		).toBe(totalBefore);
		await post(`/transactions/${id}/split/remove`, [["back", "/transactions"]]);
		const after = await loadMonth(env.DB, "2026-09");
		expect(
			after.transactions.reduce((sum, tx) => sum + tx.amountCents, 0),
		).toBe(totalBefore);
		expect(
			await env.DB.prepare(
				"SELECT is_split, credit_reviewed, credit_reviewed_by FROM transactions WHERE id = ?",
			)
				.bind(id)
				.first(),
		).toEqual({ is_split: 0, credit_reviewed: 1, credit_reviewed_by: "user" });
	});
});

describe("a split change says which bill payments it unlinked (decision 99)", () => {
	const PURCHASE = 9830;
	const MEMBERSHIP_PART = 9831;
	const GROCERIES_PART = 9832;

	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT OR REPLACE INTO merchants (raw_name, display_name) VALUES ('COSTCO', 'Costco')",
			),
			env.DB.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, anchor_month, category_id, merchant_raw_name, active) VALUES (9820, 'Costco membership', 4000, 15, 'yearly', 9, NULL, 'COSTCO', 1)",
			),
			env.DB.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, anchor_month, category_id, merchant_raw_name, active) VALUES (9821, 'Water', 1000, 3, 'monthly', NULL, NULL, 'CITY WATER', 1)",
			),
			env.DB.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, is_split) VALUES (?, 3, '2026-09-15', 5000, 'COSTCO', 1)",
			).bind(PURCHASE),
			env.DB.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source, parent_id) VALUES (?, 3, '2026-09-15', 4000, 'COSTCO', 4, 'user', ?)",
			).bind(MEMBERSHIP_PART, PURCHASE),
			env.DB.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source, parent_id) VALUES (?, 3, '2026-09-15', 1000, 'COSTCO', 1, 'user', ?)",
			).bind(GROCERIES_PART, PURCHASE),
			env.DB.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9820, '2026', ?, 'auto', 'linked')",
			).bind(MEMBERSHIP_PART),
		]);
	});

	const trigger = async (res: Response) =>
		JSON.parse(res.headers.get("HX-Trigger") ?? "null") as {
			toast: { message: string };
			announce: string;
		};

	it("says the bill is no longer paid when a split is removed", async () => {
		const response = await post(`/transactions/${PURCHASE}/split/remove`, [
			["back", "/transactions"],
		]);
		const sent = await trigger(response);
		const message =
			"Removed split from Costco. The Costco membership bill for 2026 is no longer paid.";
		expect(sent.toast.message).toBe(message);
		expect(sent.announce).toBe(message);
	});

	it("counts the bills when a split removal unlinks more than one", async () => {
		await env.DB.prepare(
			"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9821, '2026-09', ?, 'auto', 'linked')",
		)
			.bind(GROCERIES_PART)
			.run();
		const response = await post(`/transactions/${PURCHASE}/split/remove`, [
			["back", "/transactions"],
		]);
		expect((await trigger(response)).toast.message).toBe(
			"Removed split from Costco. 2 bills are no longer paid.",
		);
	});

	it("says the same in the edit panel after a bank change removed the split", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions WHERE parent_id = ?").bind(
				PURCHASE,
			),
			env.DB.prepare(
				"UPDATE transactions SET is_split = 0, split_removed_from_cents = 5000, split_removed_bills = ? WHERE id = ?",
			).bind('[{"name":"Costco membership","period":"2026"}]', PURCHASE),
		]);
		const html = await (
			await exports.default.fetch(`${BASE}/transactions/${PURCHASE}`)
		).text();
		expect(html).toContain(
			"so its split was removed. The Costco membership bill for 2026 is no longer paid.",
		);
	});

	it("says the bill is no longer paid when the parts are replaced", async () => {
		const response = await post(`/transactions/${PURCHASE}/split`, [
			["part_category", "4"],
			["part_category", "1"],
			["part_amount", "35"],
			["part_amount", "15"],
			["back", "/transactions"],
		]);
		expect(response.status).toBe(200);
		const sent = await trigger(response);
		expect(sent.toast.message).toBe(
			"Split Costco. The Costco membership bill for 2026 is no longer paid.",
		);
		expect(sent.announce).toBe(
			"Saved split for Costco. The Costco membership bill for 2026 is no longer paid.",
		);
	});

	it("says nothing about a bill when the parts keep its payment", async () => {
		const response = await post(`/transactions/${PURCHASE}/split`, [
			["part_category", "4"],
			["part_category", "2"],
			["part_amount", "40"],
			["part_amount", "10"],
			["back", "/transactions"],
		]);
		expect(response.status).toBe(200);
		const sent = await trigger(response);
		expect(sent.toast.message).toBe("Split Costco");
		expect(sent.announce).toBe("Saved split for Costco.");
	});

	describe("after a bank change removed the split and the bill is paid again", () => {
		const COSTCO_JSON =
			'[{"billId":9820,"name":"Costco membership","period":"2026"}]';
		const UNPAID_SENTENCE =
			"The Costco membership bill for 2026 is no longer paid.";

		/** The bank change: PURCHASE is whole again, its parts gone, and its note names the bills by id. */
		async function bankChangeRemovedSplit(bills: string) {
			await env.DB.batch([
				env.DB.prepare("DELETE FROM transactions WHERE parent_id = ?").bind(
					PURCHASE,
				),
				env.DB.prepare(
					"UPDATE transactions SET is_split = 0, split_removed_from_cents = 5000, split_removed_bills = ? WHERE id = ?",
				).bind(bills, PURCHASE),
			]);
		}

		const editPanel = async () =>
			(await exports.default.fetch(`${BASE}/transactions/${PURCHASE}`)).text();
		const linkByHand = (bill: number, period: string, transaction: number) =>
			post(`/bills/${bill}/link`, [
				["transaction_id", String(transaction)],
				["period", period],
				["opened_period", period],
			]);

		it("drops the bill sentence from the edit panel and the list once the purchase is linked to the bill", async () => {
			await bankChangeRemovedSplit(COSTCO_JSON);
			expect(await editPanel()).toContain(UNPAID_SENTENCE);

			await linkByHand(9820, "2026", PURCHASE);

			const html = await editPanel();
			expect(html).toContain("so its split was removed.");
			expect(html).not.toContain("no longer paid");
			const list = await (
				await exports.default.fetch(`${BASE}/transactions?q=COSTCO&month=all`)
			).text();
			expect(list).toContain("so its split was removed.");
			expect(list).not.toContain("no longer paid");
		});

		it("drops the bill sentence the same way when a different payment is linked to the occurrence", async () => {
			await env.DB.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (9833, 3, '2026-09-15', 5000, 'COSTCO')",
			).run();
			await bankChangeRemovedSplit(COSTCO_JSON);

			await linkByHand(9820, "2026", 9833);

			const html = await editPanel();
			expect(html).toContain("so its split was removed.");
			expect(html).not.toContain("no longer paid");
		});

		it("names the bill still unpaid when another one is paid again", async () => {
			await bankChangeRemovedSplit(
				'[{"billId":9820,"name":"Costco membership","period":"2026"},{"billId":9821,"name":"Water","period":"2026-09"}]',
			);
			await env.DB.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (9834, 3, '2026-09-15', 4000, 'COSTCO')",
			).run();

			await linkByHand(9820, "2026", 9834);

			const html = await editPanel();
			expect(html).toContain(
				"The Water bill for September 2026 is no longer paid.",
			);
			expect(html).not.toContain(UNPAID_SENTENCE);
		});
	});
});
