import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
	COUNTED_JOINS,
	FOLLOWS_PURCHASE,
	INCLUDED,
	jevAsksAboutSql,
} from "../src/db/counted-month";
import { WAITING } from "../src/db/more-like-this";
import { neverSuggestedSql } from "../src/db/never-suggest";
import {
	categoryAskedSql,
	incomeAskedSql,
	payAskedSql,
} from "../src/db/suggestions-queue";
import {
	CATEGORY_ONLY,
	HELD_FOR_REVIEW_SQL,
	NEEDS_CATEGORY,
	NEEDS_JEV_CLASSIFICATION,
	waitingForJevSql,
} from "../src/db/transactions";
import {
	type Classified,
	type Context,
	classify,
	type Questions,
	type Row,
} from "../src/transactions/classify";

// classify() is the readable oracle for Tally's transaction questions. Each SQL question must give, row by row,
// the same yes or no as classify(). The rows are (a) named rows, one per state and per contradiction the schema
// allows, and (b) seeded random rows, which cover the Maybe range edges (20%, 40%, 80%).
// Every question must say yes to at least one row, so a pass cannot be empty.

const db = env.DB;

const ACTIVE_CAT = 101;
const OTHER_CAT = 102;
const ARCHIVED_CAT = 103;
const ACTIVE_IDS = new Set([ACTIVE_CAT, OTHER_CAT]);

// Fixed rows, inserted first with ids 1 to 3, because other rows point at them.
const PURCHASE = 1; // counted purchase, category OTHER_CAT
const PURCHASE_EXCLUDED = 2; // excluded purchase
const SPLIT_PARENT = 3; // split parent, paid by a planned expense

type Link = "bill" | "plan" | "dismissed_bill";
type Seed = Partial<Row> & { name?: string; link?: Link; raw_name?: string };

// The bank text a "Never suggest income" rule covers. Seeds have no merchant name, so their merchant key is their bank
// text, and the rule's key is this text. The oracle reads that fact from the seed itself; SQL reads the rule table.
const NEVER_RAW = "NEVER-INCOME";
const PLAIN_RAW = "CLASSIFY";

const DEFAULTS: Omit<Row, "id"> = {
	amount_cents: 1000,
	pending: 0,
	parent_id: null,
	is_split: 0,
	excluded: 0,
	excluded_source: null,
	flag_transfer: 0,
	flag_income: 0,
	income_source: null,
	plaid_category: null,
	category_id: null,
	category_source: null,
	category_confidence: null,
	jev_category_id: null,
	income_confidence: null,
	transfer_confidence: null,
	credit_reviewed: null,
	credit_reviewed_by: null,
	income_maybe_declined: 0,
	refund_of_id: null,
	jev_failed_at: null,
	plaid_transaction_id: "plaid-x",
};

const COLS = Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[];

const FIXED: Seed[] = [
	{ name: "counted purchase", category_id: OTHER_CAT, category_source: "user" },
	{ name: "excluded purchase", excluded: 1, excluded_source: "user" },
	{ name: "split parent (paid by a plan)", is_split: 1, link: "plan" },
];

const NAMED: Seed[] = [
	// Purchases
	{ name: "purchase, no category" },
	{
		name: "purchase, user's category",
		category_id: ACTIVE_CAT,
		category_source: "user",
	},
	{
		name: "purchase, Jev maybe (50%)",
		category_confidence: 0.5,
		jev_category_id: ACTIVE_CAT,
	},
	{
		name: "purchase, Jev sure (80%)",
		category_confidence: 0.8,
		jev_category_id: ACTIVE_CAT,
	},
	{
		name: "purchase, Jev below the floor (39%)",
		category_confidence: 0.39,
		jev_category_id: ACTIVE_CAT,
	},
	{
		name: "purchase, Jev at the floor (40%)",
		category_confidence: 0.4,
		jev_category_id: ACTIVE_CAT,
	},
	{
		name: "purchase, Jev maybe, its category archived",
		category_confidence: 0.5,
		jev_category_id: ARCHIVED_CAT,
	},
	{
		name: "pending purchase, Jev maybe",
		pending: 1,
		category_confidence: 0.5,
		jev_category_id: ACTIVE_CAT,
	},
	{
		name: "excluded purchase, pays a plan, Jev maybe",
		excluded: 1,
		excluded_source: "user",
		link: "plan",
		category_confidence: 0.5,
		jev_category_id: ACTIVE_CAT,
	},
	{
		name: "excluded purchase, bill link dismissed",
		excluded: 1,
		excluded_source: "user",
		link: "dismissed_bill",
	},
	{
		name: "excluded purchase, pays a bill",
		excluded: 1,
		excluded_source: "user",
		link: "bill",
	},
	{
		name: "purchase excluded by Plaid (transfer)",
		excluded: 1,
		excluded_source: "plaid",
		flag_transfer: 1,
	},
	{
		name: "purchase flagged as transfer (Jev 90%)",
		flag_transfer: 1,
		transfer_confidence: 0.9,
	},
	// Split parts
	{ name: "split part", parent_id: SPLIT_PARENT },
	{
		name: "split part, Jev maybe",
		parent_id: SPLIT_PARENT,
		category_confidence: 0.5,
		jev_category_id: ACTIVE_CAT,
	},
	{ name: "split part, pending", parent_id: SPLIT_PARENT, pending: 1 },
	// Credits (money in) nobody has reviewed: held for review
	{ name: "credit held for review", amount_cents: -500 },
	{
		name: "credit held, Jev income maybe (50%)",
		amount_cents: -500,
		income_confidence: 0.5,
	},
	{
		name: "credit held, Jev income at the floor (20%)",
		amount_cents: -500,
		income_confidence: 0.2,
	},
	{
		name: "credit held, Jev income sure (80%)",
		amount_cents: -500,
		income_confidence: 0.8,
	},
	{
		name: "credit held, Jev income maybe, never suggested",
		amount_cents: -500,
		income_confidence: 0.5,
		raw_name: NEVER_RAW,
	},
	{
		name: "credit held, Jev income maybe, pending",
		amount_cents: -500,
		income_confidence: 0.5,
		pending: 1,
	},
	{
		name: "credit flagged as transfer, Jev income maybe",
		amount_cents: -500,
		income_confidence: 0.5,
		flag_transfer: 1,
	},
	{
		name: "credit held, Jev income maybe, declined",
		amount_cents: -500,
		income_confidence: 0.5,
		income_maybe_declined: 1,
	},
	{
		name: "credit held, Jev said not income (10%), category answered",
		amount_cents: -500,
		income_confidence: 0.1,
		category_confidence: 0.9,
		jev_category_id: ACTIVE_CAT,
	},
	{
		name: "credit held, excluded by user",
		amount_cents: -500,
		excluded: 1,
		excluded_source: "user",
	},
	{ name: "credit held, split parent", amount_cents: -500, is_split: 1 },
	// Credits reviewed
	{
		name: "credit reviewed by user, no category",
		amount_cents: -500,
		credit_reviewed: 1,
		credit_reviewed_by: "user",
	},
	{
		name: "credit reviewed, refund of a counted purchase",
		amount_cents: -500,
		credit_reviewed: 1,
		refund_of_id: PURCHASE,
	},
	{
		name: "credit reviewed, refund of an excluded purchase",
		amount_cents: -500,
		credit_reviewed: 1,
		refund_of_id: PURCHASE_EXCLUDED,
	},
	{
		name: "credit reviewed, Jev category maybe",
		amount_cents: -500,
		credit_reviewed: 1,
		category_confidence: 0.5,
		jev_category_id: ACTIVE_CAT,
	},
	{
		name: "pending credit reviewed, Jev category maybe",
		pending: 1,
		amount_cents: -500,
		credit_reviewed: 1,
		category_confidence: 0.5,
		jev_category_id: ACTIVE_CAT,
	},
	// Income
	{
		name: "income by user",
		amount_cents: -500,
		flag_income: 1,
		income_source: "user",
	},
	{
		name: "income by Plaid",
		amount_cents: -500,
		flag_income: 1,
		plaid_category: "INCOME",
	},
	{
		name: "income by Jev, maybe",
		amount_cents: -500,
		flag_income: 1,
		income_source: "jev",
		income_confidence: 0.5,
	},
	{
		name: "income flagged by Tally, not chosen",
		amount_cents: -500,
		flag_income: 1,
		income_confidence: 0.9,
	},
	// Contradictions the schema lets through
	{
		name: "CONTRA is_split=1 with parent_id",
		is_split: 1,
		parent_id: SPLIT_PARENT,
		category_confidence: 0.5,
		jev_category_id: ACTIVE_CAT,
	},
	{
		name: "CONTRA flag_income=1 with excluded=1",
		amount_cents: -500,
		flag_income: 1,
		excluded: 1,
		excluded_source: "user",
		income_source: "user",
	},
	{ name: "CONTRA flag_income=1 on money out", flag_income: 1 },
	{
		name: "CONTRA category_source=jev, category_id NULL",
		category_source: "jev",
		category_confidence: 0.5,
		jev_category_id: ACTIVE_CAT,
	},
	{
		name: "CONTRA category_source=user, category_id NULL",
		category_source: "user",
	},
	{ name: "CONTRA category_id set, source NULL", category_id: ACTIVE_CAT },
	{
		name: "CONTRA credit_reviewed_by=user, credit_reviewed NULL",
		amount_cents: -500,
		credit_reviewed_by: "user",
		income_confidence: 0.5,
	},
	{
		name: "CONTRA credit_reviewed_by=user, credit_reviewed 0",
		amount_cents: -500,
		credit_reviewed: 0,
		credit_reviewed_by: "user",
		income_confidence: 0.5,
	},
	{
		name: "CONTRA reviewed credit flagged income, refund of a purchase",
		amount_cents: -500,
		credit_reviewed: 1,
		flag_income: 1,
		refund_of_id: PURCHASE,
	},
	{ name: "CONTRA refund_of_id on money out", refund_of_id: PURCHASE },
	{ name: "CONTRA pending split part", pending: 1, parent_id: SPLIT_PARENT },
];

/** Small deterministic random generator, so a failure repeats. */
function prng(seed: number) {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296;
		return s / 4294967296;
	};
}

function randomSeeds(n: number): Seed[] {
	const rnd = prng(42);
	const pick = <T>(xs: readonly T[]): T =>
		xs[Math.floor(rnd() * xs.length)] as T;
	// Confidence edges: 0.2, 0.4 and 0.8 sit exactly on the Maybe range's bounds.
	const edges = [
		null,
		0.1,
		0.19,
		0.2,
		0.21,
		0.39,
		0.4,
		0.5,
		0.79,
		0.8,
		0.95,
	] as const;
	return Array.from({ length: n }, () => ({
		amount_cents: pick([1000, -500, 0]),
		pending: pick([0, 0, 0, 1]),
		parent_id: pick([null, null, null, SPLIT_PARENT]),
		is_split: pick([0, 0, 0, 1]),
		excluded: pick([0, 0, 1]),
		excluded_source: pick([null, "user", "jev", "plaid"] as const),
		flag_transfer: pick([0, 0, 1]),
		flag_income: pick([0, 0, 1]),
		income_source: pick([null, null, "user", "jev"] as const),
		plaid_category: pick([null, "INCOME", "FOOD"]),
		category_id: pick([null, null, ACTIVE_CAT]),
		category_source: pick([
			null,
			null,
			"user",
			"merchant_rule",
			"jev",
			"bill",
		] as const),
		category_confidence: pick(edges),
		jev_category_id: pick([null, ACTIVE_CAT, ARCHIVED_CAT]),
		income_confidence: pick(edges),
		transfer_confidence: pick([null, null, 0.5]),
		credit_reviewed: pick([null, 0, 1]),
		credit_reviewed_by: pick([null, null, "user"] as const),
		income_maybe_declined: pick([0, 0, 1]),
		refund_of_id: pick([null, null, null, PURCHASE, PURCHASE_EXCLUDED]),
		jev_failed_at: pick([null, null, null, "2026-01-01"]),
		plaid_transaction_id: pick(["plaid-x", "plaid-x", null]),
		raw_name: pick([
			PLAIN_RAW,
			PLAIN_RAW,
			PLAIN_RAW,
			PLAIN_RAW,
			PLAIN_RAW,
			PLAIN_RAW,
			PLAIN_RAW,
			NEVER_RAW,
		]),
		link: pick<Link | undefined>([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"bill",
			"plan",
			"dismissed_bill",
		]),
	})).map((seed) =>
		// A payment group (a row, its split parent, its parts) cannot hold a bill and a plan together (migration 0053).
		// The split parent is paid by a plan, so its parts get no bill link.
		seed.parent_id === SPLIT_PARENT && seed.link === "bill"
			? { ...seed, link: undefined }
			: seed,
	);
}

// ---- the questions, each as SQL: the set of row ids the SQL says yes to ----------------------------------------------

const countedIds = async (where: string): Promise<Set<number>> => {
	const { results } = await db
		.prepare(`SELECT t.id FROM transactions t ${COUNTED_JOINS} WHERE ${where}`)
		.all<{ id: number }>();
	return new Set(results.map((r) => r.id));
};

const SQL_FOR: Record<keyof Questions, string> = {
	needsCategory: NEEDS_CATEGORY,
	waiting: WAITING,
	heldForReview: HELD_FOR_REVIEW_SQL,
	needsJevClassification: NEEDS_JEV_CLASSIFICATION,
	categoryOnly: CATEGORY_ONLY,
	waitingForJev: "", // built from waitingForJevSql below
	included: INCLUDED,
	follows: FOLLOWS_PURCHASE,
	jevMayBeAsked: jevAsksAboutSql("t"),
	categoryAsked: categoryAskedSql("t"),
	incomeAsked: incomeAskedSql("t"),
	payAsked: payAskedSql("t"),
};

async function sqlSet(key: keyof Questions): Promise<Set<number>> {
	if (key === "waitingForJev") {
		const sql = waitingForJevSql({ categories: true, income: true });
		if (sql === null) throw new Error("waitingForJevSql is off");
		const { results } = await db
			.prepare(`SELECT t.id ${sql}`)
			.all<{ id: number }>();
		return new Set(results.map((r) => r.id));
	}
	return countedIds(SQL_FOR[key]);
}

// ---- seeding -----------------------------------------------------------------------------------------------------------

let rows: Row[] = [];
const contexts = new Map<number, Context>();
const names = new Map<number, string>();
const idByName = new Map<string, number>();
const classified = new Map<number, Classified>();
let sets: Record<keyof Questions, Set<number>>;

beforeAll(async () => {
	await db.batch([
		db.prepare(
			"INSERT INTO accounts (name, type, subtype, is_liability, balance_cents) VALUES ('Checking','depository','checking',0,0)",
		),
		db.prepare(
			"INSERT INTO categories (id, name, icon, color) VALUES (101,'ClassifyActive','a','#000'),(102,'ClassifyOther','a','#000')",
		),
		db.prepare(
			"INSERT INTO categories (id, name, icon, color, archived) VALUES (103,'ClassifyOld','a','#000',1)",
		),
	]);
	const account = await db
		.prepare("SELECT id FROM accounts WHERE name = 'Checking'")
		.first<{ id: number }>();
	if (!account) throw new Error("the test account was not inserted");
	const acct = account.id;

	const insertTxn = `INSERT INTO transactions (id, account_id, date, raw_name, ${COLS.join(", ")})
		VALUES (?, ${acct}, '2026-10-05', ?, ${COLS.map(() => "?").join(", ")})`;

	// The "Never suggest income" rule for the bank text NEVER_RAW (decision 101). SQL reads it from this table.
	await db
		.prepare(
			"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES (?, 'income', '2026-10-01')",
		)
		.bind(NEVER_RAW)
		.run();

	const all: Seed[] = [...FIXED, ...NAMED, ...randomSeeds(4000)];
	const statements: D1PreparedStatement[] = [];
	let plaidN = 0;
	let billN = 0;
	all.forEach((seed, index) => {
		const id = index + 1;
		const values = COLS.map((c) => {
			const v = (seed[c] === undefined ? DEFAULTS[c] : seed[c]) as
				| string
				| number
				| null;
			// plaid_transaction_id is UNIQUE, so every non-null value gets its own id.
			return c === "plaid_transaction_id" && v !== null
				? `classify-${++plaidN}`
				: v;
		});
		statements.push(
			db.prepare(insertTxn).bind(id, seed.raw_name ?? PLAIN_RAW, ...values),
		);
		if (seed.name) {
			names.set(id, seed.name);
			idByName.set(seed.name, id);
		}
		if (seed.link === "plan") {
			statements.push(
				db
					.prepare(
						"INSERT INTO planned_expenses (name, amount_cents, month, transaction_id, created_by) VALUES ('plan', 100, '2026-10', ?, 'classify')",
					)
					.bind(id),
			);
		} else if (seed.link === "bill" || seed.link === "dismissed_bill") {
			// Each bill gets one payment, so every link gets its own bill.
			statements.push(
				db.prepare(
					`INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name) VALUES ('bill ${++billN}', 100, 1, 'monthly', 'CLASSIFY')`,
				),
			);
			const status = seed.link === "bill" ? "linked" : "dismissed";
			statements.push(
				db
					.prepare(
						`INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES ((SELECT MAX(id) FROM bills), '2026-10', ?, 'user', '${status}')`,
					)
					.bind(id),
			);
		}
	});
	for (let i = 0; i < statements.length; i += 100)
		await db.batch(statements.slice(i, i + 100));

	rows = (await db.prepare("SELECT * FROM transactions ORDER BY id").all<Row>())
		.results;
	const byId = new Map(rows.map((r) => [r.id, r]));
	const paying = new Set(
		all.flatMap((seed, index) =>
			seed.link === "bill" || seed.link === "plan" ? [index + 1] : [],
		),
	);
	// Facts from outside the row. The active-category fact is read from the table. The Never-suggest fact is the
	// seed's bank text against the rule's text (seeds have no merchant name, so the key is the bank text).
	const activeCategories =
		(
			await db
				.prepare("SELECT COUNT(*) AS n FROM categories WHERE archived = 0")
				.first<{ n: number }>()
		)?.n ?? 0;
	const bankTextOf = new Map(
		all.map((s, i) => [i + 1, s.raw_name ?? PLAIN_RAW]),
	);
	const contextFor = (r: Row): Context => {
		const target =
			r.refund_of_id === null ? undefined : byId.get(r.refund_of_id);
		return {
			paysBillOrPlan:
				paying.has(r.id) || (r.parent_id !== null && paying.has(r.parent_id)),
			refundTarget: target
				? { excluded: target.excluded === 1, categoryId: target.category_id }
				: null,
			jevCategoryActive:
				r.jev_category_id !== null && ACTIVE_IDS.has(r.jev_category_id),
			anyActiveCategory: activeCategories > 0,
			neverSuggestIncome: bankTextOf.get(r.id) === NEVER_RAW,
		};
	};
	for (const r of rows) {
		const ctx = contextFor(r);
		contexts.set(r.id, ctx);
		classified.set(r.id, classify(r, ctx));
	}

	const keys = Object.keys(SQL_FOR) as (keyof Questions)[];
	const found = await Promise.all(keys.map((k) => sqlSet(k)));
	sets = Object.fromEntries(keys.map((k, i) => [k, found[i]])) as Record<
		keyof Questions,
		Set<number>
	>;
});

const sqlSays = (key: keyof Questions, name: string): boolean =>
	sets[key].has(idOf(name));
const idOf = (name: string): number => {
	const id = idByName.get(name);
	if (id === undefined) throw new Error(`no named row: ${name}`);
	return id;
};
const classifiedOf = (id: number): Classified => {
	const found = classified.get(id);
	if (!found) throw new Error(`row ${id} was not classified`);
	return found;
};

// ---- the checks --------------------------------------------------------------------------------------------------------

describe("classify agrees with each SQL question, row by row", () => {
	for (const key of Object.keys(SQL_FOR) as (keyof Questions)[]) {
		it(key, () => {
			const wrong = rows
				.filter(
					(r) => classifiedOf(r.id).questions[key] !== sets[key].has(r.id),
				)
				.map(
					(r) =>
						`${r.id} ${names.get(r.id) ?? "random"} classify=${!sets[key].has(r.id)}`,
				);
			expect(wrong.slice(0, 10), `${wrong.length} rows differ`).toEqual([]);
			// No vacuous pass: the question must say yes to at least one row.
			expect(sets[key].size).toBeGreaterThan(0);
		});
	}
});

describe("named rows come out as the readable answers", () => {
	const of = (name: string) => classifiedOf(idOf(name));

	it("structure", () => {
		expect(of("split parent (paid by a plan)").structure).toEqual({
			kind: "split_parent",
		});
		expect(of("split part").structure).toEqual({
			kind: "split_part",
			parentId: SPLIT_PARENT,
		});
		expect(of("CONTRA is_split=1 with parent_id").structure.kind).toBe(
			"split_part_also_marked_split",
		);
	});

	it("budget: a payment for a bill or plan counts although excluded", () => {
		expect(of("excluded purchase, pays a bill").budget).toEqual({
			kind: "counted",
			because: "pays_bill_or_plan",
		});
		expect(of("excluded purchase, bill link dismissed").budget).toEqual({
			kind: "left_out",
			by: "user",
		});
	});

	it("money: held, reviewed, and a refund that follows its purchase", () => {
		expect(of("credit held for review").money).toEqual({
			kind: "credit",
			state: { kind: "held_for_review" },
		});
		expect(of("credit reviewed, refund of a counted purchase").money).toEqual({
			kind: "credit",
			state: { kind: "follows_purchase" },
		});
		expect(of("credit reviewed, refund of an excluded purchase").money).toEqual(
			{ kind: "credit", state: { kind: "reviewed", by: "other" } },
		);
	});

	it("income and category guesses", () => {
		expect(of("income by Plaid").income).toEqual({
			kind: "income",
			setBy: "plaid",
		});
		expect(of("purchase, Jev maybe (50%)").category).toEqual({
			kind: "unset",
			source: null,
			guess: { kind: "maybe" },
		});
		expect(of("purchase, Jev at the floor (40%)").category).toEqual({
			kind: "unset",
			source: null,
			guess: { kind: "maybe" },
		});
		expect(of("purchase, Jev below the floor (39%)").category).toEqual({
			kind: "unset",
			source: null,
			guess: { kind: "below_floor" },
		});
		expect(of("purchase, Jev sure (80%)").category).toEqual({
			kind: "unset",
			source: null,
			guess: { kind: "sure" },
		});
	});
});

// The owner's decisions (a) and (b) on the review queue: a pending row and a transfer are not asked. These tests pin the SQL to them.
describe("review questions: pending and transfer rows are not asked (owner decisions a and b)", () => {
	it("a pending purchase is not asked about its category", () => {
		expect(sqlSays("categoryAsked", "pending purchase, Jev maybe")).toBe(false);
	});

	it("a pending credit is not asked about its income", () => {
		expect(
			sqlSays("incomeAsked", "credit held, Jev income maybe, pending"),
		).toBe(false);
	});

	it("a credit flagged as a transfer is not asked about its income", () => {
		expect(
			sqlSays("incomeAsked", "credit flagged as transfer, Jev income maybe"),
		).toBe(false);
	});

	it("a held credit that is still asked about its income is asked", () => {
		expect(sqlSays("incomeAsked", "credit held, Jev income maybe (50%)")).toBe(
			true,
		);
	});
});

describe("HELD_FOR_REVIEW_SQL is self-contained (owner decision c)", () => {
	it("on its own it leaves out split parts and excluded credits", () => {
		expect(sqlSays("heldForReview", "credit held for review")).toBe(true);
		expect(sqlSays("heldForReview", "credit held, split parent")).toBe(false);
		expect(sqlSays("heldForReview", "credit held, excluded by user")).toBe(
			false,
		);
	});
});

// Owner decision: a credit flagged as a transfer and not excluded is settled, not held for review.
describe("a transfer credit is settled, not held (owner decision)", () => {
	it("a credit flagged as a transfer and in the budget is not held, and is in the settled transfer state", () => {
		const name = "credit flagged as transfer, Jev income maybe";
		expect(sqlSays("heldForReview", name)).toBe(false);
		expect(classifiedOf(idOf(name)).money).toEqual({
			kind: "credit",
			state: { kind: "settled_transfer" },
		});
	});
});

// Current behaviour that the owner has not decided yet (owner decision d), tracked in GitHub issue #870. These tests document it: they pass today,
// and they do not say the behaviour is right. Change them only when the owner decides.
describe("current behaviour awaiting an owner decision (owner decision d)", () => {
	it("a category source with no category id is counted as needing a category, and nothing asks about it", () => {
		const name = "CONTRA category_source=user, category_id NULL";
		expect(sqlSays("needsCategory", name)).toBe(true);
		expect(sqlSays("waiting", name)).toBe(false);
		expect(sqlSays("categoryAsked", name)).toBe(false);
		expect(sqlSays("waitingForJev", name)).toBe(false);
	});

	it("a held credit with no way out is held, and no question or Jev work reaches it (Jev said not income)", () => {
		const name = "credit held, Jev said not income (10%), category answered";
		expect(sqlSays("heldForReview", name)).toBe(true);
		expect(sqlSays("incomeAsked", name)).toBe(false);
		expect(sqlSays("categoryAsked", name)).toBe(false);
		expect(sqlSays("waitingForJev", name)).toBe(false);
	});

	it("a held credit with no way out is held, and no question or Jev work reaches it (a person chose, no review)", () => {
		const name = "CONTRA credit_reviewed_by=user, credit_reviewed NULL";
		expect(sqlSays("heldForReview", name)).toBe(true);
		expect(sqlSays("incomeAsked", name)).toBe(false);
		expect(sqlSays("waitingForJev", name)).toBe(false);
	});
});

const ctxOf = (id: number): Context => {
	const found = contexts.get(id);
	if (!found) throw new Error(`row ${id} has no context`);
	return found;
};

describe("the Never-suggest income rule (the oracle's fact against SQL's rule table)", () => {
	it("the rule covers the same rows whether SQL reads its table or the oracle reads the bank text", async () => {
		const bySql = await countedIds(neverSuggestedSql("t", "income"));
		const byFact = rows
			.filter((r) => ctxOf(r.id).neverSuggestIncome)
			.map((r) => r.id);
		expect(bySql.size).toBeGreaterThan(0);
		expect([...bySql].sort((a, b) => a - b)).toEqual(byFact);
	});

	it("hides the income question but not the pay question, and the oracle agrees", () => {
		const name = "credit held, Jev income maybe, never suggested";
		expect(sqlSays("incomeAsked", name)).toBe(false);
		expect(sqlSays("payAsked", name)).toBe(true);
		expect(classifiedOf(idOf(name)).questions.incomeAsked).toBe(false);
		expect(classifiedOf(idOf(name)).questions.payAsked).toBe(true);
	});
});

describe("waitingForJev with no active category (the other branch of the category work)", () => {
	it("matches the oracle when no category is active, and that branch changes some rows", async () => {
		// The migrations seed default categories, so every category is archived for this query, then restored.
		const saved = await db
			.prepare("SELECT id, archived FROM categories")
			.all<{ id: number; archived: number }>();
		await db.prepare("UPDATE categories SET archived = 1").run();
		let withoutActive = new Set<number>();
		try {
			withoutActive = await sqlSet("waitingForJev");
		} finally {
			await db.batch(
				saved.results.map((c) =>
					db
						.prepare("UPDATE categories SET archived = ? WHERE id = ?")
						.bind(c.archived, c.id),
				),
			);
		}
		const oracle = (r: Row) =>
			classify(r, { ...ctxOf(r.id), anyActiveCategory: false }).questions
				.waitingForJev;
		const wrong = rows
			.filter((r) => oracle(r) !== withoutActive.has(r.id))
			.map((r) => r.id);
		expect(wrong.slice(0, 10), `${wrong.length} rows differ`).toEqual([]);
		// No vacuous pass: the question must say yes to some row, and the branch must change some answer.
		expect(withoutActive.size).toBeGreaterThan(0);
		expect(
			rows.filter(
				(r) => sets.waitingForJev.has(r.id) !== withoutActive.has(r.id),
			).length,
		).toBeGreaterThan(0);
	});
});
