import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { countWaitingForJev, seenOf } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { inputMark } from "../src/lookup/input-mark";
import { lookupTextOf } from "../src/lookup/lookup-text";
import { runSortInstance } from "../src/sort-instance";
import type { SortParams } from "../src/sort-start";
import { fakeSteps } from "./fake-sort-steps";

// The second ask (#987 part B), through the sorting instance with fake steps. A fake Jev answers only the category-only
// call the second ask makes; any other Jev body is recorded as a violation, and every test asserts there are none.

export const db = env.DB;
export const DAY = "2026-11-15";

/** Noon on DAY in New York, the household's default zone (decision 67). */
export const NOON_MS = Date.parse("2026-11-15T17:00:00.000Z");
export const MINUTE = 60_000;
export const LINE = "Harbor Bakery is a bakery and cafe in Arlington, VA";
export const STORE_A = "Harbor Bakery 42";
export const STORE_B = "Juniper Tea 7";
export const RUN_ID = "run-second";

export const gateOpen = {
	DB: db,
	JEV_API_KEY: "jev",
	DEMO: "false",
	TAVILY_API_KEY: "tvly",
};

// No ids: the sorting groups ask nothing, so only the second ask runs.
export const params: SortParams = {
	bySync: false,
	rulesApplied: false,
	ids: [],
};

/** The id of an active category, by its name. */
export async function categoryId(name: string): Promise<number> {
	const row = await db
		.prepare("SELECT id FROM categories WHERE name = ? AND archived = 0")
		.bind(name)
		.first<{ id: number }>();

	return Number(row?.id);
}

/** The lookup text a store name is searched by (lookupTextOf keeps it lower case, digits out). */
export const textOf = (name: string) => lookupTextOf(name);

/** A store the lookup found, with its line, and the store's own key pointing at its text. */
export async function foundStore(name: string, line: string | null = LINE) {
	const text = textOf(name);

	await db
		.prepare(
			"INSERT INTO merchant_lookups (lookup_text, status, line) VALUES (?, 'found', ?) ON CONFLICT(lookup_text) DO UPDATE SET status = 'found', line = excluded.line",
		)
		.bind(text, line)
		.run();

	await db
		.prepare(
			"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES (?, ?, 0) ON CONFLICT(merchant_key) DO UPDATE SET lookup_text = excluded.lookup_text, private = 0",
		)
		.bind(name, text)
		.run();

	return text;
}

let seq = 0;

/** The columns a test may set on a guess row, beyond the posted purchase's defaults. */
export type GuessOver = {
	date?: string;
	plaid_transaction_id?: string;
	merchant_name?: string | null;
	category_id?: number | null;
	category_source?: string | null;
	category_confidence?: number | null;
	jev_category_id?: number | null;
	amount_cents?: number;
	pending?: number;
	credit_reviewed?: number;
	parent_id?: number | null;
	flag_transfer?: number;
	jev_attempts?: number;
	jev_failed_at?: string | null;
	note?: string | null;
};

/** Inserts one posted purchase (money out) that the second ask may be owed, with Eating Out at 0.6, and clears its mark. */
export async function guessRow(
	name: string,
	over: GuessOver = {},
): Promise<number> {
	seq += 1;

	const row = {
		account_id: 1,
		date: DAY,
		amount_cents: 1200,
		raw_name: name,
		plaid_transaction_id: `second-${seq}`,
		plaid_category: "FOOD_AND_DRINK",
		category_id: null,
		category_source: null,
		jev_category_id: await categoryId("Eating Out"),
		category_confidence: 0.6,
		income_confidence: 0.1,
		details_asked: 1,
		pending: 0,
		...over,
	};

	const columns = Object.keys(row);

	const inserted = await db
		.prepare(
			`INSERT INTO transactions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING id`,
		)
		.bind(...Object.values(row))
		.first<{ id: number }>();

	const id = Number(inserted?.id);

	await clearMark(id);

	return id;
}

/** Writes the row's privacy mark as the sort would: the fingerprint of what Jev is told, as it stands now. */
export async function clearMark(id: number) {
	const seen = (await seenOf(db, [id])).get(id);

	await db
		.prepare(
			"INSERT INTO lookup_cleared (transaction_id, input_mark, cleared) VALUES (?, ?, 1)",
		)
		.bind(id, seen ? await inputMark(seen) : "")
		.run();
}

/** A Jev reply to the category-only question: a category at a confidence. */
export const categoryReply = (choice: string, confidence = 0.9, status = 200) =>
	new Response(
		JSON.stringify({
			answers: { category: { type: "choice", choice, confidence } },
		}),
		{ status },
	);

/** The parts of a Jev call the fakes read: the state's facts and the questions asked, by name. */
export type JevBody = {
	state: { bank_description?: string; store_lookup?: string };
	questions: {
		category?: unknown;
		payee?: unknown;
		mixed?: unknown;
		transfer?: unknown;
	};
};

const isText = (value: unknown): value is string => typeof value === "string";

/** A call the second ask makes: the category question alone, with the line as a fact. */
export const isSecondAskBody = (body: JevBody) =>
	Object.keys(body.questions).join(",") === "category" &&
	isText(body.state.store_lookup);

/**
 * A fake Jev: each second-ask call is answered by `plan`, given its body; any other call is a recorded violation. `bodies`
 * holds every body sent, in order.
 */
export function fakeJev(plan: (body: JevBody) => Response | Promise<Response>) {
	const bodies: JevBody[] = [];
	const violations: string[] = [];

	const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
		// SAFETY: the body is the JSON askJevCategoryOnly and askJev send, whose state and questions the fake reads by name.
		const body = JSON.parse(String(init?.body ?? "{}")) as JevBody;

		bodies.push(body);

		// The privacy re-ask asks its payee question alone (it is not the second ask, so it is answered and not counted).
		if (!("category" in body.questions) && "payee" in body.questions) {
			return new Response(
				JSON.stringify({
					answers: {
						transfer: { type: "noul", noul: 0.01 },
						reimbursement: { type: "noul", noul: 0.01 },
						income: { type: "noul", noul: 0.01 },
						payee: { type: "choice", choice: "business", confidence: 0.95 },
					},
				}),
				{ status: 200 },
			);
		}

		// Any other ordinary call is a violation: the second ask never makes one.
		if (!isSecondAskBody(body))
			violations.push(Object.keys(body.questions).join(","));

		return plan(body);
	});

	return { fetchImpl, bodies, violations };
}

/** How many calls were made for the store whose raw name is `name`. */
export const callsFor = (bodies: JevBody[], name: string) =>
	bodies.filter(
		(body) => isSecondAskBody(body) && body.state.bank_description === name,
	).length;

/** The day's Jev call count, as the reservation leaves it. */
export async function dayCount(): Promise<number> {
	const row = await db
		.prepare("SELECT value FROM household_settings WHERE key = ?")
		.bind(`jev_calls_${DAY}`)
		.first<{ value: string }>();

	return Number(row?.value ?? 0);
}

/** One row's guess: its category, source, confidence and the answer record (if any). */
export async function guessOf(id: number) {
	return db
		.prepare(
			`SELECT t.category_id AS categoryId, t.category_source AS categorySource, t.category_confidence AS confidence,
				t.jev_category_id AS jevCategoryId, t.jev_none_fit AS noneFit, t.jev_attempts AS attempts,
				t.jev_failed_at AS failedAt, t.jev_also_category_id AS alsoCategoryId, t.jev_mixed AS mixed
			FROM transactions t WHERE t.id = ?`,
		)
		.bind(id)
		.first<{
			categoryId: number | null;
			categorySource: string | null;
			confidence: number | null;
			jevCategoryId: number | null;
			noneFit: number;
			attempts: number;
			failedAt: string | null;
			alsoCategoryId: number | null;
			mixed: number | null;
		}>();
}

export const answerOf = (id: number) =>
	db
		.prepare(
			"SELECT kept, kept_category_id AS keptCategoryId, kept_confidence AS keptConfidence FROM lookup_answers WHERE transaction_id = ?",
		)
		.bind(id)
		.first<{
			kept: number;
			keptCategoryId: number | null;
			keptConfidence: number | null;
		}>();

/** Runs one sorting instance with fake steps, the gate open and the given Jev fetch. */
export async function runSecond(
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	options: {
		instanceEnv?: Parameters<typeof runSortInstance>[0];
		runParams?: SortParams;
		runId?: string;
		fails?: string[];
		throws?: Record<string, number>;
		limits?: Record<string, number>;
		replayAfter?: string[];
		beforeAttempt?: (name: string, attempt: number) => Promise<void>;
	} = {},
) {
	const steps = fakeSteps({
		fails: options.fails,
		throws: options.throws,
		limits: options.limits,
		replayAfter: options.replayAfter,
		beforeAttempt: options.beforeAttempt,
	});

	await runSortInstance(
		options.instanceEnv ?? gateOpen,
		steps.runStep,
		options.runParams ?? params,
		{ runId: options.runId ?? RUN_ID, fetchImpl },
	);

	return steps;
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOON_MS);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});

	await resetDemo(db, DAY);
	await db.batch([
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchant_lookup_texts"),
		db.prepare("DELETE FROM merchant_lookups"),
		db.prepare(
			"DELETE FROM household_settings WHERE key = 'sorting_turn' OR key GLOB 'jev_calls_*' OR key GLOB 'jev_reserved_*'",
		),
	]);
	await saveAiSwitches(db, AI_SWITCHES_ALL_ON);

	expect(await countWaitingForJev(db, { categories: true, income: true })).toBe(
		0,
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
