import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	type BillFindingCharge,
	findBillSuggestions,
	loadBillSuggestions,
	threeMonthsBack,
} from "../src/bills/find";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const charge = (date: string, amountCents = 1000): BillFindingCharge => ({
	rawName: "GYM",
	bankText: "GYM",
	displayName: "Gym",
	date,
	amountCents,
	categoryId: 2,
});

describe("finding bills", () => {
	it("allows other purchases between the monthly pair, anchored on the latest charge", () => {
		expect(
			findBillSuggestions([
				charge("2026-08-01", 1000),
				charge("2026-08-15", 5000),
				charge("2026-09-01", 1000),
			]),
		).toMatchObject([{ amountCents: 1000, dueDay: 1, chargeCount: 3 }]);
	});

	it("requires two eligible charges 25–35 days apart and within 10%", () => {
		expect(
			findBillSuggestions([charge("2026-08-01"), charge("2026-09-01", 1100)]),
		).toHaveLength(1);
		expect(
			findBillSuggestions([charge("2026-08-01"), charge("2026-08-26", 900)]),
		).toHaveLength(1);
		for (const rows of [
			[charge("2026-08-01")],
			[charge("2026-08-01"), charge("2026-08-25")],
			[charge("2026-08-01"), charge("2026-09-06")],
			[charge("2026-08-01"), charge("2026-09-01", 1101)],
		])
			expect(findBillSuggestions(rows)).toHaveLength(0);
	});

	it("suggests the latest amount/day and most-used category", () => {
		const found = findBillSuggestions([
			{ ...charge("2026-07-01"), categoryId: 3 },
			{ ...charge("2026-08-01", 1050), categoryId: 3 },
			{ ...charge("2026-09-01", 1075), categoryId: 2 },
		]);
		expect(found[0]).toMatchObject({
			amountCents: 1075,
			dueDay: 1,
			categoryId: 3,
		});
	});

	it("qualifies a merchant when its latest charge repeats an earlier one", () => {
		expect(
			findBillSuggestions([
				charge("2026-07-01", 900),
				charge("2026-08-01", 1000),
				charge("2026-09-01", 1050),
			]),
		).toMatchObject([{ amountCents: 1050, dueDay: 1, chargeCount: 3 }]);
	});

	it("does not qualify Whole Foods from an old pair when its latest charge is a one-off", () => {
		expect(
			findBillSuggestions([
				charge("2026-08-23", 10000),
				charge("2026-09-23", 10200),
				charge("2026-10-04", 9630),
			]),
		).toEqual([]);
	});

	it("names a merchant with no chosen name by its tidied bank text, and never re-tidies a chosen name", () => {
		const bank: BillFindingCharge = {
			...charge("2026-08-01"),
			rawName: "BLUE BOTTLE COFFEE",
			bankText: "BLUE BOTTLE COFFEE",
			displayName: null,
		};
		expect(
			findBillSuggestions([bank, { ...bank, date: "2026-09-01" }]),
		).toMatchObject([
			{ rawName: "BLUE BOTTLE COFFEE", displayName: "Blue bottle coffee" },
		]);
		const chosen = { ...bank, displayName: "BLUE BOTTLE" };
		expect(
			findBillSuggestions([chosen, { ...chosen, date: "2026-09-01" }]),
		).toMatchObject([{ displayName: "BLUE BOTTLE" }]);
	});

	it("names an unnamed Plaid-named merchant by its latest charge's tidied bank text", () => {
		const named = (
			rawName: string,
			date: string,
			bankText: string,
		): BillFindingCharge => ({
			...charge(date),
			rawName,
			bankText,
			displayName: null,
		});
		expect(
			findBillSuggestions([
				named("Local Bakery", "2026-08-01", "SQ *LOCAL BAKERY 4432"),
				named("Local Bakery", "2026-09-01", "SQ *LOCAL BAKERY 4432"),
			]),
		).toMatchObject([
			{
				rawName: "Local Bakery",
				bankText: "SQ *LOCAL BAKERY 4432",
				displayName: "Local bakery",
			},
		]);
		expect(
			findBillSuggestions([
				named("Target", "2026-08-01", "TARGET 1234"),
				named("Target", "2026-09-01", "TARGET 5678"),
			]),
		).toMatchObject([
			{ rawName: "Target", bankText: "TARGET 5678", displayName: "Target" },
		]);
		expect(
			findBillSuggestions([
				{
					...named("Local Bakery", "2026-08-01", "SQ *LOCAL BAKERY 4432"),
					displayName: "Bakery Club",
				},
				{
					...named("Local Bakery", "2026-09-01", "SQ *LOCAL BAKERY 4432"),
					displayName: "Bakery Club",
				},
			]),
		).toMatchObject([{ displayName: "Bakery Club" }]);
	});

	it("clamps the three-month cutoff at month end", () => {
		expect(threeMonthsBack("2026-05-31")).toBe("2026-02-28");
		expect(threeMonthsBack("2024-05-31")).toBe("2024-02-29");
	});

	it("suggests exactly the seeded subscriptions on every representative date", async () => {
		for (const date of [
			"2026-01-01",
			"2026-06-15",
			"2028-02-29",
			"2026-10-31",
			"2026-12-31",
		]) {
			await resetDemo(env.DB, date);
			expect(
				(await loadBillSuggestions(env.DB, date)).map((row) => row.displayName),
			).toEqual(["City Gym", "Procreate Dreams", "YouTube Premium"]);
		}
	});

	it.each([
		["excluded rows", "excluded=1"],
		["income", "flag_income=1"],
		["split parents", "is_split=1"],
		["money-in rows", "amount_cents=-amount_cents"],
	] as const)("filters %s", async (_label, mutation) => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("FILTER ME");
		await env.DB.prepare(`UPDATE transactions SET ${mutation} WHERE raw_name=?`)
			.bind("FILTER ME")
			.run();
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).not.toContainEqual(expect.objectContaining({ rawName: "FILTER ME" }));
	});

	it("suggests a fresh candidate (the control for the filter tests)", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("KEEP ME");
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).toContainEqual(expect.objectContaining({ rawName: "KEEP ME" }));
	});

	it.each([
		["Plaid transfer out", "plaid_category='TRANSFER_OUT'", "MOVE OUT"],
		["Plaid transfer in", "plaid_category='TRANSFER_IN'", "MOVE IN"],
		["transfer Tally flagged", "flag_transfer=1", "FLAGGED MOVE"],
		[
			"card payment Plaid filed as a loan payment",
			"plaid_category='LOAN_PAYMENTS'",
			"CARD BACK",
		],
	] as const)(
		"suggests a steady %s that a person brought back into the budget",
		async (_label, mutation, rawName) => {
			await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
			await insertCandidate(rawName);
			await env.DB.prepare(
				`UPDATE transactions SET excluded=0, excluded_source='user', ${mutation} WHERE raw_name=?`,
			)
				.bind(rawName)
				.run();
			expect(
				await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
			).toContainEqual(expect.objectContaining({ rawName }));
		},
	);

	it("suggests the demo's steady transfer to savings once a person includes it", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.prepare(
			"UPDATE transactions SET excluded=0, excluded_source='user' WHERE raw_name='ONLINE TRANSFER TO SAV ...5678'",
		).run();
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).toContainEqual(
			expect.objectContaining({ rawName: "ONLINE TRANSFER TO SAV ...5678" }),
		);
	});

	it("never suggests the demo's steady transfer to savings while it is excluded", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).not.toContainEqual(
			expect.objectContaining({ rawName: "ONLINE TRANSFER TO SAV ...5678" }),
		);
	});

	it("suggests a steady payment Plaid filed as TRANSFER_OUT that was never excluded", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("PAID OUT");
		await env.DB.prepare(
			"UPDATE transactions SET plaid_category='TRANSFER_OUT' WHERE raw_name=?",
		)
			.bind("PAID OUT")
			.run();
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).toContainEqual(expect.objectContaining({ rawName: "PAID OUT" }));
	});

	it.each([
		["car", "LOAN_PAYMENTS_CAR_PAYMENT", "CAR LOAN"],
		["mortgage", "LOAN_PAYMENTS_MORTGAGE_PAYMENT", "MORTGAGE LOAN"],
		["student-loan", "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT", "STUDENT LOAN"],
		["personal-loan", "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT", "PERSONAL LOAN"],
		["other loan", "LOAN_PAYMENTS_OTHER_PAYMENT", "OTHER LOAN"],
	] as const)(
		"suggests a steady %s payment the bank marked as a loan, excluded at sync",
		async (_label, detailed, rawName) => {
			await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
			await insertCandidate(rawName);
			await env.DB.prepare(
				"UPDATE transactions SET plaid_category='LOAN_PAYMENTS', plaid_detailed_category=?, excluded=1, excluded_source='plaid' WHERE raw_name=?",
			)
				.bind(detailed, rawName)
				.run();
			expect(
				await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
			).toContainEqual(expect.objectContaining({ rawName }));
		},
	);

	it("never suggests a steady card payment that Plaid excluded as a loan payment", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("CARD PAYMENT");
		await env.DB.prepare(
			"UPDATE transactions SET plaid_category='LOAN_PAYMENTS', plaid_detailed_category='LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', excluded=1, excluded_source='plaid' WHERE raw_name=?",
		)
			.bind("CARD PAYMENT")
			.run();
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).not.toContainEqual(expect.objectContaining({ rawName: "CARD PAYMENT" }));
	});

	it("never suggests a steady move between the family's own accounts that Plaid excluded", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("OWN ACCOUNT MOVE");
		await env.DB.prepare(
			"UPDATE transactions SET plaid_category='TRANSFER_OUT', plaid_detailed_category='TRANSFER_OUT_ACCOUNT_TRANSFER', excluded=1, excluded_source='plaid' WHERE raw_name=?",
		)
			.bind("OWN ACCOUNT MOVE")
			.run();
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).not.toContainEqual(
			expect.objectContaining({ rawName: "OWN ACCOUNT MOVE" }),
		);
	});

	it("never suggests a loan payment Plaid excluded before its detailed category was stored", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("OLD LOAN");
		await env.DB.prepare(
			"UPDATE transactions SET plaid_category='LOAN_PAYMENTS', excluded=1, excluded_source='plaid' WHERE raw_name=?",
		)
			.bind("OLD LOAN")
			.run();
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).not.toContainEqual(expect.objectContaining({ rawName: "OLD LOAN" }));
	});

	it.each([
		["by hand", "user"],
		["by the matcher", "auto"],
	] as const)(
		"never suggests a payee whose payment is linked to a bill %s",
		async (_label, matchedBy) => {
			await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
			await insertCandidate("OAK STREET RENTALS");
			const rent = await insertBill("Rent", "LANDLORD CO");
			await linkCharge(rent, "OAK STREET RENTALS", 10, matchedBy);
			expect(
				await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
			).not.toContainEqual(
				expect.objectContaining({ rawName: "OAK STREET RENTALS" }),
			);
		},
	);

	it("suggests a payee again once its two latest monthly payments are left unlinked", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("OAK STREET RENTALS");
		await insertCharge("OAK STREET RENTALS", 70);
		const rent = await insertBill("Rent", "LANDLORD CO");
		await linkCharge(rent, "OAK STREET RENTALS", 70, "user");
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).toContainEqual(
			expect.objectContaining({ rawName: "OAK STREET RENTALS" }),
		);
	});

	it("keeps a payee hidden while one of its two latest monthly payments is still linked", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("OAK STREET RENTALS");
		await insertCharge("OAK STREET RENTALS", 70);
		const rent = await insertBill("Rent", "LANDLORD CO");
		await linkCharge(rent, "OAK STREET RENTALS", 40, "user");
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).not.toContainEqual(
			expect.objectContaining({ rawName: "OAK STREET RENTALS" }),
		);
	});

	it.each([
		["Jev", "flag_transfer=1, excluded=1, excluded_source='jev'", "JEV MOVE"],
		["a person", "excluded=1, excluded_source='user'", "PERSON MOVE"],
	] as const)(
		"never suggests a steady charge left out of the budget by %s",
		async (_label, mutation, rawName) => {
			await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
			await insertCandidate(rawName);
			await env.DB.prepare(
				`UPDATE transactions SET ${mutation} WHERE raw_name=?`,
			)
				.bind(rawName)
				.run();
			expect(
				await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
			).not.toContainEqual(expect.objectContaining({ rawName }));
		},
	);

	it("never suggests a split part of a purchase left out as a transfer", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("SPLIT MOVE");
		const parent = await env.DB.prepare(
			"SELECT id, account_id, date FROM transactions WHERE raw_name='SPLIT MOVE' ORDER BY date DESC LIMIT 1",
		).first<{ id: number; account_id: number; date: string }>();
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE transactions SET is_split=1, flag_transfer=1, excluded=1, excluded_source='jev' WHERE id=?",
			).bind(parent?.id),
			env.DB.prepare(
				"INSERT INTO transactions(account_id,date,amount_cents,raw_name,category_id,parent_id,excluded,excluded_source) VALUES(?,?,1000,'PART',4,?,1,'jev')",
			).bind(parent?.account_id, parent?.date, parent?.id),
		]);
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).not.toContainEqual(expect.objectContaining({ rawName: "SPLIT MOVE" }));
	});

	it("suggests a split part of a transfer a person brought back", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("SPLIT BACK");
		const parent = await env.DB.prepare(
			"SELECT id, account_id, date FROM transactions WHERE raw_name='SPLIT BACK' ORDER BY date DESC LIMIT 1",
		).first<{ id: number; account_id: number; date: string }>();
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE transactions SET is_split=1, flag_transfer=1, excluded=0, excluded_source='user' WHERE id=?",
			).bind(parent?.id),
			env.DB.prepare(
				"INSERT INTO transactions(account_id,date,amount_cents,raw_name,category_id,parent_id,excluded,excluded_source) VALUES(?,?,1000,'PART',4,?,0,'user')",
			).bind(parent?.account_id, parent?.date, parent?.id),
		]);
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).toContainEqual(expect.objectContaining({ rawName: "SPLIT BACK" }));
	});

	it("names a suggestion by the merchant's chosen name, never by a name that is only suggested (decision 64)", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("SUGGESTED ONLY", 0, false);
		await insertCandidate("CHOSEN NAME", 0, false);
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('SUGGESTED ONLY', 'A Guess', 'pending')",
			),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status, display_name) VALUES ('CHOSEN NAME', 'A Guess', 'accepted', 'Mine')",
			),
		]);
		const found = await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE));
		expect(
			found.find((row) => row.rawName === "SUGGESTED ONLY")?.displayName,
		).toBe("Suggested only");
		expect(
			found.find((row) => row.rawName === "CHOSEN NAME")?.displayName,
		).toBe("Mine");
	});

	it("dismisses a merchant whose name has a percent sign", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("100% PURE");
		const response = await exports.default.fetch(
			"http://tally.test/bills/find/100%25%20PURE/dismiss",
			{
				method: "POST",
				headers: { Origin: "http://tally.test", "HX-Request": "true" },
			},
		);
		expect(response.status).toBe(200);
		expect(
			await env.DB.prepare("SELECT not_a_bill FROM merchants WHERE raw_name=?")
				.bind("100% PURE")
				.first("not_a_bill"),
		).toBe(1);
	});

	it("saves nothing when the name isn't a current suggestion", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		const response = await exports.default.fetch(
			"http://tally.test/bills/find/NOT%20LISTED/dismiss",
			{ method: "POST", headers: { Origin: "http://tally.test" } },
		);
		expect(response.status).toBe(404);
		expect(
			await env.DB.prepare(
				"SELECT 1 FROM merchants WHERE raw_name='NOT LISTED'",
			).first(),
		).toBeNull();
	});

	it("suggests charges whose merchant has no row yet", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("NO ROW", 0, false);
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).toContainEqual(
			expect.objectContaining({ rawName: "NO ROW", displayName: "No row" }),
		);
	});

	it("counts a split part under its purchase's merchant", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("SPLIT GYM");
		const { results } = await env.DB.prepare(
			"SELECT id, account_id, date FROM transactions WHERE raw_name='SPLIT GYM' ORDER BY date DESC LIMIT 1",
		).all<{ id: number; account_id: number; date: string }>();
		const parent = results[0] as {
			id: number;
			account_id: number;
			date: string;
		};
		await env.DB.batch([
			env.DB.prepare("UPDATE transactions SET is_split=1 WHERE id=?").bind(
				parent.id,
			),
			env.DB.prepare(
				"INSERT INTO transactions(account_id,date,amount_cents,raw_name,category_id,parent_id) VALUES(?,?,1000,'PART',4,?)",
			).bind(parent.account_id, parent.date, parent.id),
		]);
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).toContainEqual(
			expect.objectContaining({
				rawName: "SPLIT GYM",
				bankText: "SPLIT GYM",
				chargeCount: 2,
			}),
		);
	});

	it("filters merchants that already have a bill", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("HAS BILL");
		await env.DB.prepare(
			"INSERT INTO bills(name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES('Existing',1000,1,'monthly',1,?)",
		)
			.bind("HAS BILL")
			.run();
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).not.toContainEqual(expect.objectContaining({ rawName: "HAS BILL" }));
	});

	it("filters merchants marked not_a_bill", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("NOT A BILL", 1);
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).not.toContainEqual(expect.objectContaining({ rawName: "NOT A BILL" }));
	});

	it("names an unnamed merchant by its tidied text in the headline and the Add form, with the bank's text on the muted line", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("SHOP BANK 4411", 0, false);
		const html = await (
			await exports.default.fetch("http://tally.test/bills/find")
		).text();
		expect(html).toContain("<span>Shop bank</span>");
		expect(html).toContain("name=Shop+bank&amp;amount=");
		expect(html).toContain("SHOP BANK 4411 ·");
	});

	it("names a merchant named by Plaid, with no chosen name, by its latest bank text on the page", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await insertCandidate("SQ *LOCAL BAKERY 4432", 0, false, "Local Bakery");
		expect(
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE)),
		).toContainEqual(
			expect.objectContaining({
				rawName: "Local Bakery",
				bankText: "SQ *LOCAL BAKERY 4432",
				displayName: "Local bakery",
			}),
		);
		const html = await (
			await exports.default.fetch("http://tally.test/bills/find")
		).text();
		expect(html).toContain("<span>Local bakery</span>");
		expect(html).toContain("name=Local+bakery&amp;amount=");
		expect(html).toContain("merchant_raw_name=Local+Bakery");
		expect(html).toContain("/bills/find/Local%20Bakery/dismiss");
		expect(html).toContain("SQ *LOCAL BAKERY 4432 ·");
		expect(html).not.toContain("Local Bakery ·");
	});

	it("prefills every Add value", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		// The seeded charge dates follow today, so the due day is its latest charge's day.
		const latest = await env.DB.prepare(
			"SELECT MAX(date) AS date FROM transactions WHERE raw_name='CITY GYM MEMBERSHIP' AND date<=?",
		)
			.bind(todayIn(DEFAULT_TIME_ZONE))
			.first<string>("date");
		const html = await (
			await exports.default.fetch("http://tally.test/bills/find")
		).text();
		expect(html).toContain(
			`/bills/new?name=City+Gym&amp;amount=42.50&amp;due_day=${Number(latest?.slice(8))}&amp;frequency=monthly&amp;category_id=5&amp;merchant_raw_name=CITY+GYM+MEMBERSHIP`,
		);
	});

	it("remembers Not a bill and removes the row with feedback", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		const raw = (
			await loadBillSuggestions(env.DB, todayIn(DEFAULT_TIME_ZONE))
		)[0]?.rawName;
		const response = await exports.default.fetch(
			`http://tally.test/bills/find/${encodeURIComponent(raw ?? "")}/dismiss`,
			{
				method: "POST",
				headers: { Origin: "http://tally.test", "HX-Request": "true" },
			},
		);
		expect(JSON.parse(response.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Marked as not a bill", type: "success" },
			announce: "Suggestion removed",
		});
		expect(
			await env.DB.prepare("SELECT not_a_bill FROM merchants WHERE raw_name=?")
				.bind(raw)
				.first("not_a_bill"),
		).toBe(1);
	});

	it("returns the empty state when dismissing the last suggestion", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.prepare(
			"UPDATE merchants SET not_a_bill=1 WHERE raw_name <> 'CITY GYM MEMBERSHIP'",
		).run();
		const response = await exports.default.fetch(
			"http://tally.test/bills/find/CITY%20GYM%20MEMBERSHIP/dismiss",
			{
				method: "POST",
				headers: { Origin: "http://tally.test", "HX-Request": "true" },
			},
		);
		expect(await response.text()).toContain("No possible bills to review.");
	});
});

/** A day `days` before today, as YYYY-MM-DD. */
const daysAgo = (days: number) =>
	new Date(
		Date.parse(`${todayIn(DEFAULT_TIME_ZONE)}T00:00:00Z`) - days * 86400000,
	)
		.toISOString()
		.slice(0, 10);

/** Two $10 charges 30 days apart, both inside the three-month window. A merchantName is Plaid's name for them. */
async function insertCandidate(
	rawName: string,
	notABill = 0,
	withRow = true,
	merchantName: string | null = null,
) {
	if (withRow)
		await env.DB.prepare(
			"INSERT INTO merchants(raw_name,display_name,default_category_id,not_a_bill) VALUES(?,?,4,?)",
		)
			.bind(rawName, rawName, notABill)
			.run();
	await env.DB.prepare(
		`INSERT INTO transactions(account_id,date,amount_cents,raw_name,category_id,merchant_name)
		 SELECT id,?,1000,?,4,? FROM accounts LIMIT 1`,
	)
		.bind(daysAgo(40), rawName, merchantName)
		.run();
	await env.DB.prepare(
		`INSERT INTO transactions(account_id,date,amount_cents,raw_name,category_id,merchant_name)
		 SELECT id,?,1000,?,4,? FROM accounts LIMIT 1`,
	)
		.bind(daysAgo(10), rawName, merchantName)
		.run();
}

/** One $10 charge for `rawName`, `days` days ago. */
async function insertCharge(rawName: string, days: number) {
	await env.DB.prepare(
		`INSERT INTO transactions(account_id,date,amount_cents,raw_name,category_id)
		 SELECT id,?,1000,?,4 FROM accounts LIMIT 1`,
	)
		.bind(daysAgo(days), rawName)
		.run();
}

/** A monthly bill whose bank text is `merchantRawName`, so no merchant key of its own covers the payee. */
async function insertBill(name: string, merchantRawName: string) {
	return env.DB.prepare(
		"INSERT INTO bills(name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(?,100000,1,'monthly',1,?) RETURNING id",
	)
		.bind(name, merchantRawName)
		.first<number>("id");
}

/** Links the `rawName` charge `days` days ago to `billId` for that month, by hand or by the matcher. */
async function linkCharge(
	billId: number | null,
	rawName: string,
	days: number,
	matchedBy: "user" | "auto",
) {
	const transaction = await env.DB.prepare(
		"SELECT id FROM transactions WHERE raw_name=? AND date=?",
	)
		.bind(rawName, daysAgo(days))
		.first<number>("id");
	await env.DB.prepare(
		"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,?,?,'linked')",
	)
		.bind(billId, daysAgo(days).slice(0, 7), transaction, matchedBy)
		.run();
}
