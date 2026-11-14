import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDemo } from "../src/demo/reset";
import baseline from "./fixtures/suggestions-edge-baseline.json";

// The Suggestions screen reads its numbers at the edge (#1006, PR 8). Each case below sends one input a person's
// browser can send to a freshly seeded screen and records what comes back: the status, the type, the Location, the
// HX-Trigger header, a hash of the page's body and a hash of the rows the answer can touch. The lines in
// fixtures/suggestions-edge-baseline.json were recorded on the code before the edge: every answer must stay the same.

const db = env.DB;
const BASE = "http://tally.test";
const PATH = "/settings/suggestions";
const VENMO = "VENMO PAYMENT";
const AUDIBLE = "AUDIBLE*TE3E10I7 WA";

/** The ids one scenario seeds, which a case's fields are written from. */
type Ctx = Record<string, number>;

type Value = string | string[] | File;

type Field = [string, Value];

type Scenario = "more" | "new" | "ask";

type Case =
	| { label: string; scenario: Scenario; query: (c: Ctx) => string }
	| { label: string; scenario: Scenario; fields: (c: Ctx) => Field[] };

const file = () => new File(["x"], "x.txt", { type: "text/plain" });

const readCase = (label: string, query: (c: Ctx) => string): Case => ({
	label,
	scenario: "more",
	query,
});

const moreCase = (label: string, fields: (c: Ctx) => Field[]): Case => ({
	label,
	scenario: "more",
	fields: (c) => [["answer", "more_add"], ...fields(c)],
});

const newCase = (label: string, fields: (c: Ctx) => Field[]): Case => ({
	label,
	scenario: "new",
	fields: (c) => [["answer", "yes"], ...fields(c)],
});

const askCase = (
	label: string,
	fields: (c: Ctx) => Field[],
	answer = "ask_yes",
): Case => ({
	label,
	scenario: "ask",
	fields: (c) => [["answer", answer], ...fields(c)],
});

const CASES: Case[] = [
	// The "N more look like this" card, drawn from the address.
	readCase("g-more-plain", (c) => String(c.filed)),
	readCase("g-more-zero-led", (c) => `0${c.filed}`),
	readCase("g-more-plus", (c) => `+${c.filed}`),
	readCase("g-more-point-zero", (c) => `${c.filed}.0`),
	readCase("g-more-space", (c) => ` ${c.filed}`),
	readCase("g-more-exponent", () => "1e3"),
	readCase("g-more-zero", () => "0"),
	readCase("g-more-words", () => "abc"),
	readCase("g-more-empty", () => ""),
	readCase("g-more-negative", () => "-1"),
	readCase("g-more-sixteen-digits", () => "1234567890123456"),
	readCase("g-more-fifteen-digits", () => "999999999999999"),
	readCase("g-more-hex", () => "0x7"),
	// Add the purchases that look like the one filed: the more and category numbers, and the ticked list.
	moreCase("m-good", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", String(c.peer)],
	]),
	moreCase("m-more-zero-led", (c) => [
		["more", `0${c.filed}`],
		["category", String(c.books)],
		["ticked", String(c.peer)],
	]),
	moreCase("m-more-plus", (c) => [
		["more", `+${c.filed}`],
		["category", String(c.books)],
		["ticked", String(c.peer)],
	]),
	moreCase("m-more-point-zero", (c) => [
		["more", `${c.filed}.0`],
		["category", String(c.books)],
		["ticked", String(c.peer)],
	]),
	moreCase("m-more-file", (c) => [
		["more", file()],
		["category", String(c.books)],
		["ticked", String(c.peer)],
	]),
	moreCase("m-more-huge", () => [
		["more", "1234567890123456"],
		["category", "1"],
		["ticked", "1"],
	]),
	moreCase("m-category-zero-led", (c) => [
		["more", String(c.filed)],
		["category", `0${c.books}`],
		["ticked", String(c.peer)],
	]),
	moreCase("m-category-point-zero", (c) => [
		["more", String(c.filed)],
		["category", `${c.books}.0`],
		["ticked", String(c.peer)],
	]),
	moreCase("m-category-space", (c) => [
		["more", String(c.filed)],
		["category", ` ${c.books}`],
		["ticked", String(c.peer)],
	]),
	moreCase("m-category-empty", (c) => [
		["more", String(c.filed)],
		["category", ""],
		["ticked", String(c.peer)],
	]),
	moreCase("m-category-file", (c) => [
		["more", String(c.filed)],
		["category", file()],
		["ticked", String(c.peer)],
	]),
	moreCase("m-ticked-zero", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", "0"],
	]),
	moreCase("m-ticked-zero-led", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", `0${c.peer}`],
	]),
	moreCase("m-ticked-plus", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", `+${c.peer}`],
	]),
	moreCase("m-ticked-space", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", ` ${c.peer} `],
	]),
	moreCase("m-ticked-point-zero", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", `${c.peer}.0`],
	]),
	moreCase("m-ticked-negative", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", `-${c.peer}`],
	]),
	moreCase("m-ticked-empty", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", ""],
	]),
	moreCase("m-ticked-duplicate", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", [String(c.peer), String(c.peer)]],
	]),
	moreCase("m-ticked-exponent", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", `${c.peer}e0`],
	]),
	moreCase("m-ticked-file", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", file()],
	]),
	moreCase("m-ticked-words-and-peer", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", ["abc", String(c.peer)]],
	]),
	moreCase("m-ticked-infinity", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", "Infinity"],
	]),
	moreCase("m-ticked-sixteen-digits", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", "1234567890123456"],
	]),
	moreCase("m-ticked-above-safe", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
		["ticked", "9007199254740993"],
	]),
	moreCase("m-ticked-none", (c) => [
		["more", String(c.filed)],
		["category", String(c.books)],
	]),
	// The new category's Yes: the shown and ticked lists, and the note under each shown purchase.
	newCase("n-good", (c) => [
		["id", `new-${c.sid}`],
		["shown", [String(c.pet0), String(c.pet1), String(c.pet2)]],
		["ticked", String(c.pet0)],
		[`note_${c.pet0}`, "a note"],
	]),
	newCase("n-shown-zero-led", (c) => [
		["id", `new-${c.sid}`],
		["shown", `0${c.pet0}`],
		["ticked", String(c.pet0)],
		[`note_${c.pet0}`, "a note"],
	]),
	newCase("n-shown-plus", (c) => [
		["id", `new-${c.sid}`],
		["shown", `+${c.pet0}`],
		["ticked", String(c.pet0)],
	]),
	newCase("n-shown-point-zero", (c) => [
		["id", `new-${c.sid}`],
		["shown", `${c.pet0}.0`],
		["ticked", String(c.pet0)],
	]),
	newCase("n-shown-space", (c) => [
		["id", `new-${c.sid}`],
		["shown", ` ${c.pet0}`],
		["ticked", String(c.pet0)],
	]),
	newCase("n-shown-exponent", (c) => [
		["id", `new-${c.sid}`],
		["shown", "1e3"],
		["ticked", String(c.pet0)],
	]),
	newCase("n-shown-file", (c) => [
		["id", `new-${c.sid}`],
		["shown", file()],
		["ticked", String(c.pet0)],
	]),
	newCase("n-shown-duplicate", (c) => [
		["id", `new-${c.sid}`],
		["shown", [String(c.pet0), String(c.pet0)]],
		["ticked", String(c.pet0)],
	]),
	newCase("n-shown-empty", (c) => [
		["id", `new-${c.sid}`],
		["ticked", String(c.pet0)],
	]),
	newCase("n-ticked-zero-led", (c) => [
		["id", `new-${c.sid}`],
		["shown", [String(c.pet0), String(c.pet1)]],
		["ticked", `0${c.pet1}`],
	]),
	newCase("n-ticked-plus", (c) => [
		["id", `new-${c.sid}`],
		["shown", [String(c.pet0), String(c.pet1)]],
		["ticked", `+${c.pet1}`],
	]),
	newCase("n-ticked-point-zero", (c) => [
		["id", `new-${c.sid}`],
		["shown", [String(c.pet0), String(c.pet1)]],
		["ticked", `${c.pet1}.0`],
	]),
	newCase("n-ticked-negative", (c) => [
		["id", `new-${c.sid}`],
		["shown", [String(c.pet0), String(c.pet1)]],
		["ticked", `-${c.pet1}`],
	]),
	newCase("n-ticked-zero", (c) => [
		["id", `new-${c.sid}`],
		["shown", [String(c.pet0)]],
		["ticked", "0"],
	]),
	newCase("n-ticked-file", (c) => [
		["id", `new-${c.sid}`],
		["shown", [String(c.pet0)]],
		["ticked", file()],
	]),
	newCase("n-ticked-huge", (c) => [
		["id", `new-${c.sid}`],
		["shown", [String(c.pet0)]],
		["ticked", "1000000000000000000000"],
	]),
	newCase("n-ticked-not-shown", (c) => [
		["id", `new-${c.sid}`],
		["shown", [String(c.pet0)]],
		["ticked", String(c.pet2)],
	]),
	newCase("n-id-zero-led", (c) => [
		["id", `new-0${c.sid}`],
		["shown", [String(c.pet0)]],
		["ticked", String(c.pet0)],
	]),
	// The question after a No: the digits after the item's kind word, its kind and its stores.
	askCase("a-good", (c) => [
		["id", `income-${c.inc}`],
		["kind", "income"],
		["store", VENMO],
	]),
	askCase("a-zero-led", (c) => [
		["id", `income-0${c.inc}`],
		["kind", "income"],
		["store", VENMO],
	]),
	askCase("a-many-zeros", (c) => [
		["id", `income-000${c.inc}`],
		["kind", "income"],
		["store", VENMO],
	]),
	askCase("a-plus", (c) => [
		["id", `income-+${c.inc}`],
		["kind", "income"],
		["store", VENMO],
	]),
	askCase("a-point-zero", (c) => [
		["id", `income-${c.inc}.0`],
		["kind", "income"],
		["store", VENMO],
	]),
	askCase("a-zero", () => [
		["id", "income-0"],
		["kind", "income"],
		["store", VENMO],
	]),
	askCase("a-sixteen-digits", () => [
		["id", "income-1234567890123456"],
		["kind", "income"],
		["store", VENMO],
	]),
	askCase("a-twenty-digits", () => [
		["id", "income-12345678901234567890"],
		["kind", "income"],
		["store", VENMO],
	]),
	askCase("a-above-safe", () => [
		["id", "income-9007199254740993"],
		["kind", "income"],
		["store", VENMO],
	]),
	askCase("a-kind-mismatch", (c) => [
		["id", `transfer-${c.inc}`],
		["kind", "income"],
		["store", VENMO],
	]),
	askCase("a-store-file", (c) => [
		["id", `income-${c.inc}`],
		["kind", "income"],
		["store", file()],
	]),
	askCase(
		"a-not-now",
		(c) => [
			["id", `income-${c.inc}`],
			["kind", "income"],
			["store", VENMO],
		],
		"ask_not_now",
	),
];

/** A category's id by its name, 0 when there is none. */
async function categoryId(name: string) {
	const row = await db
		.prepare("SELECT id FROM categories WHERE name = ?")
		.bind(name)
		.first<{ id: number }>();

	return row?.id ?? 0;
}

async function insertTx(fields: {
	raw: string;
	amount?: number;
	date?: string;
	incomeConfidence?: number;
	categoryConfidence?: number;
	jevCategoryId?: number;
	suggestionId?: number;
}): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name,
				income_confidence, category_confidence, jev_category_id, category_suggestion_id)
			VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), ?, ?, ?, ?, ?, ?, ?)
			RETURNING id`,
		)
		.bind(
			`plaid-${crypto.randomUUID()}`,
			fields.date ?? "2026-10-02",
			fields.amount ?? 1499,
			fields.raw,
			fields.incomeConfidence ?? null,
			fields.categoryConfidence ?? null,
			fields.jevCategoryId ?? null,
			fields.suggestionId ?? null,
		)
		.first<{ id: number }>();

	return row?.id ?? 0;
}

/** Seeds the screen for one scenario and returns the ids its cases write from. */
async function seed(scenario: Scenario): Promise<Ctx> {
	if (scenario === "more") {
		const filed = await insertTx({
			raw: AUDIBLE,
			categoryConfidence: 0.58,
			jevCategoryId: await categoryId("Eating Out"),
		});

		await post(PATH, [
			["id", `category-${filed}`],
			["answer", "create"],
			["new_name", "Books & audio"],
		]);
		const peer = await insertTx({ raw: AUDIBLE, date: "2026-10-05" });

		return { filed, peer, books: await categoryId("Books & audio") };
	}

	if (scenario === "new") {
		await db
			.prepare(
				`INSERT INTO merchants (raw_name, display_name) VALUES ('CHEWY.COM 1', 'Chewy'), ('PETSMART 22', 'Petsmart'), ('BANFIELD 5', 'Banfield')`,
			)
			.run();

		const sid =
			(
				await db
					.prepare(
						"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', 'pending') RETURNING id",
					)
					.first<{ id: number }>()
			)?.id ?? 0;

		const pet0 = await insertTx({
			raw: "CHEWY.COM 1",
			amount: 4500,
			suggestionId: sid,
		});

		const pet1 = await insertTx({
			raw: "PETSMART 22",
			amount: 3100,
			suggestionId: sid,
		});

		const pet2 = await insertTx({
			raw: "BANFIELD 5",
			amount: 8900,
			suggestionId: sid,
		});

		return { sid, pet0, pet1, pet2 };
	}

	await db
		.prepare(
			"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'Venmo')",
		)
		.bind(VENMO)
		.run();

	const inc = await insertTx({
		raw: VENMO,
		amount: -250000,
		incomeConfidence: 0.5,
	});
	// The question is asked after a No on the item (decision 101), as the screen asks it.

	await post(PATH, [
		["id", `income-${inc}`],
		["answer", "no"],
	]);

	return { inc };
}

/** A post as the screen's own form sends it: HTMX, the page's origin, and each value as a form entry. */
async function post(path: string, fields: Field[]) {
	const body = new FormData();

	for (const [name, value] of fields)
		for (const v of Array.isArray(value) ? value : [value])
			body.append(name, v);

	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: { Origin: BASE, "HX-Request": "true" },
		body,
	});

	return { res, html: await res.text() };
}

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path, {
		headers: { "HX-Request": "true" },
	});

	return { res, html: await res.text() };
}

async function sha(text: string) {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);

	return [...new Uint8Array(bytes)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 16);
}

/** The rows an answer can touch: the purchases, the Never suggest lines, the categories and the new categories. */
async function stateHash() {
	const [transactions, lines, categories, suggestions] = await Promise.all([
		db
			.prepare(
				"SELECT id, category_id, category_source, category_suggestion_id, note FROM transactions ORDER BY id",
			)
			.all(),
		db
			.prepare(
				"SELECT merchant_key, kind, decided_on FROM never_suggest_rules ORDER BY id",
			)
			.all(),
		db.prepare("SELECT id, name, archived FROM categories ORDER BY id").all(),
		db
			.prepare("SELECT id, name, status FROM category_suggestions ORDER BY id")
			.all(),
	]);

	return sha(
		JSON.stringify([
			transactions.results,
			lines.results,
			categories.results,
			suggestions.results,
		]),
	);
}

/** One line per case: the status, type, Location, toast header, page and state. */
async function recordLine(res: Response, html: string) {
	return [
		res.status,
		res.headers.get("content-type") ?? "-",
		res.headers.get("location") ?? "-",
		res.headers.get("HX-Trigger") ?? "-",
		`body ${await sha(html)}`,
		`state ${await stateHash()}`,
	].join(" | ");
}

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM never_suggest_rules"),
		db.prepare("DELETE FROM merchant_suggested_names"),
		db.prepare("DELETE FROM merchants"),
		db.prepare("DELETE FROM category_suggestions"),
	]);
});

describe("the Suggestions screen's answers, read at the edge (#1006, PR 8)", () => {
	it.each(CASES.map((kase) => [kase.label, kase] as const))(
		"%s keeps its answer",
		async (label, kase) => {
			const ctx = await seed(kase.scenario);

			const { res, html } =
				"query" in kase
					? await get(`${PATH}?more=${encodeURIComponent(kase.query(ctx))}`)
					: await post(PATH, kase.fields(ctx));

			const recorded: Record<string, string> = baseline;

			expect(await recordLine(res, html)).toBe(recorded[label]);
		},
	);
});
