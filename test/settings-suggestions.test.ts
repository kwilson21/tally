import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JEV_URL } from "../src/ai/categorize";
import { categorizePending } from "../src/categorize-pending";
import { saveAiSwitches } from "../src/db/ai-switches";
import { saveSuggestion } from "../src/db/category-suggestions";
import { resetDemo } from "../src/demo/reset";
import { settings } from "../src/routes/settings";

// Settings shows each suggested new category with the transactions behind it (spec §7, §8.3, P30 A, #51):
// a dashed row under Categories, open to its transactions, each ticked to go in. A person creates the
// category or dismisses the suggestion, and nothing is created without them. Screens say "Tally", never
// "Jev" (decision 64).

const db = env.DB;
type TestApp = { Bindings: Env; Variables: { actor: string } };
// The route-only harness supplies the actor that src/index.tsx sets after verifying Access.
const routeHarness = new Hono<TestApp>();
routeHarness.use("*", async (c, next) => {
	if ((c.env as { DEMO?: string }).DEMO === "false")
		c.set("actor", "test@example.com");
	await next();
});
routeHarness.route("/", settings as unknown as Hono<TestApp>);
let waitUntil: ReturnType<typeof vi.fn<(promise: Promise<unknown>) => void>>;
const ctx = () => ({ waitUntil, passThroughOnException() {}, props: {} });
const background = () => Promise.all(waitUntil.mock.calls.map(([p]) => p));

async function request(
	path: string,
	init: RequestInit = {},
	bindings: Record<string, unknown> = {},
) {
	const res = await routeHarness.request(
		path,
		init,
		{ ...env, ...bindings },
		ctx(),
	);
	return { res, html: await res.text() };
}
const get = (path = "/settings", bindings = {}) => request(path, {}, bindings);
async function post(
	path: string,
	fields: [string, string][] = [],
	{
		htmx = true,
		bindings = {},
	}: { htmx?: boolean; bindings?: Record<string, unknown> } = {},
) {
	const { res, html } = await request(
		path,
		{
			method: "POST",
			redirect: "manual",
			headers: {
				...(htmx ? { "HX-Request": "true" } : {}),
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(fields).toString(),
		},
		bindings,
	);
	return { res, html };
}
const trigger = (res: Response) =>
	JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
		toast?: { message: string };
		announce?: string;
	};
const textOf = (html: string) =>
	html
		.replace(/<[^>]+>/g, "")
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&");

function countingDb() {
	let statements = 0;
	const counted = new Proxy(db, {
		get(target, property) {
			const value = Reflect.get(target, property);
			if (property === "prepare")
				return (sql: string) => {
					statements += 1;
					return target.prepare(sql);
				};
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { db: counted as D1Database, statements: () => statements };
}

async function bulkSuggestion(name: string, count: number) {
	const { results } = await db
		.prepare(
			"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO transactions (account_id,date,amount_cents,raw_name) SELECT 1,'2026-09-14',100,? || ' ' || i FROM n RETURNING id",
		)
		.bind(count, name)
		.all<{ id: number }>();
	const id = (await saveSuggestion(
		db,
		name,
		results.map((row) => row.id),
	)) as number;
	return { id, ids: results.map((row) => row.id) };
}

async function addTx(
	rawName: string,
	cents: number,
	over: { note?: string } = {},
) {
	const result = await db
		.prepare(
			`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_category, category_confidence, jev_none_fit, note)
			 VALUES (1, '2026-09-14', ?, ?, 'GENERAL_MERCHANDISE', 0.93, 1, ?)`,
		)
		.bind(cents, rawName, over.note ?? null)
		.run();
	return Number(result.meta.last_row_id);
}

const PETS: [string, number][] = [
	["CHEWY.COM", 6412],
	["BANFIELD PET HOSPITAL", 18900],
	["PETSMART 0412", 2399],
	["AMAZON GIFT", 4520],
];
/** A pending "Pet Care" suggestion over four transactions. */
async function petCare(name = "Pet Care") {
	const ids: number[] = [];
	for (const [raw, cents] of PETS) ids.push(await addTx(raw, cents));
	const id = (await saveSuggestion(db, name, ids)) as number;
	return { id, ids };
}
const create = (
	id: number,
	ticked: number[],
	shown: number[],
	notes: Record<number, string> = {},
) =>
	post(`/settings/suggestions/${id}/create`, [
		...shown.map((n): [string, string] => ["shown", String(n)]),
		...ticked.map((n): [string, string] => ["ids", String(n)]),
		...Object.entries(notes).map(([n, text]): [string, string] => [
			`note_${n}`,
			text,
		]),
	]);

const row = (id: number) =>
	db
		.prepare(
			"SELECT category_id, category_source, category_confidence, note, updated_by FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<{
			category_id: number | null;
			category_source: string | null;
			category_confidence: number | null;
			note: string | null;
			updated_by: string | null;
		}>();
const categoryNamed = (name: string) =>
	db
		.prepare(
			"SELECT id, name, icon, color, archived FROM categories WHERE name = ?",
		)
		.bind(name)
		.first<{
			id: number;
			name: string;
			icon: string;
			color: string;
			archived: number;
		}>();
const status = async (id: number) =>
	(
		await db
			.prepare("SELECT status FROM category_suggestions WHERE id = ?")
			.bind(id)
			.first<{ status: string }>()
	)?.status;

beforeEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	waitUntil = vi.fn<(promise: Promise<unknown>) => void>((promise) => {
		void promise.catch(() => {});
	});
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchants"),
		db.prepare("DELETE FROM category_suggestions"),
		db.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'"),
	]);
});

describe("GET /settings with a suggestion", () => {
	it("shows a dashed row under the categories, open to its transactions, each ticked, with Create and Dismiss", async () => {
		const { id, ids } = await petCare();
		const { res, html } = await get();
		expect(res.status).toBe(200);
		const section = html.slice(html.indexOf('<section id="categories"'));
		// It sits in the Categories section, after the categories and before Add category.
		const at = section.indexOf(`data-suggestion="${id}"`);
		expect(at).toBeGreaterThan(section.indexOf('data-category="5"'));
		expect(at).toBeLessThan(section.indexOf("Add category"));
		expect(html).toMatch(
			new RegExp(`<details[^>]*data-suggestion="${id}"[^>]*\\bopen`),
		);
		expect(html).toMatch(/border-dashed/);
		const text = textOf(html);
		expect(text).toContain("Suggested: Pet Care");
		expect(text).toContain("Untick any that don't belong.");
		for (const n of ids) {
			expect(html).toMatch(
				new RegExp(`<input[^>]*name="ids"[^>]*value="${n}"[^>]*checked`),
			);
			expect(html).toContain(`name="shown" value="${n}"`);
		}
		expect(text).toContain("Chewy.com");
		expect(text).toContain("$189.00");
		expect(text).toContain("Create Pet Care with 4");
		expect(text).toContain("Dismiss");
		expect(html).toContain(`href="/how-it-works#categorization"`);
	});

	it("gives each transaction a note field that shows only while it is unticked, with no script", async () => {
		const { ids } = await petCare();
		const { html } = await get();
		for (const n of ids) expect(html).toContain(`name="note_${n}"`);
		expect(textOf(html)).toContain("A note for Amazon gift (optional)");
		expect(textOf(html)).toContain(
			"Tally sorts it again right away, with your note.",
		);
		// The field is hidden until its row is unticked (CSS only), and the page adds no client script of its own.
		expect(html).toMatch(/group-has-\[[^\]]*:not\(:checked\)\][^"]*:block/);
	});

	it("says Tally, never Jev, anywhere on the page", async () => {
		await petCare();
		const { html } = await get();
		expect(html).not.toMatch(/\bJev\b/);
	});

	it("shows every pending suggestion, the one with the most transactions first", async () => {
		await petCare();
		const subs: number[] = [];
		for (const raw of [
			"NETFLIX",
			"HULU",
			"SPOTIFY",
			"DISNEY PLUS",
			"MAX",
			"PEACOCK",
		])
			subs.push(await addTx(raw, 1299));
		await saveSuggestion(db, "Subscriptions", subs);
		const { html } = await get();
		const names = [
			...textOf(html).matchAll(/Suggested: ([A-Za-z ]+?)(?=Untick)/g),
		].map((m) => m[1]);
		expect(names).toEqual(["Subscriptions", "Pet Care"]);
	});

	it("loads 30 pending suggestions in one grouped transaction query and lists the busiest 10", async () => {
		for (let i = 0; i < 30; i++) await bulkSuggestion(`Batch ${i}`, 20);
		const counted = countingDb();
		const { html } = await get("/settings", { DB: counted.db });
		expect((html.match(/data-suggestion=/g) ?? []).length).toBe(10);
		expect(textOf(html)).toContain(
			"20 more suggestions will show once you decide these.",
		);
		expect(counted.statements()).toBeLessThan(20);
	});

	it("shows nothing for a suggestion with fewer than three transactions still needing a category", async () => {
		const { ids } = await petCare();
		await db
			.prepare(
				"UPDATE transactions SET category_id = 1, category_source = 'user' WHERE id IN (?, ?)",
			)
			.bind(ids[0], ids[1])
			.run();
		expect(textOf((await get()).html)).not.toContain("Suggested:");
	});

	it("keeps pending suggestions visible when Guess categories is off", async () => {
		await petCare();
		await saveAiSwitches(db, { categories: false });
		expect(textOf((await get()).html)).toContain("Suggested: Pet Care");
		await saveAiSwitches(db, { categories: true });
		expect(textOf((await get()).html)).toContain("Suggested: Pet Care");
	});

	it("shows no suggestion row when there is none", async () => {
		const { html } = await get();
		expect(textOf(html)).not.toContain("Suggested:");
		expect(html).not.toContain("data-suggestion=");
	});
});

describe("creating the category", () => {
	it("saves 100 unticked notes within D1's per-invocation query limit", async () => {
		const { id, ids } = await bulkSuggestion("Note Batch", 101);
		const counted = countingDb();
		const { res } = await post(
			`/settings/suggestions/${id}/create`,
			[
				...ids.map((n): [string, string] => ["shown", String(n)]),
				["ids", String(ids[0])],
				...ids.slice(1).map((n): [string, string] => [`note_${n}`, "left out"]),
			],
			{ bindings: { DB: counted.db } },
		);
		expect(res.status).toBe(200);
		expect(counted.statements()).toBeLessThan(1000);
	});
	it("creates it with the tag icon and the next color, puts the ticked transactions in it as the person's own pick, and says so", async () => {
		const { id, ids } = await petCare();
		const { res, html } = await create(id, ids.slice(0, 3), ids);
		expect(res.status).toBe(200);
		const created = await categoryNamed("Pet Care");
		expect(created).toMatchObject({ icon: "tag", archived: 0 });
		for (const n of ids.slice(0, 3))
			expect(await row(n)).toMatchObject({
				category_id: created?.id,
				category_source: "user",
				category_confidence: null,
				updated_by: "demo",
			});
		expect((await row(ids[3] as number))?.category_id).toBeNull();
		expect(await status(id)).toBe("created");
		expect(trigger(res)).toEqual({
			toast: {
				message: "Created Pet Care with 3 transactions",
				type: "success",
			},
			announce:
				"Created Pet Care with 3 transactions. The 1 you left out goes back to Tally to sort again.",
		});
		// The answer is the Categories section with the new category in it, and the suggestion gone.
		expect(textOf(html)).toContain("Pet Care");
		expect(html).toContain(`data-category="${created?.id}"`);
		expect(html).not.toContain("data-suggestion=");
	});

	it("says one transaction in the singular, and the left-out ones in the plural", async () => {
		const { id, ids } = await petCare();
		const { res } = await create(id, [ids[0] as number], ids);
		expect(trigger(res).toast?.message).toBe(
			"Created Pet Care with 1 transaction",
		);
		expect(trigger(res).announce).toBe(
			"Created Pet Care with 1 transaction. The 3 you left out go back to Tally to sort again.",
		);
	});

	it("leaves out the left-out part when nothing was unticked", async () => {
		const { id, ids } = await petCare();
		const { res } = await create(id, ids, ids);
		expect(trigger(res).toast?.message).toBe(
			"Created Pet Care with 4 transactions",
		);
		expect(trigger(res).announce).toBe("Created Pet Care with 4 transactions.");
	});

	it("saves a note written for an unticked transaction and asks Jev about it again right away, after the page has answered, telling it the note", async () => {
		const { id, ids } = await petCare();
		const bodies: {
			state: Record<string, unknown>;
			questions: { category: { criteria: Record<string, unknown> } };
		}[] = [];
		const jev = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			if (String(url) !== JEV_URL) throw new Error(`unexpected fetch ${url}`);
			bodies.push(JSON.parse(String(init?.body)));
			return Response.json({
				answers: {
					category: { type: "choice", choice: "Household", confidence: 0.91 },
					transfer: { type: "noul", noul: 0.01 },
					reimbursement: { type: "noul", noul: 0.01 },
					income: { type: "noul", noul: 0.01 },
				},
			});
		});
		vi.stubGlobal("fetch", jev);
		const { res } = await post(
			`/settings/suggestions/${id}/create`,
			[
				...ids.map((n): [string, string] => ["shown", String(n)]),
				...ids.slice(0, 3).map((n): [string, string] => ["ids", String(n)]),
				[`note_${ids[3]}`, "Birthday present"],
			],
			{ bindings: { JEV_API_KEY: "jev-key" } },
		);
		expect(res.status).toBe(200);
		expect((await row(ids[3] as number))?.note).toBe("Birthday present");
		// The page answered before Jev was asked: the call is handed to waitUntil.
		expect(jev).not.toHaveBeenCalled();
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await background();
		expect(jev).toHaveBeenCalledTimes(1);
		expect(bodies[0]?.state).toMatchObject({
			bank_description: "AMAZON GIFT",
			note: "Birthday present",
		});
		// The new category is on offer to it from this very call.
		expect(Object.keys(bodies[0]?.questions.category.criteria ?? {})).toContain(
			"Pet Care",
		);
		expect(await row(ids[3] as number)).toMatchObject({
			category_source: "jev",
		});
	});

	it("asks again about every unticked transaction, with or without a note", async () => {
		const { id, ids } = await petCare();
		const jev = vi.fn(async () =>
			Response.json({
				answers: {
					category: {
						type: "choice",
						choice: "None of these fit",
						confidence: 0.9,
					},
					transfer: { type: "noul", noul: 0.01 },
					reimbursement: { type: "noul", noul: 0.01 },
					income: { type: "noul", noul: 0.01 },
				},
			}),
		);
		vi.stubGlobal("fetch", jev);
		await post(
			`/settings/suggestions/${id}/create`,
			[
				...ids.map((n): [string, string] => ["shown", String(n)]),
				["ids", String(ids[0])],
			],
			{ bindings: { JEV_API_KEY: "jev-key" } },
		);
		await background();
		expect(jev).toHaveBeenCalledTimes(3);
	});

	it("re-asks newest-first about at most 50 of 300 left-out transactions, leaving the rest for night", async () => {
		const { id, ids } = await bulkSuggestion("Large Batch", 301);
		const counted = countingDb();
		const asked: string[] = [];
		const jev = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			asked.push(
				JSON.parse(String(init?.body)).state.bank_description as string,
			);
			return Response.json({
				answers: {
					category: {
						type: "choice",
						choice: "None of these fit",
						confidence: 0.5,
					},
					transfer: { type: "noul", noul: 0.01 },
					reimbursement: { type: "noul", noul: 0.01 },
					income: { type: "noul", noul: 0.01 },
				},
			});
		});
		vi.stubGlobal("fetch", jev);
		const { res } = await post(
			`/settings/suggestions/${id}/create`,
			[
				...ids.map((n): [string, string] => ["shown", String(n)]),
				["ids", String(ids[0])],
			],
			{ bindings: { DB: counted.db, DEMO: "false", JEV_API_KEY: "jev-key" } },
		);
		expect(res.status).toBe(200);
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await background();
		expect(jev).toHaveBeenCalledTimes(50);
		expect(counted.statements()).toBeLessThan(1000);
		const rows = await db
			.prepare(
				"SELECT category_id, category_confidence FROM transactions WHERE raw_name LIKE 'Large Batch %'",
			)
			.all<{
				category_id: number | null;
				category_confidence: number | null;
			}>();
		expect(
			rows.results.filter((row) => row.category_confidence === 0.5),
		).toHaveLength(50);
		expect(
			rows.results.filter(
				(row) => row.category_id === null && row.category_confidence === null,
			),
		).toHaveLength(250);
		const newest = await db
			.prepare(
				"SELECT raw_name FROM transactions WHERE raw_name LIKE 'Large Batch %' AND category_suggestion_id IS NOT NULL ORDER BY date DESC, id DESC LIMIT 50",
			)
			.all<{ raw_name: string }>();
		expect(asked).toEqual(newest.results.map((row) => row.raw_name));
		const nightly = vi.fn(async () =>
			Response.json({
				answers: {
					category: {
						type: "choice",
						choice: "None of these fit",
						confidence: 0.5,
					},
					transfer: { type: "noul", noul: 0.01 },
					reimbursement: { type: "noul", noul: 0.01 },
					income: { type: "noul", noul: 0.01 },
				},
			}),
		);
		await categorizePending(
			{ DB: db, DEMO: "false", JEV_API_KEY: "jev-key" },
			nightly,
		);
		expect(nightly).toHaveBeenCalledTimes(250);
	});

	it("asks Jev nothing when every transaction stays ticked", async () => {
		const { id, ids } = await petCare();
		await create(id, ids, ids);
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it("asks nothing, but leaves the unticked ones for the night, while Guess categories and Spot paychecks are off", async () => {
		const { id, ids } = await petCare();
		await saveAiSwitches(db, { categories: false, income: false });
		const jev = vi.fn();
		vi.stubGlobal("fetch", jev);
		await post(
			`/settings/suggestions/${id}/create`,
			[
				...ids.map((n): [string, string] => ["shown", String(n)]),
				...ids.slice(0, 3).map((n): [string, string] => ["ids", String(n)]),
			],
			{ bindings: { JEV_API_KEY: "jev-key" } },
		);
		await background();
		expect(jev).not.toHaveBeenCalled();
		expect((await row(ids[3] as number))?.category_id).toBeNull();
	});

	it("asks for a tick, keeping what was typed, and creates nothing", async () => {
		const { id, ids } = await petCare();
		const { res, html } = await create(id, [], ids, {
			[ids[0] as number]: "Dog food",
		});
		expect(res.status).toBe(422);
		expect(html).toMatch(
			/role="alert"[^>]*>[^<]*Tick at least one transaction, or dismiss this suggestion\./,
		);
		expect(await categoryNamed("Pet Care")).toBeNull();
		expect(await status(id)).toBe("pending");
		// The form comes back as it was: nothing ticked, the note still in its field.
		expect(html).not.toMatch(/<input[^>]*name="ids"[^>]*checked/);
		expect(html).toContain("Dog food");
		expect(trigger(res)).toEqual({});
	});

	it("refuses a name a category already has, with the form kept", async () => {
		const { id, ids } = await petCare();
		await db
			.prepare(
				"UPDATE category_suggestions SET name = 'groceries' WHERE id = ?",
			)
			.bind(id)
			.run();
		const { res, html } = await create(id, ids, ids);
		expect(res.status).toBe(422);
		expect(textOf(html)).toContain("That name is reserved for Jev.");
		expect(await status(id)).toBe("pending");
	});

	it("says the suggestion was changed elsewhere when it was already created or dismissed, with the current list", async () => {
		const { id, ids } = await petCare();
		await create(id, ids, ids);
		const again = await create(id, ids, ids);
		expect(again.res.status).toBe(404);
		expect(textOf(again.html)).toContain(
			"That suggestion was changed somewhere else. Here's the current list.",
		);
		const rows = await db
			.prepare("SELECT COUNT(*) AS n FROM categories WHERE name = 'Pet Care'")
			.first<{ n: number }>();
		expect(rows?.n).toBe(1);
	});

	it("without JavaScript, posts and goes back to Settings at Categories", async () => {
		const { id, ids } = await petCare();
		const { res } = await post(
			`/settings/suggestions/${id}/create`,
			[
				...ids.map((n): [string, string] => ["shown", String(n)]),
				...ids.map((n): [string, string] => ["ids", String(n)]),
			],
			{ htmx: false },
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/settings#categories");
		expect(await categoryNamed("Pet Care")).not.toBeNull();
	});

	it("never says Jev in what it tells a person", async () => {
		const { id, ids } = await petCare();
		const { res, html } = await create(id, ids.slice(0, 2), ids, {
			[ids[2] as number]: "x",
		});
		expect(JSON.stringify(trigger(res))).not.toMatch(/\bJev\b/);
		expect(html).not.toMatch(/\bJev\b/);
	});

	it("is a stale-safe form: a suggestion that doesn't exist is the same current-list answer", async () => {
		const { res } = await create(9999, [1], [1]);
		expect(res.status).toBe(404);
	});
});

describe("dismissing the suggestion", () => {
	it("turns it down, creates nothing, moves nothing, and says Tally won't suggest it again", async () => {
		const { id, ids } = await petCare();
		const had = await db
			.prepare("SELECT COUNT(*) AS n FROM categories")
			.first<{ n: number }>();
		const { res, html } = await post(`/settings/suggestions/${id}/dismiss`);
		expect(res.status).toBe(200);
		expect(await status(id)).toBe("dismissed");
		expect(
			(
				await db
					.prepare("SELECT COUNT(*) AS n FROM categories")
					.first<{ n: number }>()
			)?.n,
		).toBe(had?.n);
		for (const n of ids) expect((await row(n))?.category_id).toBeNull();
		expect(trigger(res)).toEqual({
			toast: { message: "Dismissed Pet Care", type: "success" },
			announce: "Dismissed Pet Care. Tally won't suggest it again.",
		});
		expect(html).not.toContain("data-suggestion=");
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it("says it was changed elsewhere when it was already decided", async () => {
		const { id } = await petCare();
		await post(`/settings/suggestions/${id}/dismiss`);
		const again = await post(`/settings/suggestions/${id}/dismiss`);
		expect(again.res.status).toBe(404);
		expect(textOf(again.html)).toContain(
			"That suggestion was changed somewhere else.",
		);
	});

	it("without JavaScript, posts and goes back to Settings at Categories", async () => {
		const { id } = await petCare();
		const { res } = await post(`/settings/suggestions/${id}/dismiss`, [], {
			htmx: false,
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/settings#categories");
	});
});
