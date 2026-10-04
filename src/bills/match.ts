import { todayUtc } from "../dates";

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
				Math.abs(candidate.amountCents - amountCents) <=
				Math.floor(amountCents * BILL_AMOUNT_TOLERANCE),
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

function dueDate(year: number, month: number, day: number) {
	const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

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
				"SELECT id,amount_cents,due_day,frequency,anchor_month,merchant_raw_name FROM bills",
			)
			.all<Bill>()
	).results;
	const endDay = dayNumber(today) + 7;
	const statements: D1PreparedStatement[] = [];
	const reserved = new Set<number>();
	for (const bill of bills) {
		let year = Number(first.date.slice(0, 4));
		let month = Number(first.date.slice(5, 7));
		while (year < Number(today.slice(0, 4)) + 2) {
			if (bill.frequency === "yearly" && month !== bill.anchor_month) {
				month += 1;
				if (month === 13) {
					month = 1;
					year += 1;
				}
				continue;
			}
			const due = dueDate(year, month, bill.due_day);
			if (dayNumber(due) > endDay) break;
			const period =
				bill.frequency === "monthly" ? due.slice(0, 7) : String(year);
			const alreadyLinked = await db
				.prepare(
					"SELECT 1 FROM bill_payments WHERE bill_id=? AND period=? AND status='linked'",
				)
				.bind(bill.id, period)
				.first();
			if (alreadyLinked) {
				month += bill.frequency === "yearly" ? 12 : 1;
				while (month > 12) {
					month -= 12;
					year += 1;
				}
				continue;
			}
			const candidates = (
				await db
					.prepare(
						`SELECT t.id,t.date,t.amount_cents AS amountCents FROM transactions t
				 WHERE t.raw_name=? AND t.excluded=0 AND t.is_split=0
				 AND NOT EXISTS (SELECT 1 FROM bill_payments claimed WHERE claimed.transaction_id=t.id AND claimed.status='linked')
				 AND NOT EXISTS (SELECT 1 FROM bill_payments dismissed WHERE dismissed.bill_id=? AND dismissed.period=? AND dismissed.transaction_id=t.id AND dismissed.status='dismissed')`,
					)
					.bind(bill.merchant_raw_name, bill.id, period)
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
