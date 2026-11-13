// The bills area's rules in style 3 (decisions 187, 206 and 210): mark a possible bill as not a bill, add or edit a
// bill, switch one off and on, link a payment, Not this one and its Undo, and the two answers to a price change. Each
// takes a typed request and what is stored, and is written as a list of its parts (`rule`, in ./terms). Nothing here
// parses, reads a clock or touches the database. The saves are the older functions that re-check each row in SQL as
// they write (decision 209), so a change between the read and the save is still refused there.
import * as Data from "effect/Data";
import {
	duplicateBillName,
	needsBigAmountConfirm,
	sameBillName,
} from "../bills/guards";
import { rule, term, unless } from "./terms";

// The refusals: one class each. Where the page's sentence names a month, an amount or another bill, the page composes it.

/** The bill is not there: the page answers 404. */
export class BillGone extends Data.TaggedError("BillGone") {
	readonly say = "That bill is gone.";
}

/** The merchant is not on the possible bills list: the page answers 404. */
export class NotAPossibleBill extends Data.TaggedError("NotAPossibleBill") {
	readonly say = "That isn't a possible bill any more.";
}

/** The edge could not read a field; the page shows the edge's own sentence under each one. */
export class BillFormNotRead extends Data.TaggedError("BillFormNotRead") {
	readonly say = "Check the bill's fields.";
}

export class BillCategoryGone extends Data.TaggedError("BillCategoryGone") {
	readonly field = "category_id";
	readonly say = "Choose an existing category.";
}

/** The page names the other bill. */
export class BillNameTaken extends Data.TaggedError("BillNameTaken") {
	readonly field = "name";
	readonly say = "Another bill already has that name.";
}

/** The page names the amount. */
export class BigAmountNotConfirmed extends Data.TaggedError(
	"BigAmountNotConfirmed",
) {
	readonly field = "amount";
	readonly say = "That is a lot for a bill.";
}

/** The page puts its sentence under the field that changed. */
export class ScheduleHasPayments extends Data.TaggedError(
	"ScheduleHasPayments",
) {
	readonly say =
		"This bill has payments linked. To change its schedule, deactivate it and add a new bill.";
}

export class NameBlank extends Data.TaggedError("NameBlank") {
	readonly say = "Enter a name.";
}

export class ChooseAPaymentAndMonth extends Data.TaggedError(
	"ChooseAPaymentAndMonth",
) {
	readonly say = "Choose a payment and month.";
}

/** The page names the month. */
export class MonthAlreadyPaid extends Data.TaggedError("MonthAlreadyPaid") {
	readonly say = "That month's bill is already paid.";
}

export class PaysAPlannedExpense extends Data.TaggedError(
	"PaysAPlannedExpense",
) {
	readonly say = "That payment already pays a planned expense.";
}

/** The page names the days and the month. */
export class NotWithinTheWindow extends Data.TaggedError("NotWithinTheWindow") {
	readonly say = "That payment isn't close enough to that month's bill.";
}

/** No linked payment is the one named: the page answers 404. */
export class NoSuchLinkedPayment extends Data.TaggedError(
	"NoSuchLinkedPayment",
) {
	readonly say = "That payment isn't linked to this month.";
}

export class UnlinkUndoGone extends Data.TaggedError("UnlinkUndoGone") {
	readonly say = "Undo expired.";
}

export class UnlinkUndoTooLate extends Data.TaggedError("UnlinkUndoTooLate") {
	readonly say = "Undo expired. The payment stays unlinked.";
}

export class PriceOfferGone extends Data.TaggedError("PriceOfferGone") {
	readonly say = "That price change isn't on offer any more.";
}

// Mark a possible bill as not a bill.

export const markNotABill = rule({
	name: "Mark a possible bill as not a bill",
	given: (request: { merchant: string }, facts: { listed: boolean }) => ({
		...request,
		...facts,
	}),
	refusals: [
		unless(
			term<{ listed: boolean }>(
				"the merchant is on the possible bills list",
				(g) => g.listed,
			),
			() => new NotAPossibleBill(),
		),
	],
	writes: (g): MerchantWrite => ({ merchant: g.merchant }),
	writesText: "Marks the merchant as not a bill, so it is not suggested again.",
});

export type MerchantWrite = { merchant: string };

// Add or edit a bill.

export type Frequency =
	| "monthly"
	| "yearly"
	| "weekly"
	| "biweekly"
	| "quarterly";

/** When a bill is due, as the form's fields give it. The month is only a yearly or quarterly bill's, the date only a biweekly one's. */
export type Schedule = {
	frequency: Frequency;
	dueDay: number;
	anchorMonth: number | null;
	anchorDate: string | null;
};

/** The parts of a stored bill the rules read, named as its row is. */
export type StoredBill = {
	name: string;
	frequency: string;
	due_day: number;
	anchor_month: number | null;
	anchor_date: string | null;
};

/**
 * Whether the months a bill's payments are filed under would change. A weekly bill's due day is its weekday, which
 * names its occurrences, so moving it is a change of schedule too.
 */
export const scheduleChanged = (bill: StoredBill, to: Schedule) =>
	bill.frequency !== to.frequency ||
	bill.anchor_month !== to.anchorMonth ||
	bill.anchor_date !== to.anchorDate ||
	(to.frequency === "weekly" && bill.due_day !== to.dueDay);

export type SaveBillRequest = {
	/** The bill being edited, or null for a new bill. */
	id: number | null;
	/** Whether the edge read every field. */
	read: boolean;
	name: string;
	/** Null when the edge refused the amount. */
	cents: number | null;
	/** What the "Yes, $X is right" chip sent: the cents it was drawn for, or "". */
	confirmedCents: string;
	schedule: Schedule;
	categoryId: number;
	/** The bank's text as the person typed it. */
	bankText: string;
};

export type SaveBillFacts = {
	bill: StoredBill | null;
	/** Every bill, for the name check. The list is as long as the household's bills. */
	bills: { id: number; name: string; active: number | boolean }[];
	/** Whether the chosen category is listed, or null when none was chosen (the edge says so). */
	categoryListed: boolean | null;
	/** Whether a payment is linked to the bill being edited. */
	hasLinkedPayments: boolean;
};

export type SaveBillWrite = {
	id: number | null;
	name: string;
	amountCents: number;
	schedule: Schedule;
	categoryId: number;
	bankText: string;
	/** An edit that changes the schedule drops the bill's old dismissals. */
	scheduleChanged: boolean;
};

type SaveBillGiven = SaveBillRequest & {
	found: boolean;
	categoryListed: boolean | null;
	/** The other active bill the name repeats, when the name is new to this bill. */
	duplicate: string | undefined;
	needsConfirm: boolean;
	scheduleChanged: boolean;
	hasLinkedPayments: boolean;
};

/** The other active bill a name repeats. Only a new name is checked: a bill that already shares its name can still be edited. */
export const nameRepeats = (request: SaveBillRequest, facts: SaveBillFacts) =>
	request.name === "" ||
	(facts.bill !== null && sameBillName(facts.bill.name, request.name))
		? undefined
		: duplicateBillName(facts.bills, request.name, request.id ?? undefined);

export const saveBill = rule({
	name: "Add or edit a bill",
	given: (request: SaveBillRequest, facts: SaveBillFacts): SaveBillGiven => ({
		...request,
		found: request.id === null || facts.bill !== null,
		categoryListed: facts.categoryListed,
		duplicate: nameRepeats(request, facts),
		needsConfirm:
			request.cents !== null &&
			needsBigAmountConfirm(request.cents, request.confirmedCents),
		scheduleChanged:
			facts.bill !== null && scheduleChanged(facts.bill, request.schedule),
		hasLinkedPayments: facts.hasLinkedPayments,
	}),
	refusals: [
		unless(
			term<SaveBillGiven>("the bill being edited is there", (g) => g.found),
			() => new BillGone(),
		),
		unless(
			term<SaveBillGiven>("the edge read every field", (g) => g.read),
			() => new BillFormNotRead(),
		),
		unless(
			term<SaveBillGiven>(
				"the chosen category is listed",
				(g) => g.categoryListed !== false,
			),
			() => new BillCategoryGone(),
		),
		unless(
			term<SaveBillGiven>(
				"no other active bill has the name, when the name is new to this bill",
				(g) => g.duplicate === undefined,
			),
			() => new BillNameTaken(),
		),
		unless(
			term<SaveBillGiven>(
				"an amount over $100,000 was confirmed at exactly that amount",
				(g) => !g.needsConfirm,
			),
			() => new BigAmountNotConfirmed(),
		),
		unless(
			term<SaveBillGiven>(
				"the schedule is unchanged, or no payment is linked to the bill",
				(g) => !(g.scheduleChanged && g.hasLinkedPayments),
			),
			() => new ScheduleHasPayments(),
		),
	],
	writes: (g): SaveBillWrite => ({
		id: g.id,
		name: g.name,
		// The second refusal answered an amount the edge refused, so this 0 is never used.
		amountCents: g.cents ?? 0,
		schedule: g.schedule,
		categoryId: g.categoryId,
		bankText: g.bankText,
		scheduleChanged: g.scheduleChanged,
	}),
	writesText:
		"Saves the bill, with a changed amount applying from this month on, and then matches payments to it. The save refuses a name another bill took meanwhile.",
});

// Switch a bill off and on.

type ActiveFacts = { bill: { active: boolean } | null };

const theBillIsThere = unless(
	term<ActiveFacts>("the bill is there", (g) => g.bill !== null),
	() => new BillGone(),
);

export type BillSwitch = { active: boolean };

export const deactivateBill = rule({
	name: "Deactivate a bill",
	given: (_request: Record<never, never>, facts: ActiveFacts) => facts,
	nothingToDoIf: term<ActiveFacts>(
		"the bill is already off",
		(g) => g.bill !== null && !g.bill.active,
	),
	refusals: [theBillIsThere],
	writes: (): BillSwitch => ({ active: false }),
	writesText: "Switches the bill off. Its payments stay linked.",
});

export type ReactivateWrite = { name: string };

type ReactivateGiven = ActiveFacts & { name: string };

export const reactivateBill = rule({
	name: "Reactivate a bill",
	given: (request: { name: string }, facts: ActiveFacts): ReactivateGiven => ({
		...request,
		...facts,
	}),
	nothingToDoIf: term<ReactivateGiven>(
		"the bill is already on",
		(g) => g.bill?.active === true,
	),
	refusals: [
		theBillIsThere,
		unless(
			term<ReactivateGiven>(
				"the name it comes back under is not blank",
				(g) => g.name !== "",
			),
			() => new NameBlank(),
		),
	],
	writes: (g): ReactivateWrite => ({ name: g.name }),
	writesText:
		"Switches the bill on under the name, and then matches the payments that arrived while it was off. The save refuses a name another active bill has.",
});

// Link a payment by hand.

export type LinkRequest = {
	/** The payment chosen, or null when the form named none. */
	transactionId: number | null;
	period: string;
};

export type LinkFacts = {
	/** The bill's months a payment can be linked to. */
	periods: string[];
	/** The three below are read only for one of those months, and are null otherwise. */
	monthUnpaid: boolean | null;
	paysAPlan: boolean | null;
	/** Money out, not split, not income, and within the bill's days of the month's due date. */
	withinWindow: boolean | null;
};

export type LinkWrite = { transactionId: number; period: string };

type LinkGiven = LinkRequest & LinkFacts;

export const linkPayment = rule({
	name: "Link a payment to a bill's month",
	given: (request: LinkRequest, facts: LinkFacts): LinkGiven => ({
		...request,
		...facts,
	}),
	refusals: [
		unless(
			term<LinkGiven>(
				"a payment and one of the bill's months were chosen",
				(g) => g.transactionId !== null && g.periods.includes(g.period),
			),
			() => new ChooseAPaymentAndMonth(),
		),
		unless(
			term<LinkGiven>(
				"the month is not paid yet",
				(g) => g.monthUnpaid !== false,
			),
			() => new MonthAlreadyPaid(),
		),
		unless(
			term<LinkGiven>(
				"the payment does not pay a planned expense",
				(g) => g.paysAPlan !== true,
			),
			() => new PaysAPlannedExpense(),
		),
		unless(
			term<LinkGiven>(
				"the payment is money out within the bill's days of the month's due date",
				(g) => g.withinWindow === true,
			),
			() => new NotWithinTheWindow(),
		),
	],
	writes: (g): LinkWrite => ({
		// The first refusal answered a form that named no payment, so this 0 is never used.
		transactionId: g.transactionId ?? 0,
		period: g.period,
	}),
	writesText:
		"Links the payment to the month and lifts its Not this one. The save refuses a month that was paid, or a payment that was linked or took a plan, meanwhile.",
});

// Not this one, and its Undo.

export type UnlinkRequest = {
	/** The payment the Not this one names, or null when it names none (a page from before a month could hold several). */
	named: number | null;
};

export type UnlinkWrite = { transactionId: number };

type UnlinkGiven = { chosen: number | null };

export const unlinkPayment = rule({
	name: "Not this one",
	given: (request: UnlinkRequest, facts: { linked: number[] }): UnlinkGiven => {
		const only = facts.linked.length === 1 ? facts.linked[0] : undefined;

		const named =
			request.named !== null && facts.linked.includes(request.named)
				? request.named
				: undefined;

		return { chosen: (request.named === null ? only : named) ?? null };
	},
	refusals: [
		unless(
			term<UnlinkGiven>(
				"the payment named is linked to the month, or none is named and the month has one payment",
				(g) => g.chosen !== null,
			),
			() => new NoSuchLinkedPayment(),
		),
	],
	writes: (g): UnlinkWrite => ({
		// The refusal answered a request with no payment to unlink, so this 0 is never used.
		transactionId: g.chosen ?? 0,
	}),
	writesText:
		"Unlinks the payment and remembers it is not this month's, with an Undo that works once for ten seconds.",
});

export type UndoUnlinkFacts = {
	/** The Not this one the token names, and whether its ten seconds are still running. */
	held: { transactionId: number; period: string; fresh: boolean } | null;
};

export type UndoUnlinkWrite = {
	transactionId: number;
	period: string;
	token: string;
};

type UndoUnlinkGiven = UndoUnlinkFacts & { token: string };

export const undoUnlink = rule({
	name: "Undo a Not this one",
	given: (
		request: { token: string },
		facts: UndoUnlinkFacts,
	): UndoUnlinkGiven => ({ ...request, ...facts }),
	refusals: [
		unless(
			term<UndoUnlinkGiven>(
				"the Not this one the Undo names is still there",
				(g) => g.held !== null,
			),
			() => new UnlinkUndoGone(),
		),
		unless(
			term<UndoUnlinkGiven>(
				"its ten seconds are still running",
				(g) => g.held?.fresh === true,
			),
			() => new UnlinkUndoTooLate(),
		),
	],
	writes: (g): UndoUnlinkWrite => ({
		// The first refusal answered an Undo with nothing held, so these blanks are never used.
		transactionId: g.held?.transactionId ?? 0,
		period: g.held?.period ?? "",
		token: g.token,
	}),
	writesText:
		"Links the payment to its month again and lifts the Not this one. The save refuses when the ten seconds ran out, or the payment was linked or took a plan, meanwhile.",
});

// A price change's two answers.

export type PriceFacts = {
	/** The price change on offer for the bill now, or null. */
	offer: {
		period: string;
		transactionId: number;
		/** The month's amount, in cents. */
		billCents: number;
		/** The charge, in cents. */
		amountCents: number;
	} | null;
	/** The bill's current amount, in cents. */
	currentCents: number;
};

export type PriceRequest = { period: string; transactionId: number };

/** The prices the page showed, in whole cents; NaN where the form sent none. */
export type SeenPrices = {
	billCents: number;
	chargeCents: number;
	currentCents: number;
};

type PriceGiven = PriceRequest & PriceFacts;

const offered = (g: PriceGiven) =>
	g.offer !== null &&
	g.offer.period === g.period &&
	g.offer.transactionId === g.transactionId;

const theOfferIsTheOneShown = unless(
	term<PriceGiven>(
		"the price change on offer is for the month and the payment the page showed",
		offered,
	),
	() => new PriceOfferGone(),
);

export type AcceptPriceWrite = PriceRequest & {
	billCents: number;
	currentCents: number;
};

type AcceptGiven = PriceGiven & { seen: SeenPrices };

export const acceptPrice = rule({
	name: "Accept a price change",
	given: (
		request: PriceRequest & { seen: SeenPrices },
		facts: PriceFacts,
	): AcceptGiven => ({ ...request, ...facts }),
	refusals: [
		theOfferIsTheOneShown,
		unless(
			term<AcceptGiven>(
				"the month's amount, the charge and the bill's amount are the ones the page showed",
				(g) =>
					g.seen.billCents === g.offer?.billCents &&
					g.seen.chargeCents === g.offer.amountCents &&
					g.seen.currentCents === g.currentCents,
			),
			() => new PriceOfferGone(),
		),
	],
	writes: (g): AcceptPriceWrite => ({
		period: g.period,
		transactionId: g.transactionId,
		billCents: g.seen.billCents,
		currentCents: g.seen.currentCents,
	}),
	writesText:
		"Sets the bill to the charge's amount from this month on and links the payment, then matches payments again. The save refuses prices that changed meanwhile.",
});

export const dismissPrice = rule({
	name: "Dismiss a price change",
	given: (request: PriceRequest, facts: PriceFacts): PriceGiven => ({
		...request,
		...facts,
	}),
	refusals: [theOfferIsTheOneShown],
	writes: (g): PriceRequest => ({
		period: g.period,
		transactionId: g.transactionId,
	}),
	writesText:
		"Remembers the payment is not this month's price, so the bill keeps its amount and the offer is not made again.",
});
