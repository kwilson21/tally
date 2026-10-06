import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JEV_URL } from "../src/ai/categorize";
import { categorizePending } from "../src/categorize-pending";
import { DEFAULT_TIME_ZONE, householdToday, todayIn } from "../src/dates";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";
import { transactions } from "../src/routes/transactions";

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

describe("adding a clearer name to a transaction that still needs a category", () => {
	it("asks Jev again right away, with the new name", async () => {
		const jev = fakeJev();
		await save(bakery, {
			category: "",
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
