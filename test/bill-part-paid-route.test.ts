import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";

// A bill paid in parts on its page and in its link picker (Phase 5, decision 101, #205): each payment has its
// own Not this one, a part-paid month says what it has, and the picker sorts by what's still unpaid.

const BASE = "http://tally.test";
const RENT = 9500;
const today = todayIn(DEFAULT_TIME_ZONE);
const PERIOD = today.slice(0, 7);
const DUE = `${PERIOD}-01`;

const post = (path: string, body?: Record<string, string>) =>
	exports.default.fetch(`${BASE}${path}`, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"HX-Request": "true",
			...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
		},
		body: body ? new URLSearchParams(body) : undefined,
	});
const get = async (path: string) =>
	(await exports.default.fetch(`${BASE}${path}`)).text();

const linkedIds = async () =>
	(
		await env.DB.prepare(
			"SELECT transaction_id AS id FROM bill_payments WHERE bill_id=? AND period=? AND status='linked' ORDER BY transaction_id",
		)
			.bind(RENT, PERIOD)
			.all<{ id: number }>()
	).results.map(({ id }) => id);
const dismissedIds = async () =>
	(
		await env.DB.prepare(
			"SELECT transaction_id AS id FROM bill_payments WHERE bill_id=? AND period=? AND status='dismissed' ORDER BY transaction_id",
		)
			.bind(RENT, PERIOD)
			.all<{ id: number }>()
	).results.map(({ id }) => id);

/** A $1,200 rent due on the 1st of this month, with `$600` paid by 9520 and three unclaimed payments to pick from. */
beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM bill_payments"),
		env.DB.prepare("DELETE FROM bills"),
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare(
			"INSERT INTO accounts(id,name,type,balance_cents) VALUES(1,'Checking','depository',0)",
		),
		env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(?,'Rent',120000,1,'monthly','HARBOR PROPERTY MGMT')",
		).bind(RENT),
		env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9520,1,?,60000,'HARBOR PROPERTY MGMT')",
		).bind(DUE),
		env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9520,'user','linked')",
		).bind(RENT, PERIOD),
		env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9521,1,?,65000,'SHOP A')",
		).bind(DUE),
		env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9522,1,?,120000,'SHOP B')",
		).bind(DUE),
		env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9523,1,?,59000,'SHOP C')",
		).bind(DUE),
	]);
});

describe("a part-paid rent on its page and in its picker", () => {
	it("says Part paid, lists the payment with Not this one, and offers Link another payment", async () => {
		const html = await get(`/bills/${RENT}`);
		expect(html).toContain("Part paid: $600 of $1,200");
		expect(html).toContain(
			`/bills/${RENT}/occurrences/${PERIOD}/link#payment-picker`,
		);
		expect(html).toContain("Link another payment");
		expect(html).toContain('name="transaction_id" value="9520"');
	});

	it("the picker lists the payment closest to what's left first ($600 left: $590, then $650, then $1,200)", async () => {
		const html = await get(`/bills/${RENT}/occurrences/${PERIOD}/link`);
		const at = (id: number) => html.indexOf(`value="${id}"`);
		expect(at(9523)).toBeGreaterThan(-1);
		expect(at(9523)).toBeLessThan(at(9521));
		expect(at(9521)).toBeLessThan(at(9522));
	});

	it("Not this one unlinks only the payment it names, and the month stays part paid", async () => {
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9521,'user','linked')",
		)
			.bind(RENT, PERIOD)
			.run();
		expect(await linkedIds()).toEqual([9520, 9521]);
		const res = await post(`/bills/${RENT}/occurrences/${PERIOD}/unlink`, {
			transaction_id: "9521",
		});
		expect(res.status).toBe(200);
		expect(await linkedIds()).toEqual([9520]);
		expect(await dismissedIds()).toEqual([9521]);
	});

	it("Not this one that names no payment is refused while the month holds two", async () => {
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9521,'user','linked')",
		)
			.bind(RENT, PERIOD)
			.run();
		expect(
			(await post(`/bills/${RENT}/occurrences/${PERIOD}/unlink`)).status,
		).toBe(404);
		expect(await linkedIds()).toEqual([9520, 9521]);
	});

	it("a month its two payments pay in full reads Paid in 2 payments, and offers no link", async () => {
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9522,'user','linked')",
		)
			.bind(RENT, PERIOD)
			.run();
		const html = await get(`/bills/${RENT}`);
		expect(html).toContain("Paid in 2 payments");
		expect(html).not.toContain("Part paid");
		// Paid months leave the picker's month choices, so no link button is offered for them.
		expect(html).not.toContain(
			`/bills/${RENT}/occurrences/${PERIOD}/link#payment-picker`,
		);
	});

	it("a payment posted to a month that is already Paid is refused, and nothing is linked", async () => {
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9522,'user','linked')",
		)
			.bind(RENT, PERIOD)
			.run();
		const res = await post(`/bills/${RENT}/link`, {
			transaction_id: "9521",
			period: PERIOD,
			opened_period: PERIOD,
		});
		expect(await res.text()).toContain("is already paid");
		expect(await linkedIds()).toEqual([9520, 9522]);
	});

	it("the picker's month choices keep a part-paid month, and drop a paid one", async () => {
		const part = await get(`/bills/${RENT}/occurrences/${PERIOD}/link`);
		expect(part).toContain(`value="${PERIOD}"`);
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9522,'user','linked')",
		)
			.bind(RENT, PERIOD)
			.run();
		const paid = await get(`/bills/${RENT}/occurrences/${PERIOD}/link`);
		expect(paid).not.toContain(`name="period" value="${PERIOD}"`);
	});
});
