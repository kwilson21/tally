import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import {
	getTransaction,
	listTransactions,
	saveEdit,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { parseEdit } from "../src/transactions/edit";
import { parseFilters } from "../src/transactions/filters";

// Suggested merchant names in the Transactions list and the edit panel (P29 A, decision 64, #33): the
// first pending suggestion shows dashed until a person chooses, the panel offers up to three names,
// the bank's, or their own, and nothing renames itself.

const db = env.DB;
const BASE = "http://tally.test";
const RAW = "SQ *BLUE BOTTLE COF 0412";

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}
async function post(
	path: string,
	fields: Record<string, string | string[]>,
	htmx = false,
) {
	const form = new URLSearchParams();
	for (const [key, value] of Object.entries(fields))
		for (const item of Array.isArray(value) ? value : [value])
			form.append(key, item);
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			...(htmx ? { "HX-Request": "true" } : {}),
		},
		body: form.toString(),
	});
	return { res, html: await res.text() };
}

async function charge(
	rawName = RAW,
	merchantName: string | null = null,
	date = "2026-09-20",
): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name)
			 VALUES (?, 1, ?, 650, ?, ?) RETURNING id`,
		)
		.bind(`plaid-${crypto.randomUUID()}`, date, rawName, merchantName)
		.first<{ id: number }>();
	return row?.id as number;
}
const suggest = (
	key: string,
	names: string,
	status = "pending",
	display: string | null = null,
) =>
	db
		.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status, display_name) VALUES (?, ?, ?, ?)",
		)
		.bind(key, names, status, display)
		.run();
const merchant = (key: string) =>
	db
		.prepare(
			"SELECT display_name, suggested_name, suggestion_status FROM merchants WHERE raw_name = ?",
		)
		.bind(key)
		.first<{
			display_name: string | null;
			suggested_name: string | null;
			suggestion_status: string;
		}>();
const filters = parseFilters(new URLSearchParams("month=all"), "2026-09");
const rowOf = async (id: number) =>
	(await listTransactions(db, filters)).rows.find((r) => r.id === id);
/** The ids of the rows a search finds. */
const found = async (q: string) =>
	(
		await listTransactions(
			db,
			parseFilters(new URLSearchParams({ month: "all", q }), "2026-09"),
		)
	).rows.map((r) => r.id);
/** A split part of a purchase from `rawName`, as the split form saves it. */
async function splitPart(rawName = RAW): Promise<number> {
	const parent = await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, is_split)
			 VALUES (?, 1, '2026-09-20', 1300, ?, 1) RETURNING id`,
		)
		.bind(`plaid-${crypto.randomUUID()}`, rawName)
		.first<{ id: number }>();
	const part = await db
		.prepare(
			`INSERT INTO transactions (account_id, date, amount_cents, raw_name, parent_id)
			 VALUES (1, '2026-09-20', 650, ?, ?) RETURNING id`,
		)
		.bind(rawName, parent?.id)
		.first<{ id: number }>();
	return part?.id as number;
}

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchants"),
	]);
});

describe("the Transactions list", () => {
	it("explains suggested names once above the list only while one is shown", async () => {
		await charge("PLAIN SHOP 123");
		const plain = (await get("/transactions?month=all")).html;
		expect(plain).not.toContain("Dashed names are suggestions.");

		await charge("CHECKCARD 0921 CVS", "CVS Pharmacy");
		await suggest("CVS Pharmacy", "CVS Pharmacy");
		const banked = (await get("/transactions?month=all")).html;
		expect(banked).toContain("Dashed names are suggestions.");
		expect(banked.match(/Dashed names are suggestions\./g)).toHaveLength(1);

		await charge(RAW);
		await suggest(RAW, "Blue Bottle Coffee");
		const guessed = (await get("/transactions?month=all")).html;
		expect(guessed).toContain("Dashed names are suggestions.");
		expect(guessed).toContain('href="/how-it-works#names"');
		expect(guessed).toMatch(/Dashed names are suggestions\.[\s\S]{0,300}Why\?/);
		expect(guessed.match(/Dashed names are suggestions\./g)).toHaveLength(1);
		const results =
			guessed.match(/<section id="results"[\s\S]*?<\/section>/)?.[0] ?? "";
		expect(results.indexOf("Dashed names are suggestions.")).toBeLessThan(
			results.indexOf("<ul"),
		);
	});

	it("shows the dashed-name note only for names displayed in the selected view", async () => {
		await charge(RAW);
		await suggest(RAW, "Blue Bottle Coffee");

		const normal = (await get("/transactions?month=all")).html;
		const raw = (await get("/transactions?month=all&raw=1")).html;
		expect(normal).toContain("Dashed names are suggestions.");
		expect(raw).not.toContain("Dashed names are suggestions.");
	});

	it("keeps a long unbroken name inside the edit sheet and its chips", async () => {
		const raw = `SQ *${"x".repeat(48)}`;
		const id = await charge(raw);
		await suggest(raw, `A long guessed store name ${"word ".repeat(5)}end`);
		const { html } = await get(`/transactions/${id}?month=all`);
		expect(html).toContain('id="edit-title"');
		expect(html).toContain("wrap-anywhere");
		expect(html).toContain(`Keep “${raw}”`);
	});

	it("shows the first pending suggestion in place of the tidied bank text, marked as only suggested", async () => {
		const id = await charge();
		await suggest(RAW, "Blue Bottle Coffee\nBlue Bottle");
		expect(await rowOf(id)).toMatchObject({
			displayName: "Blue Bottle Coffee",
			nameSuggested: true,
		});
	});

	it("shows the tidied bank text when nothing is suggested, or the suggestion was decided", async () => {
		const plain = await charge("PLAIN SHOP 123");
		const turnedDown = await charge("TURNED DOWN 123");
		const taken = await charge("TAKEN 123");
		await suggest("TURNED DOWN 123", "Turned Down", "rejected");
		await suggest("TAKEN 123", "Taken", "accepted");
		for (const id of [plain, turnedDown, taken])
			expect(await rowOf(id)).toMatchObject({ nameSuggested: false });
		expect((await rowOf(turnedDown))?.displayName).toBe("Turned down");
	});

	it("never replaces a name a person chose", async () => {
		const id = await charge();
		await suggest(RAW, "Blue Bottle Coffee", "pending", "The Bottle");
		expect(await rowOf(id)).toMatchObject({
			displayName: "The Bottle",
			nameSuggested: false,
		});
	});

	it("reads a Plaid-named merchant's suggestion from its key", async () => {
		const id = await charge(RAW, "Blue Bottle Coffee");
		await suggest("Blue Bottle Coffee", "Blue Bottle Coffee");
		expect(await rowOf(id)).toMatchObject({
			displayName: "Blue Bottle Coffee",
			nameSuggested: true,
		});
	});

	it("with the names switch off hides Tally's guesses but still shows the bank's own name, and the guesses come back when it is on (decision 80)", async () => {
		const guessed = await charge(RAW);
		await suggest(RAW, "Blue Bottle Coffee");
		const banked = await charge("SQ *LUPITAS TAQ 2210", "Lupita's Taqueria");
		await suggest("Lupita's Taqueria", "Lupita's Taqueria");
		await saveAiSwitches(db, { names: false });
		expect(await rowOf(guessed)).toMatchObject({
			displayName: "Blue bottle cof",
			nameSuggested: false,
		});
		expect(await rowOf(banked)).toMatchObject({
			displayName: "Lupita's Taqueria",
			nameSuggested: true,
			nameFromBank: true,
		});
		await saveAiSwitches(db, { names: true });
		expect(await rowOf(guessed)).toMatchObject({
			displayName: "Blue Bottle Coffee",
			nameSuggested: true,
			nameFromBank: false,
		});
	});

	it("draws a name Tally guessed dashed, with the sparkles icon and the words for a screen reader (P87 B), and a chosen name plain", async () => {
		await charge();
		await suggest(RAW, "Blue Bottle Coffee");
		await charge("LOCAL SHOP 99");
		await charge("NAMED SHOP 7");
		await suggest("NAMED SHOP 7", "A Guess", "pending", "Mine");
		const { html } = await get("/transactions?month=all");
		// The icon and "Tally's guess" come before the dashed name; only the one guessed row has them.
		expect(html).toMatch(
			/<svg[^>]*>.*?<\/svg><span class="sr-only">Tally&#39;s guess: <\/span><span class="[^"]*decoration-dashed[^"]*">Blue Bottle Coffee<\/span>/,
		);
		expect(html.match(/decoration-dashed/g)).toHaveLength(1);
		expect(html.match(/Tally&#39;s guess: /g)).toHaveLength(1);
		expect(html).toContain(">Mine<");
	});

	it("draws the bank's own name dashed but with no icon, and says it is from the bank only to a screen reader", async () => {
		await charge("SQ *LUPITAS TAQ 2210", "Lupita's Taqueria");
		await suggest("Lupita's Taqueria", "Lupita's Taqueria");
		const { html } = await get("/transactions?month=all");
		expect(html).toMatch(
			/<span class="sr-only">From your bank: <\/span><span class="[^"]*decoration-dashed[^"]*">Lupita&#39;s Taqueria<\/span>/,
		);
		expect(html).not.toContain("Tally&#39;s guess");
		// No sparkles: the only svg before the name is the row's own category-less circle.
		const row =
			html.split("Lupita&#39;s Taqueria")[0]?.split("<li")?.pop() ?? "";
		expect(row).not.toContain("M11.017 2.814");
	});

	it("shows a guess and the bank's name in one list, one with the icon and one without", async () => {
		await charge();
		await suggest(RAW, "Blue Bottle Coffee");
		await charge("SQ *LUPITAS TAQ 2210", "Lupita's Taqueria");
		await suggest("Lupita's Taqueria", "Lupita's Taqueria");
		const { html } = await get("/transactions?month=all");
		expect(html.match(/decoration-dashed/g)).toHaveLength(2);
		expect(html.match(/Tally&#39;s guess: /g)).toHaveLength(1);
		expect(html.match(/From your bank: /g)).toHaveLength(1);
		expect(html.match(/M11\.017 2\.814/g)).toHaveLength(1);
	});
});

describe("searching the Transactions list", () => {
	it("finds a row by the name it shows as a suggestion, and still by its bank text", async () => {
		const id = await charge();
		await charge("OTHER SHOP 5");
		await suggest(RAW, "Blue Bottle Coffee\nBlue Bottle");
		expect(await found("Blue Bottle Coffee")).toEqual([id]);
		expect(await found("bottle cof")).toEqual([id]);
		expect(await found("0412")).toEqual([id]);
		// Any of the suggested names, not only the first.
		expect(await found("blue bottle")).toEqual([id]);
	});

	it("finds it from the page too", async () => {
		await charge();
		await suggest(RAW, "Blue Bottle Coffee");
		const { html } = await get("/transactions?month=all&q=Blue+Bottle+Coffee");
		expect(html).toContain("Blue Bottle Coffee");
		expect(html).toContain(RAW);
	});

	it("finds nothing by a suggestion that is hidden or decided: with the names switch off, rejected, or accepted as another name", async () => {
		await charge();
		await suggest(RAW, "Blue Bottle Coffee");
		await saveAiSwitches(db, { names: false });
		expect(await found("Blue Bottle Coffee")).toEqual([]);
		await saveAiSwitches(db, { names: true });
		expect(await found("Blue Bottle Coffee")).toHaveLength(1);
		await db
			.prepare("UPDATE merchants SET suggestion_status = 'rejected'")
			.run();
		expect(await found("Blue Bottle Coffee")).toEqual([]);
		await db
			.prepare(
				"UPDATE merchants SET suggestion_status = 'accepted', display_name = 'The Bottle'",
			)
			.run();
		expect(await found("Blue Bottle Coffee")).toEqual([]);
		expect(await found("The Bottle")).toHaveLength(1);
	});

	it("with the names switch off still finds a row by the bank's own name, but not by Tally's guess", async () => {
		const guessed = await charge();
		await suggest(RAW, "Blue Bottle Coffee");
		const banked = await charge("SQ *LUPITAS TAQ 2210", "Lupita's Taqueria");
		await suggest("Lupita's Taqueria", "Lupita's Taqueria");
		await saveAiSwitches(db, { names: false });
		expect(await found("Blue Bottle Coffee")).toEqual([]);
		expect(await found("Lupita's Taqueria")).toEqual([banked]);
		await saveAiSwitches(db, { names: true });
		expect(await found("Blue Bottle Coffee")).toEqual([guessed]);
	});

	it("matches a % or _ in the search literally, as before", async () => {
		const id = await charge();
		await suggest(RAW, "Blue Bottle Coffee");
		expect(await found("%")).toEqual([]);
		expect(await found("Blue_Bottle")).toEqual([]);
		expect(await found("Blue Bottle")).toEqual([id]);
	});
});

describe("a split part's caption", () => {
	it("names its parent the way the parent's own row does: the suggestion, shown while it is offered", async () => {
		const part = await splitPart();
		await suggest(RAW, "Blue Bottle Coffee");
		expect(await rowOf(part)).toMatchObject({
			displayName: "Blue Bottle Coffee",
			parentName: "Blue Bottle Coffee",
		});
	});

	it("keeps the bank's own name for the parent with the names switch off", async () => {
		const part = await splitPart("SQ *LUPITAS TAQ 2210");
		await db
			.prepare("UPDATE transactions SET merchant_name = 'Lupita''s Taqueria'")
			.run();
		await suggest("Lupita's Taqueria", "Lupita's Taqueria");
		await saveAiSwitches(db, { names: false });
		expect((await rowOf(part))?.parentName).toBe("Lupita's Taqueria");
	});

	it("says the tidied bank text when the suggestion is hidden (names off) or decided, and the chosen name once chosen", async () => {
		const part = await splitPart();
		await suggest(RAW, "Blue Bottle Coffee");
		await saveAiSwitches(db, { names: false });
		expect((await rowOf(part))?.parentName).toBe("Blue bottle cof");
		await saveAiSwitches(db, { names: true });
		await db
			.prepare("UPDATE merchants SET suggestion_status = 'rejected'")
			.run();
		expect((await rowOf(part))?.parentName).toBe("Blue bottle cof");
		await db.prepare("UPDATE merchants SET display_name = 'The Bottle'").run();
		expect((await rowOf(part))?.parentName).toBe("The Bottle");
	});
});

describe("the edit panel's name choices", () => {
	it("offers up to three suggested names, the bank's, and a field for your own, with nothing chosen", async () => {
		const id = await charge();
		await charge(RAW);
		await suggest(RAW, "Blue Bottle Coffee\nBlue Bottle\nBlue Bottle Cafe");
		const { res, html } = await get(`/transactions/${id}?month=all`);
		expect(res.status).toBe(200);
		const radios = [...html.matchAll(/<input[^>]*name="name_pick"[^>]*>/g)].map(
			(m) => m[0],
		);
		expect(radios.map((r) => r.match(/value="([^"]*)"/)?.[1])).toEqual([
			"s:Blue Bottle Coffee",
			"s:Blue Bottle",
			"s:Blue Bottle Cafe",
			"keep",
		]);
		// Saving the panel for another reason must never rename the merchant.
		for (const radio of radios) expect(radio).not.toMatch(/\schecked/);
		expect(html).toContain("Keep “Blue bottle cof”");
		expect(html).toMatch(/<label[^>]*>Or your own<\/label>/);
		expect(
			html.match(/A name typed here is used instead of any name above\./g),
		).toHaveLength(1);
		const ownField = html.match(/<input[^>]*id="name-own"[^>]*>/)?.[0] ?? "";
		const hintId = ownField.match(/aria-describedby="([^"]+)"/)?.[1];
		expect(hintId).toBe("name-own-hint");
		expect(html).toMatch(
			/<label[^>]*>Or your own<\/label>[\s\S]*?A name typed here is used instead of any name above\. For all 2 transactions from this merchant\./,
		);
		expect(html).toContain("For all 2 transactions from this merchant.");
		// The title is the first suggestion, dashed like the list, and the bank's text is above it.
		expect(html).toMatch(
			/id="edit-title"[^>]*decoration-dashed[^>]*>Blue Bottle Coffee/,
		);
		expect(html).toContain(RAW);
	});

	it("shows no choices when nothing is suggested, and keeps the rename field", async () => {
		const id = await charge("PLAIN SHOP 123");
		const { html } = await get(`/transactions/${id}?month=all`);
		expect(html).not.toContain('name="name_pick"');
		expect(html).toMatch(/<label[^>]*>Merchant name<\/label>/);
	});

	it("leaves out a name that says what the tidied bank text already says", async () => {
		const id = await charge("NETFLIX.COM");
		await suggest("NETFLIX.COM", "Netflix.com\nNetflix");
		const { html } = await get(`/transactions/${id}?month=all`);
		const values = [...html.matchAll(/name="name_pick"[^>]*value="([^"]*)"/g)];
		expect(values.map((m) => m[1])).toEqual(["s:Netflix", "keep"]);
	});

	it("says under the names that they are Tally's guess, with the sparkles icon and a Why? (P87 B)", async () => {
		const id = await charge();
		await suggest(RAW, "Blue Bottle Coffee");
		const { html } = await get(`/transactions/${id}?month=all`);
		expect(html).toMatch(
			/<span id="name-source"[^>]*><svg[^>]*>.*?<\/svg>\s*Tally&#39;s guess<\/span>/,
		);
		expect(html).toMatch(
			/<a href="\/how-it-works#names"[^>]*aria-label="Why\? Tally&#39;s guess"[^>]*>Why\?<\/a>/,
		);
		// Each suggested name's chip is read with it; "Keep" isn't a guess.
		expect(html.match(/aria-describedby="name-source"/g)).toHaveLength(1);
	});

	it("says the bank's own name is from your bank, in muted words, with no icon and no Why? (P87 B)", async () => {
		const id = await charge("SQ *LUPITAS TAQ 2210", "Lupita's Taqueria");
		await suggest("Lupita's Taqueria", "Lupita's Taqueria");
		const { html } = await get(`/transactions/${id}?month=all`);
		expect(html).toMatch(
			/<p id="name-source" class="text-sm text-muted">From your bank<\/p>/,
		);
		expect(html).toContain('value="s:Lupita&#39;s Taqueria"');
		expect(html).not.toContain("Tally&#39;s guess");
		expect(html.match(/href="\/how-it-works#names"/g)).toHaveLength(1);
		expect(html).not.toContain("M11.017 2.814");
		expect(html.match(/aria-describedby="name-source"/g)).toHaveLength(1);
	});

	it("with the names switch off offers the bank's name, labelled From your bank, but not Tally's guesses (decision 80)", async () => {
		const guessed = await charge(RAW);
		await suggest(RAW, "Blue Bottle Coffee");
		const banked = await charge("SQ *LUPITAS TAQ 2210", "Lupita's Taqueria");
		await suggest("Lupita's Taqueria", "Lupita's Taqueria");
		await saveAiSwitches(db, { names: false });
		const off = (await get(`/transactions/${guessed}`)).html;
		expect(off).not.toContain('name="name_pick"');
		expect(off).not.toContain("Tally&#39;s guess");
		expect(off).toMatch(/<label[^>]*>Merchant name<\/label>/);
		const bank = (await get(`/transactions/${banked}`)).html;
		expect(bank).toContain('value="s:Lupita&#39;s Taqueria"');
		expect(bank).toContain("From your bank");
		expect(bank).not.toContain("Tally&#39;s guess");
	});

	describe("saving", () => {
		const save = (id: number, fields: Record<string, string>, htmx = false) =>
			post(
				`/transactions/${id}`,
				{ back: "/transactions?month=all", ...fields },
				htmx,
			);

		it("a chosen suggestion becomes the merchant's name, for all its transactions, and is accepted", async () => {
			const id = await charge();
			const other = await charge(RAW, null, "2026-09-18");
			await suggest(RAW, "Blue Bottle Coffee\nBlue Bottle");
			const { res } = await save(id, { name_pick: "s:Blue Bottle" });
			expect(res.status).toBe(303);
			expect(await merchant(RAW)).toEqual({
				display_name: "Blue Bottle",
				suggested_name: "Blue Bottle Coffee\nBlue Bottle",
				suggestion_status: "accepted",
			});
			for (const t of [id, other])
				expect(await rowOf(t)).toMatchObject({
					displayName: "Blue Bottle",
					nameSuggested: false,
				});
		});

		describe("a panel that is out of date never erases or restores a name (another tab named the merchant)", () => {
			const category = () =>
				db
					.prepare(
						"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1",
					)
					.first<{ id: number }>();
			const categoryOf = async (id: number) =>
				(
					await db
						.prepare("SELECT category_id FROM transactions WHERE id = ?")
						.bind(id)
						.first<{ category_id: number | null }>()
				)?.category_id;

			describe("after a form error the panel keeps what it first showed in merchant_was (a 422 redraw)", () => {
				/** Posts the edit form as htmx does and reads the redrawn panel's name fields. */
				const redraw = async (id: number, fields: Record<string, string>) => {
					const { res, html } = await save(id, fields, true);
					return {
						status: res.status,
						was: html.match(/name="merchant_was" value="([^"]*)"/)?.[1],
						typed: html.match(/name="merchant"[^>]*value="([^"]*)"/)?.[1],
					};
				};
				const BAD_CATEGORY = "999999";

				it("carries the posted merchant_was through, not the name another tab chose, so fixing the form doesn't erase it", async () => {
					const id = await charge();
					await suggest(RAW, "Blue Bottle Coffee\nBlue Bottle");
					// The panel was drawn with nothing chosen; another tab then chooses a name.
					await save(id, { name_pick: "s:Blue Bottle", merchant_was: "" });
					expect(await merchant(RAW)).toMatchObject({
						display_name: "Blue Bottle",
					});
					// The stale panel posts with a mistake.
					const failed = await redraw(id, {
						merchant_was: "",
						merchant: "",
						category: BAD_CATEGORY,
					});
					expect(failed.status).toBe(422);
					expect(failed.was).toBe("");
					// It posts again, fixed, without touching the name: the other tab's name survives.
					const picked = (await category())?.id;
					await save(id, {
						merchant_was: failed.was ?? "",
						merchant: failed.typed ?? "",
						category: String(picked),
					});
					expect(await merchant(RAW)).toMatchObject({
						display_name: "Blue Bottle",
						suggestion_status: "accepted",
					});
					expect(await categoryOf(id)).toBe(picked);
				});

				it("keeps the original merchant_was through two errors in a row", async () => {
					const id = await charge();
					await db
						.prepare(
							"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'Old Name')",
						)
						.bind(RAW)
						.run();
					await db
						.prepare("UPDATE merchants SET display_name = 'New Name'")
						.run();
					const first = await redraw(id, {
						merchant_was: "Old Name",
						merchant: "Old Name",
						category: BAD_CATEGORY,
					});
					expect(first.was).toBe("Old Name");
					const second = await redraw(id, {
						merchant_was: first.was ?? "",
						merchant: first.typed ?? "",
						category: BAD_CATEGORY,
					});
					expect(second.was).toBe("Old Name");
					await save(id, {
						merchant_was: second.was ?? "",
						merchant: second.typed ?? "",
						note: "fixed",
					});
					expect(await merchant(RAW)).toMatchObject({
						display_name: "New Name",
					});
				});

				it("a name typed before the error is still the person's own once the form is fixed", async () => {
					const id = await charge();
					await suggest(RAW, "Blue Bottle Coffee");
					const failed = await redraw(id, {
						merchant_was: "",
						merchant: "My Bottle",
						category: BAD_CATEGORY,
					});
					expect(failed.status).toBe(422);
					// What was typed comes back in the field, and the original merchant_was beside it.
					expect(failed.typed).toBe("My Bottle");
					expect(failed.was).toBe("");
					const picked = (await category())?.id;
					await save(id, {
						merchant_was: failed.was ?? "",
						merchant: failed.typed ?? "",
						category: String(picked),
					});
					expect(await merchant(RAW)).toMatchObject({
						display_name: "My Bottle",
						suggestion_status: "rejected",
					});
					expect(await categoryOf(id)).toBe(picked);
				});

				it("a name cleared before the error is still cleared once the form is fixed", async () => {
					const id = await charge();
					await db
						.prepare(
							"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'Old Name')",
						)
						.bind(RAW)
						.run();
					const failed = await redraw(id, {
						merchant_was: "Old Name",
						merchant: "",
						category: BAD_CATEGORY,
					});
					expect(failed.was).toBe("Old Name");
					expect(failed.typed ?? "").toBe("");
					await save(id, {
						merchant_was: failed.was ?? "",
						merchant: failed.typed ?? "",
						note: "fixed",
					});
					expect(await merchant(RAW)).toMatchObject({ display_name: null });
				});

				it("draws the current name when the form carried no merchant_was, as a panel first drawn does", async () => {
					const id = await charge();
					await db
						.prepare(
							"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'Current')",
						)
						.bind(RAW)
						.run();
					const failed = await redraw(id, {
						merchant: "Current",
						category: BAD_CATEGORY,
					});
					expect(failed.was).toBe("Current");
				});
			});

			it("draws what the name field held, so a save can tell", async () => {
				const id = await charge();
				await suggest(RAW, "Blue Bottle Coffee");
				const open = (await get(`/transactions/${id}?month=all`)).html;
				expect(open).toMatch(
					/<input type="hidden" name="merchant_was" value=""/,
				);
				await db
					.prepare(
						"UPDATE merchants SET display_name = 'The Bottle', suggestion_status = 'accepted'",
					)
					.run();
				const named = (await get(`/transactions/${id}?month=all`)).html;
				expect(named).toMatch(
					/<input type="hidden" name="merchant_was" value="The Bottle"/,
				);
			});

			it("a name chosen in another tab survives saving the old panel with a category change", async () => {
				const id = await charge();
				await suggest(RAW, "Blue Bottle Coffee\nBlue Bottle");
				// Tab B chooses a name.
				await save(id, { name_pick: "s:Blue Bottle", merchant_was: "" });
				expect(await merchant(RAW)).toMatchObject({
					display_name: "Blue Bottle",
					suggestion_status: "accepted",
				});
				// Tab A's panel, drawn before that: nothing chosen, the field empty, and a category picked.
				const picked = (await category())?.id;
				const { res } = await save(id, {
					merchant_was: "",
					merchant: "",
					category: String(picked),
				});
				expect(res.status).toBe(303);
				expect(await merchant(RAW)).toMatchObject({
					display_name: "Blue Bottle",
					suggestion_status: "accepted",
				});
				expect(await categoryOf(id)).toBe(picked);
			});

			it("a rename made in another tab survives the old panel's plain rename field too", async () => {
				const id = await charge();
				await db
					.prepare(
						"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'Old Name')",
					)
					.bind(RAW)
					.run();
				// The panel was drawn with "Old Name"; another tab renamed the merchant; this save still holds "Old Name".
				await db
					.prepare("UPDATE merchants SET display_name = 'New Name'")
					.run();
				await save(id, {
					merchant_was: "Old Name",
					merchant: "Old Name",
					note: "x",
				});
				expect(await merchant(RAW)).toMatchObject({ display_name: "New Name" });
			});

			it("a name changed in this form is still written, and emptying a name still clears it", async () => {
				const id = await charge();
				await db
					.prepare(
						"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'Old Name')",
					)
					.bind(RAW)
					.run();
				await save(id, { merchant_was: "Old Name", merchant: "Renamed" });
				expect(await merchant(RAW)).toMatchObject({ display_name: "Renamed" });
				await save(id, { merchant_was: "Renamed", merchant: "" });
				expect(await merchant(RAW)).toMatchObject({ display_name: null });
			});

			it("keeping the bank's name turns the suggestions down and leaves a name chosen elsewhere alone", async () => {
				const id = await charge();
				await suggest(RAW, "Blue Bottle Coffee");
				await save(id, { merchant_was: "", name_pick: "keep" });
				expect(await merchant(RAW)).toMatchObject({
					display_name: null,
					suggestion_status: "rejected",
				});
			});

			it("a form with no merchant_was is read as before: what the field holds is the name", async () => {
				const id = await charge();
				await save(id, { merchant: "Typed Name" });
				expect(await merchant(RAW)).toMatchObject({
					display_name: "Typed Name",
				});
			});

			it("still makes the merchant's row for 'Always for this merchant' when no name was given", async () => {
				const id = await charge("NO ROW YET 9");
				const picked = (await category())?.id;
				await save(id, {
					merchant_was: "",
					category: String(picked),
					always: "1",
				});
				const rule = await db
					.prepare(
						"SELECT default_category_id AS c FROM merchants WHERE raw_name = 'NO ROW YET 9'",
					)
					.first<{ c: number }>();
				expect(rule?.c).toBe(picked);
			});
		});

		describe("a chip that is no longer offered is ignored (the panel was open while things changed)", () => {
			const stillPending = {
				display_name: null,
				suggested_name: "Blue Bottle Coffee\nBlue Bottle",
				suggestion_status: "pending",
			};

			it("once the names switch is off, neither a guess nor Keep accepts or turns anything down", async () => {
				const id = await charge();
				await suggest(RAW, "Blue Bottle Coffee\nBlue Bottle");
				await saveAiSwitches(db, { names: false });
				for (const pick of ["s:Blue Bottle Coffee", "keep"]) {
					const { res } = await save(id, { name_pick: pick });
					expect(res.status).toBe(303);
					expect(await merchant(RAW)).toEqual(stillPending);
				}
				// Switched back on, the guesses are still waiting for a choice.
				await saveAiSwitches(db, { names: true });
				expect(await rowOf(id)).toMatchObject({
					displayName: "Blue Bottle Coffee",
					nameSuggested: true,
				});
			});

			it("the rest of the form still saves: the category goes in even though the name pick is ignored", async () => {
				const id = await charge();
				await suggest(RAW, "Blue Bottle Coffee\nBlue Bottle");
				await saveAiSwitches(db, { names: false });
				const category = await db
					.prepare("SELECT id FROM categories WHERE archived = 0 LIMIT 1")
					.first<{ id: number }>();
				await save(id, {
					name_pick: "s:Blue Bottle",
					category: String(category?.id),
				});
				expect(await merchant(RAW)).toEqual(stillPending);
				const saved = await db
					.prepare("SELECT category_id FROM transactions WHERE id = ?")
					.bind(id)
					.first<{ category_id: number }>();
				expect(saved?.category_id).toBe(category?.id);
			});

			it("once the suggestion was settled elsewhere, or its names changed, a stale chip changes nothing", async () => {
				const id = await charge();
				await suggest(RAW, "Blue Bottle Coffee\nBlue Bottle");
				await db
					.prepare("UPDATE merchants SET suggested_name = 'Other Name'")
					.run();
				await save(id, { name_pick: "s:Blue Bottle" });
				expect(await merchant(RAW)).toMatchObject({
					display_name: null,
					suggestion_status: "pending",
				});
				await db
					.prepare("UPDATE merchants SET suggestion_status = 'rejected'")
					.run();
				await save(id, { name_pick: "s:Other Name" });
				await save(id, { name_pick: "keep" });
				expect(await merchant(RAW)).toMatchObject({
					display_name: null,
					suggestion_status: "rejected",
				});
			});

			it("the bank's own name is still offered with the names switch off, so it can still be picked", async () => {
				const id = await charge("SQ *LUPITAS TAQ 2210", "Lupita's Taqueria");
				await suggest("Lupita's Taqueria", "Lupita's Taqueria");
				await saveAiSwitches(db, { names: false });
				await save(id, { name_pick: "s:Lupita's Taqueria" });
				expect(await merchant("Lupita's Taqueria")).toMatchObject({
					display_name: "Lupita's Taqueria",
					suggestion_status: "accepted",
				});
			});

			it("a name typed in the field is still the person's own, offered or not", async () => {
				const id = await charge();
				await suggest(RAW, "Blue Bottle Coffee");
				await saveAiSwitches(db, { names: false });
				await save(id, { name_pick: "s:Blue Bottle Coffee", merchant: "Mine" });
				expect(await merchant(RAW)).toMatchObject({
					display_name: "Mine",
					suggestion_status: "rejected",
				});
			});
		});

		it("a name typed instead is the person's own: it wins over a chip and rejects the suggestions", async () => {
			const id = await charge();
			await suggest(RAW, "Blue Bottle Coffee");
			await save(id, {
				name_pick: "s:Blue Bottle Coffee",
				merchant: "The Bottle",
			});
			expect(await merchant(RAW)).toMatchObject({
				display_name: "The Bottle",
				suggestion_status: "rejected",
			});
		});

		it("typing a name that is one of the suggestions counts as accepting it", async () => {
			const id = await charge();
			await suggest(RAW, "Blue Bottle Coffee");
			await save(id, { merchant: "Blue Bottle Coffee" });
			expect(await merchant(RAW)).toMatchObject({
				display_name: "Blue Bottle Coffee",
				suggestion_status: "accepted",
			});
		});

		it("keeping the bank's name turns the suggestions down and leaves the name to the tidied text", async () => {
			const id = await charge();
			await suggest(RAW, "Blue Bottle Coffee");
			await save(id, { name_pick: "keep" });
			expect(await merchant(RAW)).toMatchObject({
				display_name: null,
				suggestion_status: "rejected",
			});
			expect(await rowOf(id)).toMatchObject({
				displayName: "Blue bottle cof",
				nameSuggested: false,
			});
			// It isn't suggested again, even if a later sync brings the same name.
			expect((await get(`/transactions/${id}`)).html).not.toContain(
				'name="name_pick"',
			);
		});

		it("saving with no choice changes nothing about the name: it stays a pending suggestion", async () => {
			const id = await charge();
			await suggest(RAW, "Blue Bottle Coffee");
			const { res } = await save(id, { note: "for the office", merchant: "" });
			expect(res.status).toBe(303);
			expect(await merchant(RAW)).toEqual({
				display_name: null,
				suggested_name: "Blue Bottle Coffee",
				suggestion_status: "pending",
			});
		});

		it("says what was saved, naming the chosen name", async () => {
			const id = await charge();
			await suggest(RAW, "Blue Bottle Coffee");
			const { res } = await save(
				id,
				{ name_pick: "s:Blue Bottle Coffee" },
				true,
			);
			expect(res.status).toBe(200);
			const trigger = JSON.parse(res.headers.get("HX-Trigger") ?? "{}");
			expect(trigger.toast.message).toBe("Saved Blue Bottle Coffee");
		});

		it("a name that is too long comes back with the choices and the error, nothing saved", async () => {
			const id = await charge();
			await suggest(RAW, "Blue Bottle Coffee");
			const { res, html } = await save(id, { merchant: "x".repeat(81) });
			expect(res.status).toBe(422);
			expect(html).toContain("Keep the name under 80 characters.");
			expect(html).toContain('name="name_pick"');
			expect(await merchant(RAW)).toMatchObject({ display_name: null });
		});

		it("a rename of a merchant with no suggestion works as before", async () => {
			const id = await charge("PLAIN SHOP 123");
			await save(id, { merchant: "Plain Shop" });
			expect(await merchant("PLAIN SHOP 123")).toMatchObject({
				display_name: "Plain Shop",
				suggestion_status: "none",
			});
		});
	});
});

describe("Organize", () => {
	it("settles a pending suggestion when a person names the group: accepted if it is a suggestion, rejected if it is their own", async () => {
		await charge();
		await charge("LUPITAS 55");
		await suggest(RAW, "Blue Bottle Coffee");
		await suggest("LUPITAS 55", "Lupitas Taqueria");
		const category = await db
			.prepare(
				"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1",
			)
			.first<{ id: number }>();
		const organize = (group: string, name: string) =>
			post("/transactions/organize", {
				group,
				category: String(category?.id),
				name,
			});
		await organize("Blue bottle cof", "Blue Bottle Coffee");
		await organize("Lupitas 55", "Lupita's");
		expect(await merchant(RAW)).toMatchObject({
			display_name: "Blue Bottle Coffee",
			suggestion_status: "accepted",
		});
		expect(await merchant("LUPITAS 55")).toMatchObject({
			display_name: "Lupita's",
			suggestion_status: "rejected",
		});
	});

	it("leaves a pending suggestion waiting when no name is given", async () => {
		await charge();
		await suggest(RAW, "Blue Bottle Coffee");
		const category = await db
			.prepare(
				"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1",
			)
			.first<{ id: number }>();
		// The form's name field holds the group's own name unless changed, which saves no new name.
		await post("/transactions/organize", {
			group: "Blue bottle cof",
			category: String(category?.id),
			name: "Blue bottle cof",
		});
		expect(await merchant(RAW)).toMatchObject({
			display_name: null,
			suggestion_status: "pending",
		});
	});
});

describe("saveEdit and parseEdit", () => {
	it("reads a chip, the bank's name, and a typed name from the form, the typed one first", () => {
		const parse = (fields: Record<string, string>) => {
			const form = new FormData();
			for (const [k, v] of Object.entries(fields)) form.set(k, v);
			const parsed = parseEdit(form, []);
			return parsed.ok ? parsed.value : null;
		};
		expect(parse({ name_pick: "s:Blue Bottle" })).toMatchObject({
			displayName: "Blue Bottle",
			keepBankName: false,
		});
		expect(parse({ name_pick: "keep" })).toMatchObject({
			displayName: null,
			keepBankName: true,
		});
		expect(parse({ name_pick: "keep", merchant: "Mine" })).toMatchObject({
			displayName: "Mine",
			keepBankName: false,
		});
		expect(parse({})).toMatchObject({ displayName: null, keepBankName: false });
	});

	it("settles a pending suggestion only when a person names the merchant", async () => {
		const id = await charge();
		await suggest(RAW, "Blue Bottle Coffee");
		const detail = await getTransaction(db, id);
		expect(detail?.nameChoices?.names).toEqual(["Blue Bottle Coffee"]);
		await saveEdit(
			db,
			id,
			{
				categoryId: null,
				alwaysForMerchant: false,
				displayName: "Blue Bottle Coffee",
				note: null,
				excluded: false,
				income: false,
				creditReviewed: false,
			},
			"tester",
		);
		expect(await merchant(RAW)).toMatchObject({
			display_name: "Blue Bottle Coffee",
			suggestion_status: "accepted",
		});
	});
});
