import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import { namesToReview, settleSuggestion } from "../src/db/merchant-names";
import { resetDemo } from "../src/demo/reset";

// The Settings review of suggested merchant names (P29 A, decision 64, #33): a Band on Settings leads
// to one merchant at a time, like Organize. A person chooses a suggestion, keeps the bank's name, or
// types their own, or skips; nothing renames itself.

const db = env.DB;
const BASE = "http://tally.test";
const BLUE = "SQ *BLUE BOTTLE COF 0412";
const LUPITA = "SQ *LUPITAS TAQ 2210";

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}
async function post(
	path: string,
	fields: Record<string, string>,
	htmx = false,
) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			...(htmx ? { "HX-Request": "true" } : {}),
		},
		body: new URLSearchParams(fields).toString(),
	});
	return { res, html: await res.text() };
}
const trigger = (res: Response) =>
	JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
		toast?: { message: string; type: string };
		announce?: string;
	};
const textOf = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replaceAll("&#39;", "'")
		.replaceAll("&quot;", '"')
		.replace(/\s+/g, " ");

async function charges(rawName: string, count: number, merchantName?: string) {
	for (let i = 0; i < count; i += 1)
		await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name)
				 VALUES (?, 1, '2026-09-20', 650, ?, ?)`,
			)
			.bind(`plaid-${crypto.randomUUID()}`, rawName, merchantName ?? null)
			.run();
}
const suggest = (key: string, names: string, status = "pending") =>
	db
		.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, ?)",
		)
		.bind(key, names, status)
		.run();
const merchant = (key: string) =>
	db
		.prepare(
			"SELECT display_name, suggestion_status FROM merchants WHERE raw_name = ?",
		)
		.bind(key)
		.first<{ display_name: string | null; suggestion_status: string }>();

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchants"),
	]);
});

async function twoMerchants() {
	await charges(BLUE, 3);
	await suggest(BLUE, "Blue Bottle Coffee\nBlue Bottle\nBlue Bottle Cafe");
	await charges(LUPITA, 1);
	await suggest(LUPITA, "Lupita's Taqueria");
}

describe("namesToReview", () => {
	it("lists the merchants with names waiting, most transactions first, with what each needs", async () => {
		await twoMerchants();
		expect(await namesToReview(db)).toEqual([
			{
				key: BLUE,
				bankText: BLUE,
				tidied: "Blue bottle cof",
				names: ["Blue Bottle Coffee", "Blue Bottle", "Blue Bottle Cafe"],
				source: "tally",
				count: 3,
			},
			{
				key: LUPITA,
				bankText: LUPITA,
				tidied: "Lupitas taq",
				names: ["Lupita's Taqueria"],
				source: "tally",
				count: 1,
			},
		]);
	});

	it("leaves out a merchant that was decided, named by a person, has nothing to suggest, or has no transactions left", async () => {
		await charges("DECIDED 1", 1);
		await suggest("DECIDED 1", "Decided", "accepted");
		await charges("NAMED 1", 1);
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status, display_name) VALUES ('NAMED 1', 'Named', 'pending', 'Mine')",
			)
			.run();
		await charges("EMPTY 1", 1);
		await suggest("EMPTY 1", "");
		await suggest("GONE 1", "Gone");
		await charges("NETFLIX", 1);
		await suggest("NETFLIX", "Netflix");
		expect(await namesToReview(db)).toEqual([]);
	});

	it("with the names switch off keeps only the bank's own names, and lists the guesses again when it is back on (decision 80)", async () => {
		await twoMerchants();
		await charges(LUPITA, 1, "Lupita's Taqueria");
		await suggest("Lupita's Taqueria", "Lupita's Taqueria");
		await saveAiSwitches(db, { names: false });
		expect(await namesToReview(db)).toMatchObject([
			{
				key: "Lupita's Taqueria",
				names: ["Lupita's Taqueria"],
				source: "bank",
			},
		]);
		await saveAiSwitches(db, { names: true });
		expect((await namesToReview(db)).map((r) => r.source)).toEqual([
			"tally",
			"bank",
			"tally",
		]);
	});

	it("says where each merchant's names came from: Tally's guess, or the bank", async () => {
		await twoMerchants();
		await charges("SQ *COMCAST 99", 1, "Comcast");
		await suggest("Comcast", "Comcast");
		const review = await namesToReview(db);
		expect(review.find((r) => r.key === BLUE)?.source).toBe("tally");
		expect(review.find((r) => r.key === "Comcast")?.source).toBe("bank");
	});
});

describe("settleSuggestion", () => {
	it("only settles a suggestion that is still waiting for a merchant nobody has named", async () => {
		await suggest(BLUE, "Blue Bottle Coffee");
		expect(
			await settleSuggestion(db, BLUE, { kind: "name", name: "Mine" }),
		).toBe(true);
		expect(await merchant(BLUE)).toEqual({
			display_name: "Mine",
			suggestion_status: "rejected",
		});
		// Settled once: a stale form can't change it.
		expect(
			await settleSuggestion(db, BLUE, {
				kind: "name",
				name: "Blue Bottle Coffee",
			}),
		).toBe(false);
		expect(await settleSuggestion(db, BLUE, { kind: "keep" })).toBe(false);
		expect(await merchant(BLUE)).toEqual({
			display_name: "Mine",
			suggestion_status: "rejected",
		});
	});
});

describe("Settings", () => {
	it("leads to the review with a Band counting the merchants to check, above Categories", async () => {
		await twoMerchants();
		const { html } = await get("/settings");
		expect(html).toMatch(/<a href="\/settings\/names"[^>]*>/);
		const text = textOf(html);
		expect(text).toContain("2 merchant names to check");
		expect(text).toContain("Suggested names; you choose");
		expect(html.indexOf('href="/settings/names"')).toBeLessThan(
			html.indexOf('id="categories"'),
		);
	});

	it("with the names switch off counts only the bank's own names", async () => {
		await twoMerchants();
		await charges("SQ *COMCAST 99", 1, "Comcast");
		await suggest("Comcast", "Comcast");
		expect(textOf((await get("/settings")).html)).toContain(
			"3 merchant names to check",
		);
		await saveAiSwitches(db, { names: false });
		const { html } = await get("/settings");
		expect(textOf(html)).toContain("1 merchant name to check");
		await db.prepare("DELETE FROM merchants WHERE raw_name = 'Comcast'").run();
		expect((await get("/settings")).html).not.toContain(
			'href="/settings/names"',
		);
	});

	it("says '1 merchant name to check' for one, and shows no Band for none", async () => {
		await charges(BLUE, 1);
		await suggest(BLUE, "Blue Bottle Coffee");
		expect(textOf((await get("/settings")).html)).toContain(
			"1 merchant name to check",
		);
		await settleSuggestion(db, BLUE, { kind: "keep" });
		expect((await get("/settings")).html).not.toContain(
			'href="/settings/names"',
		);
	});

	it("has a Suggest store names switch in the AI suggestions group, on to start", async () => {
		const { html } = await get("/settings");
		const group =
			html.split('id="ai-suggestions"')[1]?.split("</section>")[0] ?? "";
		const first = group.match(/<input[^>]*role="switch"[^>]*>/)?.[0] ?? "";
		expect(first).toContain('name="names"');
		expect(first).toMatch(/\schecked/);
		expect(textOf(group)).toContain("Suggest store names");
		expect(textOf(group)).toContain(
			"Turns bank text like SQ *BLUE BOTTLE COF into Blue Bottle Coffee. You pick the name.",
		);
	});
});

describe("GET /settings/names", () => {
	it("shows the first merchant: what the bank says, the suggested names, keeping the bank's, and your own", async () => {
		await twoMerchants();
		const { res, html } = await get("/settings/names");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Merchant names · Tally</title>");
		const text = textOf(html);
		expect(text).toContain("1 of 2 · 3 transactions");
		expect(text).toContain("The bank says");
		expect(text).toContain(BLUE);
		const values = [...html.matchAll(/name="name_pick"[^>]*value="([^"]*)"/g)];
		expect(values.map((m) => m[1])).toEqual([
			"s:Blue Bottle Coffee",
			"s:Blue Bottle",
			"s:Blue Bottle Cafe",
			"keep",
		]);
		expect(html).toContain("Keep “Blue bottle cof”");
		// Where the names came from, under them: the sparkles icon, "Tally's guess" and a Why? (P87 B).
		expect(html).toMatch(
			/<span id="review-source"[^>]*><svg[^>]*>.*?<\/svg>\s*Tally&#39;s guess<\/span>/,
		);
		expect(html).toContain('href="/how-it-works#names"');
		expect(text).toContain("Or your own");
		expect(text).toContain("For all 3 transactions from this merchant.");
		expect(text).toContain("Save and next");
		expect(text).toContain("Skip");
		// Nothing is chosen to start with.
		expect(html).not.toMatch(/name="name_pick"[^>]*\schecked/);
		// A way back to Settings.
		expect(html).toMatch(/<a[^>]*href="\/settings"[^>]*>\s*Settings\s*<\/a>/);
	});

	it("says a name from the bank is From your bank, with no icon and no Why?, and shows it with the switch off", async () => {
		await charges("SQ *COMCAST 99", 2, "Comcast");
		await suggest("Comcast", "Comcast");
		for (const off of [false, true]) {
			await saveAiSwitches(db, { names: !off });
			const { html } = await get("/settings/names");
			expect(html).toMatch(
				/<p id="review-source" class="text-sm text-muted">From your bank<\/p>/,
			);
			expect(html).toContain('value="s:Comcast"');
			expect(html).not.toContain("Tally&#39;s guess");
			expect(html).not.toContain("/how-it-works#names");
		}
	});

	it("moves to the next merchant when one is skipped, and skipping changes nothing", async () => {
		await twoMerchants();
		const { html } = await get(
			`/settings/names?skip=${encodeURIComponent(BLUE)}`,
		);
		const text = textOf(html);
		expect(text).toContain("2 of 2 · 1 transaction");
		expect(text).toContain(LUPITA);
		expect(await merchant(BLUE)).toMatchObject({
			suggestion_status: "pending",
		});
	});

	it("says so when every merchant was skipped, and offers to start over", async () => {
		await twoMerchants();
		const { html } = await get(
			`/settings/names?skip=${encodeURIComponent(BLUE)}&skip=${encodeURIComponent(LUPITA)}`,
		);
		expect(textOf(html)).toContain("You skipped the rest.");
		expect(html).toContain('href="/settings/names"');
	});

	it("says there is nothing to check when nothing is waiting, with a way back", async () => {
		const { res, html } = await get("/settings/names");
		expect(res.status).toBe(200);
		expect(textOf(html)).toContain("No merchant names to check.");
		expect(html).toContain('href="/settings"');
	});

	it("never names Jev, or the AI behind a suggestion", async () => {
		await twoMerchants();
		const { html } = await get("/settings/names");
		expect(html).not.toMatch(/jev|workers ai/i);
	});
});

describe("POST /settings/names", () => {
	const save = (fields: Record<string, string>, htmx = true, query = "") =>
		post(`/settings/names${query}`, fields, htmx);

	it("a chosen suggestion names every transaction from the merchant, and the next one comes up", async () => {
		await twoMerchants();
		const { res, html } = await save({ key: BLUE, name_pick: "s:Blue Bottle" });
		expect(res.status).toBe(200);
		expect(await merchant(BLUE)).toEqual({
			display_name: "Blue Bottle",
			suggestion_status: "accepted",
		});
		expect(trigger(res)).toEqual({
			toast: {
				message: "Renamed 3 transactions to Blue Bottle",
				type: "success",
			},
			announce: "Renamed 3 transactions to Blue Bottle. 1 left to check.",
		});
		expect(textOf(html)).toContain(LUPITA);
		expect(textOf(html)).toContain("1 of 1 · 1 transaction");
	});

	it("a typed name is the person's own and wins over a chip", async () => {
		await twoMerchants();
		await save({
			key: BLUE,
			name_pick: "s:Blue Bottle",
			merchant: "The Bottle",
		});
		expect(await merchant(BLUE)).toEqual({
			display_name: "The Bottle",
			suggestion_status: "rejected",
		});
	});

	it("keeping the bank's name turns the suggestions down and keeps the tidied text", async () => {
		await twoMerchants();
		const { res } = await save({ key: BLUE, name_pick: "keep" });
		expect(await merchant(BLUE)).toEqual({
			display_name: null,
			suggestion_status: "rejected",
		});
		expect(trigger(res).toast?.message).toBe(
			"Kept the bank's name for 3 transactions",
		);
	});

	it("asks for a choice when none was made, and changes nothing", async () => {
		await twoMerchants();
		const { res, html } = await save({ key: BLUE });
		expect(res.status).toBe(422);
		expect(html).toContain('role="alert"');
		expect(textOf(html)).toContain(
			"Pick a name, keep the bank's, or type your own.",
		);
		expect(await merchant(BLUE)).toMatchObject({
			suggestion_status: "pending",
		});
	});

	it("refuses a chip that isn't one of the names shown, and a name that is too long", async () => {
		await twoMerchants();
		const stale = await save({ key: BLUE, name_pick: "s:Something Else" });
		expect(stale.res.status).toBe(422);
		const long = await save({ key: BLUE, merchant: "x".repeat(81) });
		expect(long.res.status).toBe(422);
		expect(textOf(long.html)).toContain("Keep the name under 80 characters.");
		expect(await merchant(BLUE)).toMatchObject({
			suggestion_status: "pending",
		});
	});

	it("when the merchant was already named elsewhere, says so and shows the next one without changing it", async () => {
		await twoMerchants();
		await settleSuggestion(db, BLUE, { kind: "name", name: "Done Elsewhere" });
		const { res, html } = await save({ key: BLUE, name_pick: "s:Blue Bottle" });
		expect(res.status).toBe(200);
		expect(trigger(res).toast).toEqual({
			message: "That merchant was already named.",
			type: "info",
		});
		expect(await merchant(BLUE)).toMatchObject({
			display_name: "Done Elsewhere",
		});
		expect(textOf(html)).toContain(LUPITA);
	});

	it("without JavaScript it redirects back to the review, keeping the skips", async () => {
		await twoMerchants();
		const { res } = await save(
			{ key: LUPITA, name_pick: "s:Lupita's Taqueria" },
			false,
			`?skip=${encodeURIComponent(BLUE)}`,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe(
			`/settings/names?skip=${encodeURIComponent(BLUE)}`,
		);
	});

	it("the next page shows the new name in the Transactions list, plain", async () => {
		await twoMerchants();
		await save({ key: BLUE, name_pick: "s:Blue Bottle Coffee" });
		const { html } = await get("/transactions?month=all");
		expect(html).toContain("Blue Bottle Coffee");
		expect(html).toContain("Lupita&#39;s Taqueria");
		expect(html.match(/decoration-dashed/g)).toHaveLength(1);
	});
});
