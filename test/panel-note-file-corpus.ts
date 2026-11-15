import { env, exports } from "cloudflare:workers";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { pinClock } from "./pinned-clock";

// The edit panel's note when a file part is posted in it (after #1109). A browser never sends a file for the note, but a
// crafted post can, and the save used to store "[object File]" as the note. Each case posts the panel to a freshly seeded
// demo, a purchase that has a saved note or none (or a cash entry split into two parts, for the Change the parts sheet),
// and records the answer: the status, the type, the Location, the HX headers, a hash of the page, the notes as they stand
// after, and a hash of every row. The lines in fixtures/panel-note-file-baseline.json were recorded on the code before the
// change. After the change only the rows with a file in `note` or `note_was` differ, and each of those must end with the
// saved note unchanged and equal its twin: the same post with `note` set to the saved note (a row the change does not touch).

const db = env.DB;
const BASE = "http://tally.test";
const ABSENT = "<absent>";
const FILE = "<file>";
const SAVED = "<saved>";
const LIST = "/transactions?month=all";
const SAVED_TEXT = "Saved note";
const BAD_CATEGORY = "abc";

type Value = string | typeof FILE | typeof ABSENT | typeof SAVED;

type Form = [string, Value][];

export type Step = {
	label: string;
	/** The route the panel is posted to: the purchase, or the cash entry for the Change the parts sheet. */
	path: string;
	form: Form;
	hx: boolean;
	/** Whether the purchase has a saved note before the post. */
	stored: boolean;
	/** The Change the parts sheet: the panel posts change_parts, then the sheet's save replays its pending edit. */
	replay: boolean;
	/** True when a file is posted in `note` or `note_was`. */
	file: boolean;
	/** The label of the twin row (the same post with the saved note in `note`), for a file row. */
	sibling?: string;
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

/** The rows a case is written from: a purchase (id), and a cash entry split into two parts. */
type Ids = {
	id: number;
	cash: number;
	cat: number;
	arch: number;
	partA: number;
	partB: number;
};

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
		cash,
		cat,
		arch,
		partA: parts.results[0]?.id ?? 0,
		partB: parts.results[1]?.id ?? 0,
	};
}

/** Puts a case's row numbers into its text. */
function fill(text: string, ids: Ids): string {
	return text
		.replaceAll("$PARTA", String(ids.partA))
		.replaceAll("$PARTB", String(ids.partB))
		.replaceAll("$CASH", String(ids.cash))
		.replaceAll("$ID", String(ids.id))
		.replaceAll("$CAT", String(ids.cat))
		.replaceAll("$ARCH", String(ids.arch));
}

const file = () => new File(["x"], "x.txt", { type: "text/plain" });

/** A posted text: the saved note's text, or "" when the purchase has no note (a browser posts the empty box). */
const textOfNote = (value: string | typeof SAVED, stored: boolean) =>
	value === SAVED ? (stored ? SAVED_TEXT : "") : value;

/** One POST, as a browser or a crafted request sends it. Returns the response and the page text. */
async function post(
	path: string,
	entries: Form,
	ids: Ids,
	stored: boolean,
	hx: boolean,
	extra: [string, string][] = [],
) {
	const headers = new Headers();

	if (hx) headers.set("HX-Request", "true");
	headers.set("Origin", BASE);

	const body = new FormData();

	for (const [key, value] of entries) {
		if (value === ABSENT) continue;

		if (value === FILE) body.append(key, file());
		else body.append(key, fill(textOfNote(value, stored), ids));
	}

	for (const [key, value] of extra) body.append(key, value);

	const res = await exports.default.fetch(`${BASE}${fill(path, ids)}`, {
		method: "POST",
		headers,
		body,
	});

	return { res, html: await res.text() };
}

/** The Change the parts sheet's pending edit, as the sheet carries it back: the HTML-escaped hidden input. */
function pendingOf(html: string): string | null {
	const match = /name="pending_edit" value="([^"]*)"/.exec(html);

	if (!match) return null;

	return match[1]
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

/** One answer as a line: the status, type, Location, the two HX headers and the page's hash. */
async function answerLine(res: Response, html: string) {
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

/** The notes as they stand after a case, so a changed note shows in the line itself. */
async function notesAfter(ids: Ids) {
	const note = async (id: number) =>
		(
			await db
				.prepare("SELECT note FROM transactions WHERE id=?")
				.bind(id)
				.first<{ note: string | null }>()
		)?.note ?? null;

	return `note ${JSON.stringify(await note(ids.id))} cash-note ${JSON.stringify(await note(ids.cash))}`;
}

/** Runs one case on a fresh demo and returns its line: the answers, the notes after, and the rows after. */
export async function recordCase(step: Step) {
	pinClock();
	await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
	const ids = await prepare();

	await db
		.prepare("UPDATE transactions SET note=?, note_state=? WHERE id IN (?, ?)")
		.bind(
			step.stored ? SAVED_TEXT : null,
			step.stored ? "written" : "unasked",
			ids.id,
			ids.cash,
		)
		.run();

	const before = await stateHash();

	try {
		const panel = await post(
			step.path,
			step.form,
			ids,
			step.stored,
			step.hx,
			step.replay ? [["change_parts", "1"]] : [],
		);

		let answer = await answerLine(panel.res, panel.html);

		if (step.replay) {
			const pending = pendingOf(panel.html);

			if (pending === null) {
				answer += " || no sheet";
			} else {
				const split = await post(
					"/transactions/$CASH/split",
					[
						["back", LIST],
						["total", "10000"],
						["amount_was", "9000"],
						["part_id", "$PARTA"],
						["part_id", "$PARTB"],
						["part_category", "$CAT"],
						["part_category", "$ARCH"],
						["part_amount", "60.00"],
						["part_amount", "40.00"],
					],
					ids,
					step.stored,
					step.hx,
					[["pending_edit", pending]],
				);

				answer += ` || ${await answerLine(split.res, split.html)}`;
			}
		}

		const after = await stateHash();

		return `${answer} | ${await notesAfter(ids)} | state ${after}${after === before ? "" : " (rows changed)"}`;
	} catch (error) {
		return `threw ${error instanceof Error ? error.name : "value"}`;
	}
}

// The panel's posted fields, in the order the panel posts them: the category, the name the person picked and the back link.
const EDIT: Form = [
	["category", "$CAT"],
	["name_pick", "own"],
	["merchant", "Corpus name"],
	["back", LIST],
];

/** The same panel with a category that is no category: the panel is drawn again with its fields echoed. */
const EDIT_BAD_CATEGORY: Form = [
	["category", BAD_CATEGORY],
	["name_pick", "own"],
	["merchant", "Corpus name"],
	["back", LIST],
];

const DETAILS: Value[] = [ABSENT, "1", "0"];

/** The panel's form: the base, the extra fields, and the note fields as the case sets them. */
function panelForm(
	base: Form,
	details: Value,
	note: Value,
	noteWas: Value,
	extra: Form = [],
): Form {
	return [
		...base,
		...extra,
		["details_visible", details],
		["note", note],
		["note_was", noteWas],
	];
}

/** A case's label: its shape as the form posts it, so a twin is found by its label. */
function labelOf(stored: boolean, hx: boolean, path: string, form: Form) {
	const fields = form
		.filter(([, value]) => value !== ABSENT)
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join(" ");

	return `stored=${stored ? "yes" : "no"} ${hx ? "htmx" : "plain"} POST ${path} ${fields}`;
}

/** A file in `note_why`'s place is the saved note in the twin; any other `note_was` is kept as it is. */
const twinNoteWas = (noteWas: Value): Value =>
	noteWas === FILE ? SAVED : noteWas;

/** Builds every case: the matrix, the keep answer, the redraw after a refused category, and the split replay. */
function buildSteps(): Step[] {
	const steps: Step[] = [];
	const seen = new Set<string>();

	const add = (step: Omit<Step, "label">, label: string) => {
		if (seen.has(label)) throw new Error(`two proof cases share a label: ${label}`);

		seen.add(label);
		steps.push({ ...step, label });
	};

	const isFile = (value: Value) => value === FILE;

	/** A post and, when a file is in it, the label of its twin: the same post with the saved note. */
	const addPanel = (
		stored: boolean,
		hx: boolean,
		path: string,
		base: Form,
		details: Value,
		note: Value,
		noteWas: Value,
		options: { extra?: Form; replay?: boolean } = {},
	) => {
		const extra = options.extra ?? [];
		const form = panelForm(base, details, note, noteWas, extra);
		const file = isFile(note) || isFile(noteWas);
		const twin = file
			? labelOf(
					stored,
					hx,
					path,
					panelForm(base, details, SAVED, twinNoteWas(noteWas), extra),
				) + (options.replay ? " (then the split save)" : "")
			: undefined;
		const label = labelOf(stored, hx, path, form) + (options.replay ? " (then the split save)" : "");

		add(
			{
				path,
				form,
				hx,
				stored,
				replay: options.replay ?? false,
				file,
				sibling: twin,
			},
			label,
		);
	};

	// The matrix: the stored note x htmx x the details x the note x the note as it was drawn.
	for (const stored of [true, false]) {
		for (const hx of [true, false]) {
			for (const details of DETAILS) {
				for (const note of [FILE, "", ABSENT, "a new note", " spaced ", SAVED] as Value[]) {
					for (const noteWas of [ABSENT, SAVED, "other", FILE] as Value[]) {
						addPanel(stored, hx, "/transactions/$ID", EDIT, details, note, noteWas);
					}
				}
			}
		}
	}

	// "Looks right" (details_action=keep): a file in the note, with the details hidden, shown, or not posted.
	for (const stored of [true, false]) {
		for (const hx of [true, false]) {
			for (const details of DETAILS) {
				for (const note of [FILE, SAVED] as Value[]) {
					for (const noteWas of [ABSENT, SAVED, FILE] as Value[]) {
						addPanel(stored, hx, "/transactions/$ID", EDIT, details, note, noteWas, {
							extra: [["details_action", "keep"]],
						});
					}
				}
			}
		}
	}

	// A refused category: the panel is drawn again with its note echoed, for a file as for a text.
	for (const stored of [true, false]) {
		for (const hx of [true, false]) {
			for (const details of DETAILS) {
				for (const note of [FILE, SAVED, ABSENT, "a new note"] as Value[]) {
					for (const noteWas of [ABSENT, SAVED, FILE] as Value[]) {
						addPanel(stored, hx, "/transactions/$ID", EDIT_BAD_CATEGORY, details, note, noteWas);
					}
				}
			}
		}
	}

	// The Change the parts sheet: the panel is posted with change_parts (its amount breaks the parts), and the sheet's
	// save replays the pending edit. A file in the note must not clear the saved note on the replay either.
	for (const stored of [true, false]) {
		for (const details of DETAILS) {
			for (const note of [FILE, "", ABSENT, SAVED, "a new note"] as Value[]) {
				for (const noteWas of [ABSENT, SAVED, FILE] as Value[]) {
					addPanel(stored, true, "/transactions/$CASH", EDIT, details, note, noteWas, {
						extra: [["amount", "100.00"]],
						replay: true,
					});
				}
			}
		}
	}

	return steps;
}

export const STEPS = buildSteps();
