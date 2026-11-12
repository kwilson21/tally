import { describe, expect, it } from "vitest";
import {
	addPlan,
	deletePlan,
	editPlan,
	type LinkPaymentFacts,
	linkPayment,
	movePlan,
	type PlanFacts,
	type RestorePlanFacts,
	restorePlan,
	unlinkPayment,
} from "../src/rules/plans";
import { answerOf, nothingToDo, refuse, write } from "./helpers/rule-answers";

// The plans area's rules as stories (decisions 187, 206): each row is what was asked, what was stored, and what the
// rule answers. The time, the Undo's token and the person are inputs (decision 195).

const VERSION = "v1";
const NOW = 1_800_000_000_000;
const FIELDS = { name: "New tires", amountCents: 60_000, month: "2026-11" };

const planned = (month = "2026-11", paid = false): PlanFacts => ({
	plan: { name: "New tires", month, paid },
	version: VERSION,
});

const NO_PLAN: PlanFacts = { plan: null, version: VERSION };
const GONE = refuse("PlanGone", "That planned expense is already gone.");

describe("Add a planned expense", () => {
	it("sets the amount aside under the name given", () => {
		const request = { ...FIELDS, who: "person@example.com" };

		expect(answerOf(addPlan.decide(request, null))).toEqual(write(request));
	});
});

describe("Save a planned expense", () => {
	const ask = (facts: PlanFacts, paymentFits: boolean) =>
		answerOf(
			editPlan.decide({ id: 3, fields: FIELDS }, { ...facts, paymentFits }),
		);

	const saves = (keepPayment: boolean, unlinked: boolean) =>
		write({
			id: 3,
			fields: FIELDS,
			keepPayment,
			unlinked,
			expectedVersion: VERSION,
		});

	it.each([
		["saves an unpaid plan", planned(), false, saves(false, false)],
		[
			"keeps a payment that still fits the new month",
			planned("2026-11", true),
			true,
			saves(true, false),
		],
		[
			"unlinks a payment the new month no longer fits",
			planned("2026-11", true),
			false,
			saves(false, true),
		],
		["refuses a plan that is gone", NO_PLAN, false, GONE],
	])("%s", (_story, facts, fits, answer) => {
		expect(ask(facts, fits)).toEqual(answer);
	});
});

describe("Move a planned expense to this month", () => {
	const ask = (facts: PlanFacts) =>
		answerOf(movePlan.decide({ id: 3, toMonth: "2026-11" }, facts));

	const MOVED = refuse(
		"PlanMovedOrPaid",
		"That planned expense is already moved or paid.",
	);

	it("moves an unpaid plan from an earlier month", () => {
		expect(ask(planned("2026-10"))).toEqual(
			write({ id: 3, toMonth: "2026-11", expectedVersion: VERSION }),
		);
	});

	it.each([
		["one already in this month", planned("2026-11")],
		["one in a later month", planned("2026-12")],
		["one that is paid", planned("2026-10", true)],
		["one that is gone", NO_PLAN],
	])("refuses %s", (_story, facts) => {
		expect(ask(facts)).toEqual(MOVED);
	});
});

describe("Delete or drop a planned expense", () => {
	const request = { id: 3, token: "t-1", now: NOW };

	it("deletes it and holds it for Undo", () => {
		expect(answerOf(deletePlan.decide(request, planned()))).toEqual(
			write({ ...request, expectedVersion: VERSION }),
		);
	});

	it("refuses one that is gone", () => {
		expect(answerOf(deletePlan.decide(request, NO_PLAN))).toEqual(GONE);
	});
});

describe("Undo a planned expense's delete", () => {
	const held = (
		ago: number,
		hadPayment = false,
		paymentFits = false,
	): RestorePlanFacts => ({
		hold: { name: "New tires", createdMs: NOW - ago, hadPayment, paymentFits },
		version: VERSION,
	});

	const ask = (facts: RestorePlanFacts) =>
		answerOf(restorePlan.decide({ token: "t-1", now: NOW }, facts));

	const restores = (keepPayment: boolean, unlinked: boolean) =>
		write({
			token: "t-1",
			name: "New tires",
			keepPayment,
			unlinked,
			expectedVersion: VERSION,
		});

	const EXPIRED = refuse(
		"PlanUndoExpired",
		"Undo expired. The planned expense stays deleted.",
	);

	it.each([
		["writes back an unpaid plan", held(4000), restores(false, false)],
		[
			"writes it back with its payment while the payment still fits",
			held(4000, true, true),
			restores(true, false),
		],
		[
			"writes it back unpaid when its payment no longer fits",
			held(4000, true, false),
			restores(false, true),
		],
		[
			"still restores just inside ten seconds",
			held(9999),
			restores(false, false),
		],
		["refuses at ten seconds", held(10_000), EXPIRED],
		[
			"refuses a token that is unknown or already used",
			{ hold: null, version: VERSION },
			EXPIRED,
		],
	])("%s", (_story, facts, answer) => {
		expect(ask(facts)).toEqual(answer);
	});
});

describe("Link a payment to a planned expense", () => {
	const facts = (
		payment: LinkPaymentFacts["payment"],
		plan = planned(),
	): LinkPaymentFacts => ({ ...plan, payment });

	const ask = (f: LinkPaymentFacts) =>
		answerOf(linkPayment.decide({ id: 3, transactionId: 7 }, f));

	it("links a payment the picker would list", () => {
		expect(ask(facts({ fits: true, pays: null }))).toEqual(
			write({ id: 3, transactionId: 7, expectedVersion: VERSION }),
		);
	});

	it.each([
		["a plan that is gone", facts({ fits: true, pays: null }, NO_PLAN), GONE],
		[
			"a plan that is already paid, before anything about the payment",
			facts({ fits: false, pays: "bill" }, planned("2026-11", true)),
			refuse("PlanAlreadyPaid", "The planned expense is already paid."),
		],
		[
			"a payment that pays a bill",
			facts({ fits: false, pays: "bill" }),
			refuse("PaymentPaysABill", "That payment already pays a bill."),
		],
		[
			"a payment that pays another plan",
			facts({ fits: false, pays: "plan" }),
			refuse(
				"PaymentPaysAPlan",
				"That payment already pays a planned expense.",
			),
		],
		[
			"a payment that cannot pay it for another reason",
			facts({ fits: false, pays: null }),
			refuse(
				"PaymentCannotBeLinked",
				"That payment can't be linked. It may already pay a bill or a planned expense.",
			),
		],
	])("refuses %s", (_story, f, answer) => {
		expect(ask(f)).toEqual(answer);
	});
});

describe("Unlink a planned expense's payment", () => {
	const ask = (facts: PlanFacts) =>
		answerOf(unlinkPayment.decide({ id: 3 }, facts));

	it.each([
		[
			"unlinks a paid plan's payment",
			planned("2026-11", true),
			write({ id: 3, expectedVersion: VERSION }),
		],
		["has nothing to do for a plan with no payment", planned(), nothingToDo()],
		["refuses a plan that is gone", NO_PLAN, GONE],
	])("%s", (_story, facts, answer) => {
		expect(ask(facts)).toEqual(answer);
	});
});
