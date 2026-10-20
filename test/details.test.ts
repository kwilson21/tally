import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { categorizePending } from "../src/categorize-pending";
import { readAiSwitches, saveAiSwitches } from "../src/db/ai-switches";
import { listTransactions, pendingForJev } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { suggestTransactionNotes } from "../src/suggest-names-pending";
import { parseFilters } from "../src/transactions/filters";
import { recordSorting } from "./record-sorting";

const db = env.DB;
recordSorting({ sort: true });
const BASE = "http://tally.test";
const textOf = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

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

async function noteRows() {
	const { results } = await db
		.prepare("SELECT note, note_guessed FROM transactions ORDER BY id")
		.all<{ note: string | null; note_guessed: number }>();
	return results;
}

async function charge() {
	const row = await db
		.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, '2026-10-01', 1299, 'COFFEE SHOP') RETURNING id",
		)
		.first<{ id: number }>();
	return row?.id as number;
}

beforeEach(async () => {
	await resetDemo(db, "2026-10-06");
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM household_people WHERE id != 1"),
	]);
});

describe("transaction detail guesses", () => {
	it("records empty note answers and reaches older untried purchases next", async () => {
		await db
			.prepare(`INSERT INTO transactions (account_id,date,amount_cents,raw_name,details_asked, note_worth_writing) VALUES
			(1,'2026-10-01',100,'NEWEST A',1,1),(1,'2026-10-02',100,'NEWEST B',1,1),
			(1,'2026-10-03',100,'NEWEST C',1,1),(1,'2026-09-01',100,'OLDER',1,1)`)
			.run();
		const asked: string[] = [];
		const ai = {
			run: vi.fn(
				async (_model: string, input: { messages: { content: string }[] }) => {
					asked.push(
						input.messages[1]?.content.replace("Bank text: ", "") ?? "",
					);
					return { response: "" };
				},
			),
		} as unknown as Ai;
		await suggestTransactionNotes({ DB: db, AI: ai }, 3);
		await suggestTransactionNotes({ DB: db, AI: ai }, 1);
		expect(asked).toEqual(["NEWEST C", "NEWEST B", "NEWEST A", "OLDER"]);
		const tried = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE raw_name LIKE 'NEWEST %' AND note_tried_at IS NOT NULL",
			)
			.first<{ n: number }>();
		expect(tried?.n).toBe(3);
	});

	it("checks the detail switch at a bounded interval for 100 notes", async () => {
		await db
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
			 INSERT INTO transactions (account_id, date, amount_cents, raw_name, details_asked, note_worth_writing)
			 SELECT 1, '2026-09-20', 500, 'COFFEE SHOP ' || i, 1, 1 FROM n`,
			)
			.run();
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
		const ai = {
			run: vi.fn(async () => ({ response: "Coffee purchase" })),
		} as unknown as Ai;
		await suggestTransactionNotes({ DB: counted as D1Database, AI: ai });
		expect(statements).toBeLessThanOrEqual(45);
	});

	it("stops within five further AI calls when the detail switch turns off", async () => {
		await db
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
			 INSERT INTO transactions (account_id, date, amount_cents, raw_name, details_asked, note_worth_writing)
			 SELECT 1, '2026-09-20', 500, 'COFFEE SHOP ' || i, 1, 1 FROM n`,
			)
			.run();
		const run = vi.fn(async () => {
			await saveAiSwitches(db, { details: false });
			return { response: "Coffee purchase" };
		});
		const ai = { run } as unknown as Ai;
		expect(await suggestTransactionNotes({ DB: db, AI: ai })).toEqual({
			asked: 5,
			suggested: 0,
		});
		expect(run).toHaveBeenCalledTimes(5);
		// After the first callback flips the switch, no more than five additional names may be sent.
		expect(run.mock.calls.length - 1).toBeLessThanOrEqual(5);
		const { results } = await db
			.prepare(
				"SELECT note FROM transactions WHERE raw_name LIKE 'COFFEE SHOP %'",
			)
			.all<{ note: string | null }>();
		expect(results).toHaveLength(100);
		expect(results.every((row) => row.note === null)).toBe(true);
	});

	it("guesses only empty notes and keeps a note typed after candidates were read", async () => {
		await db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, note, details_asked, note_worth_writing)
			 VALUES (1, '2026-09-20', 500, 'EMPTY STRING', '', 1, 1),
			        (1, '2026-09-20', 600, 'WHITESPACE NOTE', '   ', 1, 1),
			        (1, '2026-09-20', 700, 'NULL NOTE', NULL, 1, 1),
			        (1, '2026-09-20', 800, 'PERSON NOTE', 'Costco run', 1, 1),
			        (1, '2026-09-20', 900, 'RACE NOTE', NULL, 1, 1)`,
			)
			.run();
		const run = vi.fn(
			async (_model: string, input: { messages: { content: string }[] }) => {
				const rawName = input.messages[1]?.content.replace("Bank text: ", "");
				if (rawName === "RACE NOTE")
					await db
						.prepare(
							"UPDATE transactions SET note = 'Typed meanwhile' WHERE raw_name = ?",
						)
						.bind(rawName)
						.run();
				return { response: `Guess for ${rawName}` };
			},
		);
		const ai = { run } as unknown as Ai;

		await suggestTransactionNotes({ DB: db, AI: ai });
		const { results } = await db
			.prepare("SELECT raw_name, note FROM transactions ORDER BY id")
			.all<{ raw_name: string; note: string | null }>();
		expect(results).toEqual([
			{ raw_name: "EMPTY STRING", note: "Guess for EMPTY STRING" },
			{ raw_name: "WHITESPACE NOTE", note: "Guess for WHITESPACE NOTE" },
			{ raw_name: "NULL NOTE", note: "Guess for NULL NOTE" },
			{ raw_name: "PERSON NOTE", note: "Costco run" },
			{ raw_name: "RACE NOTE", note: "Typed meanwhile" },
		]);
	});

	it("stores the note, kind, and person as guesses without making them a person's choices", async () => {
		const id = await charge();
		const person = await db
			.prepare(
				"INSERT INTO household_people (name) VALUES ('Morgan') RETURNING id",
			)
			.first<{ id: number }>();
		const fakeJev = async () =>
			new Response(
				JSON.stringify({
					answers: {
						category: { choice: "Eating Out", confidence: 0.99 },
						transfer: { noul: 0 },
						reimbursement: { noul: 0 },
						income: { noul: 0 },
						kind: { choice: "one_off", confidence: 0.99 },
						for_person: { choice: `person:${person?.id}`, confidence: 0.99 },
						note_worth_writing: { noul: 0.95 },
					},
				}),
				{ status: 200 },
			);
		await categorizePending({ DB: db, JEV_API_KEY: "test-key" }, fakeJev, {
			onlyIds: [id],
		});
		await suggestTransactionNotes(
			{
				DB: db,
				AI: {
					run: async () => ({ response: "Coffee with a friend" }),
				} as unknown as Ai,
			},
			1,
		);
		const { results } = await db
			.prepare(
				"SELECT note, note_guessed, kind, kind_guessed, for_person_id, for_person_guessed FROM transactions WHERE id = ?",
			)
			.bind(id)
			.all<Record<string, unknown>>();
		expect(results[0]).toMatchObject({
			note: "Coffee with a friend",
			note_guessed: 1,
			kind: "one_off",
			kind_guessed: 1,
			for_person_id: person?.id,
			for_person_guessed: 1,
		});
	});

	it("treats a missing what-it-was answer as a no and keeps the rest of Jev's answer", async () => {
		const id = await charge();
		const person = await db
			.prepare(
				"INSERT INTO household_people (name) VALUES ('Morgan') RETURNING id",
			)
			.first<{ id: number }>();
		// Jev's answer has no note_worth_writing at all, as when it leaves the question out.
		const fakeJev = async () =>
			new Response(
				JSON.stringify({
					answers: {
						category: { choice: "Eating Out", confidence: 0.99 },
						transfer: { noul: 0 },
						reimbursement: { noul: 0 },
						income: { noul: 0 },
						kind: { choice: "one_off", confidence: 0.99 },
						for_person: { choice: `person:${person?.id}`, confidence: 0.99 },
					},
				}),
				{ status: 200 },
			);
		await categorizePending({ DB: db, JEV_API_KEY: "test-key" }, fakeJev, {
			onlyIds: [id],
		});
		const ai = {
			run: vi.fn(async () => ({ response: "Coffee with a friend" })),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };
		await suggestTransactionNotes({ DB: db, AI: ai });
		const eatingOut = await db
			.prepare("SELECT id FROM categories WHERE name = 'Eating Out'")
			.first<{ id: number }>();
		const row = await db
			.prepare(
				"SELECT category_id, category_source, kind, kind_guessed, for_person_id, for_person_guessed, details_asked, note_worth_writing, note FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({
			category_id: eatingOut?.id,
			category_source: "jev",
			kind: "one_off",
			kind_guessed: 1,
			for_person_id: person?.id,
			for_person_guessed: 1,
			details_asked: 1,
			note_worth_writing: 0,
			note: null,
		});
		expect(ai.run).not.toHaveBeenCalled();
		const panel = (await get(`/transactions/${id}`)).html;
		const whatItWas =
			panel
				.split(">What it was</span>")[1]
				?.split('<span class="block font-medium">')[0] ?? "";
		expect(whatItWas).toContain('<span class="truncate">Add</span>');
	});

	it("keeps a guess that repeats only a name a person turned down", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('UBER *TRIP', 'Uber Eats', 'rejected')",
			),
			db.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, details_asked, note_worth_writing) VALUES (1, '2026-10-01', 1299, 'UBER *TRIP', 1, 1)",
			),
		]);
		const ai = {
			run: vi.fn(async () => ({ response: "Uber Eats order" })),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };
		await suggestTransactionNotes({ DB: db, AI: ai });
		expect(await noteRows()).toEqual([
			{ note: "Uber Eats order", note_guessed: 1 },
		]);
	});

	it("drops a guess that repeats a pending name the row shows, while names are on", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('UBER *TRIP', 'Uber Eats', 'pending')",
			),
			db.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, details_asked, note_worth_writing) VALUES (1, '2026-10-01', 1299, 'UBER *TRIP', 1, 1)",
			),
		]);
		const ai = {
			run: vi.fn(async () => ({ response: "Uber Eats order" })),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };
		await suggestTransactionNotes({ DB: db, AI: ai });
		expect(await noteRows()).toEqual([{ note: null, note_guessed: 0 }]);
	});

	it("keeps a guess that repeats a Tally name while names are off, since that name isn't shown", async () => {
		await saveAiSwitches(db, { names: false });
		await db.batch([
			db.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('UBER *TRIP', 'Uber Eats', 'pending')",
			),
			db.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, details_asked, note_worth_writing) VALUES (1, '2026-10-01', 1299, 'UBER *TRIP', 1, 1)",
			),
		]);
		const ai = {
			run: vi.fn(async () => ({ response: "Uber Eats order" })),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };
		await suggestTransactionNotes({ DB: db, AI: ai });
		expect(await noteRows()).toEqual([
			{ note: "Uber Eats order", note_guessed: 1 },
		]);
	});

	it("still drops a guess that repeats the bank's own name while names are off", async () => {
		await saveAiSwitches(db, { names: false });
		await db.batch([
			db.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('Harbor Hardware', 'Harbor Hardware', 'pending')",
			),
			db.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, details_asked, note_worth_writing) VALUES (1, '2026-10-01', 1299, 'HBR HDWR #88', 'Harbor Hardware', 1, 1)",
			),
		]);
		const ai = {
			run: vi.fn(async () => ({ response: "Harbor Hardware purchase" })),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };
		await suggestTransactionNotes({ DB: db, AI: ai });
		expect(await noteRows()).toEqual([{ note: null, note_guessed: 0 }]);
	});

	it("drops a guess that repeats a name the row shows, without sending that name to Workers AI", async () => {
		// The first row's name is its merchant's chosen name; the second's is only a pending suggestion.
		await db.batch([
			db.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('BL BTTL COF', 'Blue Bottle Coffee')",
			),
			db.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('BLUE BTL CO', 'Blue Bottle Coffee', 'pending')",
			),
			db.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, details_asked, note_worth_writing) VALUES
				(1, '2026-10-01', 1299, 'BL BTTL COF', NULL, 1, 1),
				(1, '2026-10-02', 1299, 'BL BTTL COF', 'BLUE BTL CO', 1, 1)`,
			),
		]);
		const ai = {
			run: vi.fn(async () => ({ response: "Blue Bottle Coffee purchase" })),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };
		await suggestTransactionNotes({ DB: db, AI: ai });
		const asked = ai.run.mock.calls.map(
			([, input]) =>
				(input as { messages: { content: string }[] }).messages[1]?.content,
		);
		expect(asked).toEqual(["Bank text: BL BTTL COF", "Bank text: BL BTTL COF"]);
		const { results } = await db
			.prepare(
				"SELECT note, note_guessed, note_tried_at FROM transactions ORDER BY id",
			)
			.all<{
				note: string | null;
				note_guessed: number;
				note_tried_at: string | null;
			}>();
		expect(results).toEqual([
			{ note: null, note_guessed: 0, note_tried_at: expect.any(String) },
			{ note: null, note_guessed: 0, note_tried_at: expect.any(String) },
		]);
	});

	it("asks Workers AI for a what-it-was line only where Jev says one could say more than the store's name", async () => {
		const purchase = async (rawName: string, merchantName: string) =>
			(
				await db
					.prepare(
						"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, '2026-10-01', 1299, ?, ?) RETURNING id",
					)
					.bind(rawName, merchantName)
					.first<{ id: number }>()
			)?.id as number;
		const cvs = await purchase("CVS PHARMACY #1234", "CVS Pharmacy");
		const apple = await purchase("APPLE.COM/BILL", "Apple");
		// A row Jev answered before this question existed: its note is never asked for.
		await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, details_asked) VALUES (1, '2026-09-01', 500, 'OLD SHOP', 1)",
			)
			.run();
		const fakeJev = async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as {
				state: { bank_description: string };
			};
			const worth =
				body.state.bank_description === "APPLE.COM/BILL" ? 0.95 : 0.1;
			return new Response(
				JSON.stringify({
					answers: {
						category: { choice: "Eating Out", confidence: 0.99 },
						transfer: { noul: 0 },
						reimbursement: { noul: 0 },
						income: { noul: 0 },
						kind: { choice: "one_off", confidence: 0.99 },
						for_person: { choice: "none", confidence: 0.99 },
						note_worth_writing: { noul: worth },
					},
				}),
				{ status: 200 },
			);
		};
		await categorizePending({ DB: db, JEV_API_KEY: "test-key" }, fakeJev, {
			onlyIds: [cvs, apple],
		});
		const stored = await db
			.prepare(
				"SELECT id, note_worth_writing FROM transactions WHERE id IN (?, ?) ORDER BY id",
			)
			.bind(cvs, apple)
			.all<{ id: number; note_worth_writing: number }>();
		expect(stored.results).toEqual([
			{ id: cvs, note_worth_writing: 0 },
			{ id: apple, note_worth_writing: 1 },
		]);

		const ai = {
			run: vi.fn(async () => ({ response: "App or iCloud subscription" })),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };
		await suggestTransactionNotes({ DB: db, AI: ai });
		const asked = ai.run.mock.calls.map(
			([, input]) =>
				(input as { messages: { content: string }[] }).messages[1]?.content,
		);
		expect(asked).toEqual(["Bank text: APPLE.COM/BILL"]);
		// The panel's What it was row for the no says Add, as it does for any empty detail.
		const cvsPanel = (await get(`/transactions/${cvs}`)).html;
		const whatItWas =
			cvsPanel
				.split(">What it was</span>")[1]
				?.split('<span class="block font-medium">')[0] ?? "";
		expect(whatItWas).toContain('<span class="truncate">Add</span>');
		const notes = await db
			.prepare(
				"SELECT raw_name, note, note_guessed FROM transactions ORDER BY id",
			)
			.all<Record<string, unknown>>();
		expect(notes.results).toEqual([
			{ raw_name: "CVS PHARMACY #1234", note: null, note_guessed: 0 },
			{
				raw_name: "APPLE.COM/BILL",
				note: "App or iCloud subscription",
				note_guessed: 1,
			},
			{ raw_name: "OLD SHOP", note: null, note_guessed: 0 },
		]);
	});

	it("shows the four detail rows and keeps them together with Looks right", async () => {
		const id = await charge();
		await db
			.prepare(
				"UPDATE transactions SET note = 'Coffee with a friend', note_guessed = 1, kind = 'one_off', kind_guessed = 1 WHERE id = ?",
			)
			.bind(id)
			.run();
		const { html: guessed } = await get(`/transactions/${id}`);
		const words = textOf(guessed);
		for (const label of ["Name", "What it was", "Kind", "For", "Looks right"])
			expect(words).toContain(label);
		expect(guessed).toContain("Tally&#39;s guess");
		expect(guessed).toContain("Tally uses these when it picks a category.");
		expect(guessed).toContain('href="/how-it-works#categorization"');
		// P120 B: the category leads the panel; the four details and Looks right follow it.
		expect(guessed.indexOf('id="edit-category"')).toBeLessThan(
			guessed.indexOf('id="detail-name"'),
		);
		expect(guessed.indexOf("Looks right")).toBeGreaterThan(
			guessed.indexOf('id="detail-for"'),
		);
	});

	it("hides unkept detail guesses when the details switch is off", async () => {
		const id = await charge();
		await db
			.prepare(
				"UPDATE transactions SET note='Dinner claim',note_guessed=1,kind='one_off',kind_guessed=1,for_person_id=1,for_person_guessed=1 WHERE id=?",
			)
			.bind(id)
			.run();
		await saveAiSwitches(db, { details: false });
		const { html } = await get(`/transactions/${id}`);
		expect(html).not.toContain("Dinner claim");
		expect(html).not.toContain('name="kind" value="one_off" checked');
		expect(html).not.toContain('name="for_person_id" value="1" checked');
		const list = await get("/transactions?month=all");
		expect(list.html).not.toContain("Dinner claim");
		await db
			.prepare(
				"UPDATE transactions SET note_guessed=0,kind_guessed=0,for_person_guessed=0 WHERE id=?",
			)
			.bind(id)
			.run();
		const kept = await get(`/transactions/${id}`);
		expect(kept.html).toContain("Dinner claim");
	});

	it("does not mark detail questions asked when Jev omits a requested answer", async () => {
		const id = await charge();
		await saveAiSwitches(db, { details: true, categories: true, income: true });
		await categorizePending(
			{ DB: db, JEV_API_KEY: "test-key" },
			async () =>
				Response.json({
					answers: {
						category: { choice: "Eating Out", confidence: 0.99 },
						transfer: { noul: 0 },
						reimbursement: { noul: 0 },
						income: { noul: 0 },
						for_person: { choice: "none", confidence: 0.99 },
					},
				}),
			{ onlyIds: [id] },
		);
		expect(
			await db
				.prepare("SELECT details_asked FROM transactions WHERE id=?")
				.bind(id)
				.first(),
		).toEqual({ details_asked: 0 });
	});

	it("re-asks Jev after a kind or person correction", async () => {
		const id = await charge();
		await db
			.prepare("INSERT INTO household_people(name) VALUES('Morgan')")
			.run();
		const person = await db
			.prepare("SELECT id FROM household_people WHERE name='Morgan'")
			.first<{ id: number }>();
		await db
			.prepare(
				"UPDATE transactions SET category_confidence=0.5, kind='subscription', for_person_id=1 WHERE id=?",
			)
			.bind(id)
			.run();
		await post(`/transactions/${id}`, {
			back: "/transactions",
			merchant_was: "Coffee shop",
			merchant: "Coffee shop",
			note: "",
			kind: "bill",
			for_person_id: String(person?.id),
		});
		expect(
			await db
				.prepare("SELECT category_confidence FROM transactions WHERE id=?")
				.bind(id)
				.first(),
		).toMatchObject({ category_confidence: null });
		expect(
			(await pendingForJev(db, 20, { details: true })).some(
				(tx) => tx.id === id,
			),
		).toBe(true);
	});

	it("drops queued detail answers when the switch turns off before the final write", async () => {
		const ids = [await charge(), await charge()];
		await db
			.prepare("INSERT INTO household_people(name) VALUES('Morgan')")
			.run();
		let calls = 0;
		await categorizePending(
			{ DB: db, JEV_API_KEY: "test-key" },
			async () => {
				calls += 1;
				if (calls === 2) await saveAiSwitches(db, { details: false });
				return Response.json({
					answers: {
						category: { choice: "Eating Out", confidence: 0.5 },
						transfer: { noul: 0 },
						reimbursement: { noul: 0 },
						income: { noul: 0 },
						kind: { choice: "one_off", confidence: 0.99 },
						for_person: { choice: "person:1", confidence: 0.99 },
						note_worth_writing: { noul: 0.95 },
					},
				});
			},
			{ onlyIds: ids },
		);
		const rows = await db
			.prepare("SELECT details_asked FROM transactions WHERE id IN (?,?)")
			.bind(...ids)
			.all<{ details_asked: number }>();
		expect(rows.results.map((row) => row.details_asked)).toEqual([0, 0]);
	});

	it("loads household choices from the next group if details become enabled during a categorization pass", async () => {
		// 26 rows make two groups of 25 and 1 (decision 139): the switches are read once a group.
		const ids: number[] = [];
		for (let i = 0; i < 26; i++) ids.push(await charge());
		await db
			.prepare("INSERT INTO household_people(name) VALUES('Morgan')")
			.run();
		const person = await db
			.prepare("SELECT id FROM household_people WHERE name='Morgan'")
			.first<{ id: number }>();
		await saveAiSwitches(db, { details: false });
		let calls = 0;
		const questions: (Record<string, unknown> | undefined)[] = [];
		await categorizePending(
			{ DB: db, JEV_API_KEY: "test-key", DEMO: "false" },
			async (_url, init) => {
				calls += 1;
				const body = JSON.parse(String(init?.body));
				questions.push(body.questions);
				if (calls === 1) await saveAiSwitches(db, { details: true });
				const detailsAsked = body.questions?.for_person !== undefined;
				return Response.json({
					answers: {
						category: { choice: "Eating Out", confidence: 0.5 },
						transfer: { noul: 0 },
						reimbursement: { noul: 0 },
						income: { noul: 0 },
						...(detailsAsked
							? {
									kind: { choice: "one_off", confidence: 0.99 },
									for_person: {
										choice: `person:${person?.id}`,
										confidence: 0.99,
									},
									note_worth_writing: { noul: 0.95 },
								}
							: {}),
					},
				});
			},
			{ onlyIds: ids },
		);
		// The first group (calls 1 to 25) was read with details off; the second (call 26) with them on.
		expect(
			questions.slice(1, 25).some((q) => q?.for_person !== undefined),
		).toBe(false);
		const later = questions[25] as {
			for_person: { criteria: Record<string, unknown> };
		};
		expect(later.for_person.criteria[`person:${person?.id}`]).toBe("Morgan");
		expect(
			await db
				.prepare("SELECT details_asked FROM transactions WHERE id=?")
				.bind(ids[0])
				.first(),
		).toEqual({ details_asked: 1 });
		expect(
			await db
				.prepare("SELECT details_asked FROM transactions WHERE id=?")
				.bind(ids[25])
				.first(),
		).toEqual({ details_asked: 0 });
	});

	it("shows a guessed note as the dashed caption beside Needs category", async () => {
		await saveAiSwitches(db, { details: true, categories: true, income: true });
		const id = await charge();
		await db
			.prepare(
				"UPDATE transactions SET note = ?, note_guessed = 1 WHERE id = ?",
			)
			.bind("Coffee with a friend", id)
			.run();
		const { html } = await get("/transactions?month=all");
		expect(textOf(html)).toContain("Coffee with a friend");
		expect(html).toContain("decoration-dashed");
		expect(textOf(html)).toContain("Needs category");
	});

	it("asks the household to add people after Tally first guesses Everyone", async () => {
		const id = await charge();
		await db
			.prepare(
				"UPDATE transactions SET for_person_id = 1, for_person_guessed = 1 WHERE id = ?",
			)
			.bind(id)
			.run();
		const { html } = await get("/transactions?month=all");
		expect(textOf(html)).toContain("Add the people in your household");
		expect(html).toContain('href="/settings/people"');
	});

	it("clearing a guessed note records the person's decision against future guesses", async () => {
		const id = await charge();
		await db
			.prepare(
				"UPDATE transactions SET note='Unwanted guess',note_guessed=1,details_asked=1 WHERE id=?",
			)
			.bind(id)
			.run();
		await post(`/transactions/${id}`, {
			back: "/transactions",
			merchant_was: "Coffee shop",
			merchant: "Coffee shop",
			note: "",
		});
		const row = await db
			.prepare(
				"SELECT note,note_guessed,note_tried_at FROM transactions WHERE id=?",
			)
			.bind(id)
			.first<{
				note: string | null;
				note_guessed: number;
				note_tried_at: string | null;
			}>();
		expect(row).toMatchObject({ note: null, note_guessed: 0 });
		expect(row?.note_tried_at).not.toBeNull();
		const ai = {
			run: vi.fn(async () => ({ response: "Another guess" })),
		} as unknown as Ai;
		await suggestTransactionNotes({ DB: db, AI: ai }, 1);
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("a correction keeps only that row and a later guess cannot replace kept details", async () => {
		const id = await charge();
		await db
			.prepare("INSERT INTO household_people (name) VALUES ('Morgan')")
			.run();
		const person = await db
			.prepare("SELECT id FROM household_people WHERE name = 'Morgan'")
			.first<{ id: number }>();
		await db
			.prepare(
				"UPDATE transactions SET note = 'Dinner', note_guessed = 1, kind = 'one_off', kind_guessed = 1, for_person_id = ?, for_person_guessed = 1 WHERE id = ?",
			)
			.bind(person?.id, id)
			.run();
		const corrected = await post(`/transactions/${id}`, {
			back: "/transactions",
			merchant_was: "Coffee shop",
			merchant: "Coffee shop",
			note: "Dinner",
			kind: "bill",
			for_person_id: String(person?.id),
		});
		expect(corrected.res.status).toBe(200);
		let row = await db
			.prepare(
				"SELECT note, note_guessed, kind, kind_guessed, for_person_id, for_person_guessed FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({
			note: "Dinner",
			note_guessed: 1,
			kind: "bill",
			kind_guessed: 0,
			for_person_id: person?.id,
			for_person_guessed: 1,
		});
		await db
			.prepare(
				"UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL, details_asked = 0",
			)
			.run();
		let sentState: Record<string, unknown> | undefined;
		await categorizePending(
			{ DB: db, JEV_API_KEY: "test-key" },
			async (_url, init) => {
				sentState = (
					JSON.parse(String(init?.body)) as { state: Record<string, unknown> }
				).state;
				return new Response(
					JSON.stringify({
						answers: {
							category: { choice: "Eating Out", confidence: 0.99 },
							transfer: { noul: 0 },
							reimbursement: { noul: 0 },
							income: { noul: 0 },
							kind: { choice: "subscription", confidence: 0.99 },
							for_person: { choice: "person:1", confidence: 0.99 },
							note_worth_writing: { noul: 0.95 },
						},
					}),
					{ status: 200 },
				);
			},
			{ onlyIds: [id] },
		);
		expect(sentState).toMatchObject({
			note: "Dinner",
			kind: "bill",
			for_person: "Morgan",
		});
		row = await db
			.prepare(
				"SELECT note, note_guessed, kind, kind_guessed, for_person_id, for_person_guessed FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({
			note: "Dinner",
			note_guessed: 1,
			kind: "bill",
			kind_guessed: 0,
			for_person_id: person?.id,
			for_person_guessed: 1,
		});
	});

	it("keeps hidden guesses when saving an unrelated category", async () => {
		const id = await charge();
		await db
			.prepare("INSERT INTO household_people (name) VALUES ('Morgan')")
			.run();
		const person = await db
			.prepare("SELECT id FROM household_people WHERE name='Morgan'")
			.first<{ id: number }>();
		await db
			.prepare(
				"UPDATE transactions SET note='Dinner',note_guessed=1,kind='one_off',kind_guessed=1,for_person_id=?,for_person_guessed=1 WHERE id=?",
			)
			.bind(person?.id, id)
			.run();
		await saveAiSwitches(db, { details: false });
		const saved = await post(`/transactions/${id}`, {
			back: "/transactions",
			merchant_was: "",
			note: "",
			category: "2",
			kind: "",
			for_person_id: "",
			details_visible: "0",
		});
		expect(saved.res.status).toBe(200);
		await saveAiSwitches(db, { details: true });
		expect(
			await db
				.prepare(
					"SELECT note,note_guessed,kind,kind_guessed,for_person_id,for_person_guessed,note_dismissed FROM transactions WHERE id=?",
				)
				.bind(id)
				.first(),
		).toMatchObject({
			note: "Dinner",
			note_guessed: 1,
			kind: "one_off",
			kind_guessed: 1,
			for_person_id: person?.id,
			for_person_guessed: 1,
			note_dismissed: 0,
		});
	});

	it("lists written notes and hides only unkept guesses when details are off", async () => {
		const written = await charge();
		const guessed = await charge();
		await db
			.prepare(
				"UPDATE transactions SET note='Written',note_guessed=0 WHERE id=?",
			)
			.bind(written)
			.run();
		await db
			.prepare("UPDATE transactions SET note='Guess',note_guessed=1 WHERE id=?")
			.bind(guessed)
			.run();
		await saveAiSwitches(db, { details: false });
		const rows = await listTransactions(
			db,
			parseFilters(new URLSearchParams(), "2026-10"),
		);
		expect(rows.rows.find((row) => row.id === written)?.note).toBe("Written");
		expect(rows.rows.find((row) => row.id === guessed)?.note).toBeNull();
	});

	it("Looks right keeps all four details, and turning details off preserves them", async () => {
		const id = await charge();
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('COFFEE SHOP', 'Corner Coffee', 'pending')",
			)
			.run();
		const before = await get(`/transactions/${id}`);
		expect(before.html).toContain('value="s:Corner Coffee"');
		await db
			.prepare("INSERT INTO household_people (name) VALUES ('Morgan')")
			.run();
		const person = await db
			.prepare("SELECT id FROM household_people WHERE name = 'Morgan'")
			.first<{ id: number }>();
		await db
			.prepare(
				"UPDATE transactions SET note = 'Dinner', note_guessed = 1, kind = 'one_off', kind_guessed = 1, for_person_id = ?, for_person_guessed = 1 WHERE id = ?",
			)
			.bind(person?.id, id)
			.run();
		const kept = await post(`/transactions/${id}`, {
			back: "/transactions",
			merchant_was: "",
			name_pick: "s:Corner Coffee",
			// A ticked name takes the Rename list's choice, as Save does: All renames the merchant (decision 101).
			name_scope: "all",
			note: "Dinner",
			kind: "one_off",
			for_person_id: String(person?.id),
			details_action: "keep",
		});
		expect(kept.res.status).toBe(200);
		expect(
			await db
				.prepare(
					"SELECT display_name, suggestion_status FROM merchants WHERE raw_name = 'COFFEE SHOP'",
				)
				.first(),
		).toEqual({ display_name: "Corner Coffee", suggestion_status: "accepted" });
		let row = await db
			.prepare(
				"SELECT note, note_guessed, kind, kind_guessed, for_person_id, for_person_guessed FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({
			note: "Dinner",
			note_guessed: 0,
			kind: "one_off",
			kind_guessed: 0,
			for_person_id: person?.id,
			for_person_guessed: 0,
		});

		await db
			.prepare(
				"UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveAiSwitches(db, { details: false });
		let calls = 0;
		await categorizePending(
			{ DB: db, JEV_API_KEY: "test-key" },
			async () => {
				calls += 1;
				return new Response(
					JSON.stringify({
						answers: {
							category: { choice: "Eating Out", confidence: 0.99 },
							transfer: { noul: 0 },
							reimbursement: { noul: 0 },
							income: { noul: 0 },
						},
					}),
					{ status: 200 },
				);
			},
			{ onlyIds: [id] },
		);
		await suggestTransactionNotes(
			{
				DB: db,
				AI: { run: async () => ({ response: "Dinner" }) } as unknown as Ai,
			},
			1,
		);
		expect(calls).toBe(1);
		row = await db
			.prepare(
				"SELECT note, note_guessed, kind, kind_guessed, for_person_id, for_person_guessed FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({
			note: "Dinner",
			note_guessed: 0,
			kind: "one_off",
			kind_guessed: 0,
			for_person_id: person?.id,
			for_person_guessed: 0,
		});
	});

	it("Looks right keeps the values posted with the confirmation", async () => {
		const id = await charge();
		await db
			.prepare("INSERT INTO household_people (name) VALUES ('Morgan')")
			.run();
		const person = await db
			.prepare("SELECT id FROM household_people WHERE name='Morgan'")
			.first<{ id: number }>();
		await db
			.prepare(
				"UPDATE transactions SET note='Old guess',note_guessed=1,kind='subscription',kind_guessed=1,for_person_id=1,for_person_guessed=1 WHERE id=?",
			)
			.bind(id)
			.run();
		await post(`/transactions/${id}`, {
			back: "/transactions",
			merchant_was: "",
			merchant: "Edited name",
			note: "New note",
			kind: "bill",
			for_person_id: String(person?.id),
			details_action: "keep",
		});
		expect(
			await db
				.prepare(
					"SELECT note,kind,for_person_id,note_guessed,kind_guessed,for_person_guessed FROM transactions WHERE id=?",
				)
				.bind(id)
				.first(),
		).toMatchObject({
			note: "New note",
			kind: "bill",
			for_person_id: person?.id,
			note_guessed: 0,
			kind_guessed: 0,
			for_person_guessed: 0,
		});
	});

	it("Looks right accepts the displayed name suggestion when no name is posted", async () => {
		const id = await charge();
		await db
			.prepare(
				"INSERT INTO merchants (raw_name,suggested_name,suggestion_status) VALUES ('COFFEE SHOP','Corner Coffee','pending')",
			)
			.run();
		const saved = await post(`/transactions/${id}`, {
			back: "/transactions",
			merchant_was: "",
			displayed_name_guess: "Corner Coffee",
			note: "",
			details_action: "keep",
		});
		expect(saved.res.status).toBe(200);
		expect(
			await db
				.prepare(
					"SELECT display_name,suggestion_status FROM merchants WHERE raw_name='COFFEE SHOP'",
				)
				.first(),
		).toEqual({ display_name: "Corner Coffee", suggestion_status: "accepted" });
	});

	it("does not reuse a removed highest household person id", async () => {
		await db
			.prepare("INSERT INTO household_people (name) VALUES ('Last person')")
			.run();
		const old = await db
			.prepare("SELECT id FROM household_people WHERE name='Last person'")
			.first<{ id: number }>();
		await db
			.prepare("DELETE FROM household_people WHERE id=?")
			.bind(old?.id)
			.run();
		await db
			.prepare("INSERT INTO household_people (name) VALUES ('New person')")
			.run();
		const next = await db
			.prepare("SELECT id FROM household_people WHERE name='New person'")
			.first<{ id: number }>();
		expect(next?.id).not.toBe(old?.id);
	});

	it("Looks right preserves a name a person had already chosen", async () => {
		const id = await charge();
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name, suggestion_status) VALUES ('COFFEE SHOP', 'My Coffee Shop', 'accepted')",
			)
			.run();
		const saved = await post(`/transactions/${id}`, {
			back: "/transactions",
			merchant_was: "My Coffee Shop",
			merchant: "My Coffee Shop",
			note: "",
			details_action: "keep",
		});
		expect(saved.res.status).toBe(200);
		expect(
			await db
				.prepare(
					"SELECT display_name, suggestion_status FROM merchants WHERE raw_name = 'COFFEE SHOP'",
				)
				.first(),
		).toEqual({
			display_name: "My Coffee Shop",
			suggestion_status: "accepted",
		});
	});

	it("only lists household people and Everyone in the For choices", async () => {
		const id = await charge();
		await db
			.prepare(
				"INSERT INTO household_people (name) VALUES ('Kids'), ('Morgan')",
			)
			.run();
		const { html } = await get(`/transactions/${id}`);
		const forRow =
			html
				.split('<legend class="sr-only">For</legend>')[1]
				?.split("</fieldset>")[0] ?? "";
		expect(forRow).toContain("Everyone");
		expect(forRow).toContain('name="for_person_id" value=""');
		expect(forRow).toContain("No one");
		expect(forRow).toContain("Kids");
		expect(forRow).toContain("Morgan");
		expect(forRow).not.toContain('name="category"');
		expect(html).toContain('name="kind" value=""');
		expect(html).toContain("Not known");
	});

	it("offers a household member named Not sure as a distinct Jev choice", async () => {
		const id = await charge();
		await saveAiSwitches(db, { details: true, categories: true, income: true });
		await db
			.prepare("INSERT INTO household_people(name) VALUES('Not sure')")
			.run();
		await categorizePending(
			{ DB: db, JEV_API_KEY: "test-key" },
			async (_url, init) => {
				const request = JSON.parse(String(init?.body)) as Record<
					string,
					unknown
				>;
				const person = (
					request.questions as {
						for_person: { criteria: Record<string, unknown> };
					}
				).for_person.criteria;
				const idChoice = Object.keys(person).find(
					(key) => person[key] === "Not sure",
				);
				return Response.json({
					answers: {
						category: { choice: "Eating Out", confidence: 0.99 },
						transfer: { noul: 0 },
						reimbursement: { noul: 0 },
						income: { noul: 0 },
						kind: { choice: "one_off", confidence: 0.99 },
						for_person: { choice: idChoice, confidence: 0.99 },
						note_worth_writing: { noul: 0.95 },
					},
				});
			},
			{ onlyIds: [id] },
		);
		expect(
			await db
				.prepare(
					"SELECT hp.name FROM transactions t LEFT JOIN household_people hp ON hp.id=t.for_person_id WHERE t.id=?",
				)
				.bind(id)
				.first(),
		).toEqual({ name: "Not sure" });
	});
});

describe("household people and details switch", () => {
	it("keeps rejected add and rename values in the redisplayed fields", async () => {
		const tooLong = "x".repeat(41);
		const add = await post("/settings/people", {
			action: "add",
			name: tooLong,
		});
		expect(add.res.status).toBe(422);
		expect(add.html).toContain(`value="${tooLong}"`);
		await db
			.prepare("INSERT INTO household_people(name) VALUES('Existing')")
			.run();
		const person = await db
			.prepare("SELECT id FROM household_people WHERE name='Existing'")
			.first<{ id: number }>();
		const duplicate = await post("/settings/people", {
			action: "rename",
			person_id: String(person?.id),
			name: "Everyone",
		});
		expect(duplicate.res.status).toBe(422);
		expect(duplicate.html).toContain('value="Everyone"');
	});

	it("returns focus to the people section after a save or remove", async () => {
		const add = await post("/settings/people", { action: "add", name: "Kids" });
		expect(add.html).toMatch(/<h1 id="people-title"[^>]*autofocus/);
	});

	it("shows household people on the People page and allows adding, renaming and removing one", async () => {
		const tx = await charge();
		const { html } = await get("/settings/people");
		expect(textOf(html)).toContain("People");
		expect(textOf(html)).toContain("Add a person");
		const added = await post("/settings/people", {
			action: "add",
			name: "Kids",
		});
		expect(added.res.status).toBe(200);
		expect(textOf(added.html)).toContain("Kids");
		const person = await db
			.prepare("SELECT id FROM household_people WHERE name = 'Kids'")
			.first<{ id: number }>();
		await db
			.prepare("UPDATE transactions SET for_person_id = ? WHERE id = ?")
			.bind(person?.id, tx)
			.run();
		const renamed = await post("/settings/people", {
			action: "rename",
			person_id: String(person?.id),
			name: "Children",
		});
		expect(renamed.res.status).toBe(200);
		expect(textOf(renamed.html)).toContain("Children");
		const removed = await post("/settings/people", {
			action: "rename",
			remove: "1",
			person_id: String(person?.id),
			name: "Children",
		});
		expect(removed.res.status).toBe(200);
		expect(removed.res.headers.get("HX-Trigger")).toContain(
			"1 purchase for Children now say no one.",
		);
		expect(
			await db
				.prepare("SELECT id FROM household_people WHERE name = 'Children'")
				.first(),
		).toBeNull();
		expect(
			await db
				.prepare("SELECT for_person_id FROM transactions WHERE id = ?")
				.bind(tx)
				.first<{ for_person_id: number | null }>(),
		).toMatchObject({ for_person_id: null });
	});

	it("saves all five switches together and treats an omitted details checkbox as off", async () => {
		const { html } = await get("/settings/ai");
		expect(html).toContain('name="details"');
		await post("/settings/ai", {
			names: "on",
			categories: "on",
			income: "on",
			sortOnArrival: "on",
		});
		expect(await readAiSwitches(db)).toMatchObject({ details: false });
		await saveAiSwitches(db, { details: true });
		expect(await readAiSwitches(db)).toMatchObject({ details: true });
	});
});
