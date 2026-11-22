import { beforeEach, describe, expect, it } from "vitest";
import { cleanBankText } from "../src/clean-bank-text";
import { readAiSwitches, saveAiSwitches } from "../src/db/ai-switches";
import { merchantsToAsk } from "../src/db/merchant-names";
import {
	linedNames,
	readLineForName,
	waitingLookupTexts,
} from "../src/lookup/names";
import {
	addRow,
	db,
	eligibleStore,
	LINE,
	lookupRunSetup,
	makePrivate,
	MINUTE,
	NOON_MS,
	storeName,
	textOf,
} from "./lookup-run-setup";
import { seedMerchant } from "./helpers/merchants";

// The names' line reads (spec §7, "Where the line goes" and "The wait"; decisions 216 and 225): which asked-about store a name
// waits for, which bank texts carry a line that stands, and the read made before each call. The fixtures are rows, inserted
// directly, so each case sets only the facts it names.

const A = storeName(0);
const B = storeName(1);
const OPEN = { DEMO: "false", TAVILY_API_KEY: "tvly" };

/** The first unarchived category: the one a rule names. */
async function foodId(): Promise<number> {
	const row = await db
		.prepare("SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1")
		.first<{ id: number }>();

	return Number(row?.id);
}

/** Maps a bank key to a lookup text (merchant_lookup_texts), as the lookup's text step does. */
async function mapText(key: string, text = textOf(key), priv = 0) {
	await db
		.prepare(
			"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES (?, ?, ?)",
		)
		.bind(key, text, priv)
		.run();
}

/** A stored lookup row for a text: its status, and its line when it has one. */
async function lookupAt(
	text: string,
	status: string,
	line: string | null = null,
	extra: { attempts?: number; claimedAt?: string; claimedBy?: string } = {},
) {
	await db
		.prepare(
			"INSERT INTO merchant_lookups (lookup_text, status, line, attempts, claimed_at, claimed_by) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind(
			text,
			status,
			line,
			extra.attempts ?? 0,
			extra.claimedAt ?? null,
			extra.claimedBy ?? null,
		)
		.run();
}

async function switchesOff(keys: { lookupStores?: boolean; income?: boolean }) {
	await saveAiSwitches(db, keys);
}

describe("waiting, lines and the name read", () => {
	lookupRunSetup();

	beforeEach(async () => {
		await db.prepare("DELETE FROM bill_payments").run();
		await db.prepare("DELETE FROM transactions").run();
		await db.prepare("DELETE FROM merchant_suggested_names").run();
		await db.prepare("DELETE FROM merchants").run();
		await db.prepare("DELETE FROM merchant_lookups").run();
		await db.prepare("DELETE FROM merchant_name_failures").run();
	});

	// 6. The texts whose names wait: pending and still searchable (qualifies), by store A's setup.
	it.each([
		{
			name: "pending, live claim, eligible",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending", null, {
					claimedBy: "run-x",
					claimedAt: new Date(NOON_MS).toISOString(),
				});
			},
			waits: true,
		},
		{
			name: "pending, no claim, attempts 1, eligible",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending", null, { attempts: 1 });
			},
			waits: true,
		},
		{
			name: "pending, claimed 16 minutes ago, eligible",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending", null, {
					claimedBy: "run-x",
					claimedAt: new Date(NOON_MS - 16 * MINUTE).toISOString(),
				});
			},
			waits: true,
		},
		{
			name: "no lookup row, eligible",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
			},
			waits: false,
		},
		{
			name: "found",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "found", LINE);
			},
			waits: false,
		},
		{
			name: "nothing_found",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "nothing_found");
			},
			waits: false,
		},
		{
			name: "skipped",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "skipped");
			},
			waits: false,
		},
		{
			name: "gave_up",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "gave_up", null, { attempts: 3 });
			},
			waits: false,
		},
		{
			name: "pending, plus an active merchant rule on A (#1044)",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending");
				await seedMerchant(db, { key: A, defaultCategoryId: await foodId() });
			},
			waits: false,
		},
		{
			name: "pending, plus a bank-text rule on cleanBankText(A) (#1044)",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending");
				await db
					.prepare(
						"INSERT INTO bank_text_rules (cleaned_text, category_id) VALUES (?, ?)",
					)
					.bind(cleanBankText(A), await foodId())
					.run();
			},
			waits: false,
		},
		{
			name: "pending, A's rows have no plaid category",
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
			waits: false,
		},
		{
			name: "pending, plus a second A row still waiting for Jev",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending");
				await addRow({ raw_name: A });
			},
			waits: false,
		},
		{
			name: "pending, A made private",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending");
				await makePrivate(A);
			},
			waits: false,
		},
		{
			name: "pending, lookup switch off",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending");
				await switchesOff({ lookupStores: false });
			},
			waits: false,
		},
		{
			name: "pending, Spot paychecks off",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending");
				await switchesOff({ income: false });
			},
			waits: false,
		},
		{
			name: "pending, no Tavily key",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending");
			},
			env: { DEMO: "false" },
			waits: false,
		},
		{
			name: "pending, demo",
			setup: async () => {
				await eligibleStore(A);
				await mapText(A);
				await lookupAt(textOf(A), "pending");
			},
			env: { DEMO: "true", TAVILY_API_KEY: "tvly" },
			waits: false,
		},
	])("6. waitingLookupTexts: $name", async ({ setup, env, waits }) => {
		await setup();
		const switches = await readAiSwitches(db);
		const gate = env ?? OPEN;

		expect(await waitingLookupTexts(gate, db, switches)).toEqual(
			waits ? [textOf(A)] : [],
		);
	});

	// 7. A closed gate prepares no statement at all.
	it("7. with the gate closed, waitingLookupTexts and linedNames prepare no statement", async () => {
		await eligibleStore(A);
		await mapText(A);
		await lookupAt(textOf(A), "pending");

		let statements = 0;

		const counted = new Proxy(db, {
			get(target, property) {
				if (property === "prepare" || property === "batch")
					statements += 1;

				const value = Reflect.get(target, property);

				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		const switches = await readAiSwitches(db);
		const closed = { DEMO: "true", TAVILY_API_KEY: "tvly" };

		expect(await waitingLookupTexts(closed, counted, switches)).toEqual([]);
		expect(await linedNames(closed, counted, switches, [A])).toEqual(
			new Map(),
		);
		expect(statements).toBe(0);
	});

	// 8. A waiting text's merchants leave the names' list before the limit is applied.
	it("8. merchantsToAsk leaves out a waiting text before the limit", async () => {
		for (let i = 0; i < 3; i++) await addRow({ raw_name: A });
		await addRow({ raw_name: B });
		await mapText(A);

		expect(await merchantsToAsk(db, 1, [textOf(A)])).toEqual([B]);
		expect(await merchantsToAsk(db, 1, [])).toEqual([A]);

		await db.prepare("DELETE FROM merchant_lookup_texts").run();

		expect(await merchantsToAsk(db, 1, [textOf(A)])).toEqual([A]);
	});

	// 9. A bank text gets its line only when its store's line stands and the text is its own.
	it.each([
		{
			name: "L9: the map text is the key's text and its line stands",
			setup: async () => {
				await mapText(A);
				await lookupAt(textOf(A), "found", LINE);
			},
			expected: new Map([[A, textOf(A)]]),
		},
		{
			name: "L10: the map text is stale",
			setup: async () => {
				await mapText(A, "old alder");
				await lookupAt("old alder", "found", LINE);
			},
			expected: new Map(),
		},
		{
			name: "L4: no map row",
			setup: async () => {
				await lookupAt(textOf(A), "found", LINE);
			},
			expected: new Map(),
		},
		{
			name: "L11: the line is empty",
			setup: async () => {
				await mapText(A);
				await lookupAt(textOf(A), "found", null);
			},
			expected: new Map(),
		},
		{
			name: "L11: a sibling key of the text is private",
			setup: async () => {
				await mapText(A);
				await mapText(B, textOf(A), 1);
				await lookupAt(textOf(A), "found", LINE);
			},
			expected: new Map(),
		},
		{
			name: "L3: the lookup switch is off",
			setup: async () => {
				await mapText(A);
				await lookupAt(textOf(A), "found", LINE);
				await switchesOff({ lookupStores: false });
			},
			expected: new Map(),
		},
	])("9. linedNames, $name", async ({ setup, expected }) => {
		await setup();

		expect(
			await linedNames(OPEN, db, await readAiSwitches(db), [A]),
		).toEqual(expected);
	});

	// 10. The read made before a call: the line while it stands, otherwise null.
	it("10. readLineForName returns the line while it stands", async () => {
		await mapText(A);
		await lookupAt(textOf(A), "found", LINE);

		expect(await readLineForName(db, textOf(A))).toBe(LINE);
	});

	it("10. readLineForName returns null once the lookup is no longer found", async () => {
		await mapText(A);
		await lookupAt(textOf(A), "found", LINE);
		await db
			.prepare(
				"UPDATE merchant_lookups SET status = 'skipped', line = NULL WHERE lookup_text = ?",
			)
			.bind(textOf(A))
			.run();

		expect(await readLineForName(db, textOf(A))).toBeNull();
	});

	it("10. readLineForName returns null with a key of the text private", async () => {
		await mapText(A, textOf(A), 1);
		await lookupAt(textOf(A), "found", LINE);

		expect(await readLineForName(db, textOf(A))).toBeNull();
	});

	it("10. readLineForName returns null with the lookup switch off", async () => {
		await mapText(A);
		await lookupAt(textOf(A), "found", LINE);
		await switchesOff({ lookupStores: false });

		expect(await readLineForName(db, textOf(A))).toBeNull();
	});
});
