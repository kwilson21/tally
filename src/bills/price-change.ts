// "Price changed?" (spec §8.5 "Bill matching", decision 72, P36 B): a payment from the same merchant, in
// the date window but outside ±10% of the bill's amount, is offered to a person instead of being matched
// or ignored. The offer is worked out each time it's read, from the transaction and bill_payments tables,
// so nothing is stored until a person answers: accepting links the payment and sets the bill's amount;
// "Not this bill" stores a dismissal, the same `dismissed` row "Not this one" makes, so that payment is
// never offered for that bill and month again. An offer never links anything by itself.

import { daysBefore } from "../dates";
import {
	isMerchantTextSql,
	merchantColumnSql,
	merchantTextArgs,
} from "../db/merchant-key";
import { tidyName } from "../transactions/tidy-name";
import { BIG_BILL_CENTS } from "./guards";
import {
	BILL_DATE_WINDOW_DAYS,
	dayNumber,
	type MatchCandidate,
	withinBillAmount,
} from "./match";
import { putBackInBudget, setBillAmountStatement } from "./write";

/** The payment on offer for a bill's occurrence. */
export type PriceOffer = {
	transactionId: number;
	/** The bank's own date, as sent (YYYY-MM-DD). */
	date: string;
	amountCents: number;
	/** Who charged it, as a person knows the merchant. */
	merchant: string;
};

/**
 * The payment to offer for an occurrence, or undefined. Spec §6.1's date window and tie-break (closest to
 * the due date, then closest in amount, then earliest id) with the amount rule turned around: it is
 * outside ±10%, which the matcher leaves alone. It is money out, since a refund or a credit isn't a price,
 * and no more than $100,000, which a bill's own form asks a person to confirm (decision 72, P45 A).
 * `candidates` are the same-merchant payments that are unclaimed and not dismissed for this occurrence.
 */
export function pickPriceOffer<P extends MatchCandidate>(
	candidates: P[],
	dueDate: string,
	billAmountCents: number,
): P | undefined {
	const due = dayNumber(dueDate);
	const apart = (c: P) => Math.abs(dayNumber(c.date) - due);
	return candidates
		.filter(
			(c) =>
				apart(c) <= BILL_DATE_WINDOW_DAYS &&
				c.amountCents > 0 &&
				c.amountCents <= BIG_BILL_CENTS &&
				!withinBillAmount(c.amountCents, billAmountCents),
		)
		.sort(
			(a, b) =>
				apart(a) - apart(b) ||
				Math.abs(a.amountCents - billAmountCents) -
					Math.abs(b.amountCents - billAmountCents) ||
				a.id - b.id,
		)[0];
}

/** What an offer needs to know about a bill; the occurrence is the one Bills shows for it. */
export type OfferBill = {
	id: number;
	amountCents: number;
	/** The bill's merchant key (or the bank's raw text, when `merchantRawText` is 1), as §6.1 rule 1 matches it. */
	merchantRawName: string;
	merchantRawText: number;
	period: string;
	dueDate: string;
};

type Row = {
	id: number;
	date: string;
	amountCents: number;
	rawName: string;
	displayName: string | null;
};

/** The same-merchant payments near an occurrence that nothing has claimed and nobody has turned away. */
function candidates(db: D1Database, bill: OfferBill): D1PreparedStatement {
	return db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS rawName,
			        ${merchantColumnSql("t", "display_name")} AS displayName
			 FROM transactions t
			 WHERE ${isMerchantTextSql("t")} AND t.is_split = 0 AND t.flag_income = 0
			   AND t.date BETWEEN ? AND ?
			   AND NOT EXISTS (SELECT 1 FROM bill_payments claimed WHERE claimed.transaction_id = t.id AND claimed.status = 'linked')
			   AND NOT EXISTS (SELECT 1 FROM bill_payments dismissed WHERE dismissed.bill_id = ? AND dismissed.period = ? AND dismissed.transaction_id = t.id AND dismissed.status = 'dismissed')`,
		)
		.bind(
			...merchantTextArgs({
				merchant_raw_name: bill.merchantRawName,
				merchant_raw_text: bill.merchantRawText,
			}),
			daysBefore(bill.dueDate, BILL_DATE_WINDOW_DAYS),
			daysBefore(bill.dueDate, -BILL_DATE_WINDOW_DAYS),
			bill.id,
			bill.period,
		);
}

function offerFrom(rows: Row[], bill: OfferBill): PriceOffer | undefined {
	const picked = pickPriceOffer(rows, bill.dueDate, bill.amountCents);
	return picked
		? {
				transactionId: picked.id,
				date: picked.date,
				amountCents: picked.amountCents,
				merchant: picked.displayName ?? tidyName(picked.rawName),
			}
		: undefined;
}

/** The offer for one bill's occurrence, or undefined. */
export async function findPriceOffer(
	db: D1Database,
	bill: OfferBill,
): Promise<PriceOffer | undefined> {
	const { results } = await candidates(db, bill).all<Row>();
	return offerFrom(results, bill);
}

/** The offers for several bills at once, by bill id, in one round trip. */
export async function loadPriceOffers(
	db: D1Database,
	bills: OfferBill[],
): Promise<Map<number, PriceOffer>> {
	const offers = new Map<number, PriceOffer>();
	if (!bills.length) return offers;
	const answers = await db.batch<Row>(
		bills.map((bill) => candidates(db, bill)),
	);
	bills.forEach((bill, i) => {
		const offer = offerFrom(answers[i]?.results ?? [], bill);
		if (offer) offers.set(bill.id, offer);
	});
	return offers;
}

/**
 * A person says yes: the payment pays the occurrence (`matched_by = user`, and an excluded payment is put
 * back in the budget) and the bill's amount becomes what was charged, in one batch. False, with nothing
 * written, when the occurrence or the payment was taken since the offer was drawn.
 */
export async function acceptPriceOffer(
	db: D1Database,
	billId: number,
	period: string,
	offer: PriceOffer,
	actor: string,
): Promise<boolean> {
	const results = await db.batch([
		putBackInBudget(db, billId, period, offer.transactionId, actor),
		db
			.prepare(
				"INSERT OR IGNORE INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,?,'user','linked')",
			)
			.bind(billId, period, offer.transactionId),
		setBillAmountStatement(
			db,
			billId,
			offer.amountCents,
			period,
			offer.transactionId,
		),
	]);
	return (results[1]?.meta.changes ?? 0) > 0;
}

/**
 * A person says "Not this bill": a `dismissed` row, as "Not this one" records, so the payment isn't
 * offered again for this bill and month (and the matcher and the picker skip it too). Saying it twice
 * records it once.
 */
export async function dismissPriceOffer(
	db: D1Database,
	billId: number,
	period: string,
	transactionId: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status)
			 SELECT ?1,?2,?3,'user','dismissed'
			 WHERE NOT EXISTS (SELECT 1 FROM bill_payments WHERE bill_id = ?1 AND period = ?2 AND transaction_id = ?3 AND status = 'dismissed')`,
		)
		.bind(billId, period, transactionId)
		.run();
}
