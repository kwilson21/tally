import { householdToday } from "../dates";
import { amountRowsByBill } from "../db/bill-amounts";
import { paysPlanSql } from "../db/counted-month";
import { isMerchantTextSql, merchantTextArgs } from "../db/merchant-key";
import { type AmountRow, amountForMonth } from "./amount";
import {
	type BillFrequency,
	billOccurrenceForMonth,
	WEEKLY_BILL_DATE_WINDOW_DAYS,
} from "./status";

export const BILL_AMOUNT_TOLERANCE = 0.1;
export const BILL_DATE_WINDOW_DAYS = 5;

/** Spec §6.1 rule 3: a weekly bill's date window is ±3 days, so two weeks' windows never overlap; the others ±5. */
export const billDateWindowDays = (frequency: BillFrequency) =>
	frequency === "weekly" ? WEEKLY_BILL_DATE_WINDOW_DAYS : BILL_DATE_WINDOW_DAYS;

export type MatchCandidate = { id: number; date: string; amountCents: number };

export const dayNumber = (date: string) =>
	Math.floor(
		Date.UTC(
			Number(date.slice(0, 4)),
			Number(date.slice(5, 7)) - 1,
			Number(date.slice(8, 10)),
		) / 86_400_000,
	);

/** The date `shift` days from `date` (YYYY-MM-DD). */
const shiftDay = (date: string, shift: number) =>
	new Date((dayNumber(date) + shift) * 86_400_000).toISOString().slice(0, 10);

/**
 * The payments a bill could match, dated from `start` to `finish` (both included): one statement, whatever
 * the range, and it leaves out any payment already linked to a bill.
 */
async function candidatesBetween(
	db: D1Database,
	bill: Bill,
	start: string,
	finish: string,
): Promise<MatchCandidate[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id,t.date,t.amount_cents AS amountCents FROM transactions t
				 WHERE ${isMerchantTextSql("t")} AND t.is_split=0 AND t.flag_income=0
				 AND NOT (t.excluded=1 AND COALESCE(t.excluded_source,'')='user') AND t.date BETWEEN ? AND ?
				 AND NOT EXISTS (SELECT 1 FROM bill_payments claimed WHERE claimed.transaction_id=t.id AND claimed.status='linked')
				 AND NOT ${paysPlanSql("t")}`,
		)
		.bind(...merchantTextArgs(bill), start, finish)
		.all<MatchCandidate>();
	return results;
}

/** Spec §6.1 rule 2: a payment within ±10% of the bill's amount, both ends included. */
export const withinBillAmount = (paymentCents: number, billCents: number) =>
	10 * Math.abs(paymentCents - billCents) <= billCents;

/** Applies all four candidate rules and the deterministic §6.1 tie-break. */
export function pickBillPayment(
	candidates: MatchCandidate[],
	dueDate: string,
	amountCents: number,
	windowDays = BILL_DATE_WINDOW_DAYS,
): MatchCandidate | undefined {
	const due = dayNumber(dueDate);
	return candidates
		.filter(
			(candidate) => Math.abs(dayNumber(candidate.date) - due) <= windowDays,
		)
		.filter((candidate) => withinBillAmount(candidate.amountCents, amountCents))
		.sort(
			(a, b) =>
				Math.abs(dayNumber(a.date) - due) - Math.abs(dayNumber(b.date) - due) ||
				Math.abs(a.amountCents - amountCents) -
					Math.abs(b.amountCents - amountCents) ||
				a.id - b.id,
		)[0];
}

type Bill = {
	id: number;
	amount_cents: number;
	due_day: number;
	frequency: "monthly" | "yearly" | "weekly" | "biweekly" | "quarterly";
	anchor_month: number | null;
	anchor_date: string | null;
	/** The bill's merchant key, which a payment's merchant key (or its raw name, for a bill flagged below) must equal (spec §6.1 rule 1). */
	merchant_raw_name: string;
	/** 1 for a bill saved under the bank's raw text, before a merchant key existed. */
	merchant_raw_text: number;
};

/** The amount an occurrence due on `due` is matched at: its month's amount (src/bills/amount.ts). */
const occurrenceCents = (
	bill: Bill,
	due: string,
	rows: ReadonlyMap<number, AmountRow[]>,
) =>
	amountForMonth(rows.get(bill.id) ?? [], due.slice(0, 7), bill.amount_cents);

/**
 * Fills every unlinked occurrence in range; unique indexes remain the final concurrency guard.
 * `given` is the household's date when the caller already has it, otherwise it's read here.
 */
export async function matchBillPayments(
	db: D1Database,
	given?: string,
): Promise<number> {
	const today = given ?? (await householdToday(db));
	const first = await db
		.prepare("SELECT MIN(date) AS date FROM transactions")
		.first<{ date: string | null }>();
	if (!first?.date) return 0;
	const bills = (
		await db
			.prepare(
				"SELECT id,amount_cents,due_day,frequency,anchor_month,anchor_date,merchant_raw_name,merchant_raw_text FROM bills WHERE active=1",
			)
			.all<Bill>()
	).results;
	const endDay = dayNumber(today) + 7;
	// Each occurrence is matched at its own month's amount (decision 101, src/bills/amount.ts).
	const amountRows = await amountRowsByBill(db);
	type Pair = {
		bill: Bill;
		period: string;
		candidate: MatchCandidate;
		dateDistance: number;
		amountDistance: number;
	};
	const pairs: Pair[] = [];
	const firstDay = dayNumber(first.date);
	const linkedRows = (
		await db
			.prepare("SELECT bill_id,period FROM bill_payments WHERE status='linked'")
			.all<{ bill_id: number; period: string }>()
	).results;
	const linked = new Set(
		linkedRows.map((row) => `${row.bill_id}:${row.period}`),
	);
	const dismissedRows = (
		await db
			.prepare(
				"SELECT bill_id,period,transaction_id FROM bill_payments WHERE status='dismissed'",
			)
			.all<{ bill_id: number; period: string; transaction_id: number }>()
	).results;
	const dismissed = new Set(
		dismissedRows.map(
			(row) => `${row.bill_id}:${row.period}:${row.transaction_id}`,
		),
	);
	const reserved = new Set<number>();
	for (const bill of bills) {
		if (bill.frequency === "weekly" || bill.frequency === "biweekly") {
			const step = bill.frequency === "weekly" ? 7 : 14;
			const anchorDay =
				bill.frequency === "weekly"
					? firstDay -
						((new Date(`${first.date}T00:00:00Z`).getUTCDay() + 6) % 7) +
						(bill.due_day - 1)
					: dayNumber(bill.anchor_date ?? today);
			const window = billDateWindowDays(bill.frequency);
			// The first occurrence whose window reaches the first transaction, not only one falling on or
			// after it, so a payment the day after a due date still links to that due date.
			const firstOccurrence =
				anchorDay + Math.ceil((firstDay - window - anchorDay) / step) * step;
			let occurrenceDay = firstOccurrence;
			const occurrenceDates: { due: string; period: string; day: number }[] =
				[];
			while (occurrenceDay <= endDay + window) {
				const due = new Date(occurrenceDay * 86_400_000)
					.toISOString()
					.slice(0, 10);
				const period = due;
				if (!linked.has(`${bill.id}:${period}`)) {
					occurrenceDates.push({ due, period, day: occurrenceDay });
				}
				occurrenceDay += step;
			}
			if (occurrenceDates.length) {
				const firstOccurrenceDate = occurrenceDates[0];
				const lastOccurrenceDate = occurrenceDates.at(-1);
				if (!firstOccurrenceDate || !lastOccurrenceDate) continue;
				const startDate = new Date(
					(firstOccurrenceDate.day - window) * 86_400_000,
				)
					.toISOString()
					.slice(0, 10);
				const finishDate = new Date(
					(lastOccurrenceDate.day + window) * 86_400_000,
				)
					.toISOString()
					.slice(0, 10);
				const candidates = await candidatesBetween(
					db,
					bill,
					startDate,
					finishDate,
				);
				for (const { due, period, day } of occurrenceDates) {
					const cents = occurrenceCents(bill, due, amountRows);
					for (const candidate of candidates) {
						if (
							!pickBillPayment([candidate], due, cents, window) ||
							dismissed.has(`${bill.id}:${period}:${candidate.id}`)
						)
							continue;
						pairs.push({
							bill,
							period,
							candidate,
							dateDistance: Math.abs(dayNumber(candidate.date) - day),
							amountDistance: Math.abs(candidate.amountCents - cents),
						});
					}
				}
			}
			continue;
		}
		const firstMonth = new Date(`${first.date.slice(0, 7)}-01T00:00:00Z`);
		firstMonth.setUTCMonth(firstMonth.getUTCMonth() - 1);
		let year = firstMonth.getUTCFullYear();
		let month = firstMonth.getUTCMonth() + 1;
		// The occurrences still waiting on a payment, earliest first, read in one statement below.
		const occurrences: { due: string; period: string }[] = [];
		while (year < Number(today.slice(0, 4)) + 2) {
			if (bill.frequency === "yearly" && month !== bill.anchor_month) {
				month += 1;
				if (month === 13) {
					month = 1;
					year += 1;
				}
				continue;
			}
			if (
				bill.frequency === "quarterly" &&
				(month - (bill.anchor_month ?? 1) + 12) % 3 !== 0
			) {
				month += 1;
				if (month === 13) {
					month = 1;
					year += 1;
				}
				continue;
			}
			const schedule = {
				frequency: bill.frequency,
				dueDay: bill.due_day,
				anchorMonth: bill.anchor_month,
			};
			const { dueDate: due, period } = billOccurrenceForMonth(
				schedule,
				year,
				month,
			);
			if (dayNumber(due) > endDay) break;
			if (linked.has(`${bill.id}:${period}`)) {
				month += bill.frequency === "yearly" ? 12 : 1;
				while (month > 12) {
					month -= 12;
					year += 1;
				}
				continue;
			}
			occurrences.push({ due, period });
			month += bill.frequency === "yearly" ? 12 : 1;
			while (month > 12) {
				month -= 12;
				year += 1;
			}
		}
		const firstDue = occurrences[0];
		const lastDue = occurrences.at(-1);
		if (firstDue && lastDue) {
			// One statement for the whole bill, however many months of history it spans; each occurrence then
			// takes only the candidates inside its own date window.
			const candidates = await candidatesBetween(
				db,
				bill,
				shiftDay(firstDue.due, -BILL_DATE_WINDOW_DAYS),
				shiftDay(lastDue.due, BILL_DATE_WINDOW_DAYS),
			);
			for (const { due, period } of occurrences) {
				const cents = occurrenceCents(bill, due, amountRows);
				for (const candidate of candidates) {
					if (
						!pickBillPayment([candidate], due, cents) ||
						dismissed.has(`${bill.id}:${period}:${candidate.id}`)
					)
						continue;
					pairs.push({
						bill,
						period,
						candidate,
						dateDistance: Math.abs(dayNumber(candidate.date) - dayNumber(due)),
						amountDistance: Math.abs(candidate.amountCents - cents),
					});
				}
			}
		}
	}
	pairs.sort(
		(a, b) =>
			a.dateDistance - b.dateDistance ||
			a.amountDistance - b.amountDistance ||
			a.bill.id - b.bill.id ||
			a.candidate.id - b.candidate.id,
	);
	// A payment Plaid or Jev excluded qualifies (§6.1 rule 4, decision 67), and once linked it counts in Spent
	// whatever its exclusion (spec §8.5), which linking never writes. One a person excluded is theirs: the
	// matcher leaves it, and only their hand link takes it. Income is never a bill payment (the candidate
	// query leaves `flag_income` ones out, as the hand-link picker does).
	const assignments = assignPairs(pairs, reserved);
	if (!assignments.length) return 0;
	const result = await db
		.prepare(
			// An occurrence with a payment already linked (a part payment, too) takes no more from the matcher. The unique
			// index on one bill and period is gone (migration 0050), so this check is what keeps two runs from linking twice.
			// A payment a plan takes after the read above is skipped too, so the bill trigger (migration 0053) never aborts the run.
			`INSERT OR IGNORE INTO bill_payments(bill_id,period,transaction_id,matched_by,status) SELECT json_extract(value,'$.billId'),json_extract(value,'$.period'),json_extract(value,'$.transactionId'),'auto','linked' FROM json_each(?) WHERE NOT EXISTS (SELECT 1 FROM bill_payments l WHERE l.bill_id=json_extract(value,'$.billId') AND l.period=json_extract(value,'$.period') AND l.status='linked')
			 AND NOT EXISTS (SELECT 1 FROM transactions pt WHERE pt.id=json_extract(value,'$.transactionId') AND ${paysPlanSql("pt")})`,
		)
		.bind(
			JSON.stringify(
				assignments.map((pair) => ({
					billId: pair.bill.id,
					period: pair.period,
					transactionId: pair.candidate.id,
				})),
			),
		)
		.run();
	return result.meta.changes ?? 0;
}

type Pair = {
	bill: { id: number };
	period: string;
	candidate: { id: number };
};

/**
 * Picks one payment per occurrence and one occurrence per payment from pairs sorted
 * best-first. Closest pairs are taken first; then an occurrence left without a payment
 * may take one from another occurrence that has a different eligible payment, so no
 * bill stays unpaid while a valid payment exists for each.
 */
export function assignPairs<P extends Pair>(
	pairs: P[],
	reserved: ReadonlySet<number> = new Set(),
): P[] {
	const key = (p: P) => `${p.bill.id}:${p.period}`;
	const options = new Map<string, P[]>();
	for (const pair of pairs) {
		if (reserved.has(pair.candidate.id)) continue;
		const list = options.get(key(pair)) ?? [];
		list.push(pair);
		options.set(key(pair), list);
	}
	const byPayment = new Map<number, P>();
	const byOccurrence = new Map<string, P>();
	const take = (pair: P) => {
		byPayment.set(pair.candidate.id, pair);
		byOccurrence.set(key(pair), pair);
	};
	for (const pair of pairs)
		if (
			!reserved.has(pair.candidate.id) &&
			!byPayment.has(pair.candidate.id) &&
			!byOccurrence.has(key(pair))
		)
			take(pair);
	const augment = (occurrence: string, seen: Set<number>): boolean => {
		for (const pair of options.get(occurrence) ?? []) {
			const id = pair.candidate.id;
			if (seen.has(id)) continue;
			seen.add(id);
			const holder = byPayment.get(id);
			if (!holder || augment(key(holder), seen)) {
				take(pair);
				return true;
			}
		}
		return false;
	};
	for (const occurrence of options.keys())
		if (!byOccurrence.has(occurrence)) augment(occurrence, new Set());
	return [...byOccurrence.values()];
}
