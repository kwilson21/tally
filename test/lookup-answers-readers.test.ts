import { env, exports } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { runWith } from "../src/db/database";
import { decideCategoryMaybe, maybeFacts } from "../src/db/suggestion-saves";
import { suggestionQueue } from "../src/db/suggestions-queue";
import {
	getTransaction,
	listRowsByIds,
	needsCategoryCount,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { acceptCategoryGuess } from "../src/rules/suggestions";
import { present } from "./helpers/present";
import {
	GROCERIES,
	K1,
	LINE,
	lineRow,
	TEXT,
	useLineFixture,
} from "./lookup-line-fixture";

// The store lookup's line-backed guess (spec §5, §7, §8.6; decision 225). A category guess Jev made with the line,
// and kept, is a Maybe at 40% or more with no upper end, for as long as the row still holds that guess
// (lookup_answers, migration 0078). Each reader must agree on it: the row's Maybe chip, the review card, the
// edit panel, and the lineGuess flag the edit panel reads. Nothing writes lookup_answers until part B, so these
// rows are inserted here.

const db = env.DB;
const BASE = "http://tally.test";
const TODAY = "2026-11-12";
const WHO = "person@example.com";
const RAW = "SQ *LUPITAS TAQ";

const categoryId = async (name: string) =>
	present(
		await db
			.prepare("SELECT id FROM categories WHERE name = ?")
			.bind(name)
			.first<{ id: number }>(),
	).id;

/** A line row: whether the line's guess was kept, and the category and confidence copies it holds. */
type Line = {
	kept: 0 | 1;
	category: "eating" | "groceries" | null;
	confidence: number | null;
};

/** One reader case: the row's facts, and what each reader should say about it. */
type Case = {
	n: string;
	note: string;
	confidence: number | null;
	line?: Line;
	/** The stored Jev category: Eating Out (the default) or none. */
	jev?: "eating" | "none";
	noneFit?: boolean;
	pending?: boolean;
	archiveEating?: boolean;
	/** The row is filed by a person to Groceries, or by Jev to Eating Out. */
	filed?: "groceries-user" | "eating-jev";
	lookupOff?: boolean;
	chip: boolean;
	card: boolean;
	lineGuess: boolean;
};

const k1 = (confidence: number): Line => ({
	kept: 1,
	category: "eating",
	confidence,
});

const cases: Case[] = [
	{
		n: "1",
		note: "floor moved",
		confidence: 0.39,
		chip: false,
		card: false,
		lineGuess: false,
	},
	{
		n: "2",
		note: "floor",
		confidence: 0.4,
		chip: true,
		card: true,
		lineGuess: false,
	},
	{
		n: "3",
		note: "inside the range",
		confidence: 0.79,
		chip: true,
		card: true,
		lineGuess: false,
	},
	{
		n: "4",
		note: "exception applied with no row",
		confidence: 0.8,
		chip: false,
		card: false,
		lineGuess: false,
	},
	{
		n: "5",
		note: "kept 0 read as kept",
		confidence: 0.95,
		line: { kept: 0, category: null, confidence: null },
		chip: false,
		card: false,
		lineGuess: false,
	},
	{
		n: "5b",
		note: "kept 0 with matching copies is not a guess",
		confidence: 0.95,
		line: { kept: 0, category: "eating", confidence: 0.95 },
		chip: false,
		card: false,
		lineGuess: false,
	},
	{
		n: "6",
		note: "floor dropped for line guesses",
		confidence: 0.39,
		line: k1(0.39),
		chip: false,
		card: false,
		lineGuess: true,
	},
	{
		n: "7",
		note: "the floor's sure side dropped (4000)",
		confidence: 0.4,
		line: k1(0.4),
		chip: true,
		card: true,
		lineGuess: true,
	},
	{
		n: "7b",
		note: ">= used where > belongs (basis 3999)",
		confidence: 0.3999,
		line: k1(0.3999),
		chip: false,
		card: false,
		lineGuess: true,
	},
	{
		n: "8",
		note: "inside the range, with a line",
		confidence: 0.79,
		line: k1(0.79),
		chip: true,
		card: true,
		lineGuess: true,
	},
	{
		n: "9",
		note: "exception missing (the edge)",
		confidence: 0.8,
		line: k1(0.8),
		chip: true,
		card: true,
		lineGuess: true,
	},
	{
		n: "10",
		note: "exception missing",
		confidence: 0.95,
		line: k1(0.95),
		chip: true,
		card: true,
		lineGuess: true,
	},
	{
		n: "11",
		note: "an upper end kept",
		confidence: 1,
		line: k1(1),
		chip: true,
		card: true,
		lineGuess: true,
	},
	{
		n: "12",
		note: "confidence match dropped",
		confidence: 0.95,
		line: { kept: 1, category: "eating", confidence: 0.95 - 0.05 },
		chip: false,
		card: false,
		lineGuess: false,
	},
	{
		n: "13",
		note: "category match dropped",
		confidence: 0.95,
		line: { kept: 1, category: "groceries", confidence: 0.95 },
		chip: false,
		card: false,
		lineGuess: false,
	},
	{
		n: "14",
		note: "archived check dropped",
		confidence: 0.95,
		line: k1(0.95),
		archiveEating: true,
		chip: false,
		card: false,
		lineGuess: true,
	},
	{
		n: "15",
		note: "a None fit read as a category",
		confidence: 0.95,
		line: { kept: 1, category: null, confidence: 0.95 },
		jev: "none",
		noneFit: true,
		chip: false,
		card: false,
		lineGuess: true,
	},
	{
		n: "16",
		note: "a filed row read as a Maybe",
		confidence: null,
		line: k1(0.95),
		filed: "groceries-user",
		chip: false,
		card: false,
		lineGuess: false,
	},
	{
		n: "17",
		note: "pending guard dropped from the card",
		confidence: 0.95,
		line: k1(0.95),
		pending: true,
		chip: true,
		card: false,
		lineGuess: true,
	},
	{
		n: "18",
		note: "hold made to depend on the switch",
		confidence: 0.95,
		line: k1(0.95),
		lookupOff: true,
		chip: true,
		card: true,
		lineGuess: true,
	},
	{
		n: "19",
		note: "a Jev-filed row read as line-backed (the not-filed guard dropped)",
		confidence: 0.95,
		line: k1(0.95),
		filed: "eating-jev",
		chip: false,
		card: false,
		lineGuess: false,
	},
];

/** Builds one purchase and its line row, as the case says, and returns the purchase's id. */
async function build(c: Case): Promise<number> {
	const eating = await categoryId("Eating Out");
	const groceries = await categoryId("Groceries");

	const id = present(
		await db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_confidence, jev_category_id, jev_none_fit, pending)
				VALUES ((SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', 2300, ?, ?, ?, ?, ?)
				RETURNING id`,
			)
			.bind(
				RAW,
				c.confidence,
				c.jev === "none" ? null : eating,
				c.noneFit ? 1 : 0,
				c.pending ? 1 : 0,
			)
			.first<{ id: number }>(),
	).id;

	if (c.filed === "groceries-user")
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(groceries, id)
			.run();

	if (c.filed === "eating-jev")
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'jev' WHERE id = ?",
			)
			.bind(eating, id)
			.run();

	if (c.archiveEating)
		await db
			.prepare("UPDATE categories SET archived = 1 WHERE id = ?")
			.bind(eating)
			.run();

	if (c.line)
		await db
			.prepare(
				`INSERT INTO lookup_answers (transaction_id, lookup_text, kept, kept_category_id, kept_confidence)
				VALUES (?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				RAW,
				c.line.kept,
				c.line.category === "eating"
					? eating
					: c.line.category === "groceries"
						? groceries
						: null,
				c.line.confidence,
			)
			.run();

	return id;
}

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
});

describe("the readers agree on a line-backed guess (row table, decision 225)", () => {
	it.each(cases)("row $n: $note", async (c) => {
		const id = await build(c);
		const eating = await categoryId("Eating Out");

		const switches = c.lookupOff
			? { ...AI_SWITCHES_ALL_ON, lookupStores: false }
			: AI_SWITCHES_ALL_ON;

		const [listed] = await listRowsByIds(db, [id]);
		const queue = await suggestionQueue(db, switches);
		const asked = await maybeFacts(db, "category", id, eating);
		const detail = await getTransaction(db, id);

		expect(listed?.maybeCategoryName ?? null).toBe(
			c.chip ? "Eating Out" : null,
		);
		expect(queue.some((i) => i.id === `category-${id}`)).toBe(c.card);
		expect(asked.asked).toBe(c.card);
		expect(detail?.lineGuess).toBe(c.lineGuess);
	});
});

describe("the edit panel's guess line (route GET /transactions/<id>)", () => {
	beforeEach(async () => {
		await saveAiSwitches(db, { details: false });
	});

	// The guess line itself ("Tally's guess · 80% sure"), not the dashed chip's label, which the grid also shows.
	const lineOf = (html: string) =>
		html.match(/Tally&#39;s guess · \d+% sure/)?.[0] ?? null;

	it.each([
		["4", null],
		["9", "Tally&#39;s guess · 80% sure"],
		["10", "Tally&#39;s guess · 95% sure"],
		["12", null],
	])("row %s shows the guess line %s", async (n, expected) => {
		const c = cases.find((x) => x.n === n);

		if (!c) throw new Error(`no case ${n}`);
		const id = await build(c);
		const res = await exports.default.fetch(`${BASE}/transactions/${id}`);

		expect(lineOf(await res.text())).toBe(expected);
	});
});

describe("BUG_FILE_LINE_BACKED: a kept guess at 95% is still a question", () => {
	it("is a card, counts as Needs category, lists as a Maybe with no category, and files on a Yes", async () => {
		const eating = await categoryId("Eating Out");
		const before = await needsCategoryCount(db, "all");

		const id = await build({
			n: "line",
			note: "",
			confidence: 0.95,
			line: k1(0.95),
			chip: true,
			card: true,
			lineGuess: true,
		});

		const queue = await suggestionQueue(db, AI_SWITCHES_ALL_ON);
		const [listed] = await listRowsByIds(db, [id]);

		expect(queue.some((i) => i.id === `category-${id}`)).toBe(true);
		expect(await needsCategoryCount(db, "all")).toBe(before + 1);
		expect(listed).toMatchObject({
			categoryId: null,
			maybeCategoryName: "Eating Out",
		});

		await runWith(
			db,
			decideCategoryMaybe(acceptCategoryGuess, {
				transactionId: id,
				categoryId: eating,
				today: TODAY,
				who: WHO,
			}).pipe(Effect.orDie),
		);

		expect(
			await db
				.prepare(
					"SELECT category_source AS source FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first<{ source: string }>(),
		).toEqual({ source: "user" });
	});
});

describe("the exception is for categories only", () => {
	it("a line-backed 95% row is not a transfer card, even with a transfer guess of 85%", async () => {
		const id = await build({
			n: "transfer",
			note: "",
			confidence: 0.95,
			line: k1(0.95),
			chip: true,
			card: true,
			lineGuess: true,
		});

		await db
			.prepare(
				"UPDATE transactions SET transfer_confidence = 0.85 WHERE id = ?",
			)
			.bind(id)
			.run();

		const queue = await suggestionQueue(db, AI_SWITCHES_ALL_ON);

		expect(
			queue.some(
				(i) =>
					i.kind === "transfer" &&
					"transactionId" in i &&
					i.transactionId === id,
			),
		).toBe(false);
	});

	it("a credit at 90% with a line row is not an income card", async () => {
		const id = await build({
			n: "credit",
			note: "",
			confidence: 0.95,
			line: k1(0.95),
			chip: true,
			card: true,
			lineGuess: true,
		});

		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -5000, income_confidence = 0.9 WHERE id = ?",
			)
			.bind(id)
			.run();

		const queue = await suggestionQueue(db, AI_SWITCHES_ALL_ON);

		expect(
			queue.some(
				(i) =>
					i.kind === "income" && "transactionId" in i && i.transactionId === id,
			),
		).toBe(false);
	});

	it("a 95% guess with no line row stays out of the queue", async () => {
		const id = await build({
			n: "no line",
			note: "",
			confidence: 0.95,
			chip: false,
			card: false,
			lineGuess: false,
		});

		const queue = await suggestionQueue(db, AI_SWITCHES_ALL_ON);

		expect(queue.some((i) => i.id === `category-${id}`)).toBe(false);
	});
});

describe("SQLite reads the 0.3999 edge in the same basis points as TypeScript", () => {
	it("CAST(0.3999 * 10000 AS INTEGER) is 3999", async () => {
		expect(
			await db
				.prepare("SELECT CAST(0.3999 * 10000 AS INTEGER) AS basis")
				.first<{ basis: number }>(),
		).toEqual({ basis: 3999 });
	});
});

describe("the line a person sees (#988, P146): the queue and the edit panel show the same line", () => {
	useLineFixture();

	/** The queue item's line: undefined when the row is asked with no line, null when the queue does not hold the row. */
	async function queueLine(id: number): Promise<string | undefined | null> {
		const item = (await suggestionQueue(db)).find(
			(i) => i.id === `category-${id}`,
		);

		if (!item) return null;

		return (item as { lookupLine?: string }).lookupLine;
	}

	/** The edit panel's line: null when the row shows none. */
	async function panelLine(id: number): Promise<string | null> {
		return (await getTransaction(db, id))?.lookupLine ?? null;
	}

	it("a kept line-backed guess shows its line on the card and in the panel", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });

		expect(await queueLine(id)).toBe(LINE);
		expect(await panelLine(id)).toBe(LINE);
	});

	it("hides the line while Look up new stores on the web is off", async () => {
		await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, lookupStores: false });
		const id = await lineRow({ key: K1, confidence: 0.5 });

		expect(await queueLine(id)).toBeUndefined();
		expect(await panelLine(id)).toBeNull();
	});

	it("hides the line while Income is off, which greys the lookup", async () => {
		await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, income: false });
		const id = await lineRow({ key: K1, confidence: 0.5 });

		expect(await queueLine(id)).toBeUndefined();
		expect(await panelLine(id)).toBeNull();
	});

	it.each([
		[
			"skipped",
			"UPDATE merchant_lookups SET status = 'skipped' WHERE lookup_text = ?",
		],
		[
			"nothing_found",
			"UPDATE merchant_lookups SET status = 'nothing_found' WHERE lookup_text = ?",
		],
		["an empty line", "UPDATE merchant_lookups SET line = '' WHERE lookup_text = ?"],
	])("hides the line when the lookup is %s", async (_, sql) => {
		const id = await lineRow({ key: K1, confidence: 0.5 });
		await db.prepare(sql).bind(TEXT).run();

		expect(await queueLine(id)).toBeUndefined();
		expect(await panelLine(id)).toBeNull();
	});

	it("hides the line when a key of the text is private", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });
		await db
			.prepare("UPDATE merchant_lookup_texts SET private = 1 WHERE lookup_text = ?")
			.bind(TEXT)
			.run();

		expect(await queueLine(id)).toBeUndefined();
		expect(await panelLine(id)).toBeNull();
	});

	it("hides the line when the lookup answer was not kept", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });
		await db
			.prepare("UPDATE lookup_answers SET kept = 0 WHERE transaction_id = ?")
			.bind(id)
			.run();

		expect(await queueLine(id)).toBeUndefined();
		expect(await panelLine(id)).toBeNull();
	});

	it("hides the line when the guess is a stale copy", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5, line: "stale" });

		expect(await queueLine(id)).toBeUndefined();
		expect(await panelLine(id)).toBeNull();
	});

	it("leaves a row a person filed out of the queue, with no line", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(GROCERIES, id)
			.run();

		expect(await queueLine(id)).toBeNull();
		expect(await panelLine(id)).toBeNull();
	});

	it("hides the line when the row has no lookup answer", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });
		await db
			.prepare("DELETE FROM lookup_answers WHERE transaction_id = ?")
			.bind(id)
			.run();

		expect(await queueLine(id)).toBeUndefined();
		expect(await panelLine(id)).toBeNull();
	});

	it("reads the line in the queue's own statement: the same number of statements with five line rows as with one", async () => {
		await lineRow({ key: K1, confidence: 0.5 });

		const spy = vi.spyOn(db, "prepare");
		await suggestionQueue(db);
		const withOne = spy.mock.calls.length;

		spy.mockClear();
		for (let n = 0; n < 4; n++) await lineRow({ key: `${K1} ${n}` });
		spy.mockClear();
		await suggestionQueue(db);
		const withFive = spy.mock.calls.length;
		spy.mockRestore();

		expect(withOne).toBeGreaterThan(0);
		expect(withFive).toBe(withOne);
	});
});
