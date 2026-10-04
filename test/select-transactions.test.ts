import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const request = async (path: string, init?: RequestInit) => {
	const headers = new Headers(init?.headers);
	if (init?.method === "POST") headers.set("Origin", "http://tally.test");
	return exports.default.fetch(`http://tally.test${path}`, {
		...init,
		headers,
	});
};

beforeEach(async () => resetDemo(env.DB, todayUtc()));

describe("select several transactions", () => {
	it("keeps every list parameter in Select and Done drops only select", async () => {
		const html = await (
			await request("/transactions?month=all&q=shop&page=2&select=1")
		).text();
		expect(html).toContain(
			'href="/transactions?month=all&amp;q=shop&amp;page=2"',
		);
		const normal = await (
			await request("/transactions?month=all&q=shop&page=2")
		).text();
		expect(normal).toContain(
			'href="/transactions?month=all&amp;q=shop&amp;page=2&amp;select=1"',
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
			before.match(/(\d+) transactions need a category/)?.[1],
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
		expect(after).toContain(`${count - 1} transactions need a category`);
	});
});
