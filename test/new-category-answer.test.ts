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

// A real transaction for the naming to be kept against (maybe_names references transactions).
const transactionFor = async (raw: string) =>
	(
		await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name)
				VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-01', 1499, ?)
				RETURNING id`,
			)
			.bind(`plaid-${crypto.randomUUID()}`, raw)
			.first<{ id: number }>()
	)?.id ?? 0;

describe("suggestedCategoryName: the one naming path, and no call when it need not run", () => {
	let item: {
		transactionId: number;
		merchantKey: string;
		merchant: string;
		label: string;
	};
	beforeEach(async () => {
		await resetDemo(db, "2026-09-22");
		await db.batch([
			db.prepare("DELETE FROM transactions"),
			db.prepare("DELETE FROM category_suggestions"),
		]);
		vi.spyOn(console, "error").mockImplementation(() => {});
		item = {
			transactionId: await transactionFor("AUDIBLE*TE3E10I7 WA"),
			merchantKey: "AUDIBLE*TE3E10I7 WA",
			merchant: "Audible",
			label: "Audible",
		};
	});

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
			transactionId: await transactionFor("SQ *LUPITAS TAQ 2210"),
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

describe("suggestedCategoryName keeps one answer per transaction (decision 161)", () => {
	beforeEach(async () => {
		await resetDemo(db, "2026-09-22");
		await db.batch([
			db.prepare("DELETE FROM transactions"),
			db.prepare("DELETE FROM category_suggestions"),
			db.prepare("DELETE FROM never_suggest_rules"),
		]);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	const merchantKey = "AUDIBLE*TE3E10I7 WA";
	const itemFor = async (raw = merchantKey) => ({
		transactionId: await transactionFor(raw),
		merchantKey,
		merchant: "Audible",
	});
	const aiReturning = (answer: unknown) => {
		const run = vi.fn(async () => answer);
		return { ai: { run } as unknown as Ai, run };
	};
	const keptRows = async (transactionId: number) =>
		(
			await db
				.prepare("SELECT name FROM maybe_names WHERE transaction_id = ?")
				.bind(transactionId)
				.all<{ name: string | null }>()
		).results;

	it("a second draw reads the kept name and makes no AI call", async () => {
		const item = await itemFor();
		const first = aiReturning("Books & audio");
		expect(await suggestedCategoryName(db, first.ai, item)).toBe(
			"Books & audio",
		);
		const second = aiReturning("Hobby supplies");
		expect(await suggestedCategoryName(db, second.ai, item)).toBe(
			"Books & audio",
		);
		expect(first.run).toHaveBeenCalledTimes(1);
		expect(second.run).not.toHaveBeenCalled();
		expect(await keptRows(item.transactionId)).toEqual([
			{ name: "Books & audio" },
		]);
	});

	it("a 'no name' answer is kept and never asked again", async () => {
		const item = await itemFor();
		const first = aiReturning("Groceries");
		expect(await suggestedCategoryName(db, first.ai, item)).toBeNull();
		const second = aiReturning("Books & audio");
		expect(await suggestedCategoryName(db, second.ai, item)).toBeNull();
		expect(second.run).not.toHaveBeenCalled();
		expect(await keptRows(item.transactionId)).toEqual([{ name: null }]);
	});

	it("an AI failure is kept as no name and not re-asked", async () => {
		const item = await itemFor();
		const run = vi.fn(async () => {
			throw new Error("timeout");
		});
		const ai = { run } as unknown as Ai;
		expect(await suggestedCategoryName(db, ai, item)).toBeNull();
		expect(await suggestedCategoryName(db, ai, item)).toBeNull();
		expect(run).toHaveBeenCalledTimes(1);
		expect(await keptRows(item.transactionId)).toEqual([{ name: null }]);
	});

	it("ten parallel first requests make exactly one AI call and store one row", async () => {
		const item = await itemFor();
		// The call takes a moment, so every request is in flight before the first one finishes.
		const run = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return "Books & audio";
		});
		const ai = { run } as unknown as Ai;
		const answers = await Promise.all(
			Array.from({ length: 10 }, () => suggestedCategoryName(db, ai, item)),
		);
		expect(run).toHaveBeenCalledTimes(1);
		expect(await keptRows(item.transactionId)).toEqual([
			{ name: "Books & audio" },
		]);
		// The winner has the name; a request that lost the claim shows no name on that draw.
		expect(answers).toContain("Books & audio");
		expect(answers.every((a) => a === null || a === "Books & audio")).toBe(
			true,
		);
	});

	it("a request that loses the claim returns no name and makes no AI call while the winner waits", async () => {
		const item = await itemFor();
		// The winner has claimed the transaction and is still asking Workers AI: its row is there, with no name yet.
		await db
			.prepare(
				"INSERT INTO maybe_names (transaction_id, name, claim) VALUES (?, NULL, 'claim-of-the-winner')",
			)
			.bind(item.transactionId)
			.run();
		const loser = aiReturning("Books & audio");
		expect(await suggestedCategoryName(db, loser.ai, item)).toBeNull();
		expect(loser.run).not.toHaveBeenCalled();
	});

	it("after the winner finishes, a later draw returns its name with no call", async () => {
		const item = await itemFor();
		const winner = aiReturning("Books & audio");
		expect(await suggestedCategoryName(db, winner.ai, item)).toBe(
			"Books & audio",
		);
		const later = aiReturning("Hobby supplies");
		expect(await suggestedCategoryName(db, later.ai, item)).toBe(
			"Books & audio",
		);
		expect(later.run).not.toHaveBeenCalled();
	});

	it("a failed AI answer stays 'no name' and is never re-asked after the claim", async () => {
		const item = await itemFor();
		const run = vi.fn(async () => {
			throw new Error("timeout");
		});
		const ai = { run } as unknown as Ai;
		const answers = await Promise.all(
			Array.from({ length: 5 }, () => suggestedCategoryName(db, ai, item)),
		);
		expect(answers.every((a) => a === null)).toBe(true);
		expect(await suggestedCategoryName(db, ai, item)).toBeNull();
		expect(run).toHaveBeenCalledTimes(1);
		expect(await keptRows(item.transactionId)).toEqual([{ name: null }]);
	});

	it("a completion whose claim was replaced changes nothing: a reused row number keeps the new request's name", async () => {
		const item = await itemFor();
		const other = {
			transactionId: item.transactionId,
			merchantKey: "HARDWARE BARN",
			merchant: "Hardware Barn",
		};
		let bAnswer: string | null | undefined;
		// Request A claims the transaction, then, while Workers AI is still answering, the purchase is deleted (its row
		// goes with it) and a new one reuses the id. Request B claims that id and finishes with its own name.
		const runA = vi.fn(async () => {
			await db
				.prepare("DELETE FROM transactions WHERE id = ?")
				.bind(item.transactionId)
				.run();
			await db
				.prepare(
					`INSERT INTO transactions (id, plaid_transaction_id, account_id, date, amount_cents, raw_name)
				VALUES (?, ?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', 2300, 'HARDWARE BARN')`,
				)
				.bind(item.transactionId, `plaid-${crypto.randomUUID()}`)
				.run();
			bAnswer = await suggestedCategoryName(
				db,
				aiReturning("Hobby supplies").ai,
				other,
			);
			return "Books & audio";
		});
		const answerA = await suggestedCategoryName(
			db,
			{ run: runA } as unknown as Ai,
			item,
		);
		// A's answer is for a purchase that is gone: it is dropped, and B's row and name are untouched.
		expect(answerA).toBeNull();
		expect(bAnswer).toBe("Hobby supplies");
		expect(await keptRows(item.transactionId)).toEqual([
			{ name: "Hobby supplies" },
		]);
	});

	it("the stops before the claim make no claim: no row is inserted", async () => {
		// The switch is off: no claim, no call.
		const offItem = await itemFor("SWITCH OFF STORE");
		await saveAiSwitches(db, { categories: false });
		const off = aiReturning("Books & audio");
		await suggestedCategoryName(db, off.ai, offItem);
		expect(off.run).not.toHaveBeenCalled();
		await saveAiSwitches(db, { categories: true });

		// A pending suggestion for the store answers it: no claim, no call.
		const suggestion = await db
			.prepare(
				"INSERT INTO category_suggestions (name, status) VALUES ('Books & audio', 'pending') RETURNING id",
			)
			.first<{ id: number }>();
		const pendingTx = await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, category_suggestion_id)
				VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-01', 1499, ?, ?)
				RETURNING id`,
			)
			.bind(`plaid-${crypto.randomUUID()}`, merchantKey, suggestion?.id ?? null)
			.first<{ id: number }>();
		const pending = aiReturning("Hobby supplies");
		const pendingItem = {
			transactionId: pendingTx?.id ?? 0,
			merchantKey,
			merchant: "Audible",
		};
		expect(await suggestedCategoryName(db, pending.ai, pendingItem)).toBe(
			"Books & audio",
		);
		expect(pending.run).not.toHaveBeenCalled();

		// A Never suggest for a new category stops it: no claim, no call.
		const neverItem = await itemFor();
		await db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES (?, 'new_category', '2026-10-01')",
			)
			.bind(merchantKey)
			.run();
		const never = aiReturning("Hobby supplies");
		expect(await suggestedCategoryName(db, never.ai, neverItem)).toBeNull();
		expect(never.run).not.toHaveBeenCalled();

		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM maybe_names WHERE transaction_id IN (?, ?, ?)",
				)
				.bind(
					offItem.transactionId,
					pendingItem.transactionId,
					neverItem.transactionId,
				)
				.first<{ n: number }>(),
		).toMatchObject({ n: 0 });
	});

	it("deleting the transaction removes its kept name (ON DELETE CASCADE)", async () => {
		const item = await itemFor();
		await suggestedCategoryName(db, aiReturning("Books & audio").ai, item);
		await db
			.prepare("DELETE FROM transactions WHERE id = ?")
			.bind(item.transactionId)
			.run();
		expect(
			await db
				.prepare("SELECT COUNT(*) AS n FROM maybe_names")
				.first<{ n: number }>(),
		).toMatchObject({ n: 0 });
	});

	it("a new transaction that reuses the row number gets no old name", async () => {
		const item = await itemFor();
		await suggestedCategoryName(db, aiReturning("Books & audio").ai, item);
		await db
			.prepare("DELETE FROM transactions WHERE id = ?")
			.bind(item.transactionId)
			.run();
		await db
			.prepare(
				`INSERT INTO transactions (id, plaid_transaction_id, account_id, date, amount_cents, raw_name)
				VALUES (?, ?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', 2300, 'HARDWARE BARN')`,
			)
			.bind(item.transactionId, `plaid-${crypto.randomUUID()}`)
			.run();
		const fresh = aiReturning("Hobby supplies");
		const reused = {
			transactionId: item.transactionId,
			merchantKey: "HARDWARE BARN",
			merchant: "Hardware Barn",
		};
		expect(await suggestedCategoryName(db, fresh.ai, reused)).toBe(
			"Hobby supplies",
		);
		expect(fresh.run).toHaveBeenCalledTimes(1);
	});

	it("a kept name is not shown, and no call is made, while the categories switch is off", async () => {
		const item = await itemFor();
		await suggestedCategoryName(db, aiReturning("Books & audio").ai, item);
		await saveAiSwitches(db, { categories: false });
		const later = aiReturning("Books & audio");
		expect(await suggestedCategoryName(db, later.ai, item)).toBeNull();
		expect(later.run).not.toHaveBeenCalled();
	});

	it("a Never suggest for a new category stops a kept name before any read shows it", async () => {
		const item = await itemFor();
		await suggestedCategoryName(db, aiReturning("Books & audio").ai, item);
		await db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES (?, 'new_category', '2026-10-01')",
			)
			.bind(merchantKey)
			.run();
		const later = aiReturning("Books & audio");
		expect(await suggestedCategoryName(db, later.ai, item)).toBeNull();
		expect(later.run).not.toHaveBeenCalled();
	});
});

describe("the filing finds the category the family has, however its key was stored", () => {
	beforeEach(async () => {
		await resetDemo(db, "2026-09-22");
		await db.batch([
			db.prepare("DELETE FROM transactions"),
			db.prepare("DELETE FROM category_suggestions"),
		]);
	});

	async function maybeTx(raw: string) {
		const eatingOut = await db
			.prepare("SELECT id FROM categories WHERE name = 'Eating Out'")
			.first<{ id: number }>();
		const row = await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name,
					category_confidence, jev_category_id)
				VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', 1499, ?, 0.58, ?)
				RETURNING id`,
			)
			.bind(`plaid-${crypto.randomUUID()}`, raw, eatingOut?.id ?? null)
			.first<{ id: number }>();
		return row?.id ?? 0;
	}

	it("files into a category kept by migration 0052 with a legacy key, found by its id", async () => {
		// Migration 0052 kept this key as SQLite folded it (only ASCII), so the key is not the JS-folded "école".
		const legacy = await db
			.prepare(
				"INSERT INTO categories (name, name_key, icon, color, sort_order) VALUES ('École', 'École', 'tag', 'cat-blue', 90) RETURNING id",
			)
			.first<{ id: number }>();
		const tx = await maybeTx("ECOLE PAYMENT");
		const target = newCategoryTarget("école", [
			{ id: legacy?.id ?? 0, name: "École", archived: false },
		]);
		expect(target).toEqual({
			ok: true,
			kind: "existing",
			id: legacy?.id,
			name: "École",
		});
		const result = await fileInNewCategory(db, {
			transactionId: tx,
			target: target as Extract<typeof target, { ok: true }>,
			today: "2026-10-02",
			who: "Kazon",
		});
		expect(result).toEqual({ ok: true, name: "École", created: false });
		expect(
			await db
				.prepare(
					"SELECT category_id, category_source FROM transactions WHERE id = ?",
				)
				.bind(tx)
				.first(),
		).toEqual({ category_id: legacy?.id, category_source: "user" });
	});

	it("a create that lost a race to the same name files into the category that now exists, and reports its stored name", async () => {
		// The pre-check saw no "Books & audio"; another person made "books & audio" before the batch ran.
		const tx = await maybeTx("AUDIBLE*TE3E10I7 WA");
		await db
			.prepare(
				"INSERT INTO categories (name, name_key, icon, color, sort_order) VALUES ('books & audio', 'books & audio', 'tag', 'cat-blue', 91)",
			)
			.run();
		const made = await db
			.prepare("SELECT id FROM categories WHERE name = 'books & audio'")
			.first<{ id: number }>();
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
		expect(result).toEqual({ ok: true, name: "books & audio", created: false });
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM categories WHERE name_key = 'books & audio'",
				)
				.first<{ n: number }>(),
		).toEqual({ n: 1 });
		expect(
			await db
				.prepare("SELECT category_id FROM transactions WHERE id = ?")
				.bind(tx)
				.first(),
		).toEqual({ category_id: made?.id });
	});

	it("an answer that another person made first is stale, even when the list is also full", async () => {
		const tx = await maybeTx("STALE PURCHASE");
		const groceries = await db
			.prepare("SELECT id FROM categories WHERE name = 'Groceries'")
			.first<{ id: number }>();
		// Someone else answered this purchase after the queue was read...
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(groceries?.id ?? 0, tx)
			.run();
		// ...and the list reached its 50 active categories too.
		const active = await db
			.prepare("SELECT COUNT(*) AS n FROM categories WHERE archived = 0")
			.first<{ n: number }>();
		for (let i = active?.n ?? 0; i < MAX_ACTIVE; i++)
			await db
				.prepare(
					"INSERT INTO categories (name, name_key, icon, color, sort_order) VALUES (?, ?, 'tag', 'cat-blue', ?)",
				)
				.bind(`Filler ${i}`, `filler ${i}`, 300 + i)
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
		expect(result).toEqual({ ok: false, reason: "gone" });
	});

	it("a Never suggest for a new category added after the name was drawn refuses the create: nothing made or filed", async () => {
		const tx = await maybeTx("AUDIBLE*TE3E10I7 WA");
		// The name was drawn and cached, then the store got its Never suggest for a new category.
		await db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES ('AUDIBLE*TE3E10I7 WA', 'new_category', '2026-10-01')",
			)
			.run();
		const before = await db
			.prepare("SELECT COUNT(*) AS n FROM categories")
			.first<{ n: number }>();
		const answers = await db
			.prepare("SELECT COUNT(*) AS n FROM maybe_answers")
			.first<{ n: number }>();
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
		expect(
			await db
				.prepare("SELECT COUNT(*) AS n FROM categories")
				.first<{ n: number }>(),
		).toEqual(before);
		expect(
			await db
				.prepare(
					"SELECT category_id, category_source FROM transactions WHERE id = ?",
				)
				.bind(tx)
				.first(),
		).toEqual({ category_id: null, category_source: null });
		expect(
			await db
				.prepare("SELECT COUNT(*) AS n FROM maybe_answers")
				.first<{ n: number }>(),
		).toEqual(answers);
	});

	it("without a Never suggest the same create still makes and files", async () => {
		const tx = await maybeTx("AUDIBLE*TE3E10I7 WA");
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
		expect(result).toEqual({ ok: true, name: "Books & audio", created: true });
	});
});

describe("a Never suggest for a new category stops the row: no pending name and no AI call", () => {
	beforeEach(async () => {
		await resetDemo(db, "2026-09-22");
		await db.batch([
			db.prepare("DELETE FROM transactions"),
			db.prepare("DELETE FROM category_suggestions"),
			db.prepare("DELETE FROM never_suggest_rules"),
		]);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("gives no pending name and makes no call for a store with that rule", async () => {
		const suggestion = await db
			.prepare(
				"INSERT INTO category_suggestions (name, status) VALUES ('Books & audio', 'pending') RETURNING id",
			)
			.first<{ id: number }>();
		const tx = await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, category_suggestion_id)
				VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-01', 1499, 'AUDIBLE*TE3E10I7 WA', ?)
				RETURNING id`,
			)
			.bind(`plaid-${crypto.randomUUID()}`, suggestion?.id ?? null)
			.first<{ id: number }>();
		await db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES ('AUDIBLE*TE3E10I7 WA', 'new_category', '2026-10-01')",
			)
			.run();
		const run = vi.fn(async () => "Books & audio");
		const ai = { run } as unknown as Ai;
		const item = {
			transactionId: tx?.id ?? 0,
			merchantKey: "AUDIBLE*TE3E10I7 WA",
			merchant: "Audible",
		};
		expect(await suggestedCategoryName(db, ai, item)).toBeNull();
		expect(run).not.toHaveBeenCalled();
	});
});
