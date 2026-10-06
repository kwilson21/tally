import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

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
		const ids = Array.from({ length: 101 }, (_, i) => 1000 + i);
		ids[0] = 111;
		const before = await snapshot();
		const res = await post(
			path,
			form(ids, { back: "/transactions", ...extra }),
		);
		expect(res.status).toBe(422);
		expect(await res.text()).toMatch(
			/role="alert"[^>]*>Select 100 or fewer transactions\./,
		);
		expect(await snapshot()).toEqual(before);
	});
});
