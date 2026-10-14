import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

// Every sheet's close (its backdrop, Cancel and, through the backdrop, Escape) returns focus to whatever
// opened it (#87, decision 109). Without JavaScript the close is a plain link, so the page it lands on
// puts focus there with autofocus: the list takes ?focus=, as Home's and the edit panel's do.

const BASE = "http://tally.test";

async function get(path: string, headers: Record<string, string> = {}) {
	const res = await exports.default.fetch(BASE + path, { headers });
	return res.text();
}

async function post(path: string, fields: URLSearchParams) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"HX-Request": "true",
			Origin: BASE,
		},
		body: fields,
	});
	return res.text();
}

/** The address of a sheet's backdrop link, decoded from the attribute. */
function backdropHref(html: string) {
	const href =
		html.match(
			/<a href="([^"]*)" aria-label="Close"[^>]*data-sheet-close/,
		)?.[1] ?? "";
	return href.replaceAll("&amp;", "&");
}

/** The opening tag of the element with this id, so a test can read its attributes. */
function tagWithId(html: string, id: string) {
	return html.match(new RegExp(`<[a-z]+ [^>]*\\bid="${id}"[^>]*>`))?.[0] ?? "";
}

beforeEach(async () => resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE)));

describe("Add cash: its close returns focus to Add cash", () => {
	it("closes to the list with ?focus=add-cash", async () => {
		const html = await get("/transactions/cash/new?back=%2Ftransactions");
		expect(backdropHref(html)).toBe("/transactions?focus=add-cash");
	});

	it("puts focus on Add cash when the list is drawn with that focus", async () => {
		const html = await get("/transactions?focus=add-cash");
		expect(tagWithId(html, "add-cash")).toContain("autofocus");
		expect(tagWithId(await get("/transactions"), "add-cash")).not.toContain(
			"autofocus",
		);
	});
});

describe("Split: its close returns focus to the transaction's row", () => {
	it("closes, and Cancels, to that row", async () => {
		const html = await get("/transactions/110/split?back=%2Ftransactions");
		expect(backdropHref(html)).toBe("/transactions?focus=110");
		expect(html.split('href="/transactions?focus=110"').length - 1).toBe(2);
	});
});

describe("Set category in Select mode: its close returns focus to Set category", () => {
	it("closes, and Cancels, with the ticks and ?focus=set-category-back", async () => {
		const list = await get("/transactions?month=all&select=1");
		const [a, b] = [...list.matchAll(/name="ids" value="(\d+)"/g)]
			.slice(0, 2)
			.map((m) => Number(m[1]));
		const body = new URLSearchParams({ back: "/transactions?month=all" });
		body.append("ids", String(a));
		body.append("ids", String(b));
		const html = await post("/transactions/select/category", body);
		expect(backdropHref(html)).toBe(
			`/transactions?month=all&select=1&ids=${a},${b}&focus=set-category-back`,
		);
	});

	it("puts focus on Set category when the list is drawn with that focus and ticks", async () => {
		const list = await get("/transactions?month=all&select=1");
		const [a, b] = [...list.matchAll(/name="ids" value="(\d+)"/g)]
			.slice(0, 2)
			.map((m) => Number(m[1]));
		const html = await get(
			`/transactions?month=all&select=1&ids=${a},${b}&focus=set-category-back`,
		);
		expect(tagWithId(html, "set-category-selection")).toContain("autofocus");
	});
});

describe("Bills: a sheet's close returns focus to its bill, or to Add a bill", () => {
	it("closes a new bill's sheet to Add a bill", async () => {
		const html = await get("/bills/new");
		expect(backdropHref(html)).toBe("/bills?focus=add-bill");
	});

	it("puts focus on Add a bill when the list is drawn with that focus", async () => {
		const html = await get("/bills?focus=add-bill");
		expect(tagWithId(html, "add-bill")).toContain("autofocus");
	});

	it("closes a bill's sheet to that bill's row, and puts focus on the row", async () => {
		const list = await get("/bills");
		const id = list.match(/href="\/bills\/(\d+)"/)?.[1] ?? "";
		expect(id).not.toBe("");
		const sheet = await get(`/bills/${id}/edit`);
		expect(backdropHref(sheet)).toBe(`/bills?focus=${id}`);
		const drawn = await get(`/bills?focus=${id}`);
		expect(
			drawn.match(new RegExp(`<a [^>]*href="/bills/${id}"[^>]*>`))?.[0],
		).toContain("autofocus");
	});
});

describe("the edit panel: its close returns focus to the transaction's row", () => {
	it("closes, and Cancels, to that row", async () => {
		const html = await get("/transactions/110");
		expect(backdropHref(html)).toBe("/transactions?focus=110");
		expect(html.split('href="/transactions?focus=110"').length - 1).toBe(2);
	});

	it("keeps the list's filters, and joins focus to them with &", async () => {
		const html = await get("/transactions/110?uncategorized=1");
		expect(backdropHref(html)).toBe("/transactions?uncategorized=1&focus=110");
		expect(
			html.split('href="/transactions?uncategorized=1&amp;focus=110"').length -
				1,
		).toBe(2);
	});
});

describe("Budget: its close returns focus to the category's row on Home", () => {
	it("closes, and Cancels, to that row", async () => {
		const html = await get("/budget/1");
		expect(backdropHref(html)).toBe("/?focus=1");
		expect(html.split('href="/?focus=1"').length - 1).toBe(2);
	});

	it("does the same when the amount is refused and the sheet is drawn again", async () => {
		const html = await post(
			"/budget/1",
			new URLSearchParams({ budget: "abc" }),
		);
		expect(backdropHref(html)).toBe("/?focus=1");
		expect(html.split('href="/?focus=1"').length - 1).toBe(2);
	});
});

describe("Savings goal: its close returns focus to the Savings row on Home", () => {
	it("closes, and Cancels, to the Savings row", async () => {
		const html = await get("/savings-goal");
		expect(backdropHref(html)).toBe("/?focus=savings-goal");
		expect(html.split('href="/?focus=savings-goal"').length - 1).toBe(2);
	});

	it("does the same when the amount is refused and the sheet is drawn again", async () => {
		const html = await post(
			"/savings-goal",
			new URLSearchParams({ goal: "abc" }),
		);
		expect(backdropHref(html)).toBe("/?focus=savings-goal");
		expect(html.split('href="/?focus=savings-goal"').length - 1).toBe(2);
	});

	it("puts focus on the Savings row when Home is drawn with that focus, without JavaScript too", async () => {
		const drawn = await get("/?focus=savings-goal");
		const rows = drawn.match(/<a [^>]*href="\/savings-goal"[^>]*>/g) ?? [];
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(row).toContain("autofocus");
	});
});
