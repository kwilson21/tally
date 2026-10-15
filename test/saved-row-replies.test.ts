import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

// P119 A (decision 111, #71): only a save's own reply marks the row it saved, with row-saved (or row-saved-undo
// when its toast offers Undo). Cancel, Adjust's taps, a 422 redraw, archiving and the rest never mark a row.

const BASE = "http://tally.test";

async function get(path: string, htmx = false) {
	const res = await exports.default.fetch(BASE + path, {
		headers: htmx ? { "HX-Request": "true" } : {},
	});
	return { res, html: await res.text() };
}

/** A form post; pairs repeat a field name (the Select-mode save sends one `ids` per row). */
async function post(
	path: string,
	fields: Record<string, string> | [string, string][],
	htmx = true,
) {
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

/** The whole opening tag of the link that starts with `href`, so its class is checked on that link alone. */
const linkTag = (html: string, href: string) =>
	html.match(new RegExp(`<a [^>]*href="${href}"[^>]*>`))?.[0] ?? "";
const marked = (html: string) =>
	(html.match(/\brow-saved(?:-undo)?\b/g) ?? []).length;

let bakery: number;
beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	bakery = (
		await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number }>()
	)?.id as number;
});

describe("a transaction's edit panel save marks its row", () => {
	it("marks exactly the saved row in the list it returns to", async () => {
		const { html } = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
			category: "2",
		});
		expect(marked(html)).toBe(1);
		expect(linkTag(html, `/transactions/${bakery}[^"]*`)).toMatch(
			/\brow-saved\b/,
		);
		expect(html).toContain("saved-tick");
	});

	it("marks nothing when the save fails validation", async () => {
		const { html } = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
			category: "999999",
		});
		expect(marked(html)).toBe(0);
	});
});

describe("a budget sheet save marks Home's budget row and draws the bars still", () => {
	it("marks the saved category's row, and no other row", async () => {
		const { res, html } = await post("/budget/1", { budget: "650" });
		expect(res.status).toBe(200);
		expect(marked(html)).toBe(1);
		expect(linkTag(html, "/budget/1")).toMatch(/\brow-saved\b/);
	});

	it("draws Home's bars still on the save's reply, and animates them on a plain load", async () => {
		const { html } = await post("/budget/1", { budget: "650" });
		expect(html).not.toContain("bar-fill");
		const plain = await get("/");
		expect(plain.html).toContain("bar-fill");
	});

	it("marks nothing when the amount is refused and the sheet is drawn again", async () => {
		const { res, html } = await post("/budget/1", { budget: "lots" });
		expect(res.status).toBe(422);
		expect(marked(html)).toBe(0);
	});

	it("marks nothing on an Adjust tap, which keeps the bars and the rows as they are", async () => {
		const { html } = await post("/budget/1/nudge/up", {});
		expect(marked(html)).toBe(0);
		expect(html).not.toContain("saved-tick");
	});
});

describe("a savings goal save marks the Savings row", () => {
	it("marks the Savings row once a goal is set, and draws Home's bars still", async () => {
		const { res, html } = await post("/savings-goal", { goal: "500" });
		expect(res.status).toBe(200);
		expect(marked(html)).toBe(1);
		expect(linkTag(html, "/savings-goal")).toMatch(/\brow-saved\b/);
		expect(html).not.toContain("bar-fill");
	});
});

describe("a Settings category save marks its row", () => {
	it("marks the renamed category's row", async () => {
		const { res, html } = await post("/settings/categories/1", {
			name: "Food at home",
		});
		expect(res.status).toBe(200);
		expect(marked(html)).toBe(1);
		expect(html).toMatch(
			/<details class="[^"]*\brow-saved\b[^"]*" data-row="1"/,
		);
		expect(html).toContain("saved-tick");
	});

	it("marks nothing when the name is taken and the row stays open", async () => {
		const { html } = await post("/settings/categories/1", { name: "gas" });
		expect(marked(html)).toBe(0);
	});

	it("marks nothing on archive, which takes the row out of the list", async () => {
		const { html } = await post("/settings/categories/1/archive", {});
		expect(marked(html)).toBe(0);
	});
});

describe("a save that asks a question marks its own row, when it is the edit panel's", () => {
	const MERCHANT = "rule-offer-store";
	const edit = (category: number) => ({
		category: String(category),
		merchant: "",
		merchant_was: "",
		name_pick: "",
		note: "",
		excluded: "0",
		income: "0",
		creditReviewed: "0",
		back: "/transactions",
	});
	let groceries: number;
	let picks: number[];

	beforeEach(async () => {
		groceries = (
			await env.DB.prepare(
				"SELECT id FROM categories WHERE name = 'Groceries'",
			).first<{ id: number }>()
		)?.id as number;
		await env.DB.prepare("INSERT INTO merchants (raw_name) VALUES (?)")
			.bind(MERCHANT)
			.run();
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, ?, 1000, ?, ?), (1, ?, 1000, ?, ?), (1, ?, 1000, ?, ?), (1, ?, 1000, ?, ?)",
		)
			.bind(
				...Array.from({ length: 4 }, () => [
					todayIn(DEFAULT_TIME_ZONE),
					MERCHANT,
					MERCHANT,
				]).flat(),
			)
			.run();
		picks = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE merchant_name = ? ORDER BY id",
			)
				.bind(MERCHANT)
				.all<{ id: number }>()
		).results.map((row) => row.id);
	});

	/** Two Groceries picks by the person, so the next one is the third and asks. */
	const twoPicks = () =>
		env.DB.prepare(
			"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id IN (?, ?)",
		)
			.bind(groceries, picks[0], picks[1])
			.run();

	it("marks exactly the saved row when its edit panel save raises the rule offer", async () => {
		await post(`/transactions/${picks[0]}`, edit(groceries));
		await post(`/transactions/${picks[1]}`, edit(groceries));
		const third = await post(`/transactions/${picks[2]}`, edit(groceries));
		expect(third.html).toContain("Always use Groceries for rule-offer-store?");
		expect(marked(third.html)).toBe(1);
		expect(linkTag(third.html, `/transactions/${picks[2]}[^"]*`)).toMatch(
			/\brow-saved\b/,
		);
	});

	it("marks nothing when a cash entry's save raises the rule offer", async () => {
		await twoPicks();
		const cash = await post("/transactions/cash", {
			date: todayIn(DEFAULT_TIME_ZONE),
			amount: "10.00",
			merchant: MERCHANT,
			category: String(groceries),
			note: "",
			back: "/transactions",
		});
		expect(cash.html).toContain("Always use Groceries for rule-offer-store?");
		expect(marked(cash.html)).toBe(0);
	});

	it("marks nothing when a Select-mode save raises the rule offer", async () => {
		await twoPicks();
		const selected = await post("/transactions/select/category/save", {
			ids: String(picks[2]),
			category: String(groceries),
			back: "/transactions?select=1",
		});
		expect(selected.html).toContain(
			"Always use Groceries for rule-offer-store?",
		);
		expect(marked(selected.html)).toBe(0);
	});
});

describe("a save that opens the likely transactions marks its own row", () => {
	beforeEach(async () => {
		// Two more bakery charges this month, still needing a category; one is the same merchant as the bakery.
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		for (const [day, cents] of [
			["01", 1200],
			["02", 900],
		] as const)
			await env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, ?, 'SQ *LOCAL BAKERY 4432')",
			)
				.bind(`${month}-${day}`, cents)
				.run();
	});

	it("marks exactly the saved row when the new category's save opens the Likely sheet", async () => {
		const saved = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			merchant_was: "Local Bakery",
			note: "",
			back: "/transactions",
			category: "new",
			new_category_name: "Pet Care",
		});
		expect(saved.html).toContain("These might belong too:");
		expect(marked(saved.html)).toBe(1);
		expect(linkTag(saved.html, `/transactions/${bakery}[^"]*`)).toMatch(
			/\brow-saved\b/,
		);
	});

	/** The opening tags of the sheet's two closes: Not now, and the backdrop every close shares (data-sheet-close). */
	const closes = (html: string) => [
		html.match(/<a [^>]*>Not now<\/a>/)?.[0] ?? "",
		html.match(/<a [^>]*data-sheet-close[^>]*>/)?.[0] ?? "",
	];

	it("carries the saved row while its toast is up, on both closes that are htmx swaps", async () => {
		const saved = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			merchant_was: "Local Bakery",
			note: "",
			back: "/transactions",
			category: "new",
			new_category_name: "Pet Care",
		});
		const [notNow, backdrop] = closes(saved.html);
		expect(notNow).not.toBe("");
		expect(backdrop).not.toBe("");
		for (const tag of [notNow, backdrop]) {
			expect(tag).toMatch(new RegExp(`hx-get="[^"]*focus=${bakery}[^"]*"`));
			expect(tag).toMatch(new RegExp(`hx-get="[^"]*saved=${bakery}[^"]*"`));
			expect(tag).toMatch(/hx-get="[^"]*saved-at=\d+[^"]*"/);
			expect(tag).toContain('hx-swap="outerMorph"');
			expect(tag).toContain('hx-push-url="/transactions"');
			// A close without htmx is a full page load, which drops the toast anyway, so its href stays plain.
			expect(tag).not.toMatch(/href="[^"]*saved=/);
		}
	});
});

/** The opening tag of the disclosure that holds `marker`, found by walking back from the marker to its own <details>. */
const detailsOf = (html: string, marker: string) => {
	const at = html.indexOf(marker);
	const start = at < 0 ? -1 : html.lastIndexOf("<details", at);
	return start < 0 ? "" : html.slice(start, html.indexOf(">", start) + 1);
};

describe("a Settings add or time zone save marks the row it changed", () => {
	it("marks exactly the category an Add form just added", async () => {
		const { res, html } = await post("/settings/categories", {
			name: "Pet Care",
		});
		expect(res.status).toBe(200);
		const id = (
			await env.DB.prepare(
				"SELECT id FROM categories WHERE name = 'Pet Care'",
			).first<{ id: number }>()
		)?.id;
		expect(marked(html)).toBe(1);
		expect(detailsOf(html, `data-row="${id}"`)).toMatch(/\brow-saved\b/);
	});

	it("marks nothing when the new category's name is taken", async () => {
		const { res, html } = await post("/settings/categories", { name: "gas" });
		expect(res.status).toBe(422);
		expect(marked(html)).toBe(0);
	});

	it("marks the time zone row when a valid zone is saved", async () => {
		const { res, html } = await post("/settings/time-zone", {
			time_zone: "America/Chicago",
		});
		expect(res.status).toBe(200);
		expect(marked(html)).toBe(1);
		expect(detailsOf(html, 'id="time-zone-disclosure"')).toMatch(
			/\brow-saved\b/,
		);
	});

	it("marks nothing when the zone is refused", async () => {
		const { res, html } = await post("/settings/time-zone", {
			time_zone: "Mars/Olympus",
		});
		expect(res.status).toBe(422);
		expect(marked(html)).toBe(0);
	});
});

describe("a Settings person save marks the row it changed", () => {
	let kids: number;

	beforeEach(async () => {
		kids = (
			await env.DB.prepare(
				"INSERT INTO household_people (name) VALUES ('Kids') RETURNING id",
			).first<{ id: number }>()
		)?.id as number;
	});

	it("marks exactly the person a rename just saved, and keeps that row open", async () => {
		const { res, html } = await post("/settings/people", {
			action: "rename",
			person_id: String(kids),
			name: "Kidz",
		});
		expect(res.status).toBe(200);
		expect(marked(html)).toBe(1);
		const row = detailsOf(html, `name="person_id" value="${kids}"`);
		expect(row).toMatch(/\brow-saved\b/);
		expect(row).toMatch(/\sopen\b/);
	});

	it("marks nothing when the renamed name is taken", async () => {
		const { res, html } = await post("/settings/people", {
			action: "rename",
			person_id: String(kids),
			name: "Everyone",
		});
		expect(res.status).toBe(422);
		expect(marked(html)).toBe(0);
	});

	it("marks exactly the person an Add form just added, never Everyone or Add a person", async () => {
		const { res, html } = await post("/settings/people", {
			action: "add",
			name: "Morgan",
		});
		expect(res.status).toBe(200);
		const morgan = (
			await env.DB.prepare(
				"SELECT id FROM household_people WHERE name = 'Morgan'",
			).first<{ id: number }>()
		)?.id;
		expect(marked(html)).toBe(1);
		expect(detailsOf(html, `name="person_id" value="${morgan}"`)).toMatch(
			/\brow-saved\b/,
		);
		expect(detailsOf(html, "Always available")).not.toMatch(/row-saved/);
		expect(detailsOf(html, "Add a person")).not.toMatch(/row-saved/);
	});

	it("marks nothing when a person is removed", async () => {
		const { html } = await post("/settings/people", {
			remove: "1",
			person_id: String(kids),
		});
		expect(marked(html)).toBe(0);
	});
});

describe("a cash entry's Undo restore marks its row", () => {
	/** Deletes a plain cash entry from the current month; returns its row and the Undo token its toast offers. */
	async function deleteCashEntry() {
		const entry = await env.DB.prepare(
			"SELECT t.id, t.raw_name FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type='cash' AND t.is_split=0 AND t.parent_id IS NULL AND t.date LIKE ? ORDER BY t.id LIMIT 1",
		)
			.bind(`${todayIn(DEFAULT_TIME_ZONE).slice(0, 7)}-%`)
			.first<{ id: number; raw_name: string }>();
		if (!entry) throw new Error("cash seed missing");
		const { res } = await post(`/transactions/${entry.id}/delete`, {
			back: "/transactions",
			confirm: "1",
		});
		expect(res.status).toBe(200);
		const token = JSON.parse(res.headers.get("HX-Trigger") ?? "{}").toast.undo;
		return { raw_name: entry.raw_name, token: token as string };
	}

	it("marks the restored row on the ordinary toast stay, and keeps its focus", async () => {
		const { raw_name, token } = await deleteCashEntry();
		const { res, html } = await post("/transactions/undo-cash-delete", {
			token,
			back: "/transactions",
		});
		const feedback = JSON.parse(res.headers.get("HX-Trigger") ?? "{}");
		// The restore's own toast is a plain one: no Undo to offer, so four seconds.
		expect(feedback.toast.undo).toBeUndefined();
		// A restore takes new ids, so the entry is found by what it was, as the newest row of that name.
		const restoredId = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name=? ORDER BY id DESC LIMIT 1",
			)
				.bind(raw_name)
				.first<{ id: number }>()
		)?.id;
		expect(marked(html)).toBe(1);
		const tag = linkTag(html, `/transactions/${restoredId}(?:\\?[^"]*)?`);
		expect(tag).toMatch(/\brow-saved\b/);
		expect(tag).not.toMatch(/row-saved-undo/);
		expect(tag).toMatch(/\bautofocus\b/);
	});

	it("marks nothing when the same Undo token is posted again", async () => {
		const { token } = await deleteCashEntry();
		await post("/transactions/undo-cash-delete", {
			token,
			back: "/transactions",
		});
		const { res, html } = await post("/transactions/undo-cash-delete", {
			token,
			back: "/transactions",
		});
		expect(
			JSON.parse(res.headers.get("HX-Trigger") ?? "{}").toast.message,
		).toBe("That cash entry is already back.");
		expect(marked(html)).toBe(0);
	});

	it("marks nothing when the Undo token was never issued", async () => {
		const { html } = await post("/transactions/undo-cash-delete", {
			token: "00000000-0000-4000-8000-000000000000",
			back: "/transactions",
		});
		expect(marked(html)).toBe(0);
	});
});

describe("a Likely sheet's close keeps the saved row's tick for the rest of its toast", () => {
	/** The list an htmx close asks for: the row named, and when it was saved (the server's clock, in milliseconds). */
	const closeAt = (savedAt: string) =>
		`/transactions?focus=${bakery}&saved=${bakery}&saved-at=${savedAt}`;

	it("marks the saved row when the close is within the toast's stay", async () => {
		const { html } = await get(closeAt(String(Date.now() - 1000)), true);
		expect(marked(html)).toBe(1);
		expect(linkTag(html, `/transactions/${bakery}[^"]*`)).toMatch(
			/\brow-saved\b/,
		);
		expect(html).not.toContain("row-saved-undo");
	});

	it("marks nothing once the toast has gone", async () => {
		const { html } = await get(closeAt(String(Date.now() - 5000)), true);
		expect(marked(html)).toBe(0);
	});

	it("marks nothing unless htmx asks within the stay", async () => {
		const fresh = String(Date.now() - 1000);
		const cases: [string, boolean][] = [
			// A close without htmx is a full page load; the save's toast is gone by then.
			[closeAt(fresh), false],
			[closeAt(String(Date.now() + 60000)), true],
			[closeAt("abc"), true],
			[`/transactions?focus=${bakery}&saved=${bakery}`, true],
			[`/transactions?focus=${bakery}&saved=0&saved-at=${fresh}`, true],
			[`/transactions?focus=${bakery}&saved=abc&saved-at=${fresh}`, true],
		];
		for (const [path, htmx] of cases) {
			const { html } = await get(path, htmx);
			expect(marked(html), path).toBe(0);
		}
	});
});

describe("nothing but a save's own reply marks a row", () => {
	it("marks nothing when Cancel closes the budget sheet", async () => {
		const { html } = await get("/?focus=1", true);
		expect(marked(html)).toBe(0);
	});

	it("marks nothing when Cancel closes the savings goal sheet", async () => {
		const { html } = await get("/?focus=savings-goal", true);
		expect(marked(html)).toBe(0);
	});

	it("marks nothing when Cancel closes the edit panel", async () => {
		const { html } = await get(`/transactions?focus=${bakery}`, true);
		expect(marked(html)).toBe(0);
	});

	it("marks nothing when Select mode opens", async () => {
		const { html } = await get("/transactions?select=1", true);
		expect(marked(html)).toBe(0);
		expect(html).not.toContain("saved-tick");
	});

	it("marks nothing when an edit panel save takes the row out of the list it returns to", async () => {
		// Eating Out (2) is not in the Groceries (1) filter the back address names, so the row leaves the list.
		const { html } = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			note: "",
			back: "/transactions?month=all&category=1",
			category: "2",
		});
		expect(linkTag(html, `/transactions/${bakery}[^"]*`)).toBe("");
		expect(marked(html)).toBe(0);
		expect(html).not.toContain("saved-tick");
	});

	it("marks nothing when a Select-mode category save sets its ticked row", async () => {
		const { res, html } = await post("/transactions/select/category/save", [
			["category", "2"],
			["back", "/transactions?month=all"],
			["ids", String(bakery)],
		]);
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toContain(
			"Set 1 transaction to Eating Out.",
		);
		expect(marked(html)).toBe(0);
		expect(html).not.toContain("saved-tick");
	});
});
