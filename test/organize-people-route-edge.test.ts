import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { noteHouseholdMember } from "../src/db/reconnect";
import { resetDemo } from "../src/demo/reset";
import { organizeGroups } from "../src/transactions/organize";
import { present } from "./helpers/present";

// The people, time-zone, bank sign-in address and Organize routes read their input at the edge (#1006, plan 6). The
// blocks below pin what each route answers for bad input (characterisation: written from today's answers, then kept).
// The last block pins the intended differences: an id with a leading zero, a space or an exponent that Number() took.

const db = env.DB;
const BASE = "http://tally.test";
const TODAY = todayIn(DEFAULT_TIME_ZONE);

const CHANGED = "That suggestion was changed somewhere else.";
const NAME_SAY = "Enter a name up to 40 characters.";
const ZONE_SAY = "Choose a time zone from the list.";
const ADDRESS_SAY = "Choose an address to remove.";

type Field = [string, string | File];

/** A form post, multipart so a field can be a file part; a missing field is simply not sent. */
async function post(path: string, fields: Field[] = [], hx = true) {
	const body = new FormData();

	for (const [key, value] of fields) body.append(key, value);

	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: hx ? { Origin: BASE, "HX-Request": "true" } : { Origin: BASE },
		body,
	});

	return { res, html: (await res.text()).replaceAll("&#39;", "'") };
}

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);

	return { res, html: await res.text() };
}

const toastOf = (res: Response): string | null => {
	// SAFETY: HX-Trigger is the JSON these routes write, with the toast key this name reads.
	const trigger: { toast?: { message?: string } } = JSON.parse(
		res.headers.get("HX-Trigger") ?? "{}",
	);

	return trigger.toast?.message ?? null;
};

const count = async (sql: string) =>
	(await db.prepare(sql).first<{ n: number }>())?.n;

/** A person row the test names, under an id the test picks or the database gives. */
const addPerson = async (name: string, id?: number) =>
	present(
		await db
			.prepare(
				id === undefined
					? "INSERT INTO household_people (name) VALUES (?) RETURNING id"
					: "INSERT INTO household_people (id, name) VALUES (?, ?) RETURNING id",
			)
			.bind(...(id === undefined ? [name] : [id, name]))
			.first<{ id: number }>(),
	).id;

const PEOPLE_COUNT = "SELECT COUNT(*) AS n FROM household_people";

const RULES =
	"SELECT COUNT(*) AS n FROM merchants WHERE default_category_id IS NOT NULL";

beforeEach(async () => {
	await resetDemo(db, TODAY);
});

// --- POST /settings/people: person_id ----------------------------------------------------------------------------------

/** Bad ids, as a form posts them. A file part is the last one. */
const BAD_IDS: [string, string | File | undefined][] = [
	["the owner's row, 1", "1"],
	["zero", "0"],
	["minus one", "-1"],
	["abc", "abc"],
	["empty", ""],
	["absent", undefined],
	["a decimal", "1.5"],
	["a file part", new File(["5"], "id.txt")],
];

const personFields = (
	action: string | undefined,
	id: string | File | undefined,
	name?: string,
): Field[] => {
	const fields: Field[] = [];

	if (action !== undefined) fields.push(["action", action]);

	if (id !== undefined) fields.push(["person_id", id]);

	if (name !== undefined) fields.push(["name", name]);

	return fields;
};

describe("people: remove with a bad id", () => {
	it.each(BAD_IDS)("%s answers Not found and removes nobody", async (_, id) => {
		await addPerson("Sam");
		const before = await count(PEOPLE_COUNT);

		const { res, html } = await post("/settings/people", [
			["remove", "1"],
			...personFields("remove", id),
		]);

		expect(res.status).toBe(404);
		expect(html).toBe("Not found");
		expect(await count(PEOPLE_COUNT)).toBe(before);
	});

	it("a good id removes that person", async () => {
		const sam = await addPerson("Sam");

		const { res } = await post("/settings/people", [
			["remove", "1"],
			...personFields("remove", String(sam)),
		]);

		expect(res.status).toBe(200);
		expect(toastOf(res)).toBe("Removed Sam");
	});
});

describe("people: rename with a bad id", () => {
	it.each(BAD_IDS)(
		"%s with a valid name answers the Choose sentence, 400",
		async (_, id) => {
			const sam = await addPerson("Sam");

			const { res, html } = await post(
				"/settings/people",
				personFields("rename", id, "Samuel"),
			);

			expect(res.status).toBe(400);
			expect(html).toBe("Choose add, rename or remove.");
			expect(
				await db
					.prepare("SELECT name FROM household_people WHERE id = ?")
					.bind(sam)
					.first<{ name: string }>(),
			).toEqual({ name: "Sam" });
		},
	);

	it("a good id renames that person", async () => {
		const sam = await addPerson("Sam");

		const { res } = await post(
			"/settings/people",
			personFields("rename", String(sam), "Samuel"),
		);

		expect(res.status).toBe(200);
		expect(toastOf(res)).toBe("Renamed to Samuel");
	});
});

describe("people: a name that is empty or over the limit is refused first, with the id's row open", () => {
	const BAD_NAMES = ["", "   ", "x".repeat(41)];

	// The owner's row, 1, is a row id, so it opens its row (see the test below); the refused ids open none.
	it.each(BAD_IDS.filter(([, id]) => id !== "1"))(
		"rename, %s, a bad name: 422, and the page a refused id draws",
		async (_, id) => {
			for (const name of BAD_NAMES) {
				const { res, html } = await post(
					"/settings/people",
					personFields("rename", id, name),
				);

				const refused = await post(
					"/settings/people",
					personFields("rename", "abc", name),
				);

				expect(res.status).toBe(422);
				// A refused id opens no row, so the sentence is not drawn; it is the same page as any other refused id.
				expect(html).toBe(refused.html);
			}
		},
	);

	it("rename of the owner's row, 1, with a bad name opens that row (row 1 is a row id), unlike a refused id", async () => {
		const owner = await post(
			"/settings/people",
			personFields("rename", "1", ""),
		);

		const refused = await post(
			"/settings/people",
			personFields("rename", "abc", ""),
		);

		expect(owner.res.status).toBe(422);
		expect(owner.html).toMatch(/<details class="group" open/);
		expect(refused.html).not.toMatch(/<details class="group" open/);
	});

	it("add with an empty name: 422 with the sentence and the add form open", async () => {
		const { res, html } = await post(
			"/settings/people",
			personFields("add", undefined, ""),
		);

		expect(res.status).toBe(422);
		expect(html).toContain(NAME_SAY);
	});

	it("an unknown action with an empty name is refused by the name first", async () => {
		const { res, html } = await post(
			"/settings/people",
			personFields("frob", "2", ""),
		);

		expect(res.status).toBe(422);
		expect(html).toContain(NAME_SAY);
	});

	it("an unknown action with a valid name answers the Choose sentence, 400", async () => {
		const { res, html } = await post(
			"/settings/people",
			personFields("frob", "2", "Sam"),
		);

		expect(res.status).toBe(400);
		expect(html).toBe("Choose add, rename or remove.");
	});

	it("the name is echoed to the page as typed, untrimmed", async () => {
		const { html } = await post(
			"/settings/people",
			personFields("add", undefined, "   "),
		);

		expect(html).toContain(NAME_SAY);
	});

	it("a refused id draws the same page as a missing one (no row is opened)", async () => {
		const bad = await post(
			"/settings/people",
			personFields("rename", "abc", ""),
		);

		const missing = await post(
			"/settings/people",
			personFields("rename", undefined, ""),
		);

		expect(bad.html).toBe(missing.html);
	});
});

// --- POST /settings/time-zone -----------------------------------------------------------------------------------------

describe("time zone: a zone the select does not offer is refused", () => {
	const BAD_ZONES: [string, string | File | undefined][] = [
		["empty", ""],
		["absent", undefined],
		["a zone not offered", "Mars/Base"],
		["the wrong case", "america/chicago"],
		["a leading space", " America/Chicago"],
		["a trailing space", "America/Chicago "],
		["a file part", new File(["America/Chicago"], "zone.txt")],
	];

	it.each(BAD_ZONES)("%s: 422 with the sentence", async (_, zone) => {
		const fields: Field[] = zone === undefined ? [] : [["time_zone", zone]];
		const { res, html } = await post("/settings/time-zone", fields);

		expect(res.status).toBe(422);
		expect(html).toContain(ZONE_SAY);
	});

	it("an offered zone is saved and named", async () => {
		const { res } = await post("/settings/time-zone", [
			["time_zone", "America/Chicago"],
		]);

		expect(res.status).toBe(200);
		expect(toastOf(res)).toBe("Saved time zone");
	});
});

// --- POST /settings/bank-sign-in-emails (remove) ----------------------------------------------------------------------

describe("bank sign-in address removal: the address the form posts", () => {
	const removeAddress = (remove: string | File) =>
		post("/settings/bank-sign-in-emails", [["remove", remove]]);

	// SAFETY: each row is a label and a form value (text or a file part); the cast only types the literal's tuples.
	it.each([
		["empty", ""],
		["only spaces", "   "],
		["no at sign", "nobody"],
		["no dot after the at sign", "a@b"],
		["a space inside", "a b@c.com"],
		["nothing before the at sign", "@c.com"],
		["a dot straight after the at sign", "a@.com"],
		["255 characters", `${"a".repeat(250)}@b.co`],
		["a file part", new File(["pat@example.com"], "a.txt")],
	] as [string, string | File][])(
		"%s: 400 with the sentence",
		async (_, remove) => {
			const { res, html } = await removeAddress(remove);

			expect(res.status).toBe(400);
			expect(toastOf(res)).toBe(ADDRESS_SAY);
			expect(html).toContain(ADDRESS_SAY);
		},
	);

	it("a well-formed address of 254 characters is read, and not found", async () => {
		const { res, html } = await removeAddress(`${"a".repeat(249)}@b.co`);

		expect(res.status).toBe(404);
		expect(html).toContain("Address not found.");
	});

	it("a listed address, typed in capitals with spaces, is removed", async () => {
		await noteHouseholdMember(db, "pat@example.com", null);

		const { res } = await removeAddress("  PAT@Example.com ");

		expect(res.status).toBe(200);
		expect(toastOf(res)).toBe("Removed address");
	});
});

// --- GET /transactions/organize: store and category ------------------------------------------------------------------

describe("GET /transactions/organize: an address with no usable store or category shows the ordinary page", () => {
	it.each([
		"store=abc&category=2",
		"store=0&category=2",
		"store=-1&category=2",
		"store=1.5&category=2",
		"store=1e3&category=1",
		"store=999999&category=2",
		"store=2&category=abc",
		"store=2&category=0",
		"store=2",
		"category=2",
		"",
	])("%s", async (query) => {
		const plain = await get("/transactions/organize");
		const { res, html } = await get(`/transactions/organize?${query}`);

		expect(res.status).toBe(200);
		expect(html).toBe(plain.html);
	});
});

// --- POST /transactions/organize/suggestion ---------------------------------------------------------------------------

describe("Organize's Create: a suggestion id that is not a row id is the changed list", () => {
	let suggestion: number;
	let chewy: number;
	let petsmart: number;

	beforeEach(async () => {
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

	const created = () =>
		count("SELECT COUNT(*) AS n FROM categories WHERE name = 'Pet Care'");

	// SAFETY: each row is a label and a form value (text or a file part); the cast only types the literal's tuples.
	it.each([
		["abc", "abc"],
		["zero", "0"],
		["minus one", "-1"],
		["a decimal", "1.5"],
		["an exponent", "1e3"],
		["hex", "0x1"],
		["a 20-digit id", "99999999999999999999"],
		["absent", undefined],
		["a file part", new File(["1"], "s.txt")],
	] as [string, string | File | undefined][])(
		"%s: the toast says it changed, nothing is filed, and the page is drawn",
		async (_, id) => {
			const fields: Field[] = [
				["shown", String(chewy)],
				["shown", String(petsmart)],
			];

			if (id !== undefined) fields.push(["suggestion", id]);

			const { res, html } = await post(
				"/transactions/organize/suggestion",
				fields,
			);

			expect(res.status).toBe(200);
			expect(toastOf(res)).toContain(CHANGED);
			expect(html).toContain('id="organize-page"');
			expect(await created()).toBe(0);
		},
	);

	it("a refused id, without JavaScript, draws the changed sentence on the page", async () => {
		const { res, html } = await post(
			"/transactions/organize/suggestion",
			[
				["suggestion", "abc"],
				["shown", String(chewy)],
				["shown", String(petsmart)],
			],
			false,
		);

		expect(res.status).toBe(200);
		expect(html).toContain(CHANGED);
		expect(await created()).toBe(0);
	});

	it("junk in the shown list is dropped, so the two purchases are filed", async () => {
		const { res } = await post("/transactions/organize/suggestion", [
			["suggestion", String(suggestion)],
			["shown", String(chewy)],
			["shown", "abc"],
			["shown", "0"],
			["shown", "-1"],
			["shown", String(petsmart)],
		]);

		expect(res.status).toBe(200);
		expect(toastOf(res)).toContain("Created Pet Care with 2 transactions");
		expect(await created()).toBe(1);
	});
});

// --- POST /transactions/organize (the group's category) ---------------------------------------------------------------

describe("Organize's Save: a category that is not a whole number above zero is not on the list", () => {
	const BAD_CATEGORIES: [string, string | File | undefined][] = [
		["abc", "abc"],
		["zero", "0"],
		["minus one", "-1"],
		["a decimal", "1.5"],
		["empty", ""],
		["absent", undefined],
		["a file part", new File(["2"], "c.txt")],
	];

	it.each(BAD_CATEGORIES)(
		"%s: 422 with Pick a category, and no category is filed",
		async (_, category) => {
			const before = await count(
				"SELECT COUNT(*) AS n FROM transactions WHERE category_source = 'user' AND raw_name = 'SQ *LOCAL BAKERY 4432'",
			);

			const fields: Field[] = [["group", "Local Bakery"]];

			if (category !== undefined) fields.push(["category", category]);

			const { res, html } = await post("/transactions/organize", fields);

			expect(res.status).toBe(422);
			expect(html).toContain("Pick a category from the list.");
			expect(
				await count(
					"SELECT COUNT(*) AS n FROM transactions WHERE category_source = 'user' AND raw_name = 'SQ *LOCAL BAKERY 4432'",
				),
			).toBe(before);
		},
	);

	it("a group that is not on the page is not filed, whatever the category", async () => {
		const names = (await organizeGroups(db)).map((item) => item.name);

		expect(names).toContain("Local Bakery");

		const { res } = await post("/transactions/organize", [
			["group", "Nowhere Store"],
			["category", "2"],
		]);

		expect(res.status).toBe(200);
	});

	it("a new category with no name is refused, whatever the category field holds", async () => {
		const { res, html } = await post("/transactions/organize", [
			["group", "Local Bakery"],
			["category", "new"],
			["new_category_name", ""],
		]);

		expect(res.status).toBe(422);
		expect(html).toContain("Give the category a name.");
	});
});

// --- POST /transactions/organize/rule: store and category ------------------------------------------------------------

describe("Organize's Yes: a store or category that is not a row id writes no rule", () => {
	const BAD_PAIRS: [string, Field[]][] = [
		[
			"store abc",
			[
				["store", "abc"],
				["category", "2"],
			],
		],
		[
			"store zero",
			[
				["store", "0"],
				["category", "2"],
			],
		],
		[
			"store minus one",
			[
				["store", "-1"],
				["category", "2"],
			],
		],
		[
			"store a decimal",
			[
				["store", "1.5"],
				["category", "2"],
			],
		],
		[
			"store an exponent",
			[
				["store", "1e3"],
				["category", "2"],
			],
		],
		["store absent", [["category", "2"]]],
		[
			"category abc",
			[
				["store", "2"],
				["category", "abc"],
			],
		],
		[
			"category zero",
			[
				["store", "2"],
				["category", "0"],
			],
		],
		["category absent", [["store", "2"]]],
		[
			"store a file part",
			[
				["store", new File(["2"], "s.txt")],
				["category", "2"],
			],
		],
	];

	it.each(BAD_PAIRS)("%s: nothing is written", async (_, pair) => {
		const before = await count(RULES);

		const { res } = await post("/transactions/organize/rule", [
			["answer", "yes"],
			...pair,
		]);

		expect(res.status).toBe(200);
		expect(toastOf(res)).toBeNull();
		expect(await count(RULES)).toBe(before);
	});

	it("without JavaScript, a refused pair moves on with a redirect", async () => {
		const { res } = await post(
			"/transactions/organize/rule",
			[
				["answer", "yes"],
				["store", "abc"],
				["category", "2"],
			],
			false,
		);

		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/transactions/organize");
	});
});

// --- Intended differences: an id Number() took that a row id refuses (a leading zero, an exponent) ---------------------

describe("intended difference: an id with a leading zero or an exponent is refused, as NaN and 0 were", () => {
	const seedSuggestion = async () => {
		await db.batch([
			db.prepare(
				"UPDATE transactions SET category_id = 1, category_source = 'user', category_suggestion_id = NULL",
			),
			db.prepare("DELETE FROM category_suggestions"),
		]);

		const suggestion = present(
			await db
				.prepare(
					"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', 'pending') RETURNING id",
				)
				.first<{ id: number }>(),
		).id;

		const chewy = present(
			await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 6412, 'CHEWY.COM', 'Chewy', 1, ?) RETURNING id",
				)
				.bind(`${TODAY.slice(0, 7)}-05`, suggestion)
				.first<{ id: number }>(),
		).id;

		return { suggestion, chewy };
	};

	it("remove: 007 for person 7 no longer removes that person", async () => {
		await addPerson("Pat", 7);
		const before = await count(PEOPLE_COUNT);

		const { res, html } = await post("/settings/people", [
			["remove", "1"],
			["person_id", "007"],
		]);

		expect(res.status).toBe(404);
		expect(html).toBe("Not found");
		expect(await count(PEOPLE_COUNT)).toBe(before);
	});

	it("rename: 1e3 with a valid name answers the Choose sentence, as NaN did", async () => {
		const { res, html } = await post("/settings/people", [
			["action", "rename"],
			["person_id", "1e3"],
			["name", "Samuel"],
		]);

		expect(res.status).toBe(400);
		expect(html).toBe("Choose add, rename or remove.");
	});

	it("Create: a suggestion id with a leading zero is the changed list, not the suggestion", async () => {
		const { suggestion, chewy } = await seedSuggestion();

		const { res } = await post("/transactions/organize/suggestion", [
			["suggestion", `0${suggestion}`],
			["shown", String(chewy)],
		]);

		expect(toastOf(res)).toContain(CHANGED);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM categories WHERE name = 'Pet Care'",
			),
		).toBe(0);
	});

	it("Create: an exponent in the shown list is dropped, so the purchases the card showed are filed", async () => {
		const { suggestion, chewy } = await seedSuggestion();

		const { res } = await post("/transactions/organize/suggestion", [
			["suggestion", String(suggestion)],
			["shown", String(chewy)],
			["shown", "1e3"],
		]);

		expect(toastOf(res)).toContain("Created Pet Care with 1 transaction");
	});

	it("a store with a leading zero in the address no longer asks its question", async () => {
		const save = await post(
			"/transactions/organize",
			[
				["category", "2"],
				["name", ""],
				["group", "Local Bakery"],
			],
			true,
		);

		const pushed = new URL(
			BASE + (save.res.headers.get("HX-Push-Url") ?? "/transactions/organize"),
		);

		const store = pushed.searchParams.get("store") ?? "";

		const asked = await get(`/transactions/organize?store=${store}&category=2`);

		const zeroed = await get(
			`/transactions/organize?store=0${store}&category=2`,
		);

		expect(asked.html).toContain("rule-offer-title");
		expect(zeroed.html).not.toContain("rule-offer-title");
	});
});
