import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAppleCsv } from "../src/apple-card/csv";
import { leftOut, rowKey } from "../src/apple-card/plan";
import { DEFAULT_TIME_ZONE, daysBefore, todayIn } from "../src/dates";
import { accountsWithHistory } from "../src/db/balance-history";
import { appleCardSample } from "../src/demo/apple-card-sample";
import { resetDemo } from "../src/demo/reset";
import { accounts } from "../src/routes/accounts";
import { recordSorting } from "./record-sorting";

recordSorting({ sort: true });

// The demo's Apple Card sample (spec §8.10, #766): made-up rows in Apple's layout, dated from the seeded bank's latest
// transaction, added by the demo's Add the sample. The demo never reads a file; its body is never read.
const TODAY = todayIn(DEFAULT_TIME_ZONE);
const demo = { ...env, DEMO: "true" } as unknown as Env;
const ANCHOR_SQL =
	"SELECT MAX(t.date) AS d FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.plaid_item_id IS NOT NULL";

const app = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
app.use("*", async (c, next) => {
	c.set("actor", "demo");
	await next();
});
app.route("/", accounts);

const ctx = () => ({
	waitUntil: vi.fn<(promise: Promise<unknown>) => void>(() => {}),
	passThroughOnException() {},
	props: {},
});

async function anchor() {
	return (await env.DB.prepare(ANCHOR_SQL).first<{ d: string }>())?.d ?? "";
}

async function addSample(htmx = true) {
	const headers: Record<string, string> = {};
	if (htmx) headers["HX-Request"] = "true";
	const res = await app.request(
		"/accounts/apple-card",
		{ method: "POST", headers },
		demo,
		ctx(),
	);
	return { res, text: await res.text() };
}

const cardRows = () =>
	env.DB.prepare(
		"SELECT COUNT(*) AS n, SUM(excluded) AS excluded FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.subtype = 'apple_card'",
	).first<{ n: number; excluded: number }>();

describe("the demo's Apple Card sample (#766)", () => {
	beforeEach(() => resetDemo(env.DB, TODAY));

	it("reads as Apple's file, and holds every kind the spec lists", async () => {
		const read = parseAppleCsv(appleCardSample("2026-09-22"));
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		const rows = read.rows;
		expect(rows.length).toBeGreaterThanOrEqual(12);
		expect(rows.length).toBeLessThanOrEqual(16);
		const types = new Set(rows.map((row) => row.type));
		expect([...types].sort()).toEqual([
			"Credit",
			"Interest",
			"Other",
			"Payment",
			"Purchase",
		]);
		// A bounced payment is the one Other row that says REVERSAL and takes money out; the payment is the Payment row.
		expect(
			rows
				.filter((row) => leftOut(row))
				.map((row) => row.type)
				.sort(),
		).toEqual(["Other", "Payment"]);
		expect(rows.some((row) => row.clearingDate === null)).toBe(true);
		const keys = rows.map((row) => rowKey(row));
		expect(new Set(keys).size).toBeLessThan(keys.length);
	});

	it("dates every row within the 60 days before the anchor, so each cleared row is on or after Tally's history", async () => {
		const day = "2026-09-22";
		const read = parseAppleCsv(appleCardSample(day));
		if (!read.ok) throw new Error("the sample must read");
		for (const row of read.rows) {
			expect(
				row.transactionDate >= daysBefore(day, 60) &&
					row.transactionDate <= day,
			).toBe(true);
			if (row.clearingDate !== null)
				expect(row.clearingDate >= daysBefore(day, 60)).toBe(true);
		}
	});

	it("adds every cleared row on a fresh demo, and leaves out the payment and its reversal", async () => {
		const { res, text } = await addSample();
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toContain(
			"Added 13 from Apple Card. 1 hasn't cleared yet.",
		);
		expect(text).toContain("Apple Card");
		expect(await cardRows()).toEqual({ n: 13, excluded: 2 });
	});

	it("says Nothing new when Add the sample is pressed again, and never adds rows dated later", async () => {
		await addSample();
		const { res } = await addSample();
		expect(res.headers.get("HX-Trigger")).toContain("Nothing new.");
		expect(await cardRows()).toEqual({ n: 13, excluded: 2 });
	});

	it("reads no body and needs no Content-Length: a demo POST with any body succeeds", async () => {
		const res = await app.request(
			"/accounts/apple-card",
			{
				method: "POST",
				headers: { "content-type": "multipart/form-data; boundary=zzz" },
				body: "not a form at all",
			},
			demo,
			ctx(),
		);
		expect(res.status).not.toBe(422);
		expect(res.status).not.toBe(413);
		expect(await cardRows()).toEqual({ n: 13, excluded: 2 });
	});

	it("is same-origin: a demo POST with Origin passes, and one without it is refused", async () => {
		const withOrigin = await exports.default.fetch(
			"http://tally.test/accounts/apple-card",
			{
				method: "POST",
				headers: { Origin: "http://tally.test", "HX-Request": "true" },
			},
		);
		expect(withOrigin.status).toBe(200);
		const withoutOrigin = await exports.default.fetch(
			"http://tally.test/accounts/apple-card",
			{
				method: "POST",
				headers: { "content-type": "multipart/form-data; boundary=zzz" },
				body: "x",
			},
		);
		expect(withoutOrigin.status).toBe(403);
	});

	it("draws the demo's sheet with no file or balance field, and its submit adds the sample", async () => {
		const html = (
			await (
				await app.request(
					"/accounts/apple-card",
					{ headers: { "HX-Request": "true" } },
					demo,
				)
			).text()
		).replaceAll("&#39;", "'");
		expect(html).toContain("In the demo, Tally uses a sample file.");
		expect(html).toContain("Add the sample");
		expect(html).not.toContain('id="apple-card-file"');
		expect(html).not.toContain('id="apple-card-balance"');
	});

	it("gives the demo's card its months: its balance counts on the anchor, and the line starts at the earliest seed balance", async () => {
		await addSample();
		const card = await env.DB.prepare(
			"SELECT balance_cents, balance_on, counted_from FROM accounts WHERE subtype = 'apple_card'",
		).first<{
			balance_cents: number;
			balance_on: string;
			counted_from: string;
		}>();
		expect(card?.balance_cents).toBe(124018);
		expect(card?.balance_on).toBe(await anchor());
		const earliest = await env.DB.prepare(
			"SELECT MIN(h.date) AS d FROM balance_history h JOIN accounts a ON a.id = h.account_id WHERE a.plaid_item_id IS NOT NULL",
		).first<{ d: string }>();
		expect(card?.counted_from).toBe(earliest?.d);
		const { points, appleCard } = await accountsWithHistory(env.DB, TODAY);
		expect(appleCard?.balanceOn).toBe(await anchor());
		expect(points[0]?.date).toBe(card?.counted_from);
	});

	it("leaves no Apple Card account after the nightly reset", async () => {
		await addSample();
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM accounts WHERE subtype = 'apple_card'",
			).first<{ n: number }>(),
		).toEqual({ n: 1 });
		await resetDemo(env.DB, TODAY);
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM accounts WHERE subtype = 'apple_card'",
			).first<{ n: number }>(),
		).toEqual({ n: 0 });
	});
});
