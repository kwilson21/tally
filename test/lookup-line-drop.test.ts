import { describe, expect, it } from "vitest";
import { dropLineStatements } from "../src/db/store-lookups";
import { claimNext, type LookupEnv } from "../src/lookup/run";
import { asksAgain, expectCleared } from "./lookup-line-fixture";
import {
	addRow,
	dayCount,
	db,
	eligibleStore,
	fakeAi,
	fakeSearch,
	gateEnv,
	lookupRow,
	lookupRunSetup,
	makePrivate,
	runInstance,
	setDayCount,
	storeName,
	textOf,
	violations,
} from "./lookup-run-setup";

// The line drop (#1040, rule 7, spec §7 "The states"): a found store that becomes private loses its line, and its open
// line-backed guesses are cleared in the same batch. dropLineStatements is the statement pair the privacy skip and
// "Don't use this" share. These tests run the real claim (claimNext) through the lookup's own harness.

/** The first unarchived category: the one a line-backed guess names as its Eating Out (the lookup-run harness's food). */
async function foodId(): Promise<number> {
	const row = await db
		.prepare("SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1")
		.first<{ id: number }>();

	return Number(row?.id);
}

/**
 * A row under `name` that holds a line-backed guess (a Maybe at `confidence`), and its lookup answer under the store's text.
 * "stale" copies a lower confidence than the row holds, so the guess does not match its copies (the row keeps its kept).
 */
async function standingRow(
	name: string,
	{
		confidence = 0.9,
		line = "k1",
	}: { confidence?: number; line?: "k1" | "stale" } = {},
): Promise<number> {
	const food = await foodId();

	const id = await addRow({
		raw_name: name,
		merchant_name: name,
		jev_category_id: food,
		jev_mixed: 0.6,
		category_confidence: confidence,
	});

	const copy =
		line === "stale" ? Math.round((confidence - 0.05) * 100) / 100 : confidence;

	await db
		.prepare(
			"INSERT INTO lookup_answers (transaction_id, lookup_text, kept, kept_category_id, kept_confidence) VALUES (?, ?, 1, ?, ?)",
		)
		.bind(id, textOf(name), food, copy)
		.run();

	return id;
}

/** The lookup answer of a row, as stored, or null. */
async function answerOf(id: number) {
	return db
		.prepare(
			"SELECT transaction_id, lookup_text, kept, kept_category_id, kept_confidence FROM lookup_answers WHERE transaction_id = ?",
		)
		.bind(id)
		.first<{
			transaction_id: number;
			lookup_text: string;
			kept: number;
			kept_category_id: number | null;
			kept_confidence: number | null;
		}>();
}

/** A row as stored, for "left untouched" checks. */
async function txOf(id: number) {
	return db
		.prepare("SELECT * FROM transactions WHERE id = ?")
		.bind(id)
		.first<Record<string, string | number | null>>();
}

describe("dropLineStatements", () => {
	lookupRunSetup();

	// 11. Texts T and O are dropped; X is not. The statements, the chunks and the counts are as the brief states them.
	it("11. dropLineStatements: T's standing row is cleared; T's stale and person-filed rows keep their rows, kept 0; O's standing row is cleared; X is unchanged; 1001 texts give 6 statements, clear then kept; duplicates collapse; [] gives []", async () => {
		const food = await foodId();
		// The person-filed row comes first: its own write fires the trigger, which must not see the line rows below.

		const t3 = await addRow({
			raw_name: storeName(0),
			merchant_name: storeName(0),
			category_id: food,
			category_source: "user",
		});

		await db
			.prepare(
				"INSERT INTO lookup_answers (transaction_id, lookup_text, kept, kept_category_id, kept_confidence) VALUES (?, ?, 1, ?, 0.9)",
			)
			.bind(t3, textOf(storeName(0)), food)
			.run();
		const t1 = await standingRow(storeName(0));
		const t2 = await standingRow(storeName(0), { line: "stale" });
		const o1 = await standingRow(storeName(1));
		const x1 = await standingRow(storeName(2));
		const t2Before = await txOf(t2);
		const x1Before = await txOf(x1);

		const statements = dropLineStatements(db, [
			textOf(storeName(0)),
			textOf(storeName(1)),
		]);

		const results = await db.batch(statements);

		expect(statements).toHaveLength(2);
		await expectCleared(t1);
		expect((await answerOf(t2))?.kept).toBe(0);
		expect(await txOf(t2)).toEqual(t2Before);
		expect((await answerOf(t3))?.kept).toBe(0);
		expect((await txOf(t3))?.category_id).toBe(food);
		await expectCleared(o1);
		expect((await answerOf(x1))?.kept).toBe(1);
		expect(await txOf(x1)).toEqual(x1Before);

		// The kept statement reports the rows that had kept 1 (t1, t2, t3 and o1).
		expect(results[1]?.meta.changes).toBe(4);

		expect(
			dropLineStatements(
				db,
				Array.from({ length: 1001 }, (_, i) => `text ${i}`),
			),
		).toHaveLength(6);
		expect(
			dropLineStatements(db, [textOf(storeName(0)), textOf(storeName(0))]),
		).toHaveLength(2);
		// 501 copies of one text are one text: without the dedupe, 501 entries make two chunks, four statements.
		expect(
			dropLineStatements(
				db,
				Array.from({ length: 501 }, () => textOf(storeName(0))),
			),
		).toHaveLength(2);
		expect(dropLineStatements(db, [])).toEqual([]);
	});
});

describe("rule 7 and #1040, through the run", () => {
	lookupRunSetup();

	// 12. A found store that becomes private through a flag loses its line in the run's privacy skip, and its open guesses too.
	it("12. a found store flagged private: its line is dropped, its standing row is cleared with kept 0 and asked again, its stale row keeps its row with kept 0, another store is unchanged, and no fetch is made (mutation: the drop not appended)", async () => {
		await eligibleStore(storeName(0));
		await eligibleStore(storeName(1));

		await runInstance({
			search: fakeSearch([textOf(storeName(0)), textOf(storeName(1))]),
			ai: fakeAi([textOf(storeName(0)), textOf(storeName(1))]).ai,
			runId: "run-1",
		});

		const s1 = await standingRow(storeName(0));
		const s2 = await standingRow(storeName(0), { line: "stale" });
		await addRow({ raw_name: storeName(0), flag_transfer: 1 });
		const other = await standingRow(storeName(1));
		const otherBefore = await txOf(other);
		const s2Before = await txOf(s2);

		const search = fakeSearch([]);

		await runInstance({ search, ai: fakeAi([]).ai, runId: "run-2" });

		expect(search.queries).toEqual([]);
		expect(await lookupRow(textOf(storeName(0)))).toMatchObject({
			status: "skipped",
			line: null,
		});
		await expectCleared(s1);
		expect(await asksAgain(s1)).toBe(true);
		expect(await txOf(s2)).toEqual(s2Before);
		expect((await answerOf(s2))?.kept).toBe(0);
		expect(await txOf(other)).toEqual(otherBefore);
		expect((await answerOf(other))?.kept).toBe(1);
		expect(violations).toEqual([]);
	});
});

describe("the claim's result index, with the drops in the batch", () => {
	lookupRunSetup();

	// 13. The claim is read at the right index when the privacy skip drops a store with no answers (claimIndex a).
	it("13. claimIndex (a): a found private store with no answers is skipped, and the claim for an eligible store still lands (mutation: the index computed before the drops reads the kept statement and returns null)", async () => {
		await eligibleStore(storeName(0));
		await runInstance({
			search: fakeSearch([textOf(storeName(0))]),
			ai: fakeAi([textOf(storeName(0))]).ai,
			runId: "run-1",
		});
		await makePrivate(storeName(0));

		await eligibleStore(storeName(1));

		// Run 1's search for P took one of the day's counts, so the claim for E is counted on top of it.
		const countBefore = await dayCount();
		const ai = fakeAi([]);

		// SAFETY: gateEnv gives the database, the gate's cap and the AI binding, the only keys a claim reads.
		const claim = await claimNext(gateEnv(ai.ai) as LookupEnv, {
			token: "claim-13",
			bySync: false,
		});

		expect(claim?.text).toBe(textOf(storeName(1)));
		expect(await dayCount()).toBe(countBefore + 1);
	});

	// 14. The claim is read at the right index when the privacy skip drops a store with a standing row (claimIndex b).
	it("14. claimIndex (b): a found private store with a standing row is skipped, its row cleared with kept 0, and no claim lands at the day's cap (mutation: the index computed before the drops reads the kept statement and returns the eligible claim)", async () => {
		await eligibleStore(storeName(0));
		await runInstance({
			search: fakeSearch([textOf(storeName(0))]),
			ai: fakeAi([textOf(storeName(0))]).ai,
			runId: "run-1",
		});
		await makePrivate(storeName(0));

		const s = await standingRow(storeName(0));

		await eligibleStore(storeName(1));
		await setDayCount(300);

		const ai = fakeAi([]);

		// SAFETY: gateEnv gives the database, the gate's cap and the AI binding, the only keys a claim reads.
		const claim = await claimNext(gateEnv(ai.ai) as LookupEnv, {
			token: "claim-14",
			bySync: false,
		});

		expect(claim).toBeNull();
		expect(await lookupRow(textOf(storeName(0)))).toMatchObject({
			status: "skipped",
		});
		await expectCleared(s);
		expect((await answerOf(s))?.kept).toBe(0);
	});
});
