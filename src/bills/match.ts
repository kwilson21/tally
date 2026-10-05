import { householdToday } from "../dates";
import { isMerchantTextSql, merchantTextArgs } from "../db/merchant-key";
import { billOccurrenceForMonth } from "./status";

export const BILL_AMOUNT_TOLERANCE = 0.1;
export const BILL_DATE_WINDOW_DAYS = 5;

export type MatchCandidate = { id: number; date: string; amountCents: number };

const dayNumber = (date: string) =>
	Math.floor(
		Date.UTC(
			Number(date.slice(0, 4)),
			Number(date.slice(5, 7)) - 1,
			Number(date.slice(8, 10)),
		) / 86_400_000,
	);

/** Applies all four candidate rules and the deterministic §6.1 tie-break. */
export function pickBillPayment(
	candidates: MatchCandidate[],
	dueDate: string,
	amountCents: number,
): MatchCandidate | undefined {
	const due = dayNumber(dueDate);
	return candidates
		.filter(
			(candidate) =>
				Math.abs(dayNumber(candidate.date) - due) <= BILL_DATE_WINDOW_DAYS,
		)
		.filter(
			(candidate) =>
				10 * Math.abs(candidate.amountCents - amountCents) <= amountCents,
		)
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
	frequency: "monthly" | "yearly";
	anchor_month: number | null;
	/** The bill's merchant key, which a payment's merchant key (or its raw name, for older bills) must equal (spec §6.1 rule 1). */
	merchant_raw_name: string;
};

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
				"SELECT id,amount_cents,due_day,frequency,anchor_month,merchant_raw_name FROM bills WHERE active=1",
			)
			.all<Bill>()
	).results;
	const endDay = dayNumber(today) + 7;
	type Pair = {
		bill: Bill;
		period: string;
		candidate: MatchCandidate;
		dateDistance: number;
		amountDistance: number;
	};
	const pairs: Pair[] = [];
	const linkedRows = (
		await db
			.prepare("SELECT bill_id,period FROM bill_payments WHERE status='linked'")
			.all<{ bill_id: number; period: string }>()
	).results;
	const linked = new Set(
		linkedRows.map((row) => `${row.bill_id}:${row.period}`),
	);
	const reserved = new Set<number>();
	for (const bill of bills) {
		const firstMonth = new Date(`${first.date.slice(0, 7)}-01T00:00:00Z`);
		firstMonth.setUTCMonth(firstMonth.getUTCMonth() - 1);
		let year = firstMonth.getUTCFullYear();
		let month = firstMonth.getUTCMonth() + 1;
		while (year < Number(today.slice(0, 4)) + 2) {
			if (bill.frequency === "yearly" && month !== bill.anchor_month) {
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
			const start = new Date(`${due}T00:00:00Z`);
			const finish = new Date(start);
			start.setUTCDate(start.getUTCDate() - BILL_DATE_WINDOW_DAYS);
			finish.setUTCDate(finish.getUTCDate() + BILL_DATE_WINDOW_DAYS);
			const candidates = (
				await db
					.prepare(
						`SELECT t.id,t.date,t.amount_cents AS amountCents FROM transactions t
				 WHERE ${isMerchantTextSql("t", "?")} AND t.excluded=0 AND t.is_split=0
					 AND t.date BETWEEN ? AND ?
					 AND NOT EXISTS (SELECT 1 FROM bill_payments occurrence WHERE occurrence.bill_id=? AND occurrence.period=? AND occurrence.status='linked')
					 AND NOT EXISTS (SELECT 1 FROM bill_payments claimed WHERE claimed.transaction_id=t.id AND claimed.status='linked')
					 AND NOT EXISTS (SELECT 1 FROM bill_payments dismissed WHERE dismissed.bill_id=? AND dismissed.period=? AND dismissed.transaction_id=t.id AND dismissed.status='dismissed')`,
					)
					.bind(
						...merchantTextArgs(bill.merchant_raw_name),
						start.toISOString().slice(0, 10),
						finish.toISOString().slice(0, 10),
						bill.id,
						period,
						bill.id,
						period,
					)
					.all<MatchCandidate>()
			).results;
			for (const candidate of candidates) {
				if (!pickBillPayment([candidate], due, bill.amount_cents)) continue;
				pairs.push({
					bill,
					period,
					candidate,
					dateDistance: Math.abs(dayNumber(candidate.date) - dayNumber(due)),
					amountDistance: Math.abs(candidate.amountCents - bill.amount_cents),
				});
			}
			month += bill.frequency === "yearly" ? 12 : 1;
			while (month > 12) {
				month -= 12;
				year += 1;
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
	const statements: D1PreparedStatement[] = [];
	for (const pair of assignPairs(pairs, reserved))
		statements.push(
			db
				.prepare(
					"INSERT OR IGNORE INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,?,'auto','linked')",
				)
				.bind(pair.bill.id, pair.period, pair.candidate.id),
		);
	if (!statements.length) return 0;
	const results = await db.batch(statements);
	return results.reduce(
		(total, result) => total + (result.meta.changes ?? 0),
		0,
	);
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
