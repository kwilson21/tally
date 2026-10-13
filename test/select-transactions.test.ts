import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, monthLabel, todayIn } from "../src/dates";
import { FOLLOWS_PURCHASE } from "../src/db/counted-month";
import { resetDemo } from "../src/demo/reset";
import { transactions } from "../src/routes/transactions";

const request = async (path: string, init?: RequestInit) => {
	const headers = new Headers(init?.headers);
	if (init?.method === "POST") headers.set("Origin", "http://tally.test");
	return exports.default.fetch(`http://tally.test${path}`, {
		...init,
		headers,
	});
};

beforeEach(async () => resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE)));

/** The selectable ids on the first page of all months, newest first. The demo seed follows the
 * date, so which ids land on page 1 changes from day to day; tests that need a row on the page
 * take theirs from here rather than naming one. */
const firstPageIds = async () => {
	const html = await (await request("/transactions?month=all&select=1")).text();
	return [...html.matchAll(/name="ids" value="(\d+)"/g)].map((m) =>
		Number(m[1]),
	);
};

describe("Set category on a refund that follows its purchase (#346, decision 99)", () => {
	const GROCERIES = 1;
	const EATING_OUT = 2;

	type Row = {
		date: string;
		amount: number;
		rawName?: string;
		category?: number | null;
		refundOf?: number | null;
		parent?: number | null;
		isSplit?: 0 | 1;
		/** A refund's review: 1 is a person's reviewed refund (the default for money back). */
		reviewed?: 0 | 1;
		income?: 0 | 1;
		excluded?: 0 | 1;
	};

	/** Inserts one bank row. Money out is positive; a refund (money back) is negative and reviewed by default. */
	const insertRow = (id: number, row: Row) =>
		env.DB.prepare(
			"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source, refund_of_id, parent_id, is_split, credit_reviewed, flag_income, excluded) VALUES (?, 3, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
			.bind(
				id,
				row.date,
				row.amount,
				row.rawName ?? "SHOP 346",
				row.category ?? null,
				row.category ? "user" : null,
				row.refundOf ?? null,
				row.parent ?? null,
				row.isSplit ?? 0,
				row.reviewed ?? (row.amount < 0 ? 1 : null),
				row.income ?? 0,
				row.excluded ?? 0,
			)
			.run();

	/** The Set category save the sheet posts for these ticks (not all mode), setting Groceries. */
	async function setGroceries(ids: number[]) {
		const body = new URLSearchParams({
			category: String(GROCERIES),
			back: "/transactions?month=all",
		});
		for (const id of ids) body.append("ids", String(id));
		const res = await request("/transactions/select/category/save", {
			method: "POST",
			body,
			headers: { "HX-Request": "true" },
		});
		const trigger = JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
			toast?: { message: string };
			announce?: string;
		};
		return {
			res,
			message: trigger.toast?.message,
			announce: trigger.announce,
		};
	}

	/** A row's own category, its source and its refund link, as stored. */
	const stored = (id: number) =>
		env.DB.prepare(
			"SELECT category_id AS categoryId, category_source AS source, refund_of_id AS refundOf FROM transactions WHERE id = ?",
		)
			.bind(id)
			.first<{
				categoryId: number | null;
				source: string | null;
				refundOf: number | null;
			}>();

	beforeEach(() => {
		// The toast names the purchase's date without a year, so the clock is pinned to the year the fixtures use.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-13T16:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("a ticked linked refund sets its purchase's category, and the refund keeps following with none of its own", async () => {
		await insertRow(9401, {
			date: "2026-09-05",
			amount: 5000,
			category: EATING_OUT,
		});
		await insertRow(9402, {
			date: "2026-09-10",
			amount: -2000,
			refundOf: 9401,
		});
		const { res, message, announce } = await setGroceries([9402]);
		expect(res.status).toBe(200);
		expect(message).toBe(
			"Set 1 transaction to Groceries. Its Sep 5 purchase moved with it.",
		);
		expect(announce).toBe(message);
		expect(await stored(9401)).toEqual({
			categoryId: GROCERIES,
			source: "user",
			refundOf: null,
		});
		expect(await stored(9402)).toEqual({
			categoryId: null,
			source: null,
			refundOf: 9401,
		});
	});

	it("a refund and its own purchase ticked together change the purchase once, with no moved sentence", async () => {
		await insertRow(9401, {
			date: "2026-09-05",
			amount: 5000,
			category: EATING_OUT,
		});
		await insertRow(9402, {
			date: "2026-09-10",
			amount: -2000,
			refundOf: 9401,
		});
		const { message } = await setGroceries([9401, 9402]);
		expect(message).toBe("Set 1 transaction to Groceries.");
		expect(await stored(9401)).toMatchObject({
			categoryId: GROCERIES,
			source: "user",
		});
		expect(await stored(9402)).toMatchObject({
			categoryId: null,
			refundOf: 9401,
		});
	});

	it("two refunds of one purchase change it once, and the sentence names its date", async () => {
		await insertRow(9401, { date: "2026-08-20", amount: 3000 });
		await insertRow(9402, {
			date: "2026-09-10",
			amount: -1000,
			refundOf: 9401,
		});
		await insertRow(9403, {
			date: "2026-09-12",
			amount: -500,
			refundOf: 9401,
		});
		const { message } = await setGroceries([9402, 9403]);
		expect(message).toBe(
			"Set 1 transaction to Groceries. Its Aug 20 purchase moved with it.",
		);
		expect(await stored(9401)).toMatchObject({ categoryId: GROCERIES });
		expect(await stored(9402)).toMatchObject({ categoryId: null });
		expect(await stored(9403)).toMatchObject({ categoryId: null });
	});

	it("refunds of different purchases move each purchase, and the sentence says so for several", async () => {
		await insertRow(9401, { date: "2026-09-05", amount: 5000 });
		await insertRow(9402, {
			date: "2026-09-10",
			amount: -2000,
			refundOf: 9401,
		});
		await insertRow(9404, { date: "2026-08-20", amount: 3000 });
		await insertRow(9405, {
			date: "2026-09-14",
			amount: -1500,
			refundOf: 9404,
		});
		const { message } = await setGroceries([9402, 9405]);
		expect(message).toBe(
			"Set 2 transactions to Groceries. Their purchases moved with them.",
		);
		expect(await stored(9401)).toMatchObject({ categoryId: GROCERIES });
		expect(await stored(9404)).toMatchObject({ categoryId: GROCERIES });
		expect(await stored(9402)).toMatchObject({ categoryId: null });
		expect(await stored(9405)).toMatchObject({ categoryId: null });
	});

	it("an unlinked refund gets the category itself, as before", async () => {
		await insertRow(9402, { date: "2026-09-10", amount: -2000 });
		const { message } = await setGroceries([9402]);
		expect(message).toBe("Set 1 transaction to Groceries.");
		expect(await stored(9402)).toEqual({
			categoryId: GROCERIES,
			source: "user",
			refundOf: null,
		});
	});

	it("a mix of ordinary rows, an unlinked refund and a linked refund counts the purchase as one changed row", async () => {
		await insertRow(9401, { date: "2026-09-05", amount: 5000 });
		await insertRow(9402, {
			date: "2026-09-10",
			amount: -2000,
			refundOf: 9401,
		});
		await insertRow(9406, { date: "2026-09-01", amount: 1000 });
		await insertRow(9407, { date: "2026-09-12", amount: -500 });
		const { message } = await setGroceries([9406, 9407, 9402]);
		expect(message).toBe(
			"Set 3 transactions to Groceries. Its Sep 5 purchase moved with it.",
		);
		expect(await stored(9406)).toMatchObject({ categoryId: GROCERIES });
		expect(await stored(9407)).toMatchObject({ categoryId: GROCERIES });
		expect(await stored(9401)).toMatchObject({ categoryId: GROCERIES });
		expect(await stored(9402)).toMatchObject({ categoryId: null });
	});

	it("a refund of a split part moves that part, not the split parent", async () => {
		await insertRow(9410, { date: "2026-09-05", amount: 5000, isSplit: 1 });
		await insertRow(9411, {
			date: "2026-09-05",
			amount: 5000,
			parent: 9410,
			category: EATING_OUT,
		});
		await insertRow(9412, {
			date: "2026-09-10",
			amount: -2000,
			refundOf: 9411,
		});
		const { message } = await setGroceries([9412]);
		expect(message).toBe(
			"Set 1 transaction to Groceries. Its Sep 5 purchase moved with it.",
		);
		expect(await stored(9411)).toEqual({
			categoryId: GROCERIES,
			source: "user",
			refundOf: null,
		});
		expect(await stored(9410)).toMatchObject({ categoryId: null });
		expect(await stored(9412)).toMatchObject({
			categoryId: null,
			refundOf: 9411,
		});
	});

	it.each([
		{
			why: "its purchase is excluded",
			purchase: { excluded: 1 as const },
			refund: {},
		},
		{
			why: "the refund is not reviewed",
			purchase: {},
			refund: { reviewed: 0 as const },
		},
		{
			why: "the refund is income",
			purchase: {},
			refund: { income: 1 as const },
		},
	])(
		"a linked refund that doesn't follow, because $why, takes the category itself and leaves its purchase alone",
		async ({ purchase, refund }) => {
			await insertRow(9401, {
				date: "2026-09-05",
				amount: 5000,
				category: EATING_OUT,
				...purchase,
			});
			await insertRow(9402, {
				date: "2026-09-10",
				amount: -2000,
				refundOf: 9401,
				...refund,
			});
			const { message } = await setGroceries([9402]);
			expect(message).toBe("Set 1 transaction to Groceries.");
			expect(await stored(9402)).toEqual({
				categoryId: GROCERIES,
				source: "user",
				refundOf: 9401,
			});
			expect(await stored(9401)).toEqual({
				categoryId: EATING_OUT,
				source: "user",
				refundOf: null,
			});
		},
	);

	it("a linked refund whose purchase becomes the third Groceries pick gets Tally's rule question", async () => {
		// Two Groceries picks already, so the purchase that moves with its refund is the third.
		await insertRow(9420, {
			date: "2026-09-01",
			amount: 1000,
			category: GROCERIES,
		});
		await insertRow(9421, {
			date: "2026-09-02",
			amount: 1200,
			category: GROCERIES,
		});
		await insertRow(9401, { date: "2026-09-05", amount: 5000 });
		await insertRow(9402, {
			date: "2026-09-10",
			amount: -2000,
			refundOf: 9401,
		});
		const { res } = await setGroceries([9402]);
		expect(await res.text()).toContain("Always use Groceries for");
	});

	describe("a link that changes while the save runs", () => {
		type TestApp = { Bindings: Env; Variables: { actor: string } };
		const route = new Hono<TestApp>();
		route.use("*", async (c, next) => {
			c.set("actor", "test@example.com");
			await next();
		});
		route.route("/", transactions as unknown as Hono<TestApp>);

		/**
		 * The DB, with `rival` run just before the first statement that starts with `prefix` runs (its run, all or
		 * first), so a change lands between the save's start and its write. The rival writes through the real
		 * database, so it is not guarded itself.
		 */
		function racing(prefix: string, rival: () => Promise<unknown>): D1Database {
			let raced = false;
			const fire = async () => {
				if (raced) return;
				raced = true;
				await rival();
			};
			const guard = (statement: D1PreparedStatement): D1PreparedStatement =>
				new Proxy(statement, {
					get(target, prop) {
						if (prop === "bind")
							return (...values: unknown[]) => guard(target.bind(...values));
						if (prop === "run" || prop === "all" || prop === "first")
							return async (...args: unknown[]) => {
								await fire();
								return Reflect.apply(target[prop], target, args);
							};
						const value = Reflect.get(target, prop);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			return new Proxy(env.DB, {
				get(target, prop) {
					if (prop === "prepare")
						return (sql: string) => {
							const statement = target.prepare(sql);
							return sql.startsWith(prefix) ? guard(statement) : statement;
						};
					const value = Reflect.get(target, prop);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		}

		/** The sheet's Set category save for `ids` (Groceries, not all mode), run through the route on `db`. */
		async function saveWith(db: D1Database, ids: number[]) {
			const body = new URLSearchParams({
				category: String(GROCERIES),
				back: "/transactions?month=all",
			});
			for (const id of ids) body.append("ids", String(id));
			const res = await route.request(
				"/transactions/select/category/save",
				{
					method: "POST",
					body,
					headers: {
						Origin: "http://tally.test",
						"HX-Request": "true",
						"content-type": "application/x-www-form-urlencoded",
					},
				},
				{ ...env, DB: db },
			);
			const trigger = JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
				toast?: { message: string };
				announce?: string;
			};
			return {
				res,
				message: trigger.toast?.message,
				announce: trigger.announce,
			};
		}

		/** A purchase (9411, Sep 5), a second purchase (9412, Sep 7) and a refund of the first (9413, Sep 10), all Eating out but the refund. */
		const seed = async () => {
			await insertRow(9411, {
				date: "2026-09-05",
				amount: 5000,
				category: EATING_OUT,
			});
			await insertRow(9412, {
				date: "2026-09-07",
				amount: 4000,
				category: EATING_OUT,
			});
			await insertRow(9413, {
				date: "2026-09-10",
				amount: -2000,
				refundOf: 9411,
			});
		};

		it("a refund relinked to the second purchase mid-save moves that purchase, and the first keeps its category", async () => {
			await seed();
			const db = racing("UPDATE transactions SET category_id", () =>
				env.DB.prepare(
					"UPDATE transactions SET refund_of_id=9412 WHERE id=9413",
				).run(),
			);
			const { res, message, announce } = await saveWith(db, [9413]);
			expect(res.status).toBe(200);
			expect(message).toBe(
				"Set 1 transaction to Groceries. Its Sep 7 purchase moved with it.",
			);
			expect(announce).toBe(message);
			expect(await stored(9412)).toEqual({
				categoryId: GROCERIES,
				source: "user",
				refundOf: null,
			});
			expect(await stored(9411)).toEqual({
				categoryId: EATING_OUT,
				source: "user",
				refundOf: null,
			});
			expect(await stored(9413)).toEqual({
				categoryId: null,
				source: null,
				refundOf: 9412,
			});
		});

		it("a refund unlinked from its purchase mid-save takes the category itself, with no moved sentence", async () => {
			await seed();
			const db = racing("UPDATE transactions SET category_id", () =>
				env.DB.prepare(
					"UPDATE transactions SET refund_of_id=NULL WHERE id=9413",
				).run(),
			);
			const { message, announce } = await saveWith(db, [9413]);
			expect(message).toBe("Set 1 transaction to Groceries.");
			expect(announce).toBe(message);
			expect(await stored(9413)).toEqual({
				categoryId: GROCERIES,
				source: "user",
				refundOf: null,
			});
			expect(await stored(9411)).toEqual({
				categoryId: EATING_OUT,
				source: "user",
				refundOf: null,
			});
		});

		it("a refund whose purchase is excluded mid-save takes the category itself and stays linked", async () => {
			await seed();
			const db = racing("UPDATE transactions SET category_id", () =>
				env.DB.prepare(
					"UPDATE transactions SET excluded=1 WHERE id=9411",
				).run(),
			);
			const { message, announce } = await saveWith(db, [9413]);
			expect(message).toBe("Set 1 transaction to Groceries.");
			expect(announce).toBe(message);
			expect(await stored(9413)).toEqual({
				categoryId: GROCERIES,
				source: "user",
				refundOf: 9411,
			});
			expect(await stored(9411)).toEqual({
				categoryId: EATING_OUT,
				source: "user",
				refundOf: null,
			});
		});

		it("a mixed save of three ticks issues one category write, not one per row", async () => {
			await seed();
			await insertRow(9406, { date: "2026-09-01", amount: 1000 });
			await insertRow(9407, { date: "2026-09-12", amount: -500 });
			const prepared: string[] = [];
			const db = new Proxy(env.DB, {
				get(target, prop) {
					if (prop === "prepare")
						return (sql: string) => {
							prepared.push(sql);
							return target.prepare(sql);
						};
					const value = Reflect.get(target, prop);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const { res, message } = await saveWith(db, [9406, 9407, 9413]);
			expect(res.status).toBe(200);
			expect(message).toBe(
				"Set 3 transactions to Groceries. Its Sep 5 purchase moved with it.",
			);
			expect(
				prepared.filter((sql) =>
					sql.startsWith("UPDATE transactions SET category_id"),
				),
			).toHaveLength(1);
		});
	});
});

describe("select several transactions", () => {
	it("keeps every list parameter in Select and Done drops only select", async () => {
		const html = await (
			await request("/transactions?month=all&page=2&select=1")
		).text();
		expect(html).toMatch(
			/href="\/transactions\?month=all&amp;page=2" id="select-toggle"/,
		);
		const normal = await (
			await request("/transactions?month=all&page=2")
		).text();
		expect(normal).toMatch(
			/href="\/transactions\?month=all&amp;page=2&amp;select=1" id="select-toggle"/,
		);
	});

	it("does not offer a split parent but does offer its parts", async () => {
		await env.DB.batch([
			env.DB.prepare("UPDATE transactions SET is_split=1 WHERE id=110"),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,parent_id,category_id) SELECT 990,account_id,date,500,raw_name,110,1 FROM transactions WHERE id=110",
			),
		]);
		const html = await (
			await request("/transactions?select=1&q=Local+Bakery")
		).text();
		expect(html).not.toContain('name="ids" value="110"');
		expect(html).toContain('name="ids" value="990"');
	});

	it.each([
		[[], "0 selected"],
		[["110"], "1 selected"],
		[["110", "111", "112"], "3 selected"],
	])("renders the selected count", async (ids, expected) => {
		const query = new URLSearchParams(ids.map((id) => ["ids", id]));
		expect(
			await (await request(`/transactions/select/count?${query}`)).text(),
		).toContain(expected);
	});

	it("sets exactly the selected transactions and ignores a split parent", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET is_split=1 WHERE id=110",
		).run();
		const body = new URLSearchParams({
			ids: "110",
			category: "1",
			back: "/transactions?month=all&q=shop",
		});
		body.append("ids", "111");
		const res = await request("/transactions/select/category/save", {
			method: "POST",
			body,
			headers: { "HX-Request": "true" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toContain(
			"Set 1 transaction to Groceries.",
		);
		expect(await res.text()).not.toContain("Tap rows to select them.");
		expect(
			(await env.DB.prepare(
				"SELECT category_id,category_source FROM transactions WHERE id=111",
			).first()) ?? {},
		).toMatchObject({ category_id: 1, category_source: "user" });
	});

	it("a person's category for a restored purchase clears its note and takes the person's source", async () => {
		await env.DB.prepare(
			'UPDATE transactions SET category_id=2, category_source=\'jev\', split_removed_from_cents=1234, split_removed_bills=\'[{"name":"Water","period":"2026-09"}]\' WHERE id=111',
		).run();
		const res = await request("/transactions/select/category/save", {
			method: "POST",
			body: new URLSearchParams({
				ids: "111",
				category: "1",
				back: "/transactions?month=all",
			}),
			headers: { "HX-Request": "true" },
		});
		expect(res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT category_id,category_source,split_removed_from_cents,split_removed_bills FROM transactions WHERE id=111",
			).first(),
		).toEqual({
			category_id: 1,
			category_source: "user",
			split_removed_from_cents: null,
			split_removed_bills: null,
		});
	});

	it.each(["99999", "9"])(
		"rejects unknown or archived category %s",
		async (category) => {
			if (category === "9")
				await env.DB.prepare(
					"INSERT INTO categories(id,name,icon,color,sort_order,archived) VALUES(9,'Old','list','ink',99,1)",
				).run();
			const res = await request("/transactions/select/category/save", {
				method: "POST",
				body: new URLSearchParams({
					ids: "110",
					category,
					back: "/transactions",
				}),
				headers: { "HX-Request": "true" },
			});
			expect(res.status).toBe(422);
			expect(await res.text()).toContain('role="alert"');
		},
	);

	it("rejects an empty selection without saving", async () => {
		const before = await env.DB.prepare(
			"SELECT category_id FROM transactions WHERE id=110",
		).first();
		const res = await request("/transactions/select/exclude", {
			method: "POST",
			body: new URLSearchParams({ back: "/transactions" }),
		});
		expect(res.status).toBe(422);
		expect(await res.text()).toContain('role="alert"');
		expect(
			await env.DB.prepare(
				"SELECT category_id FROM transactions WHERE id=110",
			).first(),
		).toEqual(before);
	});

	it("excludes selections as a user and redirects no-JS requests to the filtered list", async () => {
		const before = await (await request("/")).text();
		const count = Number(
			before.match(
				/(\d+)<span class="sr-only"> transactions<\/span> need a category/,
			)?.[1],
		);
		const res = await request("/transactions/select/exclude", {
			method: "POST",
			body: new URLSearchParams({
				ids: "110",
				back: "/transactions?uncategorized=1",
			}),
			redirect: "manual",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/transactions?uncategorized=1");
		expect(
			await env.DB.prepare(
				"SELECT excluded,excluded_source FROM transactions WHERE id=110",
			).first(),
		).toEqual({ excluded: 1, excluded_source: "user" });
		const after = await (await request("/")).text();
		expect(after).toContain(
			`${count - 1}<span class="sr-only"> transactions</span> need a category`,
		);
	});

	const snapshot = async () =>
		(
			await env.DB.prepare(
				"SELECT id,category_id,category_source,excluded,excluded_source FROM transactions ORDER BY id",
			).all()
		).results;
	const post = (path: string, body: URLSearchParams, hx = true) =>
		request(path, {
			method: "POST",
			body,
			headers: hx ? { "HX-Request": "true" } : {},
			redirect: "manual",
		});
	const form = (ids: (string | number)[], fields: Record<string, string>) => {
		const body = new URLSearchParams(fields);
		for (const id of ids) body.append("ids", String(id));
		return body;
	};
	const splitParent = async () =>
		env.DB.batch([
			env.DB.prepare("UPDATE transactions SET is_split=1 WHERE id=110"),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,parent_id,category_id) SELECT 990,account_id,date,500,raw_name,110,1 FROM transactions WHERE id=110",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,parent_id,category_id) SELECT 991,account_id,date,700,raw_name,110,1 FROM transactions WHERE id=110",
			),
		]);

	/** 101 real rows (ids 5001 to 5101), so a tick on each one exists and the bar can count it. */
	const addHundredOneRows = async () => {
		await env.DB.prepare(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 101)
			INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id)
			SELECT 5000 + n.i, src.account_id, src.date, -100 - n.i, src.raw_name, src.category_id
			FROM n, (SELECT account_id,date,raw_name,category_id FROM transactions WHERE id=110) AS src`,
		).run();
		return Array.from({ length: 101 }, (_, i) => 5001 + i);
	};

	it("changes only the posted ids and leaves every other row and the split parent alone", async () => {
		await splitParent();
		await env.DB.prepare(
			"UPDATE transactions SET category_id=NULL, category_source=NULL WHERE id IN (111,112)",
		).run();
		const before = await snapshot();
		const res = await post(
			"/transactions/select/category/save",
			form([110, 111, 990], { category: "1", back: "/transactions" }),
		);
		expect(res.status).toBe(200);
		const after = await snapshot();
		const changed = after
			.filter((row, i) => JSON.stringify(row) !== JSON.stringify(before[i]))
			.map((row) => row.id);
		expect(changed.sort()).toEqual([111, 990]);
		expect(after.find((row) => row.id === 110)).toEqual(
			before.find((row) => row.id === 110),
		);
	});

	it.each(["99999", "9"])(
		"saves nothing for unknown or archived category %s",
		async (category) => {
			if (category === "9")
				await env.DB.prepare(
					"INSERT INTO categories(id,name,icon,color,sort_order,archived) VALUES(9,'Old','list','ink',99,1)",
				).run();
			const before = await snapshot();
			const res = await post(
				"/transactions/select/category/save",
				form([111, 112], { category, back: "/transactions" }),
			);
			expect(res.status).toBe(422);
			expect(await snapshot()).toEqual(before);
		},
	);

	it("shows an empty Set category selection's 422 inside the sheet", async () => {
		const res = await post(
			"/transactions/select/category",
			form([], { back: "/transactions" }),
		);
		expect(res.status).toBe(422);
		const html = await res.text();
		const sheet = html.slice(html.indexOf('id="sheet"'));
		expect(sheet).toMatch(
			/role="alert"[^>]*>Select at least one transaction\./,
		);
	});

	it("announces the save and returns to the filtered list out of select mode", async () => {
		const back = "/transactions?q=shop&month=all";
		const res = await post(
			"/transactions/select/category/save",
			form([111], { category: "1", back }),
		);
		const trigger = JSON.parse(res.headers.get("HX-Trigger") ?? "{}");
		expect(trigger.announce).toBe("Set 1 transaction to Groceries.");
		expect(trigger.toast.message).toBe("Set 1 transaction to Groceries.");
		expect(res.headers.get("HX-Push-Url")).toBe(back);
		const html = await res.text();
		expect(html).toContain('value="shop"');
		expect(html).not.toContain('id="selection-form"');
		expect(html).toMatch(/<option value="all" selected/);
	});

	it("pushes the list URL after Exclude", async () => {
		const back = "/transactions?uncategorized=1";
		const res = await post(
			"/transactions/select/exclude",
			form([111], { back }),
		);
		expect(res.headers.get("HX-Push-Url")).toBe(back);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}").announce).toBe(
			"Excluded 1 transaction.",
		);
	});

	it("redirects a no-JS category save to the filtered list", async () => {
		const back = "/transactions?q=shop&month=all";
		const res = await post(
			"/transactions/select/category/save",
			form([111], { category: "1", back }),
			false,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe(back);
	});

	it("keeps the chosen ids ticked when the sheet is cancelled", async () => {
		const ids = await firstPageIds();
		expect(ids.length).toBeGreaterThan(1);
		// The sheet lists the ids in ascending order.
		const [a, b] = ids.slice(0, 2).sort((x, y) => x - y) as [number, number];
		const res = await post(
			"/transactions/select/category",
			form([a, b], { back: "/transactions?month=all" }),
		);
		const html = await res.text();
		const cancel = `/transactions?month=all&amp;select=1&amp;ids=${a},${b}`;
		expect(html).toContain(`href="${cancel}"`);
		expect(
			html.match(new RegExp(`href="${cancel.replace(/[?]/g, "\\?")}"`, "g"))
				?.length,
		).toBe(2);
		const list = await (
			await request(
				`/transactions?month=all&select=1&ids=${a},${b},abc,-3,1.5,0`,
			)
		).text();
		expect(list).toMatch(new RegExp(`value="${a}"[^>]*checked`));
		expect(list).toMatch(new RegExp(`value="${b}"[^>]*checked`));
		expect((list.match(/name="ids"[^>]*checked/g) ?? []).length).toBe(2);
	});

	it("offers page links in select mode and keeps select in them", async () => {
		const html = await (
			await request("/transactions?month=all&select=1")
		).text();
		expect(html).toMatch(
			/<a href="\/transactions\?month=all&amp;page=2&amp;select=1" rel="next"/,
		);
	});

	it("refreshes Select or Done, the back input and the selection on list changes", async () => {
		const html = await (
			await request("/transactions?month=all&select=1")
		).text();
		const oob = html.match(/id="filters"[^>]*hx-select-oob="([^"]*)"/)?.[1];
		for (const part of [
			"#select-toggle:outerHTML",
			"#selection-back:outerHTML",
			"#selected-count:innerHTML",
			"#set-category-selection:outerHTML",
			"#exclude-selection:outerHTML",
			"#select-all-page:outerHTML",
		])
			expect(oob).toContain(part);
		const pageOob = html.match(/rel="next"[^>]*hx-select-oob="([^"]*)"/)?.[1];
		expect(pageOob).toContain("#select-toggle:outerHTML");
		expect(pageOob).toContain("#selected-count:innerHTML");
		expect(html).toMatch(/id="select-toggle"/);
		expect(html).toMatch(/id="selection-back"/);
	});

	it("re-derives the count from the ticked rows still in the list", async () => {
		const [id] = await firstPageIds();
		const res = await request(
			`/transactions?month=all&select=1&ids=${id}&ids=999999`,
			{ headers: { "HX-Request": "true" } },
		);
		const html = await res.text();
		expect(html).toMatch(/id="selected-count"[^>]*>1 selected</);
		const empty = await (
			await request("/transactions?month=all&select=1", {
				headers: { "HX-Request": "true" },
			})
		).text();
		expect(empty).toMatch(/id="selected-count"[^>]*>0 selected</);
		expect(empty).toMatch(/id="exclude-selection"[^>]*disabled/);
	});

	it("swaps only the out-of-band copy of the buttons", async () => {
		const html = await (
			await request("/transactions/select/count?ids=110")
		).text();
		const exclude = html.match(/<button[^>]*id="exclude-selection"[^>]*>/)?.[0];
		expect(exclude).toContain('hx-swap="innerHTML"');
		expect(exclude).toContain('hx-swap-oob="outerHTML"');
		const page = await (
			await request("/transactions?select=1&month=all")
		).text();
		const pageExclude = page.match(
			/<button[^>]*id="exclude-selection"[^>]*>/,
		)?.[0];
		expect(pageExclude).toContain('hx-swap="innerHTML"');
		expect(pageExclude).not.toContain("hx-swap-oob");
	});

	it("names each checkbox once, by merchant, amount and date", async () => {
		const html = await (
			await request("/transactions?select=1&month=all")
		).text();
		const input = html.match(/<input[^>]*name="ids" value="110"[^>]*>/)?.[0];
		expect(input).toContain('aria-labelledby="select-110-name"');
		const name = html.match(/id="select-110-name"[^>]*>([^<]*)</)?.[1];
		expect(name).toMatch(
			/^Select .+, [−-]?\$[\d,]+\.\d\d, (Today, )?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}(, \d{4})?$/,
		);
	});

	it("gives the year in a checkbox's name when the row is from another year", async () => {
		const lastYear = `${Number(todayIn(DEFAULT_TIME_ZONE).slice(0, 4)) - 1}-03-07`;
		await env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id) SELECT 992,account_id,?,1200,'OLD SHOP',1 FROM transactions WHERE id=110",
		)
			.bind(lastYear)
			.run();
		const html = await (
			await request("/transactions?select=1&month=all&q=OLD%20SHOP")
		).text();
		const name = html.match(/id="select-992-name"[^>]*>([^<]*)</)?.[1];
		expect(name).toMatch(new RegExp(`Mar 7, ${lastYear.slice(0, 4)}$`));
	});

	it("excludes a split part's whole purchase, as the edit panel does", async () => {
		await splitParent();
		const res = await post(
			"/transactions/select/exclude",
			form([990], { back: "/transactions" }),
		);
		expect(res.status).toBe(200);
		const rows = (
			await env.DB.prepare(
				"SELECT id,excluded,excluded_source FROM transactions WHERE id IN (110,990,991) ORDER BY id",
			).all()
		).results;
		expect(rows).toEqual([
			{ id: 110, excluded: 1, excluded_source: "user" },
			{ id: 990, excluded: 1, excluded_source: "user" },
			{ id: 991, excluded: 1, excluded_source: "user" },
		]);
	});

	it("says a selected row that pays a bill still counts, as the edit panel does", async () => {
		await splitParent();
		// 111 pays a bill itself, and 990 is a part of 110, which pays another (spec §8.5).
		await env.DB.batch([
			...[9800, 9801].map((id) =>
				env.DB.prepare(
					"INSERT INTO bills (id, name, amount_cents, due_day, frequency, category_id, merchant_raw_name) VALUES (?, 'Club', 1200, 1, 'monthly', 1, 'CLUB')",
				).bind(id),
			),
			...[
				[9800, 111],
				[9801, 110],
			].map(([bill, transaction]) =>
				env.DB.prepare(
					"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) SELECT ?1, substr(date, 1, 7), ?2, 'user', 'linked' FROM transactions WHERE id = ?2",
				).bind(bill, transaction),
			),
		]);
		const said = async (ids: number[]) => {
			const res = await post(
				"/transactions/select/exclude",
				form(ids, { back: "/transactions" }),
			);
			const trigger = JSON.parse(res.headers.get("HX-Trigger") ?? "{}");
			expect(trigger.toast.message).toBe(trigger.announce);
			return trigger.announce;
		};
		expect(await said([111])).toBe(
			"Excluded 1 transaction. It still counts while it pays a bill.",
		);
		expect(await said([990, 111, 112])).toBe(
			"Excluded 3 transactions. 2 still count while they pay a bill.",
		);
		expect(await said([990, 112])).toBe(
			"Excluded 2 transactions. 1 still counts while it pays a bill.",
		);
		expect(await said([112])).toBe("Excluded 1 transaction.");
	});

	it("keeps who excluded a row that was already excluded", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET excluded=1, excluded_source='jev' WHERE id=111",
		).run();
		await post(
			"/transactions/select/exclude",
			form([111, 112], { back: "/transactions?excluded=1" }),
		);
		const rows = (
			await env.DB.prepare(
				"SELECT id,excluded,excluded_source FROM transactions WHERE id IN (111,112) ORDER BY id",
			).all()
		).results;
		expect(rows).toEqual([
			{ id: 111, excluded: 1, excluded_source: "jev" },
			{ id: 112, excluded: 1, excluded_source: "user" },
		]);
	});

	it.each([
		["/transactions/select/exclude", {}],
		["/transactions/select/category", {}],
		["/transactions/select/category/save", { category: "1" }],
	])("rejects more than 100 ids at %s", async (path, extra) => {
		// 101 real rows: a missing id drops out before the limit counts (#350), so made-up ids would not reach it.
		const ids = await addHundredOneRows();
		const before = await snapshot();
		const res = await post(
			path,
			form(ids, { back: "/transactions", ...extra }),
		);
		expect(res.status).toBe(422);
		expect(await res.text()).toMatch(
			/role="alert"[\s\S]*?Select 100 or fewer transactions\./,
		);
		expect(await snapshot()).toEqual(before);
	});

	type SnapshotRow = {
		id: number;
		category_id: number | null;
		category_source: string | null;
		excluded: number;
		excluded_source: string | null;
	};

	const pageHtml = async (query: string, htmx = false) =>
		(
			await request(
				`/transactions?${query}`,
				htmx ? { headers: { "HX-Request": "true" } } : undefined,
			)
		).text();
	/** The rows on the page that can be ticked, in order. */
	const rowIds = (html: string) =>
		[...html.matchAll(/name="ids" value="(\d+)"/g)].map((m) => Number(m[1]));
	const tickedIds = (html: string) =>
		[...html.matchAll(/name="ids" value="(\d+)" checked/g)].map((m) =>
			Number(m[1]),
		);
	const selectAllLabel = (html: string) =>
		html.match(/>Select all (\d+)<\/a>/)?.[1];
	/** The link's address as a browser follows it (its ampersands are escaped in the HTML). */
	const selectAllHref = (html: string) =>
		html
			.match(/<a href="([^"]*)"[^>]*>Select all \d+<\/a>/)?.[1]
			?.replaceAll("&amp;", "&");
	/**
	 * The count's reply for these ticked ids, on a page whose selectable rows are `pageIds`. `disclosure`
	 * sends the marker a form carries while the "not on this page" line is drawn (#350).
	 */
	const countReply = (ids: number[], pageIds: number[], disclosure = false) =>
		request(
			`/transactions/select/count?${new URLSearchParams([
				...ids.map((id) => ["ids", String(id)]),
				["page-ids", pageIds.join(",")],
				["back", "/transactions?month=all"],
				...(disclosure ? [["not-on-page", "1"]] : []),
			])}`,
		);
	const countFragment = async (
		ids: number[],
		pageIds: number[],
		disclosure = false,
	) => (await countReply(ids, pageIds, disclosure)).text();

	it("offers Select all for the page's selectable rows, with none or some ticked", async () => {
		const html = await pageHtml("month=all&select=1");
		const ids = rowIds(html);
		expect(ids.length).toBeGreaterThan(1);
		expect(html).toContain('id="select-all-page"');
		expect(selectAllLabel(html)).toBe(String(ids.length));
		const some = await pageHtml(`month=all&select=1&ids=${ids[0]}`);
		expect(selectAllLabel(some)).toBe(String(ids.length));
	});

	it("puts the Select all link and the count on the list's filter queue, and leaves the buttons off it", async () => {
		const html = await pageHtml("month=all&select=1");
		const ids = rowIds(html);
		const selectAll = html.match(/<a [^>]*>Select all \d+<\/a>/)?.[0];
		expect(selectAll).toContain('hx-sync="#filters:replace"');
		const form = html.match(/<form[^>]*id="selection-form"[^>]*>/)?.[0];
		expect(form).toContain('hx-sync="#filters:queue last"');
		const oneOff = await countFragment(ids.slice(1), ids);
		expect(oneOff.match(/<a [^>]*>Select all \d+<\/a>/)?.[0]).toContain(
			'hx-sync="#filters:replace"',
		);
		for (const id of ["set-category-selection", "exclude-selection"]) {
			const button = html.match(
				new RegExp(`<button[^>]*id="${id}"[^>]*>`),
			)?.[0];
			expect(button).toBeDefined();
			expect(button).not.toContain("hx-sync");
		}
	});

	it("ticks every row on the page from the link, and the count says so", async () => {
		const html = await pageHtml("month=all&select=1");
		const ids = rowIds(html);
		const href = selectAllHref(html);
		expect(href).toBeDefined();
		const after = await (
			await request(href ?? "", { headers: { "HX-Request": "true" } })
		).text();
		expect(tickedIds(after)).toEqual(ids);
		expect(after).toMatch(/id="selected-count"[^>]*aria-live="polite"/);
		expect(after).toMatch(
			new RegExp(`id="selected-count"[^>]*>${ids.length} selected<`),
		);
		expect(selectAllLabel(after)).toBeUndefined();
	});

	it("brings the link back when a row is unticked, and hides it once every row is ticked", async () => {
		const ids = rowIds(await pageHtml("month=all&select=1"));
		const all = await countFragment(ids, ids);
		// Every page row is ticked but more rows match, so the whole-set link is drawn and the wrapper morphs it (#455).
		expect(all).toMatch(
			/<span id="select-all-page"[^>]*hx-swap-oob="outerMorph"/,
		);
		expect(selectAllLabel(all)).toBeUndefined();
		const oneOff = await countFragment(ids.slice(1), ids);
		expect(oneOff).toContain(`${ids.length - 1} selected`);
		expect(selectAllLabel(oneOff)).toBe(String(ids.length));
	});

	it("leaves a split parent out of the rows the link ticks", async () => {
		const before = rowIds(await pageHtml("month=all&select=1"));
		await env.DB.prepare("UPDATE transactions SET is_split=1 WHERE id=?")
			.bind(before[0])
			.run();
		const html = await pageHtml("month=all&select=1");
		const ids = rowIds(html);
		expect(ids).toEqual(before.slice(1));
		expect(selectAllLabel(html)).toBe(String(before.length - 1));
		const href = selectAllHref(html) ?? "";
		expect(
			new URL(href, "http://tally.test").searchParams.get("ids")?.split(","),
		).toEqual(before.slice(1).map(String));
	});

	it("counts only the rows of the filtered page", async () => {
		const html = await pageHtml("select=1&q=Local+Bakery");
		const ids = rowIds(html);
		expect(ids.length).toBeGreaterThan(0);
		expect(selectAllLabel(html)).toBe(String(ids.length));
	});

	it("has no link on a page with no rows to tick", async () => {
		const html = await pageHtml("select=1&q=zz-no-such-words-zz");
		expect(rowIds(html)).toEqual([]);
		expect(html).not.toMatch(/>Select all \d+<\/a>/);
	});

	it("ticks the page on a full page load too, without JavaScript", async () => {
		const page = await pageHtml("month=all&select=1");
		const ids = rowIds(page);
		const html = await (await request(selectAllHref(page) ?? "")).text();
		expect(tickedIds(html)).toEqual(ids);
		expect(selectAllLabel(html)).toBeUndefined();
	});

	it("changes exactly the rows the link ticked when an action follows", async () => {
		const ids = rowIds(await pageHtml("month=all&select=1"));
		const before = (await snapshot()) as SnapshotRow[];
		const res = await post(
			"/transactions/select/category/save",
			form(ids, { category: "1", back: "/transactions?month=all" }),
		);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}").announce).toBe(
			`Set ${ids.length} transactions to Groceries.`,
		);
		const beforeById = new Map(before.map((row) => [row.id, row]));
		for (const row of (await snapshot()) as SnapshotRow[]) {
			if (ids.includes(row.id)) expect(row.category_id).toBe(1);
			else expect(row).toEqual(beforeById.get(row.id));
		}
	});

	/** The page's Select all link, whole, so its attributes can be read. */
	const selectAllTag = (html: string) =>
		html.match(/<a [^>]*>Select all \d+<\/a>/)?.[0] ?? "";
	/** One attribute of a tag, with its ampersands unescaped. */
	const attribute = (tag: string, name: string) =>
		tag.match(new RegExp(` ${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");
	/** Whether a reply's Set category button takes focus when it is swapped in. */
	const setCategoryFocused = (html: string) =>
		/<button[^>]*id="set-category-selection"[^>]*autofocus/.test(html);

	it("focuses Set category in the reply to Select all, since the link leaves with that reply", async () => {
		const page = await pageHtml("month=all&select=1");
		const hxGet = attribute(selectAllTag(page), "hx-get") ?? "";
		// The page's rows come as page-ids, which htmx includes with the request (#350).
		const pageRows = page.match(/name="page-ids" value="([^"]*)"/)?.[1] ?? "";
		const reply = await (
			await request(`${hxGet}&page-ids=${pageRows}`, {
				headers: { "HX-Request": "true" },
			})
		).text();
		const setCategory =
			reply.match(/<button[^>]*id="set-category-selection"[^>]*>/)?.[0] ?? "";
		expect(setCategory).toContain("autofocus");
		// The class list has disabled:opacity-40, so look for the attribute itself.
		expect(setCategory).not.toMatch(/\sdisabled(=|\s|>)/);
		// autofocus="" also contains focus=, so look for the query parameter only.
		expect(reply).not.toMatch(/[?&]focus=/);
	});

	it("keeps the focus marker out of the pushed address, and only on the link's request", async () => {
		const page = await pageHtml("month=all&select=1");
		const link = selectAllTag(page);
		expect(attribute(link, "hx-push-url")).toBe(selectAllHref(page));
		// Its own address has no ids: htmx would replace them with the ticks it includes (#350).
		expect(attribute(link, "hx-get")).toBe(
			"/transactions?month=all&select=1&focus=set-category-selection",
		);
	});

	/** The bar's wrapper, as a count reply swaps it: its own out-of-band swap style. */
	const wrapperSwap = (html: string) =>
		attribute(
			html.match(/<span id="select-all-page"[^>]*>/)?.[0] ?? "",
			"hx-swap-oob",
		);

	it("keeps one id on the Select all link whichever link a count draws, and morphs the wrapper so the link survives (#455)", async () => {
		const page = await pageHtml("month=all&select=1");
		const ids = rowIds(page);
		// The list's own reply keeps its settle:0 swap (#438); its link has the same id as a count's.
		expect(page).toContain("#select-all-page:outerHTML settle:0");
		expect(attribute(selectAllTag(page), "id")).toBe("select-all-link");
		// The page link: some rows on the page are still unticked.
		const pageLink = await countFragment(ids.slice(0, 1), ids);
		expect(attribute(selectAllTag(pageLink), "id")).toBe("select-all-link");
		expect(pageLink.match(/id="select-all-link"/g)).toHaveLength(1);
		expect(wrapperSwap(pageLink)).toBe("outerMorph");
		// The whole-set link: every row on the page is ticked and more rows match.
		const whole = await countFragment(ids, ids);
		const wholeLink =
			whole.match(/<a [^>]*>Select all \d+ in [^<]*<\/a>/)?.[0] ?? "";
		expect(attribute(wholeLink, "id")).toBe("select-all-link");
		expect(whole.match(/id="select-all-link"/g)).toHaveLength(1);
		expect(wrapperSwap(whole)).toBe("outerMorph");
	});

	it("draws no link once every matched row is ticked: the wrapper swaps whole, and the count takes the link's id without autofocus (#455)", async () => {
		const ids = rowIds(await pageHtml("month=all&select=1"));
		// In all mode a page row whose box isn't posted is unticked, so every page row is posted as checked.
		const reply = await (
			await request(
				`/transactions/select/count?${new URLSearchParams([
					["all", "1"],
					["page-ids", ids.join(",")],
					["back", "/transactions?month=all"],
					...ids.map((id) => ["ids", String(id)]),
				])}`,
			)
		).text();
		// Every matched row is ticked, so neither link (page's or whole set's) is drawn.
		expect(reply).not.toMatch(/<a [^>]*>Select all /);
		expect(wrapperSwap(reply)).toBe("outerHTML settle:0");
		// htmx restores focus to the element with the removed link's id, and only when the link had focus. So the count
		// carries the id as a focus stop, and nothing takes focus on its own (no autofocus).
		const count = reply.match(/<span [^>]*id="select-all-link"[^>]*>/)?.[0];
		expect(count).toBeDefined();
		expect(count).toContain('tabindex="-1"');
		expect(count).not.toContain("autofocus");
		expect(reply.match(/id="select-all-link"/g)).toHaveLength(1);
		expect(setCategoryFocused(reply)).toBe(false);
	});

	it("never focuses Set category for a tick, a filter change, a plain reload or a Select all with nothing ticked", async () => {
		const ids = rowIds(await pageHtml("month=all&select=1"));
		expect(setCategoryFocused(await countFragment(ids.slice(0, 1), ids))).toBe(
			false,
		);
		expect(
			setCategoryFocused(
				await pageHtml(`month=all&select=1&ids=${ids.join(",")}`, true),
			),
		).toBe(false);
		expect(
			setCategoryFocused(
				await pageHtml("month=all&select=1&focus=set-category-selection", true),
			),
		).toBe(false);
	});

	/** The opening tag of the first element that matches. */
	const openingTag = (html: string, pattern: RegExp) =>
		html.match(pattern)?.[0] ?? "";
	/** The list's page links (Newer and Older), whole. */
	const pageLinks = (html: string) =>
		[...html.matchAll(/<a [^>]*rel="(?:prev|next)"[^>]*>/g)].map((m) => m[0]);
	const LOAD_PAUSE = {
		"hx-indicator": "#selection-form",
		"hx-disable": "#set-category-selection, #exclude-selection",
	};

	it("pauses the filters, the page links and Select all while a Select-mode list loads", async () => {
		const html = await pageHtml("month=all&page=2&select=1");
		const filters = openingTag(html, /<form[^>]*id="filters"[^>]*>/);
		expect(attribute(filters, "hx-indicator")).toBe(LOAD_PAUSE["hx-indicator"]);
		expect(attribute(filters, "hx-disable")).toBe(LOAD_PAUSE["hx-disable"]);
		const links = pageLinks(html);
		expect(links.length).toBeGreaterThan(0);
		for (const link of links) {
			expect(attribute(link, "hx-indicator")).toBe(LOAD_PAUSE["hx-indicator"]);
			expect(attribute(link, "hx-disable")).toBe(LOAD_PAUSE["hx-disable"]);
		}
		const selectAll = selectAllTag(html);
		expect(attribute(selectAll, "hx-indicator")).toBe(
			LOAD_PAUSE["hx-indicator"],
		);
		expect(attribute(selectAll, "hx-disable")).toBe(LOAD_PAUSE["hx-disable"]);
	});

	it("marks the selection form as the list's indicator, counted on the bar's count only", async () => {
		const html = await pageHtml("month=all&select=1");
		const form = openingTag(html, /<form[^>]*id="selection-form"[^>]*>/);
		expect(attribute(form, "class")).toContain("selection-list");
		expect(attribute(form, "hx-indicator")).toBe("#selected-count");
	});

	it("leaves the list's controls unpaused outside Select mode", async () => {
		const html = await pageHtml("month=all&page=2");
		const filters = openingTag(html, /<form[^>]*id="filters"[^>]*>/);
		expect(filters).not.toContain("hx-indicator");
		expect(filters).not.toContain("hx-disable");
		const links = pageLinks(html);
		expect(links.length).toBeGreaterThan(0);
		for (const link of links) {
			expect(link).not.toContain("hx-indicator");
			expect(link).not.toContain("hx-disable");
		}
		expect(html).not.toContain('class="selection-list');
	});

	it("keeps the pause on Select all in the count's out-of-band copy", async () => {
		const ids = rowIds(await pageHtml("month=all&select=1"));
		const oneOff = await countFragment(ids.slice(1), ids);
		const selectAll = selectAllTag(oneOff);
		expect(selectAll).not.toBe("");
		expect(attribute(selectAll, "hx-indicator")).toBe(
			LOAD_PAUSE["hx-indicator"],
		);
		expect(attribute(selectAll, "hx-disable")).toBe(LOAD_PAUSE["hx-disable"]);
	});

	it("asks the reply for focus on the first tick after Older or Newer, in Select mode only", async () => {
		const html = await pageHtml("month=all&page=2&select=1");
		const links = pageLinks(html);
		expect(links.length).toBeGreaterThan(0);
		for (const link of links) {
			const href = attribute(link, "href");
			expect(href).toContain("select=1");
			expect(attribute(link, "hx-get")).toBe(`${href}&focus=first-tick`);
			expect(attribute(link, "hx-push-url")).toBe(href);
		}
		const plain = await pageHtml("month=all&page=2");
		expect(plain).not.toContain("first-tick");
		for (const link of pageLinks(plain)) {
			expect(attribute(link, "hx-get")).toBe(attribute(link, "href"));
			expect(attribute(link, "hx-push-url")).toBe("true");
		}
	});

	it("gives the first row's tick autofocus in the reply to Older or Newer, and nothing else", async () => {
		const html = await pageHtml(
			"month=all&page=2&select=1&focus=first-tick",
			true,
		);
		expect(html.match(/ autofocus/g)?.length ?? 0).toBe(1);
		const tick = openingTag(html, /<input[^>]*autofocus[^>]*>/);
		expect(tick).toContain('name="ids"');
		expect(tick).toContain(`value="${rowIds(html)[0]}"`);
		const plain = await pageHtml("month=all&page=2&select=1", true);
		expect(plain).not.toContain("autofocus");
	});
	describe("ticks across pages (#350)", () => {
		/** Three rows on page 1, ticked as a person's taps leave them. */
		const pageOneTicks = async () => (await firstPageIds()).slice(0, 3);
		/** Page 2's selectable rows: none of them is on page 1, so page 1's ticks are not on this page. */
		const pageTwoRows = async () =>
			rowIds(await pageHtml("month=all&page=2&select=1"));
		const ticksParam = (ids: number[]) => ids.join(",");
		const htmxHeaders = { headers: { "HX-Request": "true" } };
		/** The form that holds the bar, its ticks and its rows: a closed disclosure's ticks are in it too. */
		const selectionForm = (html: string) => {
			const start = html.indexOf('<form id="selection-form"');
			return start < 0 ? "" : html.slice(start, html.indexOf("</form>", start));
		};
		/** The ids a link or an address carries, once each, in the order written. */
		const idsIn = (url: string) => [
			...new Set(
				new URL(url, "http://tally.test").searchParams
					.getAll("ids")
					.flatMap((value) => value.split(","))
					.filter(Boolean)
					.map(Number),
			),
		];
		const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);
		/** The ids in the no-JS hidden fields of the filter form. */
		const noscriptIds = (html: string) =>
			[
				...(html.match(/<noscript>[\s\S]*?<\/noscript>/g) ?? [])
					.join("")
					.matchAll(/name="ids" value="(\d+)"/g),
			].map((m) => Number(m[1]));

		it("keeps page 1's ticks on page 2, and the bar counts them as not on this page", async () => {
			const ids = await pageOneTicks();
			expect(ids).toHaveLength(3);
			const html = await pageHtml(
				`month=all&page=2&select=1&ids=${ticksParam(ids)}`,
				true,
			);
			expect(html).toMatch(
				/id="selected-count"[^>]*>3 selected<span class="sr-only">, 3 not on this page<\/span>/,
			);
			expect(html).toContain("3 not on this page");
			expect([...tickedIds(html)].sort()).toEqual([...ids].sort());
		});

		it("draws the off-page ticks in a closed disclosure inside the selection form, scrolling at 40% of the screen", async () => {
			const ids = await pageOneTicks();
			const form = selectionForm(
				await pageHtml(
					`month=all&page=2&select=1&ids=${ticksParam(ids)}`,
					true,
				),
			);
			expect(form).toContain('id="not-on-page"');
			expect(form).toMatch(/<details(?![^>]* open)[^>]*>/);
			expect(form).toContain("max-h-[40vh]");
			expect(form).toContain("overflow-y-auto");
			for (const id of ids) expect(form).toContain(`name="ids" value="${id}"`);
		});

		it("leaves the disclosure out once every tick is back on the list", async () => {
			const ids = await pageOneTicks();
			const html = await pageHtml(
				`month=all&select=1&ids=${ticksParam(ids)}`,
				true,
			);
			expect(html).toMatch(/id="selected-count"[^>]*>3 selected</);
			expect(html).not.toContain("not on this page");
			expect(html).not.toContain("<details");
		});

		it("counts the unticked rows out, and says how many ticks are not on this page", async () => {
			const [a, b] = (await pageOneTicks()) as [number, number];
			expect(await countFragment([a, b], [])).toContain(
				'2 selected<span class="sr-only">, 2 not on this page</span>',
			);
			expect(await countFragment([a], [])).toContain(
				'1 selected<span class="sr-only">, 1 not on this page</span>',
			);
			const onPage = await countFragment([a, b], [a, b]);
			expect(onPage).toMatch(/^2 selected</);
			expect(onPage).not.toContain('class="sr-only"');
		});

		it("takes the line away once no tick is off the page, rather than saying 0 not on this page", async () => {
			const [a, b] = (await pageOneTicks()) as [number, number];
			const onPage = await countFragment([a, b], [a, b]);
			expect(onPage).toContain(
				'<div id="not-on-page" class="empty:hidden" hx-swap-oob="outerHTML"></div>',
			);
			expect(onPage).not.toContain("not on this page");
			expect(onPage).not.toContain("<details");
		});

		it.each([
			["/transactions/select/category/save", { category: "1" }],
			["/transactions/select/exclude", {}],
		])(
			"%s changes exactly the ticks that are not on this page",
			async (path, fields) => {
				const ids = await pageOneTicks();
				await env.DB.prepare(
					`UPDATE transactions SET category_id=NULL, category_source=NULL, excluded=0, excluded_source=NULL WHERE id IN (${ids.map(() => "?").join(",")})`,
				)
					.bind(...ids)
					.run();
				const before = await snapshot();
				const res = await post(
					path,
					form(ids, { ...fields, back: "/transactions?month=all&page=2" }),
				);
				expect(res.status).toBe(200);
				const after = await snapshot();
				const changed = after
					.filter((row, i) => JSON.stringify(row) !== JSON.stringify(before[i]))
					.map((row) => row.id);
				expect(changed.sort()).toEqual([...ids].sort());
			},
		);

		it("says the ticks in words on a full page load without JavaScript, not Choose rows", async () => {
			const ids = await pageOneTicks();
			const html = await pageHtml(
				`month=all&page=2&select=1&ids=${ticksParam(ids)}`,
			);
			expect(html).toMatch(
				/id="selected-count"[^>]*>3 selected<span class="sr-only">, 3 not on this page<\/span>/,
			);
			expect(html).not.toContain("Choose rows, then an action");
		});

		it("keeps the ticks through a filter change, and counts the rows it hides as not on this page", async () => {
			const ids = await pageOneTicks();
			const html = await pageHtml(
				`month=all&select=1&q=zzz-no-such-merchant&ids=${ticksParam(ids)}`,
				true,
			);
			expect(html).toContain("No transactions match these filters.");
			expect(html).toMatch(
				/id="selected-count"[^>]*>3 selected<span class="sr-only">, 3 not on this page<\/span>/,
			);
			expect([...tickedIds(html)].sort()).toEqual([...ids].sort());
		});

		it("keeps the ticks when Set category opens, and lists the ones not on this page behind the sheet", async () => {
			const ids = await pageOneTicks();
			const res = await post(
				"/transactions/select/category",
				form(ids, { back: "/transactions?month=all&page=2" }),
			);
			const html = await res.text();
			expect(html).toContain("Set category for 3");
			expect(html).toContain("3 not on this page");
		});

		it("sends Select all's ticks and the page's rows as parameters, not in its own address", async () => {
			const ids = await pageOneTicks();
			const html = await pageHtml(
				`month=all&page=2&select=1&ids=${ticksParam(ids)}`,
				true,
			);
			const link = html.match(/<a [^>]*>Select all \d+<\/a>/)?.[0] ?? "";
			expect(link).toContain(
				'hx-include="#selection-form input[name=ids]:checked, #select-all-page input, #selection-form input[name=not-on-page-ids]"',
			);
			expect(link).toContain(
				'hx-get="/transactions?month=all&amp;page=2&amp;select=1&amp;focus=set-category-selection"',
			);
		});

		it("ticks the page's rows and keeps the ticks not on this page when Select all comes back", async () => {
			const off = await pageOneTicks();
			const pageTwo = rowIds(await pageHtml("month=all&page=2&select=1"));
			const html = await pageHtml(
				`month=all&page=2&select=1&focus=set-category-selection&ids=${ticksParam(off)}&page-ids=${pageTwo.join(",")}`,
				true,
			);
			expect(html).toMatch(
				new RegExp(
					`id="selected-count"[^>]*>${off.length + pageTwo.length} selected<span class="sr-only">, ${off.length} not on this page</span>`,
				),
			);
		});

		it("pushes the address with the ticks in it, and leaves the focus marker out", async () => {
			const ids = await pageOneTicks();
			const res = await request(
				`/transactions?month=all&page=2&select=1&focus=first-tick&ids=${ticksParam(ids)}`,
				htmxHeaders,
			);
			expect(res.headers.get("HX-Push-Url")).toBe(
				`/transactions?month=all&page=2&select=1&ids=${ticksParam(ids)}`,
			);
		});

		it("pushes no address for a plain page load", async () => {
			const res = await request("/transactions?month=all&page=2&select=1");
			expect(res.headers.get("HX-Push-Url")).toBeNull();
		});

		it("keeps the ticks on a reload, as they ride in the address", async () => {
			const ids = await pageOneTicks();
			const html = await pageHtml(
				`month=all&page=2&select=1&ids=${ticksParam(ids)}`,
			);
			expect([...tickedIds(html)].sort()).toEqual([...ids].sort());
		});

		it("drops every tick with Done, whose link carries no ticks", async () => {
			const ids = await pageOneTicks();
			const html = await pageHtml(
				`month=all&page=2&select=1&ids=${ticksParam(ids)}`,
				true,
			);
			expect(html).toMatch(
				/href="\/transactions\?month=all&amp;page=2" id="select-toggle"/,
			);
		});

		it("refuses 101 ticks in words, disables both actions, and trims nothing", async () => {
			const many = Array.from({ length: 101 }, (_, i) => 1000 + i);
			const text = await countFragment(many, []);
			expect(text).toContain("101 selected");
			expect(text).toMatch(
				/<p[^>]*role="alert"[^>]*>[\s\S]*?Select 100 or fewer transactions\.<\/p>/,
			);
			expect(text).toMatch(
				/<button(?=[^>]*id="set-category-selection")[^>]*\sdisabled(?=[\s>=])/,
			);
			expect(text).toMatch(
				/<button(?=[^>]*id="exclude-selection")[^>]*\sdisabled(?=[\s>=])/,
			);
		});

		it("allows exactly 100 ticks, with the actions on and no warning", async () => {
			const hundred = Array.from({ length: 100 }, (_, i) => 1000 + i);
			const text = await countFragment(hundred, []);
			expect(text).toContain("100 selected");
			expect(text).not.toContain("Select 100 or fewer");
			expect(text).not.toMatch(
				/<button(?=[^>]*id="set-category-selection")[^>]*\sdisabled(?=[\s>=])/,
			);
		});

		it("lists 101 real ticks without trimming any of them", async () => {
			const ids = await addHundredOneRows();
			const html = await pageHtml(
				`month=all&select=1&ids=${ticksParam(ids)}`,
				true,
			);
			expect(html).toMatch(/id="selected-count"[^>]*>101 selected/);
			expect(html).toContain("Select 100 or fewer transactions.");
			expect(tickedIds(html)).toHaveLength(101);
		});

		it("keeps all 101 ticks when a refused Exclude redraws the list", async () => {
			const ids = await addHundredOneRows();
			const res = await post(
				"/transactions/select/exclude",
				form(ids, { back: "/transactions?month=all" }),
			);
			expect(res.status).toBe(422);
			const html = await res.text();
			expect(html).toMatch(/id="selected-count"[^>]*>101 selected/);
			expect(html).toContain("Select 100 or fewer transactions.");
		});

		it("keeps all 101 ticks in a refused Set category sheet, and in its Cancel", async () => {
			const ids = await addHundredOneRows();
			const res = await post(
				"/transactions/select/category",
				form(ids, { back: "/transactions?month=all" }),
			);
			expect(res.status).toBe(422);
			const html = await res.text();
			expect(html).toMatch(/id="selected-count"[^>]*>101 selected/);
			expect(html).toMatch(
				/<a [^>]*href="[^"]*select=1&amp;ids=[^"]*"[^>]*>Cancel<\/a>/,
			);
		});

		it("replaces the address with the ticks on each count, so a reload keeps them and a tap adds no history entry", async () => {
			const ids = await pageOneTicks();
			const res = await countReply(ids, []);
			expect(res.headers.get("HX-Replace-Url")).toBe(
				`/transactions?month=all&select=1&ids=${ticksParam(ids)}`,
			);
			expect(res.headers.get("HX-Push-Url")).toBeNull();
		});

		it("replaces the address with no ticks in it once none is ticked", async () => {
			const res = await countReply([], []);
			expect(res.headers.get("HX-Replace-Url")).toBe(
				"/transactions?month=all&select=1",
			);
		});

		it("moves focus to Select all when the last tick off the page is unticked from the disclosure", async () => {
			const pageRows = await pageTwoRows();
			const text = await countFragment(pageRows.slice(0, 1), pageRows, true);
			expect(selectAllTag(text)).toContain(" autofocus");
			expect(text.match(/ autofocus/g)?.length ?? 0).toBe(1);
			expect(setCategoryFocused(text)).toBe(false);
			expect(text).not.toContain('tabindex="-1"');
		});

		it("moves focus to the count when no Select all is drawn, so focus stays in the bar", async () => {
			// The whole month is selected, so no link is left to tick anything (#321): focus stays on the count.
			const pageRows = await pageTwoRows();
			const text = await (
				await request(
					`/transactions/select/count?${new URLSearchParams([
						["page-ids", pageRows.join(",")],
						["back", "/transactions?month=all"],
						["all", "1"],
						["not-on-page", "1"],
						...pageRows.map((id) => ["ids", String(id)]),
					])}`,
				)
			).text();
			expect(selectAllTag(text)).toBe("");
			expect(text).toMatch(
				/^<span[^>]*tabindex="-1"[^>]*autofocus[^>]*>\d+ selected<\/span>/,
			);
		});

		it("sends the disclosure's marker with every count only while the not-on-page line is drawn", async () => {
			const withLine = await pageHtml(
				`month=all&page=2&select=1&ids=${ticksParam(await pageOneTicks())}`,
			);
			expect(withLine).toContain(
				'<input type="hidden" name="not-on-page" value="1"',
			);
			const withoutLine = await pageHtml("month=all&page=2&select=1");
			expect(withoutLine).not.toContain('name="not-on-page"');
		});

		it("carries the ticks in the no-JS page links and filter form, and never in the htmx requests", async () => {
			const ids = await pageOneTicks();
			const html = await pageHtml(
				`month=all&page=2&select=1&ids=${ticksParam(ids)}`,
			);
			const links = pageLinks(html);
			expect(links.length).toBeGreaterThan(0);
			for (const link of links) {
				expect(attribute(link, "href")).toContain(`ids=${ticksParam(ids)}`);
				expect(attribute(link, "hx-get")).toContain("focus=first-tick");
				expect(attribute(link, "hx-get")).not.toContain("ids=");
			}
			// Without JavaScript the filter form submits these; with it, htmx ignores a noscript block.
			const noscript = (
				html.match(/<noscript>[\s\S]*?<\/noscript>/g) ?? []
			).join("");
			for (const id of ids)
				expect(noscript).toContain(`name="ids" value="${id}"`);
		});

		it("takes no focus without the disclosure's marker, or while a tick is still off the page", async () => {
			const pageRows = await pageTwoRows();
			const plain = await countFragment(pageRows, pageRows);
			expect(plain).not.toContain("autofocus");
			expect(plain).not.toContain('tabindex="-1"');
			const offPage = await countFragment(await pageOneTicks(), pageRows, true);
			expect(offPage).toContain("3 not on this page");
			expect(offPage).not.toContain("autofocus");
		});

		it("keeps select mode and every tick in Clear filters when the filters match nothing", async () => {
			const ids = await pageOneTicks();
			const html = await pageHtml(
				`month=all&select=1&q=zzz-no-such-merchant&ids=${ticksParam(ids)}`,
			);
			expect(html).toContain("No transactions match these filters.");
			const clear = html.match(/<a [^>]*>Clear filters<\/a>/)?.[0] ?? "";
			const params = new URL(
				attribute(clear, "href") ?? "",
				"http://tally.test",
			).searchParams;
			expect(params.get("select")).toBe("1");
			expect(params.get("ids")?.split(",").map(Number)).toEqual(ids);
		});

		it("keeps the ticks not on this page in Select all's plain link, each once", async () => {
			const off = await pageOneTicks();
			const pageRows = await pageTwoRows();
			// The page's first row is ticked already, so the link must not add it twice.
			const ticked = [...off, pageRows[0] as number];
			const html = await pageHtml(
				`month=all&page=2&select=1&ids=${ticksParam(ticked)}`,
			);
			const href = selectAllHref(html) ?? "";
			const linked =
				new URL(href, "http://tally.test").searchParams
					.get("ids")
					?.split(",")
					.map(Number) ?? [];
			expect(new Set(linked).size).toBe(linked.length);
			expect([...linked].sort()).toEqual([...off, ...pageRows].sort());
			const after = await (await request(href)).text();
			expect(after).toMatch(
				new RegExp(
					`id="selected-count"[^>]*>${linked.length} selected<span class="sr-only">, ${off.length} not on this page</span>`,
				),
			);
		});

		it("says a refused Exclude over 100 once, in the bar", async () => {
			const ids = await addHundredOneRows();
			const res = await post(
				"/transactions/select/exclude",
				form(ids, { back: "/transactions?month=all" }),
			);
			expect(res.status).toBe(422);
			const html = await res.text();
			expect(html.match(/Select 100 or fewer transactions\./g)).toHaveLength(1);
			expect(html).toMatch(
				/<div id="selection-limit"[^>]*><p[^>]*role="alert"[^>]*>[\s\S]*?Select 100 or fewer transactions\.<\/p><\/div>/,
			);
		});

		it("keeps the ticks in the Add cash sheet's close link and Cancel, and in its address", async () => {
			const ids = await pageOneTicks();
			const list = await pageHtml(`month=all&select=1&ids=${ticksParam(ids)}`);
			const addCash = list.match(/<a [^>]*id="add-cash"[^>]*>/)?.[0] ?? "";
			const cashHref = attribute(addCash, "href") ?? "";
			expect(cashHref).toBe(
				`/transactions/cash/new?back=%2Ftransactions%3Fmonth%3Dall&select=1&ids=${ticksParam(ids)}`,
			);
			// With JavaScript the request carries the ticks as they are when tapped, not as drawn.
			expect(attribute(addCash, "hx-get")).toBe(
				"/transactions/cash/new?back=%2Ftransactions%3Fmonth%3Dall&select=1",
			);
			expect(attribute(addCash, "hx-include")).toBe(
				"#selection-form input[name=ids]:checked, #select-all-page input, #selection-form input[name=not-on-page-ids]",
			);
			const close = `/transactions?month=all&select=1&ids=${ticksParam(ids)}`;
			const sheetUrl = `/transactions/cash/new?${new URLSearchParams([
				["back", "/transactions?month=all"],
				["select", "1"],
				...ids.map((id) => ["ids", String(id)]),
			])}`;
			const sheet = await (await request(sheetUrl, htmxHeaders)).text();
			const backdrop = sheet.match(/<a [^>]*aria-label="Close"[^>]*>/)?.[0];
			expect(attribute(backdrop ?? "", "href")).toBe(close);
			const cancel = sheet.match(/<a [^>]*>Cancel<\/a>/)?.[0] ?? "";
			expect(attribute(cancel, "href")).toBe(close);
			// The sheet's form still returns to the plain list, and a reload of the sheet (no JavaScript) keeps the ticks.
			expect(sheet).toContain('name="back" value="/transactions?month=all"');
			const reload = await (await request(cashHref)).text();
			expect([...tickedIds(reload)].sort()).toEqual([...ids].sort());
		});

		it("keeps Select mode and the ticks when the Add cash form is refused, in its close link, Cancel and fields", async () => {
			const ids = await pageOneTicks();
			const res = await post(
				"/transactions/cash",
				form(ids, {
					amount: "0",
					date: todayIn(DEFAULT_TIME_ZONE),
					merchant: "Corner shop",
					category: "1",
					note: "",
					back: "/transactions?month=all",
					select: "1",
				}),
			);
			expect(res.status).toBe(422);
			const html = await res.text();
			expect(html).toContain("Enter an amount greater than zero.");
			expect(html).toMatch(
				new RegExp(`id="selected-count"[^>]*>${ids.length} selected`),
			);
			expect([...tickedIds(html)].sort()).toEqual([...ids].sort());
			const close = `/transactions?month=all&select=1&ids=${ticksParam(ids)}`;
			const backdrop =
				html.match(/<a [^>]*aria-label="Close"[^>]*>/)?.[0] ?? "";
			expect(attribute(backdrop, "href")).toBe(close);
			const cancel = html.match(/<a [^>]*>Cancel<\/a>/)?.[0] ?? "";
			expect(attribute(cancel, "href")).toBe(close);
			// The refused form carries Select mode and the ticks, so its next try keeps them too.
			const cashForm =
				html.match(
					/<form[^>]*action="\/transactions\/cash"[\s\S]*?<\/form>/,
				)?.[0] ?? "";
			expect(cashForm).toContain('name="select" value="1"');
			for (const id of ids)
				expect(cashForm).toContain(`name="ids" value="${id}"`);
		});

		it("counts 100 real ticks on a full page load, past a missing one and a split parent, and carries only those into the links", async () => {
			const real = (await addHundredOneRows()).slice(0, 100);
			await splitParent();
			const html = await pageHtml(
				`month=all&select=1&ids=${ticksParam([...real, 999999, 110])}`,
			);
			expect(html).toMatch(/id="selected-count"[^>]*>100 selected/);
			expect(html).not.toContain("Select 100 or fewer transactions.");
			expect(html).not.toMatch(
				/<button(?=[^>]*id="set-category-selection")[^>]*\sdisabled(?=[\s>=])/,
			);
			expect(html).not.toMatch(
				/<button(?=[^>]*id="exclude-selection")[^>]*\sdisabled(?=[\s>=])/,
			);
			const links = pageLinks(html);
			expect(links.length).toBeGreaterThan(0);
			for (const link of links)
				expect(sorted(idsIn(attribute(link, "href") ?? ""))).toEqual(
					sorted(real),
				);
			expect(sorted(noscriptIds(html))).toEqual(sorted(real));
			const addCash = html.match(/<a [^>]*id="add-cash"[^>]*>/)?.[0] ?? "";
			expect(sorted(idsIn(attribute(addCash, "href") ?? ""))).toEqual(
				sorted(real),
			);
			// Select all's address also carries this page's own rows, as it always has; no stale id is in it.
			const selectAll = idsIn(selectAllHref(html) ?? "");
			expect(selectAll).not.toContain(999999);
			expect(selectAll).not.toContain(110);
			expect(new Set(selectAll)).toEqual(new Set([...real, ...rowIds(html)]));
		});

		it("pushes only the 100 real ticks into the address on an htmx list change", async () => {
			const real = (await addHundredOneRows()).slice(0, 100);
			await splitParent();
			const res = await request(
				`/transactions?month=all&select=1&ids=${ticksParam([...real, 999999, 110])}`,
				htmxHeaders,
			);
			const pushed = res.headers.get("HX-Push-Url") ?? "";
			expect(sorted(idsIn(pushed))).toEqual(sorted(real));
			expect(pushed).not.toMatch(/focus=|page-ids=/);
		});

		it("pushes month=all with the ticks when a search is typed into an empty box in Select mode", async () => {
			const ids = await pageOneTicks();
			const res = await request(
				`/transactions?select=1&q=abc&ids=${ticksParam(ids)}`,
				{
					headers: {
						"HX-Request": "true",
						"HX-Current-URL": "http://tally.test/transactions?select=1",
					},
				},
			);
			expect(res.headers.get("HX-Push-Url")).toBe(
				`/transactions?q=abc&month=all&select=1&ids=${ticksParam(ids)}`,
			);
		});

		it("names this month in the pushed address when a month picked from an empty box is this one", async () => {
			const thisMonth = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
			const ids = await pageOneTicks();
			const res = await request(
				`/transactions?select=1&q=abc&month=${thisMonth}&ids=${ticksParam(ids)}`,
				{
					headers: {
						"HX-Request": "true",
						"HX-Current-URL": `http://tally.test/transactions?select=1&month=${thisMonth}`,
					},
				},
			);
			expect(res.headers.get("HX-Push-Url")).toBe(
				`/transactions?q=abc&month=${thisMonth}&select=1&ids=${ticksParam(ids)}`,
			);
		});

		it("acts on exactly the 100 real ticks when one of 101 posted ids is stale", async () => {
			const real = (await addHundredOneRows()).slice(0, 100);
			const before = (await snapshot()) as SnapshotRow[];
			const res = await post(
				"/transactions/select/exclude",
				form([...real, 999999], { back: "/transactions?month=all" }),
			);
			expect(res.status).toBe(200);
			const after = (await snapshot()) as SnapshotRow[];
			const changed = after
				.filter((row, i) => JSON.stringify(row) !== JSON.stringify(before[i]))
				.map((row) => row.id);
			expect(sorted(changed)).toEqual(sorted(real));
		});

		it("refuses 101 real ticks with one stale among them, says 101 selected and the limit once, in the bar", async () => {
			const real = await addHundredOneRows();
			const res = await post(
				"/transactions/select/exclude",
				form([...real, 999999], { back: "/transactions?month=all" }),
			);
			expect(res.status).toBe(422);
			const html = await res.text();
			expect(html).toMatch(/id="selected-count"[^>]*>101 selected/);
			expect(html.match(/Select 100 or fewer transactions\./g)).toHaveLength(1);
			expect(html).toMatch(
				/<div id="selection-limit"[^>]*><p[^>]*role="alert"[^>]*>[\s\S]*?Select 100 or fewer transactions\.<\/p><\/div>/,
			);
			expect(html).not.toContain('value="999999"');
		});

		it("leaves a stale tick out of Clear filters' address when the filters match nothing", async () => {
			const ids = await pageOneTicks();
			const html = await pageHtml(
				`month=all&select=1&q=zzz-no-such-merchant&ids=${ticksParam([...ids, 999999])}`,
			);
			expect(html).toContain("No transactions match these filters.");
			const clear = html.match(/<a [^>]*>Clear filters<\/a>/)?.[0] ?? "";
			expect(idsIn(attribute(clear, "href") ?? "")).toEqual(ids);
		});

		it("leaves a stale tick out of the Add cash sheet's close link and Cancel", async () => {
			const ids = await pageOneTicks();
			const sheetUrl = `/transactions/cash/new?back=${encodeURIComponent("/transactions?month=all")}&select=1&ids=${ticksParam([...ids, 999999])}`;
			const sheet = await (await request(sheetUrl, htmxHeaders)).text();
			const backdrop = sheet.match(/<a [^>]*aria-label="Close"[^>]*>/)?.[0];
			expect(idsIn(attribute(backdrop ?? "", "href") ?? "")).toEqual(ids);
			const cancel = sheet.match(/<a [^>]*>Cancel<\/a>/)?.[0] ?? "";
			expect(idsIn(attribute(cancel, "href") ?? "")).toEqual(ids);
			expect(sheet).not.toContain('value="999999"');
		});

		it("leaves a stale tick out of a refused Add cash form's fields", async () => {
			const ids = await pageOneTicks();
			const res = await post(
				"/transactions/cash",
				form([...ids, 999999], {
					amount: "0",
					date: todayIn(DEFAULT_TIME_ZONE),
					merchant: "Corner shop",
					category: "1",
					note: "",
					back: "/transactions?month=all",
					select: "1",
				}),
			);
			expect(res.status).toBe(422);
			const html = await res.text();
			expect(html).not.toContain('value="999999"');
			const cashForm =
				html.match(
					/<form[^>]*action="\/transactions\/cash"[\s\S]*?<\/form>/,
				)?.[0] ?? "";
			expect(
				sorted(
					[...cashForm.matchAll(/name="ids" value="(\d+)"/g)].map((m) =>
						Number(m[1]),
					),
				),
			).toEqual(sorted(ids));
		});
	});

	describe("select all the transactions the filters match (#321)", () => {
		/**
		 * 101 selectable rows the search "ZQ TEST BAKERY" finds, in category 2, and a split parent it finds
		 * too. Returns the 101 selectable ids.
		 */
		const seedMatches = async () => {
			await addHundredOneRows();
			await env.DB.batch([
				env.DB.prepare(
					"UPDATE transactions SET raw_name='ZQ TEST BAKERY', category_id=2, category_source='user' WHERE id BETWEEN 5001 AND 5101",
				),
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,is_split,category_id) SELECT 5200,account_id,date,-900,'ZQ TEST BAKERY',1,2 FROM transactions WHERE id=110",
				),
			]);
			return Array.from({ length: 101 }, (_, i) => 5001 + i);
		};

		it("sets every transaction the filters match, past 100, and leaves a split parent and every other row alone", async () => {
			const matched = await seedMatches();
			const before = (await snapshot()) as SnapshotRow[];
			const res = await post(
				"/transactions/select/category/save",
				new URLSearchParams({
					all: "1",
					category: "1",
					back: "/transactions?month=all&q=ZQ+TEST+BAKERY",
				}),
			);
			expect(res.status).toBe(200);
			expect(
				JSON.parse(res.headers.get("HX-Trigger") ?? "{}").toast.message,
			).toBe("Set 101 transactions to Groceries.");
			const beforeById = new Map(before.map((row) => [row.id, row]));
			for (const row of (await snapshot()) as SnapshotRow[]) {
				if (matched.includes(row.id))
					expect(row).toMatchObject({
						category_id: 1,
						category_source: "user",
					});
				else expect(row).toEqual(beforeById.get(row.id));
			}
		});

		/** The selectable rows the whole set holds with no filter: every row but a split parent. */
		const selectableTotal = async () =>
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE is_split = 0",
				).first<{ n: number }>()
			)?.n ?? 0;
		const selectableIds = async () =>
			(
				await env.DB.prepare(
					"SELECT id FROM transactions WHERE is_split = 0",
				).all<{ id: number }>()
			).results.map((row) => row.id);

		/**
		 * How many rows a Set category on these ids changes (#346): each purchase once, and a ticked refund that
		 * follows its purchase changes that purchase instead of itself, so its row is not counted.
		 */
		const changedCount = async (ids: number[]) =>
			(
				await env.DB.prepare(
					`SELECT COUNT(*) AS n FROM (
						SELECT t.id AS id FROM transactions t LEFT JOIN transactions rp ON rp.id = t.refund_of_id
						WHERE t.id IN (SELECT value FROM json_each(?1)) AND NOT ${FOLLOWS_PURCHASE}
						UNION
						SELECT rp.id AS id FROM transactions t JOIN transactions rp ON rp.id = t.refund_of_id
						WHERE t.id IN (SELECT value FROM json_each(?1)) AND ${FOLLOWS_PURCHASE}
					)`,
				)
					.bind(JSON.stringify(ids))
					.first<{ n: number }>()
			)?.n ?? 0;

		/** The count's reply for an all-mode selection on this page's rows: `ticked` are the boxes that are checked. */
		const wholeCount = async (
			pageIds: number[],
			ticked: number[],
			back: string,
		) =>
			(
				await request(
					`/transactions/select/count?${new URLSearchParams([
						["page-ids", pageIds.join(",")],
						["back", back],
						["all", "1"],
						...ticked.map((id) => ["ids", String(id)]),
					])}`,
				)
			).text();

		it("names the whole set in the link once every row on the page is ticked, with all months", async () => {
			const ids = rowIds(await pageHtml("month=all&select=1"));
			const total = await selectableTotal();
			const text = await countFragment(ids, ids);
			expect(text).toContain(`>Select all ${total} in all months</a>`);
			expect(selectAllLabel(text)).toBeUndefined();
		});

		it("names the month the filters show, not all months, when one is picked", async () => {
			const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
			const html = await pageHtml(`month=${month}&select=1`);
			const ids = rowIds(html);
			const text = await (
				await request(
					`/transactions/select/count?${new URLSearchParams([
						["page-ids", ids.join(",")],
						["back", `/transactions?month=${month}`],
						...ids.map((id) => ["ids", String(id)]),
					])}`,
				)
			).text();
			expect(text).toMatch(
				new RegExp(
					`>Select all \\d+ in ${monthLabel(month, todayIn(DEFAULT_TIME_ZONE))}</a>`,
				),
			);
		});

		it("after Select all, unticking one row leaves the rest selected, keeps the link, and an action changes those only", async () => {
			const back = "/transactions?month=all";
			const ids = rowIds(await pageHtml("month=all&select=1"));
			const [first, ...rest] = ids;
			const total = await selectableTotal();
			const counted = await wholeCount(ids, rest, back);
			expect(counted).toContain(`${total - 1} selected`);
			expect(counted).toContain(`>Select all ${total} in all months</a>`);
			// The reply's address keeps the whole set and the row that was unticked from it.
			const replaced = (
				await request(
					`/transactions/select/count?${new URLSearchParams([
						["page-ids", ids.join(",")],
						["back", back],
						["all", "1"],
						...rest.map((id) => ["ids", String(id)]),
					])}`,
				)
			).headers.get("HX-Replace-Url");
			expect(replaced).toContain("all=1");
			expect(replaced).toContain(`unticked=${first}`);

			const before = (
				await env.DB.prepare(
					"SELECT id, is_split, category_id FROM transactions",
				).all<{ id: number; is_split: number; category_id: number | null }>()
			).results;
			const firstBefore = before.find((row) => row.id === first)?.category_id;
			const res = await post(
				"/transactions/select/category/save",
				new URLSearchParams([
					["page-ids", ids.join(",")],
					["back", back],
					["all", "1"],
					["unticked", String(first)],
					["category", "1"],
					...rest.map((id) => ["ids", String(id)]),
				]),
			);
			expect(res.status).toBe(200);
			expect(
				JSON.parse(res.headers.get("HX-Trigger") ?? "{}").toast.message,
			).toBe(
				`Set ${await changedCount((await selectableIds()).filter((id) => id !== first))} transactions to Groceries.`,
			);
			const after = (
				await env.DB.prepare(
					"SELECT id, is_split, category_id FROM transactions",
				).all<{ id: number; is_split: number; category_id: number | null }>()
			).results;
			// A refund that follows its purchase keeps its own category: its purchase took the category (#346).
			const followers = new Set(
				(
					await env.DB.prepare(
						`SELECT t.id AS id FROM transactions t JOIN transactions rp ON rp.id = t.refund_of_id WHERE ${FOLLOWS_PURCHASE}`,
					).all<{ id: number }>()
				).results.map((row) => row.id),
			);
			for (const row of after) {
				if (row.id === first) expect(row.category_id).toBe(firstBefore);
				else if (followers.has(row.id))
					expect(row.category_id).toBe(
						before.find((b) => b.id === row.id)?.category_id,
					);
				else if (row.is_split === 0) expect(row.category_id).toBe(1);
			}
		});

		it("reads the whole set on the filters its address names, so a search changes the count", async () => {
			await seedMatches();
			const search = (q: string) =>
				wholeCount([], [], `/transactions?month=all&q=${q}`);
			// With no link drawn, the words sit in the count's focus stop (SelectedCount's fallback, #455).
			expect(await search("ZQ+TEST+BAKERY")).toMatch(
				/^(?:<span [^>]*>)?101 selected</,
			);
			expect(await search("zz-no-such-words-zz")).toMatch(
				/^(?:<span [^>]*>)?0 selected</,
			);
		});

		it("excludes every row the whole set holds past 100, and leaves a split parent and the rows the filters miss alone", async () => {
			const matched = await seedMatches();
			const before = (await snapshot()) as SnapshotRow[];
			const res = await post(
				"/transactions/select/exclude",
				new URLSearchParams({
					all: "1",
					back: "/transactions?month=all&q=ZQ+TEST+BAKERY",
				}),
			);
			expect(res.status).toBe(200);
			expect(
				JSON.parse(res.headers.get("HX-Trigger") ?? "{}").toast.message,
			).toBe("Excluded 101 transactions.");
			const beforeById = new Map(before.map((row) => [row.id, row]));
			for (const row of (await snapshot()) as SnapshotRow[]) {
				if (matched.includes(row.id))
					expect(row).toMatchObject({ excluded: 1, excluded_source: "user" });
				else expect(row).toEqual(beforeById.get(row.id));
			}
		});

		it("with Select all, Exclude changes only the rows the bar counts, so a matched split part is excluded on its own (P81 A)", async () => {
			await splitParent();
			await env.DB.prepare(
				"UPDATE transactions SET category_id=2, category_source='user' WHERE id=990",
			).run();
			const back = "/transactions?month=all&category=2";
			const matched = new Set(
				(
					await env.DB.prepare(
						"SELECT id FROM transactions WHERE is_split=0 AND category_id=2",
					).all<{ id: number }>()
				).results.map((row) => row.id),
			);
			const before = (await snapshot()) as SnapshotRow[];
			const counted = Number(
				(await wholeCount([], [], back)).match(
					/^(?:<span [^>]*>)?(\d+) selected/,
				)?.[1],
			);
			expect(counted).toBe(matched.size);
			const res = await post(
				"/transactions/select/exclude",
				new URLSearchParams({ all: "1", back }),
			);
			expect(res.status).toBe(200);
			expect(
				JSON.parse(res.headers.get("HX-Trigger") ?? "{}").toast.message,
			).toBe(`Excluded ${counted} transactions.`);
			const after = (await snapshot()) as SnapshotRow[];
			expect(after.find((row) => row.id === 990)).toMatchObject({
				excluded: 1,
				excluded_source: "user",
			});
			const beforeById = new Map(before.map((row) => [row.id, row]));
			for (const row of after) {
				if (matched.has(row.id)) expect(row.excluded).toBe(1);
				else expect(row).toEqual(beforeById.get(row.id));
			}
		});

		/**
		 * Select all's Exclude with one tick on split part 990 (category 1), which the category 2 search does not
		 * match: the tick is a row the filters no longer match, so it takes its whole purchase (110, 990 and 991),
		 * and each category 2 row is excluded on its own. `tick` is the form's field for that tick (#321).
		 */
		const expectWholePurchaseTick = async (tick: [string, string]) => {
			await splitParent();
			const back = "/transactions?month=all&category=2";
			const matched = new Set(
				(
					await env.DB.prepare(
						"SELECT id FROM transactions WHERE is_split=0 AND category_id=2",
					).all<{ id: number }>()
				).results.map((row) => row.id),
			);
			const before = (await snapshot()) as SnapshotRow[];
			const res = await post(
				"/transactions/select/exclude",
				new URLSearchParams([tick, ["all", "1"], ["back", back]]),
			);
			expect(res.status).toBe(200);
			expect(
				JSON.parse(res.headers.get("HX-Trigger") ?? "{}").toast.message,
			).toBe(`Excluded ${matched.size + 1} transactions.`);
			const beforeById = new Map(before.map((row) => [row.id, row]));
			for (const row of (await snapshot()) as SnapshotRow[]) {
				if (matched.has(row.id)) expect(row.excluded).toBe(1);
				else if ([110, 990, 991].includes(row.id))
					expect(row).toMatchObject({ excluded: 1, excluded_source: "user" });
				else expect(row).toEqual(beforeById.get(row.id));
			}
		};

		it("with Select all, a tick the filters no longer match excludes its whole purchase, and the matched rows each on their own (#321)", async () => {
			await expectWholePurchaseTick(["ids", "990"]);
		});

		it("with Select all, a held tick the filters no longer match is a tick again, so it excludes its whole purchase too (#321)", async () => {
			await expectWholePurchaseTick(["held", "990"]);
		});

		it("with Select all, the toast and the bill note count only the rows this Exclude excludes, not matches already excluded (#321)", async () => {
			const matched = await seedMatches();
			// Jev excluded 30 of the matches already; the bar still counts them on the default All view.
			const already = matched.slice(0, 30);
			await env.DB.prepare(
				"UPDATE transactions SET excluded=1, excluded_source='jev' WHERE id BETWEEN 5001 AND 5030",
			).run();
			// 5001 is excluded already and pays a bill; 5040 is not, and pays one. The note counts 5040 alone.
			await env.DB.batch([
				...[9800, 9801].map((id) =>
					env.DB.prepare(
						"INSERT INTO bills (id, name, amount_cents, due_day, frequency, category_id, merchant_raw_name) VALUES (?, 'Club', 1200, 1, 'monthly', 1, 'CLUB')",
					).bind(id),
				),
				...[
					[9800, 5001],
					[9801, 5040],
				].map(([bill, transaction]) =>
					env.DB.prepare(
						"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) SELECT ?1, substr(date, 1, 7), ?2, 'user', 'linked' FROM transactions WHERE id = ?2",
					).bind(bill, transaction),
				),
			]);
			const back = "/transactions?month=all&q=ZQ+TEST+BAKERY";
			expect(await wholeCount([], [], back)).toMatch(
				/^(?:<span [^>]*>)?101 selected</,
			);
			const before = (await snapshot()) as SnapshotRow[];
			const res = await post(
				"/transactions/select/exclude",
				new URLSearchParams({ all: "1", back }),
			);
			expect(res.status).toBe(200);
			const trigger = JSON.parse(res.headers.get("HX-Trigger") ?? "{}");
			expect(trigger.toast.message).toBe(
				"Excluded 71 transactions. 1 still counts while it pays a bill.",
			);
			expect(trigger.announce).toBe(trigger.toast.message);
			const beforeById = new Map(before.map((row) => [row.id, row]));
			for (const row of (await snapshot()) as SnapshotRow[]) {
				if (already.includes(row.id))
					expect(row).toEqual(beforeById.get(row.id));
				else if (matched.includes(row.id))
					expect(row).toMatchObject({ excluded: 1, excluded_source: "user" });
				else expect(row).toEqual(beforeById.get(row.id));
			}
		});

		it("opens Set category over the whole set with its all-mode fields, and titles every row it changes", async () => {
			await seedMatches();
			const res = await post(
				"/transactions/select/category",
				new URLSearchParams({
					all: "1",
					back: "/transactions?month=all&q=ZQ+TEST+BAKERY",
				}),
			);
			const html = await res.text();
			expect(html).toContain("Set category for 101");
			expect(html).toMatch(/<input type="hidden" name="all" value="1"/);
			expect(html).not.toMatch(/name="ids" value="5001"/);
		});

		it("ticks the whole set again from its link, clearing the rows unticked from it", async () => {
			const ids = rowIds(await pageHtml("month=all&select=1"));
			const [first] = ids;
			const total = await selectableTotal();
			const html = await (
				await request(
					`/transactions?month=all&select=1&all=1&focus=set-category-selection&unticked=${first}`,
					{ headers: { "HX-Request": "true" } },
				)
			).text();
			expect(html).toContain(`${total} selected`);
			expect(tickedIds(html)).toContain(first);
			expect(html).not.toMatch(/>Select all \d+ in all months<\/a>/);
		});

		it("follows the month the address names, so a month with no rows has nothing to select", async () => {
			await seedMatches();
			const text = await wholeCount([], [], "/transactions?month=2000-01");
			expect(text).toMatch(/^(?:<span [^>]*>)?0 selected/);
			expect(text).not.toContain("Select all");
		});

		/**
		 * The 101 matches dated long ago, so the newest rows (the page Select all draws) are not the search's
		 * matches. The seed's rows follow today's date, and these would otherwise sort to the top.
		 */
		const seedOldMatches = async () => {
			const matched = await seedMatches();
			await env.DB.prepare(
				"UPDATE transactions SET date = '2000-01-01' WHERE id BETWEEN 5001 AND 5101",
			).run();
			return matched;
		};

		it("after Select all, a search selects what its filters match, not the rows the old page drew, and the save changes only those", async () => {
			const matched = await seedOldMatches();
			const old = rowIds(await pageHtml("month=all&select=1"));
			const search = "/transactions?month=all&q=ZQ+TEST+BAKERY";
			// The fields a filter change posts: the old page's boxes, all of them checked, and the old page's ids.
			const fields: [string, string][] = [
				["page-ids", old.join(",")],
				["all", "1"],
				...old.map((id): [string, string] => ["ids", String(id)]),
			];
			const list = await (
				await request(`${search}&select=1&${new URLSearchParams(fields)}`, {
					headers: { "HX-Request": "true" },
				})
			).text();
			expect(list).toContain("101 selected");
			expect(list).not.toContain("not on this page");
			const counted = await (
				await request(
					`/transactions/select/count?${new URLSearchParams([["back", search], ...fields])}`,
				)
			).text();
			expect(counted).toContain("101 selected");
			expect(counted).not.toContain("not on this page");
			const before = (await snapshot()) as SnapshotRow[];
			const res = await post(
				"/transactions/select/category/save",
				new URLSearchParams([["back", search], ["category", "1"], ...fields]),
			);
			expect(res.status).toBe(200);
			expect(
				JSON.parse(res.headers.get("HX-Trigger") ?? "{}").toast.message,
			).toBe("Set 101 transactions to Groceries.");
			const beforeById = new Map(before.map((row) => [row.id, row]));
			for (const row of (await snapshot()) as SnapshotRow[]) {
				if (matched.includes(row.id))
					expect(row).toMatchObject({
						category_id: 1,
						category_source: "user",
					});
				else expect(row).toEqual(beforeById.get(row.id));
			}
		});

		it("after Select all, keeps a tick the new filters hide on the not-on-this-page line, and counts none of the old page's boxes", async () => {
			await seedOldMatches();
			const old = rowIds(await pageHtml("month=all&select=1"));
			// A row the search doesn't match and the old page doesn't show: a tick made before the filters changed.
			const hidden = await env.DB.prepare(
				`SELECT id FROM transactions WHERE is_split = 0 AND id < 5000 AND id NOT IN (${old.map(() => "?").join(",")}) ORDER BY id LIMIT 1`,
			)
				.bind(...old)
				.first<{ id: number }>();
			expect(hidden).not.toBeNull();
			const counted = await (
				await request(
					`/transactions/select/count?${new URLSearchParams([
						["back", "/transactions?month=all&q=ZQ+TEST+BAKERY"],
						["page-ids", old.join(",")],
						["all", "1"],
						...old.map((id) => ["ids", String(id)]),
						["ids", String(hidden?.id)],
					])}`,
				)
			).text();
			expect(counted).toContain("102 selected");
			expect(counted).toContain("1 not on this page");
		});

		/** A selectable row the old page doesn't draw and the ZQ search doesn't match: a tick made before the filters change. */
		const hiddenRow = async (old: number[]) => {
			const row = await env.DB.prepare(
				`SELECT id FROM transactions WHERE is_split = 0 AND id < 5000 AND id NOT IN (${old.map(() => "?").join(",")}) ORDER BY id LIMIT 1`,
			)
				.bind(...old)
				.first<{ id: number }>();
			if (!row) throw new Error("no selectable row off the old page");
			return row.id;
		};

		it("a tick made before Select all is held by the whole set, and the whole-set link keeps it (#350)", async () => {
			await seedOldMatches();
			const old = rowIds(await pageHtml("month=all&select=1"));
			const x = await hiddenRow(old);
			const total = await selectableTotal();
			const reply = await request(
				`/transactions?${new URLSearchParams([
					["month", "all"],
					["select", "1"],
					["all", "1"],
					["focus", "set-category-selection"],
					["page-ids", old.join(",")],
					...[...old, x].map((id): [string, string] => ["ids", String(id)]),
				])}`,
				{ headers: { "HX-Request": "true" } },
			);
			const html = await reply.text();
			expect(html).toContain(`${total} selected`);
			expect(html).not.toContain("not on this page");
			const bar =
				html.match(/<span id="select-all-page"[\s\S]*?<\/span>/)?.[0] ?? "";
			expect(bar).toContain(`<input type="hidden" name="held" value="${x}"`);
			const pushed =
				new URL(
					reply.headers.get("HX-Push-Url") ?? "",
					"http://tally.test",
				).searchParams
					.get("ids")
					?.split(",")
					.map(Number) ?? [];
			expect(pushed).toContain(x);
		});

		it("a search after Select all keeps a held tick as a tick, off this page, until it is unticked or acted on (#350)", async () => {
			await seedOldMatches();
			const old = rowIds(await pageHtml("month=all&select=1"));
			const x = await hiddenRow(old);
			// The fields a search change posts: the old page's boxes, all of them checked, and the held tick.
			const fields: [string, string][] = [
				["page-ids", old.join(",")],
				["all", "1"],
				...old.map((id): [string, string] => ["ids", String(id)]),
				["held", String(x)],
			];
			const list = await (
				await request(
					`/transactions?month=all&q=ZQ+TEST+BAKERY&select=1&${new URLSearchParams(fields)}`,
					{ headers: { "HX-Request": "true" } },
				)
			).text();
			expect(list).toContain("102 selected");
			expect(list).toContain("1 not on this page");
			expect(tickedIds(list)).toContain(x);
			const count = await request(
				`/transactions/select/count?${new URLSearchParams([["back", "/transactions?month=all&q=ZQ+TEST+BAKERY"], ...fields])}`,
			);
			const counted = await count.text();
			expect(counted).toContain("102 selected");
			expect(counted).toContain("1 not on this page");
			const replaced =
				new URL(
					count.headers.get("HX-Replace-Url") ?? "",
					"http://tally.test",
				).searchParams
					.get("ids")
					?.split(",")
					.map(Number) ?? [];
			expect(replaced).toContain(x);
			await env.DB.prepare(
				"UPDATE transactions SET category_id=2, category_source='user' WHERE id=?",
			)
				.bind(x)
				.run();
			const res = await post(
				"/transactions/select/category/save",
				new URLSearchParams([
					["back", "/transactions?month=all&q=ZQ+TEST+BAKERY"],
					["category", "1"],
					...fields,
				]),
			);
			expect(res.status).toBe(200);
			expect(
				JSON.parse(res.headers.get("HX-Trigger") ?? "{}").toast.message,
			).toBe("Set 102 transactions to Groceries.");
			expect(
				await env.DB.prepare("SELECT category_id FROM transactions WHERE id=?")
					.bind(x)
					.first(),
			).toEqual({ category_id: 1 });
		});

		it("unticking a held tick ends it: the count leaves it out, and the search after it does not bring it back (#350)", async () => {
			await seedOldMatches();
			const old = rowIds(await pageHtml("month=all&select=1"));
			const x = await hiddenRow(old);
			const total = await selectableTotal();
			// X is on the page, but its box is not posted: it was unticked. The held field still says it was held.
			const pageIds = [...old, x];
			const count = await request(
				`/transactions/select/count?${new URLSearchParams([
					["page-ids", pageIds.join(",")],
					["back", "/transactions?month=all"],
					["all", "1"],
					...old.map((id): [string, string] => ["ids", String(id)]),
					["held", String(x)],
				])}`,
			);
			expect(await count.text()).toContain(`${total - 1} selected`);
			const replaced = count.headers.get("HX-Replace-Url") ?? "";
			expect(replaced).toContain(`unticked=${x}`);
			expect(
				new URL(replaced, "http://tally.test").searchParams
					.get("ids")
					?.split(",")
					.map(Number) ?? [],
			).not.toContain(x);
			// The search change carries what the reply left in the form: the unticked row, and no held one.
			const listed = await (
				await request(
					`/transactions?month=all&q=ZQ+TEST+BAKERY&select=1&${new URLSearchParams(
						[
							["page-ids", pageIds.join(",")],
							["all", "1"],
							["unticked", String(x)],
							...old.map((id): [string, string] => ["ids", String(id)]),
						],
					)}`,
					{ headers: { "HX-Request": "true" } },
				)
			).text();
			expect(listed).toContain("101 selected");
			expect(listed).not.toContain("not on this page");
			expect(tickedIds(listed)).not.toContain(x);
		});

		it("a reload of the address Select all pushed keeps the held tick, once a search is added to it (#350)", async () => {
			await seedOldMatches();
			const old = rowIds(await pageHtml("month=all&select=1"));
			const x = await hiddenRow(old);
			const reply = await request(
				`/transactions?${new URLSearchParams([
					["month", "all"],
					["select", "1"],
					["all", "1"],
					["focus", "set-category-selection"],
					["page-ids", old.join(",")],
					...[...old, x].map((id): [string, string] => ["ids", String(id)]),
				])}`,
				{ headers: { "HX-Request": "true" } },
			);
			const pushed = new URL(
				reply.headers.get("HX-Push-Url") ?? "",
				"http://tally.test",
			);
			pushed.searchParams.set("q", "ZQ TEST BAKERY");
			const html = await (
				await request(`${pushed.pathname}${pushed.search}`)
			).text();
			expect(html).toContain("102 selected");
			expect(html).toContain("1 not on this page");
		});

		/** The rows the page's hidden page-ids field names: the rows the list drew (SelectAllOnPage). */
		const pageIdsOf = (html: string) =>
			(html.match(/name="page-ids" value="([\d,]*)"/)?.[1] ?? "")
				.split(",")
				.filter(Boolean)
				.map(Number);

		it("unticking a tick on the not-on-this-page line, after a search narrows the filters, ends it: clearing the search leaves it out, and the save changes only the rest (#321)", async () => {
			await seedOldMatches();
			const old = rowIds(await pageHtml("month=all&select=1"));
			const x = await hiddenRow(old);
			const total = await selectableTotal();
			const search = "/transactions?month=all&q=ZQ+TEST+BAKERY";
			await env.DB.prepare(
				"UPDATE transactions SET category_id=2, category_source='user' WHERE id=?",
			)
				.bind(x)
				.run();
			// The search after Select all: the held tick is off its rows, so it is drawn on the line, ticked.
			const narrowed = await (
				await request(
					`${search}&select=1&${new URLSearchParams([
						["page-ids", old.join(",")],
						["all", "1"],
						...old.map((id): [string, string] => ["ids", String(id)]),
						["held", String(x)],
					])}`,
					{ headers: { "HX-Request": "true" } },
				)
			).text();
			expect(narrowed).toContain("102 selected");
			expect(narrowed).toContain(`name="not-on-page-ids" value="${x}"`);
			// The row's box is unticked on the line: the line still lists it, but its box posts nothing.
			const zq = pageIdsOf(narrowed);
			const count = await request(
				`/transactions/select/count?${new URLSearchParams([
					["back", search],
					["page-ids", zq.join(",")],
					["all", "1"],
					["not-on-page", "1"],
					["not-on-page-ids", String(x)],
					...zq.map((id): [string, string] => ["ids", String(id)]),
				])}`,
			);
			const counted = await count.text();
			expect(counted).toContain("101 selected");
			expect(counted).not.toContain("not on this page");
			const replaced = count.headers.get("HX-Replace-Url") ?? "";
			expect(replaced).toContain(`unticked=${x}`);
			expect(
				new URL(replaced, "http://tally.test").searchParams
					.get("ids")
					?.split(",")
					.map(Number) ?? [],
			).not.toContain(x);
			expect(counted).toContain(`name="unticked" value="${x}"`);
			// Clearing the search carries what the reply left in the form: the unticked row, which stays out.
			const cleared = await (
				await request(
					`/transactions?month=all&select=1&${new URLSearchParams([
						["page-ids", zq.join(",")],
						["all", "1"],
						["unticked", String(x)],
						...zq.map((id): [string, string] => ["ids", String(id)]),
					])}`,
					{ headers: { "HX-Request": "true" } },
				)
			).text();
			expect(cleared).toContain(`${total - 1} selected`);
			expect(cleared).not.toContain("not on this page");
			expect(tickedIds(cleared)).not.toContain(x);
			const res = await post(
				"/transactions/select/category/save",
				new URLSearchParams([
					["page-ids", zq.join(",")],
					["back", "/transactions?month=all"],
					["all", "1"],
					["unticked", String(x)],
					["category", "1"],
					...zq.map((id): [string, string] => ["ids", String(id)]),
				]),
			);
			expect(res.status).toBe(200);
			expect(
				JSON.parse(res.headers.get("HX-Trigger") ?? "{}").toast.message,
			).toBe(
				`Set ${await changedCount((await selectableIds()).filter((id) => id !== x))} transactions to Groceries.`,
			);
			expect(
				await env.DB.prepare("SELECT category_id FROM transactions WHERE id=?")
					.bind(x)
					.first(),
			).toEqual({ category_id: 2 });
		});

		it("a search change that carries an untick on the not-on-this-page line keeps the row unticked in the address it pushes (#321)", async () => {
			await seedOldMatches();
			const old = rowIds(await pageHtml("month=all&select=1"));
			const x = await hiddenRow(old);
			const zq = pageIdsOf(
				await (
					await request(
						`/transactions?month=all&q=ZQ+TEST+BAKERY&select=1&${new URLSearchParams(
							[
								["page-ids", old.join(",")],
								["all", "1"],
								...old.map((id): [string, string] => ["ids", String(id)]),
								["held", String(x)],
							],
						)}`,
						{ headers: { "HX-Request": "true" } },
					)
				).text(),
			);
			const listed = await request(
				`/transactions?month=all&q=ZQ+TEST+BAKERY&select=1&${new URLSearchParams(
					[
						["page-ids", zq.join(",")],
						["all", "1"],
						["not-on-page", "1"],
						["not-on-page-ids", String(x)],
						...zq.map((id): [string, string] => ["ids", String(id)]),
					],
				)}`,
				{ headers: { "HX-Request": "true" } },
			);
			const html = await listed.text();
			expect(html).toContain("101 selected");
			expect(html).not.toContain("not on this page");
			expect(listed.headers.get("HX-Push-Url") ?? "").toContain(
				`unticked=${x}`,
			);
		});

		describe("a Select all list keeps the month on screen once the month turns over (#321)", () => {
			beforeEach(async () => {
				const rows: [number, string][] = [
					[5301, "2026-10-05"],
					[5302, "2026-10-20"],
					[5303, "2026-11-02"],
				];
				await env.DB.batch(
					rows.map(([id, date]) =>
						env.DB.prepare(
							"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id) SELECT ?1,account_id,?2,1200,'ZQ TURNOVER',2 FROM transactions WHERE id=110",
						).bind(id, date),
					),
				);
			});

			afterEach(() => {
				vi.useRealTimers();
			});

			/** Sets the clock. Only Date is faked, as in household-today.test.ts. */
			const atInstant = (instant: string) => {
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.setSystemTime(new Date(instant));
			};
			const OCTOBER = "2026-10-31T16:00:00Z";
			const NOVEMBER = "2026-11-01T16:00:00Z";

			/** The bar's back, as the Select all list on the TURNOVER search draws its hidden field. */
			const barBack = async () => {
				const html = await (
					await request("/transactions?q=ZQ+TURNOVER&select=1&all=1")
				).text();
				return (
					attribute(
						html.match(/<input[^>]*id="selection-back"[^>]*>/)?.[0] ?? "",
						"value",
					) ?? ""
				);
			};
			/** The month an address names, or null when it names none. */
			const monthOf = (address: string) =>
				new URL(address, "http://tally.test").searchParams.get("month");
			/** The back an Add cash address carries: the list the sheet returns to. */
			const backOf = (address: string) =>
				new URL(address, "http://tally.test").searchParams.get("back") ?? "";
			/** The Add cash link on the TURNOVER Select all list, as drawn at the moment. */
			const addCashTag = async () =>
				(
					await (
						await request("/transactions?q=ZQ+TURNOVER&select=1&all=1")
					).text()
				).match(/<a [^>]*id="add-cash"[^>]*>/)?.[0] ?? "";

			it("names the month on screen in the bar's back, even when that is this month", async () => {
				atInstant(OCTOBER);
				expect(monthOf(await barBack())).toBe("2026-10");
			});

			it("counts the month on screen on the next month", async () => {
				atInstant(OCTOBER);
				const back = await barBack();
				atInstant(NOVEMBER);
				const counted = await (
					await request(
						`/transactions/select/count?${new URLSearchParams([
							["back", back],
							["all", "1"],
						])}`,
					)
				).text();
				expect(counted).toContain("2 selected");
			});

			it("excludes the month on screen on the next month, and pushes an address that names it", async () => {
				atInstant(OCTOBER);
				const back = await barBack();
				atInstant(NOVEMBER);
				const res = await post(
					"/transactions/select/exclude",
					new URLSearchParams({ all: "1", back }),
				);
				expect(res.status).toBe(200);
				expect(
					JSON.parse(res.headers.get("HX-Trigger") ?? "{}").toast.message,
				).toBe("Excluded 2 transactions.");
				expect(monthOf(res.headers.get("HX-Push-Url") ?? "")).toBe("2026-10");
				const rows = await env.DB.prepare(
					"SELECT id, excluded FROM transactions WHERE raw_name = 'ZQ TURNOVER' ORDER BY id",
				).all<{ id: number; excluded: number }>();
				expect(rows.results).toEqual([
					{ id: 5301, excluded: 1 },
					{ id: 5302, excluded: 1 },
					{ id: 5303, excluded: 0 },
				]);
			});

			it("sets the category of the month on screen on the next month, and pushes an address that names it", async () => {
				atInstant(OCTOBER);
				const back = await barBack();
				atInstant(NOVEMBER);
				const res = await post(
					"/transactions/select/category/save",
					new URLSearchParams({ all: "1", back, category: "1" }),
				);
				expect(res.status).toBe(200);
				expect(
					JSON.parse(res.headers.get("HX-Trigger") ?? "{}").toast.message,
				).toBe("Set 2 transactions to Groceries.");
				expect(monthOf(res.headers.get("HX-Push-Url") ?? "")).toBe("2026-10");
				const rows = await env.DB.prepare(
					"SELECT id, category_id FROM transactions WHERE raw_name = 'ZQ TURNOVER' ORDER BY id",
				).all<{ id: number; category_id: number }>();
				expect(rows.results).toEqual([
					{ id: 5301, category_id: 1 },
					{ id: 5302, category_id: 1 },
					{ id: 5303, category_id: 2 },
				]);
			});

			it("pushes no month for an Exclude in the month on screen, as the address was before", async () => {
				atInstant(OCTOBER);
				const res = await post(
					"/transactions/select/exclude",
					new URLSearchParams({
						all: "1",
						back: "/transactions?q=ZQ+TURNOVER&month=2026-10",
					}),
				);
				expect(res.headers.get("HX-Push-Url")).toBe(
					"/transactions?q=ZQ+TURNOVER",
				);
			});

			it("names the month on screen in the Add cash link's back, in its href and hx-get, and keeps all", async () => {
				atInstant(OCTOBER);
				const link = await addCashTag();
				const href = attribute(link, "href") ?? "";
				expect(monthOf(backOf(href))).toBe("2026-10");
				expect(new URL(href, "http://tally.test").searchParams.get("all")).toBe(
					"1",
				);
				expect(monthOf(backOf(attribute(link, "hx-get") ?? ""))).toBe(
					"2026-10",
				);
			});

			it("keeps the month on screen in the Add cash sheet on the next month, in its close link, Cancel and back field", async () => {
				atInstant(OCTOBER);
				const href = attribute(await addCashTag(), "href") ?? "";
				atInstant(NOVEMBER);
				const sheet = await (
					await request(href, { headers: { "HX-Request": "true" } })
				).text();
				const backdrop = sheet.match(/<a [^>]*aria-label="Close"[^>]*>/)?.[0];
				const cancel = sheet.match(/<a [^>]*>Cancel<\/a>/)?.[0] ?? "";
				for (const link of [backdrop ?? "", cancel]) {
					const address = attribute(link, "href") ?? "";
					expect(monthOf(address)).toBe("2026-10");
					expect(
						new URL(address, "http://tally.test").searchParams.get("all"),
					).toBe("1");
				}
				const backField = attribute(
					sheet.match(/<input[^>]*name="back"[^>]*>/)?.[0] ?? "",
					"value",
				);
				expect(backField).toBe(backOf(href));
				expect(monthOf(backField ?? "")).toBe("2026-10");
			});

			it("keeps the month on screen when the Add cash form is refused on the next month, in its close link, Cancel and back field", async () => {
				atInstant(OCTOBER);
				const back = backOf(attribute(await addCashTag(), "href") ?? "");
				atInstant(NOVEMBER);
				const res = await post(
					"/transactions/cash",
					new URLSearchParams({
						amount: "0",
						date: "2026-11-01",
						merchant: "Corner shop",
						category: "1",
						note: "",
						back,
						select: "1",
						all: "1",
					}),
				);
				expect(res.status).toBe(422);
				const html = await res.text();
				const backdrop = html.match(/<a [^>]*aria-label="Close"[^>]*>/)?.[0];
				const cancel = html.match(/<a [^>]*>Cancel<\/a>/)?.[0] ?? "";
				for (const link of [backdrop ?? "", cancel]) {
					const address = attribute(link, "href") ?? "";
					expect(monthOf(address)).toBe("2026-10");
					expect(
						new URL(address, "http://tally.test").searchParams.get("all"),
					).toBe("1");
				}
				expect(
					attribute(
						html.match(/<input[^>]*name="back"[^>]*>/)?.[0] ?? "",
						"value",
					),
				).toBe(back);
			});

			it("pushes the list's address, with no month, for a saved Add cash on the month on screen", async () => {
				atInstant(OCTOBER);
				const res = await post(
					"/transactions/cash",
					new URLSearchParams({
						amount: "12.00",
						date: "2026-10-31",
						merchant: "Turnover cafe",
						category: "1",
						note: "",
						back: "/transactions?q=ZQ+TURNOVER&month=2026-10",
						select: "1",
						all: "1",
					}),
				);
				expect(res.status).toBe(200);
				expect(res.headers.get("HX-Push-Url")).toBe(
					"/transactions?q=ZQ+TURNOVER",
				);
			});
		});
	});
});
