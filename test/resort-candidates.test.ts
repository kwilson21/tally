import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	orderCandidates,
	RESORT_CANDIDATE_MAX,
	resortCandidates,
} from "../src/db/resort-candidates";
import { resetDemo } from "../src/demo/reset";

// The re-sort's candidates (decision 157, decision 160): the rows still waiting for a category that a newly created
// category could fit. Chosen by the same waiting rules as "N more look like this" (more-like-this.ts), by a stored
// confidence under the 0.80 threshold, and by the same Plaid category hint or the category the filed row's Jev guess
// was. Nothing here calls Jev or Workers AI.

const db = env.DB;

async function categoryId(name: string) {
	const row = await db
		.prepare("SELECT id FROM categories WHERE name = ?")
		.bind(name)
		.first<{ id: number }>();

	return row?.id ?? 0;
}

type Fields = {
	raw?: string;
	amount?: number;
	date?: string;
	confidence?: number | null;
	jevCategoryId?: number | null;
	jevFailedAt?: string | null;
	plaidCategory?: string | null;
	categoryId?: number | null;
	categorySource?: string | null;
	pending?: number;
	parentId?: number | null;
	isSplit?: number;
	jevMixed?: number | null;
	jevAlsoCategoryId?: number | null;
};

async function tx(fields: Fields = {}): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name,
				category_confidence, jev_category_id, jev_failed_at, plaid_category, category_id, category_source,
				pending, parent_id, is_split, jev_mixed, jev_also_category_id)
			VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING id`,
		)
		.bind(
			`plaid-${crypto.randomUUID()}`,
			fields.date ?? "2026-10-02",
			fields.amount ?? 1500,
			fields.raw ?? "CHECKCARD 0921 CVS",
			fields.confidence ?? null,
			fields.jevCategoryId ?? null,
			fields.jevFailedAt ?? null,
			fields.plaidCategory ?? null,
			fields.categoryId ?? null,
			fields.categorySource ?? null,
			fields.pending ?? 0,
			fields.parentId ?? null,
			fields.isSplit ?? 0,
			fields.jevMixed ?? null,
			fields.jevAlsoCategoryId ?? null,
		)
		.first<{ id: number }>();

	return row?.id ?? 0;
}

const HINT = "Shops";

let filed: number;
let groceries: number;
let eatingOut: number;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	// Every demo row already has a decision, so only the rows a test inserts are waiting.
	await db
		.prepare(
			`UPDATE transactions SET category_source = 'user',
				category_id = (SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1)
			WHERE category_id IS NULL AND category_source IS NULL`,
		)
		.run();
	groceries = await categoryId("Groceries");
	eatingOut = await categoryId("Eating Out");
	// The filed row: a person filed it in Groceries, its Jev guess was Eating Out, and its Plaid hint is HINT.
	filed = await tx({
		raw: "CHECKCARD 0921 CVS",
		plaidCategory: HINT,
		jevCategoryId: eatingOut,
		categoryId: groceries,
		categorySource: "user",
	});
	fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
	fetchSpy.mockRestore();
});

const ids = (rows: { id: number }[]) =>
	rows.map((r) => r.id).sort((a, b) => a - b);

const candidates = (queueIds: number[] = []) =>
	resortCandidates(db, {
		filedId: filed,
		newCategoryId: groceries,
		cameFromCategoryId: eatingOut,
		queueIds,
	});

describe("resortCandidates: the waiting rules", () => {
	it("excludes rows a person, a merchant rule or a bill already categorised", async () => {
		const user = await tx({
			plaidCategory: HINT,
			confidence: 0.4,
			categoryId: eatingOut,
			categorySource: "user",
		});

		const rule = await tx({
			plaidCategory: HINT,
			confidence: 0.4,
			categoryId: eatingOut,
			categorySource: "merchant_rule",
		});

		const bill = await tx({
			plaidCategory: HINT,
			confidence: 0.4,
			categoryId: eatingOut,
			categorySource: "bill",
		});

		const rows = await candidates();
		expect(ids(rows)).not.toContain(user);
		expect(ids(rows)).not.toContain(rule);
		expect(ids(rows)).not.toContain(bill);
	});

	it("excludes rows at or above the 0.80 threshold, and keeps one just under it", async () => {
		const atThreshold = await tx({ plaidCategory: HINT, confidence: 0.8 });
		const under = await tx({ plaidCategory: HINT, confidence: 0.79 });
		const rows = await candidates();
		expect(ids(rows)).not.toContain(atThreshold);
		expect(ids(rows)).toContain(under);
	});

	it("keeps rows never asked (NULL confidence) and Maybe rows (confidence between 0.40 and 0.80)", async () => {
		const never = await tx({ plaidCategory: HINT, confidence: null });
		const maybe = await tx({ plaidCategory: HINT, confidence: 0.58 });
		const rows = await candidates();
		expect(ids(rows)).toEqual(expect.arrayContaining([never, maybe]));
	});

	it("excludes the filed row, pending rows, split parts and their parts, and rows whose Jev failed", async () => {
		const pending = await tx({ plaidCategory: HINT, pending: 1 });
		const split = await tx({ plaidCategory: HINT, isSplit: 1 });
		const part = await tx({ plaidCategory: HINT, parentId: split });

		const failed = await tx({
			plaidCategory: HINT,
			jevFailedAt: "2026-10-03 10:00:00",
		});

		const rows = await candidates();
		expect(ids(rows)).not.toContain(filed);
		expect(ids(rows)).not.toContain(pending);
		expect(ids(rows)).not.toContain(split);
		expect(ids(rows)).not.toContain(part);
		expect(ids(rows)).not.toContain(failed);
	});

	it("returns nothing when the new category is archived or does not exist", async () => {
		await tx({ plaidCategory: HINT });

		const missing = await resortCandidates(db, {
			filedId: filed,
			newCategoryId: 999_999,
			cameFromCategoryId: eatingOut,
			queueIds: [],
		});

		expect(missing).toEqual([]);
		await db
			.prepare("UPDATE categories SET archived = 1 WHERE id = ?")
			.bind(groceries)
			.run();
		const archived = await candidates();
		expect(archived).toEqual([]);
	});
});

describe("resortCandidates: the two ways a row is related", () => {
	it("includes rows that share the filed row's Plaid category hint", async () => {
		const same = await tx({ plaidCategory: HINT, confidence: 0.3 });
		expect(ids(await candidates())).toContain(same);
	});

	it("includes rows whose Jev category is the one the filed row's guess was", async () => {
		const same = await tx({
			plaidCategory: "Something else",
			jevCategoryId: eatingOut,
			confidence: 0.3,
		});

		expect(ids(await candidates())).toContain(same);
	});

	it("excludes rows with neither the same hint nor the same Jev category", async () => {
		const other = await tx({
			plaidCategory: "Other",
			jevCategoryId: groceries,
			confidence: 0.3,
		});

		expect(ids(await candidates())).not.toContain(other);
	});

	it("does not match on a missing hint (NULL is never the same as NULL)", async () => {
		await db
			.prepare(
				"UPDATE transactions SET plaid_category = NULL, apple_category = NULL WHERE id = ?",
			)
			.bind(filed)
			.run();

		const noHint = await tx({
			plaidCategory: null,
			jevCategoryId: groceries,
			confidence: 0.3,
		});

		expect(ids(await candidates())).not.toContain(noHint);
	});

	it("reads the same hint Jev's question uses: the Apple Card category when Plaid has none", async () => {
		await db
			.prepare(
				"UPDATE transactions SET plaid_category = NULL, apple_category = 'Shops' WHERE id = ?",
			)
			.bind(filed)
			.run();
		const same = await tx({ plaidCategory: HINT, confidence: 0.3 });
		expect(ids(await candidates())).toContain(same);
	});
});

describe("resortCandidates: the cap and the order", () => {
	it("caps the candidates at 100", async () => {
		expect(RESORT_CANDIDATE_MAX).toBe(100);

		for (let i = 0; i < 120; i++) {
			await tx({
				plaidCategory: HINT,
				date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
			});
		}

		expect((await candidates()).length).toBe(100);
	});

	it("puts the review queue's rows first, in queue order, then the rest newest first", async () => {
		const older = await tx({ plaidCategory: HINT, date: "2026-08-01" });
		const newer = await tx({ plaidCategory: HINT, date: "2026-10-20" });
		const queued = await tx({ plaidCategory: HINT, date: "2026-07-01" });
		const rows = await candidates([queued, 987_654]);
		const order = rows.map((r) => r.id);
		expect(order[0]).toBe(queued);
		expect(order.indexOf(newer)).toBeLessThan(order.indexOf(older));
	});

	it("carries each row's pre-run Jev state as its snapshot", async () => {
		const row = await tx({
			plaidCategory: HINT,
			confidence: 0.58,
			jevCategoryId: eatingOut,
			jevMixed: 0.2,
		});

		await env.DB.prepare(
			"UPDATE transactions SET jev_attempts = 2 WHERE id = ?",
		)
			.bind(row)
			.run();
		const found = (await candidates()).find((r) => r.id === row);
		expect(found?.snapshot).toEqual({
			id: row,
			category_id: null,
			category_source: null,
			category_confidence: 0.58,
			jev_category_id: eatingOut,
			jev_none_fit: 0,
			jev_mixed: 0.2,
			jev_also_category_id: null,
			jev_failed_at: null,
			jev_attempts: 2,
		});
	});

	it("carries the cleaned-text fields and the amount that clustering needs", async () => {
		const row = await tx({
			plaidCategory: HINT,
			raw: "CHECKCARD 1002 CVS",
			amount: 2900,
		});

		const found = (await candidates()).find((r) => r.id === row);
		expect(found).toMatchObject({
			rawName: "CHECKCARD 1002 CVS",
			amountCents: 2900,
			mixed: false,
		});
		expect(typeof found?.merchantKey).toBe("string");
	});

	it("never calls Jev or Workers AI", async () => {
		await tx({ plaidCategory: HINT });
		await candidates([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("orderCandidates", () => {
	const rows = [
		{ id: 1, date: "2026-10-01" },
		{ id: 2, date: "2026-10-05" },
		{ id: 3, date: "2026-10-05" },
		{ id: 4, date: "2026-09-30" },
	];

	it("orders the rest by date, newest first, then id, newest first", () => {
		expect(orderCandidates(rows, []).map((r) => r.id)).toEqual([3, 2, 1, 4]);
	});

	it("puts the queue's rows first in queue order and ignores queue ids that are not candidates", () => {
		expect(orderCandidates(rows, [4, 999, 1]).map((r) => r.id)).toEqual([
			4, 1, 3, 2,
		]);
	});
});
