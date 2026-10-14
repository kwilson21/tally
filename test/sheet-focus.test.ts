import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadBillSuggestions } from "../src/bills/find";
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

/** A save as the Bills sheet sends it, returning the response itself so its headers can be read. */
async function postResponse(
	path: string,
	fields: URLSearchParams,
	htmx = true,
) {
	return exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...(htmx ? { "HX-Request": "true" } : {}),
			Origin: BASE,
		},
		body: fields,
	});
}

/** A valid bill form, as bills.test.ts posts one: the sheet's own fields, under the given name. */
function billFields(name: string) {
	return new URLSearchParams({
		name,
		amount: "3.99",
		due_day: "4",
		frequency: "monthly",
		anchor_month: "1",
		category_id: "5",
		merchant_raw_name: "APPLE.COM/BILL",
	});
}

/** The address of a sheet's backdrop link, decoded from the attribute. */
function backdropHref(html: string) {
	const href =
		html.match(
			/<a href="([^"]*)" aria-label="Close"[^>]*data-sheet-close/,
		)?.[1] ?? "";
	return href.replaceAll("&amp;", "&");
}

/** The id of the first bill on the Bills list. */
async function firstBillId() {
	const list = await get("/bills");
	const id = list.match(/href="\/bills\/(\d+)"/)?.[1] ?? "";
	expect(id).not.toBe("");
	return id;
}

/** The opening tag of the Add link for a possible bill, found by the finding it carries. */
function addLinkFor(html: string, rawName: string) {
	const finding = new URLSearchParams({ finding: rawName }).toString();
	return (
		(html.match(/<a [^>]*>/g) ?? []).find(
			(tag) => tag.includes("/bills/new?") && tag.includes(finding),
		) ?? ""
	);
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

	it("closes an edit sheet, from its backdrop and from Cancel, to its bill's page, with focus on Edit bill", async () => {
		const id = await firstBillId();
		const sheet = await get(`/bills/${id}/edit`);
		expect(backdropHref(sheet)).toBe(`/bills/${id}?focus=edit-bill`);
		expect(sheet.split(`href="/bills/${id}?focus=edit-bill"`).length - 1).toBe(
			2,
		);
	});

	it("keeps that close when the edit sheet is drawn again with a field's error", async () => {
		const id = await firstBillId();
		const html = await post(`/bills/${id}`, new URLSearchParams({ name: "" }));
		expect(html).toContain("Enter a name.");
		expect(backdropHref(html)).toBe(`/bills/${id}?focus=edit-bill`);
	});

	it("puts focus on Edit bill when the bill's page is drawn with that focus, and not otherwise", async () => {
		const id = await firstBillId();
		expect(
			tagWithId(await get(`/bills/${id}?focus=edit-bill`), "edit-bill"),
		).toContain("autofocus");
		expect(tagWithId(await get(`/bills/${id}`), "edit-bill")).not.toContain(
			"autofocus",
		);
	});

	it("closes a new bill added from a possible bill to that finding on the Possible bills page", async () => {
		// A raw name with a space and a % (which encodeURIComponent must escape) and no database rows needed.
		const finding = "SHOP BANK 50%";
		const html = await get(
			`/bills/new?${new URLSearchParams({ name: "Shop bank", merchant_raw_name: finding, finding })}`,
		);
		const closeTo = `/bills/find?focus=${encodeURIComponent(finding)}`;
		expect(backdropHref(html)).toBe(closeTo);
		expect(html.split(`href="${closeTo}"`).length - 1).toBe(2);
		expect(html).toMatch(
			/<input[^>]*name="finding"[^>]*value="SHOP BANK 50%"|<input[^>]*value="SHOP BANK 50%"[^>]*name="finding"/,
		);
	});

	it("keeps that close when the new bill is drawn again with a field's error", async () => {
		const finding = "SHOP BANK 50%";
		const html = await post(
			"/bills",
			new URLSearchParams({ name: "Shop bank", finding }),
		);
		expect(html).toContain("Enter an amount");
		expect(backdropHref(html)).toBe(
			`/bills/find?focus=${encodeURIComponent(finding)}`,
		);
	});

	it("puts focus on the possible bill's Add when the Possible bills page is drawn with that focus", async () => {
		const [suggestion] = await loadBillSuggestions(
			env.DB,
			todayIn(DEFAULT_TIME_ZONE),
		);
		expect(suggestion).toBeDefined();
		const rawName = suggestion?.rawName ?? "";
		const drawn = await get(`/bills/find?focus=${encodeURIComponent(rawName)}`);
		expect(addLinkFor(drawn, rawName)).toContain("autofocus");
		const other = await get("/bills/find?focus=NOPE");
		expect(other).not.toContain("autofocus");
	});

	it("saving an edit with htmx lands on the bill's page, with focus on Edit bill and no sheet", async () => {
		const id = await firstBillId();
		const res = await postResponse(
			`/bills/${id}`,
			billFields("Sheet focus bill"),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Push-Url")).toBe(`/bills/${id}`);
		expect(res.headers.get("HX-Trigger")).toContain('"announce":"Bill saved"');
		const html = await res.text();
		expect(tagWithId(html, "edit-bill")).toContain("autofocus");
		expect(html).not.toContain('role="dialog"');
	});

	it("saving an edit without JavaScript redirects to the bill's page, with focus on Edit bill", async () => {
		const id = await firstBillId();
		const res = await postResponse(
			`/bills/${id}`,
			billFields("Sheet focus bill plain"),
			false,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe(`/bills/${id}?focus=edit-bill`);
	});

	it("saving a new bill still goes to the Bills list, with htmx and without it", async () => {
		const htmx = await postResponse("/bills", billFields("Sheet focus gym"));
		expect(htmx.status).toBe(200);
		expect(htmx.headers.get("HX-Push-Url")).toBe("/bills");
		const plain = await postResponse(
			"/bills",
			billFields("Sheet focus pool"),
			false,
		);
		expect(plain.status).toBe(303);
		expect(plain.headers.get("location")).toBe("/bills");
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
