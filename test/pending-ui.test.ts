import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import type { ListRow } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { ICON_NAMES, Icon } from "../src/views/icons";
import { PendingNote } from "../src/views/pending-note";
import { TransactionRow } from "../src/views/transaction-row";

// P34 A (decision 72): "Pending" sits on the row's caption line, and the edit panel says the
// bank hasn't finished the charge, so its amount can still change.

const base: ListRow = {
	id: 7,
	date: "2026-10-04",
	amountCents: 2240,
	rawName: "TST* LUPITAS TAQ",
	displayName: "Lupita's Taqueria",
	note: null,
	excluded: false,
	income: false,
	creditReviewed: true,
	categoryId: null,
	categoryName: null,
	categoryIcon: null,
	categoryColor: null,
	pending: true,
};
const groceries = {
	categoryId: 1,
	categoryName: "Groceries",
	categoryIcon: "groceries",
	categoryColor: "cat-blue",
};

/** The pieces of text on a row's caption line, in order (the row's second line). */
async function caption(row: ListRow) {
	const html = await TransactionRow({ row }).toString();
	const line = html.match(
		/gap-2 leading-6">(.*?)<\/span><\/span><span class="shrink-0 text-lg">/s,
	)?.[1];
	return (line ?? "").split(/<[^>]+>/).filter(Boolean);
}

describe("Pending on a row's caption line", () => {
	it("follows the category, in muted words: Groceries · Pending", async () => {
		expect(await caption({ ...base, ...groceries })).toEqual([
			"Groceries",
			"· Pending",
		]);
		const html = await TransactionRow({
			row: { ...base, ...groceries },
		}).toString();
		expect(html).toContain(
			'<span class="shrink-0 text-muted">· Pending</span>',
		);
		// No new tag or color.
		expect(html).not.toContain("border-rule");
	});

	it("takes the bank text's place on a row that needs a category", async () => {
		expect(await caption(base)).toEqual(["Pending", "Needs category"]);
		const html = await TransactionRow({ row: base }).toString();
		expect(html).not.toContain("TST* LUPITAS TAQ");
		// Nothing to take the place of when the bank text is the name.
		expect(await caption({ ...base, displayName: base.rawName })).toEqual([
			"Pending",
			"Needs category",
		]);
	});

	it("reads Income · Pending on a pending credit marked as income", async () => {
		expect(
			await caption({ ...base, income: true, amountCents: -245000 }),
		).toEqual(["Income", "· Pending"]);
	});

	it.each([
		["Excluded", { excluded: true }, ["Pending ·", "Excluded"]],
		[
			"a split part",
			{ ...groceries, parentId: 9, parentName: "Costco" },
			["Pending ·", "Groceries · Split from Costco"],
		],
		[
			"a split purchase",
			{ ...groceries, isSplit: true },
			["Pending ·", "Split transaction"],
		],
		[
			"a linked refund",
			{
				...groceries,
				amountCents: -900,
				refundOfId: 3,
				refundPurchaseDate: "2026-10-01",
			},
			["Pending ·", "Groceries · Refund for Oct 1"],
		],
		[
			"a refunded purchase",
			{ ...groceries, refundedCents: 900 },
			["Pending ·", "Groceries · $9.00 refunded"],
		],
		[
			"a payment that counts in an earlier month",
			{ ...groceries, countsInMonth: "2026-09" },
			["Pending ·", "Groceries", "· Counts in September"],
		],
		[
			"a credit to review",
			{ amountCents: -2500, creditReviewed: false },
			["Pending ·", "Review credit"],
		],
		[
			"a bank-changed split",
			{ splitRemovedFromCents: 1234 },
			[
				"Pending ·",
				"The bank changed this from $12.34, so its split was removed.",
				"Needs category",
			],
		],
		[
			"a refund waiting on its purchase's category",
			{ refundOfId: 3, refundPurchaseDate: "2026-10-01" },
			["Pending ·", "Refund for Oct 1", "Needs category"],
		],
	] as const)(
		"goes first when the caption already says more: %s",
		async (_, change, expected) => {
			expect(await caption({ ...base, ...change } as ListRow)).toEqual([
				...expected,
			]);
		},
	);

	it("stays one caption line, and says nothing on a row that isn't pending", async () => {
		const html = await TransactionRow({
			row: { ...base, ...groceries },
		}).toString();
		expect(html.match(/gap-2 leading-6">/g)).toHaveLength(1);
		for (const row of [
			{ ...base, pending: false },
			{ ...base, pending: undefined },
			{ ...base, ...groceries, pending: false },
		]) {
			expect(await TransactionRow({ row }).toString()).not.toContain("Pending");
		}
		expect(await caption({ ...base, ...groceries, pending: false })).toEqual([
			"Groceries",
		]);
	});
});

describe("PendingNote", () => {
	it("says what pending means, with a clock that isn't announced", async () => {
		const html = await PendingNote().toString();
		expect(html.replace(/<[^>]+>/g, "").replaceAll("&#39;", "'")).toBe(
			"Pending. The bank hasn't finished it, so its amount can still change.",
		);
		expect(html).toContain('data-icon="clock"');
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain("text-muted");
	});

	it("uses an icon drawn like the others", async () => {
		expect(ICON_NAMES).toContain("clock");
		const html = await Icon({ name: "clock" }).toString();
		expect(html).toContain('stroke-width="1.75"');
		expect(html).toContain('stroke="currentColor"');
	});
});

const BASE = "http://tally.test";
const get = async (path: string) => {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
};
const words = (html: string) =>
	html.replace(/<[^>]+>/g, " ").replaceAll("&#39;", "'");

describe("pages for a pending transaction", () => {
	const NOTE =
		"Pending. The bank hasn't finished it, so its amount can still change.";
	const PENDING = 9001;
	const POSTED = 9002;
	beforeEach(async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		await resetDemo(env.DB, today);
		const insert = (id: number, name: string, pending: number) =>
			env.DB.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, pending) SELECT ?, id, ?, 1100, ?, 1, ? FROM accounts LIMIT 1",
			).bind(id, today, name, pending);
		await env.DB.batch([
			insert(PENDING, "PANTRY ONE", 1),
			insert(POSTED, "PANTRY TWO", 0),
		]);
	});

	it("lists it with Pending on its caption line, and only it", async () => {
		const { html } = await get("/transactions");
		const li = (id: number) =>
			html.match(
				new RegExp(`<li data-transaction="${id}">(.*?)</li>`, "s"),
			)?.[1] ?? "";
		expect(li(PENDING)).toContain("Pantry one");
		expect(li(PENDING)).toContain("· Pending");
		expect(li(POSTED)).toContain("Pantry two");
		expect(li(POSTED)).not.toContain("Pending");
	});

	it("lists it in select mode too", async () => {
		const { html } = await get("/transactions?select=1");
		expect(html).toContain("· Pending");
	});

	it("says in its edit panel, under the date, that the bank hasn't finished it", async () => {
		const { html } = await get(`/transactions/${PENDING}`);
		const text = words(html).replace(/\s+/g, " ");
		expect(text).toMatch(
			/Today, [A-Z][a-z]{2} \d{1,2} · .{1,60}? Pending\. The bank/,
		);
		expect(text).toContain(NOTE);
		expect(html).toContain('data-icon="clock"');
		const other = await get(`/transactions/${POSTED}`);
		expect(other.html).not.toContain("Pending. The bank");
		expect(other.html).not.toContain('data-icon="clock"');
	});
});
