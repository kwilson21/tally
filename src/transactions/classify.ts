// What Tally thinks about one transaction, written as plain TypeScript.
//
// The app asks its questions in SQL (src/db/*.ts), because the queries need them. This file says the same rules
// again, in short named facts, so a person can read them in one place. test/classify.test.ts runs every SQL question
// and this function over the same rows, and fails on any row where they disagree. So the SQL stays the source of
// truth, and this file is the readable check on it. The app never imports this file.
//
// A row is not one state. It can be a split part, a credit, linked to a refund and excluded, all at once. So the
// meaning is five separate answers, and one enum would need a case for every mix:
//   structure  whole, split parent, or split part            (is_split, parent_id)
//   budget     counted, or left out of the budget            (excluded, pays a bill or plan)
//   income     income, or not                                (flag_income, income_source)
//   money      a purchase, or a credit and where its review stands
//   category   set, or unset with Jev's guess                (category_id, category_source, category_confidence)
// `questions` are the yes or no answers the app's queries give, worked out from those.
//
// Plaid's sign: positive = money out, negative = money in. A money-in row is called a "credit" here.

import { confidenceBasisPoints } from "../ai/confidence";
import { askedBounds } from "../ai/maybe";

/** The columns this file reads, as SELECT * gives them (SQLite gives 0 and 1 for booleans, and null). */
export type Row = {
	id: number;
	amount_cents: number;
	pending: number;
	parent_id: number | null;
	is_split: number;
	excluded: number;
	excluded_source: "user" | "jev" | "plaid" | null;
	flag_transfer: number;
	flag_income: number;
	income_source: "user" | "jev" | null;
	plaid_category: string | null;
	category_id: number | null;
	category_source: "user" | "merchant_rule" | "jev" | "bill" | null;
	category_confidence: number | null;
	jev_category_id: number | null;
	income_confidence: number | null;
	transfer_confidence: number | null;
	credit_reviewed: number | null;
	credit_reviewed_by: "user" | null;
	income_maybe_declined: number;
	refund_of_id: number | null;
	jev_failed_at: string | null;
	plaid_transaction_id: string | null;
};

/** Facts that live in other tables or other rows. The caller looks them up and passes them in. */
export type Context = {
	/** A bill payment or a planned expense is linked to this row, or to its split parent. */
	paysBillOrPlan: boolean;
	/** The purchase this row refunds (refund_of_id), or null when it refunds nothing. */
	refundTarget: { excluded: boolean; categoryId: number | null } | null;
	/** The category Jev picked is still active. */
	jevCategoryActive: boolean;
	/** At least one category is active, so Jev can be asked about categories. */
	anyActiveCategory: boolean;
	/** A "Never suggest income" rule matches this row's store. */
	neverSuggestIncome: boolean;
};

// ---- the five answers -----------------------------------------------------------------------------------------------

export type Structure =
	| { kind: "whole" }
	| { kind: "split_parent" }
	| { kind: "split_part"; parentId: number }
	// Should not happen, but the schema allows it. Only SQL's own checks decide what it means.
	| { kind: "split_part_also_marked_split"; parentId: number };

export type Budget =
	| { kind: "counted"; because: "not_excluded" | "pays_bill_or_plan" }
	| { kind: "left_out"; by: "user" | "jev" | "plaid" | "unknown" };

export type Income =
	| { kind: "not_income" }
	| { kind: "income"; setBy: "user" | "jev" | "plaid" | "unknown" };

export type Money =
	| { kind: "purchase" }
	| { kind: "credit"; state: CreditState };

export type CreditState =
	// Money in that nobody has reviewed, in the budget, not income and not a split parent: it waits for a person
	// (decision 70). Exactly the rows HELD_FOR_REVIEW_SQL matches.
	| { kind: "held_for_review" }
	// Money in flagged as income by Tally, not reviewed. It counts as income, so it is not held.
	| { kind: "unreviewed_income" }
	// Money in, not reviewed, and not held: out of the budget, or a split parent.
	| { kind: "unreviewed_not_held" }
	// A reviewed credit that is not a refund of a counted purchase.
	| { kind: "reviewed"; by: "user" | "other" }
	// A reviewed refund whose purchase is still counted. It takes the purchase's month and category.
	| { kind: "follows_purchase" };

export type Guess =
	| { kind: "none" }
	// Below 40%: kept as stored, but not shown as a Maybe and not asked.
	| { kind: "below_floor" }
	// From 40% up to, not including, 80%: shown as a dashed Maybe and asked.
	| { kind: "maybe" }
	| { kind: "sure" };

export type Category =
	| { kind: "set"; id: number; source: Row["category_source"] }
	| { kind: "unset"; source: Row["category_source"]; guess: Guess };

export type Questions = {
	/**
	 * Needs category, Home's count and Organize: a counted row with no category that is not income, not a split
	 * parent, not a refund that follows its purchase, and not a held credit (money in that nobody reviewed).
	 */
	needsCategory: boolean;
	/**
	 * Waiting: needs a category, and nothing has set a category source yet (a person, a merchant rule, Jev or a bill),
	 * it is not a split part, and it is not pending.
	 */
	waiting: boolean;
	/** Held for review: money in that nobody has reviewed. */
	heldForReview: boolean;
	/** The rows Jev may be asked about, before the switches are read. */
	needsJevClassification: boolean;
	/** A credit a person already decided. Jev may only help with its category. */
	categoryOnly: boolean;
	/** Still waiting for Jev, with categories and income switched on. */
	waitingForJev: boolean;
	/** In the budget (Included). */
	included: boolean;
	/** A refund whose purchase is still counted (follows its purchase). */
	follows: boolean;
	/** Jev may be asked about this row (jevAsksAbout). */
	jevMayBeAsked: boolean;
	/** The review screen asks "is it this category?". */
	categoryAsked: boolean;
	/** The review screen asks "is this income?". */
	incomeAsked: boolean;
	/** The first page asks "is this your pay?". */
	payAsked: boolean;
};

export type Classified = {
	structure: Structure;
	budget: Budget;
	income: Income;
	money: Money;
	category: Category;
	questions: Questions;
};

// ---- the facts each answer is built from -------------------------------------------------------------------------------

function structureOf(r: Row): Structure {
	if (r.parent_id !== null) {
		const parentId = r.parent_id;
		return r.is_split === 1
			? { kind: "split_part_also_marked_split", parentId }
			: { kind: "split_part", parentId };
	}
	if (r.is_split === 1) return { kind: "split_parent" };
	return { kind: "whole" };
}

function budgetOf(r: Row, ctx: Context): Budget {
	if (r.excluded === 0) return { kind: "counted", because: "not_excluded" };
	// A payment for a bill or a plan counts even when it is excluded, so the bill counts once.
	if (ctx.paysBillOrPlan)
		return { kind: "counted", because: "pays_bill_or_plan" };
	return { kind: "left_out", by: r.excluded_source ?? "unknown" };
}

function incomeOf(r: Row): Income {
	if (r.flag_income === 0) return { kind: "not_income" };
	if (r.income_source !== null)
		return { kind: "income", setBy: r.income_source };
	// Plaid set the flag from its own INCOME category, and nobody has changed it since.
	if (r.plaid_category === "INCOME") return { kind: "income", setBy: "plaid" };
	return { kind: "income", setBy: "unknown" };
}

function moneyOf(
	r: Row,
	ctx: Context,
	income: Income,
	counted: boolean,
): Money {
	if (r.amount_cents >= 0) return { kind: "purchase" };
	const reviewed = (r.credit_reviewed ?? 0) === 1;
	if (!reviewed) {
		if (income.kind === "income")
			return { kind: "credit", state: { kind: "unreviewed_income" } };
		if (counted && r.is_split === 0)
			return { kind: "credit", state: { kind: "held_for_review" } };
		return { kind: "credit", state: { kind: "unreviewed_not_held" } };
	}
	const purchaseCounts =
		ctx.refundTarget !== null && !ctx.refundTarget.excluded;
	if (purchaseCounts && income.kind === "not_income")
		return { kind: "credit", state: { kind: "follows_purchase" } };
	return {
		kind: "credit",
		state: {
			kind: "reviewed",
			by: r.credit_reviewed_by === "user" ? "user" : "other",
		},
	};
}

/** Jev's guess, read against the Maybe range: 40% up to 80% is asked. Basis points keep the edges exact. */
function guessOf(r: Row): Guess {
	if (r.category_confidence === null) return { kind: "none" };
	const basisPoints = confidenceBasisPoints(r.category_confidence);
	const { above, below } = askedBounds("category");
	if (basisPoints >= below) return { kind: "sure" };
	if (basisPoints > above) return { kind: "maybe" };
	return { kind: "below_floor" };
}

function categoryOf(r: Row): Category {
	if (r.category_id !== null)
		return { kind: "set", id: r.category_id, source: r.category_source };
	return { kind: "unset", source: r.category_source, guess: guessOf(r) };
}

/** Whether a stored confidence is inside the asked range for a kind (40% to 80% for categories, 20% to 80% for income). */
function inAskedRange(
	kind: "category" | "income",
	confidence: number | null,
): boolean {
	if (confidence === null) return false;
	const { above, below } = askedBounds(kind);
	const basisPoints = confidenceBasisPoints(confidence);
	return basisPoints > above && basisPoints < below;
}

// ---- the function ------------------------------------------------------------------------------------------------------

export function classify(r: Row, ctx: Context): Classified {
	const structure = structureOf(r);
	const budget = budgetOf(r, ctx);
	const income = incomeOf(r);
	const money = moneyOf(r, ctx, income, budget.kind === "counted");
	const category = categoryOf(r);
	const questions = questionsOf(r, ctx, {
		structure,
		budget,
		income,
		money,
		category,
	});
	return { structure, budget, income, money, category, questions };
}

function questionsOf(
	r: Row,
	ctx: Context,
	a: Omit<Classified, "questions">,
): Questions {
	// Plain facts about the row, named once so each question reads as a sentence.
	const counted = a.budget.kind === "counted";
	const notSplitParent = r.is_split === 0;
	const notPart = r.parent_id === null;
	const isIncome = a.income.kind === "income";
	const isCredit = r.amount_cents < 0;
	const creditReviewed = (r.credit_reviewed ?? 0) === 1;
	const pending = r.pending === 1;
	const follows =
		a.money.kind === "credit" && a.money.state.kind === "follows_purchase";
	const heldCredit = isCredit && !creditReviewed;
	const hasCategory = r.category_id !== null;
	const hasCategorySource = r.category_source !== null;

	// A refund that follows its purchase takes the purchase's category.
	const countedCategory = follows
		? (ctx.refundTarget?.categoryId ?? null)
		: r.category_id;

	// Someone chose the income or the credit's review, so Jev and the questions leave it alone.
	const personChose =
		r.income_source === "user" || r.credit_reviewed_by === "user";
	// The income question is settled once a person chose, Jev answered, or Plaid set the flag.
	const incomeSettled =
		personChose ||
		r.income_source === "jev" ||
		(a.income.kind === "income" && a.income.setBy === "plaid");
	// The income guess the queue reads: none once settled, or when a Never suggest rule hides it.
	const incomeGuess =
		incomeSettled || ctx.neverSuggestIncome ? null : r.income_confidence;
	// The guess the first page reads: a Never suggest rule does not hide it, but a No does.
	const storedIncomeGuess =
		incomeSettled || r.income_maybe_declined === 1 ? null : r.income_confidence;

	// Only Jev's category can help a credit a person already reviewed, so it is asked for the category alone.
	const categoryOnly =
		(isCredit && creditReviewed && personChose) ||
		(r.excluded === 1 && ctx.paysBillOrPlan);
	const noCategoryYet = !hasCategory && !hasCategorySource;

	const needsCategory =
		countedCategory === null &&
		counted &&
		notSplitParent &&
		!isIncome &&
		!follows &&
		!heldCredit;

	const waiting =
		needsCategory &&
		!hasCategorySource &&
		notPart &&
		notSplitParent &&
		!pending;

	// Read from the money state, so the named state and this question always agree (decision 174).
	const heldForReview =
		a.money.kind === "credit" && a.money.state.kind === "held_for_review";

	const needsJevClassification =
		counted &&
		notSplitParent &&
		!isIncome &&
		((!personChose && (noCategoryYet || heldCredit)) ||
			(noCategoryYet && isCredit && creditReviewed && personChose));

	// Jev's work for a row: a category or an income answer that is still missing.
	const categoryAnswerMissing = r.category_confidence === null;
	// With a category active, Jev can always be asked. With none, only an outgoing payment a person did not
	// put back in the budget can be asked for its transfer answer, which is the category question's stand-in.
	const categoryQuestionPossible =
		ctx.anyActiveCategory ||
		(!categoryOnly &&
			r.amount_cents > 0 &&
			r.transfer_confidence === null &&
			r.excluded_source !== "user");
	const categoryWork = categoryAnswerMissing && categoryQuestionPossible;
	const incomeWork = !categoryOnly && isCredit && r.income_confidence === null;
	// Imported from Plaid and not failed, and Jev has a question for it (with the same switches the count uses).
	const importedAndNotFailed =
		r.plaid_transaction_id !== null && r.jev_failed_at === null;
	const waitingForJev =
		importedAndNotFailed &&
		!follows &&
		needsJevClassification &&
		(categoryWork || incomeWork);

	// Jev may be asked about a counted row that is not a split, not income, and not a refund that follows its purchase.
	const jevMayBeAsked = counted && notSplitParent && !isIncome && !follows;

	const categoryAsked =
		notPart &&
		notSplitParent &&
		!hasCategory &&
		!hasCategorySource &&
		inAskedRange("category", r.category_confidence) &&
		!isIncome &&
		jevMayBeAsked &&
		!heldCredit &&
		ctx.jevCategoryActive &&
		!pending;

	const incomeAsked =
		notPart &&
		notSplitParent &&
		r.refund_of_id === null &&
		isCredit &&
		!isIncome &&
		!creditReviewed &&
		counted &&
		r.income_maybe_declined === 0 &&
		inAskedRange("income", incomeGuess) &&
		r.flag_transfer === 0 &&
		!pending;

	// The first page's pay question: it asks about money in, counted or excluded, that no person has chosen.
	const payAsked =
		isCredit &&
		r.excluded === 0 &&
		notPart &&
		notSplitParent &&
		r.refund_of_id === null &&
		r.flag_transfer === 0 &&
		r.income_source !== "user" &&
		(r.flag_income === 1 || inAskedRange("income", storedIncomeGuess));

	return {
		needsCategory,
		waiting,
		heldForReview,
		needsJevClassification,
		categoryOnly,
		waitingForJev,
		included: counted,
		follows,
		jevMayBeAsked,
		categoryAsked,
		incomeAsked,
		payAsked,
	};
}
