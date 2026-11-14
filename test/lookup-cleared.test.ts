import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import { pendingForJev, seenOf } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { inputMark } from "../src/lookup/input-mark";
import { type SortEnv, sortGroups } from "../src/sort-groups";
import { fakeSteps } from "./fake-sort-steps";

const db = env.DB;
const TODAY = "2026-09-22";

/** The app's env with the lookup open: a production household (DEMO "false") and a Tavily key. */
const lookupEnv: SortEnv = {
	DB: db,
	JEV_API_KEY: "test-key",
	DEMO: "false",
	TAVILY_API_KEY: "tvly-test-key",
};

/** A Jev reply: Eating Out, the flags low, a kind and a person filled, and the payee answer given. */
function jevReply({
	payee = { choice: "business", confidence: 0.95 },
	forPerson = "none",
	withPayee = true,
}: {
	payee?: { choice: string; confidence: number };
	forPerson?: string;
	withPayee?: boolean;
} = {}) {
	const base = {
		category: { type: "choice", choice: "Eating Out", confidence: 0.9 },
		transfer: { type: "noul", noul: 0.01 },
		reimbursement: { type: "noul", noul: 0.01 },
		income: { type: "noul", noul: 0.01 },
		kind: { type: "choice", choice: "one_off", confidence: 0.9 },
		for_person: { type: "choice", choice: forPerson, confidence: 0.9 },
		note_worth_writing: { type: "noul", noul: 0.01 },
	};

	const answers = withPayee
		? { ...base, payee: { type: "choice", ...payee } }
		: base;

	return new Response(JSON.stringify({ answers }), { status: 200 });
}

let runCount = 0;

/** Sorts the given rows once, with a fresh step runner, and returns the fetch the calls went through. */
async function sortRows(
	ids: number[],
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	sortEnv: SortEnv = lookupEnv,
) {
	runCount += 1;
	const fake = fakeSteps();

	await sortGroups(sortEnv, fake.runStep, fetchImpl, {
		rulesApplied: true,
		onlyIds: ids,
		runId: `run-lookup-${runCount}`,
	});
}

/** Inserts one purchase (positive is money out, Plaid's sign) and returns its id. */
async function addRow(rawName: string, amountCents = 1200): Promise<number> {
	const row = await db
		.prepare(
			"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES(1,?,?,?) RETURNING id",
		)
		.bind(TODAY, amountCents, rawName)
		.first<{ id: number }>();

	return Number(row?.id);
}

const markOf = (id: number) =>
	db
		.prepare(
			"SELECT input_mark AS inputMark, cleared FROM lookup_cleared WHERE transaction_id = ?",
		)
		.bind(id)
		.first<{ inputMark: string; cleared: number }>();

const rowOf = (id: number) =>
	db
		.prepare(
			"SELECT category_id AS categoryId, category_source AS categorySource, kind, for_person_id AS forPersonId, details_asked AS detailsAsked, note FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<{
			categoryId: number | null;
			categorySource: string | null;
			kind: string | null;
			forPersonId: number | null;
			detailsAsked: number;
			note: string | null;
		}>();

/** The body of the first Jev call a fetch recorded. */
const bodyOf = (fetchImpl: { mock: { calls: unknown[][] } }) => {
	// SAFETY: a vi.fn fetch is called with (url, init), so the second argument, when present, is the RequestInit the code sent.
	const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;

	return JSON.parse(String(init?.body ?? "{}"));
};

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the mark a sure business answer writes", () => {
	it("writes cleared 1 whose fingerprint is the row's, read back after the save, with a kind and a person filled", async () => {
		const id = await addRow("LOCAL BAKERY 9");

		const person = await db
			.prepare("SELECT id FROM household_people ORDER BY id LIMIT 1")
			.first<{ id: number }>();

		expect(person).toBeTruthy();

		const fetchImpl = vi.fn(async () =>
			jevReply({ forPerson: `person:${person?.id}` }),
		);

		await sortRows([id], fetchImpl);

		// The save filled the details this test predicts, so the fingerprint is checked on a changed row.
		expect(await rowOf(id)).toMatchObject({
			categoryId: expect.any(Number),
			kind: "one_off",
			forPersonId: person?.id,
		});

		const seenAfter = (await seenOf(db, [id])).get(id);

		if (!seenAfter) throw new Error("the row is gone after the save");
		const mark = await markOf(id);
		expect(mark?.cleared).toBe(1);
		expect(mark?.inputMark).toBe(await inputMark(seenAfter));
	});

	it("asks the payee question in the same call, with the category and the details", async () => {
		const id = await addRow("LOCAL BAKERY 10");
		const fetchImpl = vi.fn(async () => jevReply());
		await sortRows([id], fetchImpl);

		const body = bodyOf(fetchImpl);
		expect(body.questions.payee).toBeDefined();
		expect(body.questions.category).toBeDefined();
	});
});

describe("the mark is never written for what a person decided or for a question not asked", () => {
	it("a credit a person filed a category for, before Jev answered, is never cleared (privacy)", async () => {
		const id = await addRow("PAYCHECK DEPOSIT", -400000);

		const category = await db
			.prepare("SELECT id FROM categories ORDER BY id LIMIT 1")
			.first<{ id: number }>();

		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(category?.id ?? null, id)
			.run();

		await sortRows(
			[id],
			vi.fn(async () => jevReply()),
		);

		expect((await markOf(id))?.cleared ?? 0).not.toBe(1);
		// Jev's category answer is not stored for a row a person filed.
		expect(await rowOf(id)).toMatchObject({
			categoryId: category?.id,
			categorySource: "user",
		});
	});

	it("a purchase a person filed while Jev was asked gets no mark", async () => {
		const id = await addRow("LOCAL BAKERY 11");

		const category = await db
			.prepare("SELECT id FROM categories ORDER BY id LIMIT 1")
			.first<{ id: number }>();

		const fetchImpl = vi.fn(async () => {
			await db
				.prepare(
					"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
				)
				.bind(category?.id ?? null, id)
				.run();

			return jevReply();
		});

		await sortRows([id], fetchImpl);

		expect(await markOf(id)).toBeNull();
	});

	it("a row whose note changed between the ask and the write gets no mark (factsChangeInFlight)", async () => {
		const id = await addRow("LOCAL BAKERY 12");

		const fetchImpl = vi.fn(async () => {
			await db
				.prepare(
					"UPDATE transactions SET note = 'changed while asked' WHERE id = ?",
				)
				.bind(id)
				.run();

			return jevReply();
		});

		await sortRows([id], fetchImpl);

		expect(await markOf(id)).toBeNull();
	});

	it("a switch turned off between the ask and the save writes no mark, and the answer is still kept", async () => {
		const id = await addRow("LOCAL BAKERY 13");

		const fetchImpl = vi.fn(async () => {
			await saveAiSwitches(db, { lookupStores: false });

			return jevReply();
		});

		await sortRows([id], fetchImpl);

		expect(await markOf(id)).toBeNull();
		expect((await rowOf(id))?.categoryId).not.toBeNull();
	});

	it("with Guess categories off, the payee question is not asked and no mark is written", async () => {
		const id = await addRow("LOCAL BAKERY 14");
		await saveAiSwitches(db, { categories: false });
		const fetchImpl = vi.fn(async () => jevReply());
		await sortRows([id], fetchImpl);

		expect(bodyOf(fetchImpl).questions.payee).toBeUndefined();
		expect(await markOf(id)).toBeNull();
	});

	it("with Spot paychecks off, the payee question is not asked and no mark is written", async () => {
		const id = await addRow("LOCAL BAKERY 15");
		await saveAiSwitches(db, { income: false });
		const fetchImpl = vi.fn(async () => jevReply());
		await sortRows([id], fetchImpl);

		expect(bodyOf(fetchImpl).questions.payee).toBeUndefined();
		expect(await markOf(id)).toBeNull();
	});

	it("a row a person marked category-only (its credit reviewed by a person) is not asked the payee question", async () => {
		const id = await addRow("CREDIT REVIEWED", -4000);
		await db
			.prepare(
				"UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = ?",
			)
			.bind(id)
			.run();
		const fetchImpl = vi.fn(async () => jevReply());
		await sortRows([id], fetchImpl);

		expect(bodyOf(fetchImpl).questions.payee).toBeUndefined();
		expect(await markOf(id)).toBeNull();
	});

	it("a credit whose category was answered earlier is written for its income only, so its mark is cleared 0", async () => {
		const id = await addRow("EMPLOYER DEPOSIT", -400000);

		const category = await db
			.prepare("SELECT id FROM categories ORDER BY id LIMIT 1")
			.first<{ id: number }>();

		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'jev', category_confidence = 0.9 WHERE id = ?",
			)
			.bind(category?.id ?? null, id)
			.run();

		await sortRows(
			[id],
			vi.fn(async () => jevReply()),
		);

		expect((await markOf(id))?.cleared).toBe(0);
	});

	it("a payee answer that is missing is kept as a row that does not clear (one row per row Jev was asked)", async () => {
		const id = await addRow("LOCAL BAKERY 16");
		await sortRows(
			[id],
			vi.fn(async () => jevReply({ withPayee: false })),
		);

		expect(await markOf(id)).toEqual({
			inputMark: expect.any(String),
			cleared: 0,
		});
	});

	it("a payee Jev calls a person is never cleared", async () => {
		const id = await addRow("LOCAL BAKERY 17");
		await sortRows(
			[id],
			vi.fn(async () =>
				jevReply({ payee: { choice: "person", confidence: 0.99 } }),
			),
		);

		expect((await markOf(id))?.cleared).toBe(0);
	});
});

describe("the gate keeps the lookup's payee question closed unless every condition holds", () => {
	it("with no Tavily key the request is unchanged and no mark is written", async () => {
		const id = await addRow("LOCAL BAKERY 18");
		const fetchImpl = vi.fn(async () => jevReply());
		await sortRows([id], fetchImpl, {
			DB: db,
			JEV_API_KEY: "test-key",
			DEMO: "false",
		});

		expect(bodyOf(fetchImpl).questions.payee).toBeUndefined();
		expect(await markOf(id)).toBeNull();
	});

	it("in the demo (cap 0) the request is unchanged and no mark is written, even with a key", async () => {
		const id = await addRow("LOCAL BAKERY 19");
		const fetchImpl = vi.fn(async () => jevReply());
		await sortRows([id], fetchImpl, {
			DB: db,
			JEV_API_KEY: "test-key",
			TAVILY_API_KEY: "tvly-test-key",
		});

		expect(bodyOf(fetchImpl).questions.payee).toBeUndefined();
		expect(await markOf(id)).toBeNull();
	});

	it("with the lookup switch off the request is unchanged and no mark is written", async () => {
		const id = await addRow("LOCAL BAKERY 20");
		await saveAiSwitches(db, { lookupStores: false });
		const fetchImpl = vi.fn(async () => jevReply());
		await sortRows([id], fetchImpl);

		expect(bodyOf(fetchImpl).questions.payee).toBeUndefined();
		expect(await markOf(id)).toBeNull();
	});
});

describe("the mark's row", () => {
	it("is deleted with its transaction", async () => {
		const id = await addRow("LOCAL BAKERY 21");
		await sortRows(
			[id],
			vi.fn(async () => jevReply()),
		);
		expect((await markOf(id))?.cleared).toBe(1);

		await db.prepare("DELETE FROM transactions WHERE id = ?").bind(id).run();

		expect(await markOf(id)).toBeNull();
	});

	it("seenOf reads each row the way pendingForJev tells Jev about it", async () => {
		const id = await addRow("LOCAL BAKERY 22");
		const pending = (await pendingForJev(db, 500)).find((row) => row.id === id);

		expect(pending).toBeDefined();
		expect((await seenOf(db, [id])).get(id)).toEqual(pending?.seen);
	});
});
