import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { householdTimeZone, todayIn } from "../src/dates";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { saveAskedNames } from "../src/db/merchant-names";
import type { JevSeen } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import type {
	Eligibility,
	ReadEligibilityRow,
} from "../src/lookup/eligibility";
import { reaskPicks } from "../src/lookup/privacy-reask";
import { mergePendingIntoPosted } from "../src/plaid/pending-merge";
import { transactions } from "../src/routes/transactions";
import { dailyJevCap } from "../src/sort-groups";
import { runSortInstance } from "../src/sort-instance";
import type { SortParams } from "../src/sort-start";
import { fakeSteps } from "./fake-sort-steps";

// The privacy re-ask's remaining cases (#1113): each clears reason, the switches and failures during a fetch, replay,
// the cap, the run placement and the selection cases. Same setup as test/lookup-reask.test.ts.

const db = env.DB;
const TODAY = "2026-09-22";

const gateOpen = {
	DB: db,
	JEV_API_KEY: "jev",
	DEMO: "false",
	TAVILY_API_KEY: "tvly",
};

// No ids: the sorting groups ask nothing, so only the re-ask runs (the demo's waiting rows are left alone).
const params: SortParams = { bySync: false, rulesApplied: false, ids: [] };

let food = 0;
let plaidSeq = 0;

/** A row Jev answered (its answer stored, details asked), so its privacy mark is owed. */
async function answeredRow(
	values: Record<string, string | number | null> = {},
) {
	plaidSeq += 1;

	const row = {
		account_id: 1,
		date: TODAY,
		amount_cents: -1200,
		raw_name: "Harbor Bakery 42",
		plaid_transaction_id: `cases-${plaidSeq}`,
		plaid_category: "FOOD_AND_DRINK",
		category_id: food,
		category_source: "jev",
		jev_category_id: food,
		category_confidence: 0.9,
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

/** A row with no answer yet: the sorting groups' waiting kind. */
async function waitingRow(rawName: string) {
	plaidSeq += 1;

	const inserted = await db
		.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, plaid_category) VALUES (1, ?, -900, ?, ?, 'FOOD_AND_DRINK') RETURNING id",
		)
		.bind(TODAY, rawName, `cases-w-${plaidSeq}`)
		.first<{ id: number }>();

	return Number(inserted?.id);
}

/** The execution context a route call takes, as test/ask-again.test.ts builds it. */
const ctx = () => ({
	waitUntil: vi.fn(),
	passThroughOnException() {},
	props: {},
});

type Flags = {
	transfer?: number;
	reimbursement?: number;
	income?: number;
	/** null leaves the payee question out of the reply. */
	payee?: { choice: string; confidence: number } | null;
};

/** A Jev reply to the privacy questions: a business at 0.95 and every flag at 0.01, unless given. */
function reply(flags: Flags = {}) {
	const payee =
		flags.payee === null
			? {}
			: {
					payee: {
						type: "choice",
						...(flags.payee ?? { choice: "business", confidence: 0.95 }),
					},
				};

	const answers = {
		transfer: { type: "noul", noul: flags.transfer ?? 0.01 },
		reimbursement: { type: "noul", noul: flags.reimbursement ?? 0.01 },
		income: { type: "noul", noul: flags.income ?? 0.01 },
		...payee,
	};

	return new Response(JSON.stringify({ answers }), { status: 200 });
}

const okFetch = () =>
	vi.fn(async (_url: string, _init?: RequestInit) => reply());

/** The body of call n (default the first) a fetch recorded. */
function bodyOf(fetchImpl: { mock: { calls: unknown[][] } }, n = 0) {
	// SAFETY: a vi.fn fetch is called with (url, init), so the second argument is the RequestInit the code sent.
	const init = fetchImpl.mock.calls[n]?.[1] as RequestInit | undefined;

	return JSON.parse(String(init?.body ?? "{}"));
}

const markOf = (id: number) =>
	db
		.prepare(
			"SELECT input_mark AS inputMark, cleared FROM lookup_cleared WHERE transaction_id = ?",
		)
		.bind(id)
		.first<{ inputMark: string; cleared: number }>();

async function callCount(): Promise<number> {
	const day = todayIn(await householdTimeZone(db));

	const row = await db
		.prepare("SELECT value FROM household_settings WHERE key = ?")
		.bind(`jev_calls_${day}`)
		.first<{ value: string }>();

	return Number(row?.value ?? 0);
}

async function runInstance(
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	options: {
		runParams?: SortParams;
		instanceEnv?: Parameters<typeof runSortInstance>[0];
		fails?: string[];
		replayAfter?: string[];
		beforeAttempt?: (name: string, attempt: number) => Promise<void>;
		sleep?: (name: string, ms: number) => Promise<void>;
		limits?: Record<string, number>;
	} = {},
) {
	const steps = fakeSteps({
		fails: options.fails,
		replayAfter: options.replayAfter,
		beforeAttempt: options.beforeAttempt,
		limits: options.limits,
	});

	await runSortInstance(
		options.instanceEnv ?? gateOpen,
		steps.runStep,
		options.runParams ?? params,
		{
			runId: crypto.randomUUID(),
			fetchImpl,
			sleep: options.sleep,
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

/** Every column of a transaction row, as it reads now. */
const rowOf = (id: number) =>
	db.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first();

const logCountOf = (id: number) =>
	db
		.prepare("SELECT COUNT(*) AS n FROM ai_log WHERE transaction_id = ?")
		.bind(id)
		.first<{ n: number }>()
		.then((row) => Number(row?.n));

describe("the request and the turn (#1113)", () => {
	it("the re-ask's request state is the literal facts of one row, with no learned line", async () => {
		await answeredRow();
		const fetchImpl = okFetch();
		await runInstance(fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const body = bodyOf(fetchImpl);
		expect(body.state).toEqual({
			bank_description: "Harbor Bakery 42",
			merchant: null,
			amount_cents: 1200,
			direction: "money in",
			account_type: "depository",
			plaid_category: "FOOD_AND_DRINK",
		});
	});

	it("a write whose turn another turn took writes no mark, and keeps its reserved calls in the record as writeGroup does", async () => {
		const id = await answeredRow();
		const day = todayIn(await householdTimeZone(db));
		const before = await callCount();
		const fetchImpl = okFetch();
		await runInstance(fetchImpl, {
			limits: { "lookup-reask-write": 1 },
			beforeAttempt: async (name) => {
				if (name !== "lookup-reask-write") return;
				await db
					.prepare(
						"UPDATE household_settings SET value = ? WHERE key = 'sorting_turn'",
					)
					.bind(
						JSON.stringify({ id: "other-turn", until: Date.now() + 60_000 }),
					)
					.run();
			},
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(await markOf(id)).toBeNull();
		// The call was made and stays counted: the record still holds the grant until the cleanup clears it.
		expect((await callCount()) - before).toBe(1);

		const record = await db
			.prepare("SELECT key FROM household_settings WHERE key GLOB ?")
			.bind(`jev_reserved_${day}_*`)
			.first();

		expect(record).not.toBeNull();
	});
});

describe("the row is unchanged by the re-ask's outcome (#1113)", () => {
	const unchanged = async (
		fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	) => {
		const id = await answeredRow();
		const before = await rowOf(id);
		const logsBefore = await logCountOf(id);
		await runInstance(fetchImpl);
		const after = await rowOf(id);
		expect(after).toEqual(before);
		expect(await logCountOf(id)).toBe(logsBefore);

		return id;
	};

	it("after an HTTP 500, the row keeps every column and its ai_log count", async () => {
		await unchanged(vi.fn(async () => new Response("{}", { status: 500 })));
	});

	it("after a lost ask (an ask step that fails), the row keeps every column and its ai_log count", async () => {
		const id = await answeredRow();
		const before = await rowOf(id);
		const logsBefore = await logCountOf(id);
		await runInstance(okFetch(), { fails: [`lookup-reask-row-${id}`] });
		expect(await rowOf(id)).toEqual(before);
		expect(await logCountOf(id)).toBe(logsBefore);
	});

	it("after an answered call, the row keeps every column and its ai_log count", async () => {
		await unchanged(okFetch());
	});
});

describe("the instance's other paths (#1113)", () => {
	it("an instance started by a sync, with sort as they arrive off, asks nothing", async () => {
		const id = await answeredRow();
		await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, sortOnArrival: false });
		const fetchImpl = okFetch();
		await runInstance(fetchImpl, { runParams: { ...params, bySync: true } });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await markOf(id)).toBeNull();
	});

	it("in the demo, with a Tavily key set, no lookup-reask step is registered", async () => {
		await answeredRow();

		const steps = await runInstance(okFetch(), {
			instanceEnv: { ...gateOpen, DEMO: "true" },
		});

		expect(steps.names().some((name) => name.startsWith("lookup-reask"))).toBe(
			false,
		);
	});
});

describe("cleared, each reason through the re-ask (#1113)", () => {
	it("a business at 0.95 with every flag at 0.01 clears the row (1)", async () => {
		const id = await answeredRow();
		await runInstance(okFetch());
		expect((await markOf(id))?.cleared).toBe(1);
	});

	it("a person as payee does not clear the row (0)", async () => {
		const id = await answeredRow();
		await runInstance(
			vi.fn(async () =>
				reply({ payee: { choice: "person", confidence: 0.95 } }),
			),
		);
		expect((await markOf(id))?.cleared).toBe(0);
	});

	it("a business at 0.79 does not clear the row (0)", async () => {
		const id = await answeredRow();
		await runInstance(
			vi.fn(async () =>
				reply({ payee: { choice: "business", confidence: 0.79 } }),
			),
		);
		expect((await markOf(id))?.cleared).toBe(0);
	});

	it("no payee answer does not clear the row (0)", async () => {
		const id = await answeredRow();
		await runInstance(vi.fn(async () => reply({ payee: null })));
		expect((await markOf(id))?.cleared).toBe(0);
	});

	it("a transfer at 0.85 does not clear the row (0)", async () => {
		const id = await answeredRow();
		await runInstance(vi.fn(async () => reply({ transfer: 0.85 })));
		expect((await markOf(id))?.cleared).toBe(0);
	});

	it("a transfer at 0.5, in its Maybe range, does not clear the row (0)", async () => {
		const id = await answeredRow();
		await runInstance(vi.fn(async () => reply({ transfer: 0.5 })));
		expect((await markOf(id))?.cleared).toBe(0);
	});

	it("a reimbursement at 0.85 does not clear the row (0)", async () => {
		const id = await answeredRow();
		await runInstance(vi.fn(async () => reply({ reimbursement: 0.85 })));
		expect((await markOf(id))?.cleared).toBe(0);
	});

	it("a reimbursement at 0.5, in its Maybe range, does not clear the row (0)", async () => {
		const id = await answeredRow();
		await runInstance(vi.fn(async () => reply({ reimbursement: 0.5 })));
		expect((await markOf(id))?.cleared).toBe(0);
	});

	it("an income at 0.85 does not clear the row (0)", async () => {
		const id = await answeredRow();
		await runInstance(vi.fn(async () => reply({ income: 0.85 })));
		expect((await markOf(id))?.cleared).toBe(0);
	});

	it("an income at 0.5, in its Maybe range, does not clear the row (0)", async () => {
		const id = await answeredRow();
		await runInstance(vi.fn(async () => reply({ income: 0.5 })));
		expect((await markOf(id))?.cleared).toBe(0);
	});

	it("a sure business on a row a person chose the category of clears the row (1)", async () => {
		const id = await answeredRow({ category_source: "user" });
		await runInstance(okFetch());
		expect((await markOf(id))?.cleared).toBe(1);
	});
});

describe("during the fetch (#1113)", () => {
	it("a note edited inside the fetch writes no mark for that row, and the batch still saves the other row", async () => {
		const edited = await answeredRow({ raw_name: "Harbor Bakery 42" });
		const other = await answeredRow({ raw_name: "Other Store 9" });

		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			if (String(init?.body).includes("Harbor Bakery")) {
				await db
					.prepare(
						"UPDATE transactions SET note = 'edited mid-ask' WHERE id = ?",
					)
					.bind(edited)
					.run();
			}

			return reply();
		});

		await runInstance(fetchImpl);
		expect(await markOf(edited)).toBeNull();
		expect((await markOf(other))?.cleared).toBe(1);
	});

	it("a row deleted inside the fetch writes no mark, and the batch still saves the other row", async () => {
		const deleted = await answeredRow({ raw_name: "Harbor Bakery 42" });
		const other = await answeredRow({ raw_name: "Other Store 9" });

		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			if (String(init?.body).includes("Harbor Bakery")) {
				await db
					.prepare("DELETE FROM transactions WHERE id = ?")
					.bind(deleted)
					.run();
			}

			return reply();
		});

		await runInstance(fetchImpl);
		expect(await markOf(deleted)).toBeNull();
		expect((await markOf(other))?.cleared).toBe(1);
	});

	it.each([
		["the lookup switch", "ai_lookup_stores"],
		["Guess categories", "ai_categories"],
		["Spot paychecks", "ai_income"],
	])("%s turned off inside the fetch writes no mark", async (_name, key) => {
		const id = await answeredRow();

		const fetchImpl = vi.fn(async () => {
			await db
				.prepare(
					"INSERT INTO household_settings (key, value) VALUES (?, 'off') ON CONFLICT(key) DO UPDATE SET value = 'off'",
				)
				.bind(key)
				.run();

			return reply();
		});

		await runInstance(fetchImpl);
		expect(await markOf(id)).toBeNull();
	});
});

describe("replay and failure (#1113)", () => {
	it("replayAfter on an ask step makes one fetch", async () => {
		const id = await answeredRow();
		const fetchImpl = okFetch();
		await runInstance(fetchImpl, { replayAfter: [`lookup-reask-row-${id}`] });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect((await markOf(id))?.cleared).toBe(1);
	});

	it("replayAfter on the write step leaves the marks and the day's count unchanged", async () => {
		const id = await answeredRow();
		const fetchImpl = okFetch();
		const before = await callCount();
		await runInstance(fetchImpl, { replayAfter: ["lookup-reask-write"] });
		expect((await markOf(id))?.cleared).toBe(1);
		expect((await callCount()) - before).toBe(1);
	});

	it("an ask step that fails writes a 0 mark, and its retry makes no call", async () => {
		const id = await answeredRow();
		const fetchImpl = okFetch();
		await runInstance(fetchImpl, { fails: [`lookup-reask-row-${id}`] });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect((await markOf(id))?.cleared).toBe(0);
	});

	it("an unreadable 200 writes 0 and ends the run, as an HTTP 500 does", async () => {
		const first = await answeredRow({ raw_name: "Harbor Bakery 42" });
		const second = await answeredRow({ raw_name: "Other Store 9" });

		const fetchImpl = vi.fn(
			async () => new Response("not json", { status: 200 }),
		);

		await runInstance(fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect((await markOf(first))?.cleared).toBe(0);
		expect(await markOf(second)).toBeNull();
	});
});

describe("the daily cap (#1113)", () => {
	it("with one call left and three owed rows, one call is made and the count reaches the cap", async () => {
		await answeredRow({ raw_name: "Store A" });
		await answeredRow({ raw_name: "Store B" });
		await answeredRow({ raw_name: "Store C" });
		const cap = await dailyJevCap(db, { DEMO: "false" });
		const day = todayIn(await householdTimeZone(db));
		await db
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.bind(`jev_calls_${day}`, String(cap - 1))
			.run();
		const fetchImpl = okFetch();
		await runInstance(fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(await callCount()).toBe(cap);
	});

	it("three answered calls raise the count by exactly three", async () => {
		await answeredRow({ raw_name: "Store A" });
		await answeredRow({ raw_name: "Store B" });
		await answeredRow({ raw_name: "Store C" });
		const before = await callCount();
		const fetchImpl = okFetch();
		await runInstance(fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect((await callCount()) - before).toBe(3);
	});

	it("time past askUntil, set before a row's attempt, makes no call and writes no mark", async () => {
		const id = await answeredRow();
		const fetchImpl = okFetch();
		const now = vi.spyOn(Date, "now");
		await runInstance(fetchImpl, {
			beforeAttempt: async (name) => {
				if (name.startsWith("lookup-reask-row-"))
					now.mockReturnValue(Date.now() + 10 * 60_000);
			},
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await markOf(id)).toBeNull();
	});
});

describe("the re-ask in the instance's run (#1113)", () => {
	it("registers no re-ask step when the groups stop on a busy Jev", async () => {
		await answeredRow();

		const ids = [
			await waitingRow("Waiting Store 1"),
			await waitingRow("Waiting Store 2"),
		];

		const steps = await runInstance(
			vi.fn(
				async () =>
					new Response("{}", { status: 429, headers: { "retry-after": "5" } }),
			),
			{ runParams: { ...params, ids }, sleep: async () => {} },
		);

		expect(steps.names().some((name) => name.startsWith("lookup-reask"))).toBe(
			false,
		);
	});

	it("one row failing in the groups still lets the re-ask run", async () => {
		const id = await answeredRow({ raw_name: "Harbor Bakery 42" });
		const failing = await waitingRow("Failing Store");

		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			if (String(init?.body).includes("Failing Store"))
				return new Response("{}", { status: 400 });

			return reply();
		});

		const steps = await runInstance(fetchImpl, {
			runParams: { ...params, ids: [failing] },
		});

		expect(steps.names()).toContain("lookup-reask-read");
		expect((await markOf(id))?.cleared).toBe(1);
	});

	it("registers no re-ask step when a group's reserve step fails, and the night's steps still run (#1113)", async () => {
		await answeredRow();
		const id = await waitingRow("Reserve Store");

		const steps = await runInstance(okFetch(), {
			runParams: { ...params, ids: [id], night: "2026-10-13" },
			fails: ["group-1-reserve"],
		});

		expect(steps.names().some((name) => name.startsWith("lookup-reask"))).toBe(
			false,
		);
		expect(steps.names()).toContain("night-names");
	});

	it("registers no re-ask step when a group's write step fails, and the night's steps still run (#1113)", async () => {
		await answeredRow();
		const id = await waitingRow("Write Store");

		const steps = await runInstance(okFetch(), {
			runParams: { ...params, ids: [id], night: "2026-10-13" },
			fails: ["group-1-write"],
			limits: { "group-1-write": 2 },
		});

		expect(steps.names().some((name) => name.startsWith("lookup-reask"))).toBe(
			false,
		);
		expect(steps.names()).toContain("night-names");
	});

	it("the re-ask still runs when only one row's ask step fails (#1113)", async () => {
		const id = await answeredRow();
		const failing = await waitingRow("Lost Store");

		const steps = await runInstance(okFetch(), {
			runParams: { ...params, ids: [failing] },
			fails: [`group-1-ask-${failing}`],
		});

		expect(steps.names()).toContain("lookup-reask-read");
		expect((await markOf(id))?.cleared).toBe(1);
	});

	it("a re-sort instance runs the re-ask after reask-finish", async () => {
		await answeredRow();

		const steps = await runInstance(okFetch(), {
			runParams: { ...params, reask: { runId: "re-sort-1", ids: [] } },
		});

		const names = steps.names();
		expect(names.indexOf("reask-finish")).toBeGreaterThan(-1);
		expect(names.indexOf("lookup-reask-read")).toBeGreaterThan(
			names.indexOf("reask-finish"),
		);
	});

	it("the re-ask runs before the night's steps", async () => {
		await answeredRow();

		const steps = await runInstance(okFetch(), {
			runParams: { ...params, night: "2026-10-13" },
		});

		const names = steps.names();
		expect(names.indexOf("lookup-reask-write")).toBeLessThan(
			names.indexOf("night-names"),
		);
	});

	it("its steps have the names and settings the brief gives", async () => {
		const id = await answeredRow();
		const steps = await runInstance(okFetch());

		const config = (name: string) =>
			steps.steps.find((step) => step.name === name)?.config;

		expect(config("lookup-reask-read")).toMatchObject({
			retries: { limit: 4, delay: "10 seconds", backoff: "constant" },
			timeout: "1 minute",
			sensitive: "output",
		});
		expect(config("lookup-reask-reserve")).toMatchObject({
			retries: { limit: 0 },
			timeout: "1 minute",
		});
		expect(config(`lookup-reask-row-${id}`)).toMatchObject({
			retries: { limit: 0 },
			timeout: "1 minute",
		});
		expect(config("lookup-reask-write")).toMatchObject({
			retries: { limit: 960, delay: "1 minute", backoff: "constant" },
			timeout: "30 seconds",
		});
	});
});

/** The facts Jev is told about a row, for the pure selection cases below. */
const SEEN: JevSeen = {
	rawName: "Harbor Bakery 42",
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

/** A decided read row for the pure selection cases: an answered row whose mark is owed, unless given. */
const pureRow = (
	over: Partial<ReadEligibilityRow> & { id: number },
): ReadEligibilityRow => ({
	lookupText: "t",
	private: false,
	sign: true,
	jev: "answered",
	mark: "owed",
	ruleSettled: false,
	seen: SEEN,
	...over,
});

describe("which rows are asked (#1113)", () => {
	it("an owed split parent is asked once", async () => {
		const parent = await answeredRow({
			raw_name: "Split Parent Shop",
			is_split: 1,
		});

		const fetchImpl = okFetch();
		await runInstance(fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect((await markOf(parent))?.cleared).toBe(1);
	});

	it("an owed refund that follows its purchase is asked once", async () => {
		const purchase = await answeredRow({
			raw_name: "Refund Shop Buy",
			amount_cents: 1200,
		});

		const refund = await answeredRow({
			raw_name: "Refund Shop Credit",
			amount_cents: -1200,
			refund_of_id: purchase,
			credit_reviewed: 1,
		});

		const fetchImpl = okFetch();
		await runInstance(fetchImpl);
		const bodies = fetchImpl.mock.calls.map((_, n) => bodyOf(fetchImpl, n));
		expect(
			bodies.filter(
				(body) => body.state.bank_description === "Refund Shop Credit",
			),
		).toHaveLength(1);
		expect((await markOf(refund))?.cleared).toBe(1);
	});

	it("an owed split part is asked once, with its parent's store", async () => {
		const parent = await answeredRow({
			raw_name: "Split Store",
			is_split: 1,
			amount_cents: 2000,
		});

		const part = await answeredRow({
			raw_name: "Split Store",
			parent_id: parent,
			plaid_transaction_id: null,
			plaid_category: null,
		});

		const fetchImpl = okFetch();
		await runInstance(fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect((await markOf(part))?.cleared).toBe(1);
	});

	it("with 12 owed rows, 10 are asked this run and the other 2 next run", async () => {
		for (let i = 1; i <= 12; i++)
			await answeredRow({ raw_name: `Store ${String(i).padStart(2, "0")}` });
		const first = okFetch();
		await runInstance(first);
		expect(first).toHaveBeenCalledTimes(10);
		const second = okFetch();
		await runInstance(second);
		expect(second).toHaveBeenCalledTimes(2);
	});

	it("a text with an answered row whose seen is null asks no row of that text (pure)", () => {
		const row = (
			over: Partial<ReadEligibilityRow> & { id: number },
		): ReadEligibilityRow => ({
			lookupText: "t",
			private: false,
			sign: true,
			jev: "answered",
			mark: "owed",
			ruleSettled: false,
			seen: null,
			...over,
		});

		const decided = new Map<string, Eligibility>([
			["t", { kind: "not_yet", why: "rows", owed: [] }],
		]);

		expect(
			reaskPicks([row({ id: 1 }), row({ id: 2, seen: null })], decided, 10),
		).toEqual([]);
	});

	it("a text with an owed row and a row still waiting for Jev asks no row of that text (pure)", () => {
		const decided = new Map<string, Eligibility>([
			["t", { kind: "not_yet", why: "rows", owed: [] }],
		]);

		expect(
			reaskPicks(
				[pureRow({ id: 1 }), pureRow({ id: 2, jev: "waiting", mark: "owed" })],
				decided,
				10,
			),
		).toEqual([]);
	});

	it("once the waiting row is answered and cleared, the text's owed row is asked (pure)", () => {
		const decided = new Map<string, Eligibility>([
			["t", { kind: "not_yet", why: "rows", owed: [] }],
		]);

		expect(
			reaskPicks(
				[pureRow({ id: 1 }), pureRow({ id: 2, mark: "cleared" })],
				decided,
				10,
			),
		).toEqual([{ id: 1, text: "t", seen: SEEN }]);
	});

	it("a row still waiting for Jev in another text does not block this text (pure)", () => {
		const decided = new Map<string, Eligibility>([
			["a", { kind: "not_yet", why: "rows", owed: [] }],
			["b", { kind: "not_yet", why: "rows", owed: [] }],
		]);

		expect(
			reaskPicks(
				[
					pureRow({ id: 1, lookupText: "a" }),
					pureRow({ id: 2, lookupText: "b", jev: "waiting" }),
				],
				decided,
				10,
			).map((pick) => pick.id),
		).toEqual([1]);
	});
});

describe("the pending merge and the names and refunds (#1113)", () => {
	it("a posted row given a pending row's Jev answer is asked once", async () => {
		const pendingId = await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, plaid_category, pending, category_id, category_source, jev_category_id, category_confidence, details_asked, updated_by) VALUES (1, ?, 1200, 'MERGE CAFE', 'pend-m1', 'FOOD_AND_DRINK', 1, ?, 'jev', ?, 0.9, 1, 'test') RETURNING id",
			)
			.bind(TODAY, food, food)
			.first<{ id: number }>();

		const postedId = await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, plaid_category, pending, updated_by) VALUES (1, ?, 1200, 'MERGE CAFE', 'post-m1', 'FOOD_AND_DRINK', 0, 'test') RETURNING id",
			)
			.bind(TODAY)
			.first<{ id: number }>();

		const item = await db
			.prepare("SELECT id FROM plaid_items ORDER BY id LIMIT 1")
			.first<{ id: number }>();

		await db
			.prepare("UPDATE plaid_items SET sync_lock_id = 'lock-m1' WHERE id = ?")
			.bind(item?.id)
			.run();
		await db.batch(
			mergePendingIntoPosted(db, Number(item?.id), "lock-m1", "pend-m1", {
				id: "post-m1",
				cents: 1200,
				date: TODAY,
				name: "MERGE CAFE",
				merchantName: null,
				plaidCategory: "FOOD_AND_DRINK",
			}),
		);
		const fetchImpl = okFetch();
		await runInstance(fetchImpl);
		expect(pendingId?.id).toBeDefined();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect((await markOf(Number(postedId?.id)))?.cleared).toBe(1);
	});

	it("a cleared row stays cleared after the name run saves Tally's suggestion for a store Plaid did not name", async () => {
		const id = await answeredRow({ raw_name: "Quiet Corner Shop" });
		await runInstance(okFetch());
		expect((await markOf(id))?.cleared).toBe(1);
		await saveAskedNames(
			db,
			[{ rawName: "Quiet Corner Shop", names: ["Tally Guess"] }],
			[],
		);
		const again = okFetch();
		await runInstance(again);
		expect(again).not.toHaveBeenCalled();
		expect((await markOf(id))?.cleared).toBe(1);
	});

	it("a cleared row stays cleared after a refund link made through its route", async () => {
		// The same store on both, since the edit panel only offers a purchase of the refund's own merchant.
		const purchase = await answeredRow({
			raw_name: "Route Shop",
			amount_cents: 1200,
		});

		const refund = await answeredRow({
			raw_name: "Route Shop",
			amount_cents: -1200,
		});

		await runInstance(okFetch());
		expect((await markOf(refund))?.cleared).toBe(1);

		const response = await transactions.request(
			`/transactions/${refund}`,
			{
				method: "POST",
				headers: {
					"HX-Request": "true",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					category: "",
					merchant: "Route Shop",
					note: "",
					refund_of: String(purchase),
					creditReviewed: "on",
				}).toString(),
			},
			{ ...env, JEV_API_KEY: "jev-key" },
			ctx(),
		);

		expect(response.status).toBe(200);

		const linked = await db
			.prepare("SELECT refund_of_id AS id FROM transactions WHERE id = ?")
			.bind(refund)
			.first<{ id: number }>();

		expect(linked?.id).toBe(purchase);
		const again = okFetch();
		await runInstance(again);
		expect(again).not.toHaveBeenCalled();
		expect((await markOf(refund))?.cleared).toBe(1);
	});
});
