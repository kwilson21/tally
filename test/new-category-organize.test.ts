import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";
const TODAY = todayIn(DEFAULT_TIME_ZONE);

async function get(path = "/transactions/organize") {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

async function post(fields: Record<string, string | string[]>) {
	const form = new URLSearchParams();
	for (const [key, value] of Object.entries(fields)) {
		for (const item of Array.isArray(value) ? value : [value])
			form.append(key, item);
	}
	const res = await exports.default.fetch(`${BASE}/transactions/organize`, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			"HX-Request": "true",
		},
		body: form.toString(),
	});
	return { res, html: await res.text() };
}

/** Leaves every demo transaction filed, then adds a merchant's charges that still need a category. */
async function harborCharges(count: number) {
	await env.DB.batch([
		env.DB.prepare(
			"UPDATE transactions SET category_id = 1, category_source = 'user'",
		),
		env.DB.prepare(
			"INSERT OR REPLACE INTO merchants (raw_name, display_name) VALUES ('HARBOR SUPPLY', 'Harbor Supply')",
		),
		...Array.from({ length: count }, (_, i) =>
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, ?, 'HARBOR SUPPLY')",
			).bind(TODAY, 1000 + i),
		),
	]);
}

const filedIn = async (name: string) =>
	(
		await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions t JOIN categories c ON c.id = t.category_id WHERE c.name = ? AND t.category_source = 'user' AND t.raw_name = 'HARBOR SUPPLY'",
		)
			.bind(name)
			.first<{ n: number }>()
	)?.n;

beforeEach(async () => {
	await resetDemo(env.DB, TODAY);
});

describe("New category in Organize", () => {
	it("hints in the plural for a merchant with several charges, and in the singular for one", async () => {
		await harborCharges(2);
		const plural = await get();
		expect(plural.html).toContain(
			"Added to your categories and used for these transactions.",
		);
		expect(plural.html).toContain('name="new_category_name"');

		await harborCharges(1);
		const singular = await get();
		expect(singular.html).toContain(
			"Added to your categories and used for this transaction.",
		);
	});

	it("a taken name gives its error in the field and saves nothing", async () => {
		await harborCharges(2);

		const { res, html } = await post({
			group: "Harbor Supply",
			category: "new",
			new_category_name: "Groceries",
			name: "",
		});

		expect(res.status).toBe(422);
		expect(html).toMatch(
			/id="new-category-name-error" role="alert"[^>]*>That name is taken\./,
		);
		const uncategorized = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE raw_name = 'HARBOR SUPPLY' AND category_id IS NULL",
		).first<{ n: number }>();
		expect(uncategorized?.n).toBe(2);
	});

	it("a new name files the whole group in it, last in the list, and offers nothing more", async () => {
		await harborCharges(2);

		const { res, html } = await post({
			group: "Harbor Supply",
			category: "new",
			new_category_name: "Pets",
			name: "",
		});

		expect(res.status).toBe(200);
		expect(await filedIn("Pets")).toBe(2);
		const made = await env.DB.prepare(
			"SELECT sort_order AS sortOrder FROM categories WHERE name = 'Pets'",
		).first<{ sortOrder: number }>();
		const last = await env.DB.prepare(
			"SELECT MAX(sort_order) AS last FROM categories WHERE name <> 'Pets'",
		).first<{ last: number }>();
		expect(made?.sortOrder).toBeGreaterThan(last?.last ?? 0);
		expect(html).not.toContain("These might belong too:");
	});
});
