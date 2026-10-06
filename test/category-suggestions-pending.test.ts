import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	categoryCallLimit,
	suggestNewCategories,
} from "../src/category-suggestions-pending";
import { saveAiSwitches } from "../src/db/ai-switches";
import {
	dismissSuggestion,
	pendingSuggestions,
} from "../src/db/category-suggestions";
import { resetDemo } from "../src/demo/reset";

// The nightly step for new category suggestions (spec §7, §8.6, #51). Code finds the transactions Jev
// was sure no category fit and groups them by theme; only a group of three or more asks Workers AI for a
// name, and what comes back is a pending suggestion a person creates or dismisses. With Guess categories
// off, nothing is asked and nothing is shown.

const db = env.DB;

type Ask = { merchants: string[]; avoid: string[]; sent: string };
/** The merchants and categories Workers AI was told in one call, read from the prompt it was given. */
const readAsk = (input: unknown): Ask => {
	const messages = (input as { messages: { role: string; content: string }[] })
		.messages;
	const user = messages.find((m) => m.role === "user")?.content ?? "";
	const line = (label: string) =>
		(user.match(new RegExp(`${label}: (.*)`))?.[1] ?? "")
			.split("; ")
			.filter(Boolean);
	return {
		merchants: line("Places"),
		avoid: line("Categories to avoid"),
		sent: JSON.stringify(messages),
	};
};

/** A fake Workers AI answering each call from `answer`, which sees what it was told. */
const fakeAi = (
	answer: (ask: Ask) => unknown = () => ({ response: "Subscriptions" }),
) =>
	({
		run: vi.fn(async (_model: string, input: unknown) =>
			answer(readAsk(input)),
		),
	}) as unknown as Ai & { run: ReturnType<typeof vi.fn> };
const asks = (ai: { run: ReturnType<typeof vi.fn> }) =>
	ai.run.mock.calls.map(([, input]) => readAsk(input));

type Over = {
	rawName?: string;
	plaidCategory?: string | null;
	confidence?: number;
	noneFit?: 0 | 1;
	amountCents?: number;
	note?: string | null;
	pending?: 0 | 1;
};
let seq = 0;
async function add(over: Over = {}) {
	seq += 1;
	const o = {
		rawName: `STREAM ${seq}`,
		plaidCategory: "ENTERTAINMENT",
		confidence: 0.93,
		noneFit: 1,
		amountCents: 1599,
		note: null,
		pending: 0,
		...over,
	};
	const result = await db
		.prepare(
			`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_category, category_confidence, jev_none_fit, note, pending)
			 VALUES (1, '2026-09-20', ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			o.amountCents,
			o.rawName,
			o.plaidCategory,
			o.confidence,
			o.noneFit,
			o.note,
			o.pending,
		)
		.run();
	return Number(result.meta.last_row_id);
}
const addMany = async (n: number, over: Over = {}) => {
	const made: number[] = [];
	for (let i = 0; i < n; i++)
		made.push(
			await add({ ...over, rawName: over.rawName ?? `STREAM ${seq + 1}` }),
		);
	return made;
};

const suggestions = async () =>
	(
		await db
			.prepare("SELECT id, name, status FROM category_suggestions ORDER BY id")
			.all<{ id: number; name: string; status: string }>()
	).results;
const categoryCount = async () =>
	(
		await db
			.prepare("SELECT COUNT(*) AS n FROM categories")
			.first<{ n: number }>()
	)?.n;

beforeEach(async () => {
	vi.restoreAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchants"),
		db.prepare("DELETE FROM category_suggestions"),
	]);
});

describe("suggestNewCategories", () => {
	it("asks Workers AI for a name once three confident none-fit transactions share a theme, and keeps it as a pending suggestion with those transactions behind it", async () => {
		const made = await addMany(3);
		const had = await categoryCount();
		const ai = fakeAi(() => ({ response: "Subscriptions" }));

		expect(await suggestNewCategories({ DB: db, AI: ai })).toEqual({
			asked: 1,
			suggested: 1,
		});
		expect(ai.run).toHaveBeenCalledTimes(1);
		expect(await suggestions()).toMatchObject([
			{ name: "Subscriptions", status: "pending" },
		]);
		const [shown] = await pendingSuggestions(db);
		expect(shown?.rows.map((r) => r.id).sort()).toEqual([...made].sort());
		// Nothing is created automatically, and nothing is moved: a person decides (spec §7).
		expect(await categoryCount()).toBe(had);
		const moved = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NOT NULL",
			)
			.first<{ n: number }>();
		expect(moved?.n).toBe(0);
	});

	it("tells Workers AI who was paid and which categories to avoid, and never an amount, a date, an account or a note", async () => {
		await add({
			rawName: "NETFLIX.COM",
			note: "Secret birthday plan",
			amountCents: 1799,
		});
		await add({ rawName: "HULU 877-8244858", amountCents: 1299 });
		await add({ rawName: "SPOTIFY USA", amountCents: 1099 });
		const ai = fakeAi();
		await suggestNewCategories({ DB: db, AI: ai });
		const [ask] = asks(ai);
		expect(ask?.merchants.sort()).toEqual([
			"Hulu",
			"Netflix.com",
			"Spotify usa",
		]);
		expect(ask?.avoid).toEqual(
			expect.arrayContaining([
				"Groceries",
				"Eating Out",
				"Gas",
				"Kids",
				"Household",
			]),
		);
		for (const leaked of [
			"Secret",
			"17.99",
			"1799",
			"2026-09",
			"Checking",
			"plaid",
		])
			expect(ask?.sent).not.toContain(leaked);
	});

	it("asks nothing for fewer than three, so a lone payment never prompts a new category", async () => {
		await addMany(2);
		await add({ plaidCategory: "TRANSFER_OUT", rawName: "VENMO *J RIVERA" });
		const ai = fakeAi();
		expect(await suggestNewCategories({ DB: db, AI: ai })).toEqual({
			asked: 0,
			suggested: 0,
		});
		expect(ai.run).not.toHaveBeenCalled();
		expect(await suggestions()).toEqual([]);
	});

	it("doesn't count a low-confidence none-fit, which behaves like unsure", async () => {
		await addMany(2);
		await add({ confidence: 0.79 });
		await add({ confidence: 0.4 });
		const ai = fakeAi();
		await suggestNewCategories({ DB: db, AI: ai });
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("doesn't count answers Jev gave while Guess categories was off", async () => {
		await addMany(2);
		await add({ noneFit: 0, confidence: 0.97 });
		const ai = fakeAi();
		await suggestNewCategories({ DB: db, AI: ai });
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("doesn't count a pending transaction, a categorized one or money in", async () => {
		await addMany(1);
		await add({ pending: 1 });
		const categorized = await add();
		await db
			.prepare(
				"UPDATE transactions SET category_id = 2, category_source = 'user' WHERE id = ?",
			)
			.bind(categorized)
			.run();
		await add({ amountCents: -1599 });
		const ai = fakeAi();
		await suggestNewCategories({ DB: db, AI: ai });
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("keeps themes apart and asks once for each group, the biggest first", async () => {
		await addMany(3, { plaidCategory: "TRANSPORTATION", rawName: "RIDE" });
		await addMany(4, { plaidCategory: "ENTERTAINMENT", rawName: "STREAM" });
		const ai = fakeAi((ask) => ({
			response: ask.merchants.includes("Ride") ? "Rides" : "Subscriptions",
		}));
		expect(await suggestNewCategories({ DB: db, AI: ai })).toEqual({
			asked: 2,
			suggested: 2,
		});
		expect(asks(ai).map((a) => a.merchants)).toEqual([["Stream"], ["Ride"]]);
		expect((await suggestions()).map((s) => s.name)).toEqual([
			"Subscriptions",
			"Rides",
		]);
	});

	it("groups transactions that have no Plaid category by their merchant, and no further", async () => {
		await addMany(3, { plaidCategory: null, rawName: "NEIGHBOR KID" });
		await add({ plaidCategory: null, rawName: "ONE OFF" });
		await add({ plaidCategory: null, rawName: "ANOTHER ONE OFF" });
		const ai = fakeAi(() => ({ response: "Babysitting" }));
		await suggestNewCategories({ DB: db, AI: ai });
		expect(asks(ai).map((a) => a.merchants)).toEqual([["Neighbor kid"]]);
	});

	it("asks about each transaction once: it is behind a suggestion from then on", async () => {
		await addMany(3);
		await suggestNewCategories({ DB: db, AI: fakeAi() });
		const again = fakeAi();
		expect(await suggestNewCategories({ DB: db, AI: again })).toEqual({
			asked: 0,
			suggested: 0,
		});
		expect(again.run).not.toHaveBeenCalled();
		expect(await suggestions()).toHaveLength(1);
	});

	it("keeps an empty suggestion when no usable name came back, so that group isn't asked about again", async () => {
		await addMany(3);
		const ai = fakeAi(() => ({ response: "Groceries" }));
		expect(await suggestNewCategories({ DB: db, AI: ai })).toEqual({
			asked: 1,
			suggested: 0,
		});
		expect(await suggestions()).toMatchObject([{ name: "", status: "none" }]);
		expect(await pendingSuggestions(db)).toEqual([]);
		const again = fakeAi();
		await suggestNewCategories({ DB: db, AI: again });
		expect(again.run).not.toHaveBeenCalled();
	});

	it("never proposes a category the household has, or a name a person dismissed", async () => {
		await addMany(3);
		const first = fakeAi(() => ({ response: "Pet Care" }));
		await suggestNewCategories({ DB: db, AI: first });
		const [made] = await pendingSuggestions(db);
		await dismissSuggestion(db, made?.id as number);

		// Three more of another theme: the model says the dismissed name again, and Tally drops it.
		await addMany(3, {
			plaidCategory: "GENERAL_MERCHANDISE",
			rawName: "PETSTORE",
		});
		const second = fakeAi(() => ({ response: "Pet Care" }));
		await suggestNewCategories({ DB: db, AI: second });
		expect(asks(second)[0]?.avoid).toContain("Pet Care");
		expect(await pendingSuggestions(db)).toEqual([]);
	});

	it("doesn't bring back what a person dismissed: its transactions are never grouped again, and the same theme returns only with three new ones", async () => {
		await addMany(3);
		await suggestNewCategories({
			DB: db,
			AI: fakeAi(() => ({ response: "Streaming" })),
		});
		const [made] = await pendingSuggestions(db);
		await dismissSuggestion(db, made?.id as number);

		const again = fakeAi(() => ({ response: "Media" }));
		await suggestNewCategories({ DB: db, AI: again });
		expect(again.run).not.toHaveBeenCalled();

		// Two new ones of that theme aren't enough; three are, and they alone are behind the new suggestion.
		await addMany(2);
		await suggestNewCategories({ DB: db, AI: again });
		expect(again.run).not.toHaveBeenCalled();
		await addMany(1);
		await suggestNewCategories({ DB: db, AI: again });
		expect(again.run).toHaveBeenCalledTimes(1);
		expect((await pendingSuggestions(db))[0]?.rows).toHaveLength(3);
	});

	it("puts a second group that gets the same name behind the first suggestion rather than making a twin", async () => {
		await addMany(3, { plaidCategory: "ENTERTAINMENT", rawName: "STREAM" });
		await addMany(3, { plaidCategory: "GENERAL_SERVICES", rawName: "APPS" });
		const ai = fakeAi(() => ({ response: "Subscriptions" }));
		expect(await suggestNewCategories({ DB: db, AI: ai })).toEqual({
			asked: 2,
			suggested: 2,
		});
		const all = await pendingSuggestions(db);
		expect(all).toHaveLength(1);
		expect(all[0]?.rows).toHaveLength(6);
	});

	it("asks about at most five groups a night, the biggest first, and the rest wait for the next", async () => {
		expect(categoryCallLimit).toBe(5);
		const shops = [
			"ALPHA",
			"BRAVO",
			"CHARLIE",
			"DELTA",
			"ECHO",
			"FOXTROT",
			"GOLF",
		];
		for (const [g, shop] of shops.entries())
			await addMany(3 + (g % 2), {
				plaidCategory: `THEME_${g}`,
				rawName: shop,
			});
		const named = (prefix: string) =>
			fakeAi((ask) => ({ response: `${prefix} ${ask.merchants[0]}` }));
		const first = named("Mine");
		expect(await suggestNewCategories({ DB: db, AI: first })).toMatchObject({
			asked: 5,
		});
		expect(first.run).toHaveBeenCalledTimes(5);
		// The four-transaction groups (odd g) go first, then the three-transaction ones in A to Z order.
		expect(asks(first).map((a) => a.merchants[0])).toEqual([
			"Bravo",
			"Delta",
			"Foxtrot",
			"Alpha",
			"Charlie",
		]);
		const next = named("Yours");
		expect(await suggestNewCategories({ DB: db, AI: next })).toMatchObject({
			asked: 2,
		});
	});

	it("does nothing without a Workers AI binding", async () => {
		await addMany(3);
		expect(await suggestNewCategories({ DB: db })).toEqual({
			asked: 0,
			suggested: 0,
		});
		expect(await suggestions()).toEqual([]);
	});

	it("makes no call and keeps nothing with Guess categories off, and asks again once it is back on", async () => {
		await addMany(3);
		await saveAiSwitches(db, { categories: false });
		const ai = fakeAi();
		expect(await suggestNewCategories({ DB: db, AI: ai })).toEqual({
			asked: 0,
			suggested: 0,
		});
		expect(ai.run).not.toHaveBeenCalled();
		expect(await suggestions()).toEqual([]);

		await saveAiSwitches(db, { categories: true });
		expect(await suggestNewCategories({ DB: db, AI: ai })).toMatchObject({
			asked: 1,
		});
	});

	it("is not governed by the store names switch or the income switch", async () => {
		await addMany(3);
		await saveAiSwitches(db, { names: false, income: false });
		const ai = fakeAi();
		await suggestNewCategories({ DB: db, AI: ai });
		expect(ai.run).toHaveBeenCalledTimes(1);
	});

	it("drops an answer that comes back after Guess categories went off, and stops", async () => {
		await addMany(3, { plaidCategory: "ONE", rawName: "A" });
		await addMany(3, { plaidCategory: "TWO", rawName: "B" });
		const ai = fakeAi(() => ({ response: "Something" }));
		ai.run.mockImplementationOnce(async () => {
			await saveAiSwitches(db, { categories: false });
			return { response: "Late Name" };
		});
		expect(await suggestNewCategories({ DB: db, AI: ai })).toMatchObject({
			suggested: 0,
		});
		expect(await suggestions()).toEqual([]);
		expect(ai.run).toHaveBeenCalledTimes(1);
		await saveAiSwitches(db, { categories: true });
	});

	it("leaves a group to be asked tomorrow when the call fails, and stops after three failures in a row", async () => {
		for (const theme of ["A", "B", "C", "D"])
			await addMany(3, { plaidCategory: theme, rawName: `SHOP ${theme}` });
		const failing = fakeAi(() => {
			throw new Error("capacity");
		});
		expect(await suggestNewCategories({ DB: db, AI: failing })).toEqual({
			asked: 3,
			suggested: 0,
		});
		expect(await suggestions()).toEqual([]);
		const working = fakeAi((ask) => ({
			response: `Name ${ask.merchants[0]}`.replace(/[\d]/g, ""),
		}));
		expect(await suggestNewCategories({ DB: db, AI: working })).toMatchObject({
			asked: 4,
		});
	});

	it("stops starting requests once its deadline has passed, keeping what was answered", async () => {
		for (const theme of ["A", "B", "C", "D"])
			await addMany(3, { plaidCategory: theme, rawName: `SHOP ${theme}` });
		let now = 0;
		const ai = fakeAi((ask) => {
			now += 1_000;
			return { response: `Name ${ask.merchants[0]}` };
		});
		expect(
			await suggestNewCategories({ DB: db, AI: ai }, categoryCallLimit, {
				deadline: 1_500,
				now: () => now,
			}),
		).toEqual({ asked: 2, suggested: 2 });
		expect(ai.run).toHaveBeenCalledTimes(2);
		expect(await suggestions()).toHaveLength(2);
	});

	it("makes no request when its deadline has already passed", async () => {
		await addMany(3);
		const ai = fakeAi();
		expect(
			await suggestNewCategories({ DB: db, AI: ai }, categoryCallLimit, {
				deadline: 5_000,
				now: () => 5_000,
			}),
		).toEqual({ asked: 0, suggested: 0 });
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("logs counts only, never a merchant, a category name or a transaction", async () => {
		await add({ rawName: "NETFLIX.COM" });
		await add({ rawName: "HULU" });
		await add({ rawName: "SPOTIFY" });
		await suggestNewCategories({
			DB: db,
			AI: fakeAi(() => ({ response: "Subscriptions" })),
		});
		const lines = [
			...vi.mocked(console.log).mock.calls,
			...vi.mocked(console.error).mock.calls,
		]
			.flat()
			.join("\n");
		expect(lines).toContain("workers-ai");
		for (const leaked of [
			"Netflix",
			"NETFLIX",
			"Hulu",
			"Spotify",
			"Subscriptions",
		])
			expect(lines).not.toContain(leaked);
	});
});
