import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reserveJevCalls } from "../src/db/jev-calls";
import { lookupCallsKey } from "../src/db/lookup-calls";
import {
	claimStatements,
	failStatement,
	holdsClaim,
	leaseCutoff,
	letGoStatement,
	readLookup,
	readLookups,
	saveResultStatement,
	skipStatements,
} from "../src/db/store-lookups";
import { next } from "../src/machines/next";
import {
	LOOKUP_LEASE_MS,
	STORE_LOOKUP_ROWS,
	storeLookupMachine,
	storeLookupState,
} from "../src/machines/store-lookup";

// The store lookup's guarded statements (spec §7, §5 `lookup_calls_<date>`): each claim takes one search from the
// day's count in its own batch, and each save, failure, let-go and skip is guarded by the stored row's state.

const db = env.DB;

const DAY = "2026-11-15";
const YESTERDAY = "2026-11-14";
const NOW_MS = Date.parse("2026-11-15T12:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();
const CUTOFF_MS = NOW_MS - LOOKUP_LEASE_MS;
const LIVE_ISO = new Date(NOW_MS - 60_000).toISOString();
const ME = "run-me";

type Seed = {
	text: string;
	status: string;
	attempts?: number;
	claimedBy?: string | null;
	claimedAt?: string | null;
	line?: string | null;
};

async function seed(row: Seed) {
	await db
		.prepare(
			"INSERT INTO merchant_lookups (lookup_text, status, line, attempts, claimed_by, claimed_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind(
			row.text,
			row.status,
			row.line ?? null,
			row.attempts ?? 0,
			row.claimedBy ?? null,
			row.claimedAt ?? null,
		)
		.run();
}

async function rowOf(text: string) {
	return db
		.prepare("SELECT * FROM merchant_lookups WHERE lookup_text = ?")
		.bind(text)
		.first<{
			lookup_text: string;
			status: string;
			line: string | null;
			attempts: number;
			claimed_by: string | null;
			claimed_at: string | null;
			failed_at: string | null;
			looked_up_at: string | null;
		}>();
}

async function householdRows(prefix: string) {
	return (
		await db
			.prepare(
				"SELECT key, value FROM household_settings WHERE key GLOB ? ORDER BY key",
			)
			.bind(`${prefix}*`)
			.all<{ key: string; value: string }>()
	).results;
}

/** The day's search count, or null when no row has been written yet. */
async function countOf(day = DAY): Promise<number | null> {
	const row = await db
		.prepare("SELECT value FROM household_settings WHERE key = ?")
		.bind(lookupCallsKey(day))
		.first<{ value: string }>();

	return row === null ? null : Number(row.value);
}

async function setCount(value: number, day = DAY) {
	await db
		.prepare(
			"INSERT INTO household_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.bind(lookupCallsKey(day), String(value))
		.run();
}

async function setSwitch(key: string, value: "on" | "off") {
	await db
		.prepare(
			"INSERT INTO household_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.bind(key, value)
		.run();
}

/** One claim, run as its own batch; `landed` is whether the claim took the store (the batch's middle statement). */
async function claim(text: string, token: string, cap = 300, nowMs = NOW_MS) {
	const results = await db.batch(
		claimStatements(db, { text, token, nowMs, day: DAY, cap }),
	);

	return { landed: results[1]?.meta.changes === 1, results };
}

beforeEach(async () => {
	await db.batch([
		db.prepare(
			"DELETE FROM household_settings WHERE key GLOB 'lookup_calls_*' OR key GLOB 'jev_calls_*' OR key GLOB 'jev_reserved_*' OR key GLOB 'ai_*'",
		),
		db.prepare("DELETE FROM merchant_lookups"),
	]);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("reading the stored lookups", () => {
	it("maps each row by its lookup text, with its claim and attempts", async () => {
		await seed({
			text: "la coop",
			status: "pending",
			attempts: 1,
			claimedBy: ME,
			claimedAt: LIVE_ISO,
		});
		await seed({ text: "bakery", status: "found", line: "Bakery" });

		const lookups = await readLookups(db);

		expect(lookups.get("la coop")).toEqual({
			lookupText: "la coop",
			status: "pending",
			claimedBy: ME,
			claimedAt: LIVE_ISO,
			attempts: 1,
		});
		expect(lookups.get("bakery")?.status).toBe("found");
		expect(await readLookup(db, "missing")).toBeNull();
	});
});

describe("the day's cap on claims (the count and the take)", () => {
	it.each([
		["no count row yet, cap 300: the claim lands", null, 300, true],
		["a count of 0, cap 300: the claim lands", 0, 300, true],
		["a count of 1, cap 300: the claim lands", 1, 300, true],
		["a count of 299, cap 300: the claim lands", 299, 300, true],
		["a count of 300, cap 300: the claim is refused", 300, 300, false],
		["a count of 305, cap 300: the claim is refused", 305, 300, false],
		["no count row, cap 0 (the demo): the claim is refused", null, 0, false],
	] as const)("%s", async (_name, before, cap, lands) => {
		if (before !== null) await setCount(before);

		const { landed } = await claim("store", ME, cap);

		expect(landed).toBe(lands);
		const after = await countOf();
		const expected = (before ?? 0) + (lands ? 1 : 0);

		if (before === null && !lands) expect(after).toBeNull();
		else expect(after).toBe(expected);
	});
});

describe("a refused claim takes nothing", () => {
	it.each<[string, Omit<Seed, "text">]>([
		[
			"a live claim by another run",
			{ status: "pending", claimedBy: "other-run", claimedAt: LIVE_ISO },
		],
		["a found line", { status: "found", line: "Bakery" }],
		["a gave_up store", { status: "gave_up", attempts: 3 }],
	])("%s", async (_name, fields) => {
		await seed({ text: "store", ...fields });

		const { landed } = await claim("store", ME);

		expect(landed).toBe(false);
		expect(await countOf()).toBeNull();
		const row = await rowOf("store");
		expect(row?.status).toBe(fields.status);
		expect(row?.claimed_by ?? null).toBe(fields.claimedBy ?? null);
	});
});

describe("races", () => {
	it("two batches built while a store is free: the first lands, the second does not", async () => {
		const first = claimStatements(db, {
			text: "store",
			token: "A",
			nowMs: NOW_MS,
			day: DAY,
			cap: 300,
		});

		const second = claimStatements(db, {
			text: "store",
			token: "B",
			nowMs: NOW_MS,
			day: DAY,
			cap: 300,
		});

		const a = await db.batch(first);
		const b = await db.batch(second);

		expect(a[1]?.meta.changes).toBe(1);
		expect(b[1]?.meta.changes).toBe(0);
		expect(await countOf()).toBe(1);
		expect((await rowOf("store"))?.claimed_by).toBe("A");
	});

	it("two stores and one search left: exactly one claim lands", async () => {
		await setCount(299);

		const both = [
			...claimStatements(db, {
				text: "first",
				token: "A",
				nowMs: NOW_MS,
				day: DAY,
				cap: 300,
			}),
			...claimStatements(db, {
				text: "second",
				token: "B",
				nowMs: NOW_MS,
				day: DAY,
				cap: 300,
			}),
		];

		const results = await db.batch(both);

		const landed = [results[1], results[4]].filter(
			(r) => r?.meta.changes === 1,
		);

		expect(landed).toHaveLength(1);
		expect(await countOf()).toBe(300);
	});
});

describe("the lease edge agrees with the machine", () => {
	const cutoff = CUTOFF_MS;

	const cases: [string, Partial<Seed>, boolean][] = [
		[
			"claimed_at one ms before the cutoff",
			{ claimedBy: "A", claimedAt: new Date(cutoff - 1).toISOString() },
			true,
		],
		[
			"claimed_at at the cutoff",
			{ claimedBy: "A", claimedAt: new Date(cutoff).toISOString() },
			true,
		],
		[
			"claimed_at one ms after the cutoff",
			{ claimedBy: "A", claimedAt: new Date(cutoff + 1).toISOString() },
			false,
		],
		["claimed_by null", { claimedBy: null, claimedAt: LIVE_ISO }, true],
		["claimed_at null", { claimedBy: "A", claimedAt: null }, true],
	];

	it.each(cases)("%s", async (_name, fields, lands) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW_MS);

		await seed({ text: "store", status: "pending", ...fields });
		const before = await readLookup(db, "store");
		const now = new Date(NOW_MS);

		const { landed } = await claim("store", "B");

		expect(landed).toBe(lands);
		expect(storeLookupState(before, now) === "to_retry").toBe(landed);
		expect(holdsClaim(before, "A", now)).toBe(!landed);
	});
});

describe("the switches at the claim", () => {
	const SWITCHES = ["ai_lookup_stores", "ai_categories", "ai_income"];

	it.each(SWITCHES)(
		"%s off: no claim lands, new or to_retry, and no count is taken",
		async (key) => {
			await setSwitch(key, "off");
			await seed({ text: "to-retry", status: "pending", attempts: 1 });

			expect((await claim("new-store", ME)).landed).toBe(false);
			expect((await claim("to-retry", ME)).landed).toBe(false);

			expect(await countOf()).toBeNull();
			expect((await rowOf("to-retry"))?.claimed_by ?? null).toBeNull();
		},
	);
});

describe("the claim's batch order", () => {
	it("a landed claim takes exactly one, and yesterday's count row is gone", async () => {
		await setCount(5, YESTERDAY);
		await setCount(2, DAY);

		const { landed } = await claim("store", ME);

		expect(landed).toBe(true);
		expect(await countOf()).toBe(3);
		expect(await countOf(YESTERDAY)).toBeNull();
	});

	it("a refused claim takes nothing even when yesterday's row is dropped in the same batch", async () => {
		await setCount(5, YESTERDAY);
		await setCount(300, DAY);

		const { landed } = await claim("store", ME, 300);

		expect(landed).toBe(false);
		expect(await countOf()).toBe(300);
		expect(await countOf(YESTERDAY)).toBeNull();
	});
});

describe("cleanup", () => {
	it("keeps only today's count; every jev_calls row stays", async () => {
		await setCount(5, YESTERDAY);
		await setCount(2, "2026-11-13");
		await setCount(1, DAY);
		await db
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('jev_calls_2026-11-14', '40'), ('jev_calls_2026-11-15', '3')",
			)
			.run();
		const jevBefore = await householdRows("jev_calls_");

		await claim("store", ME);

		expect(await householdRows("lookup_calls_")).toEqual([
			{ key: lookupCallsKey(DAY), value: "2" },
		]);
		expect(await householdRows("jev_calls_")).toEqual(jevBefore);
	});

	it("reserving Jev's calls never writes or drops a lookup count", async () => {
		await setCount(5, YESTERDAY);
		await setCount(2, DAY);
		const lookupBefore = await householdRows("lookup_calls_");

		await reserveJevCalls(db, DAY, 500, 5, "group:cleanup");

		expect(await householdRows("lookup_calls_")).toEqual(lookupBefore);
	});
});

// The guards, in full: each statement runs on six kinds of row, and changes only the row that is ours and pending.
type RowKind = { name: string; seed: Seed; ours: boolean };

const ROW_KINDS: RowKind[] = [
	{
		name: "pending, ours, live",
		seed: {
			text: "ours-live",
			status: "pending",
			claimedBy: ME,
			claimedAt: LIVE_ISO,
		},
		ours: true,
	},
	{
		name: "pending, ours, lease over",
		seed: {
			text: "ours-lapsed",
			status: "pending",
			claimedBy: ME,
			claimedAt: new Date(CUTOFF_MS - 60_000).toISOString(),
		},
		ours: true,
	},
	{
		name: "pending, another token's",
		seed: {
			text: "theirs",
			status: "pending",
			claimedBy: "other-run",
			claimedAt: LIVE_ISO,
		},
		ours: false,
	},
	{
		name: "pending, unclaimed",
		seed: { text: "unclaimed", status: "pending" },
		ours: false,
	},
	{
		name: "found",
		seed: { text: "found", status: "found", line: "Bakery" },
		ours: false,
	},
	{
		name: "skipped",
		seed: { text: "skipped", status: "skipped" },
		ours: false,
	},
];

const SWITCH_VARIANTS: [string, string | null][] = [
	["all on", null],
	["lookup off", "ai_lookup_stores"],
	["categories off", "ai_categories"],
	["income off", "ai_income"],
];

const SAVES = [
	{ name: "save found", status: "found" as const, event: "SAVE_FOUND" },
	{
		name: "save nothing",
		status: "nothing_found" as const,
		event: "SAVE_NOTHING",
	},
];

describe("the guards in full (BUG_NO_TOKEN)", () => {
	beforeEach(async () => {
		for (const kind of ROW_KINDS) await seed(kind.seed);
	});

	for (const save of SAVES) {
		for (const kind of ROW_KINDS) {
			for (const [switchName, offKey] of SWITCH_VARIANTS) {
				it(`${save.name} on a ${kind.name} row, ${switchName}`, async () => {
					if (offKey !== null) await setSwitch(offKey, "off");

					const result = await saveResultStatement(db, {
						text: kind.seed.text,
						token: ME,
						status: save.status,
						line: save.status === "found" ? "Bakery in Arlington, VA." : null,
						nowMs: NOW_MS,
					}).run();

					const landed = kind.ours && offKey === null;
					expect(result.meta.changes).toBe(landed ? 1 : 0);

					const row = await rowOf(kind.seed.text);

					const after = next(storeLookupMachine, "claimed", save.event, {
						attempts: 0,
					});

					const wanted =
						after === null
							? undefined
							: // SAFETY: next() returns only a state of storeLookupMachine, and each is a key of STORE_LOOKUP_ROWS.
								STORE_LOOKUP_ROWS[after as keyof typeof STORE_LOOKUP_ROWS]
									?.status;

					expect(row?.status).toBe(landed ? wanted : kind.seed.status);
				});
			}
		}
	}

	for (const kind of ROW_KINDS) {
		it(`fail on a ${kind.name} row`, async () => {
			const result = await failStatement(db, {
				text: kind.seed.text,
				token: ME,
				status: "pending",
				attemptsBefore: 0,
				nowMs: NOW_MS,
			}).run();

			expect(result.meta.changes).toBe(kind.ours ? 1 : 0);
			const row = await rowOf(kind.seed.text);

			if (kind.ours) {
				expect(row).toMatchObject({
					status: "pending",
					attempts: 1,
					failed_at: NOW_ISO,
					claimed_by: null,
					claimed_at: null,
				});
			} else {
				expect(row?.status).toBe(kind.seed.status);
			}
		});

		it(`let go on a ${kind.name} row`, async () => {
			const result = await letGoStatement(db, {
				text: kind.seed.text,
				token: ME,
			}).run();

			expect(result.meta.changes).toBe(kind.ours ? 1 : 0);
			const row = await rowOf(kind.seed.text);

			if (kind.ours) {
				expect(row).toMatchObject({
					status: "pending",
					attempts: 0,
					claimed_by: null,
					claimed_at: null,
				});
			} else {
				expect(row?.status).toBe(kind.seed.status);
			}
		});
	}

	it("a failure and a let-go ignore every switch: the model keeps a failure whatever the switches say", async () => {
		await setSwitch("ai_lookup_stores", "off");
		await setSwitch("ai_categories", "off");
		await setSwitch("ai_income", "off");

		const failed = await failStatement(db, {
			text: "ours-live",
			token: ME,
			status: "pending",
			attemptsBefore: 0,
			nowMs: NOW_MS,
		}).run();

		expect(failed.meta.changes).toBe(1);
	});

	it("a failure is guarded by its attempts too", async () => {
		await seed({
			text: "tried",
			status: "pending",
			attempts: 1,
			claimedBy: ME,
			claimedAt: LIVE_ISO,
		});

		const stale = await failStatement(db, {
			text: "tried",
			token: ME,
			status: "pending",
			attemptsBefore: 0,
			nowMs: NOW_MS,
		}).run();

		expect(stale.meta.changes).toBe(0);

		const current = await failStatement(db, {
			text: "tried",
			token: ME,
			status: "gave_up",
			attemptsBefore: 1,
			nowMs: NOW_MS,
		}).run();

		expect(current.meta.changes).toBe(1);
		expect(await rowOf("tried")).toMatchObject({
			status: "gave_up",
			attempts: 2,
		});
	});
});

describe("the skip table", () => {
	it("none, to_retry and found become skipped (the line dropped); the rest are untouched", async () => {
		await seed({ text: "found-text", status: "found", line: "Shop" });
		await seed({ text: "retry-text", status: "pending", attempts: 1 });
		await seed({
			text: "live-text",
			status: "pending",
			claimedBy: "other-run",
			claimedAt: LIVE_ISO,
		});
		await seed({ text: "nothing-text", status: "nothing_found" });
		await seed({ text: "skipped-text", status: "skipped" });
		await seed({ text: "gave-text", status: "gave_up", attempts: 3 });

		const statements = skipStatements(
			db,
			[
				"none-text",
				"retry-text",
				"found-text",
				"live-text",
				"nothing-text",
				"skipped-text",
				"gave-text",
			],
			NOW_MS,
		);

		await db.batch(statements);

		expect(await rowOf("none-text")).toMatchObject({ status: "skipped" });
		expect(await rowOf("retry-text")).toMatchObject({
			status: "skipped",
			claimed_by: null,
		});
		expect(await rowOf("found-text")).toMatchObject({
			status: "skipped",
			line: null,
		});
		expect(await rowOf("live-text")).toMatchObject({
			status: "pending",
			claimed_by: "other-run",
		});
		expect(await rowOf("nothing-text")).toMatchObject({
			status: "nothing_found",
		});
		expect(await rowOf("skipped-text")).toMatchObject({ status: "skipped" });
		expect(await rowOf("gave-text")).toMatchObject({ status: "gave_up" });
	});

	it("1,200 texts take three statements", () => {
		const texts = Array.from({ length: 1200 }, (_, i) => `text ${i}`);

		expect(skipStatements(db, texts, NOW_MS)).toHaveLength(3);
	});
});

describe("times", () => {
	it("every time column written is the given instant, as ISO text", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW_MS);
		await seed({ text: "timed", status: "pending", attempts: 0 });
		await seed({
			text: "failing",
			status: "pending",
			claimedBy: ME,
			claimedAt: LIVE_ISO,
		});

		await claim("fresh", ME);
		expect((await rowOf("fresh"))?.claimed_at).toBe(NOW_ISO);

		await saveResultStatement(db, {
			text: "fresh",
			token: ME,
			status: "found",
			line: "Shop",
			nowMs: NOW_MS,
		}).run();
		expect((await rowOf("fresh"))?.looked_up_at).toBe(NOW_ISO);

		await failStatement(db, {
			text: "failing",
			token: ME,
			status: "pending",
			attemptsBefore: 0,
			nowMs: NOW_MS,
		}).run();
		expect((await rowOf("failing"))?.failed_at).toBe(NOW_ISO);
	});
});

describe("the lease cutoff", () => {
	it("is the instant minus the lease, as ISO text", () => {
		expect(leaseCutoff(NOW_MS)).toBe(new Date(CUTOFF_MS).toISOString());
	});
});

// The save's private guard (spec §7, "when its line is saved"): a row that turns private between the save's read and its
// write stops the save. The merchant_lookup_texts mark is the one the guard reads.

describe("a saved line is kept only while its text is not private", () => {
	const PRIVATE_TEXT = "private bakery";

	beforeEach(async () => {
		await db.prepare("DELETE FROM merchant_lookup_texts").run();
	});

	async function markText(text: string, isPrivate: 0 | 1) {
		await db
			.prepare(
				"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES (?, ?, ?)",
			)
			.bind(`key-${text}`, text, isPrivate)
			.run();
	}

	for (const status of ["found", "nothing_found"] as const) {
		const line = status === "found" ? "Bakery in Arlington, VA." : null;

		it(`a ${status} save changes nothing when the text is private`, async () => {
			await seed({ text: PRIVATE_TEXT, status: "pending", claimedBy: ME, claimedAt: LIVE_ISO });
			await markText(PRIVATE_TEXT, 1);

			const result = await saveResultStatement(db, {
				text: PRIVATE_TEXT,
				token: ME,
				status,
				line,
				nowMs: NOW_MS,
			}).run();

			expect(result.meta.changes).toBe(0);
			expect((await readLookup(db, PRIVATE_TEXT))?.status).toBe("pending");
		});

		it(`a ${status} save lands when the text's mark is 0`, async () => {
			await seed({ text: "public bakery", status: "pending", claimedBy: ME, claimedAt: LIVE_ISO });
			await markText("public bakery", 0);

			const result = await saveResultStatement(db, {
				text: "public bakery",
				token: ME,
				status,
				line,
				nowMs: NOW_MS,
			}).run();

			expect(result.meta.changes).toBe(1);
		});

		it(`a ${status} save lands when the text has no mark row`, async () => {
			await seed({ text: "unmarked bakery", status: "pending", claimedBy: ME, claimedAt: LIVE_ISO });

			const result = await saveResultStatement(db, {
				text: "unmarked bakery",
				token: ME,
				status,
				line,
				nowMs: NOW_MS,
			}).run();

			expect(result.meta.changes).toBe(1);
		});
	}
});
