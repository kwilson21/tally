import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, monthsBefore, todayIn } from "../src/dates";
import { addLikely, likelyTransactions } from "../src/db/likely-transactions";
import { resetDemo } from "../src/demo/reset";

const TODAY = todayIn(DEFAULT_TIME_ZONE);
const THIS = TODAY.slice(0, 7);
const LAST = monthsBefore(THIS, 1);
const TWO_BACK = monthsBefore(THIS, 2);

/** Inserts a transaction and returns its id. */
async function tx(
	date: string,
	cents: number,
	raw: string,
	merchant: string | null,
	options: { categoryId?: number; suggestionId?: number } = {},
): Promise<number> {
	const row = await env.DB.prepare(
		`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, category_suggestion_id)
		VALUES (1, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
	)
		.bind(
			date,
			cents,
			raw,
			merchant,
			options.categoryId ?? null,
			options.categoryId ? "user" : null,
			options.suggestionId ?? null,
		)
		.first<{ id: number }>();
	return row?.id as number;
}

async function filed(id: number) {
	return env.DB.prepare(
		"SELECT category_id AS categoryId, category_source AS source, category_suggestion_id AS suggestionId FROM transactions WHERE id = ?",
	)
		.bind(id)
		.first<{
			categoryId: number | null;
			source: string | null;
			suggestionId: number | null;
		}>();
}

/** The amount a bank change split the transaction from, or null once its note is cleared. */
async function splitRemoved(id: number) {
	return (
		(
			await env.DB.prepare(
				"SELECT split_removed_from_cents AS cents FROM transactions WHERE id = ?",
			)
				.bind(id)
				.first<{ cents: number | null }>()
		)?.cents ?? null
	);
}

const GROCERIES = 1;
let pet: number;
let suggested: number;
let saved: number;

beforeEach(async () => {
	await resetDemo(env.DB, TODAY);
	// Every demo transaction is filed and the demo's own Pet Care suggestion goes, so each test starts clean.
	await env.DB.batch([
		env.DB.prepare(
			"UPDATE transactions SET category_id = ?, category_source = 'user', category_suggestion_id = NULL",
		).bind(GROCERIES),
		env.DB.prepare("DELETE FROM category_suggestions"),
	]);
	await env.DB.prepare(
		"INSERT INTO categories (name, icon, color, sort_order) VALUES ('Pet Care', 'tag', 'cat-plum', 99)",
	).run();
	pet = (
		await env.DB.prepare(
			"SELECT id FROM categories WHERE name = 'Pet Care'",
		).first<{
			id: number;
		}>()
	)?.id as number;
	suggested = (
		await env.DB.prepare(
			"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', 'pending') RETURNING id",
		).first<{ id: number }>()
	)?.id as number;
	// The transaction the category was made from: already filed in Pet Care.
	saved = await tx(
		`${THIS}-12`,
		18900,
		"BANFIELD PET HOSPITAL",
		"Banfield Pet Hospital",
		{ categoryId: pet },
	);
});

describe("likelyTransactions", () => {
	it("lists same-merchant rows first and ticked, then Tally's guesses, each newest first, from this month and last", async () => {
		const sameNew = await tx(
			`${THIS}-03`,
			7650,
			"BANFIELD PET HOSPITAL",
			"Banfield Pet Hospital",
		);
		const sameLast = await tx(
			`${LAST}-14`,
			4800,
			"BANFIELD PET HOSPITAL",
			"Banfield Pet Hospital",
		);
		await tx(
			`${TWO_BACK}-20`,
			3000,
			"BANFIELD PET HOSPITAL",
			"Banfield Pet Hospital",
		);
		const guessNew = await tx(`${THIS}-05`, 6412, "CHEWY.COM", "Chewy", {
			suggestionId: suggested,
		});
		const guessLast = await tx(
			`${LAST}-29`,
			2399,
			"PETSMART 0412",
			"Petsmart",
			{
				suggestionId: suggested,
			},
		);
		await tx(`${TWO_BACK}-08`, 999, "OLD GUESS", "Old", {
			suggestionId: suggested,
		});

		const rows = await likelyTransactions(env.DB, saved, "Pet Care", TODAY);

		expect(rows.map((row) => [row.id, row.sameMerchant])).toEqual([
			[sameNew, true],
			[sameLast, true],
			[guessNew, false],
			[guessLast, false],
		]);
	});

	it("caps the list at six rows, same merchant first", async () => {
		const sameIds = [
			await tx(
				`${THIS}-02`,
				100,
				"BANFIELD PET HOSPITAL",
				"Banfield Pet Hospital",
			),
			await tx(
				`${THIS}-01`,
				200,
				"BANFIELD PET HOSPITAL",
				"Banfield Pet Hospital",
			),
		];
		for (let day = 3; day <= 9; day++)
			await tx(`${THIS}-0${day}`, 300 - day, `CHEWY ${day}`, `Chewy ${day}`, {
				suggestionId: suggested,
			});

		const rows = await likelyTransactions(env.DB, saved, "Pet Care", TODAY);

		expect(rows).toHaveLength(6);
		expect(rows.slice(0, 2).map((row) => row.id)).toEqual(sameIds);
		expect(rows.slice(0, 2).every((row) => row.sameMerchant)).toBe(true);
		expect(rows.slice(2).every((row) => !row.sameMerchant)).toBe(true);
		// Guesses newest first: the day-9 one leads them.
		expect(rows[2]?.date).toBe(`${THIS}-09`);
	});

	it("offers guesses only for a name Tally suggested", async () => {
		await tx(`${THIS}-05`, 6412, "CHEWY.COM", "Chewy", {
			suggestionId: suggested,
		});
		const sameMerchant = await tx(
			`${THIS}-03`,
			7650,
			"BANFIELD PET HOSPITAL",
			"Banfield Pet Hospital",
		);

		const rows = await likelyTransactions(env.DB, saved, "Vet Visits", TODAY);

		expect(rows.map((row) => row.id)).toEqual([sameMerchant]);
	});

	it("leaves out transactions that already have a category", async () => {
		await tx(
			`${THIS}-03`,
			7650,
			"BANFIELD PET HOSPITAL",
			"Banfield Pet Hospital",
			{ categoryId: GROCERIES },
		);

		const rows = await likelyTransactions(env.DB, saved, "Pet Care", TODAY);

		expect(rows).toEqual([]);
	});

	it("hides a guessed note while details are off, and marks it guessed while they are on", async () => {
		const guessed = await tx(
			`${THIS}-03`,
			7650,
			"BANFIELD PET HOSPITAL",
			"Banfield Pet Hospital",
		);
		const typed = await tx(
			`${THIS}-04`,
			4800,
			"BANFIELD PET HOSPITAL",
			"Banfield Pet Hospital",
		);
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE transactions SET note = 'Dinner', note_guessed = 1 WHERE id = ?",
			).bind(guessed),
			env.DB.prepare(
				"UPDATE transactions SET note = 'Vet bill' WHERE id = ?",
			).bind(typed),
			env.DB.prepare(
				"INSERT OR REPLACE INTO household_settings (key, value) VALUES ('ai_details', 'off')",
			),
		]);

		const off = await likelyTransactions(env.DB, saved, "Pet Care", TODAY);
		expect(off.find((row) => row.id === guessed)).toMatchObject({
			note: null,
			noteGuessed: false,
		});
		// A note a person wrote shows whatever the details switch says.
		expect(off.find((row) => row.id === typed)).toMatchObject({
			note: "Vet bill",
			noteGuessed: false,
		});

		await env.DB.prepare(
			"INSERT OR REPLACE INTO household_settings (key, value) VALUES ('ai_details', 'on')",
		).run();
		const on = await likelyTransactions(env.DB, saved, "Pet Care", TODAY);
		expect(on.find((row) => row.id === guessed)).toMatchObject({
			note: "Dinner",
			noteGuessed: true,
		});
	});

	it("carries the date a bank change unlinked a refund, as the list does", async () => {
		const unlinked = (
			await env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, credit_reviewed, refund_unlinked_purchase_date) VALUES (1, ?, -700, 'BANFIELD PET HOSPITAL', 'Banfield Pet Hospital', 1, ?) RETURNING id",
			)
				.bind(`${THIS}-06`, `${THIS}-01`)
				.first<{ id: number }>()
		)?.id as number;

		const rows = await likelyTransactions(env.DB, saved, "Pet Care", TODAY);

		expect(rows.find((row) => row.id === unlinked)).toMatchObject({
			refundUnlinkedPurchaseDate: `${THIS}-01`,
			refundPurchaseDate: null,
		});
	});

	it("carries the bill a payment pays and the month the bill moved it to", async () => {
		const payment = await tx(
			`${THIS}-06`,
			9000,
			"BANFIELD PET HOSPITAL",
			"Banfield Pet Hospital",
		);
		const bill = (
			await env.DB.prepare(
				"INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name) VALUES ('Vet plan', 9000, 1, 'monthly', 'BANFIELD PLAN') RETURNING id",
			).first<{ id: number }>()
		)?.id as number;
		await env.DB.prepare(
			"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, ?, ?, 'auto', 'linked')",
		)
			.bind(bill, LAST, payment)
			.run();

		const rows = await likelyTransactions(env.DB, saved, "Pet Care", TODAY);

		expect(rows.find((row) => row.id === payment)).toMatchObject({
			paysBill: true,
			billName: "Vet plan",
			countsInMonth: LAST,
		});
	});
});

describe("addLikely", () => {
	it("files only the ticked rows into the category as the person's pick, and leaves the rest", async () => {
		const sameNew = await tx(
			`${THIS}-03`,
			7650,
			"BANFIELD PET HOSPITAL",
			"Banfield Pet Hospital",
		);
		const guessNew = await tx(`${THIS}-05`, 6412, "CHEWY.COM", "Chewy", {
			suggestionId: suggested,
		});
		const guessLast = await tx(
			`${LAST}-29`,
			2399,
			"PETSMART 0412",
			"Petsmart",
			{
				suggestionId: suggested,
			},
		);
		const unrelated = await tx(`${THIS}-07`, 1200, "TARGET", "Target");
		const tooOld = await tx(`${TWO_BACK}-08`, 999, "OLD GUESS", "Old", {
			suggestionId: suggested,
		});

		const moved = await addLikely(env.DB, {
			savedId: saved,
			categoryId: pet,
			categoryName: "Pet Care",
			// Ticked: a same-merchant row and a guess, plus two rows that were never offered.
			ticked: [sameNew, guessNew, unrelated, tooOld],
			today: TODAY,
			actor: "test",
		});

		expect(moved).toBe(2);
		expect(await filed(sameNew)).toEqual({
			categoryId: pet,
			source: "user",
			suggestionId: null,
		});
		expect(await filed(guessNew)).toEqual({
			categoryId: pet,
			source: "user",
			suggestionId: null,
		});
		expect((await filed(guessLast))?.categoryId).toBeNull();
		expect((await filed(unrelated))?.categoryId).toBeNull();
		expect((await filed(tooOld))?.categoryId).toBeNull();
	});

	it("clears the bank-change note on a row it files, and keeps it on a row left unticked", async () => {
		const ticked = await tx(
			`${THIS}-03`,
			7650,
			"BANFIELD PET HOSPITAL",
			"Banfield Pet Hospital",
		);
		const unticked = await tx(
			`${THIS}-04`,
			4800,
			"BANFIELD PET HOSPITAL",
			"Banfield Pet Hospital",
		);
		await env.DB.prepare(
			"UPDATE transactions SET split_removed_from_cents = 18742 WHERE id IN (?, ?)",
		)
			.bind(ticked, unticked)
			.run();

		const moved = await addLikely(env.DB, {
			savedId: saved,
			categoryId: pet,
			categoryName: "Pet Care",
			ticked: [ticked],
			today: TODAY,
			actor: "test",
		});

		expect(moved).toBe(1);
		expect(await splitRemoved(ticked)).toBeNull();
		expect(await splitRemoved(unticked)).toBe(18742);
	});
});
