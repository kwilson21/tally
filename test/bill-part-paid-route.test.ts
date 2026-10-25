import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBillRows } from "../src/bills/rows";

// A bill paid in parts on its page and in its link picker (Phase 5, decision 101, #205): each payment has its
// own Not this one, a part-paid month says what it has, and the picker sorts by what's still unpaid.

const BASE = "http://tally.test";
const RENT = 9500;
// Pinned to a mid-month day: from about the 25th, Bills counts next month's rent as due within 7 days.
const TODAY = "2026-10-15";
const today = TODAY;
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

afterEach(() => {
	vi.useRealTimers();
});

/** A $1,200 rent due on the 1st of this month, with `$600` paid by 9520 and three unclaimed payments to pick from. */
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
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

	it("a payment already linked to a part-paid month says so, and links nothing new", async () => {
		const res = await post(`/bills/${RENT}/link`, {
			transaction_id: "9520",
			period: PERIOD,
			opened_period: PERIOD,
		});
		expect(await res.text()).toContain("That payment is already linked.");
		expect(await linkedIds()).toEqual([9520]);
	});

	it("the picker's month choices keep a part-paid month, and a Paid month has no month choices at all", async () => {
		const part = await get(`/bills/${RENT}/occurrences/${PERIOD}/link`);
		expect(part).toContain(`value="${PERIOD}"`);
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9522,'user','linked')",
		)
			.bind(RENT, PERIOD)
			.run();
		// Paid, the month takes no picker (#205), so no month choice is rendered for it.
		const paid = await get(`/bills/${RENT}/occurrences/${PERIOD}/link`);
		expect(paid).not.toContain('name="period"');
	});
});

/** The month a period is in, in words, as the picker and the refusal name it (this year, so no year). */
const monthWords = (period: string) =>
	new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
		new Date(`${period}-01T00:00:00Z`),
	);
/** The HTML with its apostrophes read as written, so a sentence is matched as the person sees it. */
const readable = (html: string) => html.replaceAll("&#39;", "'");
const PAID_BY_SHOP_B = `INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9522,'user','linked')`;

describe("a month that is already Paid takes no picker (decision 101, #205)", () => {
	it("a plain request for a Paid month says it is paid, with no picker and no candidates", async () => {
		await env.DB.prepare(PAID_BY_SHOP_B).bind(RENT, PERIOD).run();
		const html = readable(
			await get(`/bills/${RENT}/occurrences/${PERIOD}/link`),
		);
		expect(html).toMatch(
			new RegExp(
				`role="alert"[^>]*>${monthWords(PERIOD)}'s bill is already paid\\.`,
			),
		);
		expect(html).not.toContain('id="payment-picker"');
		expect(html).not.toContain('value="9521"');
		expect(html).not.toContain('value="9523"');
	});

	it("a month chip's request for a Paid month swaps the whole page, with the same refusal", async () => {
		await env.DB.prepare(PAID_BY_SHOP_B).bind(RENT, PERIOD).run();
		const res = await exports.default.fetch(
			`${BASE}/bills/${RENT}/occurrences/${PERIOD}/link`,
			{ headers: { "HX-Request": "true" } },
		);
		expect(res.headers.get("HX-Retarget")).toBe("body");
		expect(res.headers.get("HX-Reswap")).toBe("outerHTML");
		expect(res.headers.get("HX-Trigger")).toBeNull();
		const html = readable(await res.text());
		expect(html).toMatch(
			new RegExp(
				`role="alert"[^>]*>${monthWords(PERIOD)}'s bill is already paid\\.`,
			),
		);
		expect(html).not.toContain('id="payment-picker"');
		expect(html).not.toContain('value="9521"');
		expect(html).not.toContain('value="9523"');
	});

	it("a part-paid month's picker names its month, checks its chip, and lists no Paid month", async () => {
		// The month before is Paid by one payment of its own, so it leaves the month choices.
		const before = new Date(`${PERIOD}-01T00:00:00Z`);
		before.setUTCMonth(before.getUTCMonth() - 1);
		const previous = before.toISOString().slice(0, 7);
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9530,1,?,120000,'HARBOR PROPERTY MGMT')",
			).bind(`${previous}-01`),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9530,'user','linked')",
			).bind(RENT, previous),
		]);
		const html = readable(
			await get(`/bills/${RENT}/occurrences/${PERIOD}/link`),
		);
		expect(html).toContain(`To ${monthWords(PERIOD)}'s Rent,`);
		expect(html).not.toContain(`name="period" value="${previous}"`);
		expect(html).toMatch(
			new RegExp(
				`<input[^>]*value="${PERIOD}"[^>]*checked|checked[^>]*value="${PERIOD}"`,
			),
		);
	});
});

describe("each Not this one names the payment it unlinks (#205)", () => {
	it("gives each Not this one an accessible name with its payment's name, amount and date", async () => {
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9521,'user','linked')",
		)
			.bind(RENT, PERIOD)
			.run();
		const html = readable(await get(`/bills/${RENT}`));
		const names = [...html.matchAll(/aria-label="(Not this one: [^"]*)"/g)].map(
			(match) => match[1],
		);
		expect(names).toHaveLength(2);
		expect(
			names.filter((name) =>
				/^Not this one: .+ \$600\.00 on [A-Z][a-z]{2} 1$/.test(name ?? ""),
			),
		).toHaveLength(1);
		expect(
			names.filter((name) =>
				/^Not this one: .+ \$650\.00 on [A-Z][a-z]{2} 1$/.test(name ?? ""),
			),
		).toHaveLength(1);
		// The visible words stay the same.
		expect(html).toContain("Not this one</button>");
	});
});

describe("two links at once cannot overpay a month (decision 101, #205)", () => {
	it("the second of two payments linked at once is refused as already paid, and links nothing", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9524,1,?,60000,'SHOP D')",
			).bind(DUE),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9525,1,?,60000,'SHOP E')",
			).bind(DUE),
		]);
		const answers = await Promise.all(
			[9524, 9525].map((transaction) =>
				post(`/bills/${RENT}/link`, {
					transaction_id: String(transaction),
					period: PERIOD,
					opened_period: PERIOD,
				}),
			),
		);
		const texts = await Promise.all(
			answers.map(async (answer) => readable(await answer.text())),
		);
		expect(
			texts.filter((text) =>
				text.includes(`${monthWords(PERIOD)}'s bill is already paid.`),
			),
		).toHaveLength(1);
		const added = (await linkedIds()).filter((id) => id !== 9520);
		expect(added).toHaveLength(1);
		const refused = [9524, 9525].find((id) => !added.includes(id));
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM bill_payments WHERE transaction_id=? AND status='linked'",
			)
				.bind(refused)
				.first("n"),
		).toBe(0);
	});
});

describe("a linked payment a bank corrected into a credit counts $0 (decision 101, #205)", () => {
	/** A $600 payment in the month, linked and then corrected by the bank to a $100 credit. */
	const creditCorrection = () =>
		env.DB.batch([
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9524,1,?,60000,'HARBOR PROPERTY MGMT')",
			).bind(DUE),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9524,'user','linked')",
			).bind(RENT, PERIOD),
			env.DB.prepare(
				"UPDATE transactions SET amount_cents=-10000 WHERE id=9524",
			),
		]);

	it("the Bills row and the bill's page read Part paid: $600 of $1,200, not $500 or a negative", async () => {
		await creditCorrection();
		for (const path of ["/bills", `/bills/${RENT}`]) {
			const html = await get(path);
			expect(html).toContain("Part paid: $600 of $1,200");
			expect(html).not.toMatch(/Part paid: (\$500|-)/);
		}
	});

	it("a $1,200 month whose only linked payment became a -$100 credit reads unpaid on the Bills row and the bill's page (#469)", async () => {
		// The $600 payment is the month's only one, and the bank corrects it to a $100 credit: it counts $0.
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents=-10000 WHERE id=9520",
		).run();
		for (const path of ["/bills", `/bills/${RENT}`]) {
			expect(await get(path)).not.toContain("Part paid");
		}
		const html = await get(`/bills/${RENT}`);
		// Unpaid reads: the month offers Link a payment (not Link another payment), and the credit stays listed with
		// its own Not this one, so it can still be unlinked.
		expect(html).toContain("Link a payment");
		expect(html).not.toContain("Link another payment");
		expect(html).toContain(
			`/bills/${RENT}/occurrences/${PERIOD}/link#payment-picker`,
		);
		expect(html).toContain('name="transaction_id" value="9520"');
	});

	it("the picker has $600 left, so $590 is listed before $650", async () => {
		await creditCorrection();
		const html = await get(`/bills/${RENT}/occurrences/${PERIOD}/link`);
		const at = (id: number) => html.indexOf(`value="${id}"`);
		expect(at(9523)).toBeGreaterThan(-1);
		expect(at(9523)).toBeLessThan(at(9521));
	});

	it("a month that reaches 90% once the credit counts $0 is Paid, and takes no link", async () => {
		// $600 and $500 pay $1,100 of $1,200. A third payment corrected to a $100 credit counts $0, so the month
		// is Paid; counted as -$100 it would be $1,000, which is still part paid.
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9524,1,?,50000,'HARBOR PROPERTY MGMT')",
			).bind(DUE),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9525,1,?,60000,'HARBOR PROPERTY MGMT')",
			).bind(DUE),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9524,'user','linked')",
			).bind(RENT, PERIOD),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9525,'user','linked')",
			).bind(RENT, PERIOD),
			env.DB.prepare(
				"UPDATE transactions SET amount_cents=-10000 WHERE id=9525",
			),
		]);
		const html = await get(`/bills/${RENT}`);
		expect(html).toContain("Paid in 3 payments");
		expect(html).not.toContain("Part paid");
		expect(html).not.toContain("Link another payment");
		expect(
			(await loadBillRows(env.DB, today)).rows.find((row) => row.id === RENT),
		).toMatchObject({ status: "paid" });
		const answer = await post(`/bills/${RENT}/link`, {
			transaction_id: "9521",
			period: PERIOD,
			opened_period: PERIOD,
		});
		expect(readable(await answer.text())).toContain(
			`${monthWords(PERIOD)}'s bill is already paid.`,
		);
		expect(await linkedIds()).toEqual([9520, 9524, 9525]);
	});
});
