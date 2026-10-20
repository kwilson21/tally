import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { summarizeMonth } from "../src/budget";
import { loadMonth } from "../src/db/month";
import {
	getTransaction,
	listTransactions,
	needsCategoryCount,
	saveEdit,
	saveJevDetailsStatement,
	saveJevResult,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { parseEdit } from "../src/transactions/edit";
import { parseFilters } from "../src/transactions/filters";

const db = env.DB;
const TODAY = "2026-09-22";
const EATING_OUT = 2;
const GAS = 3;

const idOf = async (rawName: string) =>
	(
		await db
			.prepare(
				"SELECT id FROM transactions WHERE raw_name = ? ORDER BY date DESC LIMIT 1",
			)
			.bind(rawName)
			.first<{ id: number }>()
	)?.id as number;

const row = (id: number) =>
	db
		.prepare(
			"SELECT category_id, category_source, category_confidence, note, excluded, excluded_source, updated_by FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<Record<string, unknown>>();

const edit = (over: Partial<Parameters<typeof saveEdit>[2]> = {}) => ({
	categoryId: null,
	alwaysForMerchant: false,
	displayName: null,
	note: null,
	excluded: false,
	income: false,
	creditReviewed: true,
	...over,
});

beforeEach(async () => {
	await resetDemo(db, TODAY);
});

describe("getTransaction", () => {
	it("returns the row with its account and merchant details", async () => {
		const t = await getTransaction(db, await idOf("SQ *LOCAL BAKERY 4432"));
		expect(t).toMatchObject({
			rawName: "SQ *LOCAL BAKERY 4432",
			displayName: "Local Bakery",
			merchantName: "Local Bakery",
			amountCents: 1200,
			accountName: "Credit card",
			accountMask: "9012",
			categoryId: null,
			categorySource: null,
		});
		expect(await getTransaction(db, 999999)).toBeNull();
	});
});

describe("saveEdit", () => {
	it("records and can reverse a person's income choice", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await saveEdit(db, id, edit({ income: true }), "demo");
		expect(
			await db
				.prepare(
					"SELECT flag_income, income_source FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({ flag_income: 1, income_source: "user" });
		await saveEdit(db, id, edit(), "demo");
		expect(
			await db
				.prepare(
					"SELECT flag_income, income_source FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({ flag_income: 0, income_source: "user" });
	});

	it("preserves a person's non-income refund review when Jev later flags income", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -1200, credit_reviewed = 0, credit_reviewed_by = NULL WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveEdit(db, id, edit({ creditReviewed: true }), "demo");
		expect(
			await db
				.prepare(
					"SELECT flag_income, income_source, credit_reviewed_by FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			flag_income: 0,
			income_source: "user",
			credit_reviewed_by: "user",
		});
		await saveJevResult(db, id, {
			categoryId: null,
			suggestedCategoryId: null,
			confidence: 0.4,
			flags: { transfer: false, reimbursement: false, income: true },
		});
		expect(
			await db
				.prepare(
					"SELECT flag_income, income_source, credit_reviewed_by FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			flag_income: 0,
			income_source: "user",
			credit_reviewed_by: "user",
		});
	});

	it("marks a changed category as a person's choice, and Home follows", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await saveEdit(
			db,
			id,
			edit({ categoryId: EATING_OUT, displayName: "Local Bakery" }),
			"demo",
		);
		expect(await row(id)).toMatchObject({
			category_id: EATING_OUT,
			category_source: "user",
			category_confidence: null,
			updated_by: "demo",
		});
		expect(await needsCategoryCount(db, "2026-09")).toBe(9);
		const summary = summarizeMonth({
			month: "2026-09",
			...(await loadMonth(db, "2026-09")),
			unpaidDueBillsCents: 0,
		});
		// Eating Out's rows dated up to the 22nd are $336, and the Bakery's $12 makes $348 (the demo's paced spending, #322).
		expect(
			summary.categories.find((c) => c.id === EATING_OUT)?.spentCents,
		).toBe(34800);
	});

	it("excludes a transaction, which leaves Needs category and spending (spec §6, #27)", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		const before = await loadMonth(db, "2026-09");
		await saveEdit(db, id, edit({ excluded: true }), "demo");
		expect(await row(id)).toMatchObject({ excluded: 1, updated_by: "demo" });
		expect(await needsCategoryCount(db, "2026-09")).toBe(9);
		const after = await loadMonth(db, "2026-09");
		expect(after.transactions.length).toBe(before.transactions.length - 1);
	});

	it("includes an excluded transaction again, which then counts", async () => {
		const id = await idOf("ONLINE TRANSFER TO SAV ...5678");
		expect(await row(id)).toMatchObject({ excluded: 1 });
		await saveEdit(db, id, edit({ excluded: false }), "demo");
		expect(await row(id)).toMatchObject({
			excluded: 0,
			excluded_source: "user",
		});
	});

	it("leaves who decided the exclusion alone when a save doesn't change it", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await saveEdit(db, id, edit({ note: "hi" }), "demo");
		expect(await row(id)).toMatchObject({ excluded: 0, excluded_source: null });
	});

	it("updates split children only when their exclusion changes", async () => {
		const parent = await db
			.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'COSTCO WHSE #0431' AND is_split = 1",
			)
			.first<{ id: number }>();
		await db
			.prepare(
				"UPDATE transactions SET updated_by = 'earlier' WHERE parent_id = ?",
			)
			.bind(parent?.id)
			.run();

		await saveEdit(db, parent?.id as number, edit(), "unchanged");
		expect(
			(
				await db
					.prepare(
						"SELECT DISTINCT updated_by FROM transactions WHERE parent_id = ?",
					)
					.bind(parent?.id)
					.all<{ updated_by: string }>()
			).results,
		).toEqual([{ updated_by: "earlier" }]);

		await saveEdit(
			db,
			parent?.id as number,
			edit({ excluded: true }),
			"changed",
		);
		expect(
			(
				await db
					.prepare(
						"SELECT DISTINCT updated_by FROM transactions WHERE parent_id = ?",
					)
					.bind(parent?.id)
					.all<{ updated_by: string }>()
			).results,
		).toEqual([{ updated_by: "changed" }]);
		await saveEdit(
			db,
			parent?.id as number,
			edit({ excluded: true }),
			"unchanged-again",
		);
		expect(
			(
				await db
					.prepare(
						"SELECT DISTINCT updated_by FROM transactions WHERE parent_id = ?",
					)
					.bind(parent?.id)
					.all<{ updated_by: string }>()
			).results,
		).toEqual([{ updated_by: "changed" }]);
	});

	it("excludes the whole split when one part is excluded, and includes it back", async () => {
		const parent = await db
			.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'COSTCO WHSE #0431' AND is_split = 1",
			)
			.first<{ id: number }>();
		const child = await db
			.prepare("SELECT id FROM transactions WHERE parent_id = ? LIMIT 1")
			.bind(parent?.id)
			.first<{ id: number }>();
		const states = async () =>
			(
				await db
					.prepare(
						"SELECT DISTINCT excluded FROM transactions WHERE id = ?1 OR parent_id = ?1",
					)
					.bind(parent?.id)
					.all<{ excluded: number }>()
			).results;
		await saveEdit(db, child?.id as number, edit({ excluded: true }), "part");
		expect(await states()).toEqual([{ excluded: 1 }]);
		await saveEdit(db, child?.id as number, edit({ excluded: false }), "part");
		expect(await states()).toEqual([{ excluded: 0 }]);
	});

	it("leaves the source alone when only the note changes", async () => {
		const id = await idOf("CHIPOTLE 2291");
		await saveEdit(
			db,
			id,
			edit({
				categoryId: EATING_OUT,
				displayName: "Chipotle",
				note: "team lunch",
			}),
			"demo",
		);
		expect(await row(id)).toMatchObject({
			category_id: EATING_OUT,
			category_source: "jev",
			note: "team lunch",
		});
	});

	it("applies a merchant rule to the merchant's other rows, except a person's choices", async () => {
		const ids = (
			await db
				.prepare("SELECT id FROM transactions WHERE raw_name = ? ORDER BY id")
				.bind("TRADER JOE'S #552")
				.all<{ id: number }>()
		).results.map((r) => r.id);
		expect(ids.length).toBeGreaterThan(3);
		const [edited, personal, ...others] = ids as [number, number, ...number[]];
		await db
			.prepare("UPDATE transactions SET category_source = 'user' WHERE id = ?")
			.bind(personal)
			.run();

		await saveEdit(
			db,
			edited,
			edit({
				categoryId: GAS,
				alwaysForMerchant: true,
				displayName: "Trader Joe's",
			}),
			"demo",
		);

		const merchant = await db
			.prepare("SELECT default_category_id FROM merchants WHERE raw_name = ?")
			.bind("TRADER JOE'S #552")
			.first<{ default_category_id: number }>();
		expect(merchant?.default_category_id).toBe(GAS);
		expect(await row(edited)).toMatchObject({
			category_id: GAS,
			category_source: "user",
		});
		expect(await row(personal)).toMatchObject({
			category_id: 1,
			category_source: "user",
		});
		for (const id of others) {
			expect(await row(id)).toMatchObject({
				category_id: GAS,
				category_source: "merchant_rule",
			});
		}
	});

	it("renames the merchant everywhere, creating its merchant row if needed", async () => {
		await db
			.prepare("DELETE FROM merchants WHERE raw_name = 'PAYPAL *XYZSHOP'")
			.run();
		const id = await idOf("PAYPAL *XYZSHOP");
		await saveEdit(db, id, edit({ displayName: "XYZ Shop" }), "demo");
		const { rows } = await listTransactions(
			db,
			parseFilters(new URLSearchParams("q=paypal"), "2026-09"),
		);
		expect(rows.map((r) => r.displayName)).toEqual(["XYZ Shop"]);
	});

	it("saves nothing when any part fails", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await expect(
			saveEdit(
				db,
				id,
				edit({
					categoryId: 999,
					alwaysForMerchant: true,
					note: "should not stick",
				}),
				"demo",
			),
		).rejects.toThrow();
		expect(await row(id)).toMatchObject({ category_id: null, note: null });
	});

	it("keeps a Kind and For a person cleared, when Jev answers later (#304)", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		const untouched = (
			await db
				.prepare(
					"SELECT id FROM transactions WHERE id != ? ORDER BY id LIMIT 1",
				)
				.bind(id)
				.first<{ id: number }>()
		)?.id as number;
		await db.batch([
			db
				.prepare(
					"UPDATE transactions SET kind = 'bill', kind_guessed = 0, for_person_id = 1, for_person_guessed = 0, details_asked = 0 WHERE id = ?",
				)
				.bind(id),
			db
				.prepare(
					"UPDATE transactions SET kind = NULL, kind_guessed = 0, for_person_id = NULL, for_person_guessed = 0, details_asked = 0 WHERE id = ?",
				)
				.bind(untouched),
		]);

		await saveEdit(
			db,
			id,
			edit({ kind: null, forPersonId: null, noteProvided: false }),
			"demo",
		);
		expect(
			await db
				.prepare(
					"SELECT kind_cleared, for_person_cleared FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({ kind_cleared: 1, for_person_cleared: 1 });

		await saveJevDetailsStatement(db, [
			{ id, kind: "subscription", forPersonId: 1, noteWorthWriting: null },
			{
				id: untouched,
				kind: "subscription",
				forPersonId: 1,
				noteWorthWriting: null,
			},
		])?.run();
		const details =
			"SELECT kind, kind_guessed, for_person_id, for_person_guessed FROM transactions WHERE id = ?";
		expect(await db.prepare(details).bind(id).first()).toEqual({
			kind: null,
			kind_guessed: 0,
			for_person_id: null,
			for_person_guessed: 0,
		});
		expect(await db.prepare(details).bind(untouched).first()).toEqual({
			kind: "subscription",
			kind_guessed: 1,
			for_person_id: 1,
			for_person_guessed: 1,
		});
	});

	it("a note saved with Details hidden keeps Jev's guessed Kind, which the form posts as Not known (#304)", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET kind = 'subscription', kind_guessed = 1, details_asked = 1 WHERE id = ?",
			)
			.bind(id)
			.run();
		// With the Details switch off the guess is drawn as Not known, so the form posts Kind empty both ways.
		const posted = new FormData();
		for (const [key, value] of Object.entries({
			details_visible: "0",
			kind_was: "",
			kind: "",
			for_person_id_was: "",
			for_person_id: "",
			note_was: "",
			note: "Office lunch",
		}))
			posted.set(key, value);
		const parsed = parseEdit(posted, [EATING_OUT, GAS]);
		if (!parsed.ok) throw new Error("expected the form to parse");
		await saveEdit(db, id, parsed.value, "demo");
		expect(
			await db
				.prepare(
					"SELECT note, kind, kind_guessed, kind_cleared FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			note: "Office lunch",
			kind: "subscription",
			kind_guessed: 1,
			kind_cleared: 0,
		});
	});

	it("a Kind picked with Details hidden is the person's, even when it is the hidden guess (#377)", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET kind = 'subscription', kind_guessed = 1, for_person_id = 1, for_person_guessed = 1, details_asked = 1 WHERE id = ?",
			)
			.bind(id)
			.run();
		// The guess is drawn as Not known, so picking Subscription posts against an empty kind_was.
		const posted = new FormData();
		for (const [key, value] of Object.entries({
			details_visible: "0",
			kind_was: "",
			kind: "subscription",
			for_person_id_was: "",
			for_person_id: "",
			note_was: "",
			note: "",
		}))
			posted.set(key, value);
		const parsed = parseEdit(posted, [EATING_OUT, GAS]);
		if (!parsed.ok) throw new Error("expected the form to parse");
		await saveEdit(db, id, parsed.value, "demo");
		expect(
			await db
				.prepare(
					"SELECT kind, kind_guessed, for_person_id, for_person_guessed FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			kind: "subscription",
			kind_guessed: 0,
			for_person_id: 1,
			for_person_guessed: 1,
		});
	});

	it("a For picked with Details hidden is the person's, even when it is the hidden guess (#377)", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET kind = 'subscription', kind_guessed = 1, for_person_id = 1, for_person_guessed = 1, details_asked = 1 WHERE id = ?",
			)
			.bind(id)
			.run();
		// The guess is drawn as No one, so picking Person 1 posts against an empty for_person_id_was.
		const posted = new FormData();
		for (const [key, value] of Object.entries({
			details_visible: "0",
			kind_was: "",
			kind: "",
			for_person_id_was: "",
			for_person_id: "1",
			note_was: "",
			note: "",
		}))
			posted.set(key, value);
		const parsed = parseEdit(posted, [EATING_OUT, GAS]);
		if (!parsed.ok) throw new Error("expected the form to parse");
		await saveEdit(db, id, parsed.value, "demo");
		expect(
			await db
				.prepare(
					"SELECT kind, kind_guessed, for_person_id, for_person_guessed FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			kind: "subscription",
			kind_guessed: 1,
			for_person_id: 1,
			for_person_guessed: 0,
		});
	});

	it("a save with Details shown that leaves a guessed Kind and For alone keeps them guesses (#377)", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET kind = 'subscription', kind_guessed = 1, for_person_id = 1, for_person_guessed = 1, details_asked = 1 WHERE id = ?",
			)
			.bind(id)
			.run();
		// Details shown: the guesses are drawn as they are, so an untouched save re-posts them unchanged.
		const posted = new FormData();
		for (const [key, value] of Object.entries({
			details_visible: "1",
			kind_was: "subscription",
			kind: "subscription",
			for_person_id_was: "1",
			for_person_id: "1",
			note_was: "",
			note: "",
		}))
			posted.set(key, value);
		const parsed = parseEdit(posted, [EATING_OUT, GAS]);
		if (!parsed.ok) throw new Error("expected the form to parse");
		await saveEdit(db, id, parsed.value, "demo");
		expect(
			await db
				.prepare(
					"SELECT kind, kind_guessed, for_person_id, for_person_guessed FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			kind: "subscription",
			kind_guessed: 1,
			for_person_id: 1,
			for_person_guessed: 1,
		});
	});

	it("a Kind a person chooses after clearing it is no longer a clear", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET kind = 'bill', kind_guessed = 0 WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveEdit(db, id, edit({ kind: null, noteProvided: false }), "demo");
		expect(
			await db
				.prepare("SELECT kind_cleared FROM transactions WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ kind_cleared: 1 });
		await saveEdit(
			db,
			id,
			edit({ kind: "one_off", noteProvided: false }),
			"demo",
		);
		expect(
			await db
				.prepare("SELECT kind, kind_cleared FROM transactions WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ kind: "one_off", kind_cleared: 0 });
	});
});

describe("saveEdit recounts a linked credit when this save makes it count with its purchase", () => {
	const PURCHASE = 9401;
	const REFUND = 9402;
	const INCOME_CREDIT = 9403;

	beforeEach(async () => {
		const bank = await db
			.prepare("SELECT id FROM accounts WHERE type != 'cash' LIMIT 1")
			.first<{ id: number }>();
		if (!bank) throw new Error("bank account missing");
		// A $50 purchase whose whole $50 is already refunded by REFUND, and a $20 credit linked to it
		// that is marked as income, so it doesn't count against the purchase.
		await db
			.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source, is_split, parent_id, refund_of_id, flag_income, credit_reviewed, updated_by) VALUES
				(?, ?, '2026-09-01', 5000, 'CAP SHOP', 1, 'user', 0, NULL, NULL, 0, 0, 'test'),
				(?, ?, '2026-09-03', -5000, 'CAP SHOP', 1, 'user', 0, NULL, ?, 0, 1, 'test'),
				(?, ?, '2026-09-04', -2000, 'CAP SHOP', 1, 'user', 0, NULL, ?, 1, 0, 'test')`,
			)
			.bind(
				PURCHASE,
				bank.id,
				REFUND,
				bank.id,
				PURCHASE,
				INCOME_CREDIT,
				bank.id,
				PURCHASE,
			)
			.run();
	});

	const creditRow = () =>
		db
			.prepare(
				"SELECT note, flag_income, refund_of_id FROM transactions WHERE id = ?",
			)
			.bind(INCOME_CREDIT)
			.first<{
				note: string | null;
				flag_income: number;
				refund_of_id: number | null;
			}>();

	it("saves a note from a panel that showed income off, leaving the income flag and the cap alone", async () => {
		expect(
			await saveEdit(
				db,
				INCOME_CREDIT,
				{
					...edit(),
					note: "Note only",
					income: false,
					incomeWas: false,
					creditReviewedProvided: false,
				},
				"test",
			),
		).toEqual({ saved: true });
		expect(await creditRow()).toEqual({
			note: "Note only",
			flag_income: 1,
			refund_of_id: PURCHASE,
		});
	});

	it("refuses reviewing a linked credit as not income when the purchase has no room left, since the review clears its income", async () => {
		expect(
			await saveEdit(
				db,
				INCOME_CREDIT,
				{
					...edit(),
					note: "Reviewed only",
					income: false,
					incomeWas: false,
					creditReviewed: true,
					creditReviewedWas: false,
					creditReviewedProvided: true,
				},
				"test",
			),
		).toEqual({ saved: false, refundLeftCents: 0 });
		expect(await creditRow()).toEqual({
			note: null,
			flag_income: 1,
			refund_of_id: PURCHASE,
		});
	});

	it("still refuses clearing income on a linked credit when the purchase has no room left", async () => {
		expect(
			await saveEdit(
				db,
				INCOME_CREDIT,
				{
					...edit(),
					note: "Clearing income",
					income: false,
					incomeWas: true,
					creditReviewedProvided: false,
				},
				"test",
			),
		).toEqual({ saved: false, refundLeftCents: 0 });
		expect(await creditRow()).toEqual({
			note: null,
			flag_income: 1,
			refund_of_id: PURCHASE,
		});
	});
});
