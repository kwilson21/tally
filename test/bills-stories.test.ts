import { describe, expect, it } from "vitest";
import {
	acceptPrice,
	deactivateBill,
	dismissPrice,
	linkPayment,
	markNotABill,
	reactivateBill,
	type SaveBillFacts,
	type SaveBillRequest,
	saveBill,
	scheduleChanged,
	undoUnlink,
	unlinkPayment,
} from "../src/rules/bills";
import { everyRefusal } from "../src/rules/terms";
import { answerOf, nothingToDo, refuse, write } from "./helpers/rule-answers";

// The bills area's style 3 rules as stories (decisions 187, 206, 210).

const GONE = refuse("BillGone", "That bill is gone.");

describe("Mark a possible bill as not a bill", () => {
	it.each([
		["marks a merchant on the list", true, write({ merchant: "NETFLIX" })],
		[
			"refuses one that is not on the list",
			false,
			refuse("NotAPossibleBill", "That isn't a possible bill any more."),
		],
	])("%s", (_story, listed, answer) => {
		expect(
			answerOf(markNotABill.decide({ merchant: "NETFLIX" }, { listed })),
		).toEqual(answer);
	});
});

describe("Add or edit a bill", () => {
	const MONTHLY = {
		frequency: "monthly" as const,
		dueDay: 5,
		anchorMonth: null,
		anchorDate: null,
	};

	const RENT = {
		name: "Rent",
		frequency: "monthly",
		due_day: 5,
		anchor_month: null,
		anchor_date: null,
	};

	const request = (over: Partial<SaveBillRequest> = {}): SaveBillRequest => ({
		id: null,
		read: true,
		name: "Rent",
		cents: 120_000,
		confirmedCents: "",
		schedule: MONTHLY,
		categoryId: 3,
		bankText: "LANDLORD LLC",
		...over,
	});

	const facts = (over: Partial<SaveBillFacts> = {}): SaveBillFacts => ({
		bill: null,
		bills: [],
		categoryListed: true,
		hasLinkedPayments: false,
		...over,
	});

	const ask = (r: Partial<SaveBillRequest>, f: Partial<SaveBillFacts>) =>
		answerOf(saveBill.decide(request(r), facts(f)));

	const SAVED = {
		id: null,
		name: "Rent",
		amountCents: 120_000,
		schedule: MONTHLY,
		categoryId: 3,
		bankText: "LANDLORD LLC",
		scheduleChanged: false,
	};

	const OTHER = [{ id: 9, name: " rent ", active: 1 }];
	const TAKEN = refuse("BillNameTaken", "Another bill already has that name.");
	const BIG = refuse("BigAmountNotConfirmed", "That is a lot for a bill.");

	const LOCKED = refuse(
		"ScheduleHasPayments",
		"This bill has payments linked. To change its schedule, deactivate it and add a new bill.",
	);

	it("adds a bill", () => {
		expect(ask({}, {})).toEqual(write(SAVED));
	});

	it("saves an edit, and says whether the schedule changed", () => {
		expect(
			ask(
				{
					id: 4,
					schedule: { ...MONTHLY, frequency: "yearly", anchorMonth: 3 },
				},
				{ bill: RENT },
			),
		).toEqual(
			write({
				...SAVED,
				id: 4,
				schedule: { ...MONTHLY, frequency: "yearly", anchorMonth: 3 },
				scheduleChanged: true,
			}),
		);
	});

	it.each([
		["an edit of a bill that is gone", { id: 4 }, {}, GONE],
		[
			"a form the edge could not read",
			{ read: false, cents: null },
			{},
			refuse("BillFormNotRead", "Check the bill's fields."),
		],
		[
			"a category that is not listed",
			{},
			{ categoryListed: false },
			refuse("BillCategoryGone", "Choose an existing category."),
		],
		["a name another active bill has", {}, { bills: OTHER }, TAKEN],
		[
			"an amount over $100,000 that was not confirmed",
			{ cents: 10_000_001 },
			{},
			BIG,
		],
		[
			"an amount confirmed at another amount",
			{ cents: 10_000_001, confirmedCents: "10000002" },
			{},
			BIG,
		],
		[
			"a changed schedule while a payment is linked",
			{ id: 4, schedule: { ...MONTHLY, frequency: "weekly" as const } },
			{ bill: RENT, hasLinkedPayments: true },
			LOCKED,
		],
	])("refuses %s", (_story, r, f, answer) => {
		expect(ask(r, f)).toEqual(answer);
	});

	it.each([
		[
			"a name an inactive bill has",
			{},
			{ bills: [{ id: 9, name: "Rent", active: 0 }] },
		],
		[
			"an edit that keeps a name another bill shares",
			{ id: 4, name: "RENT" },
			{ bill: RENT, bills: OTHER },
		],
		["exactly $100,000", { cents: 10_000_000 }, {}],
		[
			"an amount over $100,000 confirmed at exactly that amount",
			{ cents: 10_000_001, confirmedCents: "10000001" },
			{},
		],
		[
			"an unchanged schedule while a payment is linked",
			{ id: 4 },
			{ bill: RENT, hasLinkedPayments: true },
		],
	])("allows %s", (_story, r, f) => {
		expect(ask(r, f).kind).toBe("write");
	});

	it("names every refusal at once for the form, in order", () => {
		expect(
			everyRefusal(
				saveBill,
				request({ read: false, cents: 10_000_001 }),
				facts({ categoryListed: false, bills: OTHER }),
			).map((refusal) => refusal._tag),
		).toEqual([
			"BillFormNotRead",
			"BillCategoryGone",
			"BillNameTaken",
			"BigAmountNotConfirmed",
		]);
	});

	it("does not check a blank name or an unread amount, which the edge already refused", () => {
		expect(
			everyRefusal(
				saveBill,
				request({ read: false, name: "", cents: null }),
				facts({ bills: [{ id: 9, name: "", active: 1 }] }),
			).map((refusal) => refusal._tag),
		).toEqual(["BillFormNotRead"]);
	});

	it.each([
		["a new frequency", { ...MONTHLY, frequency: "weekly" as const }, true],
		["a weekly bill's weekday", { ...MONTHLY, dueDay: 6 }, false],
		["a monthly bill's day", { ...MONTHLY, dueDay: 20 }, false],
	])("a schedule change is %s", (_story, to, changed) => {
		expect(scheduleChanged(RENT, to)).toBe(changed);
	});

	it("moving a weekly bill's weekday is a schedule change", () => {
		expect(
			scheduleChanged(
				{ ...RENT, frequency: "weekly" },
				{ ...MONTHLY, frequency: "weekly", dueDay: 6 },
			),
		).toBe(true);
	});
});

describe("Deactivate a bill", () => {
	it.each([
		[
			"switches off a bill that is on",
			{ active: true },
			write({ active: false }),
		],
		[
			"has nothing to do for a bill already off",
			{ active: false },
			nothingToDo(),
		],
		["refuses a bill that is gone", null, GONE],
	])("%s", (_story, bill, answer) => {
		expect(answerOf(deactivateBill.decide({}, { bill }))).toEqual(answer);
	});
});

describe("Reactivate a bill", () => {
	it.each([
		[
			"switches on a bill that is off",
			"Rent",
			{ active: false },
			write({ name: "Rent" }),
		],
		[
			"has nothing to do for a bill already on",
			"",
			{ active: true },
			nothingToDo(),
		],
		["refuses a bill that is gone", "Rent", null, GONE],
		[
			"refuses a blank name",
			"",
			{ active: false },
			refuse("NameBlank", "Enter a name."),
		],
	])("%s", (_story, name, bill, answer) => {
		expect(answerOf(reactivateBill.decide({ name }, { bill }))).toEqual(answer);
	});
});

describe("Link a payment to a bill's month", () => {
	const OK = {
		periods: ["2026-10", "2026-11"],
		monthUnpaid: true,
		paysAPlan: false,
		withinWindow: true,
	};

	const UNREAD = {
		periods: OK.periods,
		monthUnpaid: null,
		paysAPlan: null,
		withinWindow: null,
	};

	const CHOOSE = refuse(
		"ChooseAPaymentAndMonth",
		"Choose a payment and month.",
	);

	const ask = (
		transactionId: number | null,
		period: string,
		facts: Partial<typeof OK> | typeof UNREAD = {},
	) =>
		answerOf(
			linkPayment.decide({ transactionId, period }, { ...OK, ...facts }),
		);

	it.each([
		[
			"links a payment to an unpaid month",
			7,
			"2026-11",
			{},
			write({ transactionId: 7, period: "2026-11" }),
		],
		["refuses a form that names no payment", null, "2026-11", UNREAD, CHOOSE],
		["refuses a month that is not the bill's", 7, "2025-01", UNREAD, CHOOSE],
		[
			"refuses a paid month",
			7,
			"2026-11",
			{ monthUnpaid: false },
			refuse("MonthAlreadyPaid", "That month's bill is already paid."),
		],
		[
			"refuses a payment that pays a planned expense",
			7,
			"2026-11",
			{ paysAPlan: true },
			refuse(
				"PaysAPlannedExpense",
				"That payment already pays a planned expense.",
			),
		],
		[
			"refuses a payment outside the window",
			7,
			"2026-11",
			{ withinWindow: false },
			refuse(
				"NotWithinTheWindow",
				"That payment isn't close enough to that month's bill.",
			),
		],
		[
			"says a paid month before a planned expense",
			7,
			"2026-11",
			{ monthUnpaid: false, paysAPlan: true },
			refuse("MonthAlreadyPaid", "That month's bill is already paid."),
		],
	])("%s", (_story, transactionId, period, facts, answer) => {
		expect(ask(transactionId, period, facts)).toEqual(answer);
	});
});

describe("Not this one", () => {
	const NONE = refuse(
		"NoSuchLinkedPayment",
		"That payment isn't linked to this month.",
	);

	it.each([
		["unlinks the payment named", 8, [7, 8], write({ transactionId: 8 })],
		[
			"unlinks the only payment when none is named",
			null,
			[7],
			write({ transactionId: 7 }),
		],
		["refuses a payment that is not linked", 9, [7, 8], NONE],
		["refuses when none is named and the month has two", null, [7, 8], NONE],
		["refuses when the month has none", null, [], NONE],
		[
			"refuses a blank name, which is not the same as naming none",
			0,
			[7],
			NONE,
		],
	])("%s", (_story, named, linked, answer) => {
		expect(answerOf(unlinkPayment.decide({ named }, { linked }))).toEqual(
			answer,
		);
	});
});

describe("Undo a Not this one", () => {
	const held = (fresh: boolean) => ({
		transactionId: 7,
		period: "2026-11",
		fresh,
	});

	it.each([
		[
			"links the payment again inside ten seconds",
			held(true),
			write({ transactionId: 7, period: "2026-11", token: "t" }),
		],
		[
			"refuses when the Not this one is gone",
			null,
			refuse("UnlinkUndoGone", "Undo expired."),
		],
		[
			"refuses after ten seconds",
			held(false),
			refuse("UnlinkUndoTooLate", "Undo expired. The payment stays unlinked."),
		],
	])("%s", (_story, facts, answer) => {
		expect(
			answerOf(undoUnlink.decide({ token: "t" }, { held: facts })),
		).toEqual(answer);
	});
});

describe("A price change's answers", () => {
	const OFFER = {
		period: "2026-11",
		transactionId: 7,
		billCents: 1_500,
		amountCents: 1_800,
	};

	const FACTS = { offer: OFFER, currentCents: 1_500 };
	const SEEN = { billCents: 1_500, chargeCents: 1_800, currentCents: 1_500 };
	const ASKED = { period: "2026-11", transactionId: 7 };

	const OFF = refuse(
		"PriceOfferGone",
		"That price change isn't on offer any more.",
	);

	it("Yes saves the prices the page showed", () => {
		expect(
			answerOf(acceptPrice.decide({ ...ASKED, seen: SEEN }, FACTS)),
		).toEqual(write({ ...ASKED, billCents: 1_500, currentCents: 1_500 }));
	});

	it.each([
		["no offer", ASKED, SEEN, { ...FACTS, offer: null }],
		[
			"an offer for another month",
			{ ...ASKED, period: "2026-10" },
			SEEN,
			FACTS,
		],
		[
			"an offer for another payment",
			{ ...ASKED, transactionId: 8 },
			SEEN,
			FACTS,
		],
		[
			"a month's amount that changed",
			ASKED,
			{ ...SEEN, billCents: 1_400 },
			FACTS,
		],
		["a charge that changed", ASKED, { ...SEEN, chargeCents: 1_900 }, FACTS],
		[
			"a bill's amount that changed",
			ASKED,
			SEEN,
			{ ...FACTS, currentCents: 1_600 },
		],
		[
			"a price the form did not send",
			ASKED,
			{ ...SEEN, chargeCents: Number.NaN },
			FACTS,
		],
	])("Yes refuses %s", (_story, asked, seen, facts) => {
		expect(answerOf(acceptPrice.decide({ ...asked, seen }, facts))).toEqual(
			OFF,
		);
	});

	it.each([
		["No remembers the payment", ASKED, FACTS, write(ASKED)],
		[
			"No refuses when nothing is on offer",
			ASKED,
			{ ...FACTS, offer: null },
			OFF,
		],
		[
			"No refuses an offer for another payment",
			{ ...ASKED, transactionId: 8 },
			FACTS,
			OFF,
		],
	])("%s", (_story, asked, facts, answer) => {
		expect(answerOf(dismissPrice.decide(asked, facts))).toEqual(answer);
	});
});
