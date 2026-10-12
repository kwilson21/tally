import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JEV_URL } from "../src/ai/categorize";
import { categorizePending } from "../src/categorize-pending";
import { saveAiSwitches } from "../src/db/ai-switches";
import {
	pendingSuggestions,
	saveSuggestion,
} from "../src/db/category-suggestions";
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
			"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO transactions (account_id,date,amount_cents,raw_name,category_confidence,jev_none_fit) SELECT 1,'2026-09-14',100,? || ' ' || i,0.95,1 FROM n RETURNING id",
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
			"SELECT category_id, category_source, category_confidence, jev_none_fit, category_suggestion_id, note, updated_by FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<{
			category_id: number | null;
			category_source: string | null;
			category_confidence: number | null;
			jev_none_fit: number;
			category_suggestion_id: number | null;
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
		db.prepare("DELETE FROM never_suggest_rules"),
		db.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'"),
	]);
	await saveAiSwitches(db, { details: false });
});

describe("GET /settings with a suggestion", () => {
	it("shows the picked dashed card with the tag, muted instruction, ticked rows, and actions", async () => {
		const { id, ids } = await petCare();
		const { res, html } = await get();
		expect(res.status).toBe(200);
		const section = html.slice(html.indexOf('<section id="categories"'));
		// It sits in the Categories section, after the categories and before Add category.
		const at = section.indexOf(`data-suggestion="${id}"`);
		expect(at).toBeGreaterThan(section.indexOf('data-category="5"'));
		expect(at).toBeLessThan(section.indexOf("Add category"));
		const cardStart = section.lastIndexOf("<details", at);
		const card = section.slice(
			cardStart,
			section.indexOf('data-row="new"', at),
		);
		expect(card).toMatch(
			/<details[^>]*class="[^"]*rounded-control border border-dashed border-ink/,
		);
		expect(card).toMatch(/<svg[^>]*data-icon="tag"/);
		expect(card).toMatch(
			/<span class="block text-sm text-muted">Untick any that don&#39;t belong\.<\/span>/,
		);
		const text = textOf(html);
		expect(text).toContain("Suggested: Pet Care");
		expect(text).toContain("Untick any that don't belong.");
		for (const n of ids) {
			const row = card.slice(card.indexOf(`data-transaction="${n}"`));
			const item = row.slice(0, row.indexOf("</li>") + 5);
			expect(item).toMatch(
				/<input class="peer sr-only" type="checkbox" name="ids"/,
			);
			expect(item).toMatch(
				/<label[^>]*class="group relative flex min-h-16 min-w-11/,
			);
			expect(item).toMatch(/selection-mark[^"]*size-7[^"]*rounded-full/);
			expect(item).toMatch(/peer-checked:border-ink peer-checked:bg-band/);
			expect(item).toMatch(/aria-labelledby="select-[^"]+-name"/);
			expect(item).toContain('data-icon="circle-dashed"');
			expect(item).toContain("Needs category");
			expect(item).toContain(`value="${n}"`);
			expect(html).toContain(`name="shown" value="${n}"`);
		}
		expect(text).toContain("Chewy.com");
		expect(text).toContain("$189.00");
		expect(text).toContain("Create Pet Care");
		expect(text).not.toContain("Create Pet Care with 4");
		expect(text).toContain("Dismiss");
		expect(html).toContain(`href="/how-it-works#categorization"`);
		expect(card.indexOf("Create Pet Care")).toBeLessThan(
			card.indexOf("Dismiss"),
		);
		expect(card.indexOf("Dismiss")).toBeLessThan(card.indexOf("Why?</a>"));
		expect(card).toMatch(
			/<button type="submit" name="action" value="create" class="[^"]*border border-ink[^"]*">Create Pet Care<\/button>/,
		);
		expect(card).toMatch(
			/<button type="submit" formaction="[^"]+\/dismiss"[^>]*class="[^"]*text-accent[^"]*">Dismiss<\/button>/,
		);
	});

	it("gives each transaction a note field that shows only while it is unticked, with no script", async () => {
		const { id, ids } = await petCare();
		const { html } = await get();
		for (const n of ids) expect(html).toContain(`name="note_${n}"`);
		expect(textOf(html)).toContain("A note for Amazon gift (optional)");
		expect(textOf(html)).toContain(
			"Tally sorts it again right away, with your note.",
		);
		// The field is hidden until its row is unticked (CSS only), and the page adds no client script of its own.
		expect(html).toContain(
			"group-has-[input[type=checkbox]:not(:checked)]/tx:block",
		);
		expect(html).toContain(
			"supports-[selector(:has(*))]:group-has-[input[type=checkbox]:not(:checked)]/tx:block",
		);
		expect(html).toMatch(/type="checkbox"[^>]*name="ids"[^>]*checked/);
		expect(html).toContain('name="shown"');
		const unchecked = await create(id, [], ids);
		expect(unchecked.res.status).toBe(422);
		expect(unchecked.html).toMatch(
			/type="checkbox"[^>]*name="ids"[^>]*value="\d+"(?![^>]*checked)/,
		);
		expect(unchecked.html).toContain(
			"group-has-[input[type=checkbox]:not(:checked)]/tx:block",
		);
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
		// Settings reads the one review queue as well (#195): its income, transfer, category and name reads add
		// a fixed handful of statements, none of them per suggestion.
		expect(counted.statements()).toBeLessThan(30);
	});

	it("keeps a partly reviewed suggestion visible while one eligible transaction remains, then retires it at zero", async () => {
		const { ids } = await petCare();
		await db
			.prepare(
				"UPDATE transactions SET category_id = 1, category_source = 'user' WHERE id IN (?, ?)",
			)
			.bind(ids[0], ids[1])
			.run();
		expect(textOf((await get()).html)).toContain("Suggested: Pet Care");
		await db
			.prepare(
				"UPDATE transactions SET category_id=1,category_source='user' WHERE id IN (?,?)",
			)
			.bind(ids[2], ids[3])
			.run();
		expect(textOf((await get()).html)).not.toContain("Suggested: Pet Care");
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
		expect(await row(ids[3] as number)).toMatchObject({
			category_confidence: null,
			jev_none_fit: 0,
			category_suggestion_id: null,
		});
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
				"SELECT raw_name FROM transactions WHERE raw_name LIKE 'Large Batch %' AND category_confidence=0.5 ORDER BY date DESC, id DESC LIMIT 50",
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
		// Details alone only runs for transactions already sorted; this new-category flow leaves this one unsorted.
		await saveAiSwitches(db, {
			categories: false,
			income: false,
			details: true,
		});
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

	it("adds the ticked ones to the category the family already has with that name, instead of making one", async () => {
		const { id, ids } = await petCare();
		await db
			.prepare(
				"UPDATE category_suggestions SET name = 'groceries' WHERE id = ?",
			)
			.bind(id)
			.run();
		const { res } = await create(id, ids, ids);
		expect(res.status).toBe(200);
		expect(JSON.stringify(trigger(res))).toContain("Added 4 transactions to");
		expect(await status(id)).toBe("created");
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

describe("Never suggest lines in the card (decision 101)", () => {
	/** Two purchases at one store and one at another, under one pending suggestion (three make one). */
	async function twoStores() {
		const a1 = await addTx("CHEWY.COM", 6412);
		const a2 = await addTx("CHEWY.COM", 4100);
		const b = await addTx("PETSMART 0412", 2399);
		const id = (await saveSuggestion(db, "Pet Care", [a1, a2, b])) as number;
		return { id, a: [a1, a2], b };
	}
	const neverLine = (merchantKey: string) =>
		db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES (?, 'new_category', '2026-10-03')",
			)
			.bind(merchantKey)
			.run();

	it("leaves a store with a line out of the card, and shows the others", async () => {
		const { a, b } = await twoStores();
		await neverLine("PETSMART 0412");
		const [suggestion] = await pendingSuggestions(db);
		const kept = suggestion?.rows.map((r) => r.id) ?? [];
		expect(kept).toHaveLength(2);
		expect(kept).toEqual(expect.arrayContaining(a));
		const { html } = await get();
		for (const id of a) expect(html).toContain(`name="shown" value="${id}"`);
		expect(html).not.toContain(`name="shown" value="${b}"`);
	});

	it("drops the card when every store has a line, without counting it as more, and keeps it pending for Remove", async () => {
		const { id } = await twoStores();
		await neverLine("CHEWY.COM");
		await neverLine("PETSMART 0412");
		const pending = await pendingSuggestions(db);
		expect(pending).toEqual([]);
		expect(pending.more).toBe(0);
		const { html } = await get();
		expect(html).not.toContain("data-suggestion=");
		expect(await status(id)).toBe("pending");
		await db
			.prepare("DELETE FROM never_suggest_rules WHERE merchant_key = ?")
			.bind("CHEWY.COM")
			.run();
		expect((await pendingSuggestions(db)).map((s) => s.id)).toEqual([id]);
	});

	it("files nothing for a store with a line, even when a stale form ticks its row", async () => {
		const { id, ids } = await petCare();
		await neverLine("PETSMART 0412");
		const { res } = await create(id, ids, ids);
		expect(res.status).toBe(200);
		const [chewy, , petsmart] = ids;
		expect(await row(petsmart as number)).toMatchObject({
			category_id: null,
			category_source: null,
		});
		expect(await row(chewy as number)).toMatchObject({
			category_source: "user",
		});
	});
});

describe("Remove takes a store's linked Never suggest lines away together (decision 101)", () => {
	const neverLine = (merchantKey: string, kind: string, decidedOn: string) =>
		db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES (?, ?, ?)",
			)
			.bind(merchantKey, kind, decidedOn)
			.run();
	const lineId = async (merchantKey: string) =>
		(
			await db
				.prepare(
					"SELECT id FROM never_suggest_rules WHERE merchant_key = ? AND kind = 'income'",
				)
				.bind(merchantKey)
				.first<{ id: number }>()
		)?.id ?? 0;
	/** The Never suggest line whose Remove takes focus after a swap: the one drawn with autofocus. */
	const focusedLine = (html: string) =>
		html
			.split("<li ")
			.find(
				(item) =>
					item.includes("autofocus") && item.includes("never-suggest/remove"),
			) ?? "";
	/** A charge whose bank text is `raw` and whose Plaid name is Venmo: the link a pair of lines goes by (decision 101). */
	const charge = (raw: string) =>
		db
			.prepare(
				"INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name) VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-04', -2500, ?, 'Venmo')",
			)
			.bind(`plaid-${crypto.randomUUID()}`, raw)
			.run();
	const linked = async () => {
		await charge("VENMO 123");
		await neverLine("VENMO 123", "income", "2026-10-04");
		await neverLine("Venmo", "income", "2026-10-03");
	};

	it("draws a linked pair as one line, under the store's name", async () => {
		await linked();
		const { html } = await get();
		expect(
			html
				.split("<li ")
				.filter((item) => item.includes("never-suggest/remove")),
		).toHaveLength(1);
		expect(html).toContain(`name="id" value="${await lineId("Venmo")}"`);
		expect(html).not.toContain(
			`name="id" value="${await lineId("VENMO 123")}"`,
		);
	});

	it("between two stores, focuses the line that took the clicked one's place", async () => {
		await linked();
		await neverLine("Chewy", "income", "2026-10-05");
		await neverLine("Petco", "income", "2026-09-01");
		const { html } = await post("/settings/never-suggest/remove", [
			["id", String(await lineId("Venmo"))],
			["merchant_key", "Venmo"],
			["kind", "income"],
		]);
		expect(focusedLine(html)).toContain("for Petco");
	});

	it("with a visible line above the clicked one, focuses that line once the pair has gone", async () => {
		await charge("VENMO 123");
		await charge("VENMO 456");
		await neverLine("VENMO 456", "income", "2026-10-05");
		await neverLine("VENMO 123", "income", "2026-10-04");
		await neverLine("Chewy", "income", "2026-10-03");
		await neverLine("Petco", "income", "2026-10-02");
		const { html } = await post("/settings/never-suggest/remove", [
			["id", String(await lineId("VENMO 123"))],
			["merchant_key", "VENMO 123"],
			["kind", "income"],
		]);
		const stored = await db
			.prepare(
				"SELECT merchant_key AS key FROM never_suggest_rules ORDER BY key",
			)
			.all<{ key: string }>();
		expect(stored.results.map((line) => line.key)).toEqual(["Chewy", "Petco"]);
		expect(focusedLine(html)).toContain("for Chewy");
	});

	it("with a line of another store left, lists only that line and focuses its Remove", async () => {
		await linked();
		await neverLine("Chewy", "income", "2026-09-01");
		const { html } = await post("/settings/never-suggest/remove", [
			["id", String(await lineId("Venmo"))],
			["merchant_key", "Venmo"],
			["kind", "income"],
		]);
		expect(
			html
				.split("<li ")
				.filter((item) => item.includes("never-suggest/remove")),
		).toHaveLength(1);
		expect(focusedLine(html)).toContain("for Chewy");
	});

	it("with no other line left, focuses the heading and says Tally hasn't been told No yet", async () => {
		await linked();
		const { html } = await post("/settings/never-suggest/remove", [
			["id", String(await lineId("Venmo"))],
			["merchant_key", "Venmo"],
			["kind", "income"],
		]);
		expect(html).toMatch(
			/<h3[^>]*tabindex="-1"[^>]*autofocus[^>]*>Never suggest<\/h3>/,
		);
		expect(textOf(html)).toContain("Tally hasn't been told No yet.");
	});

	it("the toast and announcement name the line clicked, though other lines went with it", async () => {
		await linked();
		await neverLine("Chewy", "income", "2026-09-01");
		const { res } = await post("/settings/never-suggest/remove", [
			["id", String(await lineId("Venmo"))],
			["merchant_key", "Venmo"],
			["kind", "income"],
		]);
		expect(trigger(res).toast?.message).toBe(
			"Removed. Tally can suggest that again.",
		);
		expect(trigger(res).announce).toContain(
			"Never suggest income for Venmo is gone.",
		);
	});

	it("a Remove with a live id but another kind changes nothing, and answers as stale", async () => {
		await linked();
		const { res, html } = await post("/settings/never-suggest/remove", [
			["id", String(await lineId("Venmo"))],
			["merchant_key", "Venmo"],
			["kind", "transfer"],
		]);
		expect(trigger(res).toast).toBeUndefined();
		expect(trigger(res).announce).toBe("Tally's rules list updated.");
		expect(textOf(html)).toContain("Never suggest income for Venmo");
		expect(
			await db
				.prepare("SELECT COUNT(*) AS n FROM never_suggest_rules")
				.first<{ n: number }>(),
		).toEqual({ n: 2 });
	});
});

describe("the Band follows the Settings swaps that change the queue (#195)", () => {
	const BAND_OOB = 'hx-select-oob="#names-band"';
	const tagOf = (html: string, pattern: RegExp) =>
		pattern.exec(html)?.[0] ?? "";
	const neverLine = (merchantKey: string) =>
		db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES (?, 'new_category', '2026-10-03')",
			)
			.bind(merchantKey)
			.run();

	it("swaps the Band with the create form and the Dismiss button of a suggestion card", async () => {
		const { id } = await petCare();
		const { html } = await get();
		expect(
			tagOf(
				html,
				new RegExp(
					`<form[^>]*action="/settings/suggestions/${id}/create"[^>]*>`,
				),
			),
		).toContain(BAND_OOB);
		expect(
			tagOf(
				html,
				new RegExp(
					`<button[^>]*formaction="/settings/suggestions/${id}/dismiss"[^>]*>`,
				),
			),
		).toContain(BAND_OOB);
	});

	it("swaps the Band with a Never suggest Remove, and with a Categories form built by swap()", async () => {
		await neverLine("CHEWY.COM");
		const { html } = await get();
		expect(
			tagOf(html, /<form[^>]*action="\/settings\/never-suggest\/remove"[^>]*>/),
		).toContain(BAND_OOB);
		expect(
			tagOf(html, /<form[^>]*action="\/settings\/categories"[^>]*>/),
		).toContain(BAND_OOB);
	});

	it("draws the Band empty when a Dismiss takes the only waiting suggestion away", async () => {
		const { id } = await petCare();
		const { html } = await post(`/settings/suggestions/${id}/dismiss`);
		expect(html).toContain('<div id="names-band"></div>');
	});

	it("draws the Band with its count when a Never suggest Remove brings a hidden suggestion back", async () => {
		await petCare();
		for (const store of [
			"CHEWY.COM",
			"BANFIELD PET HOSPITAL",
			"PETSMART 0412",
			"AMAZON GIFT",
		])
			await neverLine(store);
		expect(textOf((await get()).html)).not.toContain("Suggested: Pet Care");
		const line = await db
			.prepare(
				"SELECT id FROM never_suggest_rules WHERE merchant_key = 'CHEWY.COM'",
			)
			.first<{ id: number }>();
		const { html } = await post("/settings/never-suggest/remove", [
			["id", String(line?.id)],
			["merchant_key", "CHEWY.COM"],
			["kind", "new_category"],
		]);
		expect(html).toMatch(/<div id="names-band">[\s\S]*?1 suggestion to check/);
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
