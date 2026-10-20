import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JEV_URL } from "../src/ai/categorize";
import { type Decision, decide, NONE_FIT } from "../src/ai/decide";
import { askAgain, categorizePending } from "../src/categorize-pending";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
import {
	jevSaysMixedAmong,
	jevSaysMixedSql,
	looksMixed,
} from "../src/db/mixed-trip";
import { getTransaction, saveJevResult } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { organizeOffer } from "../src/transactions/organize";
import {
	firstRuleOfferAmong,
	ruleOfferForTransaction,
} from "../src/transactions/rule-offer";
import { recordSorting } from "./record-sorting";

// Mixed trips (#233, decision 113): Jev's "spans more than one category" answer and the other category it named
// are kept with the transaction, read by one SQL rule, and gate the split line and the rule questions.

const db = env.DB;
recordSorting({ sort: true });
const today = todayIn(DEFAULT_TIME_ZONE);
const JEV_KEY = { JEV_API_KEY: "jev-key" };

const categoryIdOf = async (name: string) =>
	(
		await db
			.prepare("SELECT id FROM categories WHERE name = ?")
			.bind(name)
			.first<{ id: number }>()
	)?.id as number;

/** Inserts one unsorted demo-account row with the given columns and returns its id. */
async function insertTrip(
	rawName: string,
	extra: Record<string, unknown> = {},
): Promise<number> {
	const columns = [
		"account_id",
		"date",
		"amount_cents",
		"raw_name",
		...Object.keys(extra),
	];
	const values = [1, today, 1000, rawName, ...Object.values(extra)];
	const row = await db
		.prepare(
			`INSERT INTO transactions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING id`,
		)
		.bind(...values)
		.first<{ id: number }>();
	return row?.id as number;
}

const rowOf = (id: number) =>
	db
		.prepare(
			"SELECT category_id, category_source, category_confidence, jev_category_id, jev_mixed, jev_also_category_id FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<Record<string, unknown>>();

/** A fake Jev answering each call with the given answers (the flags are filled in). */
function fakeJev(answers: Record<string, unknown>) {
	return vi.fn(async (url: string) => {
		if (String(url) !== JEV_URL) throw new Error(`unexpected fetch ${url}`);
		return Response.json({
			answers: {
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
				...answers,
			},
		});
	});
}

beforeEach(async () => {
	vi.restoreAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	await resetDemo(db, today);
	await saveAiSwitches(db, { details: false });
	await db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();
});

describe("decide reads Jev's mixed-trip answer (#233)", () => {
	const categories = [
		{ id: 1, name: "Groceries" },
		{ id: 2, name: "Household" },
	];
	const answer = (over: object = {}) => ({
		category: { label: "Groceries", confidence: 0.9 },
		flags: { transfer: 0.01, reimbursement: 0.01, income: 0.01 },
		...over,
	});

	it("keeps the probability and the active other category it named", () => {
		const d = decide(
			answer({ mixed: { probability: 0.91, also: "Household" } }),
			categories,
			0.8,
		);
		expect(d).toMatchObject({ mixedProbability: 0.91, alsoCategoryId: 2 });
	});

	it("keeps the probability and no category when Jev named none", () => {
		const d = decide(
			answer({ mixed: { probability: 0.91, also: NONE_FIT } }),
			categories,
			0.8,
		);
		expect(d).toMatchObject({ mixedProbability: 0.91, alsoCategoryId: null });
	});

	it("names no category Tally can't offer (not an active one)", () => {
		const d = decide(
			answer({ mixed: { probability: 0.91, also: "Gas" } }),
			categories,
			0.8,
		);
		expect(d).toMatchObject({ mixedProbability: 0.91, alsoCategoryId: null });
	});

	it("reads nothing when the categories switch is off, or when Jev gave no mixed reading", () => {
		const off = decide(
			answer({ mixed: { probability: 0.91, also: "Household" } }),
			categories,
			0.8,
			{ categories: false },
		);
		expect(off).not.toHaveProperty("mixedProbability");
		expect(off).not.toHaveProperty("alsoCategoryId");
		expect(decide(answer(), categories, 0.8)).not.toHaveProperty(
			"mixedProbability",
		);
	});
});

describe("saveJevResult stores and clears the mixed-trip answer (#233)", () => {
	const decision = (over: Partial<Decision> = {}): Decision => ({
		categoryId: null,
		suggestedCategoryId: null,
		confidence: 0.5,
		flags: { transfer: false, reimbursement: false, income: false },
		mixedProbability: null,
		alsoCategoryId: null,
		...over,
	});

	it("writes Jev's probability and the other category beside its pick", async () => {
		const groceries = await categoryIdOf("Groceries");
		const household = await categoryIdOf("Household");
		const id = await insertTrip("MIXED-TRIP-SAVE");
		await saveJevResult(
			db,
			id,
			decision({
				suggestedCategoryId: groceries,
				mixedProbability: 0.9,
				alsoCategoryId: household,
			}),
		);
		expect(await rowOf(id)).toMatchObject({
			jev_mixed: 0.9,
			jev_also_category_id: household,
		});
	});

	it("writes nothing for a mixed trip when Jev gave no reading", async () => {
		const id = await insertTrip("MIXED-TRIP-NONE");
		await saveJevResult(db, id, decision({ confidence: 0.95 }));
		expect(await rowOf(id)).toMatchObject({
			jev_mixed: null,
			jev_also_category_id: null,
		});
	});

	it("clears them when Jev is asked again, even when that call fails", async () => {
		const groceries = await categoryIdOf("Groceries");
		const household = await categoryIdOf("Household");
		const id = await insertTrip("MIXED-TRIP-ASK-AGAIN");
		await saveJevResult(
			db,
			id,
			decision({
				suggestedCategoryId: groceries,
				mixedProbability: 0.9,
				alsoCategoryId: household,
			}),
		);
		const failing = vi.fn(async () => new Response("{}", { status: 503 }));
		vi.stubGlobal("fetch", failing);
		await askAgain({ DB: db, ...JEV_KEY, SORT: env.SORT }, id);
		expect(await rowOf(id)).toMatchObject({
			jev_mixed: null,
			jev_also_category_id: null,
		});
	});

	it("is never set by a failed call during the nightly run", async () => {
		const id = await insertTrip("MIXED-TRIP-FAILED");
		const failing = vi.fn(async () => new Response("{}", { status: 500 }));
		await categorizePending({ DB: db, ...JEV_KEY }, failing, {
			onlyIds: [id],
		});
		expect(await rowOf(id)).toMatchObject({
			jev_mixed: null,
			jev_also_category_id: null,
		});
	});

	it("stores the reading end to end from one Jev call per transaction", async () => {
		const groceries = await categoryIdOf("Groceries");
		const household = await categoryIdOf("Household");
		const id = await insertTrip("MIXED-TRIP-END-TO-END");
		const fetchImpl = fakeJev({
			category: { type: "choice", choice: "Groceries", confidence: 0.93 },
			mixed: { type: "noul", noul: 0.92 },
			also_category: { type: "choice", choice: "Household", confidence: 0.7 },
		});
		await categorizePending({ DB: db, ...JEV_KEY }, fetchImpl, {
			onlyIds: [id],
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(await rowOf(id)).toMatchObject({
			jev_category_id: groceries,
			jev_mixed: 0.92,
			jev_also_category_id: household,
		});
	});
});

describe("the mixed-trip rule (#233)", () => {
	it("matches Jev's threshold, two different active categories, and nothing else", async () => {
		const groceries = await categoryIdOf("Groceries");
		const household = await categoryIdOf("Household");
		const eating = await categoryIdOf("Eating Out");
		const gas = await categoryIdOf("Gas");
		const cases: [string, Record<string, unknown>, number][] = [
			[
				"MIXED-AT-THRESHOLD",
				{
					jev_category_id: groceries,
					jev_mixed: 0.8,
					jev_also_category_id: household,
				},
				1,
			],
			[
				"MIXED-BELOW",
				{
					jev_category_id: groceries,
					jev_mixed: 0.79,
					jev_also_category_id: household,
				},
				0,
			],
			[
				"MIXED-NO-OTHER",
				{
					jev_category_id: groceries,
					jev_mixed: 0.95,
					jev_also_category_id: null,
				},
				0,
			],
			[
				"MIXED-SAME",
				{
					jev_category_id: groceries,
					jev_mixed: 0.95,
					jev_also_category_id: groceries,
				},
				0,
			],
			[
				"MIXED-NO-READING",
				{
					jev_category_id: groceries,
					jev_mixed: null,
					jev_also_category_id: household,
				},
				0,
			],
			[
				"MIXED-NO-PICK",
				{
					jev_category_id: null,
					jev_mixed: 0.95,
					jev_also_category_id: household,
				},
				0,
			],
			[
				"MIXED-ARCHIVED-OTHER",
				{
					jev_category_id: groceries,
					jev_mixed: 0.95,
					jev_also_category_id: gas,
				},
				0,
			],
			[
				"MIXED-ARCHIVED-PICK",
				{
					jev_category_id: eating,
					jev_mixed: 0.95,
					jev_also_category_id: household,
				},
				0,
			],
		];
		for (const [rawName, extra] of cases) await insertTrip(rawName, extra);
		await db
			.prepare("UPDATE categories SET archived = 1 WHERE id IN (?, ?)")
			.bind(gas, eating)
			.run();
		const hits = await db
			.prepare(
				`SELECT raw_name AS rawName, ${jevSaysMixedSql("transactions")} AS hit FROM transactions WHERE raw_name LIKE 'MIXED-%'`,
			)
			.all<{ rawName: string; hit: number }>();
		const byName = Object.fromEntries(
			hits.results.map((row) => [row.rawName, row.hit]),
		);
		for (const [rawName, , expected] of cases)
			expect(byName[rawName], rawName).toBe(expected);
	});

	it("looks mixed only while no person chose the category", () => {
		expect(looksMixed(true, "jev")).toBe(true);
		expect(looksMixed(true, null)).toBe(true);
		expect(looksMixed(true, "merchant_rule")).toBe(true);
		expect(looksMixed(true, "user")).toBe(false);
		expect(looksMixed(false, null)).toBe(false);
	});
});

describe("a mixed trip gets no rule question (#233)", () => {
	const merchant = "mixed-store";
	let groceries: number;
	let household: number;
	let picks: number[];

	beforeEach(async () => {
		groceries = await categoryIdOf("Groceries");
		household = await categoryIdOf("Household");
		await db
			.prepare("INSERT INTO merchants (raw_name) VALUES (?)")
			.bind(merchant)
			.run();
		for (let i = 0; i < 3; i++)
			await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 1000, ?, ?, ?, 'user')",
				)
				.bind(today, merchant, merchant, groceries)
				.run();
		const rows = await db
			.prepare(
				"SELECT id FROM transactions WHERE merchant_name = ? ORDER BY id",
			)
			.bind(merchant)
			.all<{ id: number }>();
		picks = rows.results.map((row) => row.id);
	});

	const markMixed = (id: number) =>
		db
			.prepare(
				"UPDATE transactions SET jev_category_id = ?, jev_mixed = 0.9, jev_also_category_id = ? WHERE id = ?",
			)
			.bind(groceries, household, id)
			.run();

	it("offers the rule on three picks when no trip looks mixed", async () => {
		expect(
			await ruleOfferForTransaction(db, picks[2] as number, groceries),
		).toMatchObject({ categoryId: groceries, count: 3 });
		expect(await firstRuleOfferAmong(db, picks, groceries)).toMatchObject({
			categoryId: groceries,
			count: 3,
		});
		expect(await jevSaysMixedAmong(db, picks)).toBe(false);
	});

	it("never offers the rule on a trip Jev says looks mixed, even after a person's pick", async () => {
		await markMixed(picks[2] as number);
		expect(
			await ruleOfferForTransaction(db, picks[2] as number, groceries),
		).toBeNull();
		expect(await firstRuleOfferAmong(db, picks, groceries)).toBeNull();
		expect(await jevSaysMixedAmong(db, picks)).toBe(true);
	});

	it("keeps Organize's question off a group that filed a mixed trip, on save and on reload", async () => {
		expect(await organizeOffer(db, picks, groceries)).not.toBeNull();
		await markMixed(picks[0] as number);
		expect(await organizeOffer(db, picks, groceries)).toBeNull();
	});

	it("reads the mixed reading onto the transaction the edit panel shows", async () => {
		await markMixed(picks[2] as number);
		expect(await getTransaction(db, picks[2] as number)).toMatchObject({
			jevSaysMixed: true,
			suggestedCategoryName: "Groceries",
			alsoCategoryName: "Household",
			categorySource: "user",
		});
		await db
			.prepare("UPDATE categories SET archived = 1 WHERE id = ?")
			.bind(household)
			.run();
		expect(await getTransaction(db, picks[2] as number)).toMatchObject({
			jevSaysMixed: false,
			alsoCategoryName: null,
		});
	});
});
