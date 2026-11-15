import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { householdTimeZone, todayIn } from "../src/dates";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";
import type {
	Eligibility,
	ReadEligibilityRow,
} from "../src/lookup/eligibility";
import { reaskPicks } from "../src/lookup/privacy-reask";
import { runSortInstance } from "../src/sort-instance";
import type { SortParams } from "../src/sort-start";
import { fakeSteps } from "./fake-sort-steps";

// The privacy re-ask (#1113), through the sorting instance with fake steps and the gate open.

const db = env.DB;
const TODAY = "2026-09-22";
const STORE = "Harbor Bakery 42";
const TEXT = "harbor bakery";

const gateOpen = {
	DB: db,
	JEV_API_KEY: "jev",
	DEMO: "false",
	TAVILY_API_KEY: "tvly",
};

// No ids: the sorting groups ask nothing (the demo's own waiting rows are left alone), and only the re-ask runs.
const params: SortParams = { bySync: false, rulesApplied: false, ids: [] };

let food = 0;
let plaidSeq = 0;

/** A row Jev answered (its category answer is stored) and nothing marks it yet, so its privacy mark is owed. */
async function answeredRow(
	values: Record<string, string | number | null> = {},
) {
	plaidSeq += 1;

	const row = {
		account_id: 1,
		date: TODAY,
		amount_cents: -1200,
		raw_name: STORE,
		plaid_transaction_id: `reask-${plaidSeq}`,
		plaid_category: "FOOD_AND_DRINK",
		category_id: food,
		category_source: "jev",
		jev_category_id: food,
		category_confidence: 0.9,
		// Details asked already, so the groups have nothing to ask about the row and only the re-ask can.
		details_asked: 1,
		...values,
	};

	const columns = Object.keys(row);

	const inserted = await db
		.prepare(
			`INSERT INTO transactions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING id`,
		)
		.bind(...Object.values(row))
		.first<{ id: number }>();

	return Number(inserted?.id);
}

/** A Jev reply to the four privacy questions: a business at 0.95, every flag low. */
const payeeReply = (payee = "business", confidence = 0.95) =>
	new Response(
		JSON.stringify({
			answers: {
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
				payee: { type: "choice", choice: payee, confidence },
			},
		}),
		{ status: 200 },
	);

/** The body of the first call a fetch recorded (the sorting groups make none here: only the re-ask's). */
const bodyOf = (fetchImpl: { mock: { calls: unknown[][] } }) => {
	// SAFETY: a vi.fn fetch is called with (url, init), so the second argument is the RequestInit the code sent.
	const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;

	return JSON.parse(String(init?.body ?? "{}"));
};

const markOf = (id: number) =>
	db
		.prepare(
			"SELECT input_mark AS inputMark, cleared FROM lookup_cleared WHERE transaction_id = ?",
		)
		.bind(id)
		.first<{ inputMark: string; cleared: number }>();

/** Runs one sorting instance with fake steps, the gate open, and the given Jev fetch. */
async function runInstance(
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	options: {
		instanceEnv?: Parameters<typeof runSortInstance>[0];
		fails?: string[];
		beforeAttempt?: (name: string, attempt: number) => Promise<void>;
		runParams?: SortParams;
	} = {},
) {
	const steps = fakeSteps({
		fails: options.fails,
		beforeAttempt: options.beforeAttempt,
	});

	await runSortInstance(
		options.instanceEnv ?? gateOpen,
		steps.runStep,
		options.runParams ?? params,
		{
			runId: crypto.randomUUID(),
			fetchImpl,
		},
	);

	return steps;
}

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await db
		.prepare(
			"DELETE FROM household_settings WHERE key = 'sorting_turn' OR key GLOB 'jev_calls_*' OR key GLOB 'jev_reserved_*'",
		)
		.run();
	await db.prepare("DELETE FROM merchant_lookup_texts").run();
	await saveAiSwitches(db, AI_SWITCHES_ALL_ON);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});

	const categories = await db
		.prepare("SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1")
		.all<{ id: number }>();

	food = Number(categories.results[0]?.id);
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A decided read row for the pure selection tests. */
function readRow(
	over: Partial<ReadEligibilityRow> & { id: number },
): ReadEligibilityRow {
	return {
		lookupText: TEXT,
		private: false,
		sign: true,
		jev: "answered",
		mark: "owed",
		ruleSettled: false,
		seen: { ...seenStub, forPersonName: null },
		...over,
	};
}

const seenStub = {
	rawName: STORE,
	ownName: null,
	merchantKey: "harbor bakery",
	merchantName: null,
	suggestedNames: null,
	suggestionStatus: null,
	amountCents: -1200,
	accountId: 1,
	accountType: "credit",
	plaidCategory: "FOOD_AND_DRINK",
	note: null,
	kind: null,
	forPersonId: null,
	forPersonName: null,
};

const notYet = (why: "rows" | "no_cleared"): Eligibility => ({
	kind: "not_yet",
	why,
	owed: [],
});

describe("reaskPicks: which rows are asked (pure)", () => {
	it("picks each answered row whose mark is owed, in id order", () => {
		const rows = [readRow({ id: 2 }), readRow({ id: 1 })];

		expect(
			reaskPicks(rows, new Map([[TEXT, notYet("rows")]]), 10).map((p) => p.id),
		).toEqual([1, 2]);
	});

	it("passes over a text with an asked row, a row that gave up, or an owed row with no account", () => {
		const decided = new Map<string, Eligibility>([[TEXT, notYet("rows")]]);

		expect(
			reaskPicks(
				[readRow({ id: 1 }), readRow({ id: 2, mark: "asked" })],
				decided,
				10,
			),
		).toEqual([]);
		expect(
			reaskPicks(
				[readRow({ id: 1 }), readRow({ id: 2, jev: "gave_up", mark: "owed" })],
				decided,
				10,
			),
		).toEqual([]);
		expect(
			reaskPicks(
				[readRow({ id: 1 }), readRow({ id: 2, seen: null })],
				decided,
				10,
			),
		).toEqual([]);
	});

	it("passes over a text that is private, has no sign, or is settled by a rule", () => {
		const verdicts: Eligibility[] = [
			{ kind: "private" },
			{ kind: "not_yet", why: "no_sign", owed: [] },
			{ kind: "not_yet", why: "rule", owed: [] },
		];

		for (const verdict of verdicts) {
			expect(
				reaskPicks([readRow({ id: 1 })], new Map([[TEXT, verdict]]), 10),
			).toEqual([]);
		}
	});

	it("orders texts by their fewest owed rows, then by text, and takes the first ten", () => {
		const rows = [
			readRow({ id: 1, lookupText: "b text" }),
			readRow({ id: 2, lookupText: "a text" }),
			readRow({ id: 3, lookupText: "a text" }),
			...Array.from({ length: 10 }, (_, i) =>
				readRow({ id: 10 + i, lookupText: "c text" }),
			),
		];

		const decided = new Map<string, Eligibility>([
			["a text", notYet("rows")],
			["b text", notYet("rows")],
			["c text", notYet("rows")],
		]);

		const picked = reaskPicks(rows, decided, 10);

		expect(picked.map((p) => p.id)).toEqual([
			1, 2, 3, 10, 11, 12, 13, 14, 15, 16,
		]);
	});
});

describe("the privacy re-ask, through the sorting instance (#1113)", () => {
	it("asks an owed answered row once, with the privacy questions, and writes its cleared mark only", async () => {
		const id = await answeredRow();

		const before = await db
			.prepare(
				"SELECT category_id AS categoryId, category_confidence AS confidence, jev_attempts AS attempts FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first();

		const fetchImpl = vi.fn(async () => payeeReply());

		await runInstance(fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const body = bodyOf(fetchImpl);
		expect(Object.keys(body.questions).sort()).toEqual([
			"income",
			"payee",
			"reimbursement",
			"transfer",
		]);
		expect(body.state.learned_category).toBeUndefined();
		expect(await markOf(id)).toEqual({
			inputMark: expect.any(String),
			cleared: 1,
		});
		expect(
			await db
				.prepare(
					"SELECT category_id AS categoryId, category_confidence AS confidence, jev_attempts AS attempts FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual(before);
	});

	it("does not ask again once the mark is current: a second run makes no call", async () => {
		await answeredRow();
		await runInstance(vi.fn(async () => payeeReply()));
		const again = vi.fn(async () => payeeReply());

		await runInstance(again);

		expect(again).not.toHaveBeenCalled();
	});

	it("a note edit makes the row owed again, so it is asked once more", async () => {
		const id = await answeredRow();
		await runInstance(vi.fn(async () => payeeReply()));
		await db
			.prepare("UPDATE transactions SET note = 'birthday' WHERE id = ?")
			.bind(id)
			.run();
		const again = vi.fn(async () => payeeReply());

		await runInstance(again);

		expect(again).toHaveBeenCalledTimes(1);
	});

	it("an HTTP 500 writes 0 and ends the run, so a second owed row is not asked in this run", async () => {
		const first = await answeredRow();
		const second = await answeredRow({ raw_name: "Other Store 9" });
		const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));

		await runInstance(fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect((await markOf(first))?.cleared).toBe(0);
		expect(await markOf(second)).toBeNull();
	});

	it("at the daily cap, nothing is asked and no mark is written", async () => {
		const id = await answeredRow();
		const day = todayIn(await householdTimeZone(db));
		await db
			// Far past any cap (the first week's allowance is larger than 500), so no call is granted.
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES (?, '100000') ON CONFLICT(key) DO UPDATE SET value = '100000'",
			)
			.bind(`jev_calls_${day}`)
			.run();
		const fetchImpl = vi.fn(async () => payeeReply());

		await runInstance(fetchImpl);

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await markOf(id)).toBeNull();
	});

	it("with another run holding the turn, nothing is asked or reserved", async () => {
		const id = await answeredRow();
		await db
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('sorting_turn', ?)",
			)
			.bind(JSON.stringify({ id: "someone-else", until: Date.now() + 60_000 }))
			.run();
		const fetchImpl = vi.fn(async () => payeeReply());

		await runInstance(fetchImpl);

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await markOf(id)).toBeNull();
	});

	it("a read step that fails on every try asks nothing, and the run still ends without throwing", async () => {
		const id = await answeredRow();
		const fetchImpl = vi.fn(async () => payeeReply());

		await expect(
			runInstance(fetchImpl, { fails: ["lookup-reask-read"] }),
		).resolves.toBeDefined();

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await markOf(id)).toBeNull();
	});

	it("with the gate closed (no Tavily key), no re-ask step is registered", async () => {
		await answeredRow();
		const fetchImpl = vi.fn(async () => payeeReply());

		const steps = await runInstance(fetchImpl, {
			instanceEnv: { ...gateOpen, TAVILY_API_KEY: undefined },
		});

		expect(steps.names().some((name) => name.startsWith("lookup-reask"))).toBe(
			false,
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("logs nothing that carries the bank text", async () => {
		await answeredRow();
		const fetchImpl = vi.fn(async () => payeeReply());

		const logs = vi.spyOn(console, "log");
		const errors = vi.spyOn(console, "error");

		await runInstance(fetchImpl);

		const logged = [...logs.mock.calls, ...errors.mock.calls]
			.flat()
			.map(String)
			.join(" ");

		expect(logged).not.toContain(STORE);
		expect(logged).not.toContain("harbor");
	});
});
