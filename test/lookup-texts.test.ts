import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { maybeFacts, moneyMaybeStatements } from "../src/db/suggestion-saves";
import { saveEdit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import {
	fillLookupTexts,
	type LookupTextFacts,
	lookupTextRow,
} from "../src/lookup/texts";
import { runSortInstance } from "../src/sort-instance";
import { fakeSteps } from "./fake-sort-steps";

// The lookup texts (src/lookup/texts.ts): which lookup text each merchant key uses, and whether it is private. The pure
// decision is tested first; then the one read and the one batch that fill the table; then the sorting instance's step.

const db = env.DB;
const TODAY = "2026-09-22";

const ordinary: LookupTextFacts = {
	rawTexts: ["LA COOP ARLINGTON Arlington VA 07/24"],
	categories: ["FOOD_AND_DRINK"],
	flagged: false,
	maybe: false,
	transfer: false,
	excluded: false,
};

describe("lookupTextRow", () => {
	it("an ordinary store with an ordinary category and nothing else is not private, and its text has no digits", () => {
		const row = lookupTextRow("LA COOP ARLINGTON Arlington VA 07/24", ordinary);

		expect(row).toEqual({
			merchantKey: "LA COOP ARLINGTON Arlington VA 07/24",
			lookupText: "la coop arlington arlington",
			private: 0,
		});
		expect(row.lookupText).not.toMatch(/\d/);
	});

	it("a payment app in the key is private", () => {
		expect(lookupTextRow("VENMO *J RIVERA", ordinary).private).toBe(1);
	});

	it("a bank rail in one raw text under a Plaid-style key is private", () => {
		const row = lookupTextRow("Target", {
			...ordinary,
			rawTexts: ["TARGET STORE 1234", "ACH DEBIT TARGET"],
		});

		expect(row.private).toBe(1);
	});

	it.each(["TRANSFER_OUT", "INCOME", "BANK_FEES"])(
		"the Plaid category %s makes it private",
		(category) => {
			expect(
				lookupTextRow("ORDINARY STORE", { ...ordinary, categories: [category] })
					.private,
			).toBe(1);
		},
	);

	it("a null Plaid category does not make it private", () => {
		expect(
			lookupTextRow("ORDINARY STORE", { ...ordinary, categories: [null] })
				.private,
		).toBe(0);
	});

	it("any flag makes it private", () => {
		expect(
			lookupTextRow("ORDINARY STORE", { ...ordinary, flagged: true }).private,
		).toBe(1);
	});

	it("an unanswered Maybe makes it private", () => {
		expect(
			lookupTextRow("ORDINARY STORE", { ...ordinary, maybe: true }).private,
		).toBe(1);
	});

	it("a transfer kind makes it private", () => {
		expect(
			lookupTextRow("ORDINARY STORE", { ...ordinary, transfer: true }).private,
		).toBe(1);
	});

	it("a key whose lookup text is empty is private (the empty reason)", () => {
		const row = lookupTextRow("MEMBER1234", {
			...ordinary,
			rawTexts: ["MEMBER1234"],
		});

		expect(row).toEqual({
			merchantKey: "MEMBER1234",
			lookupText: "",
			private: 1,
		});
	});
});

/** Inserts one transaction from its columns; the defaults are an ordinary purchase on account 1. */
async function addRow(values: Record<string, string | number | null>) {
	const row = {
		account_id: 1,
		date: TODAY,
		amount_cents: -1200,
		raw_name: "ORDINARY STORE",
		...values,
	};

	const columns = Object.keys(row);

	await db
		.prepare(
			`INSERT INTO transactions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
		)
		.bind(...Object.values(row))
		.run();
}

/** The stored row of one merchant key, or null when the key has none. */
const lookupRow = (key: string) =>
	db
		.prepare(
			"SELECT lookup_text AS lookupText, private FROM merchant_lookup_texts WHERE merchant_key = ?",
		)
		.bind(key)
		.first<{ lookupText: string; private: number }>();

const privateOf = async (key: string) => (await lookupRow(key))?.private;

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await db.prepare("DELETE FROM merchant_lookup_texts").run();
	await saveAiSwitches(db, AI_SWITCHES_ALL_ON);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("fillLookupTexts: what makes a key private", () => {
	it.each(["flag_transfer", "flag_income", "flag_reimbursement"])(
		"%s alone makes its key private",
		async (flag) => {
			await addRow({ merchant_name: "Corner Deli", [flag]: 1 });

			await fillLookupTexts(db);

			expect(await privateOf("Corner Deli")).toBe(1);
		},
	);

	it("an unanswered Maybe transfer and an unanswered Maybe income in range make their keys private", async () => {
		await addRow({
			merchant_name: "Maybe Transfer Co",
			transfer_confidence: 0.6,
		});
		await addRow({ merchant_name: "Maybe Income Co", income_confidence: 0.5 });

		await fillLookupTexts(db);

		expect(await privateOf("Maybe Transfer Co")).toBe(1);
		expect(await privateOf("Maybe Income Co")).toBe(1);
	});

	it("a confidence below the range, or a sure one, is not a Maybe", async () => {
		await addRow({ merchant_name: "Low Guess Co", transfer_confidence: 0.2 });
		await addRow({ merchant_name: "Sure Guess Co", transfer_confidence: 0.9 });

		await fillLookupTexts(db);

		expect(await privateOf("Low Guess Co")).toBe(0);
		expect(await privateOf("Sure Guess Co")).toBe(0);
	});

	it("a Maybe a person said No to is answered, so it is not private", async () => {
		await addRow({
			merchant_name: "Declined Transfer Co",
			transfer_confidence: 0.6,
			transfer_maybe_declined: 1,
		});
		await addRow({
			merchant_name: "Declined Income Co",
			income_confidence: 0.5,
			income_maybe_declined: 1,
		});

		await fillLookupTexts(db);

		expect(await privateOf("Declined Transfer Co")).toBe(0);
		expect(await privateOf("Declined Income Co")).toBe(0);
	});

	it("a cash row with a flag, a hand-entered row with a transfer kind, an Apple Card row and a split part with a transfer flag each make their key private", async () => {
		await db
			.prepare(
				"INSERT INTO accounts (name, type, balance_cents) VALUES ('Apple Card', 'credit', 0)",
			)
			.run();

		const apple = await db
			.prepare("SELECT id FROM accounts WHERE name = 'Apple Card'")
			.first<{ id: number }>();

		const cash = await db
			.prepare("SELECT id FROM accounts WHERE type = 'cash'")
			.first<{ id: number }>();

		await addRow({
			account_id: cash?.id ?? null,
			merchant_name: "Cash Stall",
			flag_income: 1,
		});
		await addRow({ merchant_name: "Hand Shop", kind: "transfer" });
		await addRow({
			account_id: apple?.id ?? null,
			merchant_name: "Apple Store",
			flag_transfer: 1,
		});
		await addRow({ merchant_name: "Split Parent", is_split: 1 });
		await addRow({
			merchant_name: "Split Parent",
			parent_id:
				(
					await db
						.prepare(
							"SELECT id FROM transactions WHERE merchant_name = 'Split Parent'",
						)
						.first<{ id: number }>()
				)?.id ?? null,
			flag_transfer: 1,
		});

		await fillLookupTexts(db);

		expect(await privateOf("Cash Stall")).toBe(1);
		expect(await privateOf("Hand Shop")).toBe(1);
		expect(await privateOf("Apple Store")).toBe(1);
		expect(await privateOf("Split Parent")).toBe(1);
	});

	it("two transactions of one key, one of them private, make the key private", async () => {
		await addRow({ merchant_name: "Shared Key Co" });
		await addRow({ merchant_name: "Shared Key Co", flag_reimbursement: 1 });

		await fillLookupTexts(db);

		expect(await privateOf("Shared Key Co")).toBe(1);
	});

	it("two keys that share one lookup text each get their own row with the same text", async () => {
		await addRow({ merchant_name: "Blue Bottle Coffee" });
		await addRow({ merchant_name: "BLUE BOTTLE COFFEE" });

		await fillLookupTexts(db);

		const first = await lookupRow("Blue Bottle Coffee");
		const second = await lookupRow("BLUE BOTTLE COFFEE");

		expect(first?.lookupText).toBe("blue bottle coffee");
		expect(second?.lookupText).toBe("blue bottle coffee");
	});

	it("a flag cleared and the fill run again returns the key to not private", async () => {
		await addRow({ merchant_name: "Returning Co", flag_transfer: 1 });
		await fillLookupTexts(db);
		expect(await privateOf("Returning Co")).toBe(1);

		await db
			.prepare(
				"UPDATE transactions SET flag_transfer = 0 WHERE merchant_name = 'Returning Co'",
			)
			.run();
		await fillLookupTexts(db);

		expect(await privateOf("Returning Co")).toBe(0);
	});
});

describe("fillLookupTexts: one read and one batch", () => {
	it("writes 1,200 keys in one batch of three statements, with no query in a loop", async () => {
		await db
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
				 INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name)
				 SELECT 1, ?, -500, 'STORE ' || i, 'Store ' || i FROM n`,
			)
			.bind(TODAY)
			.run();

		// The demo's seeded merchants are keys too, so the count is read from the table, not written in.
		const keys = await db
			.prepare(
				"SELECT COUNT(DISTINCT COALESCE(NULLIF(merchant_name, ''), raw_name)) AS n FROM transactions",
			)
			.first<{ n: number }>();

		const prepare = vi.spyOn(db, "prepare");
		const batch = vi.spyOn(db, "batch");

		const result = await fillLookupTexts(db);

		expect(keys?.n).toBeGreaterThan(1200);
		expect(result.keys).toBe(keys?.n);
		expect(batch).toHaveBeenCalledTimes(1);
		expect(batch.mock.calls[0]?.[0]).toHaveLength(3);
		// One read and the three statements, however many keys there are.
		expect(prepare).toHaveBeenCalledTimes(4);
	});
});

/** The sorting instance's Jev answer: nothing sure, so a call asked costs its queries and changes no category. */
const jevAnswer = () =>
	Response.json({
		answers: {
			category: { type: "choice", choice: "Eating Out", confidence: 0.5 },
			transfer: { type: "noul", noul: 0.01 },
			reimbursement: { type: "noul", noul: 0.01 },
			income: { type: "noul", noul: 0.01 },
		},
	});

const gateOpen = {
	DB: db,
	JEV_API_KEY: "jev",
	DEMO: "false",
	TAVILY_API_KEY: "tvly",
};

const params = { bySync: false, rulesApplied: false };

/** Runs one sorting instance in this process with fake steps. */
async function runInstance(
	instanceEnv: Parameters<typeof runSortInstance>[0],
	options: {
		beforeAttempt?: (name: string, attempt: number) => Promise<void>;
		fails?: string[];
	} = {},
) {
	const steps = fakeSteps({
		beforeAttempt: options.beforeAttempt,
		fails: options.fails,
	});

	await runSortInstance(instanceEnv, steps.runStep, params, {
		runId: crypto.randomUUID(),
		fetchImpl: vi.fn(async () => jevAnswer()),
	});

	return steps;
}

describe("the lookup-texts step, through the sorting instance", () => {
	it("with no Tavily key, or in the demo, the step is not registered and the table stays empty", async () => {
		await addRow({ merchant_name: "Gated Co", flag_transfer: 1 });

		const noKey = await runInstance({ ...gateOpen, TAVILY_API_KEY: undefined });
		const demo = await runInstance({ ...gateOpen, DEMO: "true" });

		expect(noKey.names()).not.toContain("lookup-texts");
		expect(demo.names()).not.toContain("lookup-texts");
		expect(noKey.names()[0]).toBe("rules");
		expect(await lookupRow("Gated Co")).toBeNull();
	});

	it("with the key and the production cap, but the lookup switch off, the step runs and writes nothing", async () => {
		await addRow({ merchant_name: "Switched Off Co", flag_transfer: 1 });
		await saveAiSwitches(db, { lookupStores: false });

		const steps = await runInstance(gateOpen);

		expect(steps.names()[0]).toBe("lookup-texts");
		expect(await lookupRow("Switched Off Co")).toBeNull();
	});

	it("with the gate open, the rows are written before the first sorting group reads", async () => {
		await addRow({ merchant_name: "Written First Co", flag_transfer: 1 });
		let rowsAtFirstRead: number | undefined;

		const steps = await runInstance(gateOpen, {
			beforeAttempt: async (name) => {
				if (name === "group-1-read") {
					rowsAtFirstRead = (
						await db
							.prepare("SELECT COUNT(*) AS n FROM merchant_lookup_texts")
							.first<{ n: number }>()
					)?.n;
				}
			},
		});

		expect(steps.names().indexOf("lookup-texts")).toBeLessThan(
			steps.names().indexOf("rules"),
		);
		expect(rowsAtFirstRead).toBeGreaterThan(0);
	});

	it("if the fill throws, sorting still runs, and the log names the error only", async () => {
		await addRow({ merchant_name: "Throwing Co SECRET", flag_transfer: 1 });
		vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("disk unavailable"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const steps = await runInstance(gateOpen);

		expect(steps.names()).toContain("rules");
		expect(steps.names()).toContain("group-1-read");
		const logged = error.mock.calls.flat().map(String).join(" ");
		expect(logged).toContain("lookup texts");
		expect(logged).toContain("Error");
		expect(logged).not.toContain("SECRET");
	});

	it("nothing it logs contains a merchant key", async () => {
		await addRow({ merchant_name: "Quiet Store SECRET", flag_transfer: 1 });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await runInstance(gateOpen);

		const logged = [...log.mock.calls, ...error.mock.calls]
			.flat()
			.map(String)
			.join(" ");

		expect(logged).not.toContain("SECRET");
	});
});

/** Inserts one transaction and returns its id (the defaults are an ordinary purchase on account 1). */
async function insertedId(values: Record<string, string | number | null>) {
	const row = {
		account_id: 1,
		date: TODAY,
		amount_cents: -1200,
		raw_name: "ORDINARY STORE",
		...values,
	};
	const columns = Object.keys(row);
	const inserted = await db
		.prepare(
			`INSERT INTO transactions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING id`,
		)
		.bind(...Object.values(row))
		.first<{ id: number }>();

	if (!inserted) throw new Error("the row was not inserted");

	return inserted.id;
}

const WHO = "person@example.com";

/** A person's Yes or No on a Maybe, through the app's own save (moneyMaybeStatements), read against its current version. */
async function answerMaybe(id: number, kind: "transfer" | "income") {
	const facts = await maybeFacts(db, kind, id);

	await db.batch(
		moneyMaybeStatements(db, {
			kind,
			answer: "yes",
			transactionId: id,
			today: TODAY,
			who: WHO,
			confidence: facts.confidence ?? 0,
			expectedVersion: facts.version,
		}),
	);
}

describe("a transfer, income or reimbursement said about any row makes its key private", () => {
	it("a person's Yes on a Maybe transfer, through the app's save, makes its key private", async () => {
		const id = await insertedId({
			merchant_name: "Quiet Mover Co",
			raw_name: "QUIET MOVER CO",
			amount_cents: 4000,
			transfer_confidence: 0.6,
		});

		await answerMaybe(id, "transfer");

		const stored = await db
			.prepare("SELECT excluded FROM transactions WHERE id = ?")
			.bind(id)
			.first<{ excluded: number }>();
		expect(stored?.excluded).toBe(1);

		await fillLookupTexts(db);

		expect(await privateOf("Quiet Mover Co")).toBe(1);
	});

	it("a person's Yes on a Maybe income, through the app's save, makes its key private", async () => {
		const id = await insertedId({
			merchant_name: "Quiet Payer Co",
			raw_name: "QUIET PAYER CO",
			amount_cents: -50000,
			income_confidence: 0.5,
		});

		await answerMaybe(id, "income");

		await fillLookupTexts(db);

		expect(await privateOf("Quiet Payer Co")).toBe(1);
	});

	it("a row a person marked as income in the edit panel makes its key private", async () => {
		const id = await insertedId({
			merchant_name: "Quiet Refund Co",
			raw_name: "QUIET REFUND CO",
			amount_cents: -7000,
		});

		await saveEdit(
			db,
			id,
			{
				categoryId: null,
				alwaysForMerchant: false,
				displayName: null,
				note: null,
				excluded: false,
				income: true,
				creditReviewed: true,
			},
			WHO,
		);

		await fillLookupTexts(db);

		expect(await privateOf("Quiet Refund Co")).toBe(1);
	});

	it("a row a person excluded in the edit panel, for any reason, makes its key private", async () => {
		const id = await insertedId({
			merchant_name: "Quiet Stop Co",
			raw_name: "QUIET STOP CO",
		});

		await saveEdit(
			db,
			id,
			{
				categoryId: null,
				alwaysForMerchant: false,
				displayName: null,
				note: null,
				excluded: true,
				income: false,
				creditReviewed: true,
			},
			WHO,
		);

		await fillLookupTexts(db);

		expect(await privateOf("Quiet Stop Co")).toBe(1);
	});

	it("a row Plaid excluded makes its key private", async () => {
		await insertedId({
			merchant_name: "Plaid Stop Co",
			raw_name: "PLAID STOP CO",
			excluded: 1,
			excluded_source: "plaid",
		});

		await fillLookupTexts(db);

		expect(await privateOf("Plaid Stop Co")).toBe(1);
	});

	it("an excluded row, once un-excluded and the fill run again, returns its key to not private", async () => {
		const id = await insertedId({
			merchant_name: "Unexcluded Co",
			raw_name: "UNEXCLUDED CO",
			excluded: 1,
			excluded_source: "user",
		});

		await fillLookupTexts(db);
		expect(await privateOf("Unexcluded Co")).toBe(1);

		await db
			.prepare(
				"UPDATE transactions SET excluded = 0, excluded_source = NULL WHERE id = ?",
			)
			.bind(id)
			.run();
		await fillLookupTexts(db);

		expect(await privateOf("Unexcluded Co")).toBe(0);
	});
});
