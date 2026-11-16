import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { cleanBankText } from "../src/clean-bank-text";
import { changeBankTextRule } from "../src/db/bank-text-rules";
import { runWith } from "../src/db/database";
import { newCategoryTarget } from "../src/db/new-category-answer";
import { decideCategoryMaybe, fileInNewCategory } from "../src/db/suggestion-saves";
import { saveSuggestion, createFromSuggestion } from "../src/db/category-suggestions";
import { addLikely } from "../src/db/likely-transactions";
import { addMoreLikeThis } from "../src/db/more-like-this";
import { applyMerchantRules, saveEdit, saveSplit, setMerchantRule } from "../src/db/transactions";
import { mergePendingIntoPosted } from "../src/plaid/pending-merge";
import { acceptCategoryGuess, chooseCategory } from "../src/rules/suggestions";
import { saveCash } from "../src/transactions/cash";
import { holdCashDelete, restoreCashDelete } from "../src/transactions/cash-undo";
import { setOrganizeRule } from "../src/transactions/organize";
import { fileOrganizeGroup } from "./organize-group";
import { present } from "./helpers/present";
import {
	asksAgain,
	db,
	edit,
	EATING,
	expectCleared,
	filedRow,
	GROCERIES,
	inQueue,
	insertTx,
	K1,
	K2,
	lineGuessOf,
	lineRow,
	rowOf,
	setCategory,
	TODAY,
	useLineFixture,
	WHO,
} from "./lookup-line-fixture";

// Rule 13 (spec §7, "One answer corrects the whole store"): every writer that files a row of a store clears the line-backed
// guesses of the store's other rows (S, under K2, shares the lookup text). Each case runs one real writer on A (the row it
// files, or the row it inserts) and checks A's filing, then S's clear. The writer table is the one the brief verified (W1-W20).

/** A category's id by its name, as the demo or a test made it. */
async function idOf(name: string): Promise<number> {
	const row = await db
		.prepare("SELECT id FROM categories WHERE name = ?")
		.bind(name)
		.first<{ id: number }>();

	return present(row).id;
}

/** The first child of a split parent, as saved (both parts are inserted in one statement, so they are read by id). */
async function firstPartOf(parentId: number): Promise<number> {
	const row = await db
		.prepare("SELECT id FROM transactions WHERE parent_id = ? ORDER BY id LIMIT 1")
		.bind(parentId)
		.first<{ id: number }>();

	return present(row).id;
}

/** Every child id of a split parent, oldest first. */
async function partIdsOf(parentId: number): Promise<number[]> {
	const { results } = await db
		.prepare("SELECT id FROM transactions WHERE parent_id = ? ORDER BY id")
		.bind(parentId)
		.all<{ id: number }>();

	return results.map((row) => row.id);
}

type Filed = { a: number; s: number; own?: "none" };

type Case = {
	label: string;
	run: () => Promise<Filed>;
	/** Who filed A and to what, as the filing's own write sets them. */
	source: "user" | "merchant_rule";
	category: string;
};

const CASES: Case[] = [
	{
		label: "W1 select-mode Set category (no UPDATE trigger: W1 fails)",
		source: "user",
		category: "Groceries",
		run: async () => {
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await setCategory([a], GROCERIES);

			return { a, s };
		},
	},
	{
		label: "W2 edit panel save (no UPDATE trigger: W2 fails)",
		source: "user",
		category: "Groceries",
		run: async () => {
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await saveEdit(db, a, edit({ categoryId: GROCERIES }), WHO);

			return { a, s };
		},
	},
	{
		label: "W3 edit panel 'Always for these merchants' (the panel's own write is user, so W3 cannot isolate the WHEN)",
		source: "user",
		category: "Groceries",
		run: async () => {
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await saveEdit(db, a, edit({ categoryId: GROCERIES, alwaysForMerchant: true }), WHO);

			return { a, s };
		},
	},
	{
		label: "W4 setMerchantRule files the store (no 'merchant_rule' in the WHEN: W4 fails)",
		source: "merchant_rule",
		category: "Groceries",
		run: async () => {
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await setMerchantRule(db, K1, GROCERIES, WHO);

			return { a, s };
		},
	},
	{
		label: "W5 split part insert (no INSERT trigger: W5 fails)",
		source: "user",
		category: "Groceries",
		run: async () => {
			const parent = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await saveSplit(
				db,
				parent,
				[
					{ categoryId: GROCERIES, amountCents: 600 },
					{ categoryId: EATING, amountCents: 600 },
				],
				WHO,
			);

			return { a: await firstPartOf(parent), s, own: "none" };
		},
	},
	{
		// A correction updates the kept part in place, and that update also fires the trigger, so this case cannot tell the
		// INSERT trigger from the UPDATE one (the brief's "no INSERT trigger: W6 fails" does not hold for it).
		label: "W6 cash split correction: a kept part updated and a new part inserted (the update alone fires it)",
		source: "user",
		category: "Eating Out",
		run: async () => {
			const parent = (
				await saveCash(
					db,
					{ date: TODAY, amountCents: 1200, merchant: K1, categoryId: GROCERIES, note: null },
					WHO,
				)
			).id;

			expect(
				await saveSplit(
					db,
					parent,
					[
						{ categoryId: GROCERIES, amountCents: 600 },
						{ categoryId: GROCERIES, amountCents: 600 },
					],
					WHO,
				),
			).toMatchObject({ saved: true });

			const kept = await partIdsOf(parent);
			const s = await lineRow({ key: K2 });

			// Every existing part is named (the gate refuses a correction that drops one), so the new part is the third.
			expect(
				await saveEdit(db, parent, edit(), WHO, {
					totalCents: 1200,
					amountWasCents: 1200,
					parts: [
						{ id: kept[0] ?? null, categoryId: GROCERIES, amountCents: 400 },
						{ id: kept[1] ?? null, categoryId: GROCERIES, amountCents: 400 },
						{ id: null, categoryId: EATING, amountCents: 400 },
					],
				}),
			).toMatchObject({ saved: true });

			const added = await db
				.prepare("SELECT id FROM transactions WHERE parent_id = ? AND id NOT IN (?, ?)")
				.bind(parent, kept[0] ?? 0, kept[1] ?? 0)
				.first<{ id: number }>();

			return { a: present(added).id, s, own: "none" };
		},
	},
	{
		label: "W7 cash entry, new (no INSERT trigger: W7 fails)",
		source: "user",
		category: "Groceries",
		run: async () => {
			const s = await lineRow({ key: K2 });
			const a = (
				await saveCash(
					db,
					{ date: TODAY, amountCents: 1200, merchant: K1, categoryId: GROCERIES, note: null },
					WHO,
				)
			).id;

			return { a, s, own: "none" };
		},
	},
	{
		label: "W8 cash entry, restored after a hold (no INSERT trigger: W8 fails)",
		source: "user",
		category: "Groceries",
		run: async () => {
			const a = (
				await saveCash(
					db,
					{ date: TODAY, amountCents: 1200, merchant: K1, categoryId: GROCERIES, note: null },
					WHO,
				)
			).id;
			const token = await holdCashDelete(db, a, K1);
			const s = await lineRow({ key: K2 });
			const restored = await restoreCashDelete(db, token);

			// The restore inserts the row again under a new id (the freed one went to the sibling above).
			if (!restored || !("id" in restored)) throw new Error("restore refused");

			return { a: restored.id, s, own: "none" };
		},
	},
	{
		label: "W9 card Yes, accepting the line-backed guess (no UPDATE trigger: W9 fails)",
		source: "user",
		category: "Eating Out",
		run: async () => {
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await runWith(
				db,
				decideCategoryMaybe(acceptCategoryGuess, {
					transactionId: a,
					categoryId: EATING,
					today: TODAY,
					who: WHO,
				}).pipe(Effect.orDie),
			);

			return { a, s };
		},
	},
	{
		label: "W10 card 'Something else' (no UPDATE trigger: W10 fails)",
		source: "user",
		category: "Groceries",
		run: async () => {
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await runWith(
				db,
				decideCategoryMaybe(chooseCategory, {
					transactionId: a,
					categoryId: GROCERIES,
					today: TODAY,
					who: WHO,
				}).pipe(Effect.orDie),
			);

			return { a, s };
		},
	},
	{
		label: "W11 card 'Put it in' a new category (no UPDATE trigger: W11 fails)",
		source: "user",
		category: "Books & audio",
		run: async () => {
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });
			const target = newCategoryTarget("Books & audio", [
				{ id: GROCERIES, name: "Groceries", archived: false },
			]);

			if (!target.ok || target.kind !== "create") throw new Error("expected create");

			await fileInNewCategory(db, { transactionId: a, target, today: TODAY, who: WHO });

			return { a, s };
		},
	},
	{
		label: "W12 more like this, Add (no UPDATE trigger: W12 fails)",
		source: "user",
		category: "Groceries",
		run: async () => {
			const filed = await filedRow(K1, GROCERIES);
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await addMoreLikeThis(db, { filedId: filed, category: GROCERIES, ticked: [a], who: WHO });

			return { a, s };
		},
	},
	{
		label: "W13 likely transactions, Add (no UPDATE trigger: W13 fails)",
		source: "user",
		category: "Groceries",
		run: async () => {
			const filed = await filedRow(K1, GROCERIES);
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await addLikely(db, {
				savedId: filed,
				categoryId: GROCERIES,
				categoryName: "Groceries",
				ticked: [a],
				today: TODAY,
				actor: WHO,
			});

			return { a, s };
		},
	},
	{
		label: "W14 Organize, filing a group (no UPDATE trigger: W14 fails)",
		source: "user",
		category: "Groceries",
		run: async () => {
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await fileOrganizeGroup(db, [K1], GROCERIES, null, "Lupitas Taqueria", WHO);

			return { a, s };
		},
	},
	{
		label: "W15 Organize's store rule (no 'merchant_rule' in the WHEN: W15 fails)",
		source: "merchant_rule",
		category: "Groceries",
		run: async () => {
			const filed = await filedRow(K1, GROCERIES);
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await setOrganizeRule(db, GROCERIES, JSON.stringify([filed]), K1, WHO);

			return { a, s };
		},
	},
	{
		// A new-category suggestion is only made from rows Jev could not fit (jev_category_id IS NULL), and a line-backed guess
		// needs one, so A here is an unguessed suggestion row with no line. S is the line-backed sibling that must clear.
		label: "W16 new-category Create (A is an unguessed suggestion row, so it has no line; no UPDATE trigger: W16 fails)",
		source: "user",
		category: "Subscriptions",
		run: async () => {
			const a = await insertTx({ raw_name: K1, merchant_name: K1, jev_none_fit: 1, category_confidence: 0.9 });
			const x = await insertTx({ raw_name: "HULU", merchant_name: "HULU", jev_none_fit: 1, category_confidence: 0.9 });
			const y = await insertTx({ raw_name: "SPOTIFY", merchant_name: "SPOTIFY", jev_none_fit: 1, category_confidence: 0.9 });
			const s = await lineRow({ key: K2 });
			const id = present(await saveSuggestion(db, "Subscriptions", [a, x, y]));

			expect(
				await createFromSuggestion(db, id, { ticked: [a], shown: [a, x, y], notes: {} }, "person"),
			).toMatchObject({ ok: true });

			return { a, s, own: "none" };
		},
	},
	{
		label: "W17 pending merge, a person's pick moves onto the posted row (no UPDATE trigger: W17 fails)",
		source: "user",
		category: "Groceries",
		run: async () => {
			await insertTx({
				raw_name: K1,
				merchant_name: K1,
				plaid_transaction_id: "pend-17",
				pending: 1,
				category_id: GROCERIES,
				category_source: "user",
			});
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await db
				.prepare("UPDATE transactions SET plaid_transaction_id = 'post-17' WHERE id = ?")
				.bind(a)
				.run();

			const item = present(
				await db.prepare("SELECT id FROM plaid_items ORDER BY id LIMIT 1").first<{ id: number }>(),
			).id;

			await db
				.prepare("UPDATE plaid_items SET sync_lock_id = ? WHERE id = ?")
				.bind("lock-17", item)
				.run();

			await db.batch(
				mergePendingIntoPosted(db, item, "lock-17", "pend-17", {
					id: "post-17",
					cents: 1200,
					date: TODAY,
					name: K1,
					merchantName: K1,
					plaidCategory: null,
				}),
			);

			return { a, s };
		},
	},
	{
		label: "W18 pending merge, a split removed by amount (direct UPDATE, the SET list of pending-merge.ts:426; no UPDATE trigger: W18 fails)",
		source: "user",
		category: "Groceries",
		run: async () => {
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await db
				.prepare(
					"UPDATE transactions SET split_removed_from_cents = 1000, category_id = ?, category_source = 'user', category_confidence = NULL, jev_category_id = NULL, jev_none_fit = 0 WHERE id = ?",
				)
				.bind(GROCERIES, a)
				.run();

			return { a, s };
		},
	},
	{
		label: "W19 merchant rules after sync (no 'merchant_rule' in the WHEN: W19 fails)",
		source: "merchant_rule",
		category: "Groceries",
		run: async () => {
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await db
				.prepare("INSERT INTO merchants (raw_name, default_category_id) VALUES (?, ?)")
				.bind(K1, GROCERIES)
				.run();
			await applyMerchantRules(db);

			return { a, s };
		},
	},
	{
		label: "W20 a bank-text Change rule (no 'merchant_rule' in the WHEN: W20 fails)",
		source: "merchant_rule",
		category: "Groceries",
		run: async () => {
			const a = await lineRow({ key: K1 });
			const s = await lineRow({ key: K2 });

			await changeBankTextRule(db, cleanBankText(K1), GROCERIES);

			return { a, s };
		},
	},
];

describe("rule 13: a filing clears the store's other line-backed guesses (siblingCleared, BUG_NO_SIBLING_CLEAR)", () => {
	useLineFixture();

	it.each(CASES)("$label", async ({ run, source, category }) => {
		const { a, s, own } = await run();

		const filed = await rowOf(a);

		expect(filed.tx).toMatchObject({
			category_id: await idOf(category),
			category_source: source,
		});

		if (own === "none") expect(filed.answer).toBeNull();
		else
			expect(filed.answer).toMatchObject({
				kept: 1,
				kept_category_id: EATING,
				kept_confidence: 0.9,
			});

		await expectCleared(s);
		expect(await lineGuessOf(s)).toBe(false);
		expect(await inQueue(s)).toBe(false);
		expect(await asksAgain(s)).toBe(true);
	});
});
