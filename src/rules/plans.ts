// The plans area's rules (decisions 187 and 206): add, save, move, delete and restore a planned expense, and link or
// unlink its payment. Each takes a typed request and what is stored about the plan, and is written as a list of its
// parts (`rule`, in ./terms). The time, the Undo's token and the person are inputs (decision 195), and nothing here
// parses, reads a clock or touches the database. Whether a payment can pay a plan is the picker's own check
// (canPayPlanSql in src/db/planned-expenses.ts), read as a fact, so the list and the rule cannot disagree. The saves'
// guards are in src/db/plan-saves.ts (decision 190).
import * as Data from "effect/Data";
import { UNDO_MS } from "../undo";
import { rule, term, unless } from "./terms";

/** The fields a person sets in a plan's sheet. */
export type PlanFields = { name: string; amountCents: number; month: string };

export type PlanFacts = {
	/** The plan as it is stored, or null when it is gone. */
	plan: { name: string; month: string; paid: boolean } | null;
	/** Stands for everything the rule read. A save lands only while the stored rows still have this version. */
	version: string;
};

// The refusals: one class each, with the sentence a person reads.

export class PlanGone extends Data.TaggedError("PlanGone") {
	readonly say = "That planned expense is already gone.";
}

export class PlanMovedOrPaid extends Data.TaggedError("PlanMovedOrPaid") {
	readonly say = "That planned expense is already moved or paid.";
}

/** The page names the plan in this sentence ("Rent is already paid."); a rule sheet has no plan to name. */
export class PlanAlreadyPaid extends Data.TaggedError("PlanAlreadyPaid") {
	readonly say = "The planned expense is already paid.";
}

export class PaymentPaysABill extends Data.TaggedError("PaymentPaysABill") {
	readonly say = "That payment already pays a bill.";
}

export class PaymentPaysAPlan extends Data.TaggedError("PaymentPaysAPlan") {
	readonly say = "That payment already pays a planned expense.";
}

export class PaymentCannotBeLinked extends Data.TaggedError(
	"PaymentCannotBeLinked",
) {
	readonly say =
		"That payment can't be linked. It may already pay a bill or a planned expense.";
}

export class PlanUndoExpired extends Data.TaggedError("PlanUndoExpired") {
	readonly say = "Undo expired. The planned expense stays deleted.";
}

const planExists = unless(
	term<{ plan: PlanFacts["plan"] }>(
		"the planned expense exists",
		(g) => g.plan !== null,
	),
	() => new PlanGone(),
);

/** What adding a plan saves. It reads nothing stored, so it has no version. */
export type AddPlanWrite = PlanFields & { who: string };

export const addPlan = rule({
	name: "Add a planned expense",
	given: (request: AddPlanWrite, _facts: null) => request,
	refusals: [],
	writes: (g): AddPlanWrite => g,
	writesText:
		"Sets the amount aside in the chosen month, under the name given.",
});

export type EditPlanRequest = { id: number; fields: PlanFields };

export type EditPlanFacts = PlanFacts & {
	/** Whether the plan's payment can still pay it in the month the save names. False when it has none. */
	paymentFits: boolean;
};

/** What saving a plan stores: its fields, and whether it keeps its payment. `unlinked` is true when it had one and loses it. */
export type EditPlanWrite = EditPlanRequest & {
	keepPayment: boolean;
	unlinked: boolean;
	expectedVersion: string;
};

export const editPlan = rule({
	name: "Save a planned expense",
	given: (request: EditPlanRequest, facts: EditPlanFacts) => ({
		...request,
		...facts,
	}),
	refusals: [planExists],
	writes: (g): EditPlanWrite => ({
		id: g.id,
		fields: g.fields,
		keepPayment: g.paymentFits,
		unlinked: g.plan?.paid === true && !g.paymentFits,
		expectedVersion: g.version,
	}),
	writesText:
		"Saves the name, amount and month, and keeps the plan's payment only while that payment can still pay it in the new month.",
});

export type MovePlanRequest = { id: number; toMonth: string };

export type MovePlanWrite = MovePlanRequest & { expectedVersion: string };

export const movePlan = rule({
	name: "Move a planned expense to this month",
	given: (request: MovePlanRequest, facts: PlanFacts) => ({
		...request,
		...facts,
	}),
	refusals: [
		unless(
			term<{ plan: PlanFacts["plan"]; toMonth: string }>(
				"the planned expense is unpaid and set aside in an earlier month",
				(g) => g.plan !== null && !g.plan.paid && g.plan.month < g.toMonth,
			),
			() => new PlanMovedOrPaid(),
		),
	],
	writes: (g): MovePlanWrite => ({
		id: g.id,
		toMonth: g.toMonth,
		expectedVersion: g.version,
	}),
	writesText: "Sets the plan aside in this month.",
});

export type DeletePlanRequest = {
	id: number;
	/** The Undo's token, made by the caller. */
	token: string;
	/** The time of the delete (ms), which the Undo's ten seconds count from. */
	now: number;
};

export type DeletePlanWrite = DeletePlanRequest & { expectedVersion: string };

export const deletePlan = rule({
	name: "Delete or drop a planned expense",
	given: (request: DeletePlanRequest, facts: PlanFacts) => ({
		...request,
		...facts,
	}),
	refusals: [planExists],
	writes: (g): DeletePlanWrite => ({
		id: g.id,
		token: g.token,
		now: g.now,
		expectedVersion: g.version,
	}),
	writesText:
		"Deletes the plan and holds its values for ten seconds, so Undo can write it back.",
});

export type RestorePlanRequest = { token: string; now: number };

export type RestorePlanFacts = {
	/** The held delete for this token, or null when there is none (unknown, or already used). */
	hold: {
		name: string;
		createdMs: number;
		hadPayment: boolean;
		/** Whether the payment the plan had can still pay it. False when it had none. */
		paymentFits: boolean;
	} | null;
	version: string;
};

/** What Undo saves: the plan written back, with its payment only while that payment still fits. */
export type RestorePlanWrite = {
	token: string;
	name: string;
	keepPayment: boolean;
	unlinked: boolean;
	expectedVersion: string;
};

export const restorePlan = rule({
	name: "Undo a planned expense's delete",
	given: (request: RestorePlanRequest, facts: RestorePlanFacts) => ({
		...request,
		...facts,
	}),
	refusals: [
		unless(
			term<RestorePlanRequest & { hold: RestorePlanFacts["hold"] }>(
				"the delete is held and its ten seconds have not passed",
				(g) => g.hold !== null && g.hold.createdMs > g.now - UNDO_MS,
			),
			() => new PlanUndoExpired(),
		),
	],
	writes: (g): RestorePlanWrite => ({
		token: g.token,
		name: g.hold?.name ?? "",
		keepPayment: g.hold?.paymentFits === true,
		unlinked: g.hold?.hadPayment === true && !g.hold.paymentFits,
		expectedVersion: g.version,
	}),
	writesText:
		"Writes the plan back once, with its payment only while that payment can still pay it, and ends the Undo.",
});

export type LinkPaymentRequest = { id: number; transactionId: number };

export type LinkPaymentFacts = PlanFacts & {
	payment: {
		/** Whether the picker would list the payment for this plan. */
		fits: boolean;
		/** What the payment already pays, if anything. */
		pays: "bill" | "plan" | null;
	};
};

export type LinkPaymentWrite = LinkPaymentRequest & { expectedVersion: string };

type Linking = LinkPaymentRequest & LinkPaymentFacts;

export const linkPayment = rule({
	name: "Link a payment to a planned expense",
	given: (request: LinkPaymentRequest, facts: LinkPaymentFacts): Linking => ({
		...request,
		...facts,
	}),
	refusals: [
		planExists,
		// A plan paid by the time its link is sent says so first, as a paid bill month does (decision 82, #623).
		unless(
			term<Linking>(
				"the planned expense is not paid yet",
				(g) => g.plan?.paid !== true,
			),
			() => new PlanAlreadyPaid(),
		),
		unless(
			term<Linking>(
				"the payment does not already pay a bill",
				(g) => g.payment.fits || g.payment.pays !== "bill",
			),
			() => new PaymentPaysABill(),
		),
		unless(
			term<Linking>(
				"the payment does not already pay a planned expense",
				(g) => g.payment.fits || g.payment.pays !== "plan",
			),
			() => new PaymentPaysAPlan(),
		),
		unless(
			term<Linking>(
				"the payment can pay the plan: money out, not split or income, in the plan's month or the next",
				(g) => g.payment.fits,
			),
			() => new PaymentCannotBeLinked(),
		),
	],
	writes: (g): LinkPaymentWrite => ({
		id: g.id,
		transactionId: g.transactionId,
		expectedVersion: g.version,
	}),
	writesText: "Links the payment, so the plan is paid.",
});

export type UnlinkPaymentWrite = { id: number; expectedVersion: string };

export const unlinkPayment = rule({
	name: "Unlink a planned expense's payment",
	given: (request: { id: number }, facts: PlanFacts) => ({
		...request,
		...facts,
	}),
	nothingToDoIf: term<{ plan: PlanFacts["plan"] }>(
		"the planned expense has no payment linked",
		(g) => g.plan !== null && !g.plan.paid,
	),
	refusals: [planExists],
	writes: (g): UnlinkPaymentWrite => ({
		id: g.id,
		expectedVersion: g.version,
	}),
	writesText: "Unlinks the payment, which sets the plan aside again.",
});
