import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, daysBefore, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { accounts } from "../src/routes/accounts";
import { envWith } from "./helpers/doubles";

// The balance typed on the Apple Card upload sheet is read at the edge (#1006, plan 4). These pin the accepted and the
// refused sets, and the page's echo of the typed text, which must not change.

const TODAY = todayIn(DEFAULT_TIME_ZONE);
const family = envWith(env, { DEMO: "false" });

const BAD_BALANCE =
	"Enter the balance as dollars, like 1,240.18, or with a minus for a credit.";

const HEADER =
	"Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD)";

/** Apple's MM/DD/YYYY for a YYYY-MM-DD day. */
const apple = (day: string) =>
	`${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`;

const ROW_A = `${apple(daysBefore(TODAY, 11))},${apple(daysBefore(TODAY, 10))},"GREENLEAF MARKET #12 100 MAIN ST SPRINGFIELD 00000 XX USA","Greenleaf Market #12","Grocery","Purchase","38.40"`;
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

const app = new Hono<{ Bindings: Env; Variables: { actor: string } }>();

app.use("*", async (c, next) => {
	c.set("actor", "family@example.com");
	await next();
});

app.route("/", accounts);

function file(text: string, name = "apple.csv") {
	return new File([text], name, { type: "text/csv" });
}

/** A multipart upload with the given fields, sent as a browser sends it, with the htmx header. */
async function post(fields: Record<string, string | File>) {
	const form = new FormData();

	for (const [name, value] of Object.entries(fields)) form.set(name, value);

	const request = new Request("http://tally.test/accounts/apple-card", {
		method: "POST",
		body: form,
	});

	const body = await request.arrayBuffer();

	const headers = new Headers({
		"content-type": request.headers.get("content-type") ?? "",
		"content-length": String(body.byteLength),
		"HX-Request": "true",
	});

	const res = await app.request(
		"/accounts/apple-card",
		{ method: "POST", headers, body },
		family,
		{ waitUntil() {}, passThroughOnException() {}, props: {} },
	);

	return { res, html: (await res.text()).replaceAll("&#39;", "'") };
}

/** The card's stored balance: its cents, and the day it was typed (null when no balance was typed). */
const cardAccount = () =>
	env.DB.prepare(
		"SELECT balance_cents, balance_on FROM accounts WHERE subtype = 'apple_card'",
	).first<{ balance_cents: number; balance_on: string | null }>();

const cardRows = () =>
	env.DB.prepare(
		"SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.subtype = 'apple_card'",
	).first<{ n: number }>();

beforeEach(async () => {
	await resetDemo(env.DB, TODAY);
});

describe("the balance an upload types, read at the edge (#1006, plan 4)", () => {
	it.each([
		["blank", ""],
		["spaces only", "  "],
		["a dollar amount with commas", "1,240.18"],
		["a credit with a minus", "-5"],
		["a dollar sign", "$5"],
		["spaces around the amount", " 5 "],
		["a dollar sign after the minus", "-$5"],
		["zero", "0"],
		["negative zero", "-0"],
		["the largest balance", "100000000"],
		["the smallest balance", "-100000000"],
		["a million with commas", "1,000,000"],
	])("accepts %s, and saves the upload", async (_label, balance) => {
		const { res } = await post({ file: file(csv(ROW_A)), balance });

		expect(res.status).toBe(200);
		expect(await cardRows()).toEqual({ n: 1 });
	});

	it("saves a blank balance as no balance: no day is recorded", async () => {
		await post({ file: file(csv(ROW_A)), balance: "" });

		expect((await cardAccount())?.balance_on ?? null).toBeNull();
	});

	it.each([
		["1,240.18", "1,240.18", 124018],
		["-5", "-5", -500],
		["$5", "$5", 500],
		[" 5 ", " 5 ", 500],
		["-$5", "-$5", -500],
		["zero", "0", 0],
		["negative zero", "-0", 0],
		["the largest balance", "100000000", 10_000_000_000],
		["the smallest balance", "-100000000", -10_000_000_000],
		["a million with commas", "1,000,000", 100_000_000],
	])("saves %s as %s cents", async (_label, balance, cents) => {
		await post({ file: file(csv(ROW_A)), balance });

		expect((await cardAccount())?.balance_cents).toBe(cents);
	});

	it.each([
		["a minus with a space", "- 5"],
		["an exponent", "1e3"],
		["a minus after the dollar sign", "$-5"],
		["three decimal places", "0.001"],
		["a cent-and-a-tenth", "1240.123"],
		["a plus sign", "+5"],
		["a trailing point", "5."],
		["NaN", "NaN"],
		["Infinity", "Infinity"],
		["a comma in the wrong place", "1,24"],
		["a comma after a minus", "-,100"],
		["an underscore", "1_000"],
		["twenty digits", "12345678901234567890"],
		["a cent over the largest balance", "100000000.01"],
		["a cent under the smallest balance", "-100000000.01"],
	])(
		"refuses %s under the balance, and saves nothing",
		async (_label, balance) => {
			const { res, html } = await post({ file: file(csv(ROW_A)), balance });

			expect(res.status).toBe(422);
			expect(html).toContain(BAD_BALANCE);
			expect(html).toMatch(/<input [^>]*id="apple-card-balance"[^>]*autofocus/);
			expect(await cardRows()).toEqual({ n: 0 });
			expect(await cardAccount()).toBeFalsy();
		},
	);

	it("echoes the typed balance unchanged on a refusal, untrimmed", async () => {
		const { html } = await post({ file: file(csv(ROW_A)), balance: " 1e3 " });

		expect(html).toContain('value=" 1e3 "');
	});

	it("reads a balance that is a file part as no balance, and saves the upload", async () => {
		const { res } = await post({
			file: file(csv(ROW_A)),
			balance: file("12", "balance.txt"),
		});

		expect(res.status).toBe(200);
		expect(await cardRows()).toEqual({ n: 1 });
		expect((await cardAccount())?.balance_on ?? null).toBeNull();
	});

	it("shows the balance's error with the file's error, and saves nothing", async () => {
		const { html } = await post({
			file: file("not an apple card file"),
			balance: "1e3",
		});

		expect(html).toContain(BAD_BALANCE);
		expect(await cardRows()).toEqual({ n: 0 });
	});
});
