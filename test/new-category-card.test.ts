import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";

// Decision 120 (P135 A): one suggestion card wherever Tally asks, with one set of answers. Settings' No retires the
// suggestion and asks decision 101's question in place; Organize's card creates the category and files its purchases.

const BASE = "http://tally.test";
const TODAY = todayIn(DEFAULT_TIME_ZONE);
const THIS = TODAY.slice(0, 7);

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

async function post(path: string, fields: [string, string][], hx = true) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			...(hx ? { "HX-Request": "true" } : {}),
		},
		body: new URLSearchParams(fields).toString(),
	});
	return { res, html: await res.text() };
}

let suggestion: number;
let chewy: number;
let petsmart: number;

beforeEach(async () => {
	await resetDemo(env.DB, TODAY);
	// Every demo transaction is filed and the demo's own suggestion goes, so this suggestion stands alone.
	await env.DB.batch([
		env.DB.prepare(
			"UPDATE transactions SET category_id = 1, category_source = 'user', category_suggestion_id = NULL",
		),
		env.DB.prepare("DELETE FROM category_suggestions"),
	]);
	suggestion = (
		await env.DB.prepare(
			"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', 'pending') RETURNING id",
		).first<{ id: number }>()
	)?.id as number;
	chewy = (
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 6412, 'CHEWY.COM', 'Chewy', 1, ?) RETURNING id",
		)
			.bind(`${THIS}-05`, suggestion)
			.first<{ id: number }>()
	)?.id as number;
	petsmart = (
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 2399, 'PETSMART 0412', 'Petsmart', 1, ?) RETURNING id",
		)
			.bind(`${THIS}-02`, suggestion)
			.first<{ id: number }>()
	)?.id as number;
});

const count = async (sql: string) =>
	(await env.DB.prepare(sql).first<{ n: number }>())?.n;

describe("Settings: one card, and No asks in its place", () => {
	it("draws the one card, with Create and No and no Dismiss", async () => {
		const { html } = await get("/settings/categories");
		expect(html).toContain("A new category: Pet Care");
		expect(html).toContain(">Create Pet Care<");
		expect(html).toContain(">No<");
		expect(html).not.toContain("Dismiss");
		expect(html).not.toContain("Suggested: Pet Care");
	});

	it("No retires the suggestion, and asks Don't suggest Pet Care again in the card's place", async () => {
		const { html } = await post(
			`/settings/suggestions/${suggestion}/dismiss`,
			[],
		);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM category_suggestions WHERE id = ${suggestion} AND status = 'dismissed'`,
			),
		).toBe(1);
		expect(html).toContain("Don&#39;t suggest Pet Care again for");
		expect(html).toContain(`value="new-${suggestion}"`);
		expect(html).toContain('value="ask_yes"');
		expect(html).toContain('value="ask_not_now"');
		expect(html).not.toContain("A new category: Pet Care");
		expect(html).not.toContain(">Create Pet Care<");
	});

	it("Yes writes one Never suggest line for each store the question asked about, and says so", async () => {
		const no = await post(`/settings/suggestions/${suggestion}/dismiss`, []);
		const stores = [...no.html.matchAll(/name="store" value="([^"]+)"/g)].map(
			(match) => match[1] as string,
		);
		expect(stores.length).toBe(2);
		const yes = await post(`/settings/suggestions/${suggestion}/dismiss`, [
			["answer", "ask_yes"],
			["id", `new-${suggestion}`],
			["kind", "new_category"],
			...stores.map((store): [string, string] => ["store", store]),
		]);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM never_suggest_rules WHERE kind = 'new_category'",
			),
		).toBe(2);
		expect(yes.res.headers.get("HX-Trigger")).toContain(
			"Tally won't suggest a new category for Chewy and Petsmart again",
		);
	});

	it("Not now writes no line and returns to Settings' categories", async () => {
		const no = await post(`/settings/suggestions/${suggestion}/dismiss`, []);
		const stores = [...no.html.matchAll(/name="store" value="([^"]+)"/g)].map(
			(match) => match[1] as string,
		);
		const notNow = await post(`/settings/suggestions/${suggestion}/dismiss`, [
			["answer", "ask_not_now"],
			["id", `new-${suggestion}`],
			["kind", "new_category"],
			...stores.map((store): [string, string] => ["store", store]),
		]);
		expect(notNow.res.status).toBe(200);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM never_suggest_rules WHERE kind = 'new_category'",
			),
		).toBe(0);
		expect(notNow.html).toContain('id="categories"');
	});

	it("an answer to a question that is no longer the one asked writes nothing", async () => {
		const stale = await post(`/settings/suggestions/${suggestion}/dismiss`, [
			["answer", "ask_yes"],
			["id", "new-999999"],
			["kind", "new_category"],
			["store", "CHEWY.COM"],
		]);
		expect(stale.res.status).toBe(404);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM never_suggest_rules WHERE kind = 'new_category'",
			),
		).toBe(0);
	});
});

describe("the card follows its own rule, not the Suggestions queue's switch", () => {
	it("No still asks with Guess categories off, since Settings' card is drawn whatever that switch says", async () => {
		await saveAiSwitches(env.DB, { categories: false });
		const { html } = await post(
			`/settings/suggestions/${suggestion}/dismiss`,
			[],
		);
		expect(html).toContain("Don&#39;t suggest Pet Care again for");
		await saveAiSwitches(env.DB, { categories: true });
	});

	it("says only that the name is not suggested again when no purchase is left to ask about", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 1, category_source = 'user' WHERE category_suggestion_id = ?",
		)
			.bind(suggestion)
			.run();
		const { res, html } = await post(
			`/settings/suggestions/${suggestion}/dismiss`,
			[],
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toContain(
			"Tally won't suggest Pet Care again.",
		);
		expect(html).not.toContain("Dismissed");
		expect(await count("SELECT COUNT(*) AS n FROM never_suggest_rules")).toBe(
			0,
		);
	});

	it("Organize's card shows with Guess categories off, as Settings' card does", async () => {
		await saveAiSwitches(env.DB, { categories: false });
		const { html } = await get("/transactions/organize");
		expect(html).toContain(
			"Tally suggested a new category for this and 1 more: Pet Care",
		);
		await saveAiSwitches(env.DB, { categories: true });
	});
});

describe("Suggestions page: the card's unticked note is kept", () => {
	it("saves the note under an unticked purchase with the answer", async () => {
		await post("/settings/suggestions", [
			["answer", "yes"],
			["id", `new-${suggestion}`],
			["shown", String(chewy)],
			["shown", String(petsmart)],
			["ticked", String(chewy)],
			[`note_${petsmart}`, "Pet food"],
		]);
		const row = await env.DB.prepare(
			"SELECT note, category_id FROM transactions WHERE id = ?",
		)
			.bind(petsmart)
			.first<{ note: string | null; category_id: number | null }>();
		expect(row?.note).toBe("Pet food");
		expect(row?.category_id).toBeNull();
	});
});

describe("Organize: the card above the chips", () => {
	it("shows the card for the merchant in the waiting suggestion, with the others counted", async () => {
		const { html } = await get("/transactions/organize");
		expect(html).toContain(
			"Tally suggested a new category for this and 1 more: Pet Care",
		);
		expect(html).toContain(">Create Pet Care<");
		expect(html).toContain('href="#organize-category"');
		expect(html).toContain('id="organize-category"');
		expect(html).toContain(`name="suggestion" value="${suggestion}"`);
		expect(html).not.toContain("Dismiss");
	});

	it("shows no card once the suggestion is answered", async () => {
		await post(`/settings/suggestions/${suggestion}/dismiss`, []);
		const { html } = await get("/transactions/organize");
		expect(html).not.toContain("Tally suggested a new category");
	});

	it("keeps Organize's Save form: the group, the category and the name", async () => {
		const { html } = await get("/transactions/organize");
		expect(html).toContain('action="/transactions/organize"');
		expect(html).toContain('name="group" value="Chewy"');
		expect(html).toContain('name="category"');
		expect(html).toContain('name="name"');
	});

	it("Create makes the category with the suggestion's purchases and files them", async () => {
		const { res, html } = await post("/transactions/organize/suggestion", [
			["suggestion", String(suggestion)],
		]);
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toContain(
			"Created Pet Care with 2 transactions",
		);
		expect(html).toContain('id="organize-page"');
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM categories WHERE name = 'Pet Care'",
			),
		).toBe(1);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM transactions WHERE id IN (${chewy}, ${petsmart}) AND category_source = 'user' AND category_id IS NOT NULL`,
			),
		).toBe(2);
	});

	it("Create without JavaScript leaves Organize's address", async () => {
		const { res } = await post(
			"/transactions/organize/suggestion",
			[["suggestion", String(suggestion)]],
			false,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/transactions/organize");
	});
});
