import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { present } from "./helpers/present";

// The Settings routes read their id, token, category, place and list input at the edge (#1006, plan 5). The blocks
// below pin what each route answers for bad input (characterisation: written from today's answers, then kept), and the
// last block pins the intended differences: a leading zero, a space or an exponent in an id that Number() accepted.

const db = env.DB;
const BASE = "http://tally.test";
const TODAY = todayIn(DEFAULT_TIME_ZONE);

const CHANGED =
	"That suggestion was changed somewhere else. Here's the current list.";

type Field = [string, string | File];

/** A form post, multipart so a field can be a file part; a repeated key is repeated in the list. */
async function post(path: string, fields: Field[] = []) {
	const body = new FormData();

	for (const [key, value] of fields) body.append(key, value);

	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: { Origin: BASE, "HX-Request": "true" },
		body,
	});

	return { res, html: (await res.text()).replaceAll("&#39;", "'") };
}

type Trigger = {
	toast?: { message: string; type?: string; undoDone?: string };
	announce?: string;
};

const triggerOf = (res: Response): Trigger =>
	// SAFETY: HX-Trigger is the JSON the Settings routes write, with the toast and announce keys this type names.
	JSON.parse(res.headers.get("HX-Trigger") ?? "{}");

/** What a person sees from an answer: its status, its toast and announcement, and whether the list says it changed. */
async function seen(path: string, fields: Field[] = []) {
	const { res, html } = await post(path, fields);
	const trigger = triggerOf(res);

	return {
		status: res.status,
		toast: trigger.toast?.message ?? null,
		undoDone: trigger.toast?.undoDone ?? null,
		announce: trigger.announce ?? null,
		changed: html.includes(CHANGED),
	};
}

const count = async (sql: string) =>
	(await db.prepare(sql).first<{ n: number }>())?.n;

/** A value a test builds once the setup has run, so it can name a row the setup made. */
type Input = (id: number) => string | File | undefined;

const NOT_A_NUMBER: [string, Input][] = [
	["abc", () => "abc"],
	["empty", () => ""],
	["absent", () => undefined],
	["zero", () => "0"],
	["minus one", () => "-1"],
	["a decimal", () => "1.5"],
	["an exponent", () => "1e3"],
	["hex", () => "0x1f"],
	["NaN", () => "NaN"],
	["Infinity", () => "Infinity"],
	["a 16-digit number", () => "1234567890123456"],
	["a 20-digit number", () => "99999999999999999999"],
	["a file part", () => new File(["5"], "id.txt")],
];

// --- Remove a "Never suggest" line -----------------------------------------------------------------------------------

const removePath = "/settings/never-suggest/remove";

const remove = (id: string | File | undefined) => {
	const fields: Field[] = [];

	if (id !== undefined) fields.push(["id", id]);

	return seen(removePath, [
		...fields,
		["merchant_key", "VENMO"],
		["kind", "income"],
		["rules_search", ""],
	]);
};

describe("never-suggest remove: the id that is no line's finds no line", () => {
	let line: number;

	beforeEach(async () => {
		await resetDemo(db, TODAY);
		line = present(
			await db
				.prepare(
					"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES ('VENMO', 'income', '2026-10-03') RETURNING id",
				)
				.first<{ id: number }>(),
		).id;
	});

	const NOT_REMOVED = {
		status: 200,
		toast: null,
		undoDone: null,
		announce: "Tally's rules list updated.",
		changed: false,
	};

	it.each(NOT_A_NUMBER)(
		"keeps the line for %s and answers the rules page",
		async (_label, input) => {
			const got = await remove(input(line));

			expect(got).toEqual(NOT_REMOVED);
			expect(await count("SELECT COUNT(*) AS n FROM never_suggest_rules")).toBe(
				1,
			);
		},
	);

	it("removes the line for its own id, and says so", async () => {
		const got = await remove(String(line));

		expect(got).toMatchObject({
			status: 200,
			toast: "Removed. Tally can suggest that again.",
		});
		expect(await count("SELECT COUNT(*) AS n FROM never_suggest_rules")).toBe(
			0,
		);
	});

	it("keeps the line when the id is right but the store is not", async () => {
		const got = await seen(removePath, [
			["id", String(line)],
			["merchant_key", "CHEWY"],
			["kind", "income"],
		]);

		expect(got).toEqual(NOT_REMOVED);
		expect(await count("SELECT COUNT(*) AS n FROM never_suggest_rules")).toBe(
			1,
		);
	});
});

// --- Undo of a Forget -------------------------------------------------------------------------------------------------

const undoPath = "/settings/learned/undo";

/** A Forget written two seconds ago, so its Undo is still open. */
async function freshForget(): Promise<number> {
	const row = await db
		.prepare(
			"INSERT INTO forgotten_texts (cleaned_text, forgotten_at) VALUES ('netflix.com', strftime('%Y-%m-%d %H:%M:%f', 'now', '-2 seconds')) RETURNING id",
		)
		.first<{ id: number }>();

	return present(row).id;
}

const undo = (token: string | File | undefined) =>
	seen(undoPath, token === undefined ? [] : [["token", token]]);

const forgotten = () => count("SELECT COUNT(*) AS n FROM forgotten_texts");

describe("learned undo: a token that is no Forget's number finds no row", () => {
	beforeEach(async () => {
		await resetDemo(db, TODAY);
		await db.prepare("DELETE FROM forgotten_texts").run();
	});

	it("gives the line back for its own number, and echoes the token", async () => {
		const id = await freshForget();
		const got = await undo(String(id));

		expect(got).toMatchObject({
			status: 200,
			toast: "Forget undone. Tally has that line back.",
			undoDone: String(id),
		});
		expect(await forgotten()).toBe(0);
	});

	it.each(NOT_A_NUMBER)(
		"refuses %s as an Undo that has closed, and keeps the Forget",
		async (_label, input) => {
			const id = await freshForget();
			const got = await undo(input(id));

			expect(got.status).toBe(200);
			expect(got.toast).toBe("Nothing to undo.");
			expect(await forgotten()).toBe(1);
		},
	);

	it("echoes a token that is not a number as posted", async () => {
		await freshForget();
		const got = await undo("abc");

		expect(got.undoDone).toBe("abc");
	});

	it("echoes an empty token as empty", async () => {
		await freshForget();
		const got = await undo("");

		expect(got.undoDone).toBe("");
	});
});

// --- Change a learned line's category ---------------------------------------------------------------------------------

const changePath = "/settings/learned/change";

async function learnedLine() {
	await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, category_id, category_source)
			VALUES ('learned-netflix', (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', 1499, 'NETFLIX.COM', (SELECT id FROM categories WHERE name = 'Entertainment'), 'user')`,
		)
		.run();
}

const change = (category: string | File | undefined) => {
	const fields: Field[] = [["text", "netflix.com"]];

	if (category !== undefined) fields.push(["category", category]);

	return seen(changePath, fields);
};

describe("learned change: a category that is no category is refused", () => {
	let entertainment: number;

	beforeEach(async () => {
		await resetDemo(db, TODAY);
		await db.batch([
			db.prepare(
				"INSERT OR IGNORE INTO categories (name, name_key, icon, color, sort_order) VALUES ('Entertainment', 'entertainment', 'entertainment', 'cat-blue', 90)",
			),
			db.prepare("DELETE FROM transactions"),
		]);
		await learnedLine();
		entertainment = present(
			await db
				.prepare("SELECT id FROM categories WHERE name = 'Entertainment'")
				.first<{ id: number }>(),
		).id;
	});

	it("saves the rule for a category it knows", async () => {
		const got = await change(String(entertainment));

		expect(got.toast).toBe("Netflix.com now goes to Entertainment every time.");
	});

	it.each(NOT_A_NUMBER)(
		"refuses %s for the category",
		async (_label, input) => {
			const got = await change(input(entertainment));

			expect(got.status).toBe(400);
			expect(got.toast).toBeNull();
		},
	);

	it("accepts a category written with a leading zero, a space or an exponent as Number did", async () => {
		expect((await change(`00${entertainment}`)).toast).toBe(
			"Netflix.com now goes to Entertainment every time.",
		);
		expect((await change(` ${entertainment} `)).toast).toBe(
			"Netflix.com now goes to Entertainment every time.",
		);
	});
});

// --- Create a category from a suggestion ------------------------------------------------------------------------------

let suggestion: number;
let chewy: number;
let petsmart: number;

beforeEach(async () => {
	await resetDemo(db, TODAY);
	// Every demo transaction is filed and the demo's own suggestion goes, so this suggestion stands alone.
	await db.batch([
		db.prepare(
			"UPDATE transactions SET category_id = 1, category_source = 'user', category_suggestion_id = NULL",
		),
		db.prepare("DELETE FROM category_suggestions"),
	]);
	suggestion = present(
		await db
			.prepare(
				"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', 'pending') RETURNING id",
			)
			.first<{ id: number }>(),
	).id;
	chewy = present(
		await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 6412, 'CHEWY.COM', 'Chewy', 1, ?) RETURNING id",
			)
			.bind(`${TODAY.slice(0, 7)}-05`, suggestion)
			.first<{ id: number }>(),
	).id;
	petsmart = present(
		await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 2399, 'PETSMART 0412', 'Petsmart', 1, ?) RETURNING id",
			)
			.bind(`${TODAY.slice(0, 7)}-02`, suggestion)
			.first<{ id: number }>(),
	).id;
});

const createdPetCare = () =>
	count("SELECT COUNT(*) AS n FROM categories WHERE name = 'Pet Care'");

const create = (path: string, ids: (string | File)[] = [String(chewy)]) =>
	seen(path, [
		...ids.map((id): Field => ["ids", id]),
		["shown", String(chewy)],
		["shown", String(petsmart)],
	]);

describe("suggestion create: an id that is no suggestion answers the changed list", () => {
	const BAD_ADDRESS_IDS = ["0", "99999999999999999999", "9999999999999999"];

	it.each(BAD_ADDRESS_IDS)(
		"answers the changed list for address id %s, and writes nothing",
		async (id) => {
			const got = await create(`/settings/suggestions/${id}/create`);

			expect(got).toEqual({
				status: 404,
				toast: null,
				undoDone: null,
				announce: null,
				changed: true,
			});
			expect(await createdPetCare()).toBe(0);
			expect(
				await count(
					`SELECT COUNT(*) AS n FROM category_suggestions WHERE id = ${suggestion} AND status = 'pending'`,
				),
			).toBe(1);
		},
	);

	it("creates the category for the suggestion's own id", async () => {
		const got = await create(`/settings/suggestions/${suggestion}/create`);

		expect(got.status).toBe(200);
		expect(got.toast).toBe("Created Pet Care with 1 transaction");
		expect(await createdPetCare()).toBe(1);
	});

	it("drops a junk entry in the ticked list and gives the same answer as the list without it", async () => {
		const junk = await create(`/settings/suggestions/${suggestion}/create`, [
			"abc",
			String(chewy),
			"-1",
			"1.5",
			"",
		]);

		expect(junk).toMatchObject({
			status: 200,
			toast: "Created Pet Care with 1 transaction",
		});
	});
});

describe("suggestion dismiss: an id that is no suggestion answers the changed list", () => {
	const BAD_ADDRESS_IDS = ["0", "99999999999999999999", "9999999999999999"];

	it.each(BAD_ADDRESS_IDS)(
		"answers the changed list to a No for address id %s",
		async (id) => {
			const got = await seen(`/settings/suggestions/${id}/dismiss`);

			expect(got).toEqual({
				status: 404,
				toast: null,
				undoDone: null,
				announce: null,
				changed: true,
			});
			expect(
				await count(
					`SELECT COUNT(*) AS n FROM category_suggestions WHERE id = ${suggestion} AND status = 'pending'`,
				),
			).toBe(1);
		},
	);

	it.each(BAD_ADDRESS_IDS)(
		"answers the changed list to a Yes for address id %s, and writes no line",
		async (id) => {
			const got = await seen(`/settings/suggestions/${id}/dismiss`, [
				["answer", "ask_yes"],
				["id", `new-${id}`],
				["kind", "new_category"],
				["store", "CHEWY.COM"],
			]);

			expect(got).toEqual({
				status: 404,
				toast: null,
				undoDone: null,
				announce: null,
				changed: true,
			});
			expect(
				await count(
					"SELECT COUNT(*) AS n FROM never_suggest_rules WHERE kind = 'new_category'",
				),
			).toBe(0);
		},
	);

	it("retires the suggestion for its own id", async () => {
		const got = await seen(`/settings/suggestions/${suggestion}/dismiss`);

		expect(got.status).toBe(200);
		expect(got.changed).toBe(false);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM category_suggestions WHERE id = ${suggestion} AND status = 'dismissed'`,
			),
		).toBe(1);
	});
});

describe("suggestion dismiss: the place of the question is a number of digits or nothing", () => {
	// A second suggestion stays pending, so the card of "Garden" is drawn and the question's place shows against it.
	beforeEach(async () => {
		const garden = present(
			await db
				.prepare(
					"INSERT INTO category_suggestions (name, status) VALUES ('Garden', 'pending') RETURNING id",
				)
				.first<{ id: number }>(),
		).id;

		await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 1200, 'GARDEN CENTER', 'Garden Center', 1, ?)",
			)
			.bind(`${TODAY.slice(0, 7)}-03`, garden)
			.run();
	});

	/** Where the question sits, against the Garden card: before it, after it, or not drawn. */
	async function placeOf(place: string | File | undefined) {
		const fields: Field[] = [];

		if (place !== undefined) fields.push(["place", place]);

		const { html } = await post(
			`/settings/suggestions/${suggestion}/dismiss`,
			fields,
		);

		const question = html.indexOf("Don't suggest Pet Care again for");
		const garden = html.indexOf("A new category: Garden");

		if (question < 0 || garden < 0) return "not drawn";

		return question < garden ? "before Garden" : "after Garden";
	}

	it("puts the question in the card's place for a place of 0", async () => {
		expect(await placeOf("0")).toBe("before Garden");
	});

	const PLACES: [string, string | File | undefined][] = [
		["absent", undefined],
		["empty", ""],
		["a place of 1", "1"],
		["a place with a leading zero", "007"],
		["a huge place", "99999999999999999999"],
		["an exponent", "1e3"],
		["minus one", "-1"],
		["a decimal", "1.5"],
		["a word", "abc"],
		["a file part", new File(["0"], "place.txt")],
	];

	it.each(PLACES)(
		"puts the question after the last card for %s",
		async (_label, place) => {
			expect(await placeOf(place)).toBe("after Garden");
		},
	);
});

// The intended differences (#1006, plan 5): an id with a leading zero, a space or an exponent, which Number() read as a
// number and RowId refuses. A refused id gets the answer junk gets. A file part posted as the Undo's token is no token.

describe("intended differences: an id that Number() accepted is refused as junk is", () => {
	let line: number;

	// The suggestion and its transactions come from the file's own setup above; this block adds only the line.
	beforeEach(async () => {
		line = present(
			await db
				.prepare(
					"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES ('VENMO', 'income', '2026-10-03') RETURNING id",
				)
				.first<{ id: number }>(),
		).id;
	});

	it.each([
		["a leading zero", (n: number) => `00${n}`],
		["a space on each side", (n: number) => ` ${n} `],
		["an exponent", (n: number) => `${n}e0`],
	])("never-suggest remove keeps the line for %s", async (_label, spell) => {
		const got = await remove(spell(line));

		expect(got.toast).toBeNull();
		expect(await count("SELECT COUNT(*) AS n FROM never_suggest_rules")).toBe(
			1,
		);
	});

	it.each([
		["a leading zero", (n: number) => `00${n}`],
		["a space on each side", (n: number) => ` ${n} `],
	])(
		"learned undo refuses the Forget for %s, and keeps it",
		async (_label, spell) => {
			const id = await freshForget();
			const got = await undo(spell(id));

			expect(got.toast).toBe("Nothing to undo.");
			expect(await forgotten()).toBe(1);
		},
	);

	it("learned undo echoes a file part as the empty token, not as its type", async () => {
		await freshForget();
		const got = await undo(new File(["5"], "token.txt"));

		expect(got.undoDone).toBe("");
	});

	it("suggestion dismiss answers the changed list for a suggestion's id with a leading zero", async () => {
		const { res } = await post(`/settings/suggestions/00${suggestion}/dismiss`);

		expect(res.status).toBe(404);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM category_suggestions WHERE id = ${suggestion} AND status = 'pending'`,
			),
		).toBe(1);
	});

	it("suggestion create answers the changed list for a suggestion's id with a leading zero", async () => {
		const got = await create(`/settings/suggestions/00${suggestion}/create`);

		expect(got).toMatchObject({ status: 404, changed: true });
		expect(await createdPetCare()).toBe(0);
	});

	it("suggestion create drops a ticked id with a leading zero, so the card is not ticked", async () => {
		const { res } = await post(`/settings/suggestions/${suggestion}/create`, [
			["ids", `00${chewy}`],
			["shown", String(chewy)],
			["shown", String(petsmart)],
		]);

		// Nothing is ticked, so the form asks again and no category is made.
		expect(res.status).toBe(422);
		expect(await createdPetCare()).toBe(0);
	});
});
