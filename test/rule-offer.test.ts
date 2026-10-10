import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";

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

let merchant: string;
let groceries: number;
let household: number;
let ids: number[];

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	merchant = "rule-offer-store";
	const categories = await env.DB.prepare(
		"SELECT id, name FROM categories WHERE name IN ('Groceries', 'Household')",
	).all<{ id: number; name: string }>();
	groceries = categories.results.find((c) => c.name === "Groceries")?.id ?? 0;
	household = categories.results.find((c) => c.name === "Household")?.id ?? 0;
	await env.DB.prepare("INSERT INTO merchants (raw_name) VALUES (?)")
		.bind(merchant)
		.run();
	await env.DB.prepare(
		"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, ?, 1000, ?, ?), (1, ?, 1000, ?, ?), (1, ?, 1000, ?, ?), (1, ?, 1000, ?, ?)",
	)
		.bind(
			...Array.from({ length: 4 }, () => [
				todayIn(DEFAULT_TIME_ZONE),
				merchant,
				merchant,
			]).flat(),
		)
		.run();
	ids = await env.DB.prepare(
		"SELECT id FROM transactions WHERE merchant_name = ? ORDER BY id",
	)
		.bind(merchant)
		.all<{ id: number }>()
		.then((r) => r.results.map((row) => row.id));
});

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

describe("merchant category rule offer", () => {
	it("offers on the third matching save with the real count, then again on the fourth", async () => {
		await post(`/transactions/${ids[0]}`, edit(groceries));
		const second = await post(`/transactions/${ids[1]}`, edit(groceries));
		expect(second.html).not.toContain(
			"Always use Groceries for rule-offer-store?",
		);
		const third = await post(`/transactions/${ids[2]}`, edit(groceries));
		expect(third.html).toContain("Always use Groceries for rule-offer-store?");
		expect(third.html).toContain(
			"You&#39;ve picked Groceries for rule-offer-store 3 times.",
		);
		const fourth = await post(`/transactions/${ids[3]}`, edit(groceries));
		expect(fourth.html).toContain(
			"You&#39;ve picked Groceries for rule-offer-store 4 times.",
		);
	});

	it("does not offer for a multi-category merchant or a merchant that already has a rule", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
		)
			.bind(household, ids[0])
			.run();
		const multi = await post(`/transactions/${ids[1]}`, edit(groceries));
		expect(multi.html).not.toContain(
			"Always use Groceries for rule-offer-store?",
		);
		await env.DB.prepare(
			"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE merchant_name = ?",
		)
			.bind(groceries, merchant)
			.run();
		await env.DB.prepare(
			"UPDATE merchants SET default_category_id = ? WHERE raw_name = ?",
		)
			.bind(groceries, merchant)
			.run();
		const ruled = await post(`/transactions/${ids[0]}`, edit(groceries));
		expect(ruled.html).not.toContain(
			"Always use Groceries for rule-offer-store?",
		);
	});

	it("Select offers only for the merchant whose selected category reaches three", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id IN (?, ?)",
		)
			.bind(groceries, ids[0], ids[1])
			.run();
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, ?, 1000, 'other', 'other'), (1, ?, 1000, 'other', 'other'), (1, ?, 1000, 'other', 'other')",
		)
			.bind(
				todayIn(DEFAULT_TIME_ZONE),
				todayIn(DEFAULT_TIME_ZONE),
				todayIn(DEFAULT_TIME_ZONE),
			)
			.run();
		const other = await env.DB.prepare(
			"SELECT id FROM transactions WHERE merchant_name = 'other' ORDER BY id",
		).all<{ id: number }>();
		await env.DB.prepare(
			"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id IN (?, ?)",
		)
			.bind(household, other.results[0]?.id ?? 0, other.results[1]?.id ?? 0)
			.run();
		const selected = await post("/transactions/select/category/save", {
			ids: `${ids[2]},${other.results[2]?.id ?? 0}`,
			category: String(groceries),
			back: "/transactions?select=1",
		});
		expect(
			selected.html.match(/Always use Groceries for rule-offer-store\?/g),
		).toHaveLength(1);
		expect(selected.html).toContain(
			"You&#39;ve picked Groceries for rule-offer-store 3 times.",
		);
		expect(selected.html).not.toContain("Always use Groceries for other?");
	});

	it("Yes makes the rule and recategorizes other rows without overwriting a person's choice", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
		)
			.bind(groceries, ids[0])
			.run();
		await env.DB.prepare(
			"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id IN (?, ?)",
		)
			.bind(groceries, ids[1], ids[2])
			.run();
		await env.DB.prepare(
			"UPDATE transactions SET category_id = NULL, category_source = NULL WHERE id = ?",
		)
			.bind(ids[3])
			.run();
		const offer = await post(`/transactions/${ids[3]}`, edit(groceries));
		const offerFields = [
			...offer.html.matchAll(
				/<input type="hidden" name="([^"]+)" value="([^"]*)"/g,
			),
		]
			.filter((match) =>
				["merchant_key", "category", "count", "back"].includes(match[1] ?? ""),
			)
			.reduce<Record<string, string>>((fields, match) => {
				fields[match[1] ?? ""] = match[2] ?? "";
				return fields;
			}, {});
		const yes = await post("/transactions/rule-offer", offerFields);
		expect(yes.res.status).toBe(200);
		expect(
			JSON.parse(yes.res.headers.get("HX-Trigger") ?? "{}").toast.message,
		).toBe(`Always use Groceries for ${merchant}.`);
		const rule = await env.DB.prepare(
			"SELECT default_category_id FROM merchants WHERE raw_name = ?",
		)
			.bind(merchant)
			.first<{ default_category_id: number }>();
		expect(rule?.default_category_id).toBe(groceries);
		const rows = await env.DB.prepare(
			"SELECT category_id, category_source FROM transactions WHERE merchant_name = ? ORDER BY id",
		)
			.bind(merchant)
			.all<{ category_id: number | null; category_source: string | null }>();
		expect(rows.results[0]).toMatchObject({
			category_id: groceries,
			category_source: "user",
		});
		expect(
			rows.results.slice(1).every((row) => row.category_id === groceries),
		).toBe(true);
		expect(offer.res.status).toBe(200);
	});

	it("Not now closes the panel without making a rule, and a later matching save asks again", async () => {
		for (const id of ids.slice(0, 3))
			await post(`/transactions/${id}`, edit(groceries));
		const panel = await post(`/transactions/${ids[3]}`, edit(groceries));
		const offerFields = [
			...panel.html.matchAll(
				/<input type="hidden" name="([^"]+)" value="([^"]*)"/g,
			),
		]
			.filter((match) =>
				["merchant_key", "category", "count", "back"].includes(match[1] ?? ""),
			)
			.reduce<Record<string, string>>((fields, match) => {
				fields[match[1] ?? ""] = match[2] ?? "";
				return fields;
			}, {});
		const ignored = await post("/transactions/rule-offer/dismiss", offerFields);
		expect(ignored.res.status).toBe(200);
		expect(ignored.html).not.toContain(
			"Always use Groceries for rule-offer-store?",
		);
		const rule = await env.DB.prepare(
			"SELECT default_category_id FROM merchants WHERE raw_name = ?",
		)
			.bind(merchant)
			.first<{ default_category_id: number | null }>();
		expect(rule?.default_category_id).toBeNull();
		await env.DB.prepare(
			"UPDATE transactions SET category_id = NULL, category_source = NULL WHERE id = ?",
		)
			.bind(ids[0])
			.run();
		const fifth = await post(`/transactions/${ids[0]}`, edit(groceries));
		expect(fifth.html).toContain("Always use Groceries for rule-offer-store?");
	});

	it("counts Organize and cash choices through the same transaction history", async () => {
		await env.DB.prepare("DELETE FROM transactions WHERE id IN (?, ?, ?)")
			.bind(ids[0], ids[1], ids[2])
			.run();
		await post("/transactions/organize", {
			category: String(groceries),
			group: merchant,
			name: merchant,
		});
		await env.DB.prepare(
			"UPDATE merchants SET default_category_id = NULL WHERE raw_name = ?",
		)
			.bind(merchant)
			.run();
		const cash = await post("/transactions/cash", {
			date: todayIn(DEFAULT_TIME_ZONE),
			amount: "10.00",
			merchant,
			category: String(groceries),
			note: "",
			back: "/transactions",
			entry_key: "123e4567-e89b-42d3-a456-426614174000",
		});
		expect(cash.html).not.toContain(
			"Always use Groceries for rule-offer-store?",
		);
	});
});
