import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
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
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
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
		expect(html).toContain("Always for this merchant");
		expect(html).toContain("Count as income");
		expect(html).toMatch(/<input[^>]*name="merchant"[^>]*value="Local Bakery"/);
		expect(html).toMatch(/<label for="note"[^>]*>Note<\/label>/);
		expect(html).toMatch(
			/<a href="\/transactions\?uncategorized=1"[^>]*>Cancel<\/a>/,
		);
		expect(html).toMatch(
			/<button type="submit"[^>]*>[\s\S]*?Save[\s\S]*?<\/button>/,
		);
	});

	it("tidies an unnamed merchant's raw text for the heading, showing the raw text underneath and as the input placeholder", async () => {
		const paypal = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'PAYPAL *XYZSHOP'",
			).first<{ id: number }>()
		)?.id;
		const { html } = await get(`/transactions/${paypal}`);
		const sheet = html.slice(html.indexOf('role="dialog"'));
		expect(sheet).toMatch(/<h2 id="edit-title"[^>]*>Xyzshop<\/h2>/);
		// The raw text differs from the tidied heading, so it shows underneath and as the placeholder.
		expect(sheet.match(/PAYPAL \*XYZSHOP/g)).toHaveLength(2);
	});

	it("is a 404 page for an unknown id", async () => {
		const { res, html } = await get("/transactions/999999");
		expect(res.status).toBe(404);
		expect(html).toContain('aria-label="Main"');
		// The app's own 404 page (spec §8.5), not a page of this route's own.
		expect(html).toContain("This page isn&#39;t here.");
		expect(html).not.toContain("Back to Transactions");
	});

	it("is that same 404 page for a missing split form and a missing cash delete", async () => {
		const split = await get("/transactions/999999/split");
		expect(split.res.status).toBe(404);
		expect(split.html).toContain("This page isn&#39;t here.");
		const gone = await post(
			"/transactions/999999/delete",
			{ back: "/transactions" },
			false,
		);
		expect(gone.res.status).toBe(404);
		expect(gone.html).toContain("This page isn&#39;t here.");
	});
});

describe("POST /transactions/:id", () => {
	const save = {
		category: "2",
		merchant: "Local Bakery",
		note: "",
		back: "/transactions?uncategorized=1",
		income: "0",
		creditReviewed: "0",
	};

	it("keeps a Jev income credit unchanged on a note-only save", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = -500, category_id = NULL, category_source = NULL, category_confidence = 0.95, flag_income = 1, income_source = 'jev', credit_reviewed = 1, credit_reviewed_by = NULL WHERE id = ?",
		)
			.bind(bakery)
			.run();
		const sheet = await get(`/transactions/${bakery}`);
		expect(sheet.html).toContain('name="creditReviewedVisible"');
		expect(sheet.html).toContain('name="creditReviewed"');
		const { res } = await post(`/transactions/${bakery}`, {
			merchant: "Synthetic Payroll",
			note: "Synthetic note",
			back: "/transactions",
			income: "1",
			creditReviewedVisible: "1",
		});
		expect(res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT note, flag_income, income_source, credit_reviewed, credit_reviewed_by FROM transactions WHERE id = ?",
			)
				.bind(bakery)
				.first(),
		).toEqual({
			note: "Synthetic note",
			flag_income: 1,
			income_source: "jev",
			credit_reviewed: 1,
			credit_reviewed_by: null,
		});
	});

	it("lets a person turn Jev income into a reviewed refund in one save", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = -500, category_id = NULL, category_source = NULL, category_confidence = 0.95, flag_income = 1, income_source = 'jev', credit_reviewed = 1, credit_reviewed_by = NULL WHERE id = ?",
		)
			.bind(bakery)
			.run();
		const sheet = await get(`/transactions/${bakery}`);
		expect(sheet.html).toContain('name="creditReviewedVisible"');
		expect(sheet.html).toContain(
			"Reviewed as a refund or other non-income credit",
		);

		const { res } = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
			income: "0",
			creditReviewedVisible: "1",
			creditReviewed: "1",
		});
		expect(res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT flag_income, income_source, credit_reviewed, credit_reviewed_by FROM transactions WHERE id = ?",
			)
				.bind(bakery)
				.first(),
		).toEqual({
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
		});
	});

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

	it("names an unnamed merchant by its tidied text in the toast and announcement, never the raw bank text", async () => {
		const paypal = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'PAYPAL *XYZSHOP'",
			).first<{ id: number }>()
		)?.id;
		const { res } = await post(`/transactions/${paypal}`, {
			...save,
			merchant: "",
		});
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Saved Xyzshop", type: "success" },
			announce: "Saved. Xyzshop is now Eating Out.",
		});
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

	it("saves a person's income choice and preserves it when Jev runs again", async () => {
		const { res } = await post(`/transactions/${bakery}`, {
			...save,
			income: "1",
		});
		expect(res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT flag_income, income_source FROM transactions WHERE id = ?",
			)
				.bind(bakery)
				.first(),
		).toMatchObject({ flag_income: 1, income_source: "user" });
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

	it("says when Tally picked it, with how sure Tally was", async () => {
		await setSource("jev", 0.934);
		const { html } = await get(`/transactions/${bakery}`);
		expect(html).toContain("Picked by Tally · 93% sure");
	});

	it("says nothing for a person's choice or a merchant rule", async () => {
		await setSource("user", null);
		expect((await get(`/transactions/${bakery}`)).html).not.toContain(
			"Picked by Tally",
		);
		await setSource("merchant_rule", null);
		expect((await get(`/transactions/${bakery}`)).html).not.toContain(
			"Picked by Tally",
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
			"Picked by Tally",
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
	// The edit form's box, not anything in the list's filters.
	const checkbox =
		/<form method="post"[\s\S]*<input type="checkbox" name="excluded" value="1"([^>]*)>/;

	it("shows a labeled exclude checkbox that reflects the transaction", async () => {
		const bakerySheet = (await get(`/transactions/${bakery}`)).html;
		expect(bakerySheet).toMatch(checkbox);
		expect(bakerySheet.match(checkbox)?.[1]).not.toContain("checked");
		expect(bakerySheet).toContain("Exclude from budget");
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

describe("the edit panel's layout (owner's pick C, #27)", () => {
	const reimbursement = async () =>
		(
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'DR MARTIN FAMILY PRACTICE REFUND'",
			).first<{ id: number }>()
		)?.id as number;

	it("keeps renaming and the note behind one closed disclosure", async () => {
		const { html } = await get(`/transactions/${bakery}`);
		expect(html).toMatch(
			/<details class="[^"]*group[^"]*">\s*<summary[^>]*>[\s\S]*Rename or add a note/,
		);
		expect(html).not.toMatch(/<details[^>]*\bopen/);
		// The name field is inside the disclosure.
		expect(html.indexOf('name="merchant"')).toBeGreaterThan(
			html.indexOf("Rename or add a note"),
		);
	});

	it("opens the disclosure when there's a note to see", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET note = 'birthday' WHERE id = ?",
		)
			.bind(bakery)
			.run();
		const { html } = await get(`/transactions/${bakery}`);
		expect(html).toMatch(/<details[^>]*\bopen/);
	});

	it("opens the disclosure when a failed save brings back a typed new name", async () => {
		const { res, html } = await post(`/transactions/${bakery}`, {
			category: "99",
			merchant: "Corner Bakery",
			note: "",
			back: "/transactions",
		});
		expect(res.status).toBe(422);
		expect(html).toMatch(/<details[^>]*\bopen/);
		expect(html).toMatch(/name="merchant"[^>]*value="Corner Bakery"/);
	});

	it("says an excluded transaction is excluded, near the top", async () => {
		const excluded = (await get(`/transactions/${await reimbursement()}`)).html;
		expect(excluded).toContain("Excluded from the budget");
		expect(excluded.indexOf("Excluded from the budget")).toBeLessThan(
			excluded.indexOf('<form method="post"'),
		);
		expect((await get(`/transactions/${bakery}`)).html).not.toContain(
			"Excluded from the budget",
		);
	});

	it("says an excluded payment that pays a bill counts, instead of calling it excluded, in the panel and the list (spec §8.5)", async () => {
		const id = await reimbursement();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9600,'Venmo',1000,5,'monthly',5,'VENMO')",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) SELECT 9600, substr(date,1,7), id, 'user', 'linked' FROM transactions WHERE id = ?",
			).bind(id),
		]);
		const panel = (await get(`/transactions/${id}`)).html;
		expect(panel).not.toContain("Excluded from the budget");
		expect(panel).toContain("It pays a bill, so it counts in the budget.");
		// The chip still shows the saved exclusion, so saving a note doesn't change it.
		expect(panel).toMatch(/name="excluded"[^>]*checked/);

		const list = (await get("/transactions?month=all&q=MARTIN")).html;
		expect(list).toContain(`data-transaction="${id}"`);
		const row = list.split(`data-transaction="${id}"`)[1]?.split("</li>")[0];
		expect(row).not.toContain("Excluded");
		const filtered = (await get("/transactions?month=all&excluded=1")).html;
		expect(filtered).not.toContain(`data-transaction="${id}"`);

		// Saving a note leaves the exclusion exactly as it was.
		const saved = await post(`/transactions/${id}`, {
			category: "",
			merchant: "",
			note: "rent",
			excluded: "1",
			back: "/transactions",
		});
		expect(saved.res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT excluded, excluded_source FROM transactions WHERE id = ?",
			)
				.bind(id)
				.first(),
		).toMatchObject({ excluded: 1 });
	});

	it("has one How this works link", async () => {
		const html = (await get(`/transactions/${bakery}`)).html;
		const sheet = html.slice(html.indexOf('id="edit-title"'));
		expect((sheet.match(/href="\/how-it-works#/g) ?? []).length).toBe(1);
	});
});
