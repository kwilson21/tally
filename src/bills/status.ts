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
	return [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
		month - 1
	] as number;
}

function occurrence(bill: BillSchedule, year: number, month: number) {
	const day = Math.min(bill.dueDay, daysInMonth(year, month));
	const dueDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	return {
		dueDate,
		period: bill.frequency === "yearly" ? String(year) : dueDate.slice(0, 7),
	};
}

function addMonth(year: number, month: number) {
	return month === 12 ? [year + 1, 1] : [year, month + 1];
}

function daysBetween(from: string, to: string) {
	const utc = (date: string) =>
		Date.UTC(
			Number(date.slice(0, 4)),
			Number(date.slice(5, 7)) - 1,
			Number(date.slice(8, 10)),
		);
	return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** Select the occurrence a person needs to act on, including the next calendar period. */
export function billOccurrence(
	bill: BillSchedule,
	today: string,
	linked: boolean | ReadonlySet<string>,
): { dueDate: string; period: string; status: BillStatus } {
	const year = Number(today.slice(0, 4));
	const month = Number(today.slice(5, 7));
	let current: ReturnType<typeof occurrence>;
	let next: ReturnType<typeof occurrence>;
	if (bill.frequency === "monthly") {
		current = occurrence(bill, year, month);
		const [nextYear, nextMonth] = addMonth(year, month) as [number, number];
		next = occurrence(bill, nextYear, nextMonth);
		// Before this month's due window, retain an unpaid prior occurrence rather
		// than making a missed bill disappear as merely upcoming on the first.
		if (daysBetween(today, current.dueDate) > 7) {
			const [previousYear, previousMonth] =
				month === 1 ? [year - 1, 12] : [year, month - 1];
			const previous = occurrence(bill, previousYear, previousMonth);
			if (
				daysBetween(today, previous.dueDate) >= -7 &&
				!isLinkedPeriod(linked, previous.period)
			)
				current = previous;
		}
	} else {
		const anchor = bill.anchorMonth ?? 1;
		current = occurrence(bill, year, anchor);
		next = occurrence(bill, year + 1, anchor);
		// A yearly bill is not overdue for the rest of the year. Once its month
		// has passed, the next annual occurrence is the useful one to show.
		if (month > anchor) current = next;
	}

	const isLinked = (period: string) => isLinkedPeriod(linked, period);
	const nextDistance = daysBetween(today, next.dueDate);
	if (bill.frequency === "monthly" && nextDistance >= 0 && nextDistance <= 7)
		current = next;
	else if (isLinked(current.period) && nextDistance >= 0 && nextDistance <= 7)
		current = next;

	const distance = daysBetween(today, current.dueDate);
	const status: BillStatus = isLinked(current.period)
		? "paid"
		: distance < 0
			? "overdue"
			: distance <= 7
				? "due"
				: "upcoming";
	return { ...current, status };
}

function isLinkedPeriod(linked: boolean | ReadonlySet<string>, period: string) {
	return typeof linked === "boolean" ? linked : linked.has(period);
}
