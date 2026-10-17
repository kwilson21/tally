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

/** The markup from the card's sentence to the end of its form, so a check reads only the card. */
function cardMarkup(html: string, sentence: string): string {
	const start = html.indexOf(sentence);
	expect(start).toBeGreaterThan(-1);
	return html.slice(start, html.indexOf("</form>", start));
}

describe("Settings: one card, and No asks in its place", () => {
	it("draws the one card, with Create and No and no Dismiss", async () => {
		const { html } = await get("/settings/categories");
		expect(html).toContain("A new category: Pet Care");
		expect(html).toContain(">Create Pet Care<");
		expect(html).toContain(">No<");
		expect(html).not.toContain("Dismiss");
		expect(html).not.toContain("Suggested: Pet Care");
	});

	it("has no Skip in the card: Skip is the Suggestions page's alone", async () => {
		const { html } = await get("/settings/categories");
		expect(cardMarkup(html, "A new category: Pet Care")).not.toContain("Skip");
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

/** The markup of the card's whole form, hidden fields included, so a check reads only that card. */
function formMarkup(html: string, sentence: string): string {
	const at = html.indexOf(sentence);
	expect(at).toBeGreaterThan(-1);
	return html.slice(html.lastIndexOf("<form", at), html.indexOf("</form>", at));
}

describe("Settings: the question is drawn where the No's card was", () => {
	let tutoring: number;

	beforeEach(async () => {
		// Pet Care has two purchases and Tutoring has one, so Pet Care is listed first.
		tutoring = (
			await env.DB.prepare(
				"INSERT INTO category_suggestions (name, status) VALUES ('Tutoring', 'pending') RETURNING id",
			).first<{ id: number }>()
		)?.id as number;
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 4500, 'TUTOR HUB 77', 'Tutor Hub', 1, ?)",
		)
			.bind(`${THIS}-08`, tutoring)
			.run();
	});

	it("each card's form sends its place, by its order in the list", async () => {
		const { html } = await get("/settings/categories");
		expect(formMarkup(html, "A new category: Pet Care")).toContain(
			'name="place" value="0"',
		);
		expect(formMarkup(html, "A new category: Tutoring")).toContain(
			'name="place" value="1"',
		);
	});

	it("No on the first card draws the question before the second card", async () => {
		const { html } = await post(`/settings/suggestions/${suggestion}/dismiss`, [
			["place", "0"],
		]);
		const question = html.indexOf("Don&#39;t suggest Pet Care again for");
		expect(question).toBeGreaterThan(-1);
		expect(question).toBeLessThan(html.indexOf("A new category: Tutoring"));
	});

	it("No on the second card draws the question after the first card", async () => {
		const { html } = await post(`/settings/suggestions/${tutoring}/dismiss`, [
			["place", "1"],
		]);
		const question = html.indexOf("Don&#39;t suggest Tutoring again for");
		expect(question).toBeGreaterThan(html.indexOf("A new category: Pet Care"));
	});

	it("with no place, or a place past the end, draws the question after every card", async () => {
		const none = await post(`/settings/suggestions/${suggestion}/dismiss`, []);
		expect(none.res.status).toBe(200);
		expect(
			none.html.indexOf("Don&#39;t suggest Pet Care again for"),
		).toBeGreaterThan(none.html.indexOf("A new category: Tutoring"));
		const past = await post(`/settings/suggestions/${tutoring}/dismiss`, [
			["place", "99"],
		]);
		expect(past.res.status).toBe(200);
		expect(
			past.html.indexOf("Don&#39;t suggest Tutoring again for"),
		).toBeGreaterThan(past.html.indexOf("A new category: Pet Care"));
	});

	it("with more than ten waiting, the question still comes before a card that moved up into the list", async () => {
		// Ten are listed, so Extra 9 waits behind the limit until Pet Care is answered and moves up.
		for (let i = 1; i <= 9; i++) {
			const id = (
				await env.DB.prepare(
					"INSERT INTO category_suggestions (name, status) VALUES (?, 'pending') RETURNING id",
				)
					.bind(`Extra ${i}`)
					.first<{ id: number }>()
			)?.id as number;
			await env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 1000, ?, ?, 1, ?)",
			)
				.bind(`${THIS}-09`, `EXTRA ${i}`, `Extra ${i}`, id)
				.run();
		}
		const { html } = await post(`/settings/suggestions/${suggestion}/dismiss`, [
			["place", "0"],
		]);
		const question = html.indexOf("Don&#39;t suggest Pet Care again for");
		expect(question).toBeLessThan(html.indexOf("A new category: Tutoring"));
		expect(question).toBeLessThan(html.indexOf("A new category: Extra 9"));
	});
});

describe("the suggested name is tidied the same on every surface", () => {
	beforeEach(async () => {
		// tidyName leaves "Pet Care" as it is, so only stored capitals show whether a surface tidies the name.
		await env.DB.prepare(
			"UPDATE category_suggestions SET name = 'PET CARE' WHERE id = ?",
		)
			.bind(suggestion)
			.run();
	});

	it("Settings' card reads Pet care, as Organize and the Suggestions page do", async () => {
		const { html } = await get("/settings/categories");
		expect(html).toContain("A new category: Pet care");
		expect(html).toContain(">Create Pet care<");
		expect(html).not.toContain("PET CARE");
	});

	it("No asks about Pet care, not the stored capitals", async () => {
		const { html } = await post(
			`/settings/suggestions/${suggestion}/dismiss`,
			[],
		);
		expect(html).toContain("Don&#39;t suggest Pet care again for");
		expect(html).not.toContain("PET CARE");
	});

	it("the No's toast says Pet care when no purchase is left to ask about", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 1, category_source = 'user' WHERE category_suggestion_id = ?",
		)
			.bind(suggestion)
			.run();
		const { res, html } = await post(
			`/settings/suggestions/${suggestion}/dismiss`,
			[],
		);
		expect(res.headers.get("HX-Trigger")).toContain(
			"Tally won't suggest Pet care again.",
		);
		expect(html).not.toContain("PET CARE");
	});

	it("Organize and the Suggestions page read Pet care too", async () => {
		const organize = await get("/transactions/organize");
		expect(organize.html).toContain(
			"Tally suggested a new category for this and 1 more: Pet care",
		);
		const page = await get("/settings/suggestions");
		expect(page.html).toContain("A new category: Pet care");
		expect(page.html).not.toContain("PET CARE");
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

describe("Suggestions page: Skip stays on this page", () => {
	it("draws Skip after the card's form, not inside the card", async () => {
		const { html } = await get("/settings/suggestions");
		const sentence = "A new category: Pet Care";
		const close = html.indexOf("</form>", html.indexOf(sentence));
		expect(html.indexOf(">Skip<", close)).toBeGreaterThan(close);
		expect(cardMarkup(html, sentence)).not.toContain("Skip");
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

	it("counts a merchant once, however many of its purchases the suggestion holds", async () => {
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 1500, 'PETSMART 0412', 'Petsmart', 1, ?)",
		)
			.bind(`${THIS}-03`, suggestion)
			.run();
		const { html } = await get("/transactions/organize");
		expect(html).toContain('name="group" value="Chewy"');
		expect(html).toContain(
			"Tally suggested a new category for this and 1 more: Pet Care",
		);
	});

	it("counts each other merchant once, however many purchases it has", async () => {
		// Two Banfield charges are two purchases of one other merchant: the card counts the merchant, not the charges.
		for (const day of ["04", "05"])
			await env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 1000, 'BANFIELD PET HOSPITAL', 'Banfield Pet Hospital', 1, ?)",
			)
				.bind(`${THIS}-${day}`, suggestion)
				.run();
		const { html } = await get("/transactions/organize");
		expect(html).toContain('name="group" value="Chewy"');
		expect(html).toContain(
			"Tally suggested a new category for this and 2 more: Pet Care",
		);
	});

	it("counts two purchases Organize shows under one name as one merchant", async () => {
		// No Plaid name, so the key is the bank text; its tidied name is Petsmart, the name Organize's group shows.
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 1500, 'PETSMART 0598', NULL, 1, ?)",
		)
			.bind(`${THIS}-07`, suggestion)
			.run();
		const { html } = await get("/transactions/organize");
		expect(html).toContain('name="group" value="Chewy"');
		expect(html).toContain(
			"Tally suggested a new category for this and 1 more: Pet Care",
		);
	});

	it("shows the sentence as the card's one headline, and no Skip in the card", async () => {
		const { html } = await get("/transactions/organize");
		const sentence =
			"Tally suggested a new category for this and 1 more: Pet Care";
		expect(html).toContain(`<h2 class="text-lg">${sentence}</h2>`);
		expect(cardMarkup(html, sentence)).not.toContain("Skip");
	});

	it("shows no card for the first merchant when it is not in the waiting suggestion", async () => {
		// Costco has two charges, so its group sorts first (most charges first) and is the one on screen.
		for (const day of ["01", "03"]) {
			await env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit) VALUES (1, ?, 9000, 'COSTCO WHSE', 'Costco', 1)",
			)
				.bind(`${THIS}-${day}`)
				.run();
		}
		const { html } = await get("/transactions/organize");
		expect(html).toContain('name="group" value="Costco"');
		expect(html).not.toContain("Tally suggested a new category");
		expect(html).not.toContain(">Create Pet Care<");
	});

	it("shows no card once the suggestion is answered", async () => {
		await post(`/settings/suggestions/${suggestion}/dismiss`, []);
		const { html } = await get("/transactions/organize");
		expect(html).not.toContain("Tally suggested a new category");
	});

	it("queues the card's Create and Organize's Save on one request queue, so a second submit is dropped", async () => {
		const { html } = await get("/transactions/organize");
		const forms = [
			...html.matchAll(/<form\b[^>]*hx-post="[^"]+"[^>]*>[\s\S]*?<\/form>/g),
		].map((match) => match[0]);
		expect(forms).toHaveLength(2);
		for (const form of forms) {
			expect(form).toContain('hx-sync="#organize-page:drop"');
			expect(form).toContain('hx-disable="#organize-page button[type=submit]"');
		}
	});

	it("draws the card for Chewy, the first on screen, with many other waiting suggestions behind it", async () => {
		// Each other suggestion is one charge from a merchant whose name sorts after Chewy and Petsmart, so Chewy stays first.
		for (let i = 1; i <= 50; i++) {
			const id = (
				await env.DB.prepare(
					"INSERT INTO category_suggestions (name, status) VALUES (?, 'pending') RETURNING id",
				)
					.bind(`Zed ${i}`)
					.first<{ id: number }>()
			)?.id as number;
			await env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 1000, ?, ?, 1, ?)",
			)
				.bind(
					`${THIS}-09`,
					`ZED ${i}`,
					`Zeta ${String(i).padStart(2, "0")}`,
					id,
				)
				.run();
		}
		const { html } = await get("/transactions/organize");
		expect(html).toContain('name="group" value="Chewy"');
		expect(html).toContain(
			"Tally suggested a new category for this and 1 more: Pet Care",
		);
		expect(html).toContain(`name="suggestion" value="${suggestion}"`);
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
			["shown", String(chewy)],
			["shown", String(petsmart)],
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

	it("an answer for a suggestion already answered says it changed, as Settings says", async () => {
		await post(`/settings/suggestions/${suggestion}/dismiss`, []);
		const { res } = await post("/transactions/organize/suggestion", [
			["suggestion", String(suggestion)],
			["shown", String(chewy)],
			["shown", String(petsmart)],
		]);
		expect(res.headers.get("HX-Trigger")).toContain(
			"That suggestion was changed somewhere else. Here's the current list.",
		);
	});

	it("Create answers that the suggestion changed when another tab saved one of its purchases", async () => {
		await env.DB.prepare(
			`CREATE TRIGGER file_during_create AFTER UPDATE OF decided_at ON category_suggestions WHEN NEW.status='pending' AND OLD.status='pending' AND NEW.decided_at IS NOT NULL BEGIN UPDATE transactions SET category_id = 1, category_source = 'user' WHERE id = ${petsmart}; END`,
		).run();
		const { res, html } = await post("/transactions/organize/suggestion", [
			["suggestion", String(suggestion)],
			["shown", String(chewy)],
			["shown", String(petsmart)],
		]);
		await env.DB.prepare("DROP TRIGGER file_during_create").run();
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toContain(
			"That suggestion was changed somewhere else. Here's the current list.",
		);
		expect(res.headers.get("HX-Trigger")).not.toContain("Tick at least one");
		expect(html).toContain('id="organize-page"');
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM categories WHERE name = 'Pet Care'",
			),
		).toBe(0);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM transactions WHERE id = ${chewy} AND category_id IS NULL AND category_suggestion_id = ${suggestion}`,
			),
		).toBe(1);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM category_suggestions WHERE id = ${suggestion} AND status = 'pending' AND decided_at IS NULL`,
			),
		).toBe(1);
	});

	it("Create without JavaScript leaves Organize's address", async () => {
		const { res } = await post(
			"/transactions/organize/suggestion",
			[
				["suggestion", String(suggestion)],
				["shown", String(chewy)],
				["shown", String(petsmart)],
			],
			false,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/transactions/organize");
	});
});

/** The fields Organize's card posts: its suggestion, and each purchase it showed. */
const fields = (...shown: number[]): [string, string][] => [
	["suggestion", String(suggestion)],
	...shown.map((id): [string, string] => ["shown", String(id)]),
];

const CHANGED =
	"That suggestion was changed somewhere else. Here's the current list.";
/** The changed words under Organize's heading, as they are drawn without a card for the suggestion (decision 120). */
const CHANGED_LINE = `<p role="alert" class="mt-3 text-sm text-over">${CHANGED.replace("'", "&#39;")}</p>`;

/** Costco has two charges, so its group sorts first: the one on screen, with no card for it. */
async function costcoFirst() {
	for (const day of ["01", "03"])
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit) VALUES (1, ?, 9000, 'COSTCO WHSE', 'Costco', 1)",
		)
			.bind(`${THIS}-${day}`)
			.run();
}

describe("Organize: Create files only the purchases the card showed", () => {
	it("the card carries one hidden shown for each purchase it counts", async () => {
		const { html } = await get("/transactions/organize");
		const card = cardMarkup(html, "Tally suggested a new category");
		expect(card).toContain(`name="shown" value="${chewy}"`);
		expect(card).toContain(`name="shown" value="${petsmart}"`);
	});

	it("files nothing, and draws the card with every purchase, when one was added after the card was drawn", async () => {
		await get("/transactions/organize");
		const third = (
			await env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 500, 'CHEWY.COM', 'Chewy', 1, ?) RETURNING id",
			)
				.bind(`${THIS}-06`, suggestion)
				.first<{ id: number }>()
		)?.id as number;
		const { res, html } = await post(
			"/transactions/organize/suggestion",
			fields(chewy, petsmart),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toContain(CHANGED);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM categories WHERE name = 'Pet Care'",
			),
		).toBe(0);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM transactions WHERE id IN (${chewy}, ${petsmart}, ${third}) AND category_id IS NULL AND category_suggestion_id = ${suggestion}`,
			),
		).toBe(3);
		const card = cardMarkup(html, "Tally suggested a new category");
		for (const id of [chewy, petsmart, third])
			expect(card).toContain(`name="shown" value="${id}"`);
	});

	it("files nothing when a purchase was filed elsewhere after the card was drawn", async () => {
		await get("/transactions/organize");
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 1, category_source = 'user' WHERE id = ?",
		)
			.bind(petsmart)
			.run();
		const { res } = await post(
			"/transactions/organize/suggestion",
			fields(chewy, petsmart),
		);
		expect(res.headers.get("HX-Trigger")).toContain(CHANGED);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM categories WHERE name = 'Pet Care'",
			),
		).toBe(0);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM transactions WHERE id = ${chewy} AND category_id IS NULL`,
			),
		).toBe(1);
	});

	it("says it changed, and files nothing, when the card sent no purchases", async () => {
		const { res } = await post("/transactions/organize/suggestion", fields());
		expect(res.headers.get("HX-Trigger")).toContain(CHANGED);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM categories WHERE name = 'Pet Care'",
			),
		).toBe(0);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM transactions WHERE id IN (${chewy}, ${petsmart}) AND category_id IS NULL`,
			),
		).toBe(2);
	});

	it("without JavaScript, shows the changed words as the card's error, and files nothing", async () => {
		const { res, html } = await post(
			"/transactions/organize/suggestion",
			fields(chewy),
			false,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Location")).toBeNull();
		expect(cardMarkup(html, "Tally suggested a new category")).toContain(
			'<p role="alert" class="text-sm text-over">That suggestion was changed somewhere else. Here&#39;s the current list.</p>',
		);
		// The words sit in the card, once: not again under Organize's heading.
		expect(html).not.toContain('class="mt-3 text-sm text-over"');
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM categories WHERE name = 'Pet Care'",
			),
		).toBe(0);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM transactions WHERE id IN (${chewy}, ${petsmart}) AND category_id IS NULL`,
			),
		).toBe(2);
	});
});

describe("Organize without JavaScript: a changed answer says so on the page", () => {
	it("says it changed in the card when another tab saved one of its purchases during Create, and files nothing", async () => {
		await env.DB.prepare(
			`CREATE TRIGGER file_during_create AFTER UPDATE OF decided_at ON category_suggestions WHEN NEW.status='pending' AND OLD.status='pending' AND NEW.decided_at IS NOT NULL BEGIN UPDATE transactions SET category_id = 1, category_source = 'user' WHERE id = ${petsmart}; END`,
		).run();
		const { res, html } = await post(
			"/transactions/organize/suggestion",
			fields(chewy, petsmart),
			false,
		).finally(() => env.DB.prepare("DROP TRIGGER file_during_create").run());
		expect(res.status).toBe(200);
		expect(res.headers.get("Location")).toBeNull();
		// chewy is still attached, so its card is drawn and the words sit in it, once, not under Organize's heading.
		expect(cardMarkup(html, "Tally suggested a new category")).toContain(
			'<p role="alert" class="text-sm text-over">That suggestion was changed somewhere else. Here&#39;s the current list.</p>',
		);
		expect(html).not.toContain('class="mt-3 text-sm text-over"');
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM categories WHERE name = 'Pet Care'",
			),
		).toBe(0);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM transactions WHERE id = ${chewy} AND category_id IS NULL AND category_suggestion_id = ${suggestion}`,
			),
		).toBe(1);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM category_suggestions WHERE id = ${suggestion} AND status = 'pending' AND decided_at IS NULL`,
			),
		).toBe(1);
	});

	it("says it changed when Create comes for a suggestion already answered, and draws no card", async () => {
		await post(`/settings/suggestions/${suggestion}/dismiss`, []);
		const { res, html } = await post(
			"/transactions/organize/suggestion",
			fields(chewy, petsmart),
			false,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Location")).toBeNull();
		expect(html).toContain(CHANGED_LINE);
		expect(html).not.toContain("Tally suggested a new category");
	});

	it("says it changed under the heading when no card is drawn for the purchases it showed", async () => {
		await costcoFirst();
		const { res, html } = await post(
			"/transactions/organize/suggestion",
			fields(chewy),
			false,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Location")).toBeNull();
		expect(html).toContain('name="group" value="Costco"');
		expect(html).toContain(CHANGED_LINE);
		expect(html).not.toContain("Tally suggested a new category");
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM transactions WHERE id IN (${chewy}, ${petsmart}) AND category_id IS NULL`,
			),
		).toBe(2);
	});

	it("says it changed when the suggestion is gone, without JavaScript", async () => {
		const { res, html } = await post(
			"/transactions/organize/suggestion",
			[
				["suggestion", "999999"],
				["shown", String(chewy)],
			],
			false,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Location")).toBeNull();
		expect(html).toContain(CHANGED_LINE);
	});
});

describe("Organize: a refused Create shows its reason in the card", () => {
	const FULL = "Tally has room for 50 categories. Archive one to add another.";

	beforeEach(async () => {
		// Fills Tally to its 50 active categories, as fillTo does in category-suggestions-db, so the Create is refused.
		const active =
			(await count(
				"SELECT COUNT(*) AS n FROM categories WHERE archived = 0",
			)) ?? 0;
		for (let i = active; i < 50; i++)
			await env.DB.prepare(
				"INSERT INTO categories (name, icon, color, sort_order) VALUES (?, 'tag', 'cat-blue', ?)",
			)
				.bind(`Filler ${i}`, 100 + i)
				.run();
	});

	it("without JavaScript, answers 422 with the reason under the card's headline, and files nothing", async () => {
		const { res, html } = await post(
			"/transactions/organize/suggestion",
			[
				["suggestion", String(suggestion)],
				["shown", String(chewy)],
				["shown", String(petsmart)],
			],
			false,
		);
		expect(res.status).toBe(422);
		expect(res.headers.get("Location")).toBeNull();
		expect(cardMarkup(html, "Tally suggested a new category")).toContain(
			`<p role="alert" class="text-sm text-over">${FULL}</p>`,
		);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM categories WHERE name = 'Pet Care'",
			),
		).toBe(0);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM transactions WHERE id IN (${chewy}, ${petsmart}) AND category_id IS NULL`,
			),
		).toBe(2);
	});

	it("without JavaScript, shows the reason under Organize's heading when no card is drawn for it", async () => {
		await costcoFirst();
		const { res, html } = await post(
			"/transactions/organize/suggestion",
			fields(chewy, petsmart),
			false,
		);
		expect(res.status).toBe(422);
		expect(html).toContain(
			`<p role="alert" class="mt-3 text-sm text-over">${FULL}</p>`,
		);
		expect(html).not.toContain("Tally suggested a new category");
	});

	it("with JavaScript, answers 422 with the same reason in the card, and no toast", async () => {
		const { res, html } = await post("/transactions/organize/suggestion", [
			["suggestion", String(suggestion)],
			["shown", String(chewy)],
			["shown", String(petsmart)],
		]);
		expect(res.status).toBe(422);
		expect(res.headers.get("HX-Trigger")).toBeNull();
		expect(cardMarkup(html, "Tally suggested a new category")).toContain(
			`<p role="alert" class="text-sm text-over">${FULL}</p>`,
		);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM categories WHERE name = 'Pet Care'",
			),
		).toBe(0);
	});
});
