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

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchants"),
	]);
});

describe("the Transactions list", () => {
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

	it("with the names switch off shows the tidied bank text, and the suggestion comes back when it is on", async () => {
		const id = await charge();
		await suggest(RAW, "Blue Bottle Coffee");
		await saveAiSwitches(db, { names: false });
		expect(await rowOf(id)).toMatchObject({
			displayName: "Blue bottle cof",
			nameSuggested: false,
		});
		await saveAiSwitches(db, { names: true });
		expect(await rowOf(id)).toMatchObject({
			displayName: "Blue Bottle Coffee",
			nameSuggested: true,
		});
	});

	it("draws a suggested name dashed, with the sparkles icon and the words for a screen reader (P87 B), and a chosen name plain", async () => {
		await charge();
		await suggest(RAW, "Blue Bottle Coffee");
		await charge("LOCAL SHOP 99");
		const named = await charge("NAMED SHOP 7");
		await suggest("NAMED SHOP 7", "A Guess", "pending", "Mine");
		expect(named).toBeGreaterThan(0);
		const { html } = await get("/transactions?month=all");
		// The icon and "Tally's guess" come before the dashed name; only the one suggested row has them.
		expect(html).toMatch(
			/<svg[^>]*>.*?<\/svg><span class="sr-only">Tally&#39;s guess: <\/span><span class="[^"]*decoration-dashed[^"]*">Blue Bottle Coffee<\/span>/,
		);
		expect(html.match(/decoration-dashed/g)).toHaveLength(1);
		expect(html.match(/Tally&#39;s guess: /g)).toHaveLength(1);
		expect(html).toContain(">Mine<");
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

	it("with the names switch off offers no names and keeps the rename field", async () => {
		const id = await charge();
		await suggest(RAW, "Blue Bottle Coffee");
		await saveAiSwitches(db, { names: false });
		const { html } = await get(`/transactions/${id}`);
		expect(html).not.toContain('name="name_pick"');
		expect(html).not.toContain("Tally&#39;s guess");
		expect(html).toMatch(/<label[^>]*>Merchant name<\/label>/);
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
