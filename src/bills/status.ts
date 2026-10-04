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

/**
 * The occurrence a person needs to act on (decision 62): the latest one due by a
 * week from now. A missed bill stays overdue until it is paid or the next one is
 * due, which then takes its place. A paid occurrence from an earlier month gives
 * way to the next one, so "Paid" always means paid this month.
 */
export function billOccurrence(
	bill: BillSchedule,
	today: string,
	linked: boolean | ReadonlySet<string>,
): { dueDate: string; period: string; status: BillStatus } {
	const year = Number(today.slice(0, 4));
	const month = Number(today.slice(5, 7));
	let occurrences: ReturnType<typeof occurrence>[];
	if (bill.frequency === "monthly") {
		const [previousYear, previousMonth] =
			month === 1 ? [year - 1, 12] : [year, month - 1];
		const [nextYear, nextMonth] = addMonth(year, month) as [number, number];
		occurrences = [
			occurrence(bill, previousYear, previousMonth),
			occurrence(bill, year, month),
			occurrence(bill, nextYear, nextMonth),
		];
	} else {
		const anchor = bill.anchorMonth ?? 1;
		occurrences = [year - 1, year, year + 1].map((y) =>
			occurrence(bill, y, anchor),
		);
	}
	const isLinked = (period: string) => isLinkedPeriod(linked, period);
	// The latest occurrence due by a week from now; the one after it is upcoming.
	let index = 0;
	occurrences.forEach((o, i) => {
		if (daysBetween(today, o.dueDate) <= 7) index = i;
	});
	const shown = occurrences[index] as ReturnType<typeof occurrence>;
	if (isLinked(shown.period) && shown.dueDate.slice(0, 7) < today.slice(0, 7))
		index += 1;
	const current = occurrences[index] as ReturnType<typeof occurrence>;
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
