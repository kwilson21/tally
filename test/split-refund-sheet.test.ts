import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;
const BASE = "http://tally.test";
const GROCERIES = 1;
const KIDS = 4;
const HOUSEHOLD = 5;
const PURCHASE = 9201;
/** $45.00 on Sep 5, and $20.00 on Sep 6: both refund the purchase. */
const FIRST = 9202;
const SECOND = 9203;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare(`INSERT INTO transactions
			(id, account_id, date, amount_cents, raw_name, category_id, category_source, is_split, parent_id) VALUES
			(${PURCHASE}, 3, '2026-09-01', 10000, 'WAREHOUSE CLUB', ${GROCERIES}, 'user', 0, NULL)`),
		db.prepare(`INSERT INTO transactions
			(id, account_id, date, amount_cents, raw_name, category_id, category_source, is_split, parent_id, refund_of_id, credit_reviewed, credit_reviewed_by) VALUES
			(${FIRST}, 3, '2026-09-05', -4500, 'WAREHOUSE CLUB', ${GROCERIES}, 'user', 0, NULL, ${PURCHASE}, 1, 'user'),
			(${SECOND}, 3, '2026-09-06', -2000, 'WAREHOUSE CLUB', ${GROCERIES}, 'user', 0, NULL, ${PURCHASE}, 1, 'user')`),
	]);
});

/** The page's HTML with the apostrophes an escaped alert carries written back as they read. */
const readable = (html: string) => html.replace(/&#39;/g, "'");

const linkOf = async (id: number) =>
	(
		await db
			.prepare("SELECT refund_of_id AS r FROM transactions WHERE id = ?")
			.bind(id)
			.first<{ r: number | null }>()
	)?.r ?? null;

const partCount = async () =>
	(
		await db
			.prepare("SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?")
			.bind(PURCHASE)
			.first<{ n: number }>()
	)?.n ?? 0;

async function post(path: string, fields: [string, string][]) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		headers: {
			Origin: BASE,
			"HX-Request": "true",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(fields),
	});
	return { res, html: readable(await res.text()) };
}

const parts = (...refunds: [string, string][]): [string, string][] => [
	["part_category", String(KIDS)],
	["part_category", String(HOUSEHOLD)],
	["part_amount", "60.00"],
	["part_amount", "40.00"],
	["back", "/transactions"],
	...refunds,
];

describe("the split sheet asks which part a linked refund goes with", () => {
	it("shows a chooser under the parts for each linked refund, with nothing chosen", async () => {
		const res = await exports.default.fetch(
			`${BASE}/transactions/${PURCHASE}/split?back=%2Ftransactions`,
		);
		const html = readable(await res.text());
		expect(html).toContain("The refund on Sep 5 goes with");
		expect(html).toContain("The refund on Sep 6 goes with");
		expect(html).toContain('name="refund_9202"');
		expect(html).toContain("Not linked");
		expect(html).not.toMatch(/name="refund_9202"[^>]*checked/);
		expect(html).not.toMatch(/name="refund_9203"[^>]*checked/);
	});

	it("refuses a save with a refund left unanswered, in words, and saves nothing", async () => {
		const { res, html } = await post(
			`/transactions/${PURCHASE}/split`,
			parts(["refund_9203", "none"]),
		);
		expect(res.status).toBe(422);
		expect(html).toContain('role="alert"');
		expect(html).toContain(
			"Pick which part the refund on Sep 5 goes with, or Not linked.",
		);
		expect(await linkOf(FIRST)).toBe(PURCHASE);
		expect(await partCount()).toBe(0);
	});

	it("refuses a part too small for the refund chosen for it, and saves nothing", async () => {
		const { res, html } = await post(
			`/transactions/${PURCHASE}/split`,
			parts(["refund_9202", "1"], ["refund_9203", "none"]),
		);
		expect(res.status).toBe(422);
		expect(html).toContain(
			"The refund is $45.00, so it can't go with Household's $40.00.",
		);
		expect(await linkOf(FIRST)).toBe(PURCHASE);
		expect(await partCount()).toBe(0);
	});

	it("keeps the refund on the part it is chosen for and says so in the toast", async () => {
		const { res } = await post(
			`/transactions/${PURCHASE}/split`,
			parts(["refund_9202", "0"], ["refund_9203", "none"]),
		);
		expect(res.status).toBe(200);
		const trigger = JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
			toast: { message: string };
		};
		expect(trigger.toast.message).toContain(
			"The refund on Sep 5 now counts with Kids.",
		);
		expect(trigger.toast.message).toContain(
			"The refund on Sep 6 is no longer linked.",
		);
		const kids = await db
			.prepare(
				"SELECT id FROM transactions WHERE parent_id = ? AND category_id = ?",
			)
			.bind(PURCHASE, KIDS)
			.first<{ id: number }>();
		expect(await linkOf(FIRST)).toBe(kids?.id);
		expect(await linkOf(SECOND)).toBeNull();
	});

	it("redraws the chooser out of band with the part labels and the answers given", async () => {
		const { res, html } = await post(`/transactions/${PURCHASE}/split/line`, [
			["part_category", String(KIDS)],
			["part_category", String(HOUSEHOLD)],
			["part_amount", "60.00"],
			["part_amount", "40.00"],
			["refund_9202", "1"],
		]);
		expect(res.status).toBe(200);
		expect(html).toContain('id="refund-choices"');
		expect(html).toContain('hx-swap-oob="true"');
		expect(html).toContain("Kids · $60.00");
		expect(html).toContain("Household · $40.00");
		expect(html).toMatch(/name="refund_9202"[^>]*value="1"[^>]*checked/);
	});

	it("shows no chooser when a split cash entry's parts change (Change the parts)", async () => {
		await saveSplit(
			db,
			PURCHASE,
			[
				{ categoryId: KIDS, amountCents: 6000 },
				{ categoryId: HOUSEHOLD, amountCents: 4000 },
			],
			"test",
			{ [FIRST]: 0 },
		);
		const cash = await db
			.prepare("SELECT id FROM accounts WHERE type = 'cash' LIMIT 1")
			.first<{ id: number }>();
		await db
			.prepare("UPDATE transactions SET account_id = ? WHERE id = ?")
			.bind(cash?.id ?? 0, PURCHASE)
			.run();
		const res = await exports.default.fetch(
			`${BASE}/transactions/${PURCHASE}/split?back=%2Ftransactions&total=12000`,
		);
		const html = readable(await res.text());
		expect(res.status).toBe(200);
		expect(html).toContain("Change them to match");
		expect(html).not.toContain("goes with");
	});
});
