import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";
import {
	nameCallLimit,
	suggestMerchantNames,
} from "../src/suggest-names-pending";

// The nightly names step (spec §7, §8.6, §9; #33): Workers AI is asked, once per bank text, only for a
// merchant Plaid didn't name, and only while the names switch is on. What it says is only ever a
// pending suggestion.

const db = env.DB;
const RAW = "SQ *BLUE BOTTLE COF 0412";

/** A fake Workers AI answering each call from `answer`, which sees the bank's text. */
const fakeAi = (answer: (text: string) => unknown = () => ({ response: "" })) =>
	({
		run: vi.fn(async (_model: string, input: unknown) => {
			const text = (
				input as { messages: { role: string; content: string }[] }
			).messages
				.find((m) => m.role === "user")
				?.content.replace("Bank text: ", "");
			return answer(text ?? "");
		}),
	}) as unknown as Ai & { run: ReturnType<typeof vi.fn> };

const callsFor = (ai: { run: ReturnType<typeof vi.fn> }) =>
	ai.run.mock.calls.map(([, input]) =>
		(input as { messages: { role: string; content: string }[] }).messages
			.find((m) => m.role === "user")
			?.content.replace("Bank text: ", ""),
	);

async function addTransactions(
	rows: {
		rawName: string;
		merchantName?: string | null;
		plaid?: boolean;
		parent?: number;
		/** On the Cash account, as a cash entry a person typed is. */
		cash?: boolean;
	}[],
) {
	let n = 0;
	for (const row of rows) {
		n += 1;
		await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name, parent_id)
				 VALUES (?, CASE WHEN ? THEN (SELECT id FROM accounts WHERE type = 'cash') ELSE 1 END, '2026-09-20', 650, ?, ?, ?)`,
			)
			.bind(
				row.plaid === false ? null : `plaid-${crypto.randomUUID()}-${n}`,
				row.cash ? 1 : 0,
				row.rawName,
				row.merchantName ?? null,
				row.parent ?? null,
			)
			.run();
	}
}

type MerchantRow = {
	raw_name: string;
	suggested_name: string | null;
	display_name: string | null;
	suggestion_status: string;
};
const merchants = async () =>
	(
		await db
			.prepare(
				"SELECT raw_name, suggested_name, display_name, suggestion_status FROM merchants ORDER BY raw_name",
			)
			.all<MerchantRow>()
	).results;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchants"),
	]);
});

describe("suggestMerchantNames", () => {
	it("reads household switches a bounded number of times for up to 100 names", async () => {
		await addTransactions(
			Array.from({ length: 100 }, (_, i) => ({
				rawName: `UNIQUE SHOP ${i}`,
			})),
		);
		let statements = 0;
		const counted = new Proxy(db, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "prepare")
					return (sql: string) => {
						statements += 1;
						return target.prepare(sql);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const ai = fakeAi(() => ({ response: "Unique Shop" }));
		await suggestMerchantNames({ DB: counted as D1Database, AI: ai });
		expect(ai.run).toHaveBeenCalledTimes(nameCallLimit);
		// Includes one candidate query, 100 individual saves and at most four batch switch checks.
		expect(statements).toBeLessThanOrEqual(110);
	});

	it("asks once for a merchant Plaid didn't name and keeps the names, pending, without renaming it", async () => {
		await addTransactions([{ rawName: RAW }, { rawName: RAW }]);
		const ai = fakeAi(() => ({
			response: "Blue Bottle Coffee\nBlue Bottle",
		}));

		expect(await suggestMerchantNames({ DB: db, AI: ai })).toEqual({
			asked: 1,
			suggested: 1,
		});
		expect(callsFor(ai)).toEqual([RAW]);
		expect(await merchants()).toEqual([
			{
				raw_name: RAW,
				suggested_name: "Blue Bottle Coffee\nBlue Bottle",
				display_name: null,
				suggestion_status: "pending",
			},
		]);
	});

	it("never asks again for a merchant it already asked about, whatever the answer was", async () => {
		await addTransactions([{ rawName: RAW }, { rawName: "NOTHING USEFUL" }]);
		const ai = fakeAi((text) =>
			text === RAW
				? { response: "Blue Bottle Coffee" }
				: { response: "NOTHING USEFUL" },
		);
		await suggestMerchantNames({ DB: db, AI: ai });
		expect(callsFor(ai).sort()).toEqual([RAW, "NOTHING USEFUL"].sort());
		// An answer with no usable name is remembered as an empty suggestion, not a pending one.
		expect(
			(await merchants()).find((m) => m.raw_name === "NOTHING USEFUL"),
		).toMatchObject({ suggested_name: "", suggestion_status: "none" });

		const again = fakeAi();
		expect(await suggestMerchantNames({ DB: db, AI: again })).toEqual({
			asked: 0,
			suggested: 0,
		});
		expect(again.run).not.toHaveBeenCalled();
	});

	it("doesn't ask for a merchant Plaid named, a cash entry, a split part, or one a person already named", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('NAMED BY PERSON', 'My place')",
			),
			db.prepare(
				"INSERT INTO merchants (raw_name, suggestion_status, suggested_name) VALUES ('ALREADY PENDING', 'pending', 'Pending Place')",
			),
			db.prepare(
				"INSERT INTO merchants (raw_name, suggestion_status) VALUES ('TURNED DOWN', 'rejected')",
			),
		]);
		await addTransactions([
			{ rawName: "SQ *LOCAL BAKERY 4432", merchantName: "Local Bakery" },
			{ rawName: "Cash at the fair", plaid: false, cash: true },
			{ rawName: "NAMED BY PERSON" },
			{ rawName: "ALREADY PENDING" },
			{ rawName: "TURNED DOWN" },
		]);
		const ai = fakeAi();
		await suggestMerchantNames({ DB: db, AI: ai });
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("asks for a seeded-style row with no Plaid id and no merchant name, but not for a cash entry, so the demo's bank texts are asked after a reset", async () => {
		await addTransactions([
			{ rawName: "TST* CORNER DELI", plaid: false },
			{ rawName: "Farmers market stall", plaid: false, cash: true },
		]);
		const ai = fakeAi(() => ({ response: "Corner Deli Cafe" }));
		expect(await suggestMerchantNames({ DB: db, AI: ai })).toEqual({
			asked: 1,
			suggested: 1,
		});
		expect(callsFor(ai)).toEqual(["TST* CORNER DELI"]);
		expect(await merchants()).toMatchObject([
			{ raw_name: "TST* CORNER DELI", suggestion_status: "pending" },
		]);
	});

	it("asks about the seeded demo's unnamed bank texts, within its limit, and never about its cash entries or named merchants", async () => {
		await resetDemo(db, "2026-09-22");
		const ai = fakeAi(() => ({ response: "Some Place" }));
		await suggestMerchantNames({ DB: db, AI: ai });
		const asked = callsFor(ai);
		expect(asked.length).toBeGreaterThan(0);
		expect(asked.length).toBeLessThanOrEqual(nameCallLimit);
		// Seeded merchants that already have a chosen name or a suggestion, and the cash entry, are left alone.
		expect(asked).not.toContain("Farmers market");
		expect(asked).not.toContain("TRADER JOE'S #552");
		expect(asked).not.toContain("TST* CORNER DELI");
		expect(asked).toContain("VENMO *J RIVERA");
	});

	it("asks for a bank text Plaid named on some charges but not others", async () => {
		await addTransactions([
			{ rawName: RAW, merchantName: "Blue Bottle Coffee" },
			{ rawName: RAW },
		]);
		const ai = fakeAi(() => ({ response: "Blue Bottle" }));
		await suggestMerchantNames({ DB: db, AI: ai });
		expect(callsFor(ai)).toEqual([RAW]);
	});

	it("does nothing without a Workers AI binding", async () => {
		await addTransactions([{ rawName: RAW }]);
		expect(await suggestMerchantNames({ DB: db })).toEqual({
			asked: 0,
			suggested: 0,
		});
		expect(await merchants()).toEqual([]);
	});

	it("with the names switch off, makes no call and no suggestion", async () => {
		await saveAiSwitches(db, { names: false });
		await addTransactions([{ rawName: RAW }]);
		const ai = fakeAi(() => ({ response: "Blue Bottle Coffee" }));
		expect(await suggestMerchantNames({ DB: db, AI: ai })).toEqual({
			asked: 0,
			suggested: 0,
		});
		expect(ai.run).not.toHaveBeenCalled();
		expect(await merchants()).toEqual([]);
	});

	it("drops a batch of answers that come back after the switch went off, or after a person named the merchant", async () => {
		await addTransactions([
			{ rawName: "FIRST SHOP" },
			{ rawName: "SECOND SHOP" },
		]);
		const ai = fakeAi(() => ({ response: "A Name" }));
		ai.run.mockImplementationOnce(async () => {
			await saveAiSwitches(db, { names: false });
			return { response: "First Shop" };
		});
		expect(await suggestMerchantNames({ DB: db, AI: ai })).toMatchObject({
			suggested: 0,
		});
		expect(await merchants()).toEqual([]);
		// It checks once after a batch of at most 25, then makes no further calls.
		expect(ai.run).toHaveBeenCalledTimes(2);

		await saveAiSwitches(db, { names: true });
		const naming = fakeAi(() => ({ response: "A Name" }));
		naming.run.mockImplementationOnce(async () => {
			await db
				.prepare(
					"INSERT INTO merchants (raw_name, display_name) VALUES ('FIRST SHOP', 'Mine') ON CONFLICT(raw_name) DO UPDATE SET display_name = 'Mine'",
				)
				.run();
			return { response: "Shopfront" };
		});
		await suggestMerchantNames({ DB: db, AI: naming });
		expect(
			(await merchants()).find((m) => m.raw_name === "FIRST SHOP"),
		).toMatchObject({ display_name: "Mine", suggestion_status: "none" });
	});

	it("leaves a merchant to be asked tomorrow when the call fails, and stops after three failures in a row", async () => {
		await addTransactions(
			["ONE", "TWO", "THREE", "FOUR"].map((rawName) => ({ rawName })),
		);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const failing = fakeAi(() => {
			throw new Error("capacity");
		});
		expect(await suggestMerchantNames({ DB: db, AI: failing })).toEqual({
			asked: 3,
			suggested: 0,
		});
		expect(failing.run).toHaveBeenCalledTimes(3);
		expect(await merchants()).toEqual([]);
		logged.mockRestore();

		// Back up the next night: everything is asked again.
		const working = fakeAi(() => ({ response: "A Name" }));
		expect(await suggestMerchantNames({ DB: db, AI: working })).toEqual({
			asked: 4,
			suggested: 4,
		});
	});

	it("asks about the merchants with the most charges first, up to its limit for a night", async () => {
		expect(nameCallLimit).toBeGreaterThanOrEqual(10);
		await addTransactions([
			{ rawName: "RARE SHOP" },
			{ rawName: "OFTEN SHOP" },
			{ rawName: "OFTEN SHOP" },
			{ rawName: "OFTEN SHOP" },
			{ rawName: "SOMETIMES SHOP" },
			{ rawName: "SOMETIMES SHOP" },
		]);
		const ai = fakeAi(() => ({ response: "A Name" }));
		await suggestMerchantNames({ DB: db, AI: ai }, 2);
		expect(callsFor(ai)).toEqual(["OFTEN SHOP", "SOMETIMES SHOP"]);
	});

	// Slow requests must not hold up the rest of a run (src/index.tsx runs this after Jev, within a budget):
	// no new request starts once the deadline has passed, and what was answered by then is kept.
	it("stops starting new requests once its deadline has passed, keeping the answers it has", async () => {
		await addTransactions(
			["ONE", "TWO", "THREE", "FOUR", "FIVE"].map((rawName) => ({ rawName })),
		);
		let now = 0;
		const ai = fakeAi(() => {
			now += 1_000;
			return { response: "A Name" };
		});

		// Calls start at 0, 1,000 and 2,000; the next would start at 3,000, past the deadline.
		expect(
			await suggestMerchantNames({ DB: db, AI: ai }, nameCallLimit, {
				deadline: 2_500,
				now: () => now,
			}),
		).toEqual({ asked: 3, suggested: 3 });
		expect(ai.run).toHaveBeenCalledTimes(3);
		expect(await merchants()).toHaveLength(3);

		// The two it didn't reach wait for the next night.
		const next = fakeAi(() => ({ response: "A Name" }));
		expect(await suggestMerchantNames({ DB: db, AI: next })).toEqual({
			asked: 2,
			suggested: 2,
		});
	});

	it("makes no request at all when its deadline has already passed", async () => {
		await addTransactions([{ rawName: RAW }]);
		const ai = fakeAi(() => ({ response: "Blue Bottle Coffee" }));
		expect(
			await suggestMerchantNames({ DB: db, AI: ai }, nameCallLimit, {
				deadline: 5_000,
				now: () => 5_000,
			}),
		).toEqual({ asked: 0, suggested: 0 });
		expect(ai.run).not.toHaveBeenCalled();
		expect(await merchants()).toEqual([]);
	});
});
