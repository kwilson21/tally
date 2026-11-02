import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NONE_FIT } from "../src/ai/decide";
import { saveAiSwitches } from "../src/db/ai-switches";
import {
	FULL_NEW_CATEGORY,
	fileInNewCategory,
	newCategoryTarget,
	suggestedCategoryName,
} from "../src/db/new-category-answer";
import { resetDemo } from "../src/demo/reset";
import { MAX_ACTIVE } from "../src/settings/category-form";

// The Maybe card's "New category" answers (decision 156): the name a person types is checked as the category form
// checks it, a name that is already a category files the purchase in that one, and the create and the filing are
// one batch, so a refusal leaves nothing behind.

const db = env.DB;
const CATEGORIES = [
	{ id: 1, name: "Groceries", archived: false },
	{ id: 2, name: "Pet Care", archived: true },
	{ id: 3, name: "Eating Out", archived: false },
];

/** A list of `count` active categories, for the limit. */
const activeList = (count: number) =>
	Array.from({ length: count }, (_, i) => ({
		id: i + 1,
		name: `Category ${i + 1}`,
		archived: false,
	}));

describe("newCategoryTarget: the typed name, checked as the category form checks it", () => {
	it("files into the active category with the same name, ignoring case and spacing", () => {
		expect(newCategoryTarget("  groceries ", CATEGORIES)).toEqual({
			ok: true,
			kind: "existing",
			id: 1,
			name: "Groceries",
		});
	});

	it("says to restore an archived category with the name, rather than making a second one", () => {
		expect(newCategoryTarget("pet care", CATEGORIES)).toEqual({
			ok: false,
			error: "An archived category has that name. Restore it instead.",
		});
	});

	it("makes a new category for a new name, with a colour and no amount", () => {
		const target = newCategoryTarget("Books & audio", CATEGORIES);
		expect(target).toMatchObject({
			ok: true,
			kind: "create",
			name: "Books & audio",
		});
		expect(target).toHaveProperty("color", expect.stringMatching(/^cat-/));
	});

	it("refuses an empty name", () => {
		expect(newCategoryTarget("   ", CATEGORIES)).toEqual({
			ok: false,
			error: "Give the category a name.",
		});
	});

	it("refuses a name longer than 40 characters", () => {
		expect(newCategoryTarget("x".repeat(41), CATEGORIES)).toEqual({
			ok: false,
			error: "Keep the name to 40 characters.",
		});
	});

	it("refuses the name Tally keeps for itself", () => {
		expect(newCategoryTarget(NONE_FIT, CATEGORIES)).toEqual({
			ok: false,
			error: "That name is reserved for Tally. Pick another.",
		});
	});

	it("at the limit refuses a new name with the category form's full message", () => {
		expect(newCategoryTarget("Books", activeList(MAX_ACTIVE))).toEqual({
			ok: false,
			error: FULL_NEW_CATEGORY,
		});
		expect(FULL_NEW_CATEGORY).toBe(
			"Tally has room for 50 categories. Archive one to add another. Add it to an existing category instead.",
		);
	});

	it("at the limit still files into a category that already has the name", () => {
		expect(newCategoryTarget("category 7", activeList(MAX_ACTIVE))).toEqual({
			ok: true,
			kind: "existing",
			id: 7,
			name: "Category 7",
		});
	});
});

describe("database: the create and the filing are one batch", () => {
	beforeEach(async () => {
		await resetDemo(db, "2026-09-22");
		await db.batch([
			db.prepare("DELETE FROM transactions"),
			db.prepare("DELETE FROM category_suggestions"),
		]);
	});

	/** A purchase Jev guessed at, unsure enough to be a Maybe. */
	async function maybeRow(raw = "AUDIBLE*TE3E10I7 WA", amount = 1499) {
		const eatingOut = await db
			.prepare("SELECT id FROM categories WHERE name = 'Eating Out'")
			.first<{ id: number }>();
		const row = await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name,
					category_confidence, jev_category_id)
				VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', ?, ?, 0.58, ?)
				RETURNING id`,
			)
			.bind(`plaid-${crypto.randomUUID()}`, amount, raw, eatingOut?.id ?? null)
			.first<{ id: number }>();
		return row?.id ?? 0;
	}

	const count = async (sql: string) =>
		(await db.prepare(sql).first<{ n: number }>())?.n ?? 0;

	it("creates an active category with no budget amount and files the purchase in it", async () => {
		const tx = await maybeRow();
		const before = await db
			.prepare("SELECT amount_cents FROM transactions WHERE id = ?")
			.bind(tx)
			.first<{ amount_cents: number }>();
		const target = newCategoryTarget("Books & audio", [
			{ id: 1, name: "Groceries", archived: false },
		]);
		if (!target.ok || target.kind !== "create")
			throw new Error("expected create");

		const result = await fileInNewCategory(db, {
			transactionId: tx,
			target,
			today: "2026-10-02",
			who: "Kazon",
		});
		expect(result).toEqual({ ok: true, name: "Books & audio", created: true });

		const made = await db
			.prepare(
				"SELECT id, archived FROM categories WHERE name_key = 'books & audio'",
			)
			.first<{ id: number; archived: number }>();
		expect(made?.archived).toBe(0);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM budget_amounts WHERE category_id = ${made?.id ?? 0}`,
			),
		).toBe(0);
		expect(
			await db
				.prepare(
					"SELECT category_id, category_source, category_confidence FROM transactions WHERE id = ?",
				)
				.bind(tx)
				.first(),
		).toEqual({
			category_id: made?.id,
			category_source: "user",
			category_confidence: null,
		});
		expect(
			await db
				.prepare(
					"SELECT kind, answer FROM maybe_answers ORDER BY id DESC LIMIT 1",
				)
				.first(),
		).toEqual({ kind: "category", answer: "something_else" });
		expect(
			await db
				.prepare("SELECT amount_cents FROM transactions WHERE id = ?")
				.bind(tx)
				.first<{ amount_cents: number }>(),
		).toEqual(before);
	});

	it("adds the purchase to a category that already has the name, without making one", async () => {
		const tx = await maybeRow();
		const groceries = await db
			.prepare("SELECT id FROM categories WHERE name = 'Groceries'")
			.first<{ id: number }>();
		const categoriesBefore = await count(
			"SELECT COUNT(*) AS n FROM categories",
		);
		const result = await fileInNewCategory(db, {
			transactionId: tx,
			target: {
				ok: true,
				kind: "existing",
				id: groceries?.id ?? 0,
				name: "Groceries",
			},
			today: "2026-10-02",
			who: "Kazon",
		});
		expect(result).toEqual({ ok: true, name: "Groceries", created: false });
		expect(await count("SELECT COUNT(*) AS n FROM categories")).toBe(
			categoriesBefore,
		);
		expect(
			await db
				.prepare("SELECT category_id FROM transactions WHERE id = ?")
				.bind(tx)
				.first(),
		).toEqual({ category_id: groceries?.id });
	});

	it("creates nothing when the purchase was answered somewhere else first", async () => {
		const tx = await maybeRow();
		const groceries = await db
			.prepare("SELECT id FROM categories WHERE name = 'Groceries'")
			.first<{ id: number }>();
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(groceries?.id ?? 0, tx)
			.run();
		const categoriesBefore = await count(
			"SELECT COUNT(*) AS n FROM categories",
		);
		const result = await fileInNewCategory(db, {
			transactionId: tx,
			target: {
				ok: true,
				kind: "create",
				name: "Books & audio",
				color: "cat-blue",
			},
			today: "2026-10-02",
			who: "Kazon",
		});
		expect(result).toEqual({ ok: false, reason: "gone" });
		expect(await count("SELECT COUNT(*) AS n FROM categories")).toBe(
			categoriesBefore,
		);
	});

	it("at the limit creates nothing and says why", async () => {
		const tx = await maybeRow();
		const active = await count(
			"SELECT COUNT(*) AS n FROM categories WHERE archived = 0",
		);
		for (let i = active; i < MAX_ACTIVE; i++)
			await db
				.prepare(
					"INSERT INTO categories (name, name_key, icon, color, sort_order) VALUES (?, ?, 'tag', 'cat-blue', ?)",
				)
				.bind(`Extra ${i}`, `extra ${i}`, 100 + i)
				.run();
		const result = await fileInNewCategory(db, {
			transactionId: tx,
			target: {
				ok: true,
				kind: "create",
				name: "Books & audio",
				color: "cat-blue",
			},
			today: "2026-10-02",
			who: "Kazon",
		});
		expect(result).toEqual({ ok: false, reason: "limit" });
		expect(
			await count("SELECT COUNT(*) AS n FROM categories WHERE archived = 0"),
		).toBe(MAX_ACTIVE);
		expect(
			await db
				.prepare("SELECT category_id FROM transactions WHERE id = ?")
				.bind(tx)
				.first(),
		).toEqual({ category_id: null });
	});
});

describe("suggestedCategoryName: the one naming path, and no call when it need not run", () => {
	beforeEach(async () => {
		await resetDemo(db, "2026-09-22");
		await db.batch([
			db.prepare("DELETE FROM transactions"),
			db.prepare("DELETE FROM category_suggestions"),
		]);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	const item = {
		merchantKey: "AUDIBLE*TE3E10I7 WA",
		merchant: "Audible",
		label: "Audible",
	};
	const fakeAi = (answer: unknown = "Books & audio") => {
		const run = vi.fn(async () => answer);
		return { ai: { run } as unknown as Ai, run };
	};

	it("suggests a name from the store's name, avoiding the family's category names", async () => {
		const { ai, run } = fakeAi();
		expect(await suggestedCategoryName(db, ai, item)).toBe("Books & audio");
		expect(run).toHaveBeenCalledTimes(1);
		const [, body] = run.mock.calls[0] as unknown as [
			string,
			{ messages: { content: string }[] },
		];
		expect(body.messages[1]?.content).toContain("Places: Audible");
		expect(body.messages[1]?.content).toContain("Groceries");
	});

	it("names from the store's name, never the transaction's own name or note", async () => {
		const { ai, run } = fakeAi();
		const own = {
			merchantKey: "SQ *LUPITAS TAQ 2210",
			merchant: "Lupita's Taqueria",
			label: "Team lunch, paid back",
		};
		await suggestedCategoryName(db, ai, own);
		const [, body] = run.mock.calls[0] as unknown as [
			string,
			{ messages: { content: string }[] },
		];
		expect(body.messages[1]?.content).toContain("Places: Lupita's Taqueria");
		expect(body.messages[1]?.content).not.toContain("Team lunch");
	});

	it("makes no call when the categories switch is off", async () => {
		await saveAiSwitches(db, { categories: false });
		const { ai, run } = fakeAi();
		expect(await suggestedCategoryName(db, ai, item)).toBeNull();
		expect(run).not.toHaveBeenCalled();
	});

	it("makes no call and gives no name without an AI binding", async () => {
		expect(await suggestedCategoryName(db, undefined, item)).toBeNull();
	});

	it("gives no name when the answer is unusable", async () => {
		const { ai } = fakeAi("Groceries");
		expect(await suggestedCategoryName(db, ai, item)).toBeNull();
	});

	it("prefers a pending suggestion for the same store and makes no call", async () => {
		const suggestion = await db
			.prepare(
				"INSERT INTO category_suggestions (name, status) VALUES ('Books & audio', 'pending') RETURNING id",
			)
			.first<{ id: number }>();
		await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, category_suggestion_id)
				VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-01', 1499, ?, ?)`,
			)
			.bind(
				`plaid-${crypto.randomUUID()}`,
				item.merchantKey,
				suggestion?.id ?? null,
			)
			.run();
		const { ai, run } = fakeAi();
		expect(await suggestedCategoryName(db, ai, item)).toBe("Books & audio");
		expect(run).not.toHaveBeenCalled();
	});
});
