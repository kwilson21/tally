import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import { listTransactions } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { parseFilters } from "../src/transactions/filters";

// A name a person gives one transaction only (decision 101, spec §5 and §7): "This one only" leaves the
// merchant's name, its suggestions and the other transactions alone; "All" renames the merchant for the
// transactions that have no own name of their own.

const db = env.DB;
const BASE = "http://tally.test";
const AMAZON = "AMAZON MKTPL*2K4";
const RAW = "SQ *BLUE BOTTLE COF 0412";

async function post(
	path: string,
	fields: Record<string, string>,
	htmx = false,
) {
	const form = new URLSearchParams(fields);
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

const save = (id: number, fields: Record<string, string>) =>
	post(`/transactions/${id}`, { back: "/transactions?month=all", ...fields });

async function charge(
	rawName: string,
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

const suggest = (key: string, names: string) =>
	db
		.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
		)
		.bind(key, names)
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

/** Three Amazon purchases, the merchant named Amazon: a (newest), b and c. */
async function amazon() {
	await db
		.prepare(
			"INSERT INTO merchants (raw_name, display_name) VALUES ('Amazon', 'Amazon')",
		)
		.run();
	const a = await charge(AMAZON, "Amazon", "2026-10-02");
	const b = await charge(AMAZON, "Amazon", "2026-09-20");
	const c = await charge(AMAZON, "Amazon", "2026-09-18");
	return { a, b, c };
}

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchants"),
	]);
	await saveAiSwitches(db, { details: false });
});

describe("a name for one transaction (decision 101)", () => {
	it("This one only renames one Amazon row to Dog bed, and the other Amazon rows still say Amazon", async () => {
		const { a, b } = await amazon();
		const { res } = await save(a, {
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
		});
		expect(res.status).toBe(303);
		expect((await rowOf(a))?.displayName).toBe("Dog bed");
		expect((await rowOf(b))?.displayName).toBe("Amazon");
		expect(await merchant("Amazon")).toMatchObject({ display_name: "Amazon" });
	});

	it("All renames the merchant but not a row with its own name", async () => {
		const { a, b, c } = await amazon();
		await save(a, { name_pick: "own", merchant: "Dog bed", name_scope: "one" });
		await save(c, { name_pick: "own", merchant: "Prime", name_scope: "all" });
		expect(await merchant("Amazon")).toMatchObject({ display_name: "Prime" });
		expect((await rowOf(a))?.displayName).toBe("Dog bed");
		expect((await rowOf(b))?.displayName).toBe("Prime");
		expect((await rowOf(c))?.displayName).toBe("Prime");
	});

	it("All from a row with its own name replaces that row's name too (this one too)", async () => {
		const { a, b } = await amazon();
		await save(a, { name_pick: "own", merchant: "Dog bed", name_scope: "one" });
		await save(a, { name_pick: "own", merchant: "Prime", name_scope: "all" });
		expect((await rowOf(a))?.displayName).toBe("Prime");
		expect((await rowOf(b))?.displayName).toBe("Prime");
	});

	it("All with the merchant's own name typed still replaces this row's own name", async () => {
		const { a, b } = await amazon();
		await save(a, { name_pick: "own", merchant: "Dog bed", name_scope: "one" });
		// The panel drew the name field as "Amazon" and the person left it there, ticking Type your own.
		const { res } = await post(
			`/transactions/${a}`,
			{
				back: "/transactions?month=all",
				name_pick: "own",
				merchant: "Amazon",
				merchant_was: "Amazon",
				name_scope: "all",
			},
			true,
		);
		expect(toastOf(res)).toBe("Saved Amazon");
		expect((await rowOf(a))?.displayName).toBe("Amazon");
		expect((await rowOf(b))?.displayName).toBe("Amazon");
		expect(await merchant("Amazon")).toMatchObject({ display_name: "Amazon" });
	});

	it("finds a row by its own name and by the bank's text", async () => {
		const { a } = await amazon();
		await save(a, { name_pick: "own", merchant: "Dog bed", name_scope: "one" });
		expect(await found("dog bed")).toEqual([a]);
		expect(await found("MKTPL")).toContain(a);
	});

	it("keeps a suggested name waiting when it is chosen for This one only", async () => {
		const id = await charge(RAW);
		const other = await charge(RAW, null, "2026-09-18");
		await suggest(RAW, "Blue Bottle Coffee\nBlue Bottle");
		await save(id, { name_pick: "s:Blue Bottle", name_scope: "one" });
		expect(await merchant(RAW)).toEqual({
			display_name: null,
			suggested_name: "Blue Bottle Coffee\nBlue Bottle",
			suggestion_status: "pending",
		});
		expect(await rowOf(id)).toMatchObject({
			displayName: "Blue Bottle",
			nameSuggested: false,
		});
		expect(await rowOf(other)).toMatchObject({
			displayName: "Blue Bottle Coffee",
			nameSuggested: true,
		});
	});

	it("Looks right with nothing ticked confirms the store's guess for all, whatever scope the hidden list posted", async () => {
		const id = await charge(RAW);
		const other = await charge(RAW, null, "2026-09-18");
		await suggest(RAW, "Blue Bottle Coffee");
		await save(id, {
			details_action: "keep",
			displayed_name_guess: "Blue Bottle Coffee",
			name_scope: "one",
		});
		expect(await merchant(RAW)).toMatchObject({
			display_name: "Blue Bottle Coffee",
			suggestion_status: "accepted",
		});
		expect((await rowOf(other))?.displayName).toBe("Blue Bottle Coffee");
	});

	it("Looks right with a name ticked saves it for This one only, as Save does", async () => {
		const id = await charge(RAW);
		const other = await charge(RAW, null, "2026-09-18");
		await suggest(RAW, "Blue Bottle Coffee");
		await save(id, {
			name_pick: "s:Blue Bottle Coffee",
			name_scope: "one",
			details_action: "keep",
			displayed_name_guess: "Blue Bottle Coffee",
		});
		expect(await merchant(RAW)).toEqual({
			display_name: null,
			suggested_name: "Blue Bottle Coffee",
			suggestion_status: "pending",
		});
		expect(await rowOf(id)).toMatchObject({
			displayName: "Blue Bottle Coffee",
			nameSuggested: false,
		});
		expect(await rowOf(other)).toMatchObject({
			displayName: "Blue Bottle Coffee",
			nameSuggested: true,
		});
	});

	it("a guess that is no longer offered does not rename the merchant when Looks right is kept", async () => {
		const id = await charge(RAW);
		await suggest(RAW, "Blue Bottle Co");
		// The panel was drawn with "Blue Bottle Coffee" as the guess; another tab settled the suggestions since.
		await save(id, {
			details_action: "keep",
			displayed_name_guess: "Blue Bottle Coffee",
			name_scope: "all",
		});
		expect(await merchant(RAW)).toEqual({
			display_name: null,
			suggested_name: "Blue Bottle Co",
			suggestion_status: "pending",
		});
	});

	it("a guess that was drawn before the merchant was named does not rename it", async () => {
		const id = await charge(RAW);
		await suggest(RAW, "Blue Bottle Coffee");
		// Another tab names the merchant after this panel was drawn with the guess showing.
		await db
			.prepare(
				"UPDATE merchants SET display_name = 'Blue Bottle' WHERE raw_name = ?",
			)
			.bind(RAW)
			.run();
		await save(id, {
			details_action: "keep",
			displayed_name_guess: "Blue Bottle Coffee",
			name_scope: "one",
		});
		expect(await merchant(RAW)).toMatchObject({
			display_name: "Blue Bottle",
		});
	});

	it("the toast names the store's own name for This one only, and the row shows it", async () => {
		const { a } = await amazon();
		const { res } = await post(
			`/transactions/${a}`,
			{
				back: "/transactions?month=all",
				name_pick: "store",
				name_scope: "one",
			},
			true,
		);
		expect(toastOf(res)).toBe("Saved Amazon mktpl");
		expect((await rowOf(a))?.displayName).toBe("Amazon mktpl");
	});

	it("the store's own name for All clears a named merchant, and the toast says the tidied text the rows now show", async () => {
		const { a, b } = await amazon();
		const { res } = await post(
			`/transactions/${a}`,
			{
				back: "/transactions?month=all",
				name_pick: "store",
				name_scope: "all",
			},
			true,
		);
		expect(toastOf(res)).toBe("Saved Amazon mktpl");
		expect(await merchant("Amazon")).toMatchObject({ display_name: null });
		expect((await rowOf(a))?.displayName).toBe("Amazon mktpl");
		expect((await rowOf(b))?.displayName).toBe("Amazon mktpl");
	});

	it("the store's own name for All turns a suggestion down and shows the tidied text", async () => {
		const id = await charge(RAW);
		await suggest(RAW, "Blue Bottle Coffee");
		const { res } = await post(
			`/transactions/${id}`,
			{
				back: "/transactions?month=all",
				name_pick: "store",
				name_scope: "all",
			},
			true,
		);
		expect(toastOf(res)).toBe("Saved Blue bottle cof");
		expect(await merchant(RAW)).toMatchObject({
			display_name: null,
			suggestion_status: "rejected",
		});
		expect((await rowOf(id))?.displayName).toBe("Blue bottle cof");
	});

	it("a save with nothing ticked names a named merchant in the toast and announcement", async () => {
		const { a } = await amazon();
		const { res } = await post(
			`/transactions/${a}`,
			{ back: "/transactions?month=all", note: "Dinner" },
			true,
		);
		expect(toastOf(res)).toBe("Saved Amazon");
		expect(announceOf(res)).toBe("Saved Amazon.");
	});

	it("Looks right with nothing ticked names a row with its own name in the toast, and changes no name", async () => {
		const { a, b } = await amazon();
		await db
			.prepare("UPDATE transactions SET own_name = 'Dog bed' WHERE id = ?")
			.bind(a)
			.run();
		const { res } = await post(
			`/transactions/${a}`,
			{
				back: "/transactions?month=all",
				details_action: "keep",
				name_scope: "all",
			},
			true,
		);
		expect(toastOf(res)).toBe("Kept details for Dog bed");
		expect(await merchant("Amazon")).toMatchObject({ display_name: "Amazon" });
		expect((await rowOf(a))?.displayName).toBe("Dog bed");
		expect((await rowOf(b))?.displayName).toBe("Amazon");
	});

	it("the store's own name under This one only names a row that had its own name, with the bank's text, and the toast says so", async () => {
		const id = await charge(RAW);
		await save(id, {
			name_pick: "own",
			merchant: "Dog bed",
			name_scope: "one",
		});
		const { res } = await post(
			`/transactions/${id}`,
			{
				back: "/transactions?month=all",
				name_pick: "store",
				name_scope: "one",
			},
			true,
		);
		expect(toastOf(res)).toBe("Saved Blue bottle cof");
		expect(announceOf(res)).toBe("Saved Blue bottle cof.");
		expect((await rowOf(id))?.displayName).toBe("Blue bottle cof");
	});

	it("a save with nothing ticked names a row with its own name in the toast, not the bank's text", async () => {
		const { a } = await amazon();
		await db
			.prepare("UPDATE transactions SET own_name = 'Dog bed' WHERE id = ?")
			.bind(a)
			.run();
		const { res } = await post(
			`/transactions/${a}`,
			{ back: "/transactions?month=all", note: "Dinner" },
			true,
		);
		expect(toastOf(res)).toBe("Saved Dog bed");
		expect(announceOf(res)).toBe("Saved Dog bed.");
		expect((await rowOf(a))?.displayName).toBe("Dog bed");
	});

	it("All's notes list a split part with its own name, and the count leaves the part out", async () => {
		const { b, c } = await amazon();
		await db
			.prepare("UPDATE transactions SET is_split = 1 WHERE id = ?")
			.bind(c)
			.run();
		await db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, parent_id, own_name)
				 VALUES (1, '2026-09-18', 325, ?, 'Amazon', ?, 'Dog bed')`,
			)
			.bind(AMAZON, c)
			.run();
		const html = await (
			await exports.default.fetch(`${BASE}/transactions/${b}?month=all`)
		).text();
		expect(html).toContain("Dog bed (Sep 18) keeps its own name.");
		expect(html).toContain("All 3 from Amazon");
	});

	it("a split's parts show the own name of the purchase they came from", async () => {
		const { a } = await amazon();
		await save(a, { name_pick: "own", merchant: "Dog bed", name_scope: "one" });
		await db
			.prepare("UPDATE transactions SET is_split = 1 WHERE id = ?")
			.bind(a)
			.run();
		const part = await db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, parent_id)
				 VALUES (1, '2026-10-02', 650, ?, ?) RETURNING id`,
			)
			.bind(AMAZON, a)
			.first<{ id: number }>();
		expect((await rowOf(part?.id as number))?.displayName).toBe("Dog bed");
	});

	it("the Name row says the bank's text only for a bank row, not for a cash entry", async () => {
		const cash = await db
			.prepare("SELECT id FROM accounts WHERE type = 'cash' LIMIT 1")
			.first<{ id: number }>();
		const id = (await db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name)
				 VALUES (?, '2026-09-20', 2045, 'Farmers market') RETURNING id`,
			)
			.bind(cash?.id)
			.first<{ id: number }>()) as { id: number };
		const html = await (
			await exports.default.fetch(`${BASE}/transactions/${id.id}?month=all`)
		).text();
		expect(html).toContain('value="store"');
		expect(html).not.toContain("The bank says");
	});

	it("The store's own name under This one only names this row with the bank's text, and the merchant keeps its name", async () => {
		const { a, b } = await amazon();
		const { res } = await post(
			`/transactions/${a}`,
			{
				back: "/transactions?month=all",
				name_pick: "store",
				name_scope: "one",
			},
			true,
		);
		expect(res.status).toBe(200);
		expect(toastOf(res)).toBe("Saved Amazon mktpl");
		expect((await rowOf(a))?.displayName).toBe("Amazon mktpl");
		expect((await rowOf(b))?.displayName).toBe("Amazon");
		expect(await merchant("Amazon")).toMatchObject({ display_name: "Amazon" });
	});

	it("The store's own name under This one only names this row and leaves a suggested name waiting", async () => {
		const id = await charge(RAW);
		const other = await charge(RAW, null, "2026-09-18");
		await suggest(RAW, "Blue Bottle Coffee\nBlue Bottle");
		const { res } = await post(
			`/transactions/${id}`,
			{
				back: "/transactions?month=all",
				name_pick: "store",
				name_scope: "one",
			},
			true,
		);
		expect(toastOf(res)).toBe("Saved Blue bottle cof");
		expect(await merchant(RAW)).toEqual({
			display_name: null,
			suggested_name: "Blue Bottle Coffee\nBlue Bottle",
			suggestion_status: "pending",
		});
		expect(await rowOf(id)).toMatchObject({
			displayName: "Blue bottle cof",
			nameSuggested: false,
		});
		expect(await rowOf(other)).toMatchObject({
			displayName: "Blue Bottle Coffee",
			nameSuggested: true,
		});
	});

	it("The store's own name under This one only still names this row when the names switch is off, and turns no suggestion down", async () => {
		await saveAiSwitches(db, { names: false });
		const id = await charge(RAW);
		await suggest(RAW, "Blue Bottle Coffee");
		await post(
			`/transactions/${id}`,
			{
				back: "/transactions?month=all",
				name_pick: "store",
				name_scope: "one",
			},
			true,
		);
		expect((await rowOf(id))?.displayName).toBe("Blue bottle cof");
		expect(await merchant(RAW)).toMatchObject({
			suggestion_status: "pending",
		});
	});
});

/** The toast message a save sends with its HTMX response. */
function toastOf(res: Response): string | undefined {
	const trigger = JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
		toast?: { message?: string };
	};
	return trigger.toast?.message;
}

/** The announcement a save sends with its HTMX response. */
function announceOf(res: Response): string | undefined {
	const trigger = JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
		announce?: string;
	};
	return trigger.announce;
}
