import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import type { Decision } from "../src/ai/decide";
import { merchantKeySql } from "../src/db/merchant-key";
import { runWith } from "../src/db/database";
import {
	dropLineStatements,
	KEPT_OFF,
	LINE_GUESS_CLEAR,
} from "../src/db/store-lookups";
import { decideCategoryMaybe } from "../src/db/suggestion-saves";
import { lineGuessSql } from "../src/db/suggestions-queue";
import { listRowsByIds, saveEdit, saveJevResult } from "../src/db/transactions";
import { fillLookupTexts } from "../src/lookup/texts";
import { acceptCategoryGuess } from "../src/rules/suggestions";
import { saveCash } from "../src/transactions/cash";
import { present } from "./helpers/present";
import {
	asksAgain,
	db,
	edit,
	EATING,
	expectCleared,
	GROCERIES,
	inQueue,
	insertTx,
	K1,
	K2,
	K3,
	lineGuessOf,
	lineRow,
	OTHER,
	rowOf,
	setCategory,
	TODAY,
	useLineFixture,
	WHO,
} from "./lookup-line-fixture";

// Spec §7 "One answer corrects the whole store": what a filing clears, what it leaves alone, and which answers still count.
// A filing is a card Yes unless the test says otherwise.

/** Whitespace collapsed to one space, so SQL text compares whatever its layout (the trigger's text and the code's tabs). */
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** A card Yes on a row: the person accepts the line-backed guess (Eating Out). */
const yes = (id: number) =>
	runWith(
		db,
		decideCategoryMaybe(acceptCategoryGuess, {
			transactionId: id,
			categoryId: EATING,
			today: TODAY,
			who: WHO,
		}).pipe(Effect.orDie),
	);

describe("a filing leaves the rows it should not touch", () => {
	useLineFixture();

	// 2. Rows left untouched, one case each.
	it.each([
		[
			"2a another store: a standing row under OTHER keeps its row and kept 1 (mutation: the text condition dropped)",
			async () => {
				const a = await lineRow({ key: K1 });
				const o = await lineRow({ key: OTHER });
				const before = await rowOf(o);

				await yes(a);

				expect(await rowOf(o)).toEqual(before);
			},
		],
		[
			"2b a jev filing: a waiting K1 row filed by Jev at 0.95 leaves S with its row and kept 1 (mutation: no WHEN, or jev in it)",
			async () => {
				const s = await lineRow({ key: K2 });
				const before = await rowOf(s);
				const waiting = await insertTx({ raw_name: K1, merchant_name: K1 });
				const decision = {
					categoryId: EATING,
					suggestedCategoryId: EATING,
					confidence: 0.95,
					flags: { transfer: false, reimbursement: false, income: false },
				} as Decision;

				expect(await saveJevResult(db, waiting, decision)).toBe(true);
				expect(await rowOf(s)).toEqual(before);
			},
		],
		[
			"2c a bill filing: a K1 row linked to a bill with a category is filed as bill, and S keeps its row (mutation: the same)",
			async () => {
				const s = await lineRow({ key: K2 });
				const before = await rowOf(s);
				const waiting = await insertTx({ raw_name: K1, merchant_name: K1 });
				const bill = present(
					await db
						.prepare(
							"INSERT INTO bills (name, amount_cents, due_day, frequency, category_id, merchant_raw_name) VALUES ('Taqueria card', 1200, 5, 'monthly', ?, ?) RETURNING id",
						)
						.bind(GROCERIES, K1)
						.first<{ id: number }>(),
				).id;

				await db
					.prepare(
						"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026-11', ?, 'user', 'linked')",
					)
					.bind(bill, waiting)
					.run();

				expect((await rowOf(waiting)).tx).toMatchObject({ category_source: "bill" });
				expect(await rowOf(s)).toEqual(before);
			},
		],
		[
			"2d a filed sibling: F under K2, filed by Jev at 0.95, keeps its row, its kept goes to 0 (departure 1; mutation: the filed guard bypassed in the clear)",
			async () => {
				const a = await lineRow({ key: K1 });
				const f = await lineRow({ key: K2, confidence: 0.95, filed: "jev" });
				const before = await rowOf(f);

				await yes(a);

				const after = await rowOf(f);

				expect(after.tx).toEqual(before.tx);
				expect(after.answer?.kept).toBe(0);
			},
		],
		[
			"2e a stale sibling: T under K2, whose copies are older than its guess, keeps its row and its kept goes to 0 (mutation: the clear keyed on kept alone)",
			async () => {
				const a = await lineRow({ key: K1 });
				const t = await lineRow({ key: K2, line: "stale" });
				const before = await rowOf(t);

				await yes(a);

				const after = await rowOf(t);

				expect(after.tx).toEqual(before.tx);
				expect(after.answer?.kept).toBe(0);
			},
		],
		[
			"2f the answering row: A's lookup answer is unchanged, kept 1 and both copies (mutation: transaction_id != NEW.id dropped from the kept statement)",
			async () => {
				const a = await lineRow({ key: K1 });
				const before = await rowOf(a);

				await yes(a);

				expect((await rowOf(a)).answer).toEqual(before.answer);
			},
		],
		[
			"2g a given-up sibling: G under K2 at jev_attempts 5 is cleared and its kept goes to 0, but is not asked again (mutation: the clear resets jev_attempts)",
			async () => {
				const a = await lineRow({ key: K1 });
				const g = await lineRow({ key: K2, attempts: 5 });

				await yes(a);

				await expectCleared(g);
				expect((await rowOf(g)).tx).toMatchObject({ jev_attempts: 5 });
				expect(await asksAgain(g)).toBe(false);
			},
		],
	])("%s", async (_label, run) => {
		await run();
	});
});

describe("the answer that stands, and the answers that come back", () => {
	useLineFixture();

	// 3. #1032: an Undo of the answer brings the line-backed Maybe back, and the siblings stay cleared.
	it("3. #1032: an Undo of a card Yes restores A's line-backed Maybe (chip, card, with_line 1), and S stays cleared with kept 0 (mutation: the answering row's own kept touched)", async () => {
		const a = await lineRow({ key: K1 });
		const s = await lineRow({ key: K2 });

		await yes(a);

		// #70's Undo puts the row's fields back: no category or source, and the guess confidence it had.
		await db
			.prepare(
				"UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = 0.9 WHERE id = ?",
			)
			.bind(a)
			.run();

		expect(await lineGuessOf(a)).toBe(true);
		expect(present((await listRowsByIds(db, [a]))[0]).maybeCategoryName).toBe(
			"Eating Out",
		);
		expect(await inQueue(a)).toBe(true);
		expect(
			await db
				.prepare("SELECT with_line FROM maybe_answers ORDER BY id DESC LIMIT 1")
				.first<{ with_line: number }>(),
		).toMatchObject({ with_line: 1 });

		await expectCleared(s);
	});

	// 4. Rule 13 through a later Undo: a filing of A2 puts A1's kept to 0, so A1's restored guess is an ordinary Maybe.
	it("4. rule 13 through a later Undo: a filing of A2 sets A1's kept to 0, so A1's Undone guess is an ordinary Maybe (mutation: kept = 0 applied only to standing siblings)", async () => {
		const a1 = await lineRow({ key: K1, confidence: 0.6 });
		const a2 = await lineRow({ key: K1, confidence: 0.6 });
		const s = await lineRow({ key: K2, confidence: 0.6 });

		await yes(a1);
		await expectCleared(s);

		await saveEdit(db, a2, edit({ categoryId: GROCERIES }), WHO);

		await db
			.prepare(
				"UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = 0.6 WHERE id = ?",
			)
			.bind(a1)
			.run();

		expect(await lineGuessOf(a1)).toBe(false);
	});

	// 5. Rule 13 through the re-check's restore: S is cleared as the re-check clears it, then put back as its restore does.
	it("5. rule 13 through the re-check's restore: S cleared by the re-check, a Yes on A, S's marks put back: an ordinary Maybe (mutation: as test 4)", async () => {
		const a = await lineRow({ key: K1, confidence: 0.6 });
		const s = await lineRow({ key: K2, confidence: 0.6 });

		// reaskClearStatement's SET (resort-run.ts:525).
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = NULL, jev_mixed = NULL, jev_also_category_id = NULL WHERE id = ?",
			)
			.bind(s)
			.run();

		await yes(a);

		// reaskRestoreStatement puts the three marks back as the clear found them.
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = 0.6, jev_mixed = 0.6, jev_also_category_id = ? WHERE id = ?",
			)
			.bind(GROCERIES, s)
			.run();

		expect(await lineGuessOf(s)).toBe(false);
	});

	// 6. One statement files two line-backed rows of one store: each is "other" to the other, so both end with kept 0 (P2).
	it("6. one statement files two line-backed rows of one store: both filed, both kept 0, S cleared (P2)", async () => {
		const a1 = await lineRow({ key: K1 });
		const a2 = await lineRow({ key: K1 });
		const s = await lineRow({ key: K2 });

		await setCategory([a1, a2], GROCERIES);

		expect((await rowOf(a1)).tx).toMatchObject({
			category_id: GROCERIES,
			category_source: "user",
		});
		expect((await rowOf(a2)).tx).toMatchObject({
			category_id: GROCERIES,
			category_source: "user",
		});
		expect((await rowOf(a1)).answer?.kept).toBe(0);
		expect((await rowOf(a2)).answer?.kept).toBe(0);

		await expectCleared(s);
	});

	// 7. A key with no merchant_lookup_texts row clears nothing (P1), and the next fill does not change that.
	it("7. a cash entry under a key with no lookup text row clears nothing, and the next fill does not either (P1)", async () => {
		const s = await lineRow({ key: K2 });
		const before = await rowOf(s);

		await saveCash(
			db,
			{ date: TODAY, amountCents: 1200, merchant: K3, categoryId: GROCERIES, note: null },
			WHO,
		);

		expect(await rowOf(s)).toEqual(before);

		await fillLookupTexts(db);

		expect(await rowOf(s)).toEqual(before);
	});

	// 8. meta.changes: a filing reports its own row, the clear and the kept writes; a repeat and a store with no answers report 1.
	it("8. meta.changes: a filing reports 4 (A, S's clear, S's kept, T's kept); a repeat reports 1; a store with no answers reports 1 (mutations: see the brief)", async () => {
		const a = await lineRow({ key: K1 });
		await lineRow({ key: K2 });
		await lineRow({ key: K2, line: "stale" });
		await lineRow({ key: K2, line: "k0" });
		await lineRow({ key: OTHER });

		const file = `UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL WHERE id = ?`;

		const first = await db.prepare(file).bind(GROCERIES, a).run();

		expect(first.meta.changes).toBe(4);

		const again = await db.prepare(file).bind(GROCERIES, a).run();

		expect(again.meta.changes).toBe(1);

		const lone = await insertTx({
			raw_name: "NO ANSWERS STORE",
			merchant_name: "NO ANSWERS STORE",
		});

		const loneRun = await db.prepare(file).bind(GROCERIES, lone).run();

		expect(loneRun.meta.changes).toBe(1);
	});

	// 9. Drift: the migration's trigger text carries the TypeScript clear, the guess, the key and the kept statement, in order.
	it("9. drift: each trigger's SQL carries the TypeScript clear, the guess, the key and the kept statement, the clear first; its OF list is category_id, category_source; no OF trigger lists a cleared column; dropLineStatements is in the same order", async () => {
		const triggers = await db
			.prepare(
				"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('lookup_line_clear_update', 'lookup_line_clear_insert')",
			)
			.all<{ name: string; sql: string }>();

		expect(triggers.results.map((row) => row.name).sort()).toEqual([
			"lookup_line_clear_insert",
			"lookup_line_clear_update",
		]);

		const clear = normalize(`UPDATE transactions SET ${LINE_GUESS_CLEAR}`);
		const guess = normalize(lineGuessSql("transactions"));
		const kept = normalize(KEPT_OFF);
		const key = normalize(merchantKeySql("NEW"));
		const when = normalize(
			"NEW.category_source IN ('user', 'merchant_rule') AND NEW.category_id IS NOT NULL",
		);

		for (const row of triggers.results) {
			const sql = normalize(row.sql);

			expect(sql).toContain(clear);
			expect(sql).toContain(guess);
			expect(sql).toContain(key);
			expect(sql).toContain(kept);
			expect(sql).toContain(when);
			expect(sql.indexOf(clear)).toBeLessThan(sql.indexOf(kept));
		}

		const update = triggers.results.find(
			(row) => row.name === "lookup_line_clear_update",
		);
		const listed = normalize(update?.sql ?? "").match(
			/AFTER UPDATE OF (.+?) ON transactions/,
		)?.[1];

		expect(listed).toBe("category_id, category_source");

		// No UPDATE OF trigger on transactions lists a column the clear writes: a future one would fire on the clear.
		const others = await db
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%AFTER UPDATE OF%'",
			)
			.all<{ sql: string }>();
		const cleared = [
			"category_confidence",
			"jev_category_id",
			"jev_mixed",
			"jev_also_category_id",
			"jev_none_fit",
		];

		for (const row of others.results) {
			const columns =
				normalize(row.sql).match(/AFTER UPDATE OF (.+?) ON transactions/)?.[1] ??
				"";

			for (const column of cleared) {
				expect(columns.split(", ")).not.toContain(column);
			}
		}

		// dropLineStatements' SQL, captured through a fake prepare: the clear, then the guess, then the kept statement.
		const captured: string[] = [];
		const fake = {
			prepare(sql: string) {
				captured.push(sql);

				const statement = { bind: () => statement };

				return statement;
			},
		} as unknown as D1Database;

		dropLineStatements(fake, ["x"]);

		const sqls = captured.map(normalize);

		expect(sqls[0]).toContain(clear);
		expect(sqls[0]).toContain(guess);
		expect(sqls[1]).toContain(kept);
		expect(sqls[0]?.indexOf(clear)).toBeLessThan(sqls[1]?.indexOf(kept) ?? 0);
	});
});

describe("control", () => {
	useLineFixture();

	// A positive control for the fixture: a standing row whose line is cleared by hand is asked again and reads no line.
	it("control: a standing row with its five clear columns and kept set by hand is asked again and reads no line", async () => {
		const s = await lineRow({ key: K2 });

		await db
			.prepare(
				"UPDATE transactions SET category_confidence = NULL, jev_category_id = NULL, jev_mixed = NULL, jev_also_category_id = NULL, jev_none_fit = 0 WHERE id = ?",
			)
			.bind(s)
			.run();
		await db
			.prepare("UPDATE lookup_answers SET kept = 0 WHERE transaction_id = ?")
			.bind(s)
			.run();

		expect(await asksAgain(s)).toBe(true);
		expect(await lineGuessOf(s)).toBe(false);
	});
});
