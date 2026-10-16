import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDemo } from "../src/demo/reset";

// A bill's page is a quiet ledger of months (P131 A, decision 121, #604): its head is P120 B's, each month is one
// ruled row with its status in muted words, a charge Tally found but nothing is linked to reads "looks like this"
// with Link it, and consecutive months with no payment fold into one row. No status is a filled pill.

const TODAY = "2026-10-16";
const BILL = 9604;
const PAGE = `http://tally.test/bills/${BILL}`;
const FOUND = 9602;

/** Streaming as the fixture has it: $2.99 a month on the 15th, paid by its own charge on Oct 15 (9601). */
async function setUp(...rows: D1PreparedStatement[]) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(`${TODAY}T16:00:00Z`));
	await resetDemo(env.DB, TODAY);
	await env.DB.batch([
		// The demo's own Apple charges would match this bill's merchant, so this fixture has none of its own.
		env.DB.prepare(
			"UPDATE transactions SET raw_name='DEMO OTHER', merchant_name=NULL WHERE raw_name LIKE 'APPLE%' OR merchant_name LIKE 'Apple%'",
		),
		env.DB.prepare("DELETE FROM bills"),
		env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(?,'Streaming',299,15,'monthly',5,'APPLE.COM/BILL')",
		).bind(BILL),
		charge(9601, "2026-10-15"),
		charge(FOUND, "2026-09-23"),
		link("2026-10", 9601),
		...rows,
	]);
}

function charge(id: number, date: string, raw = "APPLE.COM/BILL", cents = 299) {
	return env.DB.prepare(
		"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT ?,id,?,?,? FROM accounts WHERE type!='cash' LIMIT 1",
	).bind(id, date, cents, raw);
}

function link(period: string, transaction: number) {
	return env.DB.prepare(
		"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,?,'auto','linked')",
	).bind(BILL, period, transaction);
}

async function page() {
	return (await exports.default.fetch(PAGE)).text();
}

/** The `<li>` that holds a month's row, found by the month's name as a whole word, and nothing after it. */
function monthRow(html: string, month: string) {
	return (
		(html.split("<li").find((item) => item.includes(`>${month}<`)) ?? "").split(
			"</li>",
		)[0] ?? ""
	);
}

describe("a bill's page as a quiet ledger of months (#604)", () => {
	beforeEach(() => setUp());
	afterEach(() => vi.useRealTimers());

	it("draws the head as P120 B's: the name as the one headline, its amount in muted words, then the bank's text small", async () => {
		const html = await page();
		const name = html.indexOf(
			'<h1 id="page-title" class="font-serif text-3xl font-semibold tracking-tight">Streaming</h1>',
		);
		const amount = html.indexOf(
			'<p class="text-muted">$2.99 a month, due the 15th</p>',
		);
		const bank = html.indexOf(
			'<p class="text-sm text-muted">APPLE.COM/BILL</p>',
		);
		expect(name).toBeGreaterThan(-1);
		expect(amount).toBeGreaterThan(name);
		expect(bank).toBeGreaterThan(amount);
	});

	it("reads a paid month as one ruled row, Paid Oct 15 in muted words, that opens its payment and Not this one", async () => {
		const row = monthRow(await page(), "October");
		expect(row).toContain("Paid Oct 15 · $2.99");
		expect(row).toContain("<details");
		expect(row).toContain("Not this one");
		expect(row).toContain('data-icon="check"');
	});

	it("reads a charge Tally found but nothing is linked to as A $2.99 charge on Sep 23 looks like this, with Link it to the picker with that charge first", async () => {
		const row = monthRow(await page(), "September");
		expect(row).toContain("A $2.99 charge on Sep 23 looks like this");
		expect(row).toContain(
			`href="/bills/${BILL}/occurrences/2026-09/link?transaction_id=${FOUND}#payment-picker"`,
		);
		expect(row).toContain('class="text-accent">Link it</span>');
	});

	it("folds the consecutive months with no payment into one row, April to August, that says how many months it holds", async () => {
		const html = await page();
		const fold = html
			.split("<details")
			.find((part) => part.includes("April to August"));
		expect(fold).toBeDefined();
		expect(fold).toContain("No payment");
		expect(fold).toContain("5 months with no payment");
		for (const month of ["August", "July", "June", "May", "April"])
			expect(fold).toContain(`>${month}<`);
	});

	it("says each month inside the fold reads Link a payment in muted words, not terracotta", async () => {
		const html = await page();
		expect(html).not.toContain('text-accent">Link a payment');
		expect(html).toContain('text-sm text-muted">Link a payment');
	});

	it("words each open month with today's status, in muted type, and uses no filled status pill", async () => {
		const html = await page();
		expect(monthRow(html, "November")).toContain("Upcoming Nov 15 · $2.99");
		expect(monthRow(html, "December")).toContain("Upcoming Dec 15 · $2.99");
		expect(html).not.toContain("bg-band px-2");
		expect(html).not.toContain("Not paid");
	});

	it("links a later month to its picker, worded Upcoming as Bills words it", async () => {
		const december = monthRow(await page(), "December");
		expect(december).toContain(
			`href="/bills/${BILL}/occurrences/2026-12/link#payment-picker"`,
		);
		expect(december).toContain("Upcoming Dec 15 · $2.99");
	});

	it("words the current month Due within seven days, and links it to its picker", async () => {
		await setUp(
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9605,'Water',4000,20,'monthly',5,'DUE FIXTURE')",
			),
		);
		const october = monthRow(
			await (
				await exports.default.fetch("http://tally.test/bills/9605")
			).text(),
			"October",
		);
		expect(october).toContain("Due Oct 20 · $40.00");
		expect(october).toContain(
			'href="/bills/9605/occurrences/2026-10/link#payment-picker"',
		);
	});

	it("links each month inside the fold to its picker", async () => {
		const fold =
			(await page())
				.split("<details")
				.find((part) => part.includes("April to August")) ?? "";
		expect(fold).toContain(
			`href="/bills/${BILL}/occurrences/2026-07/link#payment-picker"`,
		);
	});

	it("marks each month link as a row a person opens, so j and k reach it, and leaves a fold's summary to Tab (#639)", async () => {
		const html = await page();
		expect(html).toMatch(
			/<a\b(?=[^>]*href="\/bills\/9604\/occurrences\/2026-12\/link#payment-picker")(?=[^>]*data-row="")/,
		);
		expect(html).toMatch(
			/<a\b(?=[^>]*href="\/bills\/9604\/occurrences\/2026-09\/link\?transaction_id=9602#payment-picker")(?=[^>]*data-row="")/,
		);
		expect(html).toMatch(
			/<a\b(?=[^>]*href="\/bills\/9604\/occurrences\/2026-07\/link#payment-picker")(?=[^>]*data-row="")/,
		);
		expect(html).not.toMatch(/<summary[^>]*data-row/);
	});

	it("keeps Edit bill, Deactivate and the Not this one footnote", async () => {
		const html = await page();
		expect(html).toContain(`href="/bills/${BILL}/edit"`);
		expect(html).toContain(`action="/bills/${BILL}/deactivate"`);
		expect(html).toContain("unlinks a payment, and Tally won");
	});
});

describe("a part-paid month on the ledger (#205, #604)", () => {
	afterEach(() => vi.useRealTimers());

	it("reads an earlier part-paid month as what it has, opens its payment, and offers Link another payment", async () => {
		await setUp(
			charge(9620, "2026-09-20", "APPLE.COM/BILL", 100),
			link("2026-09", 9620),
		);
		const row = monthRow(await page(), "September");
		expect(row).toContain("Part paid: $1 of $2.99");
		expect(row).toContain("Not this one");
		expect(row).toContain("Link another payment");
		expect(row).not.toContain("looks like this");
	});
});

describe("which charges a month offers as found (#604)", () => {
	afterEach(() => vi.useRealTimers());

	it("gives a single month with no payment its own row, not a fold", async () => {
		await setUp(
			link("2026-09", FOUND),
			charge(9611, "2026-07-15"),
			charge(9612, "2026-06-15"),
			charge(9613, "2026-05-15"),
			charge(9614, "2026-04-15"),
			link("2026-07", 9611),
			link("2026-06", 9612),
			link("2026-05", 9613),
			link("2026-04", 9614),
		);
		const html = await page();
		const row = monthRow(html, "August");
		expect(row).toContain("No payment");
		expect(row).not.toContain("<details");
		expect(html).not.toContain("April to August");
	});

	it("does not offer a charge the person said Not this one to for that month", async () => {
		await setUp(
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,'2026-09',?,'user','dismissed')",
			).bind(BILL, FOUND),
		);
		const html = await page();
		expect(html).not.toContain("looks like this");
		expect(html).toContain("April to September");
	});

	it("does not offer a same-merchant charge outside the manual window of any unpaid month", async () => {
		await setUp(charge(9630, "2026-03-01"));
		const html = await page();
		expect(html).not.toContain("transaction_id=9630");
		expect(html).toContain("April to August");
	});

	it("offers only a charge from the bill's own merchant", async () => {
		await setUp(
			env.DB.prepare("DELETE FROM transactions WHERE id=?").bind(FOUND),
			charge(FOUND, "2026-09-23", "NETFLIX"),
		);
		const html = await page();
		expect(html).not.toContain("looks like this");
		expect(html).toContain("April to September");
	});
});
