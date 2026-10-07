import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE_FIT } from "../src/ai/decide";
import {
	categorizePending,
	jevCallLimit,
	MAX_CALLS_PER_RUN,
} from "../src/categorize-pending";
import { householdToday } from "../src/dates";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { reserveJevCalls } from "../src/db/jev-calls";
import { loadMonth } from "../src/db/month";
import {
	merchantCategoryHistoryForJev,
	monthCounts,
	needsCategoryCount,
	pendingForJev,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;
const TODAY = "2026-09-22";
const MONTH = "2026-09";

/** A Jev reply: Eating Out at the given confidence, no flags. */
const reply = (confidence: number) =>
	new Response(
		JSON.stringify({
			answers: {
				category: { type: "choice", choice: "Eating Out", confidence },
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
			},
		}),
		{ status: 200 },
	);

/** A fake Jev answering each call in turn; later calls reuse the last answer. */
function fakeJev(...responses: (() => Response)[]) {
	let calls = 0;
	const fetchImpl = async () => {
		const respond = responses[Math.min(calls, responses.length - 1)];
		calls += 1;
		return (respond as () => Response)();
	};
	return { fetchImpl, calls: () => calls };
}

const withKey = { DB: db, JEV_API_KEY: "test-key" };
type SentRequest = { state: Record<string, unknown> };

const countWhere = async (where: string) =>
	(
		await db
			.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`)
			.first<{ n: number }>()
	)?.n ?? 0;

/** The household's next day: yesterday's Jev count no longer applies. */
const newDay = () =>
	db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();

/** How many of the household day's calls are spoken for (spec §8.6); 40 is the demo's cap. */
const callsUsed = async (day?: string) =>
	Number(
		(
			await db
				.prepare("SELECT value FROM household_settings WHERE key = ?")
				.bind(`jev_calls_${day ?? (await householdToday(db))}`)
				.first<{ value: string }>()
		)?.value ?? 0,
	);

const switchTo = (over: Partial<typeof AI_SWITCHES_ALL_ON>) =>
	saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, details: false, ...over });

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await saveAiSwitches(db, { details: false });
	// The demo's reset keeps the day's Jev count, so each test starts a day of its own.
	await newDay();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("categorizePending", () => {
	it("leaves an unasked category eligible when the household has no active categories", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db.prepare("UPDATE categories SET archived=1").run();
		await switchTo({ categories: true, income: true });
		const id = Number(
			(
				await db
					.prepare(
						"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES(1,?,500,'NO ACTIVE CATEGORIES') RETURNING id",
					)
					.bind(`${MONTH}-20`)
					.first<{ id: number }>()
			)?.id,
		);
		await categorizePending(
			withKey,
			async () =>
				Response.json({
					answers: {
						category: { type: "choice", choice: NONE_FIT, confidence: 0.99 },
						transfer: { noul: 0 },
						reimbursement: { noul: 0 },
						income: { noul: 0 },
					},
				}),
			{ rulesApplied: true, onlyIds: [id] },
		);
		expect(
			await db
				.prepare(
					"SELECT category_confidence, jev_category_id, jev_none_fit FROM transactions WHERE id=?",
				)
				.bind(id)
				.first(),
		).toEqual({
			category_confidence: null,
			jev_category_id: null,
			jev_none_fit: 0,
		});
		await db.prepare("UPDATE categories SET archived=0").run();
		await switchTo({ categories: true, income: true });
		expect((await pendingForJev(db, 50)).some((row) => row.id === id)).toBe(
			true,
		);
	});

	it("does not read or send history when category guessing is off, but does when it is on", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const target = await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, ?, 1200, 'MARKET TODAY', 'Market') RETURNING id",
			)
			.bind(`${MONTH}-20`)
			.first<{ id: number }>();
		await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 500, 'MARKET OLD', 'Market', 1, 'user')",
			)
			.bind(`${MONTH}-01`)
			.run();
		const run = async (categories: boolean) => {
			await db
				.prepare(
					"UPDATE transactions SET category_confidence = NULL WHERE id = ?",
				)
				.bind(target?.id)
				.run();
			let historyReads = 0;
			const counted = new Proxy(db, {
				get(targetDb, property) {
					const value = Reflect.get(targetDb, property);
					if (property === "prepare")
						return (sql: string) => {
							if (sql.includes("ROW_NUMBER() OVER (PARTITION BY"))
								historyReads += 1;
							return targetDb.prepare(sql);
						};
					return typeof value === "function" ? value.bind(targetDb) : value;
				},
			});
			let sent: SentRequest | undefined;
			await saveAiSwitches(db, {
				...AI_SWITCHES_ALL_ON,
				categories,
				income: true,
			});
			await categorizePending(
				{ ...withKey, DB: counted as D1Database },
				async (_url, init) => {
					sent = JSON.parse(String(init?.body));
					return reply(0.5);
				},
				{ rulesApplied: true, onlyIds: [target?.id as number] },
			);
			return { historyReads, sent };
		};
		const off = await run(false);
		expect(off.historyReads).toBe(0);
		expect(off.sent?.state).not.toHaveProperty("merchant_category_history");
		const on = await run(true);
		expect(on.historyReads).toBe(1);
		expect(on.sent?.state.merchant_category_history).toEqual([["Groceries"]]);
	});

	it("omits history when category guessing is turned off between calls", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await switchTo({ categories: true, income: true });
		await db.batch([
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, 'HISTORY BEFORE', 'Switch Shop', 1, 'user')",
				)
				.bind(`${MONTH}-01`),
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, ?, 100, 'SWITCH TARGET A', 'Switch Shop')",
				)
				.bind(`${MONTH}-20`),
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, ?, 100, 'SWITCH TARGET B', 'Switch Shop')",
				)
				.bind(`${MONTH}-21`),
		]);
		const targets = (
			await db
				.prepare(
					"SELECT id FROM transactions WHERE raw_name IN ('SWITCH TARGET A', 'SWITCH TARGET B') ORDER BY date",
				)
				.all<{ id: number }>()
		).results;
		const histories: unknown[] = [];
		await categorizePending(
			withKey,
			async (_url, init) => {
				histories.push(
					JSON.parse(String(init?.body)).state.merchant_category_history,
				);
				if (histories.length === 1)
					await switchTo({ categories: false, income: true });
				return reply(0.5);
			},
			{ rulesApplied: true, onlyIds: targets.map(({ id }) => id) },
		);
		expect(histories).toEqual([[["Groceries"]], undefined]);
	});

	it("returns five chosen category names newest first, using id to break date ties", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const categories = (
			await db
				.prepare(
					"SELECT id, name FROM categories WHERE archived = 0 ORDER BY id LIMIT 5",
				)
				.all<{ id: number; name: string }>()
		).results;
		for (let i = 0; i < 6; i++) {
			const category = categories[i % categories.length];
			await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, ?, 'Tie Shop', ?, 'user')",
				)
				.bind(
					i >= 4 ? `${MONTH}-10` : `${MONTH}-${String(i + 1).padStart(2, "0")}`,
					`TIE ${i}`,
					category?.id,
				)
				.run();
		}
		const target = await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, ?, 200, 'TIE TARGET', 'Tie Shop') RETURNING id",
			)
			.bind(`${MONTH}-20`)
			.first<{ id: number }>();
		let sent: SentRequest | undefined;
		await categorizePending(
			withKey,
			async (_url, init) => {
				sent = JSON.parse(String(init?.body));
				return reply(0.5);
			},
			{ rulesApplied: true, onlyIds: [target?.id as number] },
		);
		expect(sent?.state.merchant_category_history).toEqual([
			[categories[0]?.name],
			[categories[4]?.name],
			[categories[3]?.name],
			[categories[2]?.name],
			[categories[1]?.name],
		]);
	});

	it("excludes archived categories and Jev-sourced categories from history", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const categories = (
			await db
				.prepare(
					"SELECT id, name FROM categories WHERE archived = 0 ORDER BY id LIMIT 2",
				)
				.all<{ id: number; name: string }>()
		).results;
		const archived = categories[1];
		await db
			.prepare("UPDATE categories SET archived = 1 WHERE id = ?")
			.bind(archived?.id)
			.run();
		await db.batch([
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, 'OLD ACTIVE', 'Archive Shop', ?, 'user')",
				)
				.bind(`${MONTH}-02`, categories[0]?.id),
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, 'OLD ARCHIVED', 'Archive Shop', ?, 'user')",
				)
				.bind(`${MONTH}-03`, archived?.id),
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, 'OLD JEV', 'Archive Shop', ?, 'jev')",
				)
				.bind(`${MONTH}-04`, categories[0]?.id),
		]);
		const target = await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, ?, 200, 'ARCHIVE TARGET', 'Archive Shop') RETURNING id",
			)
			.bind(`${MONTH}-20`)
			.first<{ id: number }>();
		let sent: SentRequest | undefined;
		await categorizePending(
			withKey,
			async (_url, init) => {
				sent = JSON.parse(String(init?.body));
				return reply(0.5);
			},
			{ rulesApplied: true, onlyIds: [target?.id as number] },
		);
		expect(sent?.state.merchant_category_history).toEqual([
			[categories[0]?.name],
		]);
	});

	it("excludes every transaction in the current page from each transaction's history", async () => {
		await db.batch([
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, 'OLD', 'Page Shop', 1, 'user')",
				)
				.bind(`${MONTH}-01`),
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, 'PAGE A', 'Page Shop', 2, 'user')",
				)
				.bind(`${MONTH}-02`),
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, 'PAGE B', 'Page Shop', 3, 'merchant_rule')",
				)
				.bind(`${MONTH}-03`),
		]);
		const ids = (
			await db
				.prepare(
					"SELECT id FROM transactions WHERE raw_name IN ('PAGE A', 'PAGE B') ORDER BY id",
				)
				.all<{ id: number }>()
		).results;
		expect(
			await merchantCategoryHistoryForJev(
				db,
				ids.map(({ id }) => ({ id, merchantKey: "Page Shop" })),
			),
		).toEqual(new Map([["Page Shop", [["Groceries"]]]]));
	});

	it("keeps a person-chosen category in history when its transaction pays a bill", async () => {
		const transaction = await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, 'LINKED HUMAN', 'Bill Shop', 2, 'user') RETURNING id",
			)
			.bind(`${MONTH}-01`)
			.first<{ id: number }>();
		const bill = await db
			.prepare(
				"INSERT INTO bills (name, amount_cents, due_day, frequency, category_id, merchant_raw_name, active) VALUES ('Bill Shop bill', 100, 4, 'monthly', 1, 'Bill Shop', 1) RETURNING id",
			)
			.first<{ id: number }>();
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, ?, ?, 'user', 'linked')",
			)
			.bind(bill?.id, MONTH, transaction?.id)
			.run();
		const history = await merchantCategoryHistoryForJev(db, [
			{ id: 999999, merchantKey: "Bill Shop" },
		]);
		expect(history).toEqual(new Map([["Bill Shop", [["Eating Out"]]]]));
	});

	it("includes an older raw-name trip with the current Plaid merchant name only for that raw text", async () => {
		await db.batch([
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 100, 'LEGACY BANK TEXT', 1, 'user')",
				)
				.bind(`${MONTH}-01`),
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 100, 'SOMEONE ELSES BANK TEXT', 2, 'user')",
				)
				.bind(`${MONTH}-02`),
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, ?, 100, 'LEGACY BANK TEXT', 'Named Shop')",
				)
				.bind(`${MONTH}-20`),
		]);
		const target = await db
			.prepare("SELECT id FROM transactions WHERE merchant_name = 'Named Shop'")
			.first<{ id: number }>();
		const history = await merchantCategoryHistoryForJev(db, [
			{
				id: target?.id as number,
				merchantKey: "Named Shop",
				rawName: "LEGACY BANK TEXT",
			},
		]);
		expect(history.get("Named Shop")).toEqual([["Groceries"]]);
	});

	it("keeps old history unless five newer eligible trips displace it", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, date('now', '-2 years'), 100, 'WINDOW OLD', 'Rare Shop', 1, 'user')",
			),
			db.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, date('now', '-2 years'), 100, 'WINDOW OLD', 'Frequent Shop', 1, 'user')",
			),
			...Array.from({ length: 5 }, (_, index) =>
				db
					.prepare(
						"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, date('now', ? || ' days'), 100, 'WINDOW NEW', 'Frequent Shop', 2, 'user')",
					)
					.bind(String(-index - 1)),
			),
		]);
		const history = await merchantCategoryHistoryForJev(db, [
			{ id: 999999, merchantKey: "Rare Shop" },
			{ id: 999998, merchantKey: "Frequent Shop" },
		]);
		expect(history.get("Rare Shop")).toEqual([["Groceries"]]);
		expect(history.get("Frequent Shop")).toEqual([
			["Eating Out"],
			["Eating Out"],
			["Eating Out"],
			["Eating Out"],
			["Eating Out"],
		]);
	});

	it("includes excluded bill payments in history while excluding other excluded rows", async () => {
		const billTrip = await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, excluded) VALUES (1, ?, 100, 'EXCLUDED BILL', 'Bill History Shop', 2, 'user', 1) RETURNING id",
			)
			.bind(`${MONTH}-02`)
			.first<{ id: number }>();
		await db.batch([
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, excluded) VALUES (1, ?, 100, 'EXCLUDED TRANSFER', 'Bill History Shop', 1, 'user', 1)",
				)
				.bind(`${MONTH}-03`),
			db.prepare(
				"INSERT INTO bills (name, amount_cents, due_day, frequency, category_id, merchant_raw_name, active) VALUES ('History bill', 100, 4, 'monthly', 1, 'Bill History Shop', 1) RETURNING id",
			),
		]);
		const bill = await db
			.prepare("SELECT id FROM bills WHERE name = 'History bill'")
			.first<{ id: number }>();
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, ?, ?, 'user', 'linked')",
			)
			.bind(bill?.id, MONTH, billTrip?.id)
			.run();
		const history = await merchantCategoryHistoryForJev(db, [
			{ id: 999999, merchantKey: "Bill History Shop" },
		]);
		expect(history.get("Bill History Shop")).toEqual([["Eating Out"]]);
	});

	it("includes only user and merchant-rule categories in history", async () => {
		await db.batch([
			...[
				["JEV SOURCE", 2, "jev"],
				["NO SOURCE", 3, null],
				["USER SOURCE", 1, "user"],
				["RULE SOURCE", 2, "merchant_rule"],
			].map(([name, categoryId, source], index) =>
				db
					.prepare(
						"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, ?, 'Source Shop', ?, ?)",
					)
					.bind(
						`${MONTH}-${String(index + 1).padStart(2, "0")}`,
						name,
						categoryId,
						source,
					),
			),
		]);
		const history = await merchantCategoryHistoryForJev(db, [
			{ id: 999999, merchantKey: "Source Shop" },
		]);
		expect(history.get("Source Shop")).toEqual([["Eating Out"], ["Groceries"]]);
	});

	it("counts each split purchase as one trip and uses its active part categories", async () => {
		const addSingle = (date: string, name: string, categoryId: number) =>
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, ?, 'Trip Shop', ?, 'user')",
				)
				.bind(date, name, categoryId);
		const split = await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, is_split) VALUES (1, ?, 500, 'SPLIT TRIP', 'Trip Shop', 3, 'user', 1) RETURNING id",
			)
			.bind(`${MONTH}-15`)
			.first<{ id: number }>();
		await db.batch([
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source, parent_id) VALUES (1, ?, 300, 'SPLIT GROCERIES', 1, 'user', ?)",
				)
				.bind(`${MONTH}-15`, split?.id),
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source, parent_id) VALUES (1, ?, 200, 'SPLIT HOUSEHOLD', 2, 'merchant_rule', ?)",
				)
				.bind(`${MONTH}-15`, split?.id),
			addSingle(`${MONTH}-14`, "TRIP 2", 1),
			addSingle(`${MONTH}-13`, "TRIP 3", 2),
			addSingle(`${MONTH}-12`, "TRIP 4", 1),
			addSingle(`${MONTH}-11`, "TRIP 5", 2),
		]);
		const history = await merchantCategoryHistoryForJev(db, [
			{ id: 999999, merchantKey: "Trip Shop" },
		]);
		expect(history.get("Trip Shop")).toEqual([
			["Groceries", "Eating Out"],
			["Groceries"],
			["Eating Out"],
			["Groceries"],
			["Eating Out"],
		]);
	});

	it("orders a split trip by its parent date and keeps its parts in one entry", async () => {
		const split = await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, is_split) VALUES (1, ?, 500, 'DATED SPLIT PARENT', 'Date Shop', 3, 'user', 1) RETURNING id",
			)
			.bind(`${MONTH}-15`)
			.first<{ id: number }>();
		await db.batch([
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source, parent_id) VALUES (1, ?, 300, 'DATED SPLIT GROCERIES', 1, 'user', ?)",
				)
				.bind(`${MONTH}-01`, split?.id),
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source, parent_id) VALUES (1, ?, 200, 'DATED SPLIT HOUSEHOLD', 2, 'merchant_rule', ?)",
				)
				.bind(`${MONTH}-02`, split?.id),
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, 'DATED SINGLE', 'Date Shop', 3, 'user')",
				)
				.bind(`${MONTH}-10`),
		]);
		const history = await merchantCategoryHistoryForJev(db, [
			{ id: 999999, merchantKey: "Date Shop" },
		]);
		expect(history.get("Date Shop")).toEqual([
			["Groceries", "Eating Out"],
			["Gas"],
		]);
	});

	it("takes the newest five split and single trips, skipping unusable split parts", async () => {
		const addSplit = async (
			date: string,
			name: string,
			parts: {
				categoryId: number | null;
				source: string | null;
				excluded?: boolean;
				pending?: boolean;
			}[],
		) => {
			const parent = await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, is_split) VALUES (1, ?, 500, ?, 'Split Shop', 3, 'user', 1) RETURNING id",
				)
				.bind(date, name)
				.first<{ id: number }>();
			for (const [index, part] of parts.entries())
				await db
					.prepare(
						"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source, parent_id, excluded, pending) VALUES (1, ?, 100, ?, ?, ?, ?, ?, ?)",
					)
					.bind(
						date,
						`${name} PART ${index}`,
						part.categoryId,
						part.source,
						parent?.id,
						part.excluded ? 1 : 0,
						part.pending ? 1 : 0,
					)
					.run();
		};
		await addSplit(`${MONTH}-19`, "ARCHIVED ONLY SPLIT", [
			{ categoryId: 4, source: "user" },
		]);
		await addSplit(`${MONTH}-18`, "EMPTY SPLIT", [
			{ categoryId: null, source: null },
		]);
		await addSplit(`${MONTH}-17`, "ARCHIVED SPLIT", [
			{ categoryId: 4, source: "user" },
			{ categoryId: 2, source: "user" },
		]);
		await addSplit(`${MONTH}-16`, "SPLIT A", [
			{ categoryId: 1, source: "user" },
			{ categoryId: 2, source: "user" },
			{ categoryId: 1, source: "merchant_rule" },
			{ categoryId: 3, source: "user", excluded: true },
			{ categoryId: 3, source: "user", pending: true },
		]);
		await db.batch(
			[`${MONTH}-14`, `${MONTH}-13`, `${MONTH}-12`, `${MONTH}-11`].map(
				(date, index) =>
					db
						.prepare(
							"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, ?, 'Split Shop', ?, 'user')",
						)
						.bind(date, `SINGLE ${index}`, (index % 2) + 1),
			),
		);
		await db.prepare("UPDATE categories SET archived = 1 WHERE id = 4").run();
		const history = await merchantCategoryHistoryForJev(db, [
			{ id: 999999, merchantKey: "Split Shop" },
		]);
		expect(history.get("Split Shop")).toEqual([
			["Eating Out"],
			["Groceries", "Eating Out"],
			["Groceries"],
			["Eating Out"],
			["Groceries"],
		]);
	});

	it("uses raw-name fallback keys, shares short histories, and sends none for another merchant", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db.batch([
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, 'BANK TEXT A', 'HAND SHOP A', 1, 'user')",
				)
				.bind(`${MONTH}-01`),
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 100, 'BANK TEXT B', 'HAND SHOP A', 2, 'merchant_rule')",
				)
				.bind(`${MONTH}-02`),
			db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 100, 'OTHER HAND SHOP', 3, 'user')",
				)
				.bind(`${MONTH}-03`),
		]);
		const targets = [];
		for (const rawName of ["HAND SHOP A", "HAND SHOP A", "NO HISTORY HERE"]) {
			const row = await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 200, ?) RETURNING id",
				)
				.bind(`${MONTH}-20`, rawName)
				.first<{ id: number }>();
			targets.push(row?.id as number);
		}
		const histories: unknown[] = [];
		await categorizePending(
			withKey,
			async (_url, init) => {
				histories.push(
					JSON.parse(String(init?.body)).state.merchant_category_history,
				);
				return reply(0.5);
			},
			{ rulesApplied: true, onlyIds: targets },
		);
		expect(histories).toEqual([
			undefined,
			[["Eating Out"], ["Groceries"]],
			[["Eating Out"], ["Groceries"]],
		]);
	});
	it("sends the five newest person-chosen merchant trips in one Jev request", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db.batch(
			Array.from({ length: 5 }, (_, index) =>
				db
					.prepare(
						`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source)
						 VALUES (1, ?, 500, ?, 'Costco', 1, ?)`,
					)
					.bind(
						`${MONTH}-${String(index + 1).padStart(2, "0")}`,
						`COSTCO ${index}`,
						index === 0 ? "merchant_rule" : "user",
					),
			),
		);
		await db.batch([
			db.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('Costco', 'Costco')",
			),
			db.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source)
				 VALUES (1, '2026-08-31', 500, 'COSTCO OLD', 'Costco', 2, 'user')`,
			),
			db.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source)
				 VALUES (1, '2026-09-30', 500, 'COSTCO TALLY', 'Costco', 2, 'jev')`,
			),
			db.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, excluded)
				 VALUES (1, '2026-09-29', 500, 'COSTCO EXCLUDED', 'Costco', 2, 'user', 1)`,
			),
			db.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, pending)
				 VALUES (1, '2026-09-28', 500, 'COSTCO PENDING', 'Costco', 2, 'user', 1)`,
			),
			db.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, is_split)
				 VALUES (1, '2026-09-27', 500, 'COSTCO SPLIT PARENT', 'Costco', 2, 'user', 1)`,
			),
		]);
		const target = await db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name)
				 VALUES (1, ?, 1200, 'COSTCO CURRENT', 'Costco') RETURNING id`,
			)
			.bind(`${MONTH}-20`)
			.first<{ id: number }>();
		let calls = 0;
		let sent: Record<string, unknown> | undefined;
		await categorizePending(
			withKey,
			async (_url, init) => {
				calls += 1;
				sent = JSON.parse(String(init?.body));
				return reply(0.5);
			},
			{ rulesApplied: true, onlyIds: [target?.id as number] },
		);
		expect(calls).toBe(1);
		expect(sent?.state).toMatchObject({
			merchant: "Costco",
			merchant_category_history: [
				["Groceries"],
				["Groceries"],
				["Groceries"],
				["Groceries"],
				["Groceries"],
			],
		});
		expect(sent?.state).not.toHaveProperty("date");
		expect(sent?.state).not.toHaveProperty("account");
		expect(sent?.state).not.toHaveProperty("note");
		expect(sent?.state).not.toHaveProperty("history");
		expect(
			await db
				.prepare(
					"SELECT category_id, jev_category_id, category_confidence FROM transactions WHERE id = ?",
				)
				.bind(target?.id)
				.first(),
		).toEqual({
			category_id: null,
			jev_category_id: 2,
			category_confidence: 0.5,
		});
	});

	it("sends a transaction with no merchant history exactly as it did before", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const target = await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 1200, 'ONE-OFF SHOP') RETURNING id",
			)
			.bind(`${MONTH}-20`)
			.first<{ id: number }>();
		let sent: Record<string, unknown> | undefined;
		await categorizePending(
			withKey,
			async (_url, init) => {
				sent = JSON.parse(String(init?.body));
				return reply(0.5);
			},
			{ rulesApplied: true, onlyIds: [target?.id as number] },
		);
		expect(sent?.state).toEqual({
			bank_description: "ONE-OFF SHOP",
			merchant: null,
			amount_cents: 1200,
			direction: "money out",
			account_type: "depository",
		});
	});

	it.each([
		{ enabled: true, income: 1, source: "jev", reviewed: 1 },
		{ enabled: false, income: 0, source: null, reviewed: 0 },
	])(
		"applies the income answer only when the income switch is $enabled",
		async ({ enabled, income, source, reviewed }) => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			const id = 1;
			await db.batch([
				db
					.prepare(
						"UPDATE transactions SET amount_cents = -500, category_id = NULL, category_source = NULL, category_confidence = NULL, flag_income = 0, income_source = NULL, credit_reviewed = 0, credit_reviewed_by = NULL, excluded = 0, excluded_source = NULL WHERE id = ?",
					)
					.bind(id),
				db
					.prepare(
						"UPDATE transactions SET category_confidence = 0.5 WHERE id != ?",
					)
					.bind(id),
			]);
			const jev = fakeJev(
				() =>
					new Response(
						JSON.stringify({
							answers: {
								category: {
									type: "choice",
									choice: "None of these fit",
									confidence: 0.5,
								},
								transfer: { type: "noul", noul: 0.01 },
								reimbursement: { type: "noul", noul: 0.01 },
								income: { type: "noul", noul: 0.99 },
							},
						}),
						{ status: 200 },
					),
			);

			await saveAiSwitches(db, {
				...AI_SWITCHES_ALL_ON,
				details: false,
				income: enabled,
			});
			await categorizePending(withKey, jev.fetchImpl);
			expect(
				await db
					.prepare(
						"SELECT flag_income, income_source, credit_reviewed FROM transactions WHERE id = ?",
					)
					.bind(id)
					.first(),
			).toEqual({
				flag_income: income,
				income_source: source,
				credit_reviewed: reviewed,
			});
		},
	);

	it("does nothing without a key", async () => {
		const jev = fakeJev(() => reply(0.95));
		const result = await categorizePending({ DB: db }, jev.fetchImpl);
		expect(jev.calls()).toBe(0);
		expect(result).toEqual({ asked: 0, applied: 0 });
		expect(await needsCategoryCount(db, MONTH)).toBe(10);
	});

	it("offers category-only help for a user-reviewed credit and never overwrites the decision", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const id = 1;
		await db
			.prepare(
				"UPDATE transactions SET raw_name = 'SYNTHETIC USER REVIEWED CREDIT', category_id = NULL, category_source = NULL, category_confidence = NULL, amount_cents = -500, flag_income = 0, income_source = 'user', credit_reviewed = 1, credit_reviewed_by = 'user', excluded = 0, excluded_source = NULL, flag_transfer = 0, flag_reimbursement = 0 WHERE id = ?",
			)
			.bind(id)
			.run();
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = 0.5 WHERE id != ?",
			)
			.bind(id)
			.run();
		const pending = await pendingForJev(db, 40);
		expect(pending).toContainEqual(
			expect.objectContaining({ id, categoryOnly: true }),
		);
		const jev = fakeJev(
			() =>
				new Response(
					JSON.stringify({
						answers: {
							category: {
								type: "choice",
								choice: "Eating Out",
								confidence: 0.95,
							},
							transfer: { type: "noul", noul: 0.99 },
							reimbursement: { type: "noul", noul: 0.99 },
							income: { type: "noul", noul: 0.99 },
						},
					}),
					{ status: 200 },
				),
		);
		expect(await categorizePending(withKey, jev.fetchImpl)).toEqual({
			asked: 1,
			applied: 1,
		});
		expect(jev.calls()).toBe(1);
		const category = await db
			.prepare("SELECT id FROM categories WHERE name = 'Eating Out'")
			.first<{ id: number }>();
		expect(
			await db
				.prepare(
					"SELECT category_id, category_source, category_confidence, flag_income, income_source, credit_reviewed, credit_reviewed_by, excluded, flag_transfer, flag_reimbursement FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			category_id: category?.id,
			category_source: "jev",
			category_confidence: 0.95,
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
			excluded: 0,
			flag_transfer: 0,
			flag_reimbursement: 0,
		});
		const secondRun = fakeJev(() => reply(0.95));
		expect(await categorizePending(withKey, secondRun.fetchImpl)).toEqual({
			asked: 0,
			applied: 0,
		});
		expect(secondRun.calls()).toBe(0);
		expect(
			await db
				.prepare(
					"SELECT amount_cents, income_source, credit_reviewed_by FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			amount_cents: -500,
			income_source: "user",
			credit_reviewed_by: "user",
		});
	});

	it("applies confident answers and stores the confidence of unsure ones", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		// First 4 calls confident, the rest unsure.
		const jev = fakeJev(
			() => reply(0.95),
			() => reply(0.95),
			() => reply(0.95),
			() => reply(0.95),
			() => reply(0.5),
		);

		const result = await categorizePending(withKey, jev.fetchImpl);

		expect(jev.calls()).toBe(10);
		expect(result).toEqual({ asked: 10, applied: 4 });
		expect(await needsCategoryCount(db, MONTH)).toBe(6);
		expect(
			await countWhere(
				"category_source IS NULL AND category_id IS NULL AND category_confidence = 0.5",
			),
		).toBe(6);
	});

	it.each(["merchant_rule", "user"] as const)(
		"remembers an uncertain answer for a $categorySource-categorized credit and retries after Plaid changes it",
		async (categorySource) => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			await db
				.prepare(
					"UPDATE transactions SET category_confidence = 0.5 WHERE category_confidence IS NULL",
				)
				.run();
			const heldBefore = (await monthCounts(db, MONTH)).heldForReview;
			const inserted = await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source, category_confidence, flag_income, income_source, credit_reviewed, credit_reviewed_by) VALUES (1, ?, -777, 'SYNTHETIC UNCERTAIN CREDIT', 1, ?, NULL, 0, NULL, 0, NULL) RETURNING id",
				)
				.bind(`${MONTH}-20`, categorySource)
				.first<{ id: number }>();
			const id = inserted?.id as number;
			const jev = fakeJev(() => reply(0.5));
			expect(await categorizePending(withKey, jev.fetchImpl)).toEqual({
				asked: 1,
				applied: 0,
			});
			expect(jev.calls()).toBe(1);
			expect(
				await db
					.prepare(
						"SELECT flag_income, income_source, credit_reviewed, category_confidence, category_id, category_source FROM transactions WHERE id = ?",
					)
					.bind(id)
					.first(),
			).toEqual({
				flag_income: 0,
				income_source: null,
				credit_reviewed: 0,
				category_confidence: 0.5,
				category_id: 1,
				category_source: categorySource,
			});
			expect((await monthCounts(db, MONTH)).heldForReview).toBe(heldBefore + 1);
			expect(
				(await loadMonth(db, MONTH)).transactions.some(
					(transaction) => transaction.amountCents === -777,
				),
			).toBe(false);
			const next = fakeJev(() => reply(0.95));
			expect(await categorizePending(withKey, next.fetchImpl)).toEqual({
				asked: 0,
				applied: 0,
			});
			expect(next.calls()).toBe(0);

			// Plaid amount corrections clear Jev's saved confidence and make the transaction eligible again.
			await db
				.prepare(
					"UPDATE transactions SET amount_cents = -888, category_confidence = NULL WHERE id = ?",
				)
				.bind(id)
				.run();
			expect(
				(await pendingForJev(db, 40)).map((transaction) => transaction.id),
			).toContain(id);
			const changed = fakeJev(() => reply(0.95));
			expect(await categorizePending(withKey, changed.fetchImpl)).toEqual({
				asked: 1,
				applied: 1,
			});
			expect(changed.calls()).toBe(1);
			expect((await monthCounts(db, MONTH)).heldForReview).toBe(heldBefore);
		},
	);

	it("doesn't ask again about transactions it already looked at", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await categorizePending(withKey, fakeJev(() => reply(0.5)).fetchImpl);
		const second = fakeJev(() => reply(0.95));
		await categorizePending(withKey, second.fetchImpl);
		expect(second.calls()).toBe(0);
	});

	it("stops the run on a failure and retries the rest the next night", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		const jev = fakeJev(
			() => reply(0.95),
			() => reply(0.95),
			() =>
				new Response("{}", {
					status: 429,
					headers: { "x-typesafe-request-id": "req_9" },
				}),
		);

		const first = await categorizePending(withKey, jev.fetchImpl);

		expect(jev.calls()).toBe(3);
		expect(first).toEqual({ asked: 3, applied: 2 });
		expect(await needsCategoryCount(db, MONTH)).toBe(8);
		// The only thing logged about a failure: the status and Jev's request id.
		expect(errors).toHaveBeenCalledTimes(1);
		expect(errors).toHaveBeenCalledWith("jev: 429 req_9");

		const next = fakeJev(() => reply(0.95));
		await categorizePending(withKey, next.fetchImpl);
		expect(next.calls()).toBe(8);
		expect(await needsCategoryCount(db, MONTH)).toBe(0);
	});

	it("counts only categories it actually wrote, not ones a person chose mid-run", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			// While Jev is answering the first call, a person categorizes every pending row.
			if (calls === 1) {
				await db
					.prepare(
						"UPDATE transactions SET category_id = 1, category_source = 'user' WHERE category_id IS NULL AND flag_income = 0",
					)
					.run();
			}
			return reply(0.95);
		};
		const result = await categorizePending(withKey, fetchImpl);
		expect(result.applied).toBe(0);
	});

	it("logs only counts on success, never transaction details", async () => {
		const logs = vi.spyOn(console, "log").mockImplementation(() => {});
		await categorizePending(withKey, fakeJev(() => reply(0.95)).fetchImpl);
		expect(logs).toHaveBeenCalledTimes(1);
		expect(logs).toHaveBeenCalledWith("jev: asked 10, applied 10");
	});

	it("applies merchant rules before asking Jev", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db
			.prepare(
				"UPDATE merchants SET default_category_id = 1 WHERE raw_name = 'SQ *FARMERS MKT'",
			)
			.run();
		const jev = fakeJev(() => reply(0.5));
		await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(9);
		expect(await countWhere("category_source = 'merchant_rule'")).toBe(1);
	});

	it("skips its own rules pass when the sync just ran it", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await db
			.prepare(
				"UPDATE merchants SET default_category_id = 1 WHERE raw_name = 'SQ *FARMERS MKT'",
			)
			.run();
		const jev = fakeJev(() => reply(0.5));
		await categorizePending(withKey, jev.fetchImpl, { rulesApplied: true });
		expect(await countWhere("category_source = 'merchant_rule'")).toBe(0);
	});

	it("caps a run at 40 calls in the demo and 500 in production (decision 56)", () => {
		expect(jevCallLimit({ DEMO: "true" })).toBe(40);
		expect(jevCallLimit({})).toBe(40);
		expect(jevCallLimit({ DEMO: "false" })).toBe(500);
	});

	it("stops the demo's run at its cap", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		// Make 50 more transactions that need a category.
		for (let i = 0; i < 50; i++) {
			await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 100, ?)",
				)
				.bind(`${MONTH}-01`, `EXTRA ${i}`)
				.run();
		}
		const jev = fakeJev(() => reply(0.5));
		await categorizePending({ ...withKey, DEMO: "true" }, jev.fetchImpl);
		expect(jev.calls()).toBe(40);
	});

	it("goes past the demo's cap in production, so a new bank's backfill isn't held to 40 a day", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		for (let i = 0; i < 50; i++) {
			await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 100, ?)",
				)
				.bind(`${MONTH}-01`, `EXTRA ${i}`)
				.run();
		}
		const jev = fakeJev(() => reply(0.5));
		await categorizePending({ ...withKey, DEMO: "false" }, jev.fetchImpl);
		expect(jev.calls()).toBeGreaterThan(50);
		// Nothing is left for the next night.
		const again = fakeJev(() => reply(0.5));
		await categorizePending({ ...withKey, DEMO: "false" }, again.fetchImpl);
		expect(again.calls()).toBe(0);
	});

	it("stops one run at what an invocation's queries allow, and the day at 500, leaving the rest for the next run", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		// 510 more transactions that need a category, in one statement.
		await db
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 510)
				 INSERT INTO transactions (account_id, date, amount_cents, raw_name)
				 SELECT 1, ?, 100, 'EXTRA ' || i FROM n`,
			)
			.bind(`${MONTH}-01`)
			.run();
		const production = { ...withKey, DEMO: "false" };
		const jev = fakeJev(() => reply(0.5));
		await categorizePending(production, jev.fetchImpl);
		// One run asks about at most MAX_CALLS_PER_RUN (300): D1's 1,000 queries per invocation.
		expect(jev.calls()).toBe(MAX_CALLS_PER_RUN);
		expect(MAX_CALLS_PER_RUN).toBe(300);
		expect(await callsUsed()).toBe(300);
		// A second run the same day takes what's left of the day's 500, and then there is nothing more.
		const sameDay = fakeJev(() => reply(0.5));
		await categorizePending(production, sameDay.fetchImpl);
		expect(sameDay.calls()).toBe(200);
		const third = fakeJev(() => reply(0.5));
		await categorizePending(production, third.fetchImpl);
		expect(third.calls()).toBe(0);
		// The next household day starts at zero.
		await newDay();
		const next = fakeJev(() => reply(0.5));
		await categorizePending(production, next.fetchImpl);
		expect(next.calls()).toBeGreaterThan(0);
		// 800 Jev round trips take a few seconds on a busy CI runner.
	}, 60_000);

	it("keeps a night's queries under D1's 1,000 per invocation", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await saveAiSwitches(db, { details: true });
		await db
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400)
				 INSERT INTO transactions (account_id, date, amount_cents, raw_name)
				 SELECT 1, ?, 100, 'EXTRA ' || i FROM n`,
			)
			.bind(`${MONTH}-01`)
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
		await categorizePending(
			{ ...withKey, DB: counted as D1Database, DEMO: "false" },
			fakeJev(() => reply(0.95)).fetchImpl,
		);
		// Three queries per call, one batched details save and history read per run, and setup.
		expect(statements).toBeLessThanOrEqual(MAX_CALLS_PER_RUN * 3 + 17);
		expect(statements).toBeLessThan(1000 - 50);
	}, 60_000);

	describe("the day's cap, shared with the runs right after a sync (spec §8.6)", () => {
		/** 50 more transactions that need a category, so more are waiting than the demo's cap. */
		async function addExtras() {
			for (let i = 0; i < 50; i++) {
				await db
					.prepare(
						"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 100, ?)",
					)
					.bind(`${MONTH}-01`, `EXTRA ${i}`)
					.run();
			}
		}
		/** Counts n calls against today's cap, as earlier runs the same day would have. */
		async function spend(n: number, cap = 40) {
			await reserveJevCalls(db, await householdToday(db), cap, n);
		}
		const quiet = () => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			vi.spyOn(console, "error").mockImplementation(() => {});
		};

		it("asks only about what an earlier run left of the day's cap", async () => {
			quiet();
			await addExtras();
			await spend(35);
			const jev = fakeJev(() => reply(0.5));
			const result = await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(5);
			expect(result.asked).toBe(5);
			expect(await callsUsed()).toBe(40);
		});

		it("splits one day's cap between two runs, never past it", async () => {
			quiet();
			// A run right after a sync sorts the seed's 12 ...
			const first = fakeJev(() => reply(0.5));
			await categorizePending(withKey, first.fetchImpl, {
				rulesApplied: true,
			});
			expect(first.calls()).toBe(10);
			// ... then 50 more arrive, and the nightly run gets the 28 left of 40.
			await addExtras();
			const second = fakeJev(() => reply(0.5));
			await categorizePending(withKey, second.fetchImpl);
			expect(second.calls()).toBe(30);
			expect(await callsUsed()).toBe(40);
		});

		it("asks nothing once the day's cap is used, leaving the rest for the next day", async () => {
			quiet();
			await spend(40);
			const waiting = (await pendingForJev(db, 100)).length;
			expect(waiting).toBe(10);
			const jev = fakeJev(() => reply(0.95));
			const result = await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(0);
			expect(result).toEqual({ asked: 0, applied: 0 });
			expect(await pendingForJev(db, 100)).toHaveLength(waiting);
		});

		it("counts a call that failed, since it was asked", async () => {
			quiet();
			const jev = fakeJev(() => new Response("{}", { status: 503 }));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(1);
			expect(await callsUsed()).toBe(1);
		});

		it("doesn't count a transaction it didn't ask about", async () => {
			quiet();
			await saveAiSwitches(db, {
				...AI_SWITCHES_ALL_ON,
				details: false,
				categories: false,
				income: false,
			});
			const jev = fakeJev(() => reply(0.95));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(0);
			expect(await callsUsed()).toBe(0);
		});

		it("starts the next household day at zero", async () => {
			quiet();
			await spend(40);
			await newDay();
			const jev = fakeJev(() => reply(0.5));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);
		});

		it("never goes over the cap when runs go at the same moment", async () => {
			quiet();
			await addExtras();
			const runs = await Promise.all(
				[1, 2, 3].map(() => {
					const jev = fakeJev(() => reply(0.5));
					return categorizePending(withKey, jev.fetchImpl).then(() =>
						jev.calls(),
					);
				}),
			);
			expect(runs.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(40);
			expect(await callsUsed()).toBe(40);
		});
	});

	describe("the calls it reserves for the day (spec §8.6)", () => {
		const quiet = () => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			return vi.spyOn(console, "error").mockImplementation(() => {});
		};

		/** A DB that counts every statement a run prepares, for D1's 1,000 queries per invocation. */
		function countingDb() {
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
			return { db: counted as D1Database, statements: () => statements };
		}

		it("costs at most three queries a call, none of them for the cap", async () => {
			quiet();
			const ids = (await pendingForJev(db, 100)).map((t) => t.id);
			const few = countingDb();
			await categorizePending(
				{ ...withKey, DB: few.db },
				fakeJev(() => reply(0.95)).fetchImpl,
				{ rulesApplied: true, onlyIds: ids.slice(0, 6) },
			);
			// Another day, so the same cap and the same twelve waiting.
			await resetDemo(db, TODAY);
			await newDay();
			const many = countingDb();
			await categorizePending(
				{ ...withKey, DB: many.db },
				fakeJev(() => reply(0.95)).fetchImpl,
				{ rulesApplied: true, onlyIds: ids },
			);
			// Six calls cost three each, plus the run's one bulk details save and history read.
			expect(many.statements() - few.statements()).toBeLessThanOrEqual(20);
		});

		it("gives back what it reserved and didn't ask when the run stops early", async () => {
			quiet();
			const jev = fakeJev(() => new Response("{}", { status: 503 }));
			await categorizePending(withKey, jev.fetchImpl);
			// It reserved the twelve waiting, asked one, and the other eleven are free again.
			expect(jev.calls()).toBe(1);
			expect(await callsUsed()).toBe(1);
			const next = fakeJev(() => reply(0.95));
			await categorizePending(withKey, next.fetchImpl);
			expect(next.calls()).toBe(10);
			expect(await callsUsed()).toBe(11);
		});

		it("starts no new call once its deadline has passed, and gives back what it didn't ask", async () => {
			quiet();
			let now = 0;
			const jev = fakeJev(() => {
				now += 1_000;
				return reply(0.95);
			});
			// Calls start at 0, 1,000 and 2,000; the next would start at 3,000, past the deadline.
			expect(
				await categorizePending(withKey, jev.fetchImpl, {
					time: { deadline: 2_500, now: () => now },
				}),
			).toMatchObject({ asked: 3 });
			expect(jev.calls()).toBe(3);
			// It reserved the twelve waiting, and the other nine are free again.
			expect(await callsUsed()).toBe(3);
		});

		it("reserves and asks nothing when its deadline has passed before it starts", async () => {
			quiet();
			const jev = fakeJev(() => reply(0.95));
			expect(
				await categorizePending(withKey, jev.fetchImpl, {
					time: { deadline: 5_000, now: () => 5_000 },
				}),
			).toEqual({ asked: 0, applied: 0 });
			expect(jev.calls()).toBe(0);
			expect(await callsUsed()).toBe(0);
		});

		it("loses the unused part for the day, and still ends well, when giving it back fails", async () => {
			const errors = quiet();
			await db
				.prepare(
					`CREATE TRIGGER fail_give_back BEFORE UPDATE ON household_settings
					 WHEN OLD.key GLOB 'jev_calls_*' BEGIN SELECT RAISE(ABORT, 'nope'); END`,
				)
				.run();
			try {
				const jev = fakeJev(() => new Response("{}", { status: 503 }));
				await expect(
					categorizePending(withKey, jev.fetchImpl),
				).resolves.toEqual({ asked: 1, applied: 0 });
				// Lost, never over-spent: all twelve stay counted.
				expect(await callsUsed()).toBe(10);
				expect(JSON.stringify(errors.mock.calls)).not.toContain("nope");
			} finally {
				await db.prepare("DROP TRIGGER fail_give_back").run();
			}
		});

		describe("when the household's day changes under a run", () => {
			// Eastern, the demo's zone: 03:59:50 UTC is 23:59:50 the evening before.
			const BEFORE_MIDNIGHT = "2026-10-06T03:59:50Z";
			const AFTER_MIDNIGHT = "2026-10-06T04:00:05Z";

			it("stops before the next call, and charges nothing to the new day", async () => {
				quiet();
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.setSystemTime(new Date(BEFORE_MIDNIGHT));
				let calls = 0;
				const asked = async () => {
					calls += 1;
					// Midnight passes while the second call is on its way.
					if (calls === 2) vi.setSystemTime(new Date(AFTER_MIDNIGHT));
					return reply(0.95);
				};
				const result = await categorizePending(withKey, asked);
				// The second call was already made; the third is never sent.
				expect(calls).toBe(2);
				expect(result.asked).toBe(2);
				// The evening's day keeps its two; the new day has nothing charged to it.
				expect(await callsUsed("2026-10-05")).toBe(2);
				expect(await callsUsed("2026-10-06")).toBe(0);
			});

			it("leaves the rest for a run on the new day, which has the whole cap", async () => {
				quiet();
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.setSystemTime(new Date(BEFORE_MIDNIGHT));
				let calls = 0;
				await categorizePending(withKey, async () => {
					calls += 1;
					if (calls === 2) vi.setSystemTime(new Date(AFTER_MIDNIGHT));
					return reply(0.95);
				});
				const next = fakeJev(() => reply(0.95));
				await categorizePending(withKey, next.fetchImpl);
				expect(next.calls()).toBe(8);
				expect(await callsUsed("2026-10-06")).toBe(8);
			});

			it("takes the household's own zone, not the server's", async () => {
				quiet();
				vi.useFakeTimers({ toFake: ["Date"] });
				// Tokyo's date is already the 6th at 15:00 UTC on the 5th, and turns the 7th at 15:00 UTC the 6th.
				await db
					.prepare(
						"UPDATE household_settings SET value = 'Asia/Tokyo' WHERE key = 'time_zone'",
					)
					.run();
				vi.setSystemTime(new Date("2026-10-06T14:59:55Z"));
				let calls = 0;
				const result = await categorizePending(withKey, async () => {
					calls += 1;
					if (calls === 1) vi.setSystemTime(new Date("2026-10-06T15:00:05Z"));
					return reply(0.95);
				});
				expect(result.asked).toBe(1);
				expect(await callsUsed("2026-10-06")).toBe(1);
			});

			it("reads the household's zone once, not for every call", async () => {
				quiet();
				const zoneReads = countingDb();
				const spy = vi.spyOn(zoneReads.db, "prepare");
				await categorizePending(
					{ ...withKey, DB: zoneReads.db },
					fakeJev(() => reply(0.95)).fetchImpl,
				);
				const reads = spy.mock.calls.filter(([sql]) =>
					String(sql).includes("key = 'time_zone'"),
				);
				expect(reads).toHaveLength(1);
			});
		});
	});

	describe("asking only about the rows it's given", () => {
		const quiet = () => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			return vi.spyOn(console, "error").mockImplementation(() => {});
		};
		const waitingIds = async () =>
			(await pendingForJev(db, 100)).map((t) => t.id);

		it("asks about those and leaves older waiting ones for the night", async () => {
			quiet();
			const [a, b, c] = await waitingIds();
			const jev = fakeJev(() => reply(0.95));
			const result = await categorizePending(withKey, jev.fetchImpl, {
				rulesApplied: true,
				onlyIds: [a as number, b as number, c as number],
			});
			expect(jev.calls()).toBe(3);
			expect(result.asked).toBe(3);
			// The nine older ones are still waiting, and the night's run takes them.
			expect(await pendingForJev(db, 100)).toHaveLength(7);
			const night = fakeJev(() => reply(0.95));
			await categorizePending(withKey, night.fetchImpl);
			expect(night.calls()).toBe(7);
		});

		it("counts only the calls it makes against the day", async () => {
			quiet();
			const [a, b] = await waitingIds();
			await categorizePending(withKey, fakeJev(() => reply(0.95)).fetchImpl, {
				rulesApplied: true,
				onlyIds: [a as number, b as number],
			});
			expect(await callsUsed()).toBe(2);
		});

		it("asks about nothing for an empty list, and counts nothing", async () => {
			const jev = fakeJev(() => reply(0.95));
			await categorizePending(withKey, jev.fetchImpl, { onlyIds: [] });
			expect(jev.calls()).toBe(0);
			expect(await callsUsed()).toBe(0);
		});

		it("skips a listed row that was already looked at, or already has a category", async () => {
			quiet();
			const [a, b, c] = (await waitingIds()) as [number, number, number];
			await db.batch([
				db
					.prepare(
						"UPDATE transactions SET category_confidence = 0.4 WHERE id = ?",
					)
					.bind(a),
				db
					.prepare(
						"UPDATE transactions SET category_id = 1, category_source = 'user' WHERE id = ?",
					)
					.bind(b),
			]);
			const jev = fakeJev(() => reply(0.95));
			await categorizePending(withKey, jev.fetchImpl, {
				rulesApplied: true,
				onlyIds: [a, b, c],
			});
			expect(jev.calls()).toBe(1);
		});

		it("lets a merchant rule sort a listed row before Jev is asked", async () => {
			quiet();
			await db
				.prepare(
					"UPDATE merchants SET default_category_id = 1 WHERE raw_name = 'SQ *FARMERS MKT'",
				)
				.run();
			const ids = await waitingIds();
			const jev = fakeJev(() => reply(0.95));
			const result = await categorizePending(withKey, jev.fetchImpl, {
				onlyIds: ids,
			});
			expect(result.asked).toBe(9);
			expect(
				await db
					.prepare(
						"SELECT category_source FROM transactions WHERE raw_name = 'SQ *FARMERS MKT'",
					)
					.first(),
			).toEqual({ category_source: "merchant_rule" });
		});

		it("takes more rows than D1's 100 bound values in one statement", async () => {
			quiet();
			await db
				.prepare(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250)
					 INSERT INTO transactions (account_id, date, amount_cents, raw_name)
					 SELECT 1, '2026-09-01', 100, 'EXTRA ' || i FROM n`,
				)
				.run();
			const { results } = await db
				.prepare("SELECT id FROM transactions WHERE raw_name LIKE 'EXTRA %'")
				.all<{ id: number }>();
			const ids = results.map((r) => r.id);
			expect(ids).toHaveLength(250);
			const jev = fakeJev(() => reply(0.95));
			await categorizePending({ ...withKey, DEMO: "false" }, jev.fetchImpl, {
				rulesApplied: true,
				onlyIds: ids,
			});
			expect(jev.calls()).toBe(250);
			// The seed's twelve weren't listed, so they still wait.
			expect(await pendingForJev(db, 100)).toHaveLength(10);
		}, 30_000);
	});

	// A run right after a sync honors "Sort new transactions as they arrive" before each call (spec §8.6).
	describe("a run started by a sync", () => {
		const quiet = () => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			vi.spyOn(console, "error").mockImplementation(() => {});
		};
		const bySync = async () => ({
			rulesApplied: true,
			bySync: true,
			onlyIds: (await pendingForJev(db, 100)).map((t) => t.id),
		});
		/** A Jev that runs `during` as its nth answer is on its way back, then answers. */
		function jevWith(during: (call: number) => Promise<void>) {
			let calls = 0;
			return {
				calls: () => calls,
				fetchImpl: async () => {
					calls += 1;
					await during(calls);
					return reply(0.95);
				},
			};
		}

		it("asks nothing when the switch is off to begin with, and counts nothing", async () => {
			await switchTo({ sortOnArrival: false });
			const jev = fakeJev(() => reply(0.95));
			await categorizePending(withKey, jev.fetchImpl, await bySync());
			expect(jev.calls()).toBe(0);
			expect(await callsUsed()).toBe(0);
		});

		it("stops sending once the switch is turned off mid-run, keeping what it saved", async () => {
			quiet();
			const jev = jevWith(async (call) => {
				if (call === 2) await switchTo({ sortOnArrival: false });
			});
			const result = await categorizePending(
				withKey,
				jev.fetchImpl,
				await bySync(),
			);
			// The second call was on its way when it went off, so its answer is kept; no third goes out.
			expect(jev.calls()).toBe(2);
			expect(result).toEqual({ asked: 2, applied: 2 });
			expect(await needsCategoryCount(db, MONTH)).toBe(8);
			// And the ten it didn't ask about are free for the night.
			expect(await callsUsed()).toBe(2);
		});

		it("is not what stops the nightly run, which has no such switch", async () => {
			quiet();
			const jev = jevWith(async (call) => {
				if (call === 2) await switchTo({ sortOnArrival: false });
			});
			const result = await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);
			expect(result.asked).toBe(10);
		});

		it("still stops for the switches every run honors", async () => {
			quiet();
			const jev = jevWith(async (call) => {
				if (call === 1) await switchTo({ categories: false, income: false });
			});
			await categorizePending(withKey, jev.fetchImpl, await bySync());
			expect(jev.calls()).toBe(1);
		});
	});

	it("skips one transaction Jev can't answer usefully and carries on with the rest", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		// The first (newest) transaction always gets an answer that isn't one of the options.
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			if (calls === 1) {
				return new Response(
					JSON.stringify({
						answers: {
							category: {
								type: "choice",
								choice: "eating out",
								confidence: 0.9,
							},
							transfer: { type: "noul", noul: 0.01 },
							reimbursement: { type: "noul", noul: 0.01 },
							income: { type: "noul", noul: 0.01 },
						},
					}),
					{ status: 200, headers: { "x-typesafe-request-id": "req_bad" } },
				);
			}
			return reply(0.95);
		};

		const result = await categorizePending(withKey, fetchImpl);

		expect(calls).toBe(10);
		expect(result).toEqual({ asked: 10, applied: 9 });
		expect(await needsCategoryCount(db, MONTH)).toBe(1);
		expect(errors).toHaveBeenCalledWith("jev: 200 req_bad");
	});

	it.each([422, 400])(
		"skips a transaction Jev rejects with %i instead of stopping",
		async (status) => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			vi.spyOn(console, "log").mockImplementation(() => {});
			let calls = 0;
			const fetchImpl = async () => {
				calls += 1;
				return calls === 1 ? new Response("{}", { status }) : reply(0.95);
			};
			await categorizePending(withKey, fetchImpl);
			expect(calls).toBe(10);
		},
	);

	it.each([401, 403, 429, 500, 529])(
		"stops the whole run on %i, which would fail every call",
		async (status) => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			const jev = fakeJev(() => new Response("{}", { status }));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(1);
		},
	);

	it("doesn't ask Jev at all when there are no categories to offer", async () => {
		await db.prepare("UPDATE categories SET archived = 1").run();
		await saveAiSwitches(db, {
			categories: false,
			income: false,
			details: false,
		});
		const jev = fakeJev(() => reply(0.95));
		const result = await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(0);
		expect(result).toEqual({ asked: 0, applied: 0 });
		// Nothing was marked as looked at, so Jev asks once categories exist.
		expect(
			await countWhere(
				"category_confidence IS NOT NULL AND category_source IS NULL",
			),
		).toBe(0);
	});

	it("stops after three failures in a row, which point at every call, not one transaction", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const jev = fakeJev(() => new Response("{}", { status: 422 }));
		const result = await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(3);
		expect(result).toEqual({ asked: 3, applied: 0 });
	});

	it("resets the count after a good answer, so scattered bad rows are still skipped", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		let calls = 0;
		// Two failures, a success, two failures, then successes: never three in a row.
		const fetchImpl = async () => {
			calls += 1;
			return [1, 2, 4, 5].includes(calls)
				? new Response("{}", { status: 422 })
				: reply(0.95);
		};
		const result = await categorizePending(withKey, fetchImpl);
		expect(calls).toBe(10);
		expect(result.applied).toBe(6);
	});

	it("asks about transactions that failed before last, so they never block the rest", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		// The three newest pending transactions always get an unusable answer.
		const newest = (await pendingForJev(db, 3)).map((t) => t.id);
		const fetchImpl = async (_url: string, init?: RequestInit) => {
			const state = JSON.parse(String(init?.body)).state;
			const bad = await db
				.prepare("SELECT id FROM transactions WHERE raw_name = ?")
				.bind(state.bank_description)
				.first<{ id: number }>();
			return newest.includes(bad?.id ?? -1)
				? new Response("{}", { status: 422 })
				: reply(0.95);
		};

		// Night 1: the three bad ones come first, so the run stops after them.
		expect(await categorizePending(withKey, fetchImpl)).toEqual({
			asked: 3,
			applied: 0,
		});
		// Night 2: the other nine are asked first and applied; the three bad ones are last.
		expect(await categorizePending(withKey, fetchImpl)).toEqual({
			asked: 10,
			applied: 7,
		});
		expect(await needsCategoryCount(db, MONTH)).toBe(3);
	});

	it("doesn't mark a transaction as failed when Jev itself is down", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		await categorizePending(
			withKey,
			fakeJev(() => new Response("{}", { status: 503 })).fetchImpl,
		);
		expect(await countWhere("jev_failed_at IS NOT NULL")).toBe(0);
	});
});

// Spec §8.6: every run honors the household's AI switches, nightly and at sync alike. Off means
// Tally works from rules and people's choices alone, and nothing already decided changes.
describe("the AI switches", () => {
	const setSwitches = (over: Partial<typeof AI_SWITCHES_ALL_ON>) =>
		saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, details: false, ...over });

	/** A Jev reply with a flag's probability set, whatever the category. */
	const flagged = (flags: {
		transfer?: number;
		reimbursement?: number;
		income?: number;
	}) =>
		new Response(
			JSON.stringify({
				answers: {
					category: { type: "choice", choice: "Eating Out", confidence: 0.95 },
					transfer: { type: "noul", noul: flags.transfer ?? 0.01 },
					reimbursement: { type: "noul", noul: flags.reimbursement ?? 0.01 },
					income: { type: "noul", noul: flags.income ?? 0.01 },
				},
			}),
			{ status: 200 },
		);

	/** Only transaction 1 is left for Jev, as a credit nobody has decided about. */
	async function onlyOneCreditPending() {
		await db.batch([
			db.prepare(
				"UPDATE transactions SET amount_cents = -500, category_id = NULL, category_source = NULL, category_confidence = NULL, flag_income = 0, income_source = NULL, credit_reviewed = 0, credit_reviewed_by = NULL, excluded = 0, excluded_source = NULL WHERE id = 1",
			),
			db.prepare(
				"UPDATE transactions SET category_confidence = 0.5 WHERE id != 1",
			),
		]);
	}

	const snapshot = async () =>
		(
			await db
				.prepare(
					`SELECT id, category_id, category_source, category_confidence, jev_category_id, flag_transfer,
						flag_reimbursement, flag_income, income_source, credit_reviewed, excluded, excluded_source
					FROM transactions ORDER BY id`,
				)
				.all()
		).results;

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	it("never calls Jev with categories and income both off, however many transactions wait", async () => {
		await setSwitches({ categories: false, income: false });
		const before = await snapshot();
		const jev = fakeJev(() => reply(0.95));
		expect(await categorizePending(withKey, jev.fetchImpl)).toEqual({
			asked: 0,
			applied: 0,
		});
		expect(jev.calls()).toBe(0);
		expect(await snapshot()).toEqual(before);
	});

	it("still applies the household's merchant rules with every Jev switch off, since a rule is a person's choice", async () => {
		await setSwitches({ categories: false, income: false });
		await db
			.prepare(
				"UPDATE merchants SET default_category_id = 1 WHERE raw_name = 'SQ *FARMERS MKT'",
			)
			.run();
		const jev = fakeJev(() => reply(0.95));
		await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(0);
		expect(await countWhere("category_source = 'merchant_rule'")).toBe(1);
	});

	it("asks Jev nightly with names and sorting-as-they-arrive off, since neither gates the nightly run", async () => {
		await setSwitches({ names: false, sortOnArrival: false });
		const jev = fakeJev(() => reply(0.95));
		const result = await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(10);
		expect(result.applied).toBe(10);
	});

	describe("with categories and exclusions off, and income on", () => {
		beforeEach(() => setSwitches({ categories: false }));

		it("asks Jev for the income answer, but applies and keeps no category", async () => {
			const asked = (await pendingForJev(db, 40)).map((t) => t.id);
			const jev = fakeJev(() => reply(0.97));
			const result = await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);
			expect(result.applied).toBe(0);
			// Neither applied nor kept as a suggestion to show; only that it was asked is kept.
			const rows = await db
				.prepare(
					`SELECT category_id, category_source, jev_category_id, category_confidence
					FROM transactions WHERE id IN (${asked.join(",")})`,
				)
				.all();
			expect(rows.results).toHaveLength(10);
			for (const row of rows.results)
				expect(row).toEqual({
					category_id: null,
					category_source: null,
					jev_category_id: null,
					category_confidence: 0.97,
				});
			expect(await needsCategoryCount(db, MONTH)).toBe(10);
		});

		it("lets Jev's transfer and reimbursement flags exclude nothing", async () => {
			const excludedBefore = await countWhere("excluded = 1");
			const flagsBefore = await countWhere(
				"flag_transfer = 1 OR flag_reimbursement = 1",
			);
			const jev = fakeJev(() =>
				flagged({ transfer: 0.99, reimbursement: 0.99 }),
			);
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);
			expect(await countWhere("excluded = 1")).toBe(excludedBefore);
			expect(
				await countWhere("flag_transfer = 1 OR flag_reimbursement = 1"),
			).toBe(flagsBefore);
			expect(await countWhere("excluded_source = 'jev'")).toBe(0);
		});

		it("still stores Jev's income answer on a credit", async () => {
			await onlyOneCreditPending();
			const jev = fakeJev(() => flagged({ income: 0.99 }));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(1);
			expect(
				await db
					.prepare(
						"SELECT category_id, flag_income, income_source, credit_reviewed FROM transactions WHERE id = 1",
					)
					.first(),
			).toEqual({
				category_id: null,
				flag_income: 1,
				income_source: "jev",
				credit_reviewed: 1,
			});
		});

		it("still asks about an older credit whose review was never recorded (NULL), and stores its income answer", async () => {
			await onlyOneCreditPending();
			await db
				.prepare(
					"UPDATE transactions SET credit_reviewed = NULL, credit_reviewed_by = NULL, income_source = NULL WHERE id = 1",
				)
				.run();
			const jev = fakeJev(() => flagged({ income: 0.99 }));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(1);
			expect(
				await db
					.prepare(
						"SELECT flag_income, income_source FROM transactions WHERE id = 1",
					)
					.first(),
			).toEqual({ flag_income: 1, income_source: "jev" });
		});

		it("marks what it asked about as looked at, so the same ones aren't asked every night", async () => {
			const jev = fakeJev(() => reply(0.97));
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);
		});

		it("doesn't ask about a credit a person already reviewed, since only its category could be asked", async () => {
			await onlyOneCreditPending();
			await db
				.prepare(
					"UPDATE transactions SET income_source = 'user', credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = 1",
				)
				.run();
			const jev = fakeJev(() => reply(0.97));
			expect(await categorizePending(withKey, jev.fetchImpl)).toEqual({
				asked: 0,
				applied: 0,
			});
			expect(jev.calls()).toBe(0);
		});
	});

	describe("with income off, and categories on", () => {
		beforeEach(() => setSwitches({ income: false }));

		it("applies Jev's category but not its income answer", async () => {
			await onlyOneCreditPending();
			const jev = fakeJev(() => flagged({ income: 0.99 }));
			const result = await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(1);
			expect(result.applied).toBe(1);
			expect(
				await db
					.prepare(
						"SELECT category_id, category_source, flag_income, income_source FROM transactions WHERE id = 1",
					)
					.first(),
			).toEqual({
				category_id: 2,
				category_source: "jev",
				flag_income: 0,
				income_source: null,
			});
		});

		it("still lets its transfer flag exclude, which the categories switch owns", async () => {
			const jev = fakeJev(() => flagged({ transfer: 0.99 }));
			await categorizePending(withKey, jev.fetchImpl);
			expect(await countWhere("excluded_source = 'jev'")).toBeGreaterThan(0);
		});
	});

	it("changes nothing already decided when switches are turned off after a run", async () => {
		await categorizePending(withKey, fakeJev(() => reply(0.95)).fetchImpl);
		const decided = await snapshot();
		expect(await needsCategoryCount(db, MONTH)).toBe(0);
		await setSwitches({
			names: false,
			categories: false,
			income: false,
			sortOnArrival: false,
		});
		const jev = fakeJev(() => reply(0.5));
		await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(0);
		expect(await snapshot()).toEqual(decided);
	});

	it("is back on after the demo's nightly reset", async () => {
		await setSwitches({ categories: false, income: false });
		await resetDemo(db, TODAY);
		await saveAiSwitches(db, { details: false });
		const jev = fakeJev(() => reply(0.95));
		await categorizePending(withKey, jev.fetchImpl);
		expect(jev.calls()).toBe(10);
	});

	// Someone can save the switches while a run is going, so each transaction reads them again: before
	// it's sent, and before its answer is saved.
	describe("turned off while a run is going", () => {
		/** A Jev that runs `during` as its nth answer is on its way back, then answers. */
		function jevWith(
			during: (call: number) => Promise<void>,
			response: () => Response,
		) {
			let calls = 0;
			return {
				calls: () => calls,
				fetchImpl: async () => {
					calls += 1;
					await during(calls);
					return response();
				},
			};
		}

		it("stops sending once both Jev switches are off, and saves nothing from the answer on its way back", async () => {
			const before = await snapshot();
			const jev = jevWith(
				async (call) => {
					if (call === 1)
						await setSwitches({ categories: false, income: false });
				},
				() => reply(0.95),
			);
			const result = await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(1);
			expect(result.applied).toBe(0);
			expect(await snapshot()).toEqual(before);
			expect(await needsCategoryCount(db, MONTH)).toBe(10);
		});

		it("keeps what it saved before they went off, and sends nothing after", async () => {
			const jev = jevWith(
				async (call) => {
					if (call === 2)
						await setSwitches({ categories: false, income: false });
				},
				() => reply(0.95),
			);
			const result = await categorizePending(withKey, jev.fetchImpl);
			// The first answer was saved; the second arrived with the switches off, and no third went out.
			expect(jev.calls()).toBe(2);
			expect(result.applied).toBe(1);
			expect(await needsCategoryCount(db, MONTH)).toBe(9);
		});

		it("drops a category from the answer on its way back when categories went off, and carries on for income", async () => {
			const asked = (await pendingForJev(db, 40)).map((t) => t.id);
			const jev = jevWith(
				async (call) => {
					if (call === 2) await setSwitches({ categories: false });
				},
				() => reply(0.95),
			);
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(10);
			const rows = (
				await db
					.prepare(
						`SELECT category_id, jev_category_id FROM transactions WHERE id IN (${asked.join(",")}) ORDER BY id`,
					)
					.all()
			).results;
			// Only the first answer, which arrived while categories were on, was applied.
			expect(rows.filter((r) => r.category_id !== null)).toHaveLength(1);
			expect(rows.filter((r) => r.jev_category_id !== null)).toHaveLength(1);
		});

		it("doesn't use an income answer that arrives after income went off", async () => {
			await onlyOneCreditPending();
			const jev = jevWith(
				async () => {
					await setSwitches({ income: false });
				},
				() => flagged({ income: 0.99 }),
			);
			await categorizePending(withKey, jev.fetchImpl);
			expect(
				await db
					.prepare(
						"SELECT category_id, flag_income, income_source FROM transactions WHERE id = 1",
					)
					.first(),
			).toEqual({ category_id: 2, flag_income: 0, income_source: null });
		});

		it("skips a credit a person reviewed once categories are off, since only its category could be asked", async () => {
			await db.batch([
				db.prepare(
					"UPDATE transactions SET category_confidence = 0.5 WHERE id NOT IN (1, 2)",
				),
				db.prepare(
					"UPDATE transactions SET date = '2026-09-21', amount_cents = -500, category_id = NULL, category_source = NULL, category_confidence = NULL, flag_income = 0, income_source = NULL, credit_reviewed = 0, credit_reviewed_by = NULL, excluded = 0, excluded_source = NULL WHERE id = 1",
				),
				db.prepare(
					"UPDATE transactions SET date = '2026-09-20', amount_cents = -700, category_id = NULL, category_source = NULL, category_confidence = NULL, flag_income = 0, income_source = 'user', credit_reviewed = 1, credit_reviewed_by = 'user', excluded = 0, excluded_source = NULL WHERE id = 2",
				),
			]);
			expect((await pendingForJev(db, 40)).map((t) => t.id)).toEqual([1, 2]);
			const jev = jevWith(
				async (call) => {
					if (call === 1) await setSwitches({ categories: false });
				},
				() => reply(0.97),
			);
			await categorizePending(withKey, jev.fetchImpl);
			expect(jev.calls()).toBe(1);
		});
	});
});
