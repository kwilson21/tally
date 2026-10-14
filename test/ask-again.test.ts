import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JEV_URL } from "../src/ai/categorize";
import { categorizePending } from "../src/categorize-pending";
import { DEFAULT_TIME_ZONE, householdToday, todayIn } from "../src/dates";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { pendingSuggestions } from "../src/db/category-suggestions";
import { resetDemo } from "../src/demo/reset";
import { transactions } from "../src/routes/transactions";
import { tidyName } from "../src/transactions/tidy-name";

// Spec §7, decision 79: when a person adds a clearer name or a note to a transaction that still needs
// a category, Tally asks Jev again right away, after the page has answered (so a save never waits for
// it), as for a note in decision 64. A transaction that already has a category asks nothing.

const db = env.DB;
let waitUntil: ReturnType<typeof vi.fn<(promise: Promise<unknown>) => void>>;
const ctx = () => ({ waitUntil, passThroughOnException() {}, props: {} });
/** The background work a save handed to waitUntil, finished. */
const background = () => Promise.all(waitUntil.mock.calls.map(([p]) => p));

type JevBody = { state: Record<string, unknown> };
/** A fake Jev: every call is recorded, and answered with Eating Out at `confidence`. */
function fakeJev(
	answer: () => Response | Promise<Response> = () => reply(0.95),
) {
	const bodies: JevBody[] = [];
	const fetchImpl = vi.fn(
		async (url: RequestInfo | URL, init?: RequestInit) => {
			if (String(url) !== JEV_URL) throw new Error(`unexpected fetch ${url}`);
			bodies.push(JSON.parse(String(init?.body)));
			return answer();
		},
	);
	vi.stubGlobal("fetch", fetchImpl);
	return { bodies, fetchImpl };
}
const reply = (confidence: number) =>
	Response.json({
		answers: {
			category: { type: "choice", choice: "Eating Out", confidence },
			transfer: { type: "noul", noul: 0.01 },
			reimbursement: { type: "noul", noul: 0.01 },
			income: { type: "noul", noul: 0.01 },
		},
	});

/** Saves the edit panel the way the browser posts it. */
async function save(
	id: number,
	fields: Record<string, string>,
	bindings: Record<string, unknown> = { JEV_API_KEY: "jev-key" },
) {
	const response = await transactions.request(
		`/transactions/${id}`,
		{
			method: "POST",
			headers: {
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(fields).toString(),
		},
		{ ...env, ...bindings },
		ctx(),
	);
	return { response, html: await response.text() };
}

const rowOf = (id: number) =>
	db
		.prepare(
			"SELECT category_id, category_source, category_confidence, note FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first();
const idOf = async (rawName: string) =>
	(
		await db
			.prepare("SELECT id FROM transactions WHERE raw_name = ?")
			.bind(rawName)
			.first<{ id: number }>()
	)?.id as number;
const callsUsed = async () =>
	Number(
		(
			await db
				.prepare("SELECT value FROM household_settings WHERE key = ?")
				.bind(`jev_calls_${await householdToday(db)}`)
				.first<{ value: string }>()
		)?.value ?? 0,
	);

let bakery: number;
beforeEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	waitUntil = vi.fn<(promise: Promise<unknown>) => void>((promise) => {
		void promise.catch(() => {});
	});
	await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
	await saveAiSwitches(db, { details: false });
	await db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();
	bakery = await idOf("SQ *LOCAL BAKERY 4432");
});

describe("adding a note to a transaction that still needs a category", () => {
	it("asks Jev again right away, telling it the note, and applies a sure answer", async () => {
		const jev = fakeJev();
		const { response } = await save(bakery, {
			category: "",
			merchant: "Local Bakery",
			note: "Birthday cake for Sam",
		});
		expect(response.status).toBe(200);
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await background();
		expect(jev.bodies).toHaveLength(1);
		expect(jev.bodies[0]?.state).toMatchObject({
			bank_description: "SQ *LOCAL BAKERY 4432",
			note: "Birthday cake for Sam",
		});
		expect(await rowOf(bakery)).toMatchObject({
			category_source: "jev",
			category_confidence: 0.95,
			note: "Birthday cake for Sam",
		});
		expect(await callsUsed()).toBe(1);
	});

	it("asks again about one Jev looked at and wasn't sure of, which waited for the night until now", async () => {
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = 0.4, jev_category_id = 1 WHERE id = ?",
			)
			.bind(bakery)
			.run();
		const jev = fakeJev(() => reply(0.97));
		await save(bakery, {
			category: "",
			merchant: "Local Bakery",
			note: "Cake",
		});
		await background();
		expect(jev.bodies).toHaveLength(1);
		expect(await rowOf(bakery)).toMatchObject({
			category_source: "jev",
			category_confidence: 0.97,
		});
	});

	it("answers the save without waiting for Jev", async () => {
		let release: (response: Response) => void = () => {};
		const slow = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const jev = fakeJev(() => slow);
		const { response } = await save(bakery, {
			category: "",
			merchant: "Local Bakery",
			note: "Cake",
		});
		// The page has answered, saved, and Jev's call is still going.
		expect(response.status).toBe(200);
		expect(await rowOf(bakery)).toMatchObject({
			note: "Cake",
			category_source: null,
		});
		await vi.waitFor(() => expect(jev.bodies).toHaveLength(1));
		expect(await rowOf(bakery)).toMatchObject({ category_source: null });
		release(reply(0.95));
		await background();
		expect(await rowOf(bakery)).toMatchObject({ category_source: "jev" });
	});

	it("leaves the save as it was when Jev is down, and leaves the transaction for the night", async () => {
		const jev = fakeJev(() => new Response("{}", { status: 503 }));
		const { response } = await save(bakery, {
			category: "",
			merchant: "Local Bakery",
			note: "Cake",
		});
		await expect(background()).resolves.toBeDefined();
		expect(response.status).toBe(200);
		expect(jev.bodies).toHaveLength(1);
		expect(await rowOf(bakery)).toEqual({
			category_id: null,
			category_source: null,
			category_confidence: null,
			note: "Cake",
		});
		// The night's run asks about it.
		const night = fakeJev();
		await categorizePending(
			{ DB: db, JEV_API_KEY: "jev-key" },
			night.fetchImpl,
		);
		expect(night.bodies.map((b) => b.state.bank_description)).toContain(
			"SQ *LOCAL BAKERY 4432",
		);
	});

	it("doesn't ask when the note is unchanged, or taken away", async () => {
		const jev = fakeJev();
		await db
			.prepare("UPDATE transactions SET note = 'Cake' WHERE id = ?")
			.bind(bakery)
			.run();
		await save(bakery, {
			category: "",
			merchant: "Local Bakery",
			note: "Cake",
		});
		await save(bakery, { category: "", merchant: "Local Bakery", note: "" });
		expect(waitUntil).not.toHaveBeenCalled();
		expect(jev.bodies).toHaveLength(0);
	});

	it("doesn't ask when the same save picks a category", async () => {
		const jev = fakeJev();
		await save(bakery, {
			category: "2",
			merchant: "Local Bakery",
			note: "Cake",
		});
		expect(waitUntil).not.toHaveBeenCalled();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: 2,
			category_source: "user",
		});
	});

	it("asks nothing for a transaction that already has a category", async () => {
		const categorized = (
			await db
				.prepare(
					"SELECT id FROM transactions WHERE category_id IS NOT NULL AND is_split = 0 AND parent_id IS NULL AND amount_cents > 0 LIMIT 1",
				)
				.first<{ id: number }>()
		)?.id as number;
		const jev = fakeJev();
		const before = await rowOf(categorized);
		await save(categorized, {
			category: String((before as { category_id: number }).category_id),
			merchant: "A clearer name",
			note: "A note nobody had",
		});
		expect(waitUntil).not.toHaveBeenCalled();
		expect(jev.bodies).toHaveLength(0);
		expect(await callsUsed()).toBe(0);
		expect(await rowOf(categorized)).toMatchObject({
			category_id: (before as { category_id: number }).category_id,
			note: "A note nobody had",
		});
	});
});

describe("a merchant rule comes before Jev (spec §7)", () => {
	it("gives the rule's category, and doesn't ask Jev, when a rule matches the transaction", async () => {
		await db
			.prepare(
				"UPDATE merchants SET default_category_id = 2 WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
			)
			.run();
		const jev = fakeJev();
		await save(bakery, {
			category: "",
			merchant: "Local Bakery",
			note: "Birthday cake for Sam",
		});
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: 2,
			category_source: "merchant_rule",
			category_confidence: null,
			note: "Birthday cake for Sam",
		});
		expect(await callsUsed()).toBe(0);
	});

	it("gives the rule's category to one Jev wasn't sure of, without asking again", async () => {
		await db.batch([
			db.prepare(
				"UPDATE merchants SET default_category_id = 2 WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
			),
			db
				.prepare(
					"UPDATE transactions SET category_confidence = 0.4, jev_category_id = 1 WHERE id = ?",
				)
				.bind(bakery),
		]);
		const jev = fakeJev();
		await save(bakery, {
			category: "",
			merchant: "Local Bakery",
			note: "Cake",
		});
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: 2,
			category_source: "merchant_rule",
		});
	});

	it("asks Jev when the rule's category is archived, so the rule can't apply", async () => {
		await db.batch([
			db.prepare(
				"UPDATE merchants SET default_category_id = 2 WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
			),
			db.prepare("UPDATE categories SET archived = 1 WHERE id = 2"),
		]);
		const jev = fakeJev();
		await save(bakery, {
			category: "",
			merchant: "Local Bakery",
			note: "Cake",
		});
		await background();
		expect(jev.bodies).toHaveLength(1);
	});
});

describe("adding a clearer name to a transaction that still needs a category", () => {
	it("asks Jev again right away, with the new name", async () => {
		const jev = fakeJev();
		await save(bakery, {
			category: "",
			name_pick: "own",
			merchant: "Neighborhood Bakery",
			note: "",
		});
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await background();
		expect(jev.bodies).toHaveLength(1);
		expect(jev.bodies[0]?.state).toMatchObject({
			bank_description: "SQ *LOCAL BAKERY 4432",
			merchant: "Neighborhood Bakery",
		});
		expect(await rowOf(bakery)).toMatchObject({ category_source: "jev" });
	});

	it("doesn't ask when the name is left as it was", async () => {
		const jev = fakeJev();
		await save(bakery, { category: "", merchant: "Local Bakery", note: "" });
		expect(waitUntil).not.toHaveBeenCalled();
		expect(jev.bodies).toHaveLength(0);
	});

	it("asks when a panel that says what it showed (merchant_was) has its name changed", async () => {
		const jev = fakeJev();
		await save(bakery, {
			category: "",
			merchant_was: "Local Bakery",
			name_pick: "own",
			merchant: "Neighborhood Bakery",
			note: "",
		});
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await background();
		expect(jev.bodies).toHaveLength(1);
	});

	it("doesn't ask when an out-of-date panel is saved after another tab renamed the merchant, and keeps the new name", async () => {
		const jev = fakeJev();
		// The panel was drawn with "Local Bakery"; another tab renamed the merchant since.
		await db
			.prepare(
				"UPDATE merchants SET display_name = 'Corner Bakery' WHERE display_name = 'Local Bakery'",
			)
			.run();
		await save(bakery, {
			category: "",
			merchant_was: "Local Bakery",
			merchant: "Local Bakery",
			note: "",
		});
		expect(waitUntil).not.toHaveBeenCalled();
		expect(jev.bodies).toHaveLength(0);
		expect(await callsUsed()).toBe(0);
		const name = await db
			.prepare(
				"SELECT display_name FROM merchants WHERE display_name LIKE '%Bakery'",
			)
			.first<{ display_name: string }>();
		expect(name?.display_name).toBe("Corner Bakery");
	});

	it("doesn't ask when a panel that showed no name is saved after another tab chose one", async () => {
		const jev = fakeJev();
		const deli = await idOf("TST* CORNER DELI");
		await db
			.prepare(
				"UPDATE merchants SET display_name = 'Deli Counter', suggestion_status = 'accepted' WHERE raw_name = 'TST* CORNER DELI'",
			)
			.run();
		await save(deli, {
			category: "",
			merchant_was: "",
			merchant: "",
			note: "",
		});
		expect(waitUntil).not.toHaveBeenCalled();
		expect(jev.bodies).toHaveLength(0);
	});
});

// Decision 101: a one-off name makes Tally guess the category again, but only while Jev answers categories
// (the key is set and the categories switch is on). With Jev off, the category Tally picked stays.
describe("a one-off name on a category Tally picked (decision 101)", () => {
	const firstCategory = async () =>
		(
			await db
				.prepare(
					"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1",
				)
				.first<{ id: number }>()
		)?.id as number;
	const pickedByTally = (categoryId: number) =>
		db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'jev', category_confidence = 0.95 WHERE id = ?",
			)
			.bind(categoryId, bakery)
			.run();
	/** The edit panel as the browser gets it, with the bindings it is served under. */
	const panel = async (bindings: Record<string, unknown>) =>
		(
			await transactions.request(
				`/transactions/${bakery}?month=all`,
				{},
				{ ...env, ...bindings },
				ctx(),
			)
		).text();

	it("clears the category Tally picked, and Jev guesses it again from the new name", async () => {
		const category = await firstCategory();
		await pickedByTally(category);
		// Jev is unsure, so the category is left empty for the night.
		const jev = fakeJev(() => reply(0.2));
		await save(bakery, {
			category: String(category),
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
		});
		await background();
		expect(jev.bodies).toHaveLength(1);
		expect(jev.bodies[0]?.state).toMatchObject({ merchant: "Dog bed" });
		expect(await rowOf(bakery)).toMatchObject({
			category_id: null,
			category_source: null,
		});
	});

	it("announces Saved with the name, and says Tally guesses its category again, not the category the save posted", async () => {
		const category = await firstCategory();
		await pickedByTally(category);
		fakeJev(() => reply(0.2));
		const { response } = await save(bakery, {
			category: String(category),
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
		});
		await background();
		expect(
			JSON.parse(response.headers.get("HX-Trigger") ?? "{}").announce,
		).toBe("Saved Dog bed. Tally guesses its category again.");
		expect(await rowOf(bakery)).toMatchObject({ category_id: null });
	});

	it("the store's own name under This one only is a one-off name too: Jev guesses the category again", async () => {
		const category = await firstCategory();
		await pickedByTally(category);
		const jev = fakeJev(() => reply(0.2));
		await save(bakery, {
			category: String(category),
			name_pick: "store",
			name_scope: "one",
		});
		await background();
		expect(jev.bodies).toHaveLength(1);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: null,
			category_source: null,
		});
	});

	it("leaves a category a person picked alone when the name changes", async () => {
		const category = await firstCategory();
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(category, bakery)
			.run();
		const jev = fakeJev();
		await save(bakery, {
			name_pick: "own",
			merchant: "Gift",
			name_scope: "one",
		});
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: category,
			category_source: "user",
		});
	});

	it("keeps Tally's category when the same save ticks Always for this merchant: the rule is made, Jev is asked nothing, and the words say nothing of guessing again", async () => {
		const category = await firstCategory();
		await pickedByTally(category);
		const jev = fakeJev(() => reply(0.2));
		const { response } = await save(bakery, {
			category: String(category),
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
			always: "1",
			always_was: "0",
			rule_category_was: "",
		});
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: category,
			category_source: "jev",
		});
		expect(
			await db
				.prepare(
					"SELECT default_category_id FROM merchants WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
				)
				.first(),
		).toMatchObject({ default_category_id: category });
		const categoryName = (
			await db
				.prepare("SELECT name FROM categories WHERE id = ?")
				.bind(category)
				.first<{ name: string }>()
		)?.name;
		const trigger = JSON.parse(response.headers.get("HX-Trigger") ?? "{}");
		expect(trigger.announce).toBe(`Saved. Dog bed is now ${categoryName}.`);
		expect(trigger.announce).not.toContain("guesses its category again");
		expect(trigger.toast.message).toBe("Saved Dog bed");
	});

	it("says Tally guesses its category again while Jev answers categories", async () => {
		await pickedByTally(await firstCategory());
		expect(await panel({ JEV_API_KEY: "jev-key" })).toContain(
			"Tally guesses its category again.",
		);
	});

	it("puts the note under the edit form's named group, so picking another control folds it away", async () => {
		await pickedByTally(await firstCategory());
		const html = await panel({ JEV_API_KEY: "jev-key" });
		const editForm = html
			.split("<form")
			.find((part) => part.includes(`action="/transactions/${bakery}"`));
		expect(editForm?.slice(0, editForm.indexOf(">"))).toContain("group/edit");
		const note = html.match(
			/<span class="([^"]*)">Tally guesses its category again\.<\/span>/,
		)?.[1];
		expect(note).toContain(
			"group-has-[input[name=category]:checked:not([checked])]/edit:hidden",
		);
	});

	it("folds the note both ways when Always for this merchant changes, since ticking it keeps the category", async () => {
		await pickedByTally(await firstCategory());
		const html = await panel({ JEV_API_KEY: "jev-key" });
		const note = html.match(
			/<span class="([^"]*)">Tally guesses its category again\.<\/span>/,
		)?.[1];
		expect(note).toContain(
			"group-has-[input[name=always]:checked:not([checked])]/edit:hidden",
		);
		expect(note).toContain(
			"group-has-[input[name=always][checked]:not(:checked)]/edit:hidden",
		);
	});

	it("draws no note on a 422 redraw that posts another category, since the save keeps that one", async () => {
		const category = await firstCategory();
		const other = (
			await db
				.prepare(
					"SELECT id FROM categories WHERE archived = 0 AND id != ? ORDER BY id LIMIT 1",
				)
				.bind(category)
				.first<{ id: number }>()
		)?.id as number;
		await pickedByTally(category);
		fakeJev();
		const { response, html } = await save(bakery, {
			category: String(other),
			name_pick: "own",
			merchant: "",
			name_scope: "one",
		});
		expect(response.status).toBe(422);
		expect(html).not.toContain("Tally guesses its category again.");
	});

	it("keeps the note on a 422 redraw that posts the row's own category", async () => {
		const category = await firstCategory();
		await pickedByTally(category);
		fakeJev();
		const { response, html } = await save(bakery, {
			category: String(category),
			name_pick: "own",
			merchant: "",
			name_scope: "one",
		});
		expect(response.status).toBe(422);
		expect(html).toContain("Tally guesses its category again.");
	});

	it("draws no note on a 422 redraw that posts the row's own category with Always for this merchant ticked, since the save keeps it", async () => {
		const category = await firstCategory();
		await pickedByTally(category);
		fakeJev();
		const { response, html } = await save(bakery, {
			category: String(category),
			name_pick: "own",
			merchant: "",
			name_scope: "one",
			always: "1",
			always_was: "0",
			rule_category_was: "",
		});
		expect(response.status).toBe(422);
		expect(html).not.toContain("Tally guesses its category again.");
	});

	it("draws no note on a row whose category was set by a person, even with no category id", async () => {
		await db
			.prepare(
				"UPDATE transactions SET category_id = NULL, category_source = 'user' WHERE id = ?",
			)
			.bind(bakery)
			.run();
		expect(await panel({ JEV_API_KEY: "jev-key" })).not.toContain(
			"Tally guesses its category again.",
		);
	});

	it("keeps Tally's category, and says nothing of guessing again, while the categories switch is off", async () => {
		await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, categories: false });
		const category = await firstCategory();
		await pickedByTally(category);
		const jev = fakeJev();
		await save(bakery, {
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
		});
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: category,
			category_source: "jev",
		});
		const html = await panel({ JEV_API_KEY: "jev-key" });
		expect(html).toContain("This one only");
		expect(html).not.toContain("Tally guesses its category again.");
	});

	it("keeps Tally's category, and says nothing of guessing again, without a Jev key", async () => {
		const category = await firstCategory();
		await pickedByTally(category);
		const jev = fakeJev();
		await save(
			bakery,
			{ name_pick: "own", merchant: "Dog bed", name_scope: "one" },
			{},
		);
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: category,
			category_source: "jev",
		});
		expect(await panel({})).not.toContain("Tally guesses its category again.");
	});
	/** The row behind a pending new-category suggestion, as a none-fit answer leaves it: Jev was sure, and no category was chosen. */
	const behindSuggestion = async () => {
		await db
			.prepare(
				"INSERT INTO category_suggestions (name, status) VALUES ('Bakery supplies', 'pending')",
			)
			.run();
		await db
			.prepare(
				`UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = 0.93,
					jev_none_fit = 1, jev_category_id = NULL,
					category_suggestion_id = (SELECT id FROM category_suggestions WHERE name = 'Bakery supplies')
				 WHERE id = ?`,
			)
			.bind(bakery)
			.run();
	};
	const answerColumns = (id: number) =>
		db
			.prepare(
				"SELECT category_id, category_source, category_confidence, category_suggestion_id, jev_category_id, jev_none_fit FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<Record<string, unknown>>();
	/** The ids of the rows the Settings page lists behind pending suggestions. */
	const listedRows = async () =>
		(await pendingSuggestions(db)).flatMap((suggestion) =>
			suggestion.rows.map((listed) => listed.id),
		);

	it("releases the pending suggestion when a one-off name makes Jev guess again, and asks Jev with the name", async () => {
		await behindSuggestion();
		expect(await listedRows()).toContain(bakery);
		const jev = fakeJev(() => new Response("{}", { status: 503 }));
		await save(bakery, {
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
		});
		await background();
		expect(jev.bodies).toHaveLength(1);
		expect(jev.bodies[0]?.state).toMatchObject({ merchant: "Dog bed" });
		expect(await answerColumns(bakery)).toEqual({
			category_id: null,
			category_source: null,
			category_confidence: null,
			category_suggestion_id: null,
			jev_category_id: null,
			jev_none_fit: 0,
		});
		expect(await listedRows()).not.toContain(bakery);
	});

	it("releases the pending suggestion even when the row's confidence was already cleared, as a failed re-ask leaves it", async () => {
		await behindSuggestion();
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = NULL WHERE id = ?",
			)
			.bind(bakery)
			.run();
		expect(await listedRows()).toContain(bakery);
		const jev = fakeJev(() => new Response("{}", { status: 503 }));
		await save(bakery, {
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
		});
		await background();
		expect(jev.bodies).toHaveLength(1);
		expect(jev.bodies[0]?.state).toMatchObject({ merchant: "Dog bed" });
		expect(await answerColumns(bakery)).toEqual({
			category_id: null,
			category_source: null,
			category_confidence: null,
			category_suggestion_id: null,
			jev_category_id: null,
			jev_none_fit: 0,
		});
		expect(await listedRows()).not.toContain(bakery);
	});

	it("releases the suggestion the same way after a note's failed re-ask cleared the confidence", async () => {
		await behindSuggestion();
		fakeJev(() => new Response("{}", { status: 503 }));
		await save(bakery, {
			category: "",
			merchant: "Local Bakery",
			note: "Birthday cake for Sam",
		});
		await background();
		expect(await answerColumns(bakery)).toMatchObject({
			category_confidence: null,
			category_suggestion_id: expect.any(Number),
		});
		expect(await listedRows()).toContain(bakery);
		const jev = fakeJev(() => new Response("{}", { status: 503 }));
		await save(bakery, {
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
		});
		await background();
		expect(jev.bodies).toHaveLength(1);
		expect(await answerColumns(bakery)).toEqual({
			category_id: null,
			category_source: null,
			category_confidence: null,
			category_suggestion_id: null,
			jev_category_id: null,
			jev_none_fit: 0,
		});
		expect(await listedRows()).not.toContain(bakery);
	});

	it.each(["user", "merchant_rule"])(
		"keeps every column of a row whose %s category is set, suggestion and all",
		async (source) => {
			await behindSuggestion();
			await db
				.prepare(
					"UPDATE transactions SET category_id = ?, category_source = ? WHERE id = ?",
				)
				.bind(await firstCategory(), source, bakery)
				.run();
			const before = await answerColumns(bakery);
			const jev = fakeJev();
			await save(bakery, {
				name_pick: "own",
				merchant: "Dog bed",
				name_scope: "one",
			});
			await background();
			expect(jev.bodies).toHaveLength(0);
			expect(await answerColumns(bakery)).toEqual(before);
		},
	);

	it("keeps the suggestion link of an excluded row, which a one-off name doesn't re-guess", async () => {
		await behindSuggestion();
		await db
			.prepare(
				"UPDATE transactions SET excluded = 1, excluded_source = 'user' WHERE id = ?",
			)
			.bind(bakery)
			.run();
		const before = await answerColumns(bakery);
		expect(before).toMatchObject({
			category_suggestion_id: expect.any(Number),
		});
		const jev = fakeJev();
		await save(bakery, {
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
			excluded: "1",
		});
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await answerColumns(bakery)).toMatchObject({
			category_suggestion_id: before?.category_suggestion_id,
			jev_none_fit: 1,
		});
	});
	it("says Kept the details for the name, and that Tally guesses its category again, when Looks right keeps a category Tally picked", async () => {
		const category = await firstCategory();
		await pickedByTally(category);
		fakeJev(() => reply(0.2));
		const { response } = await save(bakery, {
			category: String(category),
			details_action: "keep",
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
		});
		await background();
		expect(
			JSON.parse(response.headers.get("HX-Trigger") ?? "{}").announce,
		).toBe("Kept the details for Dog bed. Tally guesses its category again.");
		expect(await rowOf(bakery)).toMatchObject({ category_id: null });
	});

	it("says just Kept the details for the name while the categories switch is off", async () => {
		await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, categories: false });
		const category = await firstCategory();
		await pickedByTally(category);
		fakeJev();
		const { response } = await save(bakery, {
			details_action: "keep",
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
		});
		await background();
		expect(
			JSON.parse(response.headers.get("HX-Trigger") ?? "{}").announce,
		).toBe("Kept the details for Dog bed.");
	});

	const ownNameOf = async (id: number) =>
		(
			await db
				.prepare("SELECT own_name FROM transactions WHERE id = ?")
				.bind(id)
				.first<{ own_name: string | null }>()
		)?.own_name;

	it("picking the row's own name again under This one only keeps Tally's category and asks Jev nothing", async () => {
		const category = await firstCategory();
		await db
			.prepare("UPDATE transactions SET own_name = 'Dog bed' WHERE id = ?")
			.bind(bakery)
			.run();
		await pickedByTally(category);
		const jev = fakeJev(() => reply(0.2));
		const { response } = await save(bakery, {
			category: String(category),
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
		});
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: category,
			category_source: "jev",
		});
		expect(await ownNameOf(bakery)).toBe("Dog bed");
		expect(
			JSON.parse(response.headers.get("HX-Trigger") ?? "{}").announce,
		).not.toContain("Tally guesses its category again.");
	});

	it("picking the store's name again under This one only, when the row already shows it, keeps Tally's category and asks Jev nothing", async () => {
		const category = await firstCategory();
		const tidied = tidyName("SQ *LOCAL BAKERY 4432");
		await db
			.prepare("UPDATE transactions SET own_name = ? WHERE id = ?")
			.bind(tidied, bakery)
			.run();
		await pickedByTally(category);
		const jev = fakeJev(() => reply(0.2));
		const { response } = await save(bakery, {
			category: String(category),
			name_pick: "store",
			name_scope: "one",
		});
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: category,
			category_source: "jev",
		});
		expect(await ownNameOf(bakery)).toBe(tidied);
		expect(
			JSON.parse(response.headers.get("HX-Trigger") ?? "{}").announce,
		).not.toContain("Tally guesses its category again.");
	});

	it("picking the suggestion the row already shows under This one only keeps Tally's category, asks Jev nothing, and leaves the merchant's suggestion pending", async () => {
		const category = await firstCategory();
		await db
			.prepare(
				"UPDATE merchants SET display_name = NULL, suggested_name = 'Bakery Lane', suggestion_status = 'pending' WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
			)
			.run();
		await db
			.prepare("UPDATE transactions SET own_name = 'Bakery Lane' WHERE id = ?")
			.bind(bakery)
			.run();
		await pickedByTally(category);
		const jev = fakeJev(() => reply(0.2));
		const { response } = await save(bakery, {
			category: String(category),
			name_pick: "s:Bakery Lane",
			name_scope: "one",
		});
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: category,
			category_source: "jev",
		});
		expect(await ownNameOf(bakery)).toBe("Bakery Lane");
		expect(
			await db
				.prepare(
					"SELECT suggestion_status, display_name FROM merchants WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
				)
				.first(),
		).toEqual({ suggestion_status: "pending", display_name: null });
		expect(
			JSON.parse(response.headers.get("HX-Trigger") ?? "{}").announce,
		).not.toContain("Tally guesses its category again.");
	});

	it("picking the purchase's own name again under This one only leaves a split part's own name NULL, keeps its category, and asks Jev nothing", async () => {
		const category = await firstCategory();
		await db
			.prepare(
				"UPDATE transactions SET is_split = 1, own_name = 'Dog bed' WHERE id = ?",
			)
			.bind(bakery)
			.run();
		const part = await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, parent_id, category_id, category_source, category_confidence)
				 VALUES (?, 1, '2026-09-22', 300, 'SQ *LOCAL BAKERY 4432', ?, ?, 'jev', 0.95) RETURNING id`,
			)
			.bind(`part-${crypto.randomUUID()}`, bakery, category)
			.first<{ id: number }>();
		const partId = part?.id as number;
		const jev = fakeJev(() => reply(0.2));
		await save(partId, {
			category: String(category),
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
		});
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(partId)).toMatchObject({
			category_id: category,
			category_source: "jev",
		});
		expect(await ownNameOf(partId)).toBeNull();
	});

	it("typing a different name under This one only still asks Jev once and clears Tally's category", async () => {
		const category = await firstCategory();
		await db
			.prepare("UPDATE transactions SET own_name = 'Dog bed' WHERE id = ?")
			.bind(bakery)
			.run();
		await pickedByTally(category);
		const jev = fakeJev(() => reply(0.2));
		await save(bakery, {
			category: String(category),
			name_pick: "own",
			merchant: "Dog bowl",
			name_scope: "one",
		});
		await background();
		expect(jev.bodies).toHaveLength(1);
		expect(jev.bodies[0]?.state).toMatchObject({ merchant: "Dog bowl" });
		expect(await rowOf(bakery)).toMatchObject({
			category_id: null,
			category_source: null,
		});
		expect(await ownNameOf(bakery)).toBe("Dog bowl");
	});

	/** The re-guess note as the panel draws it, with its classes. */
	const noteClass = (html: string) =>
		html.match(
			/<span class="([^"]*)">Tally guesses its category again\.<\/span>/,
		)?.[1] ?? "";
	/** Makes the bakery row a credit (negative), linked to a purchase of the household's, or unlinked. */
	const creditLinked = async (linked: boolean) => {
		const purchase = await db
			.prepare(
				"SELECT id FROM transactions WHERE amount_cents > 0 AND excluded = 0 AND parent_id IS NULL AND is_split = 0 AND id != ? ORDER BY id LIMIT 1",
			)
			.bind(bakery)
			.first<{ id: number }>();
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -650, refund_of_id = ?, credit_reviewed = 0 WHERE id = ?",
			)
			.bind(linked ? purchase?.id : null, bakery)
			.run();
	};

	it("on a linked, unreviewed credit, the note folds on the review chip both ways, since ticking it makes the refund follow its purchase", async () => {
		await pickedByTally(await firstCategory());
		await creditLinked(true);
		const note = noteClass(await panel({ JEV_API_KEY: "jev-key" }));
		expect(note).toContain(
			"group-has-[input[name=creditReviewed]:checked:not([checked])]/edit:hidden",
		);
		expect(note).toContain(
			"group-has-[input[name=creditReviewed][checked]:not(:checked)]/edit:hidden",
		);
	});

	it("on an unlinked credit, the note has no review hooks, since no purchase is linked for a review to count", async () => {
		await pickedByTally(await firstCategory());
		await creditLinked(false);
		const html = await panel({ JEV_API_KEY: "jev-key" });
		expect(html).toContain("Tally guesses its category again.");
		expect(noteClass(html)).not.toContain("input[name=creditReviewed]");
	});

	it("marks the suggested name the row already shows as its own, so ticking it folds the note: the save keeps Tally's category", async () => {
		await pickedByTally(await firstCategory());
		await db
			.prepare(
				"UPDATE merchants SET display_name = NULL, suggested_name = 'Bakery Lane', suggestion_status = 'pending' WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
			)
			.run();
		await db
			.prepare("UPDATE transactions SET own_name = 'Bakery Lane' WHERE id = ?")
			.bind(bakery)
			.run();
		const html = await panel({ JEV_API_KEY: "jev-key" });
		const radio = html
			.split("<input")
			.find((part) => part.includes('value="s:Bakery Lane"'));
		expect(radio).toContain("name-same");
		expect(noteClass(html)).toContain(
			"group-has-[.name-same:checked]/edit:hidden",
		);
	});
});

describe("asking again honors what everything else does", () => {
	it("asks nothing without a Jev key", async () => {
		const jev = fakeJev();
		await save(
			bakery,
			{ category: "", merchant: "Local Bakery", note: "Cake" },
			{},
		);
		await background();
		expect(jev.bodies).toHaveLength(0);
	});

	it("asks nothing with categories and income both switched off", async () => {
		await saveAiSwitches(db, {
			...AI_SWITCHES_ALL_ON,
			details: false,
			categories: false,
			income: false,
		});
		const jev = fakeJev();
		await save(bakery, {
			category: "",
			merchant: "Local Bakery",
			note: "Cake",
		});
		await background();
		expect(jev.bodies).toHaveLength(0);
	});

	it("doesn't wait on the switch for sorting new transactions as they arrive, which is about syncs", async () => {
		await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, sortOnArrival: false });
		const jev = fakeJev();
		await save(bakery, {
			category: "",
			merchant: "Local Bakery",
			note: "Cake",
		});
		await background();
		expect(jev.bodies).toHaveLength(1);
	});

	it("counts against the day's cap, and asks nothing once it's used", async () => {
		await db
			.prepare("INSERT INTO household_settings (key, value) VALUES (?, '40')")
			.bind(`jev_calls_${await householdToday(db)}`)
			.run();
		const jev = fakeJev();
		await save(bakery, {
			category: "",
			merchant: "Local Bakery",
			note: "Cake",
		});
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await callsUsed()).toBe(40);
	});

	it("asks about that one transaction only, not the others waiting", async () => {
		const jev = fakeJev();
		await save(bakery, {
			category: "",
			merchant: "Local Bakery",
			note: "Cake",
		});
		await background();
		expect(jev.bodies).toHaveLength(1);
		const waiting = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL AND category_confidence IS NULL AND is_split = 0 AND excluded = 0 AND flag_income = 0",
			)
			.first<{ n: number }>();
		expect(waiting?.n).toBeGreaterThan(5);
	});
});

// Decision 101 (round 2): a one-off name asks Jev again only on a row Jev can be asked about (the rows
// pendingForJev classifies, src/transactions/rename.ts jevAsksAbout). Any other row keeps its category.
describe("a one-off name re-guesses only where Jev can be asked (decision 101)", () => {
	const firstCategory = async () =>
		(
			await db
				.prepare(
					"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1",
				)
				.first<{ id: number }>()
		)?.id as number;
	/** The bakery row as Tally picked its category, with `extra` columns changed too. */
	const pickedByTally = (categoryId: number, extra = "") =>
		db
			.prepare(
				`UPDATE transactions SET category_id = ?, category_source = 'jev', category_confidence = 0.95${extra} WHERE id = ?`,
			)
			.bind(categoryId, bakery)
			.run();
	const panelHtml = async () =>
		(
			await transactions.request(
				`/transactions/${bakery}?month=all`,
				{},
				{ ...env, JEV_API_KEY: "jev-key" },
				ctx(),
			)
		).text();

	it.each<{ name: string; extra: string; fields: Record<string, string> }>([
		{
			name: "an excluded transaction that doesn't pay a bill",
			extra: ", excluded = 1, excluded_source = 'user'",
			fields: { excluded: "1" },
		},
		{
			name: "an income transaction",
			extra: ", flag_income = 1, income_source = 'user'",
			fields: { income: "1", income_was: "1" },
		},
		{ name: "a split purchase", extra: ", is_split = 1", fields: {} },
	])(
		"keeps Tally's category for $name, and says nothing of guessing again",
		async ({ extra, fields }) => {
			const category = await firstCategory();
			await pickedByTally(category, extra);
			const jev = fakeJev(() => reply(0.2));
			const { response } = await save(bakery, {
				category: "",
				name_pick: "own",
				merchant: "Dog bed",
				name_scope: "one",
				...fields,
			});
			await background();
			expect(jev.bodies).toHaveLength(0);
			expect(await rowOf(bakery)).toMatchObject({
				category_id: category,
				category_source: "jev",
			});
			expect(
				JSON.parse(response.headers.get("HX-Trigger") ?? "{}").announce,
			).toBe("Saved Dog bed.");
			expect(await panelHtml()).not.toContain(
				"Tally guesses its category again.",
			);
		},
	);

	it("keeps Tally's category for a refund that follows its included purchase", async () => {
		const category = await firstCategory();
		const purchase = await db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name)
				 VALUES (1, '2026-09-10', 650, 'SQ *LOCAL BAKERY 4432', 'Local Bakery') RETURNING id`,
			)
			.first<{ id: number }>();
		await pickedByTally(
			category,
			`, amount_cents = -650, refund_of_id = ${purchase?.id}, credit_reviewed = 1, credit_reviewed_by = 'user'`,
		);
		const jev = fakeJev(() => reply(0.2));
		const { response } = await save(bakery, {
			category: "",
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
			income: "0",
			income_was: "0",
			creditReviewed: "1",
			creditReviewed_was: "1",
		});
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: category,
			category_source: "jev",
		});
		expect(
			JSON.parse(response.headers.get("HX-Trigger") ?? "{}").announce,
		).toBe("Saved Dog bed.");
		expect(await panelHtml()).not.toContain(
			"Tally guesses its category again.",
		);
	});

	it("still re-guesses the category of an excluded transaction that pays a bill", async () => {
		const category = await firstCategory();
		await db
			.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, category_id, merchant_raw_name) VALUES (700, 'Bakery club', 650, 28, 'monthly', 1, 'Not a match')",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (700, '2026-09', ?, 'user', 'linked')",
			)
			.bind(bakery)
			.run();
		await pickedByTally(category, ", excluded = 1, excluded_source = 'user'");
		const jev = fakeJev(() => reply(0.2));
		await save(bakery, {
			category: "",
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
			excluded: "1",
		});
		await background();
		expect(jev.bodies).toHaveLength(1);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: null,
			category_source: null,
		});
	});

	it("re-guesses the category when the same save un-excludes the transaction", async () => {
		const category = await firstCategory();
		await pickedByTally(category, ", excluded = 1, excluded_source = 'user'");
		const jev = fakeJev(() => reply(0.2));
		const { response } = await save(bakery, {
			category: "",
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
		});
		await background();
		expect(jev.bodies).toHaveLength(1);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: null,
			category_source: null,
		});
		expect(
			JSON.parse(response.headers.get("HX-Trigger") ?? "{}").announce,
		).toBe(
			"Saved Dog bed. Tally guesses its category again. It counts in the budget again.",
		);
	});
});

describe("a review as a non-income credit lifts Plaid's exclusion (decision 70)", () => {
	const firstCategory = async () =>
		(
			await db
				.prepare(
					"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1",
				)
				.first<{ id: number }>()
		)?.id as number;
	/** The bakery row as a bank credit that Plaid excluded (or, with `source`, someone else did), its category picked by Tally. */
	const excludedCredit = (categoryId: number, source = "plaid") =>
		db
			.prepare(
				"UPDATE transactions SET amount_cents = -650, excluded = 1, excluded_source = ?, category_id = ?, category_source = 'jev', category_confidence = 0.95 WHERE id = ?",
			)
			.bind(source, categoryId, bakery)
			.run();
	/** The panel's fields for a one-off name under This one only, with the exclusion chip and the review chip as given. */
	const renamed = (review: "0" | "1") => ({
		category: "",
		name_pick: "own",
		merchant: "Dog bed",
		name_scope: "one",
		excluded: "1",
		income: "0",
		income_was: "0",
		creditReviewed: review,
		creditReviewed_was: "0",
	});
	const panelHtml = async () =>
		(
			await transactions.request(
				`/transactions/${bakery}?month=all`,
				{},
				{ ...env, JEV_API_KEY: "jev-key" },
				ctx(),
			)
		).text();

	it("guesses the category again when the same save renames the credit and reviews it, and says it counts again", async () => {
		await excludedCredit(await firstCategory());
		const jev = fakeJev(() => reply(0.2));
		const { response } = await save(bakery, renamed("1"));
		await background();
		expect(jev.bodies).toHaveLength(1);
		expect(jev.bodies[0]?.state).toMatchObject({ merchant: "Dog bed" });
		expect(await rowOf(bakery)).toMatchObject({
			category_id: null,
			category_source: null,
		});
		expect(
			await db
				.prepare("SELECT excluded FROM transactions WHERE id = ?")
				.bind(bakery)
				.first<{ excluded: number }>(),
		).toMatchObject({ excluded: 0 });
		expect(
			JSON.parse(response.headers.get("HX-Trigger") ?? "{}").announce,
		).toBe(
			"Saved Dog bed. Tally guesses its category again. It counts in the budget again.",
		);
	});

	it("keeps the category when the same save renames the credit without the review, since it stays excluded", async () => {
		const category = await firstCategory();
		await excludedCredit(category);
		const jev = fakeJev(() => reply(0.2));
		const { response } = await save(bakery, renamed("0"));
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: category,
			category_source: "jev",
		});
		expect(
			JSON.parse(response.headers.get("HX-Trigger") ?? "{}").announce,
		).toBe("Saved Dog bed.");
	});

	it("keeps the category when the review is ticked but the exclusion is the person's, since only Plaid's exclusion lifts", async () => {
		const category = await firstCategory();
		await excludedCredit(category, "user");
		const jev = fakeJev(() => reply(0.2));
		const { response } = await save(bakery, renamed("1"));
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: category,
			category_source: "jev",
		});
		expect(
			JSON.parse(response.headers.get("HX-Trigger") ?? "{}").announce,
		).toBe("Saved Dog bed.");
	});

	it("counts a Plaid-excluded credit marked income in the same save, and keeps its category, since income is not asked about", async () => {
		const category = await firstCategory();
		await excludedCredit(category);
		const jev = fakeJev(() => reply(0.2));
		const { response } = await save(bakery, {
			...renamed("0"),
			income: "1",
			income_was: "0",
		});
		await background();
		expect(jev.bodies).toHaveLength(0);
		expect(await rowOf(bakery)).toMatchObject({
			category_id: category,
			category_source: "jev",
		});
		expect(
			JSON.parse(response.headers.get("HX-Trigger") ?? "{}").announce,
		).toBe("Saved Dog bed. It counts in the budget again.");
	});

	it("draws the note on a 422 redraw that posts the review, and folds it when the review is unticked", async () => {
		await excludedCredit(await firstCategory());
		fakeJev();
		const { response, html } = await save(bakery, {
			...renamed("1"),
			merchant: "",
		});
		expect(response.status).toBe(422);
		expect(html).toContain("Tally guesses its category again.");
		const note = html.match(
			/<span class="([^"]*)">Tally guesses its category again\.<\/span>/,
		)?.[1];
		expect(note).toContain(
			"group-has-[input[name=creditReviewed][checked]:not(:checked)]/edit:hidden",
		);
	});

	it("draws no note on the credit as it stands, since the exclusion still holds until the review", async () => {
		await excludedCredit(await firstCategory());
		expect(await panelHtml()).not.toContain(
			"Tally guesses its category again.",
		);
	});
});
