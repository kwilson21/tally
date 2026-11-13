import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { resetDemo } from "../src/demo/reset";
import { mergePendingIntoPosted } from "../src/plaid/pending-merge";
import { present } from "./helpers/present";

// Tally's log of what its AI did follows the category it counts (spec section 5): when the bank posts a pending
// purchase that is already stored, the pending row's log row moves onto the posted row exactly when the pending row's
// category moves onto it, and otherwise stays with no transaction. The log's conditions and the category statements in
// src/plaid/pending-merge.ts say the same three cases, so this runs every pending row against every posted row and
// checks the two agree. (Audit finding: the log arms only had comments saying they mirror the category statements.)

const db = env.DB;
const TODAY = "2026-10-11";
const ITEM_LOCK = "lock-log";

type Pending = {
	label: string;
	set: string;
	/** What the posted row's category becomes when it takes this pending row's. */
	takes: { id: number; source: string };
};

// A category log row exists only for a purchase that has a category, so the pending row always has one.
const PENDING: Pending[] = [
	{
		label: "Jev's pick",
		set: "category_id = 1, category_source = 'jev', category_confidence = 0.9, jev_category_id = 1",
		takes: { id: 1, source: "jev" },
	},
	{
		label: "a person's pick",
		set: "category_id = 1, category_source = 'user'",
		takes: { id: 1, source: "user" },
	},
	{
		label: "a rule's pick",
		set: "category_id = 1, category_source = 'merchant_rule'",
		takes: { id: 1, source: "merchant_rule" },
	},
];

type Posted = { label: string; set: string };

const POSTED: Posted[] = [
	{ label: "no category", set: "" },
	{ label: "an unsure answer", set: "category_confidence = 0.5" },
	{
		label: "Jev's pick",
		set: "category_id = 2, category_source = 'jev', category_confidence = 0.9",
	},
	{
		label: "a person's pick",
		set: "category_id = 2, category_source = 'user'",
	},
	{
		label: "a rule's pick",
		set: "category_id = 2, category_source = 'merchant_rule'",
	},
];

const POSTED_SPLITS: { label: string; set: string }[] = [
	{ label: "whole", set: "" },
	{ label: "split away", set: "split_removed_from_cents = 1200" },
	{ label: "split", set: "is_split = 1" },
];

const PENDING_SPLITS = [
	{ label: "whole", set: "" },
	{ label: "split", set: "is_split = 1" },
];

const MERGE_SOURCE = present(
	Object.values(
		import.meta.glob("../src/plaid/pending-merge.ts", {
			query: "?raw",
			import: "default",
			eager: true,
		}),
	)[0],
);

let item = 0;
let counter = 0;

beforeAll(async () => {
	await resetDemo(db, TODAY);
	await db.prepare("DELETE FROM ai_log").run();
	item = present(
		(
			await db
				.prepare("SELECT id FROM plaid_items ORDER BY id LIMIT 1")
				.first<{ id: number }>()
		)?.id,
	);
	await db
		.prepare("UPDATE plaid_items SET sync_lock_id = ? WHERE id = ?")
		.bind(ITEM_LOCK, item)
		.run();
});

const store = async (
	plaidId: string,
	pending: number,
	cents: number,
	set: string,
) => {
	const id = present(
		(
			await db
				.prepare(
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, pending, updated_by)
					 VALUES (1, ?, ?, 'CORNER COFFEE', ?, ?, 'test') RETURNING id`,
				)
				.bind(TODAY, cents, plaidId, pending)
				.first<{ id: number }>()
		)?.id,
	);

	if (set)
		await db
			.prepare(`UPDATE transactions SET ${set} WHERE id = ?`)
			.bind(id)
			.run();

	return id;
};

type Outcome = {
	logMoved: boolean;
	categoryTaken: boolean;
};

/** Merges one pending purchase into its posted row and says whether the log moved and whether the category did. */
async function merge(
	pending: Pending,
	pendingSplit: string,
	posted: Posted,
	postedSplit: string,
	cents: number,
): Promise<Outcome> {
	counter += 1;

	const pendingId = await store(
		`pend-${counter}`,
		1,
		1200,
		[pending.set, pendingSplit].filter(Boolean).join(", "),
	);

	const postedId = await store(
		`post-${counter}`,
		0,
		cents,
		[posted.set, postedSplit].filter(Boolean).join(", "),
	);

	await db
		.prepare(
			"INSERT INTO ai_log (kind, transaction_id, household_day) VALUES ('category', ?, ?)",
		)
		.bind(pendingId, TODAY)
		.run();

	const before = present(
		await db
			.prepare(
				"SELECT category_id AS id, category_source AS source FROM transactions WHERE id = ?",
			)
			.bind(postedId)
			.first<{ id: number | null; source: string | null }>(),
	);

	await db.batch(
		mergePendingIntoPosted(db, item, ITEM_LOCK, `pend-${counter}`, {
			id: `post-${counter}`,
			cents,
			date: TODAY,
			name: "CORNER COFFEE",
			merchantName: null,
			plaidCategory: null,
		}),
	);

	const after = present(
		await db
			.prepare(
				"SELECT category_id AS id, category_source AS source FROM transactions WHERE id = ?",
			)
			.bind(postedId)
			.first<{ id: number | null; source: string | null }>(),
	);

	const log = present(
		await db
			.prepare(
				"SELECT transaction_id AS id FROM ai_log WHERE kind = 'category' AND id = (SELECT MAX(id) FROM ai_log)",
			)
			.first<{ id: number | null }>(),
	);

	const changed = before.id !== after.id || before.source !== after.source;

	return {
		logMoved: log.id === postedId,
		categoryTaken:
			changed &&
			after.id === pending.takes.id &&
			after.source === pending.takes.source,
	};
}

describe("a pending purchase's category log follows its category onto the posted row", () => {
	it("moves the log row exactly when the posted row took the pending row's category, for every pair", async () => {
		const wrong: string[] = [];
		const moved = new Set<string>();

		for (const pending of PENDING)
			for (const pendingSplit of PENDING_SPLITS)
				for (const posted of POSTED)
					for (const postedSplit of POSTED_SPLITS)
						for (const cents of [1200, 1500]) {
							const outcome = await merge(
								pending,
								pendingSplit.set,
								posted,
								postedSplit.set,
								cents,
							);

							const name = `pending ${pendingSplit.label} with ${pending.label} -> posted ${postedSplit.label} with ${posted.label}, ${cents === 1200 ? "same" : "changed"} amount`;

							if (outcome.logMoved !== outcome.categoryTaken)
								wrong.push(
									`${name}: log moved=${outcome.logMoved}, category taken=${outcome.categoryTaken}`,
								);

							if (outcome.logMoved)
								moved.add(`${pendingSplit.label} ${pending.label}`);
						}

		expect(wrong).toEqual([]);
		// No vacuous pass: each of the three cases moved at least one log row.
		expect([...moved]).toEqual(
			expect.arrayContaining([
				"whole a person's pick",
				"whole Jev's pick",
				"split Jev's pick",
			]),
		);
	}, 120_000);
});

describe("the conditions are written once", () => {
	const countOf = (needle: string) => MERGE_SOURCE.split(needle).length - 1;

	it.each([
		[
			"a person's pick moves",
			"p.category_source = 'user' AND p.category_id IS NOT NULL",
		],
		["the posted row holds a person's pick", "category_source, '') = 'user'"],
		[
			"the posted row's category is open to Jev",
			`category_id IS NULL AND \${posted}.category_source IS NULL`,
		],
		[
			"a split is removed by the amount",
			"p.is_split = 1 AND p.amount_cents != ?3",
		],
	])(
		"%s is spelled once in src/plaid/pending-merge.ts (the category statement and the log call its function)",
		(_name, needle) => {
			expect(countOf(needle)).toBe(1);
		},
	);
});
