import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { feedback } from "../src/routes/feedback";
import { envWith } from "./helpers/doubles";
import { seedMerchant } from "./helpers/merchants";
import { pinClock } from "./pinned-clock";

// The text fields the write routes read as text (#1109): a file part posted in a text box is read as "" (the same answer
// a missing field gets), never as "[object File]". Each case posts one input a browser can send, to a freshly seeded demo,
// and records what comes back: the status, the type, the Location, the HX headers, a hash of the page, whether the page
// shows "[object File]", and a hash of every table after the answer, with a count of the rows that hold "[object File]".
// The lines in fixtures/route-text-file-baseline.json were recorded on the code before the change. After the change only
// the file rows of the changed fields differ, and each of those equals its missing-field row (intended difference).

const db = env.DB;
const BASE = "http://tally.test";
const ABSENT = "<absent>";
const FILE = "<file>";
const LIST = "/transactions?month=all";
const VENMO = "VENMO PAYMENT";
const BLUE = "BLUE BOTTLE COF";

/** The limit cookie the feedback form is drawn with; a form that has no such id has expired (feedback.tsx). */
const FEEDBACK_COOKIE =
	"__Host-tally-feedback-limit=00000000-0000-4000-8000-0000000000fb";

export type Value = string | typeof FILE | typeof ABSENT;

export type Form = [string, Value][];

export type Prep =
	| "none"
	| "bill"
	| "new"
	| "ask"
	| "name"
	| "learned"
	| "rule"
	| "filed"
	| "panel"
	| "cash";

export type Step = {
	label: string;
	path: string;
	form: Form;
	hx: boolean;
	prep: Prep;
	/** A file part is posted in a text field this change reads as text: the case must match its missing-field sibling. */
	missingSibling?: Step;
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

const plain = (text: string) =>
	text.replaceAll(
		/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
		"UUID",
	);

/** A row without its stamps: the answers stamp times from the database's own clock, which the pinned clock does not move. */
const withoutStamps = (row: Row) =>
	Object.fromEntries(
		Object.entries(row).filter(([key]) => !key.endsWith("_at")),
	);

const TEXT_FILE = "[object File]";

/** A stored row as the tables hold it: text, numbers, or nothing. */
type Row = Record<string, string | number | null>;

/** A value a seed statement binds. */
type Bind = string | number | null;

/** Every table's rows (without stamps), hashed, and how many rows hold a stored "[object File]". */
async function stateOf(): Promise<{ hash: string; stored: number }> {
	const { results: tables } = await db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
		)
		.all<{ name: string }>();

	let text = "";
	let stored = 0;

	for (const { name } of tables) {
		const { results } = await db
			.prepare(`SELECT * FROM "${name}" ORDER BY rowid`)
			.all<Row>();

		for (const row of results) {
			const json = plain(JSON.stringify(withoutStamps(row))).replace(
				/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g,
				"TS",
			);

			if (json.includes(TEXT_FILE)) stored++;
			text += `${name} ${json}\n`;
		}
	}

	return { hash: await sha(text), stored };
}

/** The ids a case is written from, seeded per case. Tokens such as $CAT in a step's text take these values. */
type Ids = Record<string, string>;

/** The live categories, the demo's first purchase and the first active bill, read after the reset. */
async function baseIds(TODAY: string): Promise<Ids> {
	const first = async (sql: string) =>
		(await db.prepare(sql).first<{ id: number }>())?.id ?? 0;

	return {
		CAT: String(
			await first(
				"SELECT id AS id FROM categories WHERE archived=0 ORDER BY id LIMIT 1",
			),
		),
		ARCH: String(
			await first(
				"SELECT id AS id FROM categories WHERE archived=0 ORDER BY id DESC LIMIT 1",
			),
		),
		BILL: String(
			await first(
				"SELECT id AS id FROM bills WHERE active=1 ORDER BY id LIMIT 1",
			),
		),
		ID: String(
			await first(
				"SELECT t.id AS id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type<>'cash' AND t.parent_id IS NULL AND t.refund_of_id IS NULL AND t.is_split=0 ORDER BY t.id LIMIT 1",
			),
		),
		MONTH: TODAY.slice(0, 7),
		TODAY,
	};
}

/** Seeds one case's rows on top of the demo, and returns the ids its text names. */
async function prepare(prep: Prep, ids: Ids): Promise<Ids> {
	const more: Ids = {};

	const run = (sql: string, ...binds: Bind[]) =>
		db
			.prepare(sql)
			.bind(...binds)
			.run();

	const id = async (sql: string, ...binds: Bind[]) =>
		(
			await db
				.prepare(sql)
				.bind(...binds)
				.first<{ id: number }>()
		)?.id ?? 0;

	if (prep === "bill") {
		await run("UPDATE bills SET active=0 WHERE id=?", Number(ids.BILL));
	}

	if (prep === "new") {
		await run(
			`INSERT INTO merchants (raw_name, display_name) VALUES ('CHEWY.COM 1', 'Chewy'), ('PETSMART 22', 'Petsmart'), ('BANFIELD 5', 'Banfield')`,
		);

		const sid = await id(
			"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', 'pending') RETURNING id",
		);

		const tx = (raw: string, amount: number) =>
			id(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, category_suggestion_id)
				VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', ?, ?, ?) RETURNING id`,
				`plaid-${crypto.randomUUID()}`,
				amount,
				raw,
				sid,
			);

		more.SID = String(sid);
		more.PET0 = String(await tx("CHEWY.COM 1", 4500));
		more.PET1 = String(await tx("PETSMART 22", 3100));
		more.PET2 = String(await tx("BANFIELD 5", 8900));
	}

	if (prep === "filed") {
		more.FILED = String(
			await id(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, category_confidence, jev_category_id)
				VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', 1499, 'AUDIBLE*TE3E10I7 WA', 0.58,
				(SELECT id FROM categories WHERE name = 'Eating Out')) RETURNING id`,
				`plaid-${crypto.randomUUID()}`,
			),
		);
	}

	if (prep === "ask") {
		await run(
			"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'Venmo')",
			VENMO,
		);
		more.INC = String(
			await id(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, income_confidence)
				VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', -250000, ?, 0.5) RETURNING id`,
				`plaid-${crypto.randomUUID()}`,
				VENMO,
			),
		);
	}

	if (prep === "name") {
		await seedMerchant(db, {
			key: BLUE,
			status: "pending",
			names: ["Blue Bottle Coffee"],
		});
		await run(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name)
			VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', 600, ?)`,
			`plaid-${crypto.randomUUID()}`,
			BLUE,
		);
		more.NAME = String(
			await id("SELECT rowid AS id FROM merchants WHERE raw_name = ?", BLUE),
		);
	}

	if (prep === "learned") {
		await run(
			"INSERT INTO bank_text_rules (cleaned_text, category_id) VALUES ('netflix.com', ?)",
			Number(ids.CAT),
		);
	}

	if (prep === "rule") {
		await run(
			"INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES ('RULE REMOVE TEST', 'Remove Test', ?)",
			Number(ids.CAT),
		);
	}

	return { ...ids, ...more };
}

/** Fills a step's tokens ($CAT, $ID, ...) from the case's ids: each token is one whole name. */
function fill(text: string, ids: Ids): string {
	return text.replace(
		/\$[A-Z]+[0-9]*/g,
		(token) => ids[token.slice(1)] ?? token,
	);
}

const file = () => new File(["x"], "x.txt", { type: "text/plain" });

/**
 * The feedback form, as test/feedback.test.ts runs it: the feedback routes alone, with the demo off, so the form is open.
 */
function feedbackFetch(path: string, init: RequestInit) {
	const app = new Hono<{ Bindings: Env; Variables: { actor: string } }>();

	app.use("*", async (c, next) => {
		c.set("actor", "person@example.com");
		await next();
	});
	app.route("/", feedback);

	const bindings = envWith(env, {
		DEMO: "false",
		FEEDBACK_GITHUB_TOKEN: undefined,
		FEEDBACK_DIAGNOSTICS_ENABLED: "false",
		FEEDBACK_REPLAY_LINKS_ENABLED: "false",
		APP_VERSION: undefined,
	});

	return app.fetch(new Request(BASE + path, init), bindings, {
		waitUntil: () => {},
		passThroughOnException() {},
		props: {},
	});
}

/** Posts one step: the page's own form encoding, with a file part where the step names FILE. */
async function send(step: Step, ids: Ids) {
	const headers = new Headers({ Origin: BASE });

	if (step.hx) headers.set("HX-Request", "true");

	if (step.path.startsWith("/feedback")) headers.set("cookie", FEEDBACK_COOKIE);

	const body = new FormData();

	for (const [key, value] of step.form) {
		if (value === ABSENT) continue;

		body.append(fill(key, ids), value === FILE ? file() : fill(value, ids));
	}

	const init: RequestInit = {
		method: "POST",
		redirect: "manual",
		headers,
		body,
	};

	const res = step.path.startsWith("/feedback")
		? await feedbackFetch(fill(step.path, ids), init)
		: await exports.default.fetch(`${BASE}${fill(step.path, ids)}`, init);

	return { res, html: await res.text() };
}

/** One line per case: the status, the type, the Location, the HX headers, the page, and the state of every table. */
async function lineOf(res: Response, html: string): Promise<string> {
	const hx = [...res.headers.entries()]
		.filter(([name]) => name.startsWith("hx-"))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `${name}=${plain(value)}`);

	const state = await stateOf();

	return [
		res.status,
		res.headers.get("content-type") ?? "-",
		res.headers.get("location") ?? "-",
		...hx,
		`echo ${html.includes(TEXT_FILE) ? "yes" : "no"}`,
		`body ${await sha(plain(html))}`,
		`state ${state.hash}`,
		`stored ${state.stored}`,
	].join(" | ");
}

/** Runs one step on a freshly seeded demo: its line. */
export async function recordCase(step: Step): Promise<string> {
	pinClock();
	const TODAY = todayIn(DEFAULT_TIME_ZONE);
	// The AUTOINCREMENT counters are cleared before the reset as well, which inserts with them.
	await db.prepare("DELETE FROM sqlite_sequence").run();
	await resetDemo(db, TODAY);
	// A reset keeps two things a case could leave behind, so the cases before it would change its state: the AUTOINCREMENT
	// counters, and the household's Jev call counters (resetDemo keeps the jev_calls_ rows). Both start clean for each case.
	await db.prepare("DELETE FROM sqlite_sequence").run();
	await db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();
	const ids = await prepare(step.prep, await baseIds(TODAY));

	if (step.prep === "ask") {
		// The question is asked after a No on the income item (decision 101), as the screen asks it.
		await postPlain(`/settings/suggestions`, [
			["id", `income-${ids.INC}`],
			["answer", "no"],
		]);
	}

	const { res, html } = await send(step, ids);

	return lineOf(res, html);
}

/** A plain post used to set a case up; its answer is not recorded. */
async function postPlain(path: string, form: Form) {
	const body = new FormData();

	for (const [key, value] of form) {
		if (value === ABSENT) continue;

		body.append(key, value === FILE ? file() : value);
	}

	await exports.default.fetch(`${BASE}${path}`, {
		method: "POST",
		redirect: "manual",
		headers: { Origin: BASE, "HX-Request": "true" },
		body,
	});
}

/** A form with one key's values replaced by another value (every entry of that key). */
function replaceValue(form: Form, key: string, value: Value): Form {
	return form.map(([k, v]): [string, Value] =>
		k === key ? [k, value] : [k, v],
	);
}

/** The steps: each field the change reads as text, with a file, "", a missing field and the canonical value. */
export const STEPS: Step[] = [];

const labelOf = (step: Omit<Step, "label">) =>
	`${step.hx ? "htmx" : "plain"} POST ${step.path} ${step.form
		.map(
			([key, value]) =>
				`${key}=${value === FILE ? "<file>" : value === ABSENT ? "<absent>" : JSON.stringify(value)}`,
		)
		.join(" ")}`;

/** Adds a step in both forms: htmx and plain. A file step names the missing-field step it must match, if it is changed. */
function add(base: Omit<Step, "label" | "hx">, changed: string | null) {
	for (const hx of [true, false]) {
		const step: Step = { ...base, hx, label: "" };

		step.label = labelOf(step);

		if (changed !== null && base.form.some(([, v]) => v === FILE)) {
			const absent: Step = {
				...step,
				form: step.form.map(([key, value]): [string, Value] =>
					value === FILE && key === changed ? [key, ABSENT] : [key, value],
				),
			};

			absent.label = labelOf(absent);
			step.missingSibling = absent;
		}

		// The same case can come from two fields (a canonical base form): it is one case, recorded once.
		if (!STEPS.some((known) => known.label === step.label)) STEPS.push(step);
	}
}

/**
 * The variants of one field: a file, "", a missing field, and the canonical value. A field the base form lacks is added.
 * `changed` is false for a field whose answers stay as they are (pinned), so no file row is compared with its sibling.
 */
function fieldSteps(
	path: string,
	base: Form,
	key: string,
	prep: Prep = "none",
	changed = true,
) {
	const has = base.some(([k]) => k === key);
	const canonical = base.find(([k]) => k === key)?.[1];
	const values: Value[] = [FILE, "", ABSENT];

	if (canonical !== undefined && canonical !== FILE) values.push(canonical);

	for (const value of values) {
		const form: Form = has
			? base.map(([k, v]) => (k === key ? [k, value] : [k, v]))
			: [...base, [key, value]];

		add({ path, form, prep }, changed ? key : null);
	}
}

/** Fields the change reads as text, one by one, on the routes that save them. */
export function buildSteps() {
	STEPS.length = 0;

	// A plan's name (plans.tsx planForm).
	const plan: Form = [
		["name", "Gift"],
		["amount", "12"],
		["month", "$MONTH"],
	];

	fieldSteps("/plans", plan, "name");
	// The amount and the month are refused by their own checks before anything is saved: pinned as they are.
	fieldSteps("/plans", plan, "amount", "none", false);
	fieldSteps("/plans", plan, "month", "none", false);

	// A bill's name and the bank's text (bills.tsx save).
	const bill: Form = [
		["name", "Gym"],
		["amount", "10"],
		["due_day", "5"],
		["frequency", "monthly"],
		["category_id", "$CAT"],
		["merchant_raw_name", "GYM CO"],
	];

	fieldSteps("/bills", bill, "name");
	fieldSteps("/bills", bill, "merchant_raw_name");
	fieldSteps("/bills/$BILL", bill, "name");

	// A bill's name when it comes back from an inactive state (bills.tsx reactivate, ?rename=1).
	fieldSteps(
		"/bills/$BILL/reactivate?rename=1",
		[["name", "Gym Again"]],
		"name",
		"bill",
	);

	// The organize screen's merchant name and its new category's name (organize.tsx).
	const organize: Form = [
		["category", "$CAT"],
		["name", "The Bakery"],
		["group", "Local Bakery"],
		["raw_name", "SQ *LOCAL BAKERY 4432"],
	];

	fieldSteps("/transactions/organize", organize, "name");
	fieldSteps(
		"/transactions/organize",
		replaceValue(organize, "category", "new"),
		"new_category_name",
	);

	// A household person's name (settings.tsx people, add).
	fieldSteps(
		"/settings/people",
		[
			["action", "add"],
			["name", "Sam"],
		],
		"name",
	);

	// A category's name when added, and when renamed (settings.tsx categories).
	fieldSteps("/settings/categories", [["name", "Hobbies"]], "name");
	fieldSteps("/settings/categories/$CAT", [["name", "Pets Two"]], "name");

	// A merchant's Always rule removed (settings.tsx merchant-rules/remove).
	fieldSteps(
		"/settings/merchant-rules/remove",
		[["merchant", "RULE REMOVE TEST"]],
		"merchant",
		"rule",
	);

	// A learned line forgotten or changed (settings.tsx learned forget and change).
	fieldSteps(
		"/settings/learned/forget",
		[["text", "netflix.com"]],
		"text",
		"learned",
	);
	fieldSteps(
		"/settings/learned/change",
		[
			["text", "netflix.com"],
			["category", "$CAT"],
		],
		"text",
		"learned",
	);

	// A purchase's note under a new category's suggestion, in Settings and on the Suggestions screen.
	// A note is kept under a purchase the person did not tick (decision 120), so the note is the unticked one's.
	const notes: Form = [
		["ids", "$PET0"],
		["shown", "$PET0"],
		["shown", "$PET1"],
		["shown", "$PET2"],
		["note_$PET1", "a note"],
	];

	fieldSteps("/settings/suggestions/$SID/create", notes, "note_$PET1", "new");
	fieldSteps(
		"/settings/suggestions",
		[
			["id", "new-$SID"],
			["answer", "yes"],
			["shown", "$PET0"],
			["shown", "$PET1"],
			["shown", "$PET2"],
			["ticked", "$PET0"],
			["note_$PET1", "a note"],
		],
		"note_$PET1",
		"new",
	);

	// The Settings question after a No, for a new category: its stores are the merchants the suggestion was made from.
	fieldSteps(
		"/settings/suggestions/$SID/dismiss",
		[
			["id", "new-$SID"],
			["kind", "new_category"],
			["answer", "ask_yes"],
			["store", "CHEWY.COM 1"],
		],
		"store",
		"new",
	);

	// A typed name for a new category on the Suggestions screen (create, and else).
	fieldSteps(
		"/settings/suggestions",
		[
			["id", "category-$FILED"],
			["answer", "create"],
			["new_name", "Books & audio"],
		],
		"new_name",
		"filed",
	);
	fieldSteps(
		"/settings/suggestions",
		[
			["id", "category-$FILED"],
			["answer", "else"],
			["category", ""],
			["new_name", "Books"],
		],
		"new_name",
		"filed",
	);
	fieldSteps(
		"/settings/suggestions",
		[
			["id", "category-$FILED"],
			["answer", "else"],
			["category", "$CAT"],
			["new_name", "Books"],
		],
		"new_name",
		"filed",
	);

	// The name of a merchant typed on the Name row (Type your own).
	fieldSteps(
		"/settings/suggestions",
		[
			["id", "name-$NAME"],
			["answer", "else"],
			["name_pick", "own"],
			["merchant", "Blue Bottle"],
		],
		"merchant",
		"name",
	);

	// The stores of a Never suggest answer (Yes writes a line for each store), on the Suggestions screen and in Settings.
	const ask: Form = [
		["id", "income-$INC"],
		["answer", "ask_yes"],
		["kind", "income"],
		["store", VENMO],
	];

	fieldSteps("/settings/suggestions", ask, "store", "ask");
	// A file among the stores that are real: the real one is kept, and the file is no store (pinned: no file row changes).
	add(
		{
			path: "/settings/suggestions",
			form: [
				["id", "income-$INC"],
				["answer", "ask_yes"],
				["kind", "income"],
				["store", VENMO],
				["store", FILE],
			],
			prep: "ask",
		},
		null,
	);

	// A purchase's edit panel: the typed name, the new category's name and the echoes of both (transactions.tsx, edit.ts).
	const panel: Form = [
		["category", "$CAT"],
		["name_pick", "own"],
		["merchant", "Corpus name"],
		["back", LIST],
	];

	fieldSteps("/transactions/$ID", panel, "merchant");
	fieldSteps(
		"/transactions/$ID",
		replaceValue(panel, "category", "new"),
		"new_category_name",
	);

	// Pinned as they are: fields a file is refused in. The panel's note is the exception: a file in it is no note, so the
	// saved note stays (test/panel-note-file-corpus.ts), and its two file rows were recorded on that change.
	for (const key of [
		"note",
		"kind",
		"category",
		"for_person_id",
		"refund_of",
	]) {
		fieldSteps(
			"/transactions/$ID",
			[...panel, ["for_person_id_was", "abc"]],
			key,
			"none",
			false,
		);
	}

	// A cash entry (transactions.tsx cash): where it was spent, and its note; the date and amount are checked first.
	const cash: Form = [
		["date", "$TODAY"],
		["amount", "5.00"],
		["merchant", "Farmers market"],
		["category", "$CAT"],
		["note", "Fresh"],
	];

	fieldSteps("/transactions/cash", cash, "merchant");
	fieldSteps("/transactions/cash", cash, "note");
	fieldSteps("/transactions/cash", cash, "category", "none", false);
	fieldSteps("/transactions/cash", cash, "date", "none", false);

	// The feedback form's message, and the route the feedback came from (feedback/form.ts).
	const feedback: Form = [
		["type", "Bug"],
		["feeling", "Confused"],
		["message", "The totals look wrong"],
		["from", "/"],
	];

	fieldSteps("/feedback", feedback, "message");
	fieldSteps("/feedback", feedback, "from");
	fieldSteps("/feedback", feedback, "return_to");

	const labels = STEPS.map((step) => step.label);

	const seen = new Set<string>();

	for (const label of labels) {
		if (seen.has(label))
			throw new Error(`two route text cases share a label: ${label}`);
		seen.add(label);
	}

	return STEPS;
}

buildSteps();
