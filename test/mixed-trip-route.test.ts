import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";

// The mixed-trip screens (#233, decision 113): the edit panel's quiet line, and the split that opens with Tally's
// guessed parts, dashed, with empty amounts. Route tests, so the rendered HTML is what a person sees.

const BASE = "http://tally.test";
const db = env.DB;
const today = todayIn(DEFAULT_TIME_ZONE);
// The guess line, as HTML: Hono escapes the apostrophe in "Tally's" to &#39;.
const GUESS_LINE = /Tally(?:'|&#39;)s guess: Groceries and Household/;
// The list behind the sheet has its own "Tally's guess: " words (an sr-only mark on a row), so a negative check
// looks for this split's categories in the guess line, not the bare words.
const ANY_GUESS = GUESS_LINE;

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

async function postSplit(id: number, fields: [string, string][]) {
	const res = await exports.default.fetch(`${BASE}/transactions/${id}/split`, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"HX-Request": "true",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams([
			["back", "/transactions"],
			...fields,
		]).toString(),
	});
	return { res, html: await res.text() };
}

/** The live line's reply to a form's current fields, as a person types or picks (#233). */
async function postLine(id: number, fields: [string, string][]) {
	const res = await exports.default.fetch(
		`${BASE}/transactions/${id}/split/line`,
		{
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams([
				["back", "/transactions"],
				...fields,
			]).toString(),
		},
	);
	return { res, html: await res.text() };
}

const categoryId = async (name: string) =>
	(
		await db
			.prepare("SELECT id FROM categories WHERE name = ?")
			.bind(name)
			.first<{ id: number }>()
	)?.id as number;

/** A $214.36 Costco trip with no person's category, that Jev says looks like Groceries and Household. */
async function mixedTrip(over: Record<string, unknown> = {}): Promise<number> {
	const groceries = await categoryId("Groceries");
	const household = await categoryId("Household");
	const values: Record<string, unknown> = {
		category_id: null,
		category_source: null,
		category_confidence: 0.6,
		jev_category_id: groceries,
		jev_mixed: 0.9,
		jev_also_category_id: household,
		...over,
	};
	const columns = [
		"account_id",
		"date",
		"amount_cents",
		"raw_name",
		"merchant_name",
		...Object.keys(values),
	];
	const row = await db
		.prepare(
			`INSERT INTO transactions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING id`,
		)
		.bind(
			1,
			today,
			21436,
			"COSTCO WHSE 1186",
			"Costco",
			...Object.values(values),
		)
		.first<{ id: number }>();
	return row?.id as number;
}

beforeEach(async () => {
	await resetDemo(db, today);
	await saveAiSwitches(db, { details: false });
});

describe("the edit panel's line (#233)", () => {
	it("shows the quiet line and a link that opens the split, on a trip that looks mixed", async () => {
		const id = await mixedTrip();
		const { html } = await get(`/transactions/${id}`);
		expect(html).toContain("This trip looks like Groceries and Household.");
		expect(html).toContain(`/transactions/${id}/split?back=`);
		expect(html).toContain("Split this one?");
	});

	it("shows no line when Jev's probability is below the threshold", async () => {
		const id = await mixedTrip({ jev_mixed: 0.79 });
		const { html } = await get(`/transactions/${id}`);
		expect(html).not.toContain("This trip looks like");
	});

	it("shows no line once a person has chosen the trip's category", async () => {
		const groceries = await categoryId("Groceries");
		const id = await mixedTrip({
			category_id: groceries,
			category_source: "user",
			category_confidence: null,
		});
		const { html } = await get(`/transactions/${id}`);
		expect(html).not.toContain("This trip looks like");
	});

	it("shows no line on a trip Jev didn't say looks mixed", async () => {
		const id = await mixedTrip({ jev_mixed: null, jev_also_category_id: null });
		const { html } = await get(`/transactions/${id}`);
		expect(html).not.toContain("This trip looks like");
		expect(html).not.toContain("Split this one?");
	});
});

describe("the split form with Tally's guessed parts (#233)", () => {
	it("opens with the two categories dashed, amounts empty and the guess line", async () => {
		const id = await mixedTrip();
		const { html } = await get(
			`/transactions/${id}/split?back=%2Ftransactions`,
		);
		expect(html).toMatch(GUESS_LINE);
		expect(html).toMatch(/id="part-category-0"[^>]*border-dashed/);
		expect(html).toMatch(/id="part-category-1"[^>]*border-dashed/);
		expect(html).toContain("$214.36 left to assign");
	});

	it("draws no guess on a trip that doesn't look mixed, and never fills an amount from Jev", async () => {
		const plain = await mixedTrip({
			jev_mixed: 0.2,
			jev_also_category_id: null,
		});
		const { html } = await get(
			`/transactions/${plain}/split?back=%2Ftransactions`,
		);
		expect(html).not.toMatch(ANY_GUESS);
		expect(html).not.toMatch(/id="part-category-0"[^>]*border-dashed/);

		const mixed = await mixedTrip();
		const again = await get(
			`/transactions/${mixed}/split?back=%2Ftransactions`,
		);
		expect(again.html).not.toMatch(/name="part_amount"[^>]*value="[1-9]/);
	});

	it("can't be saved until the parts add up, and a part is solid once its amount is typed", async () => {
		const groceries = await categoryId("Groceries");
		const household = await categoryId("Household");
		const id = await mixedTrip();
		const typed = await postSplit(id, [
			["part_category", String(groceries)],
			["part_category", String(household)],
			["part_guess", String(groceries)],
			["part_guess", String(household)],
			["part_amount", "144.36"],
			["part_amount", ""],
		]);
		expect(typed.res.status).toBe(422);
		// The typed part is solid; the untyped one is still Tally's guess, so the guess line stays.
		expect(typed.html).toMatch(GUESS_LINE);
		expect(typed.html).not.toMatch(/id="part-category-0"[^>]*border-dashed/);
		expect(typed.html).toMatch(/id="part-category-1"[^>]*border-dashed/);
		const still = await db
			.prepare("SELECT is_split FROM transactions WHERE id = ?")
			.bind(id)
			.first<{ is_split: number }>();
		expect(still?.is_split).toBe(0);
	});

	it("saves the split once the parts add up exactly", async () => {
		const groceries = await categoryId("Groceries");
		const household = await categoryId("Household");
		const id = await mixedTrip();
		const saved = await postSplit(id, [
			["part_category", String(groceries)],
			["part_category", String(household)],
			["part_guess", String(groceries)],
			["part_guess", String(household)],
			["part_amount", "144.36"],
			["part_amount", "70.00"],
		]);
		expect(saved.res.status).toBe(200);
		const parts = await db
			.prepare(
				"SELECT category_id AS categoryId, amount_cents AS amountCents FROM transactions WHERE parent_id = ? ORDER BY id",
			)
			.bind(id)
			.all<{ categoryId: number; amountCents: number }>();
		expect(parts.results.map((p) => [p.categoryId, p.amountCents])).toEqual([
			[groceries, 14436],
			[household, 7000],
		]);
	});

	it("ignores a posted guess on a trip that doesn't look mixed", async () => {
		const groceries = await categoryId("Groceries");
		const plain = await mixedTrip({
			jev_mixed: null,
			jev_also_category_id: null,
		});
		const { html } = await postSplit(plain, [
			["part_category", String(groceries)],
			["part_category", String(groceries)],
			["part_guess", String(groceries)],
			["part_guess", String(groceries)],
			["part_amount", ""],
			["part_amount", ""],
		]);
		expect(html).not.toMatch(ANY_GUESS);
		expect(html).not.toMatch(/id="part-category-0"[^>]*border-dashed/);
	});
});

/** The whole element with this id, from its opening tag to its closing tag, as the reply draws it. */
function elementWithId(html: string, id: string, tag: string): string {
	return (
		html.match(
			new RegExp(`<${tag}\\b[^>]*\\sid="${id}"[\\s\\S]*?</${tag}>`),
		)?.[0] ?? ""
	);
}

/** The opening tag of the element with this id, as the reply draws it. */
function openingTagWithId(html: string, id: string): string {
	return (
		html.match(new RegExp(`<[a-z]+\\b[^>]*\\sid="${id}"[^>]*>`))?.[0] ?? ""
	);
}

describe("the live line redraws the parts as a person types or picks (#233)", () => {
	it("turns a part solid once its amount is typed, and the other part stays Tally's guess", async () => {
		const groceries = await categoryId("Groceries");
		const household = await categoryId("Household");
		const id = await mixedTrip();
		const { res, html } = await postLine(id, [
			["part_category", String(groceries)],
			["part_category", String(household)],
			["part_guess", String(groceries)],
			["part_guess", String(household)],
			["part_amount", "144.36"],
			["part_amount", ""],
		]);
		expect(res.status).toBe(200);
		const first = elementWithId(html, "part-category-0", "select");
		expect(first).toContain('hx-swap-oob="outerHTML"');
		expect(first).not.toContain("border-dashed");
		expect(first).not.toContain("autofocus");
		expect(elementWithId(html, "part-category-1", "select")).toContain(
			"border-dashed",
		);
		expect(html).toContain("$70.00 left to assign");
	});

	it("turns a part solid once its category is changed, keeping the picked category selected", async () => {
		const groceries = await categoryId("Groceries");
		const household = await categoryId("Household");
		const id = await mixedTrip();
		const { html } = await postLine(id, [
			["part_category", String(household)],
			["part_category", String(household)],
			["part_guess", String(groceries)],
			["part_guess", String(household)],
			["part_amount", ""],
			["part_amount", ""],
		]);
		const first = elementWithId(html, "part-category-0", "select");
		expect(first).not.toContain("border-dashed");
		expect(first).toMatch(new RegExp(`<option value="${household}" selected`));
		expect(elementWithId(html, "part-category-1", "select")).toContain(
			"border-dashed",
		);
		// The label a screen reader hears follows the same state.
		const label = elementWithId(html, "part-label-0", "label");
		expect(label).toContain("Part 1 category");
		expect(label).not.toContain("Tally's guess");
	});

	it("takes the guess line away once no part is a guess, and keeps it while one is", async () => {
		const groceries = await categoryId("Groceries");
		const household = await categoryId("Household");
		const id = await mixedTrip();
		const one = await postLine(id, [
			["part_category", String(groceries)],
			["part_category", String(household)],
			["part_guess", String(groceries)],
			["part_guess", String(household)],
			["part_amount", "144.36"],
			["part_amount", ""],
		]);
		expect(openingTagWithId(one.html, "split-guess")).not.toContain("hidden");
		const both = await postLine(id, [
			["part_category", String(groceries)],
			["part_category", String(household)],
			["part_guess", String(groceries)],
			["part_guess", String(household)],
			["part_amount", "144.36"],
			["part_amount", "70.00"],
		]);
		expect(openingTagWithId(both.html, "split-guess")).toContain("hidden");
	});

	it("draws no out-of-band parts on a trip that doesn't look mixed", async () => {
		const groceries = await categoryId("Groceries");
		const plain = await mixedTrip({
			jev_mixed: null,
			jev_also_category_id: null,
		});
		const { res, html } = await postLine(plain, [
			["part_category", String(groceries)],
			["part_category", String(groceries)],
			["part_guess", String(groceries)],
			["part_guess", String(groceries)],
			["part_amount", "10.00"],
			["part_amount", ""],
		]);
		expect(res.status).toBe(200);
		expect(html).toContain("left to assign");
		expect(html).not.toContain("hx-swap-oob");
	});
});
