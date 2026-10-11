import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import { namesToReview, settleSuggestion } from "../src/db/merchant-names";
import { resetDemo } from "../src/demo/reset";

// Suggested merchant names (P29 A, decision 64, #33): which names wait for a person (namesToReview) and
// how a choice settles one (settleSuggestion). The one review screen that asks them is tested in
// suggestions-route.test.ts (#195); nothing renames itself.

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

/** The number Skip uses for a merchant, never its bank text. */
const rowId = async (key: string) =>
	(
		await db
			.prepare("SELECT rowid AS id FROM merchants WHERE raw_name = ?")
			.bind(key)
			.first<{ id: number }>()
	)?.id as number;

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
				id: await rowId(BLUE),
				bankText: BLUE,
				tidied: "Blue bottle cof",
				names: ["Blue Bottle Coffee", "Blue Bottle", "Blue Bottle Cafe"],
				source: "tally",
				count: 3,
			},
			{
				key: LUPITA,
				id: await rowId(LUPITA),
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

describe("namesToReview with several bank texts for one merchant", () => {
	it("keeps a merchant whose most frequent text repeats the suggestion, since its other rows still show it", async () => {
		// "TARGET 1234" tidies to "Target", which the suggestion repeats, so its rows show no suggestion;
		// "TGT*0099 SF" doesn't, so those rows show it dashed and the review must still offer it.
		await charges("TARGET 1234", 3, "Target");
		await charges("TGT*0099 SF", 1, "Target");
		await suggest("Target", "Target");
		expect(await namesToReview(db)).toEqual([
			{
				key: "Target",
				id: await rowId("Target"),
				bankText: "TGT*0099 SF",
				tidied: "Tgt 0099 sf",
				names: ["Target"],
				// Plaid's name is the merchant's key, so a suggestion equal to it is the bank's own.
				source: "bank",
				count: 4,
			},
		]);
	});

	it("shows the text with the most charges among those that have a name to offer", async () => {
		await charges("TGT*0099 SF", 1, "Target");
		await charges("TGT*5 OAKLAND", 2, "Target");
		await charges("TARGET 1234", 5, "Target");
		await suggest("Target", "Target\nTarget Stores");
		const [review] = await namesToReview(db);
		// The first text's tidied form repeats "Target", so only "Target Stores" is offered there; the
		// text shown is the busiest one where something is offered.
		expect(review).toMatchObject({ key: "Target", count: 8 });
		expect(review?.bankText).toBe("TARGET 1234");
		expect(review?.names).toEqual(["Target Stores"]);
	});

	it("drops a merchant only when no text of it has a name to offer", async () => {
		await charges("TARGET 1234", 2, "Target");
		await suggest("Target", "Target");
		expect(await namesToReview(db)).toEqual([]);
	});

	it("keeps the Settings count and the review in step", async () => {
		await charges("TARGET 1234", 3, "Target");
		await charges("TGT*0099 SF", 1, "Target");
		await suggest("Target", "Target");
		expect(textOf((await get("/settings")).html)).toContain(
			"1 suggestion to check",
		);
		const { html } = await get("/settings/suggestions");
		expect(textOf(html)).toContain("The bank says TGT*0099 SF");
		expect(textOf(html)).toContain("For all 4 transactions");
	});
});

describe("saving the names switch redraws the Band above Categories", () => {
	const bandOf = (html: string) =>
		html.match(/<div id="names-band">[\s\S]*?<\/div>(?=\s*<section)/)?.[0] ??
		"";

	it("always has a place for it, and the group asks for it to be drawn again with the switch", async () => {
		const { html } = await get("/settings");
		expect(html).toContain('<div id="names-band">');
		expect(html).toMatch(
			/<form[^>]*action="\/settings\/ai"[^>]*hx-select-oob="#names-band"/,
		);
	});

	it("takes the Band away when the switch is saved off, and says so", async () => {
		await twoMerchants();
		expect(bandOf((await get("/settings")).html)).toContain(
			"2 suggestions to check",
		);
		const { res, html } = await post(
			"/settings/ai",
			{ categories: "on", income: "on" },
			true,
		);
		expect(res.status).toBe(200);
		expect(html).toContain('<div id="names-band">');
		expect(html).not.toContain('href="/settings/suggestions"');
		expect(trigger(res).announce).toContain("Nothing to check.");
	});

	it("brings the Band back when the switch is saved on, with its count in the announcement", async () => {
		await twoMerchants();
		await saveAiSwitches(db, { names: false });
		const { res, html } = await post(
			"/settings/ai",
			{ names: "on", categories: "on", income: "on" },
			true,
		);
		expect(textOf(html)).toContain("2 suggestions to check");
		expect(html).toMatch(
			/<div id="names-band"><div[^>]*><a href="\/settings\/suggestions"/,
		);
		expect(trigger(res).announce).toContain("2 suggestions to check.");
	});

	it("says nothing about the Band when a save doesn't change it", async () => {
		await twoMerchants();
		const { res } = await post(
			"/settings/ai",
			{ names: "on", categories: "on" },
			true,
		);
		expect(trigger(res).announce).not.toMatch(/merchant name/);
	});

	it("without JavaScript the save redirects, and the Settings page it lands on has the right Band", async () => {
		await twoMerchants();
		const { res } = await post("/settings/ai", { income: "on" }, false);
		expect(res.status).toBe(303);
		expect((await get("/settings")).html).not.toContain(
			'href="/settings/suggestions"',
		);
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
		expect(html).toMatch(/<a href="\/settings\/suggestions"[^>]*>/);
		const text = textOf(html);
		expect(text).toContain("2 suggestions to check");
		expect(text).toContain("Tally's guesses; you decide");
		expect(html.indexOf('href="/settings/suggestions"')).toBeLessThan(
			html.indexOf('id="categories"'),
		);
	});

	it("with the names switch off counts only the bank's own names", async () => {
		await twoMerchants();
		await charges("SQ *COMCAST 99", 1, "Comcast");
		await suggest("Comcast", "Comcast");
		expect(textOf((await get("/settings")).html)).toContain(
			"3 suggestions to check",
		);
		await saveAiSwitches(db, { names: false });
		const { html } = await get("/settings");
		expect(textOf(html)).toContain("1 suggestion to check");
		await db.prepare("DELETE FROM merchants WHERE raw_name = 'Comcast'").run();
		expect((await get("/settings")).html).not.toContain(
			'href="/settings/suggestions"',
		);
	});

	it("says '1 suggestion to check' for one, and shows no Band for none", async () => {
		await charges(BLUE, 1);
		await suggest(BLUE, "Blue Bottle Coffee");
		expect(textOf((await get("/settings")).html)).toContain(
			"1 suggestion to check",
		);
		await settleSuggestion(db, BLUE, { kind: "keep" });
		expect((await get("/settings")).html).not.toContain(
			'href="/settings/suggestions"',
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
