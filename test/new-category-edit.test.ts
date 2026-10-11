import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";
const TODAY = todayIn(DEFAULT_TIME_ZONE);
const THIS = TODAY.slice(0, 7);
const GROCERIES = 1;

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

async function post(path: string, fields: Record<string, string>) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			"HX-Request": "true",
		},
		body: new URLSearchParams(fields).toString(),
	});
	return { res, html: await res.text() };
}

const categoryCount = async () =>
	(
		await env.DB.prepare("SELECT COUNT(*) AS n FROM categories").first<{
			n: number;
		}>()
	)?.n;

const categoryNamed = (name: string) =>
	env.DB.prepare(
		"SELECT id, sort_order AS sortOrder, archived FROM categories WHERE name = ? COLLATE NOCASE",
	)
		.bind(name)
		.first<{ id: number; sortOrder: number; archived: number }>();

/** The category and source a transaction is filed under right now. */
const filedAs = (id: number) =>
	env.DB.prepare(
		"SELECT category_id AS categoryId, category_source AS source FROM transactions WHERE id = ?",
	)
		.bind(id)
		.first<{ categoryId: number | null; source: string | null }>();

let bakery: number;

/** The fields a save of the bakery panel posts, with the merchant name left as it is. */
const saveFields = (extra: Record<string, string>) => ({
	merchant: "Local Bakery",
	merchant_was: "Local Bakery",
	note: "",
	back: "/transactions",
	...extra,
});

beforeEach(async () => {
	await resetDemo(env.DB, TODAY);
	bakery = (
		await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number }>()
	)?.id as number;
});

describe("the New category chip in the edit panel", () => {
	it("draws the chip among the categories, its name field closed until it is chosen", async () => {
		const { html } = await get(`/transactions/${bakery}`);
		expect(html).toMatch(/name="category" value="new"/);
		expect(html).toContain("New category");
		expect(html).toContain('id="new-category-name"');
		expect(html).toContain(
			"Added to your categories and used for this transaction.",
		);
	});

	it("a taken name, in any case, gives its error in the field and saves nothing", async () => {
		const before = await filedAs(bakery);
		const count = await categoryCount();

		const { res, html } = await post(
			`/transactions/${bakery}`,
			saveFields({ category: "new", new_category_name: "  groceries " }),
		);

		expect(res.status).toBe(422);
		expect(html).toMatch(
			/id="new-category-name-error" role="alert"[^>]*>That name is taken\./,
		);
		expect(html).toMatch(/name="category" value="new" checked/);
		expect(await categoryCount()).toBe(count);
		expect(await filedAs(bakery)).toEqual(before);
	});

	it("a 51st active category gives the full message and saves nothing", async () => {
		const active = (
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM categories WHERE archived = 0",
			).first<{ n: number }>()
		)?.n as number;
		for (let i = active; i < 50; i++)
			await env.DB.prepare(
				"INSERT INTO categories (name, icon, color, sort_order) VALUES (?, 'tag', 'cat-blue', ?)",
			)
				.bind(`Filler ${i}`, 100 + i)
				.run();
		const before = await filedAs(bakery);

		const { res, html } = await post(
			`/transactions/${bakery}`,
			saveFields({ category: "new", new_category_name: "Pet Care" }),
		);

		expect(res.status).toBe(422);
		expect(html).toContain(
			"Tally has room for 50 categories. Archive one to add another.",
		);
		expect(await categoryNamed("Pet Care")).toBeNull();
		expect(await filedAs(bakery)).toEqual(before);
	});

	it("Save makes the category last, and files the transaction in it as the person's pick", async () => {
		const { res } = await post(
			`/transactions/${bakery}`,
			saveFields({ category: "new", new_category_name: "Pet Care" }),
		);

		expect(res.status).toBe(200);
		const made = await categoryNamed("Pet Care");
		expect(made?.archived).toBe(0);
		const last = (
			await env.DB.prepare(
				"SELECT MAX(sort_order) AS last FROM categories WHERE id <> ?",
			)
				.bind(made?.id)
				.first<{ last: number }>()
		)?.last as number;
		expect(made?.sortOrder).toBeGreaterThan(last);
		expect(await filedAs(bakery)).toEqual({
			categoryId: made?.id,
			source: "user",
		});
	});

	it("a typed name counts only while New category is chosen", async () => {
		const { res } = await post(
			`/transactions/${bakery}`,
			saveFields({
				category: String(GROCERIES),
				new_category_name: "Pet Care",
			}),
		);

		expect(res.status).toBe(200);
		expect(await categoryNamed("Pet Care")).toBeNull();
		expect(await filedAs(bakery)).toEqual({
			categoryId: GROCERIES,
			source: "user",
		});
	});
});

describe("the likely transactions after a new category", () => {
	let first: number;
	let second: number;

	beforeEach(async () => {
		// Two more bakery charges this month, still needing a category; one is the same merchant as the bakery.
		const insert = (date: string, cents: number) =>
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, ?, 'SQ *LOCAL BAKERY 4432') RETURNING id",
			)
				.bind(date, cents)
				.first<{ id: number }>();
		first = (await insert(`${THIS}-01`, 1200))?.id as number;
		second = (await insert(`${THIS}-02`, 900))?.id as number;
	});

	it("are offered after Save, ticked, and Add files only the ticked ones into the new category", async () => {
		const saved = await post(
			`/transactions/${bakery}`,
			saveFields({ category: "new", new_category_name: "Pet Care" }),
		);
		expect(saved.html).toContain("Pet Care is made.");
		expect(saved.html).toContain("These might belong too:");
		expect(saved.html).toMatch(
			new RegExp(`name="ids" value="${first}" checked`),
		);
		expect(saved.html).toMatch(
			new RegExp(`name="ids" value="${second}" checked`),
		);
		expect(saved.html).toContain("Add 2 to Pet Care");
		expect(saved.html).toContain("Same merchant as");

		const made = await categoryNamed("Pet Care");
		const { res, html } = await post(`/transactions/${bakery}/likely`, {
			back: "/transactions",
			category: String(made?.id),
			ids: String(first),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toContain(
			"Set 1 transaction to Pet Care.",
		);
		expect(html).not.toContain("These might belong too:");
		expect(await filedAs(first)).toEqual({
			categoryId: made?.id,
			source: "user",
		});
		expect((await filedAs(second))?.categoryId).toBeNull();
	});

	it("redraw the Add count as the ticks change", async () => {
		await env.DB.prepare(
			"INSERT INTO categories (name, icon, color, sort_order) VALUES ('Pet Care', 'tag', 'cat-plum', 99)",
		).run();
		const made = await categoryNamed("Pet Care");
		const none = await post(`/transactions/${bakery}/likely/count`, {
			back: "/transactions",
			category: String(made?.id),
		});
		expect(none.html).toContain("Add to Pet Care");
		expect(none.html).toMatch(/<button[^>]*disabled[^>]*>Add to Pet Care/);

		const one = await post(`/transactions/${bakery}/likely/count`, {
			back: "/transactions",
			category: String(made?.id),
			ids: String(first),
		});
		expect(one.html).toContain("Add 1 to Pet Care");
	});
});
