import { env, exports } from "cloudflare:workers";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { pinClock } from "./pinned-clock";

// The corpus of the split routes and the category lock, read at the edge (#1006, PR 11). Each case gets or posts one
// input a person's browser can send to a freshly seeded demo, where a cash entry is split into two saved parts, a plain
// cash entry is unsplit and a credit is linked to a purchase. It records what comes back: the status, the type, the
// Location, the HX-Trigger and HX-Push-Url headers, a hash of the page's body and a hash of every row the answer can
// touch. The lines in fixtures/transactions-split-edge-baseline.json were recorded on the code before the edge.

const db = env.DB;
const BASE = "http://tally.test";
const ABSENT = "<absent>";
const FILE = "<file>";
const LIST = "/transactions?month=all";
const HUGE = `1${"0".repeat(400)}`;

/** The rows a case is written from, read from the seeded demo. */
type Ids = {
	id: number;
	id2: number;
	cash: number;
	plain: number;
	refund: number;
	cat: number;
	arch: number;
	partA: number;
	partB: number;
};

type Value = string | typeof FILE | typeof ABSENT;

type Form = [string, Value][];

export type Step = {
	label: string;
	method: "GET" | "POST";
	path: string;
	query?: [string, Value][];
	form?: Form;
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

/** Seeds the demo's rows the cases use: a purchase, a cash entry split into two parts, a plain cash entry, a credit. */
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

	// One live category stays live (cat); the last one is archived (arch), so a saved part can keep an archived category.
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

	const ids: Ids = {
		id: await first(`${purchases} LIMIT 1`),
		id2: await first(`${purchases} DESC LIMIT 1`),
		cash: await first(`${cashEntries} LIMIT 1`),
		plain: 0,
		refund: 0,
		cat,
		arch,
		partA: 0,
		partB: 0,
	};

	await db
		.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name) SELECT account_id,date,4000,'Corpus plain' FROM transactions WHERE id=?",
		)
		.bind(ids.cash)
		.run();
	ids.plain = await first(
		"SELECT id FROM transactions WHERE raw_name='Corpus plain' ORDER BY id DESC LIMIT 1",
	);

	await db
		.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name,refund_of_id,credit_reviewed) SELECT account_id,date,-2000,'Corpus refund',?,1 FROM transactions WHERE id=?",
		)
		.bind(ids.id, ids.id)
		.run();
	ids.refund = await first(
		"SELECT id FROM transactions WHERE raw_name='Corpus refund' ORDER BY id DESC LIMIT 1",
	);

	await db
		.prepare("UPDATE transactions SET amount_cents=9000 WHERE id=?")
		.bind(ids.cash)
		.run();
	await saveSplit(
		db,
		ids.cash,
		[
			{ amountCents: 6000, categoryId: ids.cat },
			{ amountCents: 3000, categoryId: ids.arch },
		],
		"demo",
	);

	const parts = await db
		.prepare(
			"SELECT id FROM transactions WHERE parent_id=? ORDER BY id LIMIT 2",
		)
		.bind(ids.cash)
		.all<{ id: number }>();

	ids.partA = parts.results[0]?.id ?? 0;
	ids.partB = parts.results[1]?.id ?? 0;

	return ids;
}

/** Puts a case's row numbers into its text. Longer names go first, so a prefix never matches. */
function fill(text: string, ids: Ids): string {
	return text
		.replaceAll("$REFUND", String(ids.refund))
		.replaceAll("$PARTA", String(ids.partA))
		.replaceAll("$PARTB", String(ids.partB))
		.replaceAll("$PLAIN", String(ids.plain))
		.replaceAll("$CASH", String(ids.cash))
		.replaceAll("$ID2", String(ids.id2))
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

	const query = (step.query ?? [])
		.filter(([, value]) => value !== ABSENT)
		.map(
			([key, value]) =>
				`${encodeURIComponent(key)}=${encodeURIComponent(fill(String(value), ids))}`,
		);

	const url = `${BASE}${fill(step.path, ids)}${query.length ? `?${query.join("&")}` : ""}`;

	if (step.method === "GET") {
		const res = await exports.default.fetch(url, { headers });

		return { res, html: await res.text() };
	}

	const body = new FormData();

	for (const [key, value] of step.form ?? []) {
		if (value === ABSENT) continue;

		body.append(key, value === FILE ? file() : fill(value, ids));
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

// The values a browser can send for a number: see the cases below.
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
	"Infinity",
	"$ARCH",
	FILE,
	ABSENT,
];

/** The totals a Change the parts sheet can post: whole cents, padded, signed, exponent, huge and junk. */
const TOTALS: Value[] = [
	"10000",
	"9000",
	"009000",
	" 9000",
	"9000 ",
	"+9000",
	"9000.0",
	"1e3",
	"007",
	"0",
	"-5",
	"abc",
	"",
	"1.5e4",
	"0x2328",
	"9007199254740991",
	"9007199254740992",
	"1000000000000000",
	"12345678901234567890",
	"Infinity",
	HUGE,
	FILE,
	ABSENT,
];

const TOTALS_GET: Value[] = TOTALS.filter(
	(value) => value !== FILE && value !== ABSENT,
);

/** The amount the saved parts were drawn with (amount_was). */
const AMOUNTS_WAS: Value[] = [
	"9000",
	"10000",
	"007",
	" 9000",
	"1e3",
	"-5",
	"0",
	"abc",
	"",
	"9007199254740993",
	FILE,
	ABSENT,
];

/** The posted part ids: each list is one form's part_id fields, in the order posted. */
const PART_IDS: Value[][] = [
	["$PARTA", "$PARTB"],
	["$PARTA", ""],
	["", ""],
	["$PARTA"],
	["$PARTB", "$PARTA"],
	["$PARTA", "$PARTA"],
	["0$PARTA", "$PARTB"],
	["00$PARTA", "$PARTB"],
	[" $PARTA", "$PARTB"],
	["$PARTA", "1e3"],
	["$PARTA", "007"],
	["$PARTA", "-5"],
	["$PARTA", "0"],
	["$PARTA", "1.5"],
	["$PARTA", "abc"],
	["$PARTA", "9007199254740993"],
	["$PARTA", "12345678901234567890"],
	["$PARTA", "1000000000000000"],
	["$PARTA", HUGE],
	["$PARTA", "$CASH"],
	["$PARTA", FILE],
	[FILE, "$PARTB"],
	[],
];

/** The posted part categories, in row order. */
const PART_CATS: Value[][] = [
	["$CAT", "$ARCH"],
	["$CAT", " 7"],
	["$CAT", "007"],
	["$CAT", "1e3"],
	["$CAT", "0"],
	["$CAT", "abc"],
	["$CAT", ""],
	["$CAT", FILE],
	[FILE, "$ARCH"],
	["$CAT"],
	[],
];

/** The posted part amounts, in row order (dollars text). */
const PART_AMOUNTS: Value[][] = [
	["60.00", "40.00"],
	["60", "40"],
	["abc", "40.00"],
	["", ""],
	["60.00"],
	["-60", "40.00"],
	["60.00", FILE],
	[FILE, "40.00"],
	[],
];

/** The split sheet's token: lower case and 36 characters is the only shape the sheet draws; the rest are not one. */
const SHEETS: Value[] = [
	"1b4e28ba-2fa1-11d2-883f-0016d3cca427",
	"1B4E28BA-2FA1-11D2-883F-0016D3CCA427",
	"1b4e28ba-2fa1-11d2-883f-0016d3cca42",
	"1b4e28ba-2fa1-11d2-883f-0016d3cca4277",
	"1b4e28ba-2fa1-11d2-883f-0016d3cca42\n",
	"1b4e28ba2fa111d2883f0016d3cca427",
	"1b4e28ba-2fa1-11d2-883f-0016d3cca42g",
	"",
	"x",
	FILE,
	ABSENT,
];

const BACKS: Value[] = [LIST, ABSENT, "abc", "", FILE];

/** Padded and odd ids in the address; a padded real id is an intended difference (see isIntended). */
const PADS = [
	"$CASH",
	"0$CASH",
	"00$CASH",
	"000000000000000000$CASH",
	"$PLAIN",
	"0$PLAIN",
	"$ID",
	"0$ID",
	"00$ID",
	"$ID2",
	"0$ID2",
	"0",
	"9999999999999999",
	"1000000000000000",
	"123456789012345",
];

const LOCK_PATHS = [
	"$REFUND",
	"0$REFUND",
	"00$REFUND",
	"$ID",
	"0$ID",
	"$ID2",
	"$CASH",
	"0",
	"9999999999999999",
];

/** The split sheet's fields. A list is one field per entry, in the order posted; an absent field is left out. */
type SplitFields = {
	back?: Value;
	total?: Value;
	amountWas?: Value;
	pending?: Value;
	add?: Value;
	sheet?: Value;
	partIds?: Value[];
	partCategories?: Value[];
	partAmounts?: Value[];
};

const CORRECTION: SplitFields = {
	back: LIST,
	total: "10000",
	amountWas: "9000",
	partIds: ["$PARTA", "$PARTB"],
	partCategories: ["$CAT", "$ARCH"],
	partAmounts: ["60.00", "40.00"],
};

const NEW_SPLIT: SplitFields = {
	back: LIST,
	partIds: [],
	partCategories: ["$CAT", "$ARCH"],
	partAmounts: ["60.00", "30.00"],
};

const LINE: SplitFields = {
	partIds: ["$PARTA", "$PARTB"],
	partCategories: ["$CAT", "$ARCH"],
	partAmounts: ["60.00", "40.00"],
};

function splitForm(fields: SplitFields): Form {
	const form: Form = [];

	const single = (key: string, value: Value | undefined) => {
		if (value !== undefined) form.push([key, value]);
	};

	single("back", fields.back);
	single("total", fields.total);
	single("amount_was", fields.amountWas);
	single("pending_edit", fields.pending);
	single("add", fields.add);
	single("sheet", fields.sheet);

	for (const value of fields.partIds ?? []) form.push(["part_id", value]);

	for (const value of fields.partCategories ?? [])
		form.push(["part_category", value]);

	for (const value of fields.partAmounts ?? [])
		form.push(["part_amount", value]);

	return form;
}

/** The steps, one per label. A label is written with the values as the template has them, so it names each case. */
function buildSteps(): Step[] {
	const steps: Step[] = [];

	const add = (step: Omit<Step, "label">) => {
		const fields = [
			...(step.query ?? []).map(
				([key, value]) => `?${key}=${JSON.stringify(value)}`,
			),
			...(step.form ?? []).map(
				([key, value]) => `${key}=${JSON.stringify(value)}`,
			),
		].join(" ");

		const hx = step.hx === false ? " (no HX-Request)" : "";

		steps.push({
			...step,
			label:
				`#${steps.length + 1} ${step.method} ${step.path} ${fields}${hx}`.trim(),
		});
	};

	const post = (path: string, fields: SplitFields, hx?: boolean) =>
		add({ method: "POST", path, form: splitForm(fields), hx });

	// The Change the parts sheet, drawn by GET: each address, then the total, padded and junk, on the split cash entry.
	for (const path of PADS) {
		add({ method: "GET", path: `/transactions/${path}/split` });
	}

	for (const total of TOTALS_GET) {
		add({
			method: "GET",
			path: "/transactions/$CASH/split",
			query: [
				["total", total],
				["back", LIST],
			],
		});
	}

	for (const total of ["10000", "9000", "007", "abc", ""]) {
		add({
			method: "GET",
			path: "/transactions/$PLAIN/split",
			query: [["total", total]],
		});
		add({
			method: "GET",
			path: "/transactions/$ID/split",
			query: [["total", total]],
		});
	}

	for (const back of ["/transactions", "abc", "", "/transactions?month=all"]) {
		add({
			method: "GET",
			path: "/transactions/$PLAIN/split",
			query: [["back", back]],
		});
	}

	add({ method: "GET", path: "/transactions/$CASH/split", hx: false });
	add({ method: "GET", path: "/transactions/$PLAIN/split", hx: false });
	add({
		method: "GET",
		path: "/transactions/$CASH/split",
		query: [
			["total", "10000"],
			["back", LIST],
		],
		hx: false,
	});

	// The split line: each address, then one field at a time against the base.
	for (const path of PADS) {
		post(`/transactions/${path}/split/line`, LINE);
	}

	for (const total of TOTALS) {
		post("/transactions/$CASH/split/line", { ...LINE, total });
	}

	for (const partIds of PART_IDS) {
		post("/transactions/$CASH/split/line", { ...LINE, partIds });
	}

	for (const partCategories of PART_CATS) {
		post("/transactions/$CASH/split/line", { ...LINE, partCategories });
	}

	for (const partAmounts of PART_AMOUNTS) {
		post("/transactions/$CASH/split/line", { ...LINE, partAmounts });
	}

	for (const sheet of SHEETS) {
		post("/transactions/$CASH/split/line", { ...LINE, sheet });
		post("/transactions/$CASH/split/line", { ...LINE, sheet, total: "10000" });
	}

	post("/transactions/$PLAIN/split/line", LINE);
	post("/transactions/$ID/split/line", LINE);
	post("/transactions/$CASH/split/line", LINE, false);

	// The split POST: a correction (a total), then a new split, one field at a time.
	for (const path of PADS) {
		post(`/transactions/${path}/split`, CORRECTION);
	}

	for (const total of TOTALS) {
		post("/transactions/$CASH/split", { ...CORRECTION, total });
	}

	for (const amountWas of AMOUNTS_WAS) {
		post("/transactions/$CASH/split", { ...CORRECTION, amountWas });
	}

	for (const partIds of PART_IDS) {
		post("/transactions/$CASH/split", { ...CORRECTION, partIds });
	}

	for (const partCategories of PART_CATS) {
		post("/transactions/$CASH/split", { ...CORRECTION, partCategories });
	}

	for (const partAmounts of PART_AMOUNTS) {
		post("/transactions/$CASH/split", { ...CORRECTION, partAmounts });
	}

	for (const back of BACKS) {
		post("/transactions/$CASH/split", { ...CORRECTION, back });
	}

	for (const add of ["1", "2", "", ABSENT, FILE]) {
		post("/transactions/$CASH/split", { ...CORRECTION, add });
	}

	for (const pending of ["", "x", FILE, ABSENT]) {
		post("/transactions/$CASH/split", { ...CORRECTION, pending });
	}

	for (const total of ["10000", "9000", "abc"]) {
		post("/transactions/$CASH/split", {
			...CORRECTION,
			total,
			pending: "x",
			amountWas: FILE,
		});
	}

	post("/transactions/$CASH/split", { ...CORRECTION, total: ABSENT });
	post("/transactions/$CASH/split", { ...CORRECTION, amountWas: ABSENT });
	post("/transactions/$CASH/split", { ...CORRECTION, back: ABSENT }, false);

	post("/transactions/$PLAIN/split", NEW_SPLIT);
	post("/transactions/$PLAIN/split", { ...NEW_SPLIT, back: "abc" });
	post("/transactions/$PLAIN/split", { ...NEW_SPLIT, add: "1" });
	post("/transactions/$PLAIN/split", { ...NEW_SPLIT, total: "10000" });
	post("/transactions/$PLAIN/split", { ...NEW_SPLIT, partIds: ["$PARTA"] });
	post("/transactions/$PLAIN/split", {
		...NEW_SPLIT,
		partCategories: ["$CAT", "007"],
	});
	post("/transactions/$PLAIN/split", {
		...NEW_SPLIT,
		partAmounts: ["25.00", "15.00"],
	});
	post("/transactions/$PLAIN/split", {
		...NEW_SPLIT,
		partAmounts: ["25.00", "15.00"],
		partIds: ["0$PARTA"],
	});
	post("/transactions/$CASH/split", NEW_SPLIT);
	post("/transactions/$ID/split", NEW_SPLIT);
	post("/transactions/$ID/split", { ...CORRECTION, total: "10000" });

	// Remove the split: each address, then the back the form posts.
	for (const path of PADS) {
		add({
			method: "POST",
			path: `/transactions/${path}/split/remove`,
			form: [["back", LIST]],
		});
	}

	for (const back of BACKS) {
		add({
			method: "POST",
			path: "/transactions/$CASH/split/remove",
			form: back === ABSENT ? [] : [["back", back]],
		});
	}

	add({
		method: "POST",
		path: "/transactions/$PLAIN/split/remove",
		form: [["back", LIST]],
	});
	add({
		method: "POST",
		path: "/transactions/$CASH/split/remove",
		form: [["back", LIST]],
		hx: false,
	});

	// The category lock: each address, then the category, the rule's tick, the purchase's link and the credit's flags.
	const lock = (form: Form, path = "/transactions/$REFUND/category/lock") =>
		add({ method: "POST", path, form });

	for (const path of LOCK_PATHS) {
		lock(
			[
				["category", "$CAT"],
				["back", LIST],
			],
			`/transactions/${path}/category/lock`,
		);
	}

	for (const category of [...NUMBERS, "new"]) {
		lock([
			["category", category],
			["back", LIST],
		]);
		lock(
			[
				["category", category],
				["back", LIST],
			],
			"/transactions/$ID/category/lock",
		);
	}

	const REFUND_OF: Value[] = [
		"$ID",
		"$ID2",
		"0",
		"007",
		" $ID",
		"1e3",
		"abc",
		"",
		"-1",
		"1.5",
		"9007199254740993",
		"$CASH",
		"$ARCH",
		"$REFUND",
		FILE,
		ABSENT,
	];

	for (const refundOf of REFUND_OF) {
		lock([
			["refund_of", refundOf],
			["category", "$CAT"],
			["back", LIST],
		]);
		lock(
			[
				["refund_of", refundOf],
				["category", "$CAT"],
				["back", LIST],
			],
			"/transactions/$ID/category/lock",
		);
	}

	const RULE_WAS: Value[] = [
		"$CAT",
		"007",
		"abc",
		"0",
		"",
		"$ARCH",
		FILE,
		ABSENT,
	];

	for (const ruleWas of RULE_WAS) {
		lock([
			["category", "$CAT"],
			["always", "1"],
			["always_was", "1"],
			["rule_category_was", ruleWas],
			["back", LIST],
		]);
	}

	for (const always of ["1", "0", ABSENT]) {
		lock([
			["category", "$CAT"],
			["always", always],
			["back", LIST],
		]);
	}

	for (const name of ["", "Shops", FILE, ABSENT]) {
		lock([
			["category", "new"],
			["new_category_name", name],
			["back", LIST],
		]);
	}

	const FLAGS: Form[] = [
		[["income", "1"]],
		[
			["income", "1"],
			["income_was", "1"],
		],
		[
			["income", "0"],
			["income_was", "1"],
		],
		[
			["creditReviewed", "1"],
			["creditReviewedVisible", "1"],
		],
		[
			["creditReviewed", "1"],
			["creditReviewed_was", "0"],
		],
		[["creditReviewedVisible", "1"]],
	];

	for (const flags of FLAGS) {
		lock([["category", "$CAT"], ...flags, ["back", LIST]]);
	}

	for (const back of BACKS) {
		lock(
			back === ABSENT
				? [["category", "$CAT"]]
				: [
						["category", "$CAT"],
						["back", back],
					],
		);
	}

	return steps;
}

/**
 * Cases whose answer is meant to change (the intended difference in the PR notes): a padded address id, a leading zero
 * on a real transaction, now answers as a missing transaction, with no write. Each is checked against its own answer.
 */
export const isIntended = (step: Step) =>
	/^\/transactions\/0+\$/.test(step.path);

export const STEPS = buildSteps();

const labels = STEPS.map((step) => step.label);

if (new Set(labels).size !== labels.length) {
	throw new Error("two proof cases share a label");
}
