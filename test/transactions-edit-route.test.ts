import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";
const rowCount = (html: string) =>
	(html.match(/<li data-transaction=/g) ?? []).length;

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

async function post(path: string, fields: Record<string, string>, htmx = true) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			...(htmx ? { "HX-Request": "true" } : {}),
		},
		body: new URLSearchParams(fields).toString(),
	});
	return { res, html: await res.text() };
}

let bakery: number;
beforeEach(async () => {
	await resetDemo(env.DB, todayUtc());
	bakery = (
		await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number }>()
	)?.id as number;
});

describe("row links", () => {
	it("open the edit sheet for that row, keeping the list's filters", async () => {
		const { html } = await get("/transactions?uncategorized=1");
		expect(html).toMatch(
			new RegExp(
				`<a href="/transactions/${bakery}\\?uncategorized=1"[^>]*hx-target="#sheet"`,
			),
		);
	});
});

describe("GET /transactions/:id", () => {
	it("shows the list and the edit sheet, labeled and focused", async () => {
		const { res, html } = await get(`/transactions/${bakery}?uncategorized=1`);
		expect(res.status).toBe(200);
		expect(rowCount(html)).toBe(12);
		expect(html).toMatch(/<section role="dialog" aria-labelledby="edit-title"/);
		expect(html).toMatch(
			/<h2 id="edit-title"[^>]*autofocus[^>]*>Local Bakery<\/h2>/,
		);
		expect(html).toContain("SQ *LOCAL BAKERY 4432");
		expect(html).toContain("$12.00");
		expect(html).toMatch(/Credit card ••9012/);
		expect(html).toMatch(/<fieldset[^>]*><legend[^>]*>Category<\/legend>/);
		expect(
			(html.match(/<input type="radio" name="category"/g) ?? []).length,
		).toBe(5);
		expect(html).toContain("Always use this category for this merchant");
		expect(html).toMatch(/<input[^>]*name="merchant"[^>]*value="Local Bakery"/);
		expect(html).toMatch(/<label for="note"[^>]*>Note<\/label>/);
		expect(html).toMatch(
			/<a href="\/transactions\?uncategorized=1"[^>]*>Cancel<\/a>/,
		);
		expect(html).toMatch(/<button type="submit"[^>]*>Save<\/button>/);
	});

	it("shows the raw bank name only when it differs from the heading", async () => {
		const paypal = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'PAYPAL *XYZSHOP'",
			).first<{ id: number }>()
		)?.id;
		const { html } = await get(`/transactions/${paypal}`);
		const sheet = html.slice(html.indexOf('role="dialog"'));
		expect(sheet.match(/PAYPAL \*XYZSHOP/g)).toHaveLength(2); // heading + input placeholder
	});

	it("is a 404 page for an unknown id", async () => {
		const { res, html } = await get("/transactions/999999");
		expect(res.status).toBe(404);
		expect(html).toContain('aria-label="Main"');
	});
});

describe("POST /transactions/:id", () => {
	const save = {
		category: "2",
		merchant: "Local Bakery",
		note: "",
		back: "/transactions?uncategorized=1",
	};

	it("saves, closes the sheet, and confirms with a toast and announcement (htmx)", async () => {
		const { res, html } = await post(`/transactions/${bakery}`, save);
		expect(res.status).toBe(200);
		expect(rowCount(html)).toBe(11);
		expect(html).not.toContain('role="dialog"');
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Saved Local Bakery", type: "success" },
			announce: "Saved. Local Bakery is now Eating Out.",
		});
		expect(res.headers.get("HX-Push-Url")).toBe(
			"/transactions?uncategorized=1",
		);
		// The saved row left this filtered list, so focus goes to the result count.
		expect(html).toMatch(/<p id="result-count"[^>]*autofocus/);
	});

	it("updates the Needs category count outside the swapped list after a save", async () => {
		const { html: sheet } = await get(
			`/transactions/${bakery}?uncategorized=1`,
		);
		expect(sheet).toMatch(
			/<form method="post"[^>]*hx-select-oob="#needs-count:innerHTML"/,
		);
		const { html } = await post(`/transactions/${bakery}`, save);
		expect(html).toMatch(/<span id="needs-count">11<\/span>/);
	});

	it("returns focus to the saved row when it's still in the list", async () => {
		const { html } = await post(`/transactions/${bakery}`, {
			...save,
			back: "/transactions",
		});
		expect(html).toMatch(
			new RegExp(`<a href="/transactions/${bakery}"[^>]*autofocus`),
		);
	});

	it("redirects back to the list without JavaScript", async () => {
		const { res } = await post(`/transactions/${bakery}`, save, false);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/transactions?uncategorized=1");
	});

	it("never redirects off the Transactions list", async () => {
		const { res } = await post(
			`/transactions/${bakery}`,
			{ ...save, back: "https://evil.example" },
			false,
		);
		expect(res.headers.get("Location")).toBe("/transactions");
	});

	it("re-renders the sheet with the error and the typed values", async () => {
		const { res, html } = await post(`/transactions/${bakery}`, {
			...save,
			category: "99",
			note: "keep me",
		});
		expect(res.status).toBe(422);
		expect(html).toMatch(/role="alert"[^>]*>Pick a category from the list\./);
		expect(html).toContain("keep me");
		expect(html).toContain('role="dialog"');
	});

	it("updates Home", async () => {
		await post(`/transactions/${bakery}`, save);
		expect((await get("/")).html).toContain("11 transactions need a category");
	});
});

describe("who picked the category", () => {
	const setSource = (source: string | null, confidence: number | null) =>
		env.DB.prepare(
			"UPDATE transactions SET category_id = 2, category_source = ?, category_confidence = ? WHERE id = ?",
		)
			.bind(source, confidence, bakery)
			.run();

	it("says when Jev picked it, with how sure Jev was", async () => {
		await setSource("jev", 0.934);
		const { html } = await get(`/transactions/${bakery}`);
		expect(html).toContain("Picked by Jev · 93% sure");
	});

	it("says nothing for a person's choice or a merchant rule", async () => {
		await setSource("user", null);
		expect((await get(`/transactions/${bakery}`)).html).not.toContain(
			"Picked by Jev",
		);
		await setSource("merchant_rule", null);
		expect((await get(`/transactions/${bakery}`)).html).not.toContain(
			"Picked by Jev",
		);
	});

	it("goes away once a person chooses the category", async () => {
		await setSource("jev", 0.9);
		const { res } = await post(`/transactions/${bakery}`, {
			category: "1",
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
		});
		expect(res.status).toBe(200);
		expect((await get(`/transactions/${bakery}`)).html).not.toContain(
			"Picked by Jev",
		);
	});
});

describe("excluding a transaction (spec §6, #27)", () => {
	const transferId = async () =>
		(
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'ONLINE TRANSFER TO SAV ...5678' ORDER BY date DESC",
			).first<{ id: number }>()
		)?.id as number;
	// The edit form's box, not the list's Excluded filter chip, which shares the field name.
	const checkbox =
		/<form method="post"[\s\S]*<input type="checkbox" name="excluded" value="1"([^>]*)>/;

	it("shows a labeled exclude checkbox that reflects the transaction", async () => {
		const bakerySheet = (await get(`/transactions/${bakery}`)).html;
		expect(bakerySheet).toMatch(checkbox);
		expect(bakerySheet.match(checkbox)?.[1]).not.toContain("checked");
		expect(bakerySheet).toContain("Exclude from the budget");
		const transferSheet = (await get(`/transactions/${await transferId()}`))
			.html;
		expect(transferSheet.match(checkbox)?.[1]).toContain("checked");
	});

	it("excludes on save, and says so", async () => {
		const { res, html } = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			note: "",
			excluded: "1",
			back: "/transactions?uncategorized=1",
		});
		expect(rowCount(html)).toBe(11);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}").announce).toBe(
			"Saved Local Bakery. It's excluded from the budget.",
		);
		expect((await get("/")).html).toContain("11 transactions need a category");
	});

	it("includes an excluded transaction again when the box is cleared, and says so", async () => {
		const id = await transferId();
		const { res } = await post(`/transactions/${id}`, {
			merchant: "",
			note: "",
			back: "/transactions",
		});
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}").announce).toMatch(
			/It counts in the budget again\.$/,
		);
		const row = await env.DB.prepare(
			"SELECT excluded FROM transactions WHERE id = ?",
		)
			.bind(id)
			.first<{ excluded: number }>();
		expect(row?.excluded).toBe(0);
	});

	it("keeps the box as typed when the form has an error", async () => {
		const { html } = await post(`/transactions/${bakery}`, {
			category: "99",
			merchant: "",
			note: "",
			excluded: "1",
			back: "/transactions",
		});
		expect(html.match(checkbox)?.[1]).toContain("checked");
	});
});
