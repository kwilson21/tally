import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { merchantKeySql } from "../src/db/merchant-key";
import { resetDemo } from "../src/demo/reset";
import baseline from "./fixtures/transactions-likely-edge-baseline.json";
import { pinClock } from "./pinned-clock";

// The likely panel's routes and the rule offer's answers, read at the edge (#1006, PR 10). Each case posts one input a
// person's browser can send to a freshly seeded demo and records what comes back: the status, the type, the Location,
// the HX-Trigger and HX-Push-Url headers, a hash of the page's body and a hash of every row the answer can touch. The
// lines in fixtures/transactions-likely-edge-baseline.json were recorded on the code before the edge: every answer must
// stay the same, except the padded address ids listed in INTENDED, which are checked on their own.

const db = env.DB;
const BASE = "http://tally.test";
const ABSENT = "<absent>";
const FILE = "<file>";
const LIST = "/transactions?month=all";

/** The rows one case is written from, read from the seeded demo. */
type Ids = {
	id: number;
	id2: number;
	cash: number;
	cat: number;
	catName: string;
	arch: number;
	key: string;
};

type Value = string | typeof FILE | typeof ABSENT;

type Form = [string, Value][];

type Step = {
	label: string;
	method: "POST";
	path: string;
	form: Form;
	hx?: boolean;
};

const sha = async (text: string) => {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);

	return [...new Uint8Array(bytes)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 16);
};

/** A database row: the columns a route's answer can change, as text, numbers or nothing. */
type Row = Record<string, string | number | null>;

/** A row without its timestamps: the answers stamp `updated_at` from the database's own clock. */
const withoutStamps = (row: Row) =>
	Object.fromEntries(
		Object.entries(row).filter(([key]) => !key.endsWith("_at")),
	);

/** Every row the answers can change: the transactions, the categories, the merchants and the accounts. */
async function stateHash() {
	const [transactions, categories, merchants, accounts] = await Promise.all([
		db.prepare("SELECT * FROM transactions ORDER BY id").all<Row>(),
		db.prepare("SELECT * FROM categories ORDER BY id").all<Row>(),
		db.prepare("SELECT * FROM merchants ORDER BY raw_name").all<Row>(),
		db.prepare("SELECT id, type FROM accounts ORDER BY id").all<Row>(),
	]);

	return sha(
		JSON.stringify([
			transactions.results.map(withoutStamps),
			categories.results.map(withoutStamps),
			merchants.results.map(withoutStamps),
			accounts.results,
		]),
	);
}

async function seedIds(): Promise<Ids> {
	const first = async (sql: string) => {
		const row = await db.prepare(sql).first<{ id: number }>();

		if (!row) throw new Error(`seed missing: ${sql}`);

		return row.id;
	};

	const purchases =
		"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type<>'cash' AND t.parent_id IS NULL AND t.refund_of_id IS NULL ORDER BY t.id";

	const archived = await db
		.prepare("SELECT id FROM categories WHERE archived=1 ORDER BY id LIMIT 1")
		.first<{ id: number }>();

	const id = await first(`${purchases} LIMIT 1`);

	const cat = await first(
		"SELECT id FROM categories WHERE archived=0 ORDER BY id LIMIT 1",
	);

	const catRow = await db
		.prepare("SELECT name FROM categories WHERE id=?")
		.bind(cat)
		.first<{ name: string }>();

	const keyRow = await db
		.prepare(
			`SELECT ${merchantKeySql("t")} AS key FROM transactions t WHERE t.id=?`,
		)
		.bind(id)
		.first<{ key: string }>();

	return {
		id,
		id2: await first(`${purchases} DESC LIMIT 1`),
		cash: await first(
			"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type='cash' AND t.parent_id IS NULL ORDER BY t.id LIMIT 1",
		),
		cat,
		catName: catRow?.name ?? "Groceries",
		arch: archived?.id ?? 999,
		key: keyRow?.key ?? "Corner shop",
	};
}

/**
 * Makes one store of the demo: the saved purchase and two more are the person's picks of the category (three picks
 * make a rule offer), and the second purchase is an uncategorised row of the same merchant this month, so the likely
 * panel has something to offer and Add something to file. The same rows change the same way on every run.
 */
async function prepareLikely(ids: Ids) {
	const picks = await db
		.prepare(
			`SELECT t.id AS id FROM transactions t JOIN accounts a ON a.id = t.account_id
			WHERE a.type <> 'cash' AND t.parent_id IS NULL AND t.refund_of_id IS NULL AND t.id NOT IN (?1, ?2)
			ORDER BY t.id LIMIT 2`,
		)
		.bind(ids.id, ids.id2)
		.all<{ id: number }>();

	const chosen = [ids.id, ...picks.results.map((row) => row.id)];

	for (const id of chosen) {
		await db
			.prepare(
				`UPDATE transactions SET merchant_name = ?1, category_id = ?2, category_source = 'user',
				amount_cents = 1000, flag_income = 0, is_split = 0, excluded = 0, pending = 0,
				date = '2026-10-06' WHERE id = ?3`,
			)
			.bind(ids.key, ids.cat, id)
			.run();
	}

	await db
		.prepare(
			"UPDATE transactions SET merchant_name = ?1, category_id = NULL, category_source = NULL, date = '2026-10-05', pending = 0 WHERE id = ?2",
		)
		.bind(ids.key, ids.id2)
		.run();
}

/** Puts a case's row numbers into its text. "$ID2" goes before "$ID", so its prefix does not match. */
function fill(text: string, ids: Ids): string {
	return text
		.replaceAll("$ID2", String(ids.id2))
		.replaceAll("$ID", String(ids.id))
		.replaceAll("$HEX", ids.id.toString(16))
		.replaceAll("$CASH", String(ids.cash))
		.replaceAll("$CATNAME", ids.catName)
		.replaceAll("$CAT", String(ids.cat))
		.replaceAll("$ARCH", String(ids.arch))
		.replaceAll("$KEY", ids.key);
}

const file = () => new File(["x"], "x.txt", { type: "text/plain" });

/** Runs one step and returns its response and the page text. */
async function run(step: Step, ids: Ids) {
	const headers = new Headers();

	if (step.hx !== false) headers.set("HX-Request", "true");
	headers.set("Origin", BASE);

	const body = new FormData();

	for (const [key, value] of step.form) {
		if (value === ABSENT) continue;

		body.append(key, value === FILE ? file() : fill(value, ids));
	}

	const res = await exports.default.fetch(`${BASE}${fill(step.path, ids)}`, {
		method: "POST",
		headers,
		body,
	});

	return { res, html: await res.text() };
}

/** One line per case: the status, type, Location, the two HX headers, the page and the rows. Random UUIDs are written as UUID. */
async function recordLine(res: Response, html: string) {
	const plain = (text: string) =>
		text.replaceAll(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
			"UUID",
		);

	return [
		res.status,
		res.headers.get("content-type") ?? "-",
		res.headers.get("location") ?? "-",
		plain(res.headers.get("HX-Trigger") ?? "-"),
		plain(res.headers.get("HX-Push-Url") ?? "-"),
		`body ${await sha(plain(html))}`,
		`state ${await stateHash()}`,
	].join(" | ");
}

// The values a browser can send for a number (the category, the saved row, the trip): see fill().
const NUMBERS: Value[] = [
	"$CAT",
	"0$CAT",
	"00$CAT",
	" $CAT",
	"$CAT ",
	"+$CAT",
	"$CAT.0",
	"$CAT.5",
	"0x$CAT",
	"1e1",
	"1e21",
	"9007199254740993",
	"999999999999999999999",
	"0",
	"-1",
	"1.5",
	"abc",
	"",
	"Infinity",
	"$ARCH",
	FILE,
	ABSENT,
];

const SAVED: Value[] = [
	"$ID",
	"0$ID",
	"00$ID",
	" $ID",
	"$ID ",
	"+$ID",
	"$ID.0",
	"1e3",
	"0",
	"-1",
	"1.5",
	"abc",
	"",
	"9007199254740993",
	"9999999999999999",
	FILE,
	ABSENT,
];

/** The ticked rows: each inner list is one posted `ids` field set, every entry one form value. */
const IDS: Value[][] = [
	["$ID"],
	["$ID2"],
	["0$ID2"],
	[" $ID2 "],
	["$ID2", "$ID"],
	["$ID2", "$ID2"],
	["$ID2", "abc"],
	["$ID2", "0"],
	["$ID2", "-1"],
	["$ID2", "1e3"],
	["$ID2", "1.5"],
	["$ID2", "+$ID2"],
	["$ID2", "$ID2.0"],
	["$ID2", "9007199254740993"],
	["$ID2", "1e21"],
	["$ID2", "9999999999999999"],
	["$ID2", "999999999999999999999"],
	["$ID2", "Infinity"],
	["$ID2", ""],
	["$ID2", FILE],
	["$ID2", ABSENT],
	["$ID2", "0x$HEX"],
	["0", "-1", "abc"],
	["1e3"],
	[""],
	[ABSENT],
	[FILE],
	["$CASH"],
	["$ARCH"],
];

const TRIPS: Value[] = [
	"$ID",
	"0$ID",
	"00$ID",
	" $ID",
	"$ID ",
	"+$ID",
	"$ID.0",
	"1e3",
	"0",
	"-1",
	"1.5",
	"abc",
	"",
	"9007199254740993",
	"9999999999999999",
	"1e21",
	FILE,
	ABSENT,
];

const KEYS: Value[] = ["$KEY", "", "nope", FILE, ABSENT];

const PATHS_LIKELY = [
	"$ID",
	"0$ID",
	"00$ID",
	"$ID2",
	"0$ID2",
	"0",
	"9999999999999999",
	"123456789012345",
	"000000000000000000$ID",
	"$CASH",
	"$ARCH",
];

/** The steps, one per label. A label is written with the values as the template has them, so it names each case. */
function buildSteps(): Step[] {
	const steps: Step[] = [];

	const add = (step: Omit<Step, "label">) => {
		const fields = step.form
			.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
			.join(" ");

		const hx = step.hx === false ? " (no HX-Request)" : "";

		steps.push({
			...step,
			label:
				`#${steps.length + 1} ${step.method} ${step.path} ${fields}${hx}`.trim(),
		});
	};

	const likelyForm = (
		category: Value,
		ids: Value[],
		name: Value = "$CATNAME",
	): Form => [
		["category", category],
		["category_name", name],
		...ids.map((value): [string, Value] => ["ids", value]),
		["back", LIST],
	];

	const likelyRoutes = ["likely", "likely/count"];

	for (const route of likelyRoutes) {
		// The address: a padded id is a missing transaction on the edit (intended), the others read as before.
		for (const path of PATHS_LIKELY) {
			add({
				method: "POST",
				path: `/transactions/${path}/${route}`,
				form: likelyForm("$CAT", ["$ID2"]),
			});
		}

		// The category the panel files into.
		for (const category of NUMBERS) {
			add({
				method: "POST",
				path: `/transactions/$ID/${route}`,
				form: likelyForm(category, ["$ID2"]),
			});
		}

		// The ticked rows.
		for (const ids of IDS) {
			add({
				method: "POST",
				path: `/transactions/$ID/${route}`,
				form: likelyForm("$CAT", ids),
			});
		}

		// The category's name as the panel showed it.
		for (const name of ["$CATNAME", "", "nope", FILE, ABSENT]) {
			add({
				method: "POST",
				path: `/transactions/$ID/${route}`,
				form: likelyForm("$CAT", ["$ID2"], name),
			});
		}

		add({
			method: "POST",
			path: `/transactions/$ID/${route}`,
			form: likelyForm("$CAT", ["$ID2"]),
			hx: false,
		});
	}

	// The rule offer's Yes and its No: the category, the saved row, the trip the question was asked about, the key.
	const ruleForm = (
		values: { category?: Value; saved?: Value; trip?: Value; key?: Value } = {},
	): Form => [
		["merchant_key", values.key ?? "$KEY"],
		["merchant", "Corner shop"],
		["category", values.category ?? "$CAT"],
		["trip", values.trip ?? "$ID"],
		["saved", values.saved ?? "$ID"],
		["back", LIST],
	];

	for (const route of ["rule-offer", "rule-offer/dismiss"]) {
		add({ method: "POST", path: `/transactions/${route}`, form: ruleForm() });

		for (const category of NUMBERS) {
			add({
				method: "POST",
				path: `/transactions/${route}`,
				form: ruleForm({ category }),
			});
		}

		for (const saved of SAVED) {
			add({
				method: "POST",
				path: `/transactions/${route}`,
				form: ruleForm({ saved }),
			});
		}

		for (const trip of TRIPS) {
			add({
				method: "POST",
				path: `/transactions/${route}`,
				form: ruleForm({ trip }),
			});
		}

		for (const key of KEYS) {
			add({
				method: "POST",
				path: `/transactions/${route}`,
				form: ruleForm({ key }),
			});
		}

		add({
			method: "POST",
			path: `/transactions/${route}`,
			form: ruleForm({ category: "$CAT", trip: "abc", saved: "abc" }),
			hx: false,
		});

		add({
			method: "POST",
			path: `/transactions/${route}`,
			form: ruleForm({ category: "$ARCH", trip: "$ID2", saved: "$ID2" }),
			hx: false,
		});
	}

	return steps;
}

/**
 * Cases whose answer is meant to change (the intended difference in the PR notes): a padded address id on the likely
 * routes now answers as a missing transaction, with no write. Each is checked below against its own expectation.
 */
const INTENDED = (step: Step) =>
	/^\/transactions\/0+\$(CASH|ID|ID2)\/likely/.test(step.path);

const STEPS = buildSteps();

const labels = STEPS.map((step) => step.label);

if (new Set(labels).size !== labels.length) {
	throw new Error("two proof cases share a label");
}

beforeEach(async () => {
	pinClock();
	await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the likely panel and the rule offer, read at the edge (#1006, PR 10)", () => {
	it.each(STEPS.map((step) => [step.label, step] as const))(
		"%s keeps its answer",
		async (label, step) => {
			const ids = await seedIds();
			await prepareLikely(ids);
			const before = await stateHash();
			let line: string;

			try {
				const { res, html } = await run(step, ids);

				line = await recordLine(res, html);
			} catch (error) {
				line = `threw ${error instanceof Error ? error.name : "value"}`;
			}

			if (INTENDED(step)) {
				// The padded id is a missing transaction: a 404 and no row changed.
				expect(line.split(" | ")[0]).toBe("404");
				expect(await stateHash()).toBe(before);

				return;
			}

			const recorded: Record<string, string> = baseline;

			expect(line).toBe(recorded[label]);
		},
	);
});
