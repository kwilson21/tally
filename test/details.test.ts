import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { categorizePending } from "../src/categorize-pending";
import { readAiSwitches, saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";
import { suggestTransactionNotes } from "../src/suggest-names-pending";

const db = env.DB;
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
						for_person: { choice: "Morgan", confidence: 0.99 },
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
	});

	it("shows a guessed note as the dashed caption beside Needs category", async () => {
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
		expect(html).toContain('href="/settings#household"');
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
							for_person: { choice: "Everyone", confidence: 0.99 },
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

	it("Looks right keeps all four details, and turning details off preserves them", async () => {
		const id = await charge();
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('COFFEE SHOP', 'Coffee Shop', 'pending')",
			)
			.run();
		const before = await get(`/transactions/${id}`);
		expect(before.html).toContain('value="s:Coffee Shop"');
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
		).toEqual({ display_name: "Coffee Shop", suggestion_status: "accepted" });
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
		expect(forRow).toContain("Kids");
		expect(forRow).toContain("Morgan");
		expect(forRow).not.toContain('name="category"');
	});
});

describe("household people and details switch", () => {
	it("shows household people in Settings and allows adding one without JavaScript", async () => {
		const tx = await charge();
		const { html } = await get("/settings");
		expect(textOf(html)).toContain("Household");
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
		const { html } = await get("/settings");
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
