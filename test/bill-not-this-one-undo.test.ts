import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

// "Not this one" on a bill's page can be undone for ten seconds, and the month's picker lists the turned-away
// payment last (#340, decision 99). Lifting a Not this one lifts it for the purchase and its parts (decision 105).

const BASE = "http://tally.test";
const BILL = 9400;
const today = todayIn(DEFAULT_TIME_ZONE);
const PERIOD = today.slice(0, 7);

const post = (path: string, body: Record<string, string> = {}) =>
	exports.default.fetch(`${BASE}${path}`, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"HX-Request": "true",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(body),
	});
const trigger = (res: Response) =>
	JSON.parse(res.headers.get("HX-Trigger") ?? "{}");
const unlink = () => post(`/bills/${BILL}/occurrences/${PERIOD}/unlink`);
const linkPayment = (transaction: number) =>
	post(`/bills/${BILL}/link`, {
		transaction_id: String(transaction),
		period: PERIOD,
		opened_period: PERIOD,
	});
const undo = (token: string) =>
	post(`/bills/${BILL}/undo-unlink`, { token, back: `/bills/${BILL}` });
const token = (res: Response) => String(trigger(res).toast.undo);
/** The row a Not this one's Undo token was saved on, by its undo_token column (0 once that row is gone). */
const dismissalIdOf = async (undoToken: string) =>
	(
		await env.DB.prepare("SELECT id FROM bill_payments WHERE undo_token=?")
			.bind(undoToken)
			.first<{ id: number }>()
	)?.id ?? 0;
const linkedTo = () =>
	env.DB.prepare(
		"SELECT transaction_id AS transactionId FROM bill_payments WHERE bill_id=? AND period=? AND status='linked'",
	)
		.bind(BILL, PERIOD)
		.first<{ transactionId: number }>();
const dismissedOn = async (...transactions: number[]) =>
	(
		await env.DB.prepare(
			`SELECT transaction_id AS transactionId FROM bill_payments WHERE bill_id=? AND period=? AND status='dismissed' AND matched_by='user' AND transaction_id IN (${transactions.join(",")}) ORDER BY transaction_id`,
		)
			.bind(BILL, PERIOD)
			.all<{ transactionId: number }>()
	).results.map(({ transactionId }) => transactionId);
const pay = (transaction: number) =>
	env.DB.prepare(
		"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,?,'auto','linked')",
	)
		.bind(BILL, PERIOD, transaction)
		.run();

/** A bill due today, a payment from the same merchant (9401) and another in the window (9402). */
async function setUp() {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM bill_payments"),
		env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(?,'Gym',1500,?,'monthly','GYM CO')",
		).bind(BILL, Number(today.slice(8, 10))),
		env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 9401,id,?,1500,'GYM CO' FROM accounts WHERE type!='cash' LIMIT 1",
		).bind(today),
		env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 9402,id,?,1480,'OTHER SHOP' FROM accounts WHERE type!='cash' LIMIT 1",
		).bind(today),
	]);
}

describe("Not this one can be undone for ten seconds (#340)", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, today);
		await setUp();
		await pay(9401);
	});

	it("says Payment unlinked with an Undo that lasts up to ten seconds", async () => {
		const res = await unlink();
		const { toast, announce } = trigger(res);
		expect(toast).toMatchObject({
			message: "Payment unlinked",
			type: "success",
			undoAction: `/bills/${BILL}/undo-unlink`,
		});
		// The token is the payment's id, a dot and a random UUID, and the Not this one it undoes stores that same token.
		expect(toast.undo).toMatch(
			/^9401\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		const dismissal = await env.DB.prepare(
			"SELECT undo_token AS undoToken FROM bill_payments WHERE bill_id=? AND period=? AND status='dismissed'",
		)
			.bind(BILL, PERIOD)
			.first<{ undoToken: string }>();
		expect(dismissal?.undoToken).toBe(toast.undo);
		expect(toast.undoExpiresInMs).toBeGreaterThan(8000);
		expect(toast.undoExpiresInMs).toBeLessThanOrEqual(10000);
		expect(announce).toBe("Payment unlinked. Undo for 10 seconds.");
	});

	it("relinks the payment to its month within ten seconds, and the page shows the month Paid", async () => {
		const unlinked = await unlink();
		expect(await linkedTo()).toBeNull();

		const res = await undo(token(unlinked));
		expect(trigger(res).toast).toEqual({
			message: "Payment linked again",
			type: "success",
			undoDone: token(unlinked),
		});
		expect(await linkedTo()).toEqual({ transactionId: 9401 });
		// It comes back as the matcher's link, the common kind; the dismissal doesn't remember how it was linked.
		expect(
			await env.DB.prepare(
				"SELECT matched_by AS matchedBy FROM bill_payments WHERE bill_id=? AND period=? AND status='linked'",
			)
				.bind(BILL, PERIOD)
				.first("matchedBy"),
		).toBe("auto");
		expect(await dismissedOn(9401)).toEqual([]);
		// The swapped-in page takes focus on the restored month's Not this one, so focus isn't lost to the body.
		expect(await res.text()).toMatch(
			/<button[^>]*autofocus[^>]*>\s*Not this one/,
		);

		const html = await (
			await exports.default.fetch(`${BASE}/bills/${BILL}`)
		).text();
		expect(html).toContain('id="page"');
		expect(html).toContain("Paid");
	});

	it("does nothing after ten seconds and says the Undo expired", async () => {
		const expired = token(await unlink());
		await env.DB.prepare(
			"UPDATE bill_payments SET created_at=datetime('now','-11 seconds') WHERE undo_token=?",
		)
			.bind(expired)
			.run();

		const res = await undo(expired);
		expect(trigger(res).toast).toEqual({
			message: "Undo expired. The payment stays unlinked.",
			type: "error",
			undoDone: expired,
		});
		expect(await linkedTo()).toBeNull();
		expect(await dismissedOn(9401)).toEqual([9401]);
	});

	it("says Couldn't undo when the payment can no longer come back, and ends its toast", async () => {
		const unlinked = await unlink();
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents=-1500 WHERE id=9401",
		).run();

		const res = await undo(token(unlinked));
		expect(trigger(res).toast).toEqual({
			message: "Couldn't undo. The payment stays unlinked.",
			type: "error",
			undoDone: token(unlinked),
		});
		expect(await linkedTo()).toBeNull();
		expect(await dismissedOn(9401)).toEqual([9401]);
	});

	it("can be used once, so a second tap links nothing more and claims no state", async () => {
		const unlinked = await unlink();
		await undo(token(unlinked));
		const again = await undo(token(unlinked));
		expect(trigger(again).toast).toEqual({
			message: "Undo expired.",
			type: "error",
			undoDone: token(unlinked),
		});
		expect(await linkedTo()).toEqual({ transactionId: 9401 });
	});

	it("an old Undo doesn't restore a later Not this one that reuses its row id", async () => {
		const unlinked = await unlink();
		const old = token(unlinked);
		// SQLite gives a later dismissal the same id once the highest row is gone: the old row is deleted, and a
		// Not this one for another payment, saved three seconds ago, takes its id.
		const oldId = await dismissalIdOf(old);
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments WHERE id=?").bind(oldId),
			env.DB.prepare(
				"INSERT INTO bill_payments(id,bill_id,period,transaction_id,matched_by,status,created_at) VALUES(?,?,?,9402,'user','dismissed',datetime('now','-3 seconds'))",
			).bind(oldId, BILL, PERIOD),
		]);

		const res = await undo(old);
		expect(trigger(res).toast).toEqual({
			message: "Undo expired.",
			type: "error",
			undoDone: old,
		});
		expect(await linkedTo()).toBeNull();
		expect(await dismissedOn(9402)).toEqual([9402]);
	});

	it("relinks the payment beside another payment in its month, since a month can hold several (decision 101)", async () => {
		const unlinked = await unlink();
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9402,'user','linked')",
		)
			.bind(BILL, PERIOD)
			.run();

		const res = await undo(token(unlinked));
		expect(trigger(res).toast).toEqual({
			message: "Payment linked again",
			type: "success",
			undoDone: token(unlinked),
		});
		expect(
			(
				await env.DB.prepare(
					"SELECT transaction_id AS transactionId FROM bill_payments WHERE bill_id=? AND period=? AND status='linked' ORDER BY transaction_id",
				)
					.bind(BILL, PERIOD)
					.all<{ transactionId: number }>()
			).results.map(({ transactionId }) => transactionId),
		).toEqual([9401, 9402]);
		expect(await dismissedOn(9401)).toEqual([]);
	});

	it("lists the turned-away payment last under 'You said not this one', and linking it links it and lifts the Not this one", async () => {
		await unlink();
		const html = await (
			await exports.default.fetch(
				`${BASE}/bills/${BILL}/occurrences/${PERIOD}/link`,
			)
		).text();
		const label = html.indexOf("You said not this one");
		const other = html.indexOf('value="9402"');
		const turnedAway = html.indexOf('value="9401"');
		expect(other).toBeGreaterThan(-1);
		expect(label).toBeGreaterThan(other);
		expect(turnedAway).toBeGreaterThan(label);

		await linkPayment(9401);
		expect(await linkedTo()).toEqual({ transactionId: 9401 });
		expect(await dismissedOn(9401)).toEqual([]);
	});

	it("linking a turned-away part lifts a Not this one kept on its purchase for the purchase and every part, and only for that month", async () => {
		const previous = new Date(`${PERIOD}-01T00:00:00Z`);
		previous.setUTCMonth(previous.getUTCMonth() - 1);
		const lastMonth = previous.toISOString().slice(0, 7);
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,is_split) SELECT 9410,id,?,2000,'GYM CO SPLIT',1 FROM accounts WHERE type!='cash' LIMIT 1",
			).bind(today),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,parent_id) SELECT 9411,id,?,1500,'GYM CO SPLIT',9410 FROM accounts WHERE type!='cash' LIMIT 1",
			).bind(today),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,parent_id) SELECT 9412,id,?,500,'GYM CO SPLIT',9410 FROM accounts WHERE type!='cash' LIMIT 1",
			).bind(today),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 9420,id,?,1500,'GYM CO OTHER' FROM accounts WHERE type!='cash' LIMIT 1",
			).bind(today),
		]);
		// A Not this one on the purchase, copied to each part, for this month; one on an unrelated payment; and
		// the purchase's Not this one for last month, which must stay.
		await env.DB.batch(
			[9410, 9411, 9412, 9420].map((transaction) =>
				env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,?,'user','dismissed')",
				).bind(BILL, PERIOD, transaction),
			),
		);
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9411,'user','dismissed')",
		)
			.bind(BILL, lastMonth)
			.run();
		// The month's payment from setUp is unlinked first, so the picker can link a part of the purchase.
		await env.DB.prepare(
			"DELETE FROM bill_payments WHERE bill_id=? AND period=? AND status='linked'",
		)
			.bind(BILL, PERIOD)
			.run();

		await linkPayment(9411);
		expect(await linkedTo()).toEqual({ transactionId: 9411 });
		expect(await dismissedOn(9410, 9411, 9412)).toEqual([]);
		expect(await dismissedOn(9420)).toEqual([9420]);
		const lastMonthRows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id=? AND period=? AND transaction_id=9411 AND status='dismissed'",
		)
			.bind(BILL, lastMonth)
			.first<{ n: number }>();
		expect(lastMonthRows?.n).toBe(1);
	});

	it("an Undo works once, and the next Not this one's Undo has a token of its own", async () => {
		const first = token(await unlink());
		expect(trigger(await undo(first)).toast).toEqual({
			message: "Payment linked again",
			type: "success",
			undoDone: first,
		});

		const second = token(await unlink());
		expect(second).not.toBe(first);
		// The first token is spent, so posting it again links nothing, even when both were saved in the same second.
		expect(trigger(await undo(first)).toast).toEqual({
			message: "Undo expired.",
			type: "error",
			undoDone: first,
		});
		expect(await linkedTo()).toBeNull();

		expect(trigger(await undo(second)).toast).toEqual({
			message: "Payment linked again",
			type: "success",
			undoDone: second,
		});
		expect(await linkedTo()).toEqual({ transactionId: 9401 });
	});

	it("the bill page keeps its Edit sheet inside #page, so an Undo's #page swap empties it (#340)", async () => {
		const html = await (
			await exports.default.fetch(`${BASE}/bills/${BILL}`)
		).text();
		expect(html.indexOf('id="page"')).toBeLessThan(html.indexOf('id="sheet"'));
		expect(html.indexOf('id="sheet"')).toBeLessThan(html.indexOf("</main>"));
		expect(html.slice(html.indexOf("</main>"))).not.toContain('id="sheet"');
		// The sheet is the last thing in #page, so it is inside the swapped element and not after it.
		expect(html).toContain('<div id="sheet"></div></div></main>');
	});

	it("an Undo from an open Edit sheet pushes the bill's own address and leaves the sheet empty (#340)", async () => {
		const res = await undo(token(await unlink()));
		expect(res.headers.get("HX-Push-Url")).toBe(`/bills/${BILL}`);
		expect(await res.text()).toContain('<div id="sheet"></div></div></main>');
	});

	it("a Not this one swaps only #page, so a second one leaves the first one's Undo toast in place (#340)", async () => {
		const html = await (
			await exports.default.fetch(`${BASE}/bills/${BILL}`)
		).text();
		const form =
			html.match(
				new RegExp(
					`<form[^>]*action="/bills/${BILL}/occurrences/${PERIOD}/unlink"[^>]*>`,
				),
			)?.[0] ?? "";
		expect(form).toContain('hx-target="#page"');
		expect(form).toContain('hx-select="#page"');
		expect(form).toContain('hx-swap="outerHTML"');
		expect(form).not.toContain('hx-target="body"');
	});
});
