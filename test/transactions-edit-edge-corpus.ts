import { env, exports } from "cloudflare:workers";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { pinClock } from "./pinned-clock";

// The edit panel's save, read at the edge (#1006, PR 12). Each case posts one input a person's browser can send to a
// freshly seeded demo, where a purchase is edited and a cash entry is split into two saved parts. It records what comes
// back: the status, the type, the Location, the HX-Trigger and HX-Push-Url headers, a hash of the page's body and a hash
// of every row the answer can touch. The lines in fixtures/transactions-edit-edge-baseline.json were recorded on the code
// before the edge: every answer must stay the same, except a padded address id on a real transaction (a leading zero),
// which now answers as a missing transaction and writes nothing (intended difference 1, checked on its own below).

const db = env.DB;
const BASE = "http://tally.test";
const ABSENT = "<absent>";
const FILE = "<file>";
const LIST = "/transactions?month=all";

/** The rows a case is written from, read from the seeded demo. */
type Ids = {
	id: number;
	id2: number;
	cash: number;
	cat: number;
	arch: number;
	partA: number;
	partB: number;
};

type Value = string | typeof FILE | typeof ABSENT;

type Form = [string, Value][];

export type Step = {
	label: string;
	path: string;
	form: Form;
	/** The panel's pending edit, as the Change the parts sheet carries it: built per case from its fields. */
	pending?: Form;
	hx?: boolean;
	/** Seeds the second purchase ($PERSON) and the cash entry ($CASH) with household person 1: they already have one. */
	person?: boolean;
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

/** Seeds the demo's rows the cases use: a purchase, and a cash entry split into two saved parts. */
async function prepare(): Promise<Ids> {
	const first = async (sql: string) => {
		const row = await db.prepare(sql).first<{ id: number }>();

		if (!row) throw new Error(`seed missing: ${sql}`);

		return row.id;
	};

	const purchases =
		"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type<>'cash' AND t.parent_id IS NULL AND t.refund_of_id IS NULL AND t.is_split=0 ORDER BY t.id";

	const cashEntries =
		"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type='cash' AND t.parent_id IS NULL ORDER BY t.id";

	// One live category stays live (cat); another is archived (arch), so a rule can name an archived category.
	const cat = await first(
		"SELECT id FROM categories WHERE archived=0 ORDER BY id LIMIT 1",
	);

	const arch = (
		await db
			.prepare(
				"SELECT id FROM categories WHERE archived=0 AND id<>? ORDER BY id DESC LIMIT 1",
			)
			.bind(cat)
			.first<{ id: number }>()
	)?.id;

	if (arch === undefined) throw new Error("seed missing: a second category");
	await db
		.prepare("UPDATE categories SET archived=1 WHERE id=?")
		.bind(arch)
		.run();

	const cash = await first(`${cashEntries} LIMIT 1`);

	await db
		.prepare("UPDATE transactions SET amount_cents=9000 WHERE id=?")
		.bind(cash)
		.run();
	await saveSplit(
		db,
		cash,
		[
			{ amountCents: 6000, categoryId: cat },
			{ amountCents: 3000, categoryId: arch },
		],
		"demo",
	);

	const parts = await db
		.prepare(
			"SELECT id FROM transactions WHERE parent_id=? ORDER BY id LIMIT 2",
		)
		.bind(cash)
		.all<{ id: number }>();

	return {
		id: await first(`${purchases} LIMIT 1`),
		id2: await first(`${purchases} DESC LIMIT 1`),
		cash,
		cat,
		arch,
		partA: parts.results[0]?.id ?? 0,
		partB: parts.results[1]?.id ?? 0,
	};
}

/** Puts a case's row numbers into its text. Longer names go first, so a prefix never matches. */
function fill(text: string, ids: Ids): string {
	return text
		.replaceAll("$PERSON", String(ids.id2))
		.replaceAll("$PARTA", String(ids.partA))
		.replaceAll("$PARTB", String(ids.partB))
		.replaceAll("$CASH", String(ids.cash))
		.replaceAll("$ID", String(ids.id))
		.replaceAll("$CAT", String(ids.cat))
		.replaceAll("$ARCH", String(ids.arch));
}

const file = () => new File(["x"], "x.txt", { type: "text/plain" });

/** Runs one case and returns its response and the page text. */
async function send(step: Step, ids: Ids) {
	const headers = new Headers();

	if (step.hx !== false) headers.set("HX-Request", "true");
	headers.set("Origin", BASE);

	const url = `${BASE}${fill(step.path, ids)}`;
	const body = new FormData();

	for (const [key, value] of step.form) {
		if (value === ABSENT) continue;

		body.append(key, value === FILE ? file() : fill(value, ids));
	}

	// The sheet carries the panel's pending edit as text, which the split route hands back to the panel's save.
	if (step.pending) {
		const pending = new URLSearchParams();

		for (const [key, value] of step.pending) {
			if (value !== ABSENT && value !== FILE)
				pending.append(key, fill(value, ids));
		}

		body.append("pending_edit", pending.toString());
	}

	const res = await exports.default.fetch(url, {
		method: "POST",
		headers,
		body,
	});

	return { res, html: await res.text() };
}

/** One line per case: the status, type, Location, the two HX headers and the page. Random UUIDs are written as UUID. */
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
	].join(" | ");
}

/** Runs one case on a fresh demo: its line (answer and rows after it), and whether any row changed while it ran. */
export async function recordCase(step: Step) {
	pinClock();
	await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
	const ids = await prepare();

	if (step.person)
		await db
			.prepare("UPDATE transactions SET for_person_id=1 WHERE id IN (?, ?)")
			.bind(ids.id2, ids.cash)
			.run();

	const before = await stateHash();
	let line: string;
	let changed = false;

	try {
		const { res, html } = await send(step, ids);

		const after = await stateHash();

		changed = after !== before;
		line = `${await recordLine(res, html)} | state ${after}`;
	} catch (error) {
		line = `threw ${error instanceof Error ? error.name : "value"}`;
	}

	return { line, changed };
}

/** The values a browser can send for a number, as a category, a rule's category or a person's id: see the cases. */
const NUMBERS: Value[] = [
	"$CAT",
	"0$CAT",
	"00$CAT",
	" $CAT",
	"$CAT ",
	"+$CAT",
	"$CAT.0",
	"0x$CAT",
	"1e1",
	"1e21",
	"9007199254740993",
	"0",
	"-1",
	"1.5",
	"abc",
	"",
	"7",
	"007",
	" 7",
	"Infinity",
	"1e400",
	"0x1",
	"+3",
	"1_000",
	"00",
	" ",
	"$ARCH",
	FILE,
	ABSENT,
];

/** The category text a browser can send: the numbers, and a new category. */
const CATEGORIES: Value[] = [...NUMBERS, "new"];

/** The ids the For person field can carry: junk, padded, signed and exponent forms, a file, and nothing. */
const PEOPLE: Value[] = [
	"",
	"1",
	"001",
	" 1",
	"abc",
	"1.5",
	"0",
	"-1",
	"1e0",
	"1e21",
	"2",
	FILE,
	ABSENT,
];

/** The person a guess was drawn with (for_person_id_was). */
const PEOPLE_WAS: Value[] = ["abc", "1", "1.5", "0", ABSENT];

/** The purchase's edit as the panel posts it: the category, the name the person picked and the back link. */
const EDIT: Form = [
	["category", "$CAT"],
	["name_pick", "own"],
	["merchant", "Corpus name"],
	["back", LIST],
];

/** The split sheet's correction at the cash entry: a total of $100.00 over parts of $60.00 and $40.00. */
const CORRECTION: Form = [
	["back", LIST],
	["total", "10000"],
	["amount_was", "9000"],
	["part_id", "$PARTA"],
	["part_id", "$PARTB"],
	["part_category", "$CAT"],
	["part_category", "$ARCH"],
	["part_amount", "60.00"],
	["part_amount", "40.00"],
];

/** A form with one field's value replaced (or removed, for ABSENT), as the panel would post it. */
function withFields(base: Form, changes: Form): Form {
	const keys = new Set(changes.map(([key]) => key));

	return [...base.filter(([key]) => !keys.has(key)), ...changes];
}

/** The steps, one per label. A label is written with the values as the template has them, so it names each case. */
function buildSteps(): Step[] {
	const steps: Step[] = [];

	const add = (step: Omit<Step, "label">) => {
		const fields = [...step.form, ...(step.pending ?? [])]
			.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
			.join(" ");

		const pending = step.pending ? " (pending_edit)" : "";
		const hx = step.hx === false ? " (no HX-Request)" : "";

		steps.push({
			...step,
			label:
				`#${steps.length + 1} POST ${step.path} ${fields}${pending}${hx}`.trim(),
		});
	};

	// The address: a padded id ("007", a leading zero, 16 digits) reaches a real transaction or nothing.
	for (const path of [
		"$ID",
		"0$ID",
		"00$ID",
		"000000000000000000$ID",
		"007",
		"0",
		"9999999999999999",
		"1234567890123456",
		"$CASH",
		"0$CASH",
	]) {
		for (const hx of [true, false]) {
			add({ path: `/transactions/${path}`, form: EDIT, hx });
		}
	}

	// The category: every text a browser can send, htmx and plain.
	for (const hx of [true, false]) {
		for (const category of CATEGORIES) {
			add({
				path: "/transactions/$ID",
				form: withFields(EDIT, [["category", category]]),
				hx,
			});
		}
	}

	// A new category: its name is checked only when the category is new.
	for (const name of ["", "Shops", FILE, ABSENT]) {
		add({
			path: "/transactions/$ID",
			form: withFields(EDIT, [
				["category", "new"],
				["new_category_name", name],
			]),
		});
	}

	// The store rule's category (rule_category_was), with the rule ticked as it was drawn, htmx and plain.
	for (const hx of [true, false]) {
		for (const ruleWas of NUMBERS) {
			add({
				path: "/transactions/$ID",
				form: withFields(EDIT, [
					["always", "1"],
					["always_was", "1"],
					["rule_category_was", ruleWas],
				]),
				hx,
			});
		}
	}

	// The rule's category without the tick as it was drawn: the rule is not kept, so the junk is read and then ignored.
	for (const ruleWas of NUMBERS) {
		add({
			path: "/transactions/$ID",
			form: withFields(EDIT, [
				["always", "1"],
				["rule_category_was", ruleWas],
			]),
		});
	}

	// For person, with the panel's details shown as hidden, and the guess it was drawn with.
	for (const person of PEOPLE) {
		for (const was of PEOPLE_WAS) {
			add({
				path: "/transactions/$ID",
				form: withFields(EDIT, [
					["details_visible", "0"],
					["for_person_id", person],
					["for_person_id_was", was],
				]),
			});
		}
	}

	// For person with the details shown: the same person, and a guess that is junk.
	for (const person of PEOPLE) {
		add({
			path: "/transactions/$ID",
			form: withFields(EDIT, [
				["for_person_id", person],
				["for_person_id_was", "abc"],
			]),
			hx: false,
		});
	}

	// The pending edit: a Change the parts sheet carries the panel's posted fields to its save. Each junk value is
	// posted to the panel (change_parts), then replayed through the split route's correction, which saves the panel.
	const pendingCases: [string, Value[], Form][] = [
		["category", CATEGORIES, EDIT],
		[
			"rule_category_was",
			NUMBERS,
			[...EDIT, ["always", "1"], ["always_was", "1"]],
		],
		["for_person_id", PEOPLE, [...EDIT, ["details_visible", "0"]]],
		[
			"for_person_id_was",
			PEOPLE_WAS,
			[...EDIT, ["details_visible", "0"], ["for_person_id", "1"]],
		],
	];

	for (const [field, values, base] of pendingCases) {
		for (const value of values) {
			const edit = withFields(base, [[field, value]]);

			add({
				path: "/transactions/$CASH",
				form: withFields(edit, [
					["change_parts", "1"],
					["amount", "100.00"],
				]),
			});
			add({
				path: "/transactions/$CASH/split",
				form: CORRECTION,
				pending: edit,
			});
		}
	}

	// A transaction that already has a person (household person 1): the For person field keeps, clears or refuses it
	// against the guess it was drawn with. These cases come after the others, so their labels keep the earlier numbers.
	const PERSON_NOW: Value[] = ["", "1", "001", " 1", "abc", "1.5", ABSENT];
	const PERSON_WAS_NOW: Value[] = [ABSENT, "", "1", "abc", "1e0", FILE];

	for (const details of ["0", "1"]) {
		for (const now of PERSON_NOW) {
			for (const was of PERSON_WAS_NOW) {
				add({
					path: "/transactions/$PERSON",
					form: withFields(EDIT, [
						["details_visible", details],
						["for_person_id", now],
						["for_person_id_was", was],
					]),
					person: true,
				});
			}
		}
	}

	for (const now of PERSON_NOW) {
		for (const was of PERSON_WAS_NOW) {
			add({
				path: "/transactions/$PERSON",
				form: withFields(EDIT, [
					["details_visible", "0"],
					["for_person_id", now],
					["for_person_id_was", was],
				]),
				person: true,
				hx: false,
			});
		}
	}

	// The pending edit on a cash entry that has a person: the sheet's save, then its replay through the split route.
	for (const now of ["", "abc", "1.5", "001"]) {
		const edit = withFields(EDIT, [
			["details_visible", "0"],
			["for_person_id", now],
			["for_person_id_was", "abc"],
		]);

		add({
			path: "/transactions/$CASH",
			form: withFields(edit, [
				["change_parts", "1"],
				["amount", "100.00"],
			]),
			person: true,
		});
		add({
			path: "/transactions/$CASH/split",
			form: CORRECTION,
			pending: edit,
			person: true,
		});
	}

	return steps;
}

/**
 * Cases whose answer is meant to change (the intended difference in the PR notes): a padded address id, a leading zero
 * on a real transaction, now answers as a missing transaction, with no write. Each is checked against its own answer.
 */
export const isIntended = (step: Step) =>
	/^\/transactions\/(0\d|0+\$)/.test(step.path);

export const STEPS = buildSteps();

const labels = STEPS.map((step) => step.label);

if (new Set(labels).size !== labels.length) {
	throw new Error("two proof cases share a label");
}
