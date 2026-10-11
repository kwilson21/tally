import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchBillPayments } from "../src/bills/match";
import { loadPriceOffers } from "../src/bills/price-change";
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

	it("shows $15.49 for September and $17.99 for October and November on the bill's page", async () => {
		await post(`/bills/${BILL}`, netflixForm("17.99", categoryId));
		const page = await get(`/bills/${BILL}`);
		expect(page).toContain("September · $15.49");
		expect(page).toContain("October · $17.99");
		expect(page).toContain("November · $17.99");
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
			},
		);
		expect(res.headers.get("HX-Trigger")).toContain("Bill updated to $17.99");
		expect(await get(`/bills/${id}`)).toContain(
			"Price went up to $17.99 in October",
		);
		expect(await get(`/bills/${id}`)).toContain("September · $15.49");
	});
});
