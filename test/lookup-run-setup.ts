import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { lookupCallsKey } from "../src/db/lookup-calls";
import { seenOf } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { inputMark } from "../src/lookup/input-mark";
import { runSortInstance } from "../src/sort-instance";
import type { SortParams } from "../src/sort-start";
import { fakeSteps } from "./fake-sort-steps";

// The store lookup's run (src/lookup/run.ts), through the sorting instance with fake steps. Every fake records any call that
// the run should not make, and every test asserts that none was made: a throw inside a fake is a planted failure, not a
// violation, so the record is the only way a stray call shows.

export const db = env.DB;
export const DAY = "2026-11-15";
/** Noon on DAY in New York, the household's default zone (decision 67). A lease is 15 minutes, so tests move less than that. */
export const NOON_MS = Date.parse("2026-11-15T17:00:00.000Z");
export const MINUTE = 60_000;
export const TAVILY_URL = "https://api.tavily.com/search";
export const LINE = "Coffee shop in Arlington, VA";

/** Every store the tests make, in the order they are created (so the oldest, by first transaction id, is the first). */
export const STORE_NAMES = [
	"Alder Cafe",
	"Birch Grill",
	"Cedar Bakery",
	"Dune Books",
	"Elm Diner",
	"Fern Market",
	"Grove Pharmacy",
	"Hazel Bistro",
	"Iris Florist",
	"Juniper Tea",
	"Kelp Sushi",
	"Linden Pizza",
];

/** A store's lookup text: its name in lower case, as lookupTextOf keeps it. */
export const textOf = (name: string) => name.toLowerCase();

/** Violations: a call the run should not have made (a Jev call, a search for a store it should not search, a stray message). */
export const violations: string[] = [];

let food = 0;
let plaidSeq = 0;

/** Inserts one purchase on the checking account and returns its id; the defaults are an ordinary, sign-bearing row. */
export async function addRow(
	values: Record<string, string | number | null>,
): Promise<number> {
	plaidSeq += 1;

	const row = {
		account_id: 1,
		date: DAY,
		amount_cents: -1200,
		raw_name: STORE_NAMES[0],
		plaid_transaction_id: `run-${plaidSeq}`,
		plaid_category: "FOOD_AND_DRINK",
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

/** Writes the row's lookup mark as the sort would: the fingerprint of what Jev is told, as it stands now. */
export async function markCleared(id: number, cleared = 1) {
	const seen = (await seenOf(db, [id])).get(id);

	await db
		.prepare(
			"INSERT INTO lookup_cleared (transaction_id, input_mark, cleared) VALUES (?, ?, ?)",
		)
		.bind(id, seen ? await inputMark(seen) : "", cleared)
		.run();
}

/**
 * Makes one store eligible to be searched: a row Jev answered and cleared (the same shape as lookup-eligibility.test.ts's
 * clearedRow). The store's name is letters only, so its lookup text keeps every word.
 */
export async function eligibleStore(name: string): Promise<number> {
	const id = await addRow({
		raw_name: name,
		category_id: food,
		category_source: "jev",
		jev_category_id: food,
	});

	await markCleared(id, 1);

	return id;
}

/** Makes a text private, as a person's transfer flag does (readRowFacts): the store's rows are never searched again. */
export async function makePrivate(name: string) {
	await db
		.prepare(
			"UPDATE transactions SET flag_transfer = 1 WHERE raw_name = ?",
		)
		.bind(name)
		.run();
}

/** A store's stored row, or null: the fields the tests read. */
export async function lookupRow(text: string) {
	return db
		.prepare(
			"SELECT status, attempts, claimed_by AS claimedBy, line, looked_up_at AS lookedUpAt, failed_at AS failedAt FROM merchant_lookups WHERE lookup_text = ?",
		)
		.bind(text)
		.first<{
			status: string;
			attempts: number;
			claimedBy: string | null;
			line: string | null;
			lookedUpAt: string | null;
			failedAt: string | null;
		}>();
}

/** One search taken from the day's count (lookup_calls_<day>); 0 when no row exists. */
export async function dayCount(day = DAY): Promise<number> {
	const row = await db
		.prepare("SELECT CAST(value AS INTEGER) AS n FROM household_settings WHERE key = ?")
		.bind(lookupCallsKey(day))
		.first<{ n: number }>();

	return Number(row?.n ?? 0);
}

/** Sets the day's count, as a run before this one would have left it. */
export async function setDayCount(n: number, day = DAY) {
	await db
		.prepare(
			"INSERT INTO household_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.bind(lookupCallsKey(day), String(n))
		.run();
}

/** The gate's environment for a run: the Tavily key and a cap above 0 (production), and the AI binding. */
export function gateEnv(ai: Ai) {
	return { DB: db, DEMO: "false", TAVILY_API_KEY: "tvly", AI: ai };
}

/** The params a sort with no rows of its own takes: the groups ask nothing, so only the lookup runs. */
export const PARAMS: SortParams = { bySync: false, rulesApplied: false, ids: [] };

/** A Jev fetch that must never be called: a lookup test has no Jev key, so any call is a violation. */
export const noJev = (async () => {
	violations.push("jev call");
	throw new Error("no Jev call in a lookup test");
}) as typeof fetch;

/** A search answer: Tavily's results for the query, or the status and body a test gives. */
export type SearchPlan = (
	query: string,
	call: number,
) => Promise<Response> | Response | undefined;

/**
 * A fake Tavily: records every query it is asked, answers with one result for a known store (or with `plan`'s answer),
 * and records a violation for any other URL or any query that is not a store's text.
 */
export function fakeSearch(known: string[], plan?: SearchPlan) {
	const queries: string[] = [];

	const fetchFake = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		if (String(input) !== TAVILY_URL) {
			violations.push(`search url ${String(input)}`);
			throw new Error("unexpected url");
		}

		const body = JSON.parse(String(init?.body)) as { query: string };

		queries.push(body.query);

		const planned = await plan?.(body.query, queries.length);

		if (planned) return planned;

		if (!known.includes(body.query)) {
			violations.push(`search for ${body.query}`);
			throw new Error("unexpected query");
		}

		return Response.json({
			query: body.query,
			results: [
				{
					title: "A title",
					url: "https://example.test/page",
					content: "A short description of the place.",
					score: 0.9,
				},
			],
		});
	};

	return { fetch: fetchFake as typeof fetch, queries };
}

/** A Tavily answer with no results: the store is not on the web. */
export const noResults = (query: string) =>
	Response.json({ query, results: [] });

/** A Tavily answer with an HTTP status and no results. */
export const httpStatus = (code: number) => new Response("", { status: code });

/** The line model's answer for one store: a line, a reply, or an error that the model throws. */
export type AiPlan = (
	store: string,
	call: number,
) => Promise<string | Error> | string | Error | undefined;

/**
 * A fake Workers AI binding: records every call, answers with `plan`'s reply or the default line, and records a violation
 * for any message that is not a store's line request (its user message starts with `Store: `).
 */
export function fakeAi(known: string[], plan?: AiPlan) {
	const stores: string[] = [];

	const run = async (
		_model: string,
		input: { messages: { role: string; content: string }[] },
		_options?: { signal?: AbortSignal },
	) => {
		const content = input.messages[1]?.content ?? "";

		if (!content.startsWith("Store: ")) {
			violations.push("ai message");
			throw new Error("unexpected message");
		}

		const store = content.slice("Store: ".length).split("\n")[0] ?? "";

		stores.push(store);

		if (!known.includes(store)) violations.push(`ai for ${store}`);

		const planned = await plan?.(store, stores.length);

		if (planned instanceof Error) throw planned;

		return { response: planned ?? LINE };
	};

	// SAFETY: the module calls only ai.run, the one member this fake provides.
	return { ai: { run } as unknown as Ai, stores };
}

/** Runs one sorting instance with fake steps, the lookup open and the given fakes. Returns the steps it ran. */
export async function runInstance({
	search,
	ai,
	runId = "run-1",
	steps = {},
	env: overrides = {},
	params = PARAMS,
}: {
	search: { fetch: typeof fetch };
	ai: Ai;
	runId?: string;
	steps?: Parameters<typeof fakeSteps>[0];
	env?: Record<string, unknown>;
	params?: SortParams;
}) {
	const fake = fakeSteps(steps);

	await runSortInstance(
		{ ...gateEnv(ai), ...overrides },
		fake.runStep,
		params,
		{ runId, fetchImpl: noJev, searchFetch: search.fetch },
	);

	return fake;
}

/**
 * The setup every lookup run test shares: a fixed noon, the demo reset, every switch on, no counts, no turn, and the
 * violation check at the end. Call once at the top of a test file.
 */
export function lookupRunSetup() {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOON_MS);
		violations.length = 0;
		plaidSeq = 0;

		await resetDemo(db, DAY);
		await db.prepare("DELETE FROM merchant_lookup_texts").run();
		await db
			.prepare(
				"DELETE FROM household_settings WHERE key GLOB 'lookup_calls_*' OR key = 'sorting_turn'",
			)
			.run();
		await saveAiSwitches(db, AI_SWITCHES_ALL_ON);

		const categories = await db
			.prepare("SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1")
			.all<{ id: number }>();

		food = Number(categories.results[0]?.id);
	});

	afterEach(() => {
		vi.useRealTimers();
		expect(violations).toEqual([]);
	});
}
