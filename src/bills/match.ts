import { todayUtc } from "../dates";
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
	merchant_raw_name: string;
};

/** Fills every unlinked occurrence in range; unique indexes remain the final concurrency guard. */
export async function matchBillPayments(
	db: D1Database,
	today = todayUtc(),
): Promise<number> {
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
	const statements: D1PreparedStatement[] = [];
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
			const start = new Date(`${due}T00:00:00Z`);
			const finish = new Date(start);
			start.setUTCDate(start.getUTCDate() - BILL_DATE_WINDOW_DAYS);
			finish.setUTCDate(finish.getUTCDate() + BILL_DATE_WINDOW_DAYS);
			const candidates = (
				await db
					.prepare(
						`SELECT t.id,t.date,t.amount_cents AS amountCents FROM transactions t
				 WHERE t.raw_name=? AND t.excluded=0 AND t.is_split=0
					 AND t.date BETWEEN ? AND ?
					 AND NOT EXISTS (SELECT 1 FROM bill_payments occurrence WHERE occurrence.bill_id=? AND occurrence.period=? AND occurrence.status='linked')
					 AND NOT EXISTS (SELECT 1 FROM bill_payments claimed WHERE claimed.transaction_id=t.id AND claimed.status='linked')
					 AND NOT EXISTS (SELECT 1 FROM bill_payments dismissed WHERE dismissed.bill_id=? AND dismissed.period=? AND dismissed.transaction_id=t.id AND dismissed.status='dismissed')`,
					)
					.bind(
						bill.merchant_raw_name,
						start.toISOString().slice(0, 10),
						finish.toISOString().slice(0, 10),
						bill.id,
						period,
						bill.id,
						period,
					)
					.all<MatchCandidate>()
			).results;
			const picked = pickBillPayment(
				candidates.filter((candidate) => !reserved.has(candidate.id)),
				due,
				bill.amount_cents,
			);
			if (picked)
				statements.push(
					db
						.prepare(
							"INSERT OR IGNORE INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,?,'auto','linked')",
						)
						.bind(bill.id, period, picked.id),
				);
			if (picked) reserved.add(picked.id);
			month += bill.frequency === "yearly" ? 12 : 1;
			while (month > 12) {
				month -= 12;
				year += 1;
			}
		}
	}
	if (!statements.length) return 0;
	const results = await db.batch(statements);
	return results.reduce(
		(total, result) => total + (result.meta.changes ?? 0),
		0,
	);
}
