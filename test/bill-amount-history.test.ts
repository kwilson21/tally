import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchBillPayments } from "../src/bills/match";
import { acceptPriceOffer, loadPriceOffers } from "../src/bills/price-change";
import { type BillFields, insertBill, updateBill } from "../src/bills/write";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { loadBillRows } from "../src/routes/bills";

// Spec §5 `bill_amounts`, §8.4 and decision 101: a bill's amount from a month on. Editing it writes this
// month's row, earlier months keep theirs, and the bill's page, its edit sheet and its payment matching
// all read the amount of each occurrence's own month.

const BASE = "http://tally.test";
const TODAY = "2026-10-10";
const BILL = 9501;

const post = (path: string, body: Record<string, string>) =>
	exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"HX-Request": "true",
			Origin: BASE,
		},
		body: new URLSearchParams(body),
	});
const get = async (path: string) =>
	(await exports.default.fetch(BASE + path)).text();

/** The form a person submits for the Netflix fixture, with the amount they type. */
const netflixForm = (amount: string, categoryId: number) => ({
	name: "Netflix",
	amount,
	due_day: "2",
	frequency: "monthly",
	anchor_month: "1",
	category_id: String(categoryId),
	merchant_raw_name: "NETFLIX.COM",
});

async function amountRows() {
	const { results } = await env.DB.prepare(
		"SELECT effective_month AS effectiveMonth, amount_cents AS amountCents FROM bill_amounts WHERE bill_id=? ORDER BY effective_month",
	)
		.bind(BILL)
		.all<{ effectiveMonth: string; amountCents: number }>();
	return results;
}

/** The ledger row that names a month, as a whole word: its name and its muted words (#604). */
const monthRow = (html: string, month: string) =>
	(html.split("<li").find((item) => item.includes(`>${month}<`)) ?? "").split(
		"</li>",
	)[0] ?? "";

describe("a bill's amount history", () => {
	let categoryId = 0;

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-10T16:00:00Z"));
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.prepare("DELETE FROM bills").run();
		categoryId =
			(
				await env.DB.prepare(
					"SELECT id FROM categories WHERE archived=0 ORDER BY id LIMIT 1",
				).first<{ id: number }>()
			)?.id ?? 0;
		// A $15.49 bill with its history from August, as migration 0044 would have written it.
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(?,'Netflix',1549,2,'monthly',?,'NETFLIX.COM')",
			).bind(BILL, categoryId),
			env.DB.prepare(
				"INSERT INTO bill_amounts(bill_id,effective_month,amount_cents) VALUES(?,'2026-08',1549)",
			).bind(BILL),
		]);
	});
	afterEach(() => vi.useRealTimers());

	it("writes this month's row when the amount changes, and earlier months keep theirs", async () => {
		const res = await post(`/bills/${BILL}`, netflixForm("17.99", categoryId));
		expect(res.headers.get("HX-Trigger")).toContain("Bill saved");
		expect(await amountRows()).toEqual([
			{ effectiveMonth: "2026-08", amountCents: 1549 },
			{ effectiveMonth: "2026-10", amountCents: 1799 },
		]);
		expect(
			await env.DB.prepare("SELECT amount_cents FROM bills WHERE id=?")
				.bind(BILL)
				.first("amount_cents"),
		).toBe(1799);
	});

	it("shows $17.99 for November's due amount, and October's charge at that price, on the bill's page", async () => {
		await post(`/bills/${BILL}`, netflixForm("17.99", categoryId));
		const page = await get(`/bills/${BILL}`);
		// A month's words carry its amount (P131 A, #604): an upcoming month its due amount, and a charge Tally
		// found for a month says the charge's amount. A month with no payment says only No payment.
		expect(monthRow(page, "November")).toContain("$17.99");
		expect(monthRow(page, "October")).toContain("A $17.99 charge");
	});

	it("replaces this month's row when the amount is edited twice in one month", async () => {
		await post(`/bills/${BILL}`, netflixForm("17.99", categoryId));
		await post(`/bills/${BILL}`, netflixForm("18.49", categoryId));
		expect(await amountRows()).toEqual([
			{ effectiveMonth: "2026-08", amountCents: 1549 },
			{ effectiveMonth: "2026-10", amountCents: 1849 },
		]);
	});

	it("writes no row for a save that keeps the amount", async () => {
		await post(`/bills/${BILL}`, netflixForm("15.49", categoryId));
		expect(await amountRows()).toEqual([
			{ effectiveMonth: "2026-08", amountCents: 1549 },
		]);
	});

	it("says a price went up, in the month it changed, under the amount line", async () => {
		await post(`/bills/${BILL}`, netflixForm("17.99", categoryId));
		expect(await get(`/bills/${BILL}`)).toContain(
			"Price went up to $17.99 in October",
		);
	});

	it("says a price went down, under the amount line", async () => {
		await post(`/bills/${BILL}`, netflixForm("14.99", categoryId));
		expect(await get(`/bills/${BILL}`)).toContain(
			"Price went down to $14.99 in October",
		);
	});

	it("says nothing about a change when the bill has never changed price", async () => {
		expect(await get(`/bills/${BILL}`)).not.toContain("Price went");
	});

	it("says Applies from October on, and names the price earlier months keep", async () => {
		const sheet = await get(`/bills/${BILL}/edit`);
		expect(sheet).toContain(
			"Applies from October on. Earlier months keep $15.49.",
		);
	});

	it("names the earlier price again after a second edit in October", async () => {
		await post(`/bills/${BILL}`, netflixForm("17.99", categoryId));
		const sheet = await get(`/bills/${BILL}/edit`);
		expect(sheet).toContain("Earlier months keep $15.49.");
		expect(sheet).not.toContain("Earlier months keep $17.99.");
	});

	it("leaves the line out when the bill has no earlier price", async () => {
		await env.DB.prepare("DELETE FROM bill_amounts WHERE bill_id=?")
			.bind(BILL)
			.run();
		await env.DB.prepare(
			"INSERT INTO bill_amounts(bill_id,effective_month,amount_cents) VALUES(?,'2026-10',1549)",
		)
			.bind(BILL)
			.run();
		expect(await get(`/bills/${BILL}/edit`)).not.toContain(
			"Earlier months keep",
		);
	});

	it("gives a new bill its first row at this month", async () => {
		await post("/bills", {
			name: "Gym",
			amount: "40.00",
			due_day: "9",
			frequency: "monthly",
			anchor_month: "1",
			category_id: String(categoryId),
			merchant_raw_name: "GYM CO",
		});
		const gym = await env.DB.prepare(
			"SELECT id FROM bills WHERE name='Gym'",
		).first<{ id: number }>();
		const rows = await env.DB.prepare(
			"SELECT effective_month AS effectiveMonth, amount_cents AS amountCents FROM bill_amounts WHERE bill_id=?",
		)
			.bind(gym?.id ?? 0)
			.all();
		expect(rows.results).toEqual([
			{ effectiveMonth: "2026-10", amountCents: 4000 },
		]);
	});

	it("matches each occurrence at its own month's amount", async () => {
		await post(`/bills/${BILL}`, netflixForm("17.99", categoryId));
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9501,1,'2026-09-02',1549,'NETFLIX.COM'),(9502,1,'2026-10-02',1799,'NETFLIX.COM')",
			),
		]);
		await matchBillPayments(env.DB, TODAY);
		const linked = await env.DB.prepare(
			"SELECT period, transaction_id AS transactionId FROM bill_payments WHERE bill_id=? AND status='linked' ORDER BY period",
		)
			.bind(BILL)
			.all();
		expect(linked.results).toEqual([
			{ period: "2026-09", transactionId: 9501 },
			{ period: "2026-10", transactionId: 9502 },
		]);
	});
});

describe("the demo's Netflix price history", () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-10T16:00:00Z"));
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	});
	afterEach(() => vi.useRealTimers());

	it("shows no price history until a visitor accepts the offer, then shows the change", async () => {
		const netflix = await env.DB.prepare(
			"SELECT id FROM bills WHERE name='Netflix'",
		).first<{ id: number }>();
		const id = netflix?.id ?? 0;
		expect(await get(`/bills/${id}`)).not.toContain("Price went");
		// The sheet names what earlier months keep: the demo's $15.49 from its first month.
		expect(await get(`/bills/${id}/edit`)).toContain(
			"Applies from October on. Earlier months keep $15.49.",
		);
		const rows = await loadBillRows(env.DB, "2026-10-10");
		const row = rows.rows.find((bill) => bill.id === id);
		const offer = (await loadPriceOffers(env.DB, rows.rows)).get(id);
		expect(row).toBeDefined();
		expect(offer).toBeDefined();
		const res = await post(
			`/bills/${id}/occurrences/${row?.period ?? ""}/price/accept`,
			{
				transaction_id: String(offer?.transactionId ?? 0),
				bill_cents: "1549",
				charge_cents: "1799",
				current_cents: "1549",
			},
		);
		expect(res.headers.get("HX-Trigger")).toContain("Bill updated to $17.99");
		expect(await get(`/bills/${id}`)).toContain(
			"Price went up to $17.99 in October",
		);
		expect(monthRow(await get(`/bills/${id}`), "October")).toContain("$17.99");
	});
});

/** Every bill and every amount row, as a snapshot a refused write must leave as it was. */
const snapshot = async () => ({
	bills: (
		await env.DB.prepare(
			"SELECT id, name, amount_cents AS amountCents, active FROM bills ORDER BY id",
		).all()
	).results,
	rows: (
		await env.DB.prepare(
			"SELECT bill_id AS billId, effective_month AS effectiveMonth, amount_cents AS amountCents FROM bill_amounts ORDER BY bill_id, effective_month",
		).all()
	).results,
});

describe("the writes keep a bill's amount rows with the bill", () => {
	let categoryId = 0;
	const rowsOf = async (billId: number) =>
		(
			await env.DB.prepare(
				"SELECT effective_month AS effectiveMonth, amount_cents AS amountCents FROM bill_amounts WHERE bill_id=? ORDER BY effective_month",
			)
				.bind(billId)
				.all<{ effectiveMonth: string; amountCents: number }>()
		).results;
	const amountOf = async (billId: number) =>
		(
			await env.DB.prepare("SELECT amount_cents FROM bills WHERE id=?")
				.bind(billId)
				.first<{ amount_cents: number }>()
		)?.amount_cents;
	const fields = (over: Partial<BillFields> = {}): BillFields => ({
		name: "Netflix",
		amountCents: 1549,
		dueDay: 2,
		frequency: "monthly",
		anchorMonth: null,
		categoryId,
		merchantRawName: "NETFLIX.COM",
		...over,
	});

	beforeEach(async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.prepare("DELETE FROM bills").run();
		categoryId =
			(
				await env.DB.prepare(
					"SELECT id FROM categories WHERE archived=0 ORDER BY id LIMIT 1",
				).first<{ id: number }>()
			)?.id ?? 0;
		// Netflix at $15.49, and an active "Water" and an inactive "Old phone plan", each with its first row.
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(?,'Netflix',1549,2,'monthly',?,'NETFLIX.COM')",
			).bind(BILL, categoryId),
			env.DB.prepare(
				"INSERT INTO bill_amounts(bill_id,effective_month,amount_cents) VALUES(?,'2026-08',1549)",
			).bind(BILL),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name,active) VALUES(9502,'Water',1000,5,'monthly',?,'CITY WATER',1)",
			).bind(categoryId),
			env.DB.prepare(
				"INSERT INTO bill_amounts(bill_id,effective_month,amount_cents) VALUES(9502,'2026-08',1000)",
			),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name,active) VALUES(9503,'Old phone plan',500,6,'monthly',?,'CARRIER',0)",
			).bind(categoryId),
			env.DB.prepare(
				"INSERT INTO bill_amounts(bill_id,effective_month,amount_cents) VALUES(9503,'2026-08',500)",
			),
		]);
	});

	it("rejects an add whose month the amount row can't hold, and leaves no bill behind", async () => {
		const before = await snapshot();
		await expect(
			insertBill(env.DB, fields({ name: "Gym" }), "2026-13-01"),
		).rejects.toThrow();
		expect(await snapshot()).toEqual(before);
	});

	it("refuses an add under an active bill's name, and writes no bill and no amount row", async () => {
		const before = await snapshot();
		expect(
			await insertBill(env.DB, fields({ name: " water " }), "2026-10-01"),
		).toBe(false);
		expect(await snapshot()).toEqual(before);
	});

	it("gives an add under an inactive bill's name its first row, and the inactive bill nothing new", async () => {
		expect(
			await insertBill(
				env.DB,
				fields({ name: "Old phone plan", amountCents: 3000 }),
				"2026-10-01",
			),
		).toBe(true);
		const added = await env.DB.prepare(
			"SELECT id FROM bills WHERE name='Old phone plan' AND active=1",
		).first<{ id: number }>();
		expect(await rowsOf(added?.id ?? 0)).toEqual([
			{ effectiveMonth: "2026-10", amountCents: 3000 },
		]);
		expect(await rowsOf(9503)).toEqual([
			{ effectiveMonth: "2026-08", amountCents: 500 },
		]);
	});

	it("writes this month's row with the amount in the same batch, when another write lands first", async () => {
		// A competing save lands between this save's read and its write: the bill and this month's row go to $17.99.
		const racing = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "batch")
					return async (statements: D1PreparedStatement[]) => {
						await env.DB.batch([
							env.DB.prepare(
								"UPDATE bills SET amount_cents=1799 WHERE id=?",
							).bind(BILL),
							env.DB.prepare(
								"INSERT INTO bill_amounts(bill_id,effective_month,amount_cents) VALUES(?,'2026-10',1799)",
							).bind(BILL),
						]);
						return env.DB.batch(statements);
					};
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as unknown as D1Database;
		expect(
			await updateBill(racing, BILL, fields({ dueDay: 5 }), false, "2026-10"),
		).toBe(true);
		expect(await amountOf(BILL)).toBe(1549);
		expect(await rowsOf(BILL)).toEqual([
			{ effectiveMonth: "2026-08", amountCents: 1549 },
			{ effectiveMonth: "2026-10", amountCents: 1549 },
		]);
	});

	it("writes no amount row for a save that keeps the amount", async () => {
		expect(
			await updateBill(env.DB, BILL, fields({ dueDay: 5 }), false, "2026-10"),
		).toBe(true);
		expect(await rowsOf(BILL)).toEqual([
			{ effectiveMonth: "2026-08", amountCents: 1549 },
		]);
	});

	it("writes no amount row for a save refused for a name another active bill has", async () => {
		const before = await snapshot();
		expect(
			await updateBill(
				env.DB,
				BILL,
				fields({ name: "water", amountCents: 1799 }),
				false,
				"2026-10",
			),
		).toBe(false);
		expect(await snapshot()).toEqual(before);
	});
});

describe("a price that moved after September went overdue", () => {
	// Netflix: $100.00 in September, $120.00 from October on. Its September charge of $115.00 is unpaid,
	// due September 28, and today is October 10, so September is the occurrence Bills shows, overdue.
	const SEPT = "2026-09";
	const offer = {
		transactionId: 9601,
		date: "2026-09-30",
		amountCents: 11500,
		merchant: "Netflix",
	};
	const linksOf = async () =>
		(
			await env.DB.prepare(
				"SELECT transaction_id AS transactionId FROM bill_payments WHERE bill_id=? AND status='linked' ORDER BY transaction_id",
			)
				.bind(BILL)
				.all()
		).results;
	const amountOf = async () =>
		(
			await env.DB.prepare("SELECT amount_cents FROM bills WHERE id=?")
				.bind(BILL)
				.first<{ amount_cents: number }>()
		)?.amount_cents;
	const rowsOf = async () =>
		(
			await env.DB.prepare(
				"SELECT effective_month AS effectiveMonth, amount_cents AS amountCents FROM bill_amounts WHERE bill_id=? ORDER BY effective_month",
			)
				.bind(BILL)
				.all()
		).results;
	const accept = (currentCents: string) =>
		post(`/bills/${BILL}/occurrences/${SEPT}/price/accept`, {
			transaction_id: String(offer.transactionId),
			bill_cents: "10000",
			charge_cents: "11500",
			current_cents: currentCents,
		});

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-10T16:00:00Z"));
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.prepare("DELETE FROM bills").run();
		const categoryId =
			(
				await env.DB.prepare(
					"SELECT id FROM categories WHERE archived=0 ORDER BY id LIMIT 1",
				).first<{ id: number }>()
			)?.id ?? 0;
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(?,'Netflix',12000,28,'monthly',?,'NETFLIX.COM')",
			).bind(BILL, categoryId),
			env.DB.prepare(
				"INSERT INTO bill_amounts(bill_id,effective_month,amount_cents) VALUES(?,'2026-09',10000),(?,'2026-10',12000)",
			).bind(BILL, BILL),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9601,1,'2026-09-30',11500,'NETFLIX.COM')",
			),
		]);
	});
	afterEach(() => vi.useRealTimers());

	it("refuses an accept made on a page that showed the old amount, and saves nothing", async () => {
		const rows = await rowsOf();
		const res = await accept("10000");
		expect(await res.text()).toContain("isn&#39;t on offer");
		expect(res.headers.get("HX-Trigger")).toBeNull();
		expect(await rowsOf()).toEqual(rows);
		expect(await amountOf()).toBe(12000);
		expect(await linksOf()).toEqual([]);
	});

	it("accepts the same charge once the page showed the bill's current amount", async () => {
		const res = await accept("12000");
		expect(res.headers.get("HX-Trigger")).toContain("Bill updated to $115.00");
		expect(await amountOf()).toBe(11500);
		expect(await rowsOf()).toEqual([
			{ effectiveMonth: "2026-09", amountCents: 10000 },
			{ effectiveMonth: "2026-10", amountCents: 11500 },
		]);
		expect(await linksOf()).toEqual([{ transactionId: 9601 }]);
	});

	it("draws the bill's current amount into the accept form, as whole cents", async () => {
		const page = await get(`/bills/${BILL}`);
		expect(page).toContain("charged $115.00");
		expect(page.match(/name="current_cents"/g)).toHaveLength(1);
		expect(page).toContain('name="current_cents" value="12000"');
	});

	it("acceptPriceOffer writes nothing when the bill's current amount is not the one seen", async () => {
		const rows = await rowsOf();
		expect(
			await acceptPriceOffer(
				env.DB,
				BILL,
				SEPT,
				offer,
				10000,
				SEPT,
				10000,
				"2026-10",
			),
		).toBe(false);
		expect(await rowsOf()).toEqual(rows);
		expect(await amountOf()).toBe(12000);
		expect(await linksOf()).toEqual([]);
	});

	it("shows the monthly share at the bill's current amount, and the overdue total at September's", async () => {
		const page = await get("/bills");
		expect(page).toContain("$120 a month in bills");
		const overdueGroup =
			page.split("<section").find((part) => part.includes(">Overdue</h2>")) ??
			"";
		expect(overdueGroup).toContain('<span class="ml-auto shrink-0">$100.00');
	});
});
