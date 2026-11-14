import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { setupRoute } from "../src/routes/setup";
import baseline from "./fixtures/route-number-baseline.json";
import { envWith } from "./helpers/doubles";
import { pinClock } from "./pinned-clock";

// The three routes and one helper that read a typed or posted number with Number() (#1105): the category rename's
// invalid-name branch, the bill form's quarter sentence, the home page's focus, and the Your banks list's `in` list.
// Each case records what a browser can send and what comes back: the status, every HX-* header, and a hash of the
// page. The lines in fixtures/route-number-baseline.json were recorded on the code before the change; every answer
// must stay the same.

const db = env.DB;
const BASE = "http://tally.test";
const ABSENT = "<absent>";

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

/** The category ids the cases name: one live category and one archived one (or a number no category has). */
async function seedIds() {
	const first = async (sql: string) =>
		(await db.prepare(sql).first<{ id: number }>())?.id ?? 999;

	return {
		cat: await first(
			"SELECT id FROM categories WHERE archived=0 ORDER BY id LIMIT 1",
		),
		arch: await first(
			"SELECT id FROM categories WHERE archived=1 ORDER BY id LIMIT 1",
		),
	};
}

type Ids = Awaited<ReturnType<typeof seedIds>>;

type Case = {
	label: string;
	method: "GET" | "POST";
	path: string;
	hx: boolean;
	query?: [string, string][];
	form?: [string, string][];
};

/** Fills the cases' category ids into their text; "$ARCH" goes first is not needed, the names differ. */
const fill = (text: string, ids: Ids) =>
	text
		.replaceAll("$ARCH", String(ids.arch))
		.replaceAll("$CAT", String(ids.cat));

/** Runs one case and returns its line: the status, the HX-* headers, the Location and a hash of the page. */
async function line(step: Case, ids: Ids): Promise<string> {
	const headers = new Headers();

	if (step.hx) headers.set("HX-Request", "true");

	const query = (step.query ?? [])
		.filter(([, value]) => value !== ABSENT)
		.map(([key, value]) => [key, fill(value, ids)] as const);

	const url = `${BASE}${fill(step.path, ids)}${query.length ? `?${new URLSearchParams(query)}` : ""}`;

	let res: Response;

	if (step.method === "GET") {
		res = await exports.default.fetch(url, { headers });
	} else {
		headers.set("Origin", BASE);

		const body = new URLSearchParams(
			(step.form ?? [])
				.filter(([, value]) => value !== ABSENT)
				.map(([key, value]) => [key, fill(value, ids)]),
		);

		res = await exports.default.fetch(url, {
			method: "POST",
			headers,
			body,
		});
	}

	return lineOf(res, await res.text());
}

/** A readable name for the case, so the fixture's keys say what was posted. */
const q = (pairs: [string, string][] | undefined) =>
	(pairs ?? [])
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join(" ");

const cases = (): Case[] => {
	const renameNames = ["", "   "];
	const renameIds = ["$CAT", "0$CAT", "00$CAT", "$ARCH", "999999"];

	const quarterMonths = [
		"5",
		"05",
		"5.0",
		"1e1",
		"abc",
		"",
		"13",
		"0",
		"-3",
		"Infinity",
		"1.5",
		" 5",
		"1e0",
		"0x10",
		"12",
		"1",
	];

	const focusValues = [
		"7",
		"007",
		" 7",
		"1e1",
		"abc",
		"0",
		"-1",
		"1.5",
		"",
		"$CAT",
		"$ARCH",
		"savings-goal",
		ABSENT,
	];

	const rename = renameIds.flatMap((id) =>
		renameNames.flatMap((name) =>
			[true, false].map(
				(hx): Case => ({
					label: `settings rename id=${id} name=${JSON.stringify(name)} hx=${hx}`,
					method: "POST",
					path: `/settings/categories/${id}`,
					hx,
					form: [["name", name]],
				}),
			),
		),
	);

	const bills = quarterMonths.map(
		(month): Case => ({
			label: `bills quarter anchor_month=${JSON.stringify(month)}`,
			method: "POST",
			path: "/bills",
			hx: false,
			form: [
				["name", ""],
				["amount", "10"],
				["due_day", "5"],
				["frequency", "quarterly"],
				["anchor_month", month],
				["merchant_raw_name", "COFFEE SHOP"],
				["category_id", "$CAT"],
			],
		}),
	);

	const home = focusValues.flatMap((focus) =>
		[false, true].map((hx): Case => {
			const query: [string, string][] =
				focus === ABSENT ? [] : [["focus", focus]];

			return {
				label: `home ${q(query) || "no query"} hx=${hx}`,
				method: "GET",
				path: "/",
				hx,
				query,
			};
		}),
	);

	return [...rename, ...bills, ...home];
};

const IN_VALUES = [
	"902",
	"0902",
	" 902",
	"902,5",
	"3,5",
	"3,,x",
	"99999999999999999999",
	"1e3",
	"0",
	"007",
	"",
	ABSENT,
];

/** A bank that has come in, with one transaction: the Solo Card the Your banks test seeds. */
async function seedArrivedBank() {
	await db.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
	await db
		.prepare(
			"INSERT INTO plaid_items (id, access_token_encrypted, institution_name, linked_by, history_complete_at) VALUES (902, X'', 'Solo Card', 'test', datetime('now'))",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO accounts (id, plaid_item_id, name, mask, type, subtype, is_liability, balance_cents) VALUES (990, 902, 'Card', '0000', 'credit', 'credit card', 1, 0)",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id) VALUES (990, '2026-10-01', 500, 'SHOP', 'solo-card-1')",
		)
		.run();
}

/** The line for a response: as line() writes it. */
async function lineOf(res: Response, html: string): Promise<string> {
	const hx = [...res.headers.entries()]
		.filter(([name]) => name.startsWith("hx-"))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `${name}=${plain(value)}`);

	const autofocus = html.split("autofocus").length - 1;

	return [
		res.status,
		res.headers.get("content-type") ?? "-",
		res.headers.get("location") ?? "-",
		...hx,
		`autofocus ${autofocus}`,
		`body ${await sha(plain(html))}`,
	].join(" | ");
}

beforeEach(async () => {
	pinClock();
	await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("routes that read a typed number at the edge (#1105)", () => {
	it("answers every recorded case the same as before the edge", async () => {
		const ids = await seedIds();
		const problems: string[] = [];
		const expected: Record<string, string> = baseline;

		const check = (label: string, got: string) => {
			const want = expected[label];

			if (want !== got)
				problems.push(`${label}\n  want ${want}\n  got  ${got}`);
		};

		for (const step of cases()) check(step.label, await line(step, ids));

		// Your banks: one bank has come in (as the Solo Card test seeds it), so ?in= decides whether it is announced.
		await seedArrivedBank();

		for (const value of IN_VALUES) {
			const query = value === ABSENT ? "" : `?in=${encodeURIComponent(value)}`;

			const res = await setupRoute.request(
				`/setup/banks${query}`,
				{ headers: { "HX-Request": "true" } },
				envWith(env, { DEMO: "false" }),
			);

			const html = await res.text();

			check(`setup banks in=${JSON.stringify(value)}`, await lineOf(res, html));
		}

		expect(problems).toEqual([]);
	});
});

/** The quarter sentence the bill form shows for a first-month text, read from a re-drawn form (a name left blank). */
async function quarterSentence(anchor: string): Promise<string> {
	const res = await exports.default.fetch(`${BASE}/bills`, {
		method: "POST",
		headers: { Origin: BASE },
		body: new URLSearchParams([
			["name", ""],
			["amount", "10"],
			["due_day", "5"],
			["frequency", "quarterly"],
			["anchor_month", anchor],
			["merchant_raw_name", "COFFEE SHOP"],
			["category_id", String((await seedIds()).cat)],
		]),
	});

	const html = await res.text();

	return html.match(/bill-quarter-hint[^>]*>([^<]*)</)?.[1] ?? "<no hint>";
}

describe("the bill form's quarter sentence (#1105)", () => {
	it("names the four months from the first month read as Number reads it", async () => {
		const words: [string, string][] = [
			["5", "Then every 3 months: May, August, November and February."],
			["1e1", "Then every 3 months: October, January, April and July."],
			["abc", "Then every 3 months: January, April, July and October."],
			["13", "Then every 3 months: December, March, June and September."],
		];

		for (const [anchor, sentence] of words)
			expect(await quarterSentence(anchor)).toBe(sentence);
	});
});
