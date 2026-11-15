import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { present } from "./helpers/present";

// A Change the parts correction whose entry or parts changed since its sheet was drawn (#1110). The sheet's amount and
// parts are compared with the entry's as it is now; when they no longer match, the save is refused in words, like the
// refund refusals, and nothing is written. Only a race inside the batch itself is still an error.

const BASE = "http://tally.test";
const STALE =
	"This split changed while you were editing it, so nothing was saved. Close this sheet and open it again to see it as it is now.";

beforeEach(() => resetDemo(env.DB, "2026-09-22"));

const today = () => todayIn(DEFAULT_TIME_ZONE);

async function post(path: string, fields: [string, string][], htmx = true) {
	const headers: Record<string, string> = {
		Origin: BASE,
		"content-type": "application/x-www-form-urlencoded",
	};

	if (htmx) headers["HX-Request"] = "true";

	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		headers,
		body: new URLSearchParams(fields),
	});

	return { res, html: await res.text() };
}

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path, {
		headers: { Origin: BASE },
	});

	return { res, html: await res.text() };
}

const idByName = async (merchant: string) =>
	present(
		await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name=? ORDER BY id DESC LIMIT 1",
		)
			.bind(merchant)
			.first<{ id: number }>(),
	).id;

const partsOf = async (id: number) =>
	(
		await env.DB.prepare(
			"SELECT id, category_id AS categoryId, amount_cents AS amountCents FROM transactions WHERE parent_id=? ORDER BY id",
		)
			.bind(id)
			.all<{ id: number; categoryId: number; amountCents: number }>()
	).results;

/** The entry, its parts and every refund: what a refused correction must leave as it was. */
const stateOf = async (id: number) => ({
	parent: await env.DB.prepare(
		"SELECT amount_cents AS amountCents, is_split AS isSplit, date, note, excluded, kind FROM transactions WHERE id=?",
	)
		.bind(id)
		.first(),
	parts: await partsOf(id),
	refunds: (
		await env.DB.prepare(
			"SELECT id, refund_of_id AS refundOfId, amount_cents AS amountCents FROM transactions WHERE raw_name='Part refund' ORDER BY id",
		).all()
	).results,
	rows: await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first(),
});

/**
 * A $90.00 cash entry split into Groceries $60.00 (part A) and Household $30.00 (part B), with a $20.00 refund
 * linked to B.
 */
async function splitCash(merchant: string) {
	await post("/transactions/cash", [
		["date", today()],
		["amount", "90.00"],
		["merchant", merchant],
		["category", "1"],
	]);

	const id = await idByName(merchant);

	await saveSplit(
		env.DB,
		id,
		[
			{ amountCents: 6000, categoryId: 1 },
			{ amountCents: 3000, categoryId: 5 },
		],
		"demo",
	);

	const [a, b] = await partsOf(id);

	await env.DB.prepare(
		"INSERT INTO transactions (account_id,date,amount_cents,raw_name,refund_of_id,credit_reviewed) SELECT account_id,date,-2000,'Part refund',?,1 FROM transactions WHERE id=?",
	)
		.bind(present(b).id, id)
		.run();

	return { id, a: present(a).id, b: present(b).id };
}

/** Posts the correction sheet: by default a total of $100.00 over the saved $90.00, as the sheet drew it. */
const correction = (
	id: number,
	parts: [string, string, string][],
	{
		extra = [],
		total = "10000",
		amountWas = "9000",
		htmx = true,
	}: {
		extra?: [string, string][];
		total?: string;
		amountWas?: string;
		htmx?: boolean;
	} = {},
) =>
	post(
		`/transactions/${id}/split`,
		[
			["back", "/transactions"],
			["total", total],
			["amount_was", amountWas],
			...extra,
			...parts.flatMap(([partId, category, amount]): [string, string][] => [
				["part_id", partId],
				["part_category", category],
				["part_amount", amount],
			]),
		],
		htmx,
	);

const savedParts = (a: number, b: number): [string, string, string][] => [
	[String(a), "1", "60.00"],
	[String(b), "5", "40.00"],
];

/** A part that another save added to the entry after its sheet was drawn. */
const addPart = (id: number) =>
	env.DB.prepare(
		"INSERT INTO transactions (account_id,date,amount_cents,raw_name,merchant_name,category_id,category_source,parent_id,updated_by) SELECT account_id,date,1000,raw_name,merchant_name,1,'user',id,'demo' FROM transactions WHERE id=?",
	)
		.bind(id)
		.run();

/** The edit panel's hidden fields for entry `id`, without the fields the panel's own edits change. */
async function panelFields(id: number, edits: [string, string][]) {
	const { html } = await get(`/transactions/${id}?back=%2Ftransactions`);
	const start = html.indexOf(`action="/transactions/${id}"`);
	const end = html.indexOf(`action="/transactions/${id}/delete"`, start);

	return [
		...html
			.slice(start, end)
			.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g),
	]
		.map(([, name = "", value = ""]): [string, string] => [
			name,
			value.replaceAll("&amp;", "&").replaceAll("&quot;", '"'),
		])
		.filter(([name]) => !edits.some(([edit]) => edit === name));
}

const panelEdits: [string, string][] = [
	["date", today()],
	["amount", "100.00"],
	["name_pick", "own"],
	["merchant", "Corner Market"],
	["note", "Farmers market\nand bakery"],
	["excluded", "0"],
	["kind", "one_off"],
];

/** The pending edit a panel sends with Change the parts: its drawn fields and its own edits, as the sheet carries them. */
async function pendingEditOf(id: number) {
	const drawn = await panelFields(id, panelEdits);
	const sheet = await post(`/transactions/${id}`, [
		...drawn,
		...panelEdits,
		["change_parts", "1"],
	]);

	expect(sheet.res.status).toBe(200);

	return new URLSearchParams([...drawn, ...panelEdits]).toString();
}

describe("a Change the parts correction whose entry or parts changed since the sheet was drawn (#1110)", () => {
	it("is refused in words when the entry's amount changed since the sheet was drawn (htmx and plain)", async () => {
		const { id, a, b } = await splitCash("Amount moved");
		const before = await stateOf(id);

		// The #1098 case: the sheet was drawn at $100.00 over the entry's $90.00, and the entry is still $90.00.
		const htmx = await correction(id, savedParts(a, b), { amountWas: "10000" });

		expect(htmx.res.status).toBe(422);
		expect(htmx.html).toContain(STALE);
		expect(await stateOf(id)).toEqual(before);

		const plain = await correction(id, savedParts(a, b), {
			amountWas: "10000",
			htmx: false,
		});

		expect(plain.res.status).toBe(422);
		expect(plain.html).toContain(STALE);
		expect(await stateOf(id)).toEqual(before);
	});

	it.each([
		[
			"a saved part is missing",
			(a: number) => [
				[String(a), "1", "60.00"],
				["", "5", "40.00"],
			],
		],
		[
			"a part id that isn't one of its parts is posted",
			(a: number, b: number, foreign: number) => [
				[String(a), "1", "60.00"],
				[String(b), "5", "30.00"],
				[String(foreign), "2", "10.00"],
			],
		],
	] as const)(
		"is refused in words when %s (the parts changed before the batch)",
		async (_name, parts) => {
			const { id, a, b } = await splitCash("Parts moved");
			const foreign = present(
				await env.DB.prepare(
					"SELECT t.id FROM transactions t WHERE t.parent_id IS NULL AND t.is_split = 0 AND t.id <> ? ORDER BY t.id LIMIT 1",
				)
					.bind(id)
					.first<{ id: number }>(),
			).id;
			const before = await stateOf(id);

			const { res, html } = await correction(
				id,
				parts(a, b, foreign) as [string, string, string][],
			);

			expect(res.status).toBe(422);
			expect(html).toContain(STALE);
			expect(await stateOf(id)).toEqual(before);
		},
	);

	it("is refused in words when a part was added since the sheet was drawn, and writes nothing", async () => {
		const { id, a, b } = await splitCash("Part added");

		await addPart(id);
		const before = await stateOf(id);

		const { res, html } = await correction(id, savedParts(a, b));

		expect(res.status).toBe(422);
		expect(html).toContain(STALE);
		expect(await stateOf(id)).toEqual(before);
	});

	it("is refused in words through the edit panel's pending correction when the amount changed", async () => {
		const { id, a, b } = await splitCash("Panel amount");
		const pending = await pendingEditOf(id);
		const before = await stateOf(id);

		const { res, html } = await correction(id, savedParts(a, b), {
			amountWas: "10000",
			extra: [["pending_edit", pending]],
		});

		expect(res.status).toBe(422);
		expect(html).toContain(STALE);
		expect(await stateOf(id)).toEqual(before);
	});

	it("is refused in words through the edit panel's pending correction when a part was added", async () => {
		const { id, a, b } = await splitCash("Panel part");
		const pending = await pendingEditOf(id);

		await addPart(id);
		const before = await stateOf(id);

		const { res, html } = await correction(id, savedParts(a, b), {
			extra: [["pending_edit", pending]],
		});

		expect(res.status).toBe(422);
		expect(html).toContain(STALE);
		expect(await stateOf(id)).toEqual(before);
	});

	it("still saves a normal correction", async () => {
		const { id, a, b } = await splitCash("Normal save");

		const { res } = await correction(id, savedParts(a, b));

		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toContain("Saved split for Normal save.");
		expect(
			(
				await env.DB.prepare(
					"SELECT amount_cents AS amountCents FROM transactions WHERE id=?",
				)
					.bind(id)
					.first<{ amountCents: number }>()
			)?.amountCents,
		).toBe(10000);
	});

	it("keeps the refund refusals' sentences, and their statuses, as they were", async () => {
		const total = await splitCash("Refund total");
		const totalBefore = await stateOf(total.id);
		const refundTotal = await correction(
			total.id,
			[
				[String(total.a), "1", "10.00"],
				[String(total.b), "5", "5.00"],
			],
			{ total: "1500" },
		);

		expect(refundTotal.res.status).toBe(422);
		expect(refundTotal.html).toContain(
			"Linked refunds add up to $20.00, so the amount can&#39;t be less than that.",
		);
		expect(refundTotal.html).not.toContain(STALE);
		expect(await stateOf(total.id)).toEqual(totalBefore);

		const part = await splitCash("Refund part");
		const partBefore = await stateOf(part.id);
		const refundPart = await correction(
			part.id,
			[
				[String(part.a), "1", "80.00"],
				[String(part.b), "5", "10.00"],
			],
			{ total: "9000" },
		);

		expect(refundPart.res.status).toBe(422);
		expect(refundPart.html).toContain(
			"Linked refunds add up to $20.00, so part 2 can&#39;t be less than that.",
		);
		expect(refundPart.html).not.toContain(STALE);
		expect(await stateOf(part.id)).toEqual(partBefore);
	});

	it("keeps a bad parts sheet's own sentence, as it was", async () => {
		const { id, a, b } = await splitCash("Bad sheet");
		const before = await stateOf(id);

		const { res, html } = await correction(id, [
			[String(a), "1", "abc"],
			[String(b), "5", "40.00"],
		]);

		expect(res.status).toBe(422);
		expect(html).toContain("Enter an amount above $0 for part 1.");
		expect(html).not.toContain(STALE);
		expect(await stateOf(id)).toEqual(before);
	});
});
