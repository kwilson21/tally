export type BillStatus = "paid" | "overdue" | "due" | "upcoming";

export type BillSchedule = {
	frequency: "monthly" | "yearly";
	dueDay: number;
	anchorMonth?: number | null;
};

function leap(year: number) {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number) {
	return (
		[31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
			month - 1
		] ?? 31
	);
}

function ordinal(date: string) {
	const year = Number(date.slice(0, 4));
	const month = Number(date.slice(5, 7));
	const day = Number(date.slice(8, 10));
	let total = day;
	for (let y = 1970; y < year; y++) total += leap(y) ? 366 : 365;
	for (let m = 1; m < month; m++) total += daysInMonth(year, m);
	return total;
}

/** The occurrence for today's month/year, calculated entirely from calendar strings. */
export function billOccurrence(
	bill: BillSchedule,
	today: string,
	linked: boolean,
): { dueDate: string; period: string; status: BillStatus } {
	const year = Number(today.slice(0, 4));
	const month =
		bill.frequency === "yearly"
			? (bill.anchorMonth ?? 1)
			: Number(today.slice(5, 7));
	const day = Math.min(bill.dueDay, daysInMonth(year, month));
	const dueDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	const period =
		bill.frequency === "yearly" ? String(year) : dueDate.slice(0, 7);
	const distance = ordinal(dueDate) - ordinal(today);
	const status: BillStatus = linked
		? "paid"
		: distance < 0
			? "overdue"
			: distance <= 7
				? "due"
				: "upcoming";
	return { dueDate, period, status };
}
