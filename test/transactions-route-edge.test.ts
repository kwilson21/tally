import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import baseline from "./fixtures/transactions-edge-baseline.json";
import { pinClock } from "./pinned-clock";

// The transactions routes read their numbers at the edge (#1006, PR 9). Each case below posts or gets one input a
// person's browser can send to a freshly seeded demo and records what comes back: the status, the type, the Location,
// the HX-Trigger and HX-Push-Url headers, a hash of the page's body and a hash of every row the answer can touch. The
// lines in fixtures/transactions-edge-baseline.json were recorded on the code before the edge: every answer must stay
// the same, except the cases listed in INTENDED, which are checked on their own below.

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
	arch: number;
	now: number;
};

type Step = {
	label: string;
	method: "GET" | "POST";
	path: string;
	query?: [string, string][];
	form?: [string, string][];
	hx?: boolean;
	token?: boolean;
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

/** Every row the answers can change: the transactions, the categories and the accounts. */
async function stateHash() {
	const [transactions, categories, accounts] = await Promise.all([
		db.prepare("SELECT * FROM transactions ORDER BY id").all<Row>(),
		db.prepare("SELECT * FROM categories ORDER BY id").all<Row>(),
		db.prepare("SELECT id, type FROM accounts ORDER BY id").all<Row>(),
	]);

	return sha(
		JSON.stringify([
			transactions.results.map(withoutStamps),
			categories.results.map(withoutStamps),
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

	return {
		id: await first(`${purchases} LIMIT 1`),
		id2: await first(`${purchases} DESC LIMIT 1`),
		cash: await first(
			"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type='cash' AND t.parent_id IS NULL ORDER BY t.id LIMIT 1",
		),
		cat: await first(
			"SELECT id FROM categories WHERE archived=0 ORDER BY id LIMIT 1",
		),
		arch: archived?.id ?? 999,
		now: Date.now(),
	};
}

/** Puts a case's row numbers into its text. "$ID2" and "$TOKEN_UP" go first, so their prefixes do not match. */
function fill(text: string, ids: Ids, token: string): string {
	return text
		.replaceAll("$ID2", String(ids.id2))
		.replaceAll("$ID", String(ids.id))
		.replaceAll("$HEX", ids.id.toString(16))
		.replaceAll("$CASH", String(ids.cash))
		.replaceAll("$CAT", String(ids.cat))
		.replaceAll("$ARCH", String(ids.arch))
		.replaceAll("$NOW", String(ids.now))
		.replaceAll("$PAST", String(ids.now - 1000))
		.replaceAll("$FUTURE", String(ids.now + 1000))
		.replaceAll("$TOKEN_UP", token.toUpperCase())
		.replaceAll("$TOKEN", token);
}

const file = () => new File(["x"], "x.txt", { type: "text/plain" });

/** Runs one step and returns its response and the page text. The token is the Undo a seed made, when the step names one. */
async function run(step: Step, ids: Ids, token: string) {
	const headers = new Headers();

	if (step.hx !== false) headers.set("HX-Request", "true");

	const query = (step.query ?? [])
		.filter(([, value]) => value !== ABSENT)
		.map(([key, value]) => [key, fill(value, ids, token)] as const);

	const url = `${BASE}${fill(step.path, ids, token)}${query.length ? `?${new URLSearchParams(query)}` : ""}`;

	if (step.method === "GET") {
		const res = await exports.default.fetch(url, { headers });

		return { res, html: await res.text() };
	}

	headers.set("Origin", BASE);
	const body = new FormData();

	for (const [key, value] of step.form ?? []) {
		if (value === ABSENT) continue;

		body.append(key, value === FILE ? file() : fill(value, ids, token));
	}

	const res = await exports.default.fetch(url, {
		method: "POST",
		headers,
		body,
	});

	return { res, html: await res.text() };
}

/** One line per case: the status, type, Location, the two HX headers, the page and the rows. Random UUIDs (Undo tokens, the cash form's entry key) are written as UUID. */
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

/** An Undo token from a real cash delete, read from its toast. */
async function undoToken(ids: Ids): Promise<string> {
	const res = await exports.default.fetch(
		`${BASE}/transactions/${ids.cash}/delete`,
		{
			method: "POST",
			headers: { "HX-Request": "true", Origin: BASE },
			body: new URLSearchParams({ confirm: "1", back: LIST }),
		},
	);

	const trigger: { toast?: { undo?: string } } = JSON.parse(
		res.headers.get("HX-Trigger") ?? "{}",
	);

	if (!trigger.toast?.undo) throw new Error("seed: no Undo token");

	return trigger.toast.undo;
}

// The values a browser can send, written with the rows of the case; see fill().
const QUERY_NUMBERS = [
	"$ID",
	"0$ID",
	"00$ID",
	" $ID",
	"$ID ",
	"+$ID",
	"$ID.0",
	"$ID.5",
	"0x$HEX",
	"1e3",
	"0",
	"-1",
	"1.5",
	"abc",
	"",
	"Infinity",
	"9999999999999999",
	"123456789012345",
	ABSENT,
];

const ID_LISTS = [
	"$ID",
	"0$ID",
	" $ID ",
	"$ID,abc",
	"$ID,$ID2",
	"$ID,0",
	"$ID2,$ID",
	"1e3",
	"0",
	"-1",
	"",
	"9999999999999999",
	"$ID.5",
	" $ID",
	ABSENT,
	FILE,
];

const CATEGORIES = [
	"$CAT",
	"0$CAT",
	"00$CAT",
	" $CAT",
	"$CAT.0",
	"+$CAT",
	"1e1",
	"1e21",
	"999999999999999999999",
	"0",
	"-1",
	"1.5",
	"abc",
	"",
	"0x7",
	"Infinity",
	"$ARCH",
	FILE,
	ABSENT,
];

/** The address ids the route pattern admits (digits only); the handler reads the number of each. */
const PATH_IDS = [
	"$CASH",
	"0$CASH",
	"00$CASH",
	"$ID",
	"0$ID",
	"0",
	"9999999999999999",
	"123456789012345",
	"000000000000000000$CASH",
];

const TOKENS = [
	"$TOKEN",
	"$TOKEN_UP",
	" $TOKEN",
	"$TOKEN\n",
	"",
	"abc",
	"x".repeat(36),
	"$TOKEN+",
	FILE,
	ABSENT,
];

/** The steps, one per label. A label is written with the values as the template has them, so it names each case. */
function buildSteps(): Step[] {
	const steps: Step[] = [];

	const add = (step: Omit<Step, "label">) => {
		const fields = [...(step.query ?? []), ...(step.form ?? [])]
			.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
			.join(" ");

		const hx = step.hx === false ? " (no HX-Request)" : "";

		const number = steps.length + 1;

		steps.push({
			...step,
			label: `#${number} ${step.method} ${step.path} ${fields}${hx}`.trim(),
		});
	};

	// GET /transactions: the list's own numbers (focus, the category, account and page filters).
	for (const name of ["focus", "category", "account", "page"]) {
		for (const value of QUERY_NUMBERS) {
			add({ method: "GET", path: LIST_PATH, query: [[name, value]] });
		}
	}

	// The Likely close's saved row and its time: both must be whole numbers, and the time must be inside the toast.
	for (const saved of ["$ID", "0$ID", "1e3", "abc", "", "-1"]) {
		for (const savedAt of [
			"$NOW",
			"$PAST",
			"$FUTURE",
			"0$NOW",
			"1e3",
			"abc",
			"",
			" $NOW",
		]) {
			add({
				method: "GET",
				path: LIST_PATH,
				query: [
					["saved", saved],
					["saved-at", savedAt],
				],
			});
		}
	}

	add({ method: "GET", path: LIST_PATH, query: [["focus", "$ID"]], hx: false });
	add({
		method: "GET",
		path: LIST_PATH,
		query: [
			["saved", "$ID"],
			["saved-at", "$NOW"],
		],
		hx: false,
	});
	add({
		method: "GET",
		path: LIST_PATH,
		query: [
			["category", "$CAT"],
			["account", "0$CAT"],
		],
		hx: false,
	});

	// The Select bar's count, the selection's posts, and the cash sheet opened from a selection.
	for (const ids of ID_LISTS) {
		add({
			method: "GET",
			path: "/transactions/select/count",
			query: [
				["ids", ids],
				["back", LIST],
				["select", "1"],
			],
		});
	}

	for (const ids of ID_LISTS) {
		add({
			method: "POST",
			path: "/transactions/select/category",
			form: [
				["ids", ids],
				["back", LIST],
			],
		});
	}

	for (const ids of ID_LISTS) {
		add({
			method: "POST",
			path: "/transactions/select/exclude",
			form: [
				["ids", ids],
				["back", LIST],
			],
		});
	}

	for (const ids of ID_LISTS) {
		add({
			method: "GET",
			path: "/transactions/cash/new",
			query: [
				["ids", ids],
				["back", LIST],
				["select", "1"],
			],
		});
	}

	add({
		method: "POST",
		path: "/transactions/select/count",
		form: [
			["ids", "$ID"],
			["all", "1"],
		],
	});

	// The category a selection is set to: every category text, with a row that is ticked.
	for (const category of CATEGORIES) {
		add({
			method: "POST",
			path: "/transactions/select/category/save",
			form: [
				["ids", "$ID"],
				["back", LIST],
				["category", category],
			],
		});
	}

	for (const ids of ID_LISTS) {
		add({
			method: "POST",
			path: "/transactions/select/category/save",
			form: [
				["ids", ids],
				["back", LIST],
				["category", "$CAT"],
			],
		});
	}

	// The Add cash form: its category, and the amount and date it is checked with.
	for (const category of CATEGORIES) {
		add({
			method: "POST",
			path: "/transactions/cash",
			form: cashForm({ category }),
		});
	}

	for (const amount of ["5", "abc", "1e3", "0", "", "-5", "12.345"]) {
		add({
			method: "POST",
			path: "/transactions/cash",
			form: cashForm({ amount }),
		});
	}

	for (const date of ["2026-02-30", "", "2030-01-01", "2026-10-11"]) {
		add({
			method: "POST",
			path: "/transactions/cash",
			form: cashForm({ date }),
		});
	}

	add({
		method: "POST",
		path: "/transactions/cash",
		form: cashForm({ category: "$CAT" }),
		hx: false,
	});

	// An address id: the transaction's edit panel, and the delete of a cash entry (sheet first, then the delete).
	for (const id of PATH_IDS) {
		add({ method: "GET", path: `/transactions/${id}` });
	}

	for (const id of PATH_IDS) {
		add({
			method: "POST",
			path: `/transactions/${id}/delete`,
			form: [
				["confirm", "1"],
				["back", LIST],
			],
		});
	}

	for (const id of ["$CASH", "0$CASH", "00$CASH"]) {
		add({
			method: "POST",
			path: `/transactions/${id}/delete`,
			form: [["back", LIST]],
		});
	}

	add({
		method: "POST",
		path: "/transactions/$CASH/delete",
		form: [
			["confirm", "1"],
			["back", LIST],
		],
		hx: false,
	});

	// The Undo of a cash delete: the token every answer names back.
	for (const token of TOKENS) {
		add({
			method: "POST",
			path: "/transactions/undo-cash-delete",
			form: [
				["token", token],
				["back", LIST],
			],
			token: true,
		});
	}

	add({
		method: "POST",
		path: "/transactions/undo-cash-delete",
		form: [
			["token", "$TOKEN"],
			["back", LIST],
		],
		hx: false,
		token: true,
	});

	return steps;
}

const LIST_PATH = "/transactions";

/** The Add cash form with the valid values of the other fields, and the one field this case changes. */
function cashForm(
	change: Partial<Record<"date" | "amount" | "category", string>>,
): [string, string][] {
	const values = {
		date: "2026-10-11",
		amount: "5",
		merchant: "Corner shop",
		category: "$CAT",
		note: "",
		...change,
	};

	return [
		["date", values.date],
		["amount", values.amount],
		["merchant", values.merchant],
		["category", values.category],
		["note", values.note],
		["back", LIST],
	];
}

/**
 * Cases whose answer is meant to change (the intended difference in the PR notes): a padded address id now answers as
 * a missing transaction, with no write. Each is checked below, against its own expectation, not the baseline.
 */
const INTENDED = (step: Step) =>
	/^\/transactions\/0+\$(CASH|ID)/.test(step.path);

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

describe("the transactions routes' answers, read at the edge (#1006, PR 9)", () => {
	it.each(STEPS.map((step) => [step.label, step] as const))(
		"%s keeps its answer",
		async (label, step) => {
			const ids = await seedIds();
			const token = step.token ? await undoToken(ids) : "";
			const before = await stateHash();
			let line: string;

			try {
				const { res, html } = await run(step, ids, token);

				line = await recordLine(res, html);
			} catch (error) {
				line = `threw ${error instanceof Error ? error.name : "value"}`;
			}

			if (INTENDED(step)) {
				// The padded id is a missing transaction: a 404 and no row changed (the GET changes nothing either).
				expect(line.split(" | ")[0]).toBe("404");
				expect(await stateHash()).toBe(before);

				return;
			}

			const recorded: Record<string, string> = baseline;

			expect(line).toBe(recorded[label]);
		},
	);

	// The intended difference, on its own: a padded address id reached a real cash entry and deleted it before the edge.
	it("a padded cash id answers 404 and keeps the entry (intended difference, #1006)", async () => {
		const ids = await seedIds();

		const padded = await run(
			{
				label: "padded",
				method: "POST",
				path: "/transactions/00$CASH/delete",
				form: [
					["confirm", "1"],
					["back", LIST],
				],
			},
			ids,
			"",
		);

		expect(padded.res.status).toBe(404);

		const kept = await db
			.prepare("SELECT id FROM transactions WHERE id=?")
			.bind(ids.cash)
			.first<{ id: number }>();

		expect(kept?.id).toBe(ids.cash);
	});

	it("a padded purchase id on the edit panel answers 404 (intended difference, #1006)", async () => {
		const ids = await seedIds();

		const padded = await run(
			{ label: "padded", method: "GET", path: "/transactions/0$ID" },
			ids,
			"",
		);

		expect(padded.res.status).toBe(404);
	});

	it("an unpadded id on the edit panel still opens the row", async () => {
		const ids = await seedIds();

		const open = await run(
			{ label: "plain", method: "GET", path: "/transactions/$ID" },
			ids,
			"",
		);

		expect(open.res.status).toBe(200);
	});
});
