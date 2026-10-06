import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { JEV_THRESHOLD } from "../src/ai/categorize";
import { saveAiSwitches } from "../src/db/ai-switches";
import {
	createFromSuggestion,
	dismissSuggestion,
	namesToAvoid,
	noneFitTransactions,
	pendingSuggestions,
	saveSuggestion,
} from "../src/db/category-suggestions";
import { saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";

// Which transactions count as "Jev was sure none of the categories fit" (spec §7, #51), where a
// suggestion and the transactions behind it are kept, and what a person's Create and Dismiss do.

const db = env.DB;
const CHECKING = 1;

type Over = {
	rawName?: string;
	merchantName?: string | null;
	plaidCategory?: string | null;
	amountCents?: number;
	confidence?: number | null;
	noneFit?: 0 | 1;
	jevCategoryId?: number | null;
	categoryId?: number | null;
	categorySource?: string | null;
	excluded?: 0 | 1;
	income?: 0 | 1;
	isSplit?: 0 | 1;
	parentId?: number | null;
	pending?: 0 | 1;
	suggestionId?: number | null;
	note?: string | null;
	date?: string;
};

/** One transaction; by default a confident "none of these fit" for $15 of ENTERTAINMENT. */
async function add(over: Over = {}): Promise<number> {
	const o = {
		rawName: "NETFLIX.COM",
		merchantName: null,
		plaidCategory: "ENTERTAINMENT",
		amountCents: 1500,
		confidence: 0.93,
		noneFit: 1,
		jevCategoryId: null,
		categoryId: null,
		categorySource: null,
		excluded: 0,
		income: 0,
		isSplit: 0,
		parentId: null,
		pending: 0,
		suggestionId: null,
		note: null,
		date: "2026-09-20",
		...over,
	};
	const result = await db
		.prepare(
			`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, plaid_category,
				category_id, category_source, category_confidence, jev_category_id, jev_none_fit,
				excluded, flag_income, is_split, parent_id, pending, category_suggestion_id, note)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			CHECKING,
			o.date,
			o.amountCents,
			o.rawName,
			o.merchantName,
			o.plaidCategory,
			o.categoryId,
			o.categorySource,
			o.confidence,
			o.jevCategoryId,
			o.noneFit,
			o.excluded,
			o.income,
			o.isSplit,
			o.parentId,
			o.pending,
			o.suggestionId,
			o.note,
		)
		.run();
	return Number(result.meta.last_row_id);
}
const ids = (rows: { id: number }[]) =>
	rows.map((r) => r.id).sort((a, b) => a - b);

const row = (id: number) =>
	db
		.prepare(
			"SELECT category_id, category_source, category_confidence, note, updated_by, category_suggestion_id FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<{
			category_id: number | null;
			category_source: string | null;
			category_confidence: number | null;
			note: string | null;
			updated_by: string | null;
			category_suggestion_id: number | null;
		}>();
const suggestion = (id: number) =>
	db
		.prepare(
			"SELECT name, status, decided_at FROM category_suggestions WHERE id = ?",
		)
		.bind(id)
		.first<{ name: string; status: string; decided_at: string | null }>();
const categories = async () =>
	(
		await db
			.prepare(
				"SELECT id, name, icon, color, archived FROM categories ORDER BY id",
			)
			.all<{
				id: number;
				name: string;
				icon: string;
				color: string;
				archived: number;
			}>()
	).results;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchants"),
		db.prepare("DELETE FROM category_suggestions"),
	]);
});

describe("noneFitTransactions: what counts as Jev being sure no category fits", () => {
	it("counts a confident none-fit: a high confidence, no pick of Jev's, nothing chosen yet", async () => {
		const id = await add();
		expect(await noneFitTransactions(db)).toEqual([
			{
				id,
				theme: "ENTERTAINMENT",
				merchantKey: "NETFLIX.COM",
				merchant: "Netflix.com",
			},
		]);
	});

	it("counts one at exactly the threshold, and leaves out a low-confidence none-fit, which behaves like unsure", async () => {
		const sure = await add({ confidence: JEV_THRESHOLD });
		await add({ confidence: JEV_THRESHOLD - 0.01 });
		await add({ confidence: 0.4 });
		expect(ids(await noneFitTransactions(db))).toEqual([sure]);
	});

	it("leaves out an answer Jev gave while Guess categories was off, which stores no pick but isn't none-fit", async () => {
		await add({ noneFit: 0, confidence: 0.97 });
		expect(await noneFitTransactions(db)).toEqual([]);
	});

	it("leaves out one Jev did pick a category for, however it was decided after", async () => {
		await add({ noneFit: 0, jevCategoryId: 2, confidence: 0.6 });
		await add({ noneFit: 1, jevCategoryId: 2, confidence: 0.95 });
		expect(await noneFitTransactions(db)).toEqual([]);
	});

	it("leaves out a transaction a person or a rule has since categorized", async () => {
		await add({ categoryId: 2, categorySource: "user" });
		await add({ categoryId: 2, categorySource: "merchant_rule" });
		expect(await noneFitTransactions(db)).toEqual([]);
	});

	it("leaves out what isn't spending that needs a category: excluded, income, money in, split parts and parents", async () => {
		await add({ excluded: 1 });
		await add({ income: 1 });
		await add({ amountCents: -1500 });
		const parent = await add({ isSplit: 1, categoryId: null });
		await add({ parentId: parent, categoryId: 2, categorySource: "user" });
		expect(await noneFitTransactions(db)).toEqual([]);
	});

	it("leaves out a pending transaction, which the bank may still change or replace", async () => {
		await add({ pending: 1 });
		expect(await noneFitTransactions(db)).toEqual([]);
	});

	it("leaves out one that is already behind a suggestion, so each is asked about once", async () => {
		const made = await saveSuggestion(db, "Subscriptions", [
			await add(),
			await add({ rawName: "HULU" }),
			await add({ rawName: "SPOTIFY" }),
		]);
		expect(made).not.toBeNull();
		expect(await noneFitTransactions(db)).toEqual([]);
	});

	it("takes Plaid's category as the theme, and the merchant when Plaid sent none", async () => {
		const withHint = await add({
			plaidCategory: "TRANSPORTATION",
			rawName: "UBER *TRIP",
		});
		const without = await add({
			plaidCategory: null,
			rawName: "NEIGHBOR KID",
			merchantName: null,
		});
		const blank = await add({ plaidCategory: "", rawName: "NEIGHBOR KID" });
		const found = await noneFitTransactions(db);
		expect(found.find((r) => r.id === withHint)?.theme).toBe("TRANSPORTATION");
		expect(found.find((r) => r.id === without)?.theme).toBe(
			"merchant:NEIGHBOR KID",
		);
		expect(found.find((r) => r.id === blank)?.theme).toBe(
			"merchant:NEIGHBOR KID",
		);
	});

	it("names each merchant as a person did, else as Plaid did, else by its tidied bank text", async () => {
		const chosen = await add({
			rawName: "SQ *CHEWY 0412",
			merchantName: "Chewy.com",
		});
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('Chewy.com', 'Chewy')",
			)
			.run();
		const plaid = await add({
			rawName: "TST* PETSMART 22",
			merchantName: "Petsmart",
		});
		const tidied = await add({ rawName: "BANFIELD PET HOSPITAL" });
		const found = await noneFitTransactions(db);
		const merchant = (id: number) => found.find((r) => r.id === id)?.merchant;
		expect(merchant(chosen)).toBe("Chewy");
		expect(merchant(plaid)).toBe("Petsmart");
		expect(merchant(tidied)).toBe("Banfield pet hospital");
	});
});

describe("saveSuggestion", () => {
	it("keeps a pending suggestion with the transactions behind it, and creates no category", async () => {
		const before = (await categories()).length;
		const a = await add();
		const b = await add({ rawName: "HULU" });
		const c = await add({ rawName: "SPOTIFY" });
		const id = await saveSuggestion(db, "Subscriptions", [a, b, c]);
		expect(await suggestion(id as number)).toMatchObject({
			name: "Subscriptions",
			status: "pending",
			decided_at: null,
		});
		expect((await row(a))?.category_suggestion_id).toBe(id);
		expect((await row(b))?.category_suggestion_id).toBe(id);
		// Nothing is created without a person (spec §7).
		expect(await categories()).toHaveLength(before);
		expect((await row(a))?.category_id).toBeNull();
	});

	it("keeps an empty one when no usable name came, so that group isn't asked about again", async () => {
		const rows = [
			await add(),
			await add({ rawName: "HULU" }),
			await add({ rawName: "SPOTIFY" }),
		];
		const id = await saveSuggestion(db, null, rows);
		expect(await suggestion(id as number)).toMatchObject({
			name: "",
			status: "none",
		});
		expect(await noneFitTransactions(db)).toEqual([]);
	});

	it("puts a second group with the same name, in any capitals, behind the pending suggestion that has it", async () => {
		const [first, second] = await Promise.all([
			saveSuggestion(db, "Subscriptions", [
				await add(),
				await add({ rawName: "HULU" }),
				await add({ rawName: "SPOTIFY" }),
			]),
			saveSuggestion(db, "subscriptions", [
				await add({ rawName: "HULU2" }),
				await add({ rawName: "SPOTIFY2" }),
				await add({ rawName: "MAX" }),
			]),
		]);
		expect(second).toBe(first);
		const { results } = await db
			.prepare("SELECT COUNT(*) AS n FROM category_suggestions")
			.all<{ n: number }>();
		expect(results[0]?.n).toBe(1);
	});

	it("doesn't take a transaction a person categorized while the name was being asked for", async () => {
		const a = await add();
		const b = await add({ rawName: "HULU" });
		const c = await add({ rawName: "SPOTIFY" });
		await db
			.prepare(
				"UPDATE transactions SET category_id = 2, category_source = 'user' WHERE id = ?",
			)
			.bind(b)
			.run();
		const id = await saveSuggestion(db, "Subscriptions", [a, b, c]);
		expect((await row(a))?.category_suggestion_id).toBe(id);
		expect((await row(b))?.category_suggestion_id).toBeNull();
	});

	it("does not leave an empty suggestion when its candidate purchases changed while Jev answered", async () => {
		const a = await add();
		const b = await add({ rawName: "HULU" });
		const c = await add({ rawName: "SPOTIFY" });
		await db
			.prepare(
				"UPDATE transactions SET category_id=2, category_source='user' WHERE id IN (?, ?, ?)",
			)
			.bind(a, b, c)
			.run();
		expect(await saveSuggestion(db, "Subscriptions", [a, b, c])).toBeNull();
		expect(
			await db.prepare("SELECT COUNT(*) n FROM category_suggestions").first(),
		).toMatchObject({ n: 0 });
	});

	it("does not group split parents, and releases their old suggestion link", async () => {
		const { id, made } = await (async () => {
			const items = [
				await add(),
				await add({ rawName: "HULU" }),
				await add({ rawName: "SPOTIFY" }),
			];
			return {
				id: await saveSuggestion(db, "Subscriptions", items),
				made: items,
			};
		})();
		await saveSplit(
			db,
			made[0] as number,
			[
				{ categoryId: 1, amountCents: 750 },
				{ categoryId: 2, amountCents: 750 },
			],
			"person",
		);
		expect(
			(await pendingSuggestions(db)).flatMap((s) => s.rows.map((r) => r.id)),
		).not.toContain(made[0]);
		expect(
			await createFromSuggestion(
				db,
				id as number,
				{ ticked: made, shown: made, notes: {} },
				"person",
			),
		).toMatchObject({ ok: true, moved: 2 });
		expect((await row(made[0] as number))?.category_suggestion_id).toBeNull();
	});

	it("keeps a suggestion available while any eligible purchase remains", async () => {
		const items = [
			await add(),
			await add({ rawName: "HULU" }),
			await add({ rawName: "SPOTIFY" }),
		];
		const id = (await saveSuggestion(db, "Subscriptions", items)) as number;
		await db
			.prepare(
				"UPDATE transactions SET category_id=2, category_source='user' WHERE id=?",
			)
			.bind(items[0])
			.run();
		expect((await pendingSuggestions(db))[0]?.rows).toHaveLength(2);
		expect(await suggestion(id)).toMatchObject({ status: "pending" });
	});

	it("clears the prior suggestion link from unticked and newly attached rows when Create succeeds", async () => {
		const { id, made } = await (async () => {
			const items = [
				await add(),
				await add({ rawName: "HULU" }),
				await add({ rawName: "SPOTIFY" }),
				await add({ rawName: "LATE" }),
			];
			return {
				id: await saveSuggestion(db, "Subscriptions", items),
				made: items,
			};
		})();
		const result = await createFromSuggestion(
			db,
			id as number,
			{ ticked: made.slice(0, 2), shown: made.slice(0, 3), notes: {} },
			"person",
		);
		expect(result).toMatchObject({
			ok: true,
			leftOut: expect.arrayContaining([made[2], made[3]]),
		});
		for (const tx of [made[2] as number, made[3] as number])
			expect((await row(tx))?.category_suggestion_id).toBeNull();
	});

	it("does not categorize a row excluded or made ineligible while the form is open", async () => {
		const made = [
			await add(),
			await add({ rawName: "HULU" }),
			await add({ rawName: "SPOTIFY" }),
			await add({ rawName: "MAX" }),
		];
		const id = (await saveSuggestion(db, "Subscriptions", made)) as number;
		await db
			.prepare(
				`CREATE TRIGGER exclude_during_create AFTER UPDATE OF decided_at ON category_suggestions WHEN NEW.status='pending' AND OLD.status='pending' AND NEW.decided_at IS NOT NULL BEGIN UPDATE transactions SET excluded=1 WHERE category_suggestion_id=NEW.id; END`,
			)
			.run();
		const result = await createFromSuggestion(
			db,
			id,
			{ ticked: made, shown: made, notes: {} },
			"person",
		);
		await db.prepare("DROP TRIGGER exclude_during_create").run();
		expect(result).toMatchObject({ ok: false, reason: "invalid" });
		for (const tx of made) expect((await row(tx))?.category_id).toBeNull();
	});

	it("does not create or move anything if another tab dismisses during Create", async () => {
		const made = [
			await add(),
			await add({ rawName: "HULU" }),
			await add({ rawName: "SPOTIFY" }),
			await add({ rawName: "MAX" }),
		];
		const id = (await saveSuggestion(db, "Subscriptions", made)) as number;
		await db
			.prepare(
				`CREATE TRIGGER dismiss_during_create AFTER UPDATE OF decided_at ON category_suggestions WHEN NEW.status='pending' AND OLD.status='pending' AND NEW.decided_at IS NOT NULL BEGIN UPDATE category_suggestions SET status='dismissed' WHERE id=NEW.id; END`,
			)
			.run();
		const before = (await categories()).length;
		const result = await createFromSuggestion(
			db,
			id,
			{ ticked: made, shown: made, notes: {} },
			"person",
		);
		await db.prepare("DROP TRIGGER dismiss_during_create").run();
		expect(result).toEqual({ ok: false, reason: "gone" });
		expect(await categories()).toHaveLength(before);
		expect(await suggestion(id)).toMatchObject({ status: "dismissed" });
		for (const tx of made) expect((await row(tx))?.category_id).toBeNull();
	});

	it("handles a category name taken after validation without making a duplicate", async () => {
		const made = [
			await add(),
			await add({ rawName: "HULU" }),
			await add({ rawName: "SPOTIFY" }),
			await add({ rawName: "MAX" }),
		];
		const id = (await saveSuggestion(db, "Subscriptions", made)) as number;
		await db
			.prepare(
				`CREATE TRIGGER take_name_during_create AFTER UPDATE OF decided_at ON category_suggestions WHEN NEW.status='pending' AND OLD.status='pending' AND NEW.decided_at IS NOT NULL BEGIN INSERT INTO categories(name,icon,color,sort_order) VALUES(NEW.name,'tag','cat-blue',99); END`,
			)
			.run();
		const result = await createFromSuggestion(
			db,
			id,
			{ ticked: made, shown: made, notes: {} },
			"person",
		);
		await db.prepare("DROP TRIGGER take_name_during_create").run();
		expect(result).toMatchObject({
			ok: false,
			reason: "invalid",
			error: "That name is taken.",
		});
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) n FROM categories WHERE name='Subscriptions' COLLATE NOCASE",
				)
				.first(),
		).toMatchObject({ n: 1 });
	});

	it("enforces the 50 active category limit in the Create write", async () => {
		const made = [
			await add(),
			await add({ rawName: "HULU" }),
			await add({ rawName: "SPOTIFY" }),
			await add({ rawName: "MAX" }),
		];
		const id = (await saveSuggestion(db, "Subscriptions", made)) as number;
		const active = (await categories()).filter((c) => !c.archived).length;
		for (let i = active; i < 49; i++)
			await db
				.prepare(
					"INSERT INTO categories(name,icon,color,sort_order) VALUES(?,'tag','cat-blue',?)",
				)
				.bind(`Limit ${i}`, 100 + i)
				.run();
		await db
			.prepare(
				`CREATE TRIGGER fill_limit_during_create AFTER UPDATE OF decided_at ON category_suggestions WHEN NEW.status='pending' AND OLD.status='pending' AND NEW.decided_at IS NOT NULL BEGIN INSERT INTO categories(name,icon,color,sort_order) VALUES('Concurrent category','tag','cat-blue',999); END`,
			)
			.run();
		const result = await createFromSuggestion(
			db,
			id,
			{ ticked: made, shown: made, notes: {} },
			"person",
		);
		await db.prepare("DROP TRIGGER fill_limit_during_create").run();
		expect(result).toMatchObject({
			ok: false,
			reason: "invalid",
			error: "Tally has room for 50 categories. Archive one to add another.",
		});
		expect((await categories()).filter((c) => !c.archived)).toHaveLength(50);
	});
});

describe("namesToAvoid", () => {
	it("holds every category, archived ones too, and every name a person dismissed, but not a pending one", async () => {
		await db
			.prepare("UPDATE categories SET archived = 1 WHERE name = 'Gas'")
			.run();
		const pending = await saveSuggestion(db, "Subscriptions", [
			await add(),
			await add({ rawName: "HULU" }),
			await add({ rawName: "SPOTIFY" }),
		]);
		const dismissed = await saveSuggestion(db, "Pet Care", [
			await add({ rawName: "CHEWY" }),
			await add({ rawName: "BANFIELD" }),
			await add({ rawName: "PETSMART" }),
		]);
		await dismissSuggestion(db, dismissed as number);
		const avoid = await namesToAvoid(db);
		expect(avoid).toEqual(
			expect.arrayContaining([
				"Groceries",
				"Eating Out",
				"Gas",
				"Kids",
				"Household",
				"Pet Care",
			]),
		);
		expect(avoid).not.toContain("Subscriptions");
		expect(pending).not.toBeNull();
	});
});

describe("pendingSuggestions: what Settings shows", () => {
	async function made(name: string, n: number, theme = "ENTERTAINMENT") {
		const made: number[] = [];
		for (let i = 0; i < n; i++)
			made.push(
				await add({
					plaidCategory: theme,
					rawName: `${name} ${i}`,
					date: `2026-09-${10 + i}`,
				}),
			);
		return { id: (await saveSuggestion(db, name, made)) as number, made };
	}

	it("lists each pending suggestion with the transactions behind it, newest first", async () => {
		const { id, made: txs } = await made("Subscriptions", 3);
		const [only] = await pendingSuggestions(db);
		expect(only?.id).toBe(id);
		expect(only?.name).toBe("Subscriptions");
		expect(only?.rows.map((r) => r.id)).toEqual([...txs].reverse());
		expect(only?.rows[0]).toMatchObject({
			amountCents: 1500,
			categoryId: null,
			categoryName: null,
			excluded: false,
			income: false,
		});
	});

	it("leaves out a transaction that has been categorized since, and the suggestion once fewer than three still need one", async () => {
		const { made: txs } = await made("Subscriptions", 4);
		await db
			.prepare(
				"UPDATE transactions SET category_id = 2, category_source = 'user' WHERE id = ?",
			)
			.bind(txs[0])
			.run();
		expect((await pendingSuggestions(db))[0]?.rows).toHaveLength(3);
		await db
			.prepare(
				"UPDATE transactions SET category_id = 2, category_source = 'merchant_rule' WHERE id = ?",
			)
			.bind(txs[1])
			.run();
		expect((await pendingSuggestions(db))[0]?.rows).toHaveLength(2);
		await db
			.prepare(
				"UPDATE transactions SET category_id=2, category_source='user' WHERE id=?",
			)
			.bind(txs[2])
			.run();
		await db
			.prepare(
				"UPDATE transactions SET category_id=2, category_source='user' WHERE id=?",
			)
			.bind(txs[3])
			.run();
		expect(await pendingSuggestions(db)).toEqual([]);
	});

	it("keeps a created suggestion visible for its transactions even when Guess categories is off", async () => {
		await made("Subscriptions", 3);
		await saveAiSwitches(db, { categories: false });
		expect(await pendingSuggestions(db)).toHaveLength(1);
		await saveAiSwitches(db, { categories: true });
		expect(await pendingSuggestions(db)).toHaveLength(1);
	});

	it("leaves out suggestions that were created, dismissed or had no name", async () => {
		const a = await made("Subscriptions", 3);
		const b = await made("Pet Care", 3, "GENERAL_MERCHANDISE");
		await saveSuggestion(db, null, [
			await add({ plaidCategory: "X" }),
			await add({ plaidCategory: "X", rawName: "Y" }),
			await add({ plaidCategory: "X", rawName: "Z" }),
		]);
		await dismissSuggestion(db, a.id);
		await db
			.prepare(
				"UPDATE category_suggestions SET status = 'created' WHERE id = ?",
			)
			.bind(b.id)
			.run();
		expect(await pendingSuggestions(db)).toEqual([]);
	});

	it("puts the suggestion with the most transactions first", async () => {
		await made("Pet Care", 3, "GENERAL_MERCHANDISE");
		await made("Subscriptions", 5);
		expect((await pendingSuggestions(db)).map((s) => s.name)).toEqual([
			"Subscriptions",
			"Pet Care",
		]);
	});

	it("loads only the ten busiest of 50 pending suggestions before fetching purchases", async () => {
		for (let i = 0; i < 50; i++) {
			const items = [
				await add({ rawName: `GROUP ${i} A` }),
				await add({ rawName: `GROUP ${i} B` }),
				await add({ rawName: `GROUP ${i} C` }),
			];
			await saveSuggestion(db, `Group ${i}`, items);
		}
		let statements = 0;
		const counted = new Proxy(db, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "prepare")
					return (sql: string) => {
						statements++;
						return target.prepare(sql);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as D1Database;
		const result = await pendingSuggestions(counted);
		expect(result).toHaveLength(10);
		expect(result.more).toBe(40);
		expect(statements).toBe(4);
	});
});

describe("createFromSuggestion", () => {
	async function pending(n = 4) {
		const made: number[] = [];
		for (let i = 0; i < n; i++)
			made.push(await add({ rawName: `SHOP ${i}`, date: `2026-09-${10 + i}` }));
		const id = (await saveSuggestion(db, "Subscriptions", made)) as number;
		return { id, made };
	}

	it("creates the category with the tag icon and the next color, and puts the ticked transactions in it as the person's own pick", async () => {
		const { id, made } = await pending();
		const had = (await categories()).length;
		const result = await createFromSuggestion(
			db,
			id,
			{ ticked: made.slice(0, 3), shown: made, notes: {} },
			"person@example.com",
		);
		expect(result).toMatchObject({
			ok: true,
			name: "Subscriptions",
			moved: 3,
			leftOut: [made[3]],
		});
		const all = await categories();
		expect(all).toHaveLength(had + 1);
		const created = all.at(-1);
		expect(created).toMatchObject({
			name: "Subscriptions",
			icon: "tag",
			archived: 0,
		});
		for (const tx of made.slice(0, 3))
			expect(await row(tx)).toMatchObject({
				category_id: created?.id,
				category_source: "user",
				category_confidence: null,
				updated_by: "person@example.com",
			});
		expect(await suggestion(id)).toMatchObject({ status: "created" });
		expect((await suggestion(id))?.decided_at).not.toBeNull();
	});

	it("leaves an unticked transaction uncategorized, and saves the note written for it", async () => {
		const { id, made } = await pending();
		await createFromSuggestion(
			db,
			id,
			{
				ticked: made.slice(0, 3),
				shown: made,
				notes: { [made[3] as number]: "  Birthday present  " },
			},
			"person",
		);
		expect(await row(made[3] as number)).toMatchObject({
			category_id: null,
			category_source: null,
			note: "Birthday present",
		});
	});

	it("leaves an unticked transaction's own note as it was when no new one is written", async () => {
		const { id, made } = await pending();
		await db
			.prepare("UPDATE transactions SET note = 'Gift' WHERE id = ?")
			.bind(made[3])
			.run();
		await createFromSuggestion(
			db,
			id,
			{
				ticked: made.slice(0, 3),
				shown: made,
				notes: { [made[3] as number]: "   " },
			},
			"person",
		);
		expect((await row(made[3] as number))?.note).toBe("Gift");
	});

	it("ignores a note written for a ticked transaction", async () => {
		const { id, made } = await pending();
		await createFromSuggestion(
			db,
			id,
			{ ticked: made, shown: made, notes: { [made[0] as number]: "ignored" } },
			"person",
		);
		expect((await row(made[0] as number))?.note).toBeNull();
	});

	it("asks for at least one tick, and creates nothing without one", async () => {
		const { id, made } = await pending();
		const had = (await categories()).length;
		expect(
			await createFromSuggestion(
				db,
				id,
				{ ticked: [], shown: made, notes: {} },
				"person",
			),
		).toEqual({
			ok: false,
			reason: "invalid",
			error: "Tick at least one transaction, or dismiss this suggestion.",
		});
		expect(await categories()).toHaveLength(had);
		expect(await suggestion(id)).toMatchObject({ status: "pending" });
	});

	it("can't move a transaction that isn't behind this suggestion, however the form was posted", async () => {
		const { id, made } = await pending();
		const stranger = await add({ rawName: "SOMEWHERE ELSE" });
		const result = await createFromSuggestion(
			db,
			id,
			{ ticked: [made[0] as number, stranger], shown: made, notes: {} },
			"person",
		);
		expect(result).toMatchObject({ ok: true, moved: 1 });
		expect((await row(stranger))?.category_id).toBeNull();
	});

	it("doesn't take over a transaction categorized in the meantime", async () => {
		const { id, made } = await pending();
		await db
			.prepare(
				"UPDATE transactions SET category_id = 2, category_source = 'merchant_rule' WHERE id = ?",
			)
			.bind(made[0])
			.run();
		const result = await createFromSuggestion(
			db,
			id,
			{ ticked: made, shown: made, notes: {} },
			"person",
		);
		expect(result).toMatchObject({ ok: true, moved: 3 });
		expect(await row(made[0] as number)).toMatchObject({
			category_id: 2,
			category_source: "merchant_rule",
		});
	});

	it("doesn't count a transaction that arrived behind the suggestion after the page was drawn as one the person unticked", async () => {
		const { id, made } = await pending(3);
		const late = await add({ rawName: "LATE" });
		await db
			.prepare("UPDATE transactions SET category_suggestion_id=? WHERE id=?")
			.bind(id, late)
			.run();
		const result = await createFromSuggestion(
			db,
			id,
			{ ticked: made, shown: made, notes: {} },
			"person",
		);
		expect(result).toMatchObject({ ok: true, leftOut: [late] });
	});

	it("refuses a name a category already has, in any capitals, archived ones too, and creates nothing", async () => {
		const { id, made } = await pending();
		await db
			.prepare("UPDATE categories SET archived = 1 WHERE name = 'Gas'")
			.run();
		for (const taken of ["groceries", "GAS"]) {
			await db
				.prepare("UPDATE category_suggestions SET name = ? WHERE id = ?")
				.bind(taken, id)
				.run();
			const result = await createFromSuggestion(
				db,
				id,
				{ ticked: made, shown: made, notes: {} },
				"person",
			);
			expect(result).toMatchObject({ ok: false, reason: "invalid" });
		}
		expect(await suggestion(id)).toMatchObject({ status: "pending" });
	});

	it("refuses when 50 categories are active already", async () => {
		const { id, made } = await pending();
		const have = (await categories()).filter((c) => !c.archived).length;
		for (let i = have; i < 50; i++)
			await db
				.prepare(
					"INSERT INTO categories (name, icon, color, sort_order) VALUES (?, 'tag', 'cat-blue', ?)",
				)
				.bind(`Filler ${i}`, 100 + i)
				.run();
		const result = await createFromSuggestion(
			db,
			id,
			{ ticked: made, shown: made, notes: {} },
			"person",
		);
		expect(result).toMatchObject({
			ok: false,
			reason: "invalid",
			error: "Tally has room for 50 categories. Archive one to add another.",
		});
		expect(await suggestion(id)).toMatchObject({ status: "pending" });
	});

	it("says it is gone when the suggestion was already created or dismissed, or never existed", async () => {
		const { id, made } = await pending();
		await dismissSuggestion(db, id);
		expect(
			await createFromSuggestion(
				db,
				id,
				{ ticked: made, shown: made, notes: {} },
				"person",
			),
		).toEqual({
			ok: false,
			reason: "gone",
		});
		expect(
			await createFromSuggestion(
				db,
				9999,
				{ ticked: [1], shown: [1], notes: {} },
				"person",
			),
		).toEqual({
			ok: false,
			reason: "gone",
		});
	});

	it("refuses a note over 500 characters, and changes nothing", async () => {
		const { id, made } = await pending();
		const result = await createFromSuggestion(
			db,
			id,
			{
				ticked: made.slice(0, 3),
				shown: made,
				notes: { [made[3] as number]: "x".repeat(501) },
			},
			"person",
		);
		expect(result).toEqual({
			ok: false,
			reason: "invalid",
			error: "Keep each note under 500 characters.",
		});
		expect((await row(made[0] as number))?.category_id).toBeNull();
	});

	it("saves notes for 300 unticked transactions in a fixed number of statements", async () => {
		const made: number[] = [];
		for (let i = 0; i < 301; i++)
			made.push(await add({ rawName: `SHOP ${i}`, date: "2026-09-10" }));
		const id = (await saveSuggestion(db, "Subscriptions", made)) as number;
		let statements = 0;
		const counted = new Proxy(db, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "prepare")
					return (sql: string) => {
						statements++;
						return target.prepare(sql);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as D1Database;
		const notes = Object.fromEntries(
			made.slice(1).map((tx) => [tx, `Note for ${tx}`]),
		);

		const result = await createFromSuggestion(
			counted,
			id,
			{ ticked: [made[0] as number], shown: made, notes },
			"person",
		);

		expect(result).toMatchObject({ ok: true, moved: 1 });
		expect(statements).toBeLessThanOrEqual(12);
		expect((await row(made[300] as number))?.note).toBe(
			`Note for ${made[300]}`,
		);
	});

	it("rolls back the category and transaction writes if the final batch statement fails", async () => {
		const { id, made } = await pending();
		const before = (await categories()).length;
		await db
			.prepare(`
			CREATE TRIGGER fail_suggestion_created
			BEFORE UPDATE OF status ON category_suggestions
			WHEN NEW.status = 'created'
			BEGIN SELECT RAISE(ABORT, 'forced final statement failure'); END
			`)
			.run();

		try {
			await expect(
				createFromSuggestion(
					db,
					id,
					{
						ticked: made.slice(0, 3),
						shown: made,
						notes: { [made[3] as number]: "Gift" },
					},
					"person",
				),
			).rejects.toThrow();
		} finally {
			await db.prepare("DROP TRIGGER fail_suggestion_created").run();
		}

		expect(await categories()).toHaveLength(before);
		expect(await suggestion(id)).toMatchObject({ status: "pending" });
		for (const tx of made)
			expect(await row(tx)).toMatchObject({
				category_id: null,
				category_suggestion_id: id,
			});
		expect((await row(made[3] as number))?.note).toBeNull();
	});
});

describe("dismissSuggestion", () => {
	it("turns the suggestion down: nothing is created or moved, and its transactions never form a suggestion again", async () => {
		const made = [
			await add(),
			await add({ rawName: "HULU" }),
			await add({ rawName: "SPOTIFY" }),
		];
		const id = (await saveSuggestion(db, "Subscriptions", made)) as number;
		const had = (await categories()).length;
		expect(await dismissSuggestion(db, id)).toEqual({ name: "Subscriptions" });
		expect(await suggestion(id)).toMatchObject({ status: "dismissed" });
		expect((await suggestion(id))?.decided_at).not.toBeNull();
		expect(await categories()).toHaveLength(had);
		for (const tx of made) expect((await row(tx))?.category_id).toBeNull();
		expect(await noneFitTransactions(db)).toEqual([]);
		expect(await pendingSuggestions(db)).toEqual([]);
	});

	it("says nothing was there when it was already decided", async () => {
		const id = (await saveSuggestion(db, "Subscriptions", [
			await add(),
			await add({ rawName: "HULU" }),
			await add({ rawName: "SPOTIFY" }),
		])) as number;
		await dismissSuggestion(db, id);
		expect(await dismissSuggestion(db, id)).toBeNull();
		expect(await dismissSuggestion(db, 9999)).toBeNull();
	});
});
