// "Price changed?" (spec §8.5 "Bill matching", decision 72, P36 B): a payment from the same merchant, in
// the date window but outside ±10% of the bill's amount, is offered to a person instead of being matched
// or ignored. The offer is worked out each time it's read, from the transaction and bill_payments tables,
// so nothing is stored until a person answers: accepting links the payment and sets the bill's amount;
// "Not this bill" stores a dismissal, the same `dismissed` row "Not this one" makes, so that payment is
// never offered for that bill and month again. An offer never links anything by itself.

import { daysBefore, householdMonth } from "../dates";
import {
	isMerchantTextSql,
	merchantColumnSql,
	merchantTextArgs,
} from "../db/merchant-key";
import { ownNameSql } from "../db/own-name";
import { tidyName } from "../transactions/tidy-name";
import { BIG_BILL_CENTS } from "./guards";
import {
	BILL_DATE_WINDOW_DAYS,
	billDateWindowDays,
	dayNumber,
	type MatchCandidate,
	withinBillAmount,
} from "./match";
import type { BillFrequency, BillStatus } from "./status";

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
 * `windowDays` is the bill's own date window (`billDateWindowDays`), the one the matcher uses.
 */
export function pickPriceOffer<P extends MatchCandidate>(
	candidates: P[],
	dueDate: string,
	billAmountCents: number,
	windowDays = BILL_DATE_WINDOW_DAYS,
): P | undefined {
	const due = dayNumber(dueDate);
	const apart = (c: P) => Math.abs(dayNumber(c.date) - due);
	return candidates
		.filter(
			(c) =>
				apart(c) <= windowDays &&
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

/**
 * What an offer needs to know about a bill; the occurrence is the one Bills shows for it, with the
 * status `billOccurrence` gave it. An offer is only for an active bill whose occurrence is unpaid, which
 * is to say due or overdue with no payment linked (paid has one; upcoming is weeks away). The frequency
 * sets the date window, as it does for the matcher.
 */
export type OfferBill = {
	id: number;
	active: boolean;
	status: BillStatus;
	frequency: BillFrequency;
	amountCents: number;
	/** The bill's merchant key (or the bank's raw text, when `merchantRawText` is 1), as §6.1 rule 1 matches it. */
	merchantRawName: string;
	merchantRawText: number;
	period: string;
	dueDate: string;
	/** What the occurrence's linked payments add up to, in cents: an occurrence with any part payment is not asked about. */
	paidCents: number;
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
	const window = billDateWindowDays(bill.frequency);
	return db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS rawName,
			        COALESCE(${ownNameSql("t")}, ${merchantColumnSql("t", "display_name")}) AS displayName
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
			daysBefore(bill.dueDate, window),
			daysBefore(bill.dueDate, -window),
			bill.id,
			bill.period,
		);
}

function offerFrom(rows: Row[], bill: OfferBill): PriceOffer | undefined {
	const picked = pickPriceOffer(
		rows,
		bill.dueDate,
		bill.amountCents,
		billDateWindowDays(bill.frequency),
	);
	return picked
		? {
				transactionId: picked.id,
				date: picked.date,
				amountCents: picked.amountCents,
				merchant: picked.displayName ?? tidyName(picked.rawName),
			}
		: undefined;
}

/**
 * Whether an occurrence can be asked about at all: an active bill, due or overdue, with no payment linked (a part
 * payment counts as one, so a part-paid occurrence is not asked about either).
 */
const asks = (bill: OfferBill) =>
	bill.active &&
	(bill.status === "due" || bill.status === "overdue") &&
	bill.paidCents === 0;

/** The offer for one bill's occurrence, or undefined. */
export async function findPriceOffer(
	db: D1Database,
	bill: OfferBill,
): Promise<PriceOffer | undefined> {
	if (!asks(bill)) return undefined;
	const { results } = await candidates(db, bill).all<Row>();
	return offerFrom(results, bill);
}

/** The offers for several bills at once, by bill id, in one round trip. */
export async function loadPriceOffers(
	db: D1Database,
	bills: OfferBill[],
): Promise<Map<number, PriceOffer>> {
	const offers = new Map<number, PriceOffer>();
	const asked = bills.filter(asks);
	if (!asked.length) return offers;
	const answers = await db.batch<Row>(
		asked.map((bill) => candidates(db, bill)),
	);
	asked.forEach((bill, i) => {
		const offer = offerFrom(answers[i]?.results ?? [], bill);
		if (offer) offers.set(bill.id, offer);
	});
	return offers;
}

/**
 * The amount the occurrence due in ?6 is judged at, as src/bills/amount.ts's `amountForMonth` reads it: the
 * latest row on or before that month, else the earliest row, else the bill's own amount.
 */
const occurrenceAmountSql = `COALESCE(
	(SELECT amount_cents FROM bill_amounts WHERE bill_id = ?2 AND effective_month <= ?6 ORDER BY effective_month DESC LIMIT 1),
	(SELECT amount_cents FROM bill_amounts WHERE bill_id = ?2 ORDER BY effective_month LIMIT 1),
	(SELECT amount_cents FROM bills WHERE id = ?2))`;

/**
 * What must still be true for an accept to go through, as one condition every statement of it shares:
 * linking the payment to the occurrence would be new (nothing is linked to the payment, and nothing to
 * the occurrence), the payment is still the charge the person saw, the occurrence is still at the amount
 * they saw, and the bill is still at its current amount, which `seenCurrent` (?7) holds. The bill may also
 * be at the charge already: the amount update runs before the link and moves it there, and the link is then
 * checked against the same condition. Numbered parameters: ?1 payment, ?2 bill, ?3 period, ?6 the
 * occurrence's month, ?7 the bill's current amount on the page, and the charge and the occurrence's amount
 * seen, named by `charge` and `seen`.
 */
const stillOffered = (charge: string, seen: string) =>
	`NOT EXISTS (SELECT 1 FROM bill_payments linked WHERE linked.status = 'linked'
	   AND (linked.transaction_id = ?1 OR (linked.bill_id = ?2 AND linked.period = ?3)))
	 AND EXISTS (SELECT 1 FROM transactions WHERE id = ?1 AND amount_cents = ${charge})
	 AND ${occurrenceAmountSql} IN (${charge}, ${seen})
	 AND EXISTS (SELECT 1 FROM bills WHERE id = ?2 AND amount_cents IN (${charge}, ?7))`;

/**
 * A person says yes: the payment pays the occurrence (`matched_by = user`) and the bill's amount becomes
 * what was charged, in one batch. An excluded payment counts once linked, whatever its exclusion (spec
 * §8.5), which this never writes. The page's prices must all still hold: `seenBillCents` is the
 * occurrence's amount on the page they answered, the offer's amount is the charge on it, and
 * `seenCurrentCents` is the bill's own current amount there.
 *
 * Every statement carries the same condition (`stillOffered`), checked as the batch runs, so they
 * write together or not at all: if another tab linked this payment or this month in the meantime, or the
 * bill was edited, or the charge corrected, nothing is written and this returns false. The amount row and
 * the update go before the link on purpose: the link is then checked against the charge the update set.
 */
export async function acceptPriceOffer(
	db: D1Database,
	billId: number,
	period: string,
	offer: PriceOffer,
	seenBillCents: number,
	dueMonth: string,
	/** The bill's current amount (`bills.amount_cents`) on the page they answered, in whole cents. */
	seenCurrentCents: number,
	/** The household's month (YYYY-MM) when the caller has it; read here otherwise. */
	month?: string,
): Promise<boolean> {
	// The new amount takes effect this month (decision 101): its row replaces this month's if there is one,
	// and the bill's own amount is the current one. Earlier months keep the amounts they had.
	const binds = [
		offer.transactionId,
		billId,
		period,
		offer.amountCents,
		seenBillCents,
		dueMonth,
		seenCurrentCents,
		month ?? (await householdMonth(db)),
	];
	// D1 wants exactly the parameters a statement names, so the two that don't use ?8 get the first seven.
	const results = await db.batch([
		db
			.prepare(
				`INSERT INTO bill_amounts (bill_id, effective_month, amount_cents)
				 SELECT ?2, ?8, ?4 WHERE ${stillOffered("?4", "?5")}
				 ON CONFLICT (bill_id, effective_month) DO UPDATE SET amount_cents = excluded.amount_cents`,
			)
			.bind(...binds),
		db
			.prepare(
				`UPDATE bills SET amount_cents = ?4 WHERE id = ?2 AND ${stillOffered("?4", "?5")}`,
			)
			.bind(...binds.slice(0, 7)),
		db
			.prepare(
				`INSERT OR IGNORE INTO bill_payments(bill_id,period,transaction_id,matched_by,status)
				 SELECT ?2, ?3, ?1, 'user', 'linked' WHERE ${stillOffered("?4", "?5")}`,
			)
			.bind(...binds.slice(0, 7)),
	]);
	return (results[2]?.meta.changes ?? 0) > 0;
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
