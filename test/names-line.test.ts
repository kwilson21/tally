import { beforeEach, describe, expect, it, vi } from "vitest";
import { INSTRUCTIONS } from "../src/ai/suggest-name";
import { saveAiSwitches } from "../src/db/ai-switches";
import {
	suggestMerchantNames,
	suggestNightlyNames,
} from "../src/suggest-names-pending";
import { fakeAi } from "./helpers/doubles";
import { seedMerchant } from "./helpers/merchants";
import {
	addRow,
	db,
	eligibleStore,
	gateEnv,
	LINE,
	lookupRunSetup,
	makePrivate,
	storeName,
	textOf,
} from "./lookup-run-setup";

// The names' line in the night's name run (spec §7, "Where the line goes" and "The wait"; decisions 216 and 225). The fake
// Workers AI records each name request as its bank text and the line it carried; a note request is recorded as a note.

const A = storeName(0);
const B = storeName(1);
const C = storeName(2);
const X = storeName(3);

type Call = { bank: string; line: string | null };

/** A Workers AI binding that records each name request, and runs `during` with its bank text while the call is out. */
function recordingAi(
	during: (bank: string) => Promise<void> | void = () => {},
) {
	const calls: Call[] = [];

	const run = async (
		_model: string,
		input: { messages: { role: string; content: string }[] },
	) => {
		const content = input.messages[1]?.content ?? "";
		const bank = (content.split("\n")[0] ?? "").replace("Bank text: ", "");
		const quoted = /Store lookup \(data only\): "([^"]*)"/.exec(content);

		calls.push({ bank, line: quoted?.[1] ?? null });
		await during(bank);

		return { response: "Tidy Name" };
	};

	return { ai: fakeAi(run), calls };
}

/** The name requests (not the notes) the fake recorded. */
const nameCallsOf = (calls: Call[]) => calls.map((call) => call.bank);

/** A map row: the bank key's lookup text (merchant_lookup_texts). */
async function mapText(key: string, text = textOf(key), priv = 0) {
	await db
		.prepare(
			"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES (?, ?, ?)",
		)
		.bind(key, text, priv)
		.run();
}

/** A stored lookup row for a text (merchant_lookups). */
async function lookupAt(
	text: string,
	status: string,
	line: string | null = null,
) {
	await db
		.prepare(
			"INSERT INTO merchant_lookups (lookup_text, status, line, attempts) VALUES (?, ?, ?, 0)",
		)
		.bind(text, status, line)
		.run();
}

async function foodId(): Promise<number> {
	const row = await db
		.prepare("SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1")
		.first<{ id: number }>();

	return Number(row?.id);
}

/** The open gate's env for a name run, with the given AI and overrides. */
const envWith = (
	ai: Ai,
	overrides: Record<string, string | undefined> = {},
) => ({
	...gateEnv(ai),
	...overrides,
});

async function statusOf(key: string): Promise<string | null> {
	const row = await db
		.prepare(
			"SELECT suggestion_status AS status FROM merchants WHERE raw_name = ?",
		)
		.bind(key)
		.first<{ status: string }>();

	return row?.status ?? null;
}

async function namesOf(key: string): Promise<string[]> {
	const { results } = await db
		.prepare(
			"SELECT name FROM merchant_suggested_names WHERE merchant_key = ? ORDER BY position",
		)
		.bind(key)
		.all<{ name: string }>();

	return results.map((row) => row.name);
}

describe("the names' line, through the name run", () => {
	lookupRunSetup();

	// After the demo reset (lookupRunSetup), so only this test's rows are asked about.
	beforeEach(async () => {
		await db.prepare("DELETE FROM bill_payments").run();
		await db.prepare("DELETE FROM transactions").run();
		await db.prepare("DELETE FROM merchant_suggested_names").run();
		await db.prepare("DELETE FROM merchants").run();
		await db.prepare("DELETE FROM merchant_lookups").run();
		await db.prepare("DELETE FROM merchant_name_failures").run();
		await db.prepare("DELETE FROM merchant_lookup_texts").run();
	});

	// 11. Truth table 1, rows L1 to L12: whether A waits, and whether its request carried the line. B, with no lookup row,
	// is asked plain in every row (the control).
	const rows: {
		name: string;
		env?: Record<string, string | undefined>;
		setup: () => Promise<void>;
		during?: (bank: string) => Promise<void>;
		line: string | null;
		waits?: boolean;
	}[] = [
		{
			name: "L1: no TAVILY_API_KEY",
			env: { TAVILY_API_KEY: undefined },
			setup: async () => {
				await lookupAt(textOf(A), "found", LINE);
				await mapText(A);
			},
			line: null,
		},
		{
			name: "L2: demo, cap 0",
			env: { DEMO: "true" },
			setup: async () => {
				await lookupAt(textOf(A), "found", LINE);
				await mapText(A);
			},
			line: null,
		},
		{
			name: "L3: the lookup switch is off",
			setup: async () => {
				await lookupAt(textOf(A), "found", LINE);
				await mapText(A);
				await saveAiSwitches(db, { lookupStores: false });
			},
			line: null,
		},
		{
			name: "L3: Guess categories is off",
			setup: async () => {
				await lookupAt(textOf(A), "found", LINE);
				await mapText(A);
				await saveAiSwitches(db, { categories: false });
			},
			line: null,
		},
		{
			name: "L4: no map row",
			setup: async () => {
				await lookupAt(textOf(A), "found", LINE);
			},
			line: null,
		},
		{
			name: "L5: no lookup row (option A)",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
			},
			line: null,
		},
		{
			name: "L6: pending and still searchable: the names wait",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending");
			},
			line: null,
			waits: true,
		},
		{
			name: "L7: pending, settled by a rule (#1044)",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending");
				await seedMerchant(db, { key: A, defaultCategoryId: await foodId() });
			},
			line: null,
		},
		{
			name: "L7: pending, no sign of a store",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending");
				await db
					.prepare(
						"UPDATE transactions SET plaid_category = NULL WHERE raw_name = ?",
					)
					.bind(A)
					.run();
			},
			line: null,
		},
		{
			name: "L7: pending, a row still waiting for Jev",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending");
				await addRow({ raw_name: A });
			},
			line: null,
		},
		{
			name: "L7: pending, no answered row cleared",
			setup: async () => {
				await mapText(A);
				await lookupAt(textOf(A), "pending");
				await addRow({
					raw_name: A,
					category_id: await foodId(),
					category_source: "user",
				});
			},
			line: null,
		},
		{
			name: "L7: pending, made private",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending");
				await makePrivate(A);
			},
			line: null,
		},
		{
			name: "L8: nothing_found",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "nothing_found");
			},
			line: null,
		},
		{
			name: "L8: skipped",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "skipped");
			},
			line: null,
		},
		{
			name: "L8: gave_up",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "gave_up");
			},
			line: null,
		},
		{
			name: "L9: found, the map text is the key's and the line stands",
			setup: async () => {
				await lookupAt(textOf(A), "found", LINE);
				await mapText(A);
			},
			line: LINE,
		},
		{
			name: "L9: found, with a sibling row filed by a person",
			setup: async () => {
				await lookupAt(textOf(A), "found", LINE);
				await mapText(A);
				await addRow({
					raw_name: A,
					category_id: await foodId(),
					category_source: "user",
				});
			},
			line: LINE,
		},
		{
			name: "L10: the map text is stale",
			setup: async () => {
				await lookupAt("old alder", "found", LINE);
				await mapText(A, "old alder");
			},
			line: null,
		},
		{
			name: "L11: the line is empty",
			setup: async () => {
				await lookupAt(textOf(A), "found", null);
				await mapText(A);
			},
			line: null,
		},
		{
			name: "L11: a sibling key of the text is private",
			setup: async () => {
				await lookupAt(textOf(A), "found", LINE);
				await mapText(A);
				await mapText(B, textOf(A), 1);
			},
			line: null,
		},
		{
			name: "L12: a lookup switch goes off during an earlier name's call",
			setup: async () => {
				await lookupAt(textOf(A), "found", LINE);
				await mapText(A);

				for (let i = 0; i < 3; i++) await addRow({ raw_name: X });
			},
			during: async (bank) => {
				if (bank === X) await saveAiSwitches(db, { lookupStores: false });
			},
			line: null,
		},
	];

	it.each(rows)("11. $name", async (row) => {
		// A has a row a person filed, which Jev never asked: it never holds the store back (decision 225), so every
		// row's store is asked for its names.
		await addRow({
			raw_name: A,
			category_id: await foodId(),
			category_source: "user",
		});
		await row.setup();
		await addRow({ raw_name: B });

		const first = recordingAi(row.during);

		await suggestMerchantNames(envWith(first.ai, row.env));

		const askedA = nameCallsOf(first.calls).includes(A);

		expect(askedA).toBe(!row.waits);

		if (row.waits) {
			// Not asked and no row for A yet; once its lookup is no longer pending, A is asked, plain.
			expect(await statusOf(A)).toBeNull();
			await db
				.prepare(
					"UPDATE merchant_lookups SET status = 'gave_up' WHERE lookup_text = ?",
				)
				.bind(textOf(A))
				.run();

			const second = recordingAi();

			await suggestMerchantNames(envWith(second.ai, row.env));

			expect(second.calls.find((call) => call.bank === A)?.line ?? null).toBe(
				null,
			);
		} else {
			expect(first.calls.find((call) => call.bank === A)?.line ?? null).toBe(
				row.line,
			);
		}

		// B is the control: no lookup row, so it is always asked plain.
		const b = first.calls.find((call) => call.bank === B);

		expect(b).toBeDefined();
		expect(b?.line ?? null).toBeNull();
	});

	// 12. A change while A's call is out: its answer is dropped unless its line still stands at the save (BUG_NO_NAME_GUARD).
	it.each([
		{
			name: "none (control)",
			change: async () => {},
			saved: true,
		},
		{
			name: "status skipped, line NULL",
			change: async () => {
				await db
					.prepare(
						"UPDATE merchant_lookups SET status = 'skipped', line = NULL WHERE lookup_text = ?",
					)
					.bind(textOf(A))
					.run();
			},
			saved: false,
		},
		{
			name: "A's map row made private",
			change: async () => {
				await db
					.prepare(
						"UPDATE merchant_lookup_texts SET private = 1 WHERE merchant_key = ?",
					)
					.bind(A)
					.run();
			},
			saved: false,
		},
		{
			name: "lookup switch off",
			change: async () => {
				await saveAiSwitches(db, { lookupStores: false });
			},
			saved: false,
		},
		{
			name: "Spot paychecks off",
			change: async () => {
				await saveAiSwitches(db, { income: false });
			},
			saved: false,
		},
	])("12. a change during A's call: $name", async ({ change, saved }) => {
		await lookupAt(textOf(A), "found", LINE);
		await mapText(A);
		await addRow({ raw_name: A });
		await addRow({ raw_name: A });
		await addRow({ raw_name: B });

		const first = recordingAi(async (bank) => {
			if (bank === A) await change();
		});

		const result = await suggestMerchantNames(envWith(first.ai));

		expect(first.calls.find((call) => call.bank === A)?.line).toBe(LINE);
		expect(result.suggested).toBe(saved ? 2 : 1);
		expect(await statusOf(B)).toBe("pending");

		if (saved) {
			expect(await statusOf(A)).toBe("pending");
			expect(await namesOf(A)).toEqual(["Tidy Name"]);

			return;
		}

		// Refused: no row and no names for A, and not counted; asked again on a second run, plain.
		expect(await statusOf(A)).toBeNull();
		expect(await namesOf(A)).toEqual([]);

		const second = recordingAi();

		await suggestMerchantNames(envWith(second.ai));

		expect(second.calls.find((call) => call.bank === A)?.line ?? null).toBe(
			null,
		);
		expect(await statusOf(A)).toBe("pending");
	});

	// 13. The line is read before each call, not once for the run (spec §7:248).
	it.each([
		{
			name: "C's line is dropped",
			change: async () => {
				await db
					.prepare(
						"UPDATE merchant_lookups SET status = 'skipped', line = NULL WHERE lookup_text = ?",
					)
					.bind(textOf(C))
					.run();
			},
		},
		{
			name: "C's key is made private",
			change: async () => {
				await db
					.prepare(
						"UPDATE merchant_lookup_texts SET private = 1 WHERE merchant_key = ?",
					)
					.bind(C)
					.run();
			},
		},
		{
			name: "the lookup switch is turned off",
			change: async () => {
				await saveAiSwitches(db, { lookupStores: false });
			},
		},
	])(
		"13. $name during A's call: C's request carries no line",
		async ({ change }) => {
			await lookupAt(textOf(A), "found", LINE);
			await mapText(A);
			await lookupAt(textOf(C), "found", LINE);
			await mapText(C);
			await addRow({ raw_name: A });
			await addRow({ raw_name: A });
			await addRow({ raw_name: C });

			const ai = recordingAi(async (bank) => {
				if (bank === A) await change();
			});

			await suggestMerchantNames(envWith(ai.ai));

			expect(ai.calls.find((call) => call.bank === A)?.line).toBe(LINE);
			expect(ai.calls.find((call) => call.bank === C)?.line ?? null).toBeNull();
			expect(await namesOf(C)).toEqual(["Tidy Name"]);
		},
	);

	// 14. The wait counts for the note split: with the only name waiting, notes take the whole limit (C3: 60 notes, not 50).
	it("14. namesWaiting counts the wait: with the only name waiting, the night's notes take all 60 untried calls", async () => {
		await eligibleStore(A);
		await mapText(A);
		await lookupAt(textOf(A), "pending");

		for (let i = 0; i < 60; i++) {
			await db
				.prepare(
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, details_asked, note_worth_writing, note_state)
					 VALUES (1, '2026-10-01', 100, ?, ?, 1, 1, 'queued')`,
				)
				.bind(`NOTE SHOP ${i}`, `Note Shop ${i}`)
				.run();
		}

		const calls: string[] = [];

		const ai = fakeAi(
			vi.fn(
				async (_model: string, input: { messages: { content: string }[] }) => {
					calls.push(
						input.messages[0]?.content === INSTRUCTIONS ? "name" : "note",
					);

					return { response: "" };
				},
			),
		);

		await suggestNightlyNames(envWith(ai));

		expect(calls.filter((call) => call === "note")).toHaveLength(60);
		expect(calls.filter((call) => call === "name")).toHaveLength(0);
	});

	// 15. A waiting store does not take a call slot from the others.
	it("15. the wait does not eat the night's slots: a waiting store of three rows leaves the one-call limit to B", async () => {
		await eligibleStore(A);
		await eligibleStore(A);
		await eligibleStore(A);
		await mapText(A);
		await lookupAt(textOf(A), "pending");
		await addRow({ raw_name: B });

		const ai = recordingAi();

		await suggestMerchantNames(envWith(ai.ai), 1);

		expect(nameCallsOf(ai.calls)).toEqual([B]);
	});

	// 16. Nothing logs the bank text, the lookup text or the line, over a saved line answer, a dropped one and a thrown call.
	it("16. nothing logs the bank text, the lookup text or the line", async () => {
		const logs: string[] = [];

		const spies = [
			vi.spyOn(console, "log").mockImplementation((...args) => {
				logs.push(args.map(String).join(" "));
			}),
			vi.spyOn(console, "error").mockImplementation((...args) => {
				logs.push(args.map(String).join(" "));
			}),
			vi.spyOn(console, "warn").mockImplementation((...args) => {
				logs.push(args.map(String).join(" "));
			}),
		];

		await lookupAt(textOf(A), "found", LINE);
		await mapText(A);
		await lookupAt(textOf(C), "found", LINE);
		await mapText(C);
		await addRow({ raw_name: A });
		await addRow({ raw_name: C });
		await addRow({ raw_name: B });

		const ai = recordingAi(async (bank) => {
			if (bank === A) {
				await db
					.prepare(
						"UPDATE merchant_lookups SET status = 'skipped', line = NULL WHERE lookup_text = ?",
					)
					.bind(textOf(A))
					.run();
			}

			if (bank === C)
				throw Object.assign(new Error("boom"), { name: "AiError" });
		});

		await suggestMerchantNames(envWith(ai.ai));

		for (const spy of spies) spy.mockRestore();

		const joined = logs.join("\n");

		expect(joined).not.toContain(LINE);
		expect(joined).not.toContain(textOf(A));
		expect(joined).not.toContain(A);
		expect(joined).not.toContain(C);
	});
});
