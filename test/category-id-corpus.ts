import { env, exports } from "cloudflare:workers";
import { resetDemo } from "../src/demo/reset";
import { pinClock } from "./pinned-clock";

// Every route that reads a category id with CategoryId (#1111). Each case posts or gets one input a browser can send,
// on a freshly reset demo, and records what comes back: the status, the Location, the HX-* headers, the autofocus count,
// a hash of the page, and a hash of every table after the answer. The lines in fixtures/category-id-baseline.json were
// recorded on the code before the change (only the old code's answers are in it). After the change the rows whose value
// Number accepted and CategoryId now refuses are the only ones that differ, and each equals that route's refused answer.

const db = env.DB;
const BASE = "http://tally.test";
const ABSENT = "<absent>";
const FILE = "<file>";
const MISSING_ROW = 999999;

// The demo's day and the clock are fixed, so the seeded rows and the pages that show dates are the same on every run.
const DEMO_DAY = "2026-10-15";
const CLOCK = "2026-10-15T12:00:00Z";
const FILE_TEXT = "x";
const AUDIBLE = "AUDIBLE*TE3E10I7 WA";
const VENMO_ROW = "NETFLIX.COM";

export type Value = string | typeof FILE | typeof ABSENT;

/** One input's name and text. The text is filled from the category the case names. */
export const VALUE_NAMES = [
	"canonical",
	"zero-led",
	"space",
	"plus",
	"point-zero",
	"exponent",
	"hex",
	"zero",
	"negative",
	"words",
	"empty",
	"sixteen",
	"big",
	"file",
	"missing",
] as const;

export type ValueName = (typeof VALUE_NAMES)[number];

/** The text one input name stands for, given a real category id. */
export function inputText(name: ValueName, id: number): Value {
	switch (name) {
		case "canonical":
			return String(id);
		case "zero-led":
			return `0${id}`;
		case "space":
			return ` ${id}`;
		case "plus":
			return `+${id}`;
		case "point-zero":
			return `${id}.0`;
		case "exponent":
			return "1e0";
		case "hex":
			return "0x2";
		case "zero":
			return "0";
		case "negative":
			return "-1";
		case "words":
			return "abc";
		case "empty":
			return "";
		case "sixteen":
			return "1234567890123456";
		case "big":
			return "99999999999999999999";
		case "file":
			return FILE;
		case "missing":
			return ABSENT;
	}
}

/** An address value a route reads: the same texts, with no file or missing field (an address is never a file). */
const PATH_VALUE_NAMES = VALUE_NAMES.filter(
	(name) => name !== "file" && name !== "missing",
);

export type Req = {
	/** The caller and the value, as the fixture keys it. */
	label: string;
	method: "GET" | "POST";
	path: string;
	hx: boolean;
	query?: [string, string][];
	form?: [string, Value][];
	/** Seeds the state the request reads before it is sent. */
	prep?: "none" | "learned" | "organize" | "suggest";
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

type Row = Record<string, string | number | null>;

/** Every table's rows without their timestamps, hashed. */
async function stateOf(): Promise<string> {
	const { results: tables } = await db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
		)
		.all<{ name: string }>();

	let text = "";

	for (const { name } of tables) {
		const { results } = await db
			.prepare(`SELECT * FROM "${name}" ORDER BY rowid`)
			.all<Row>();

		for (const row of results) {
			const kept = Object.fromEntries(
				Object.entries(row).filter(([key]) => !key.endsWith("_at")),
			);

			const json = plain(JSON.stringify(kept)).replace(
				/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g,
				"TS",
			);

			text += `${name} ${json}\n`;
		}
	}

	return sha(text);
}

/** The demo, with the two categories the cases file rows under (the default list has them, the demo does not). */
async function reset(): Promise<void> {
	await resetDemo(db, DEMO_DAY);
	await db.batch([
		db.prepare(
			"INSERT OR IGNORE INTO categories (name, name_key, icon, color, sort_order) VALUES ('Entertainment', 'entertainment', 'entertainment', 'cat-blue', 90)",
		),
		db.prepare(
			"INSERT OR IGNORE INTO categories (name, name_key, icon, color, sort_order) VALUES ('Books & audio', 'books & audio', 'books', 'cat-plum', 95)",
		),
	]);
}

const first = async (sql: string) =>
	(await db.prepare(sql).first<{ id: number }>())?.id ?? 0;

/** The ids the cases write from: a live category, the one a suggestion files, and an archived one. */
async function idsOf() {
	return {
		live: await first(
			"SELECT id AS id FROM categories WHERE archived=0 AND name='Books & audio'",
		),
		eating: await first(
			"SELECT id AS id FROM categories WHERE name='Eating Out'",
		),
		entertainment: await first(
			"SELECT id AS id FROM categories WHERE name='Entertainment'",
		),
	};
}

/** Seeds the state a prep names, on top of a reset demo. */
async function prepare(prep: Req["prep"]): Promise<void> {
	const ids = await idsOf();

	if (prep === "learned") {
		// Two charges the person sorted by hand, so the learned line for "NETFLIX.COM" exists (as learned-page.test.ts seeds it).
		for (const date of ["2026-10-02", "2026-10-03"])
			await db
				.prepare(
					`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, category_id, category_source)
					VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), ?, 1499, ?, ?, 'user')`,
				)
				.bind(
					`plaid-${crypto.randomUUID()}`,
					date,
					VENMO_ROW,
					ids.entertainment,
				)
				.run();
	}

	if (prep === "organize") {
		// The bakery's charge has no category, so the organize page offers its group (as organize-route.test.ts seeds it).
		await db
			.prepare(
				"UPDATE transactions SET category_id = NULL, category_source = NULL WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
			)
			.run();
	}

	if (prep === "suggest") {
		// A charge the Jev guess would file under Eating Out, not yet answered: the card's category row is its question.
		await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name,
					category_confidence, jev_category_id)
				VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', 1499, ?, 0.58, ?)`,
			)
			.bind(`plaid-${crypto.randomUUID()}`, AUDIBLE, ids.eating)
			.run();
	}
}

/** The question a suggestion case answers: the one charge seeded for it, by its id. */
async function suggestionId(): Promise<string> {
	const id = await first(
		`SELECT id AS id FROM transactions WHERE raw_name = '${AUDIBLE}' ORDER BY id DESC LIMIT 1`,
	);

	return `category-${id}`;
}

/** The line for a response: as the other characterisation corpora write it. */
async function lineOf(res: Response): Promise<string> {
	const html = await res.text();

	const hx = [...res.headers.entries()]
		.filter(([name]) => name.startsWith("hx-"))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `${name}=${plain(value)}`);

	return [
		res.status,
		res.headers.get("location") ?? "-",
		...hx,
		`autofocus ${html.split("autofocus").length - 1}`,
		`body ${await sha(plain(html))}`,
		`state ${await stateOf()}`,
	].join(" | ");
}

/** Runs one case on a freshly reset demo and returns its line. */
export async function runCase(req: Req): Promise<string> {
	pinClock(CLOCK);
	await reset();
	await prepare(req.prep);

	// The suggestion cases name their question by the charge the prep seeds, so its id is read after the seed.
	const form: [string, Value][] = [];

	for (const [key, value] of req.form ?? []) {
		const posted: Value =
			key === "id" && value === "<question>" ? await suggestionId() : value;

		form.push([key, posted]);
	}

	const headers = new Headers();

	if (req.hx) {
		headers.set("HX-Request", "true");
		headers.set("HX-Current-URL", `${BASE}/settings/suggestions`);
	}

	const query = new URLSearchParams(req.query ?? []);
	const url = `${BASE}${req.path}${query.size ? `?${query}` : ""}`;

	if (req.method === "GET") {
		return lineOf(await exports.default.fetch(url, { headers }));
	}

	headers.set("Origin", BASE);
	const body = new FormData();

	for (const [key, value] of form) {
		if (value === ABSENT) continue;

		body.append(
			key,
			value === FILE
				? new File([FILE_TEXT], "x.txt", { type: "text/plain" })
				: value,
		);
	}

	return lineOf(
		await exports.default.fetch(url, { method: "POST", headers, body }),
	);
}

/** Every case, in the order the fixture lists them. Ids come from the seeded demo, so they are read after the reset. */
export async function cases(): Promise<Req[]> {
	pinClock(CLOCK);
	await reset();
	const ids = await idsOf();
	const out: Req[] = [];

	// The address values, then a category row that no category has (the answer a refused id is compared with).
	const pathValues = (id: number): [string, string][] => [
		...PATH_VALUE_NAMES.map((name): [string, string] => [
			name,
			String(inputText(name, id)),
		]),
		["missing-row", String(MISSING_ROW)],
	];

	// The budget sheet's address (home.tsx activeCategory), its save and its nudge.
	for (const [name, text] of pathValues(ids.live))
		for (const hx of [false, true]) {
			out.push({
				label: `budget GET id=${name} hx=${hx}`,
				method: "GET",
				path: `/budget/${encodeURIComponent(text)}`,
				hx,
			});
			out.push({
				label: `budget POST id=${name} hx=${hx}`,
				method: "POST",
				path: `/budget/${encodeURIComponent(text)}`,
				hx,
				form: [["budget", "700"]],
			});
			out.push({
				label: `budget nudge id=${name} hx=${hx}`,
				method: "POST",
				path: `/budget/${encodeURIComponent(text)}/nudge/up`,
				hx,
			});
		}

	// The organize page's category (organize.tsx): a refused one is no category, and the page says so.
	for (const name of VALUE_NAMES) {
		const text = inputText(name, ids.live);

		for (const hx of [false, true])
			out.push({
				label: `organize category=${name} hx=${hx}`,
				method: "POST",
				path: "/transactions/organize",
				hx,
				prep: "organize",
				form: [
					["category", text],
					["name", "The Bakery"],
					["group", "Local Bakery"],
					["raw_name", "SQ *LOCAL BAKERY 4432"],
				],
			});
	}

	// The learned line's change (settings.tsx /settings/learned/change), the category a learned line takes.
	for (const name of VALUE_NAMES) {
		const text = inputText(name, ids.live);

		for (const hx of [false, true])
			out.push({
				label: `learned change category=${name} hx=${hx}`,
				method: "POST",
				path: "/settings/learned/change",
				hx,
				prep: "learned",
				form: [
					["text", "netflix.com"],
					["category", text],
				],
			});
	}

	// The categories page reads ?open= and ?focus= (settings.tsx numberParam).
	for (const key of ["open", "focus"] as const)
		for (const name of PATH_VALUE_NAMES)
			for (const hx of [false, true])
				out.push({
					label: `categories ${key}=${name} hx=${hx}`,
					method: "GET",
					path: "/settings/categories",
					hx,
					query: [[key, String(inputText(name, ids.live))]],
				});

	for (const hx of [false, true])
		out.push({
			label: `categories no query hx=${hx}`,
			method: "GET",
			path: "/settings/categories",
			hx,
		});

	// The category routes that take the id from the address: rename (with a valid name and with a blank one, which
	// shows the retry page), archive, restore and move up and down.
	for (const [name, text] of pathValues(ids.live)) {
		const at = `/settings/categories/${encodeURIComponent(text)}`;

		for (const hx of [false, true]) {
			out.push({
				label: `rename id=${name} name=new hx=${hx}`,
				method: "POST",
				path: at,
				hx,
				form: [["name", "Renamed Cat"]],
			});
			out.push({
				label: `rename id=${name} name=blank hx=${hx}`,
				method: "POST",
				path: at,
				hx,
				form: [["name", ""]],
			});
			out.push({
				label: `archive id=${name} hx=${hx}`,
				method: "POST",
				path: `${at}/archive`,
				hx,
			});
			out.push({
				label: `restore id=${name} hx=${hx}`,
				method: "POST",
				path: `${at}/restore`,
				hx,
			});
			out.push({
				label: `move up id=${name} hx=${hx}`,
				method: "POST",
				path: `${at}/move/up`,
				hx,
			});
			out.push({
				label: `move down id=${name} hx=${hx}`,
				method: "POST",
				path: `${at}/move/down`,
				hx,
			});
		}
	}

	// The suggestion card's create tap and its else branch, which read the category as CategoryId does (suggestions.tsx).
	for (const name of VALUE_NAMES) {
		const text = inputText(name, ids.live);

		for (const hx of [false, true]) {
			out.push({
				label: `suggestion create category=${name} hx=${hx}`,
				method: "POST",
				path: "/settings/suggestions",
				hx,
				prep: "suggest",
				form: [
					["id", "<question>"],
					["answer", "create"],
					["category", text],
				],
			});
			out.push({
				label: `suggestion else category=${name} hx=${hx}`,
				method: "POST",
				path: "/settings/suggestions",
				hx,
				prep: "suggest",
				form: [
					["id", "<question>"],
					["answer", "else"],
					["category", text],
				],
			});
		}
	}

	return out;
}
