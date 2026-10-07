export type BillStatus = "paid" | "overdue" | "due" | "upcoming";
export type BillFrequency =
	| "monthly"
	| "yearly"
	| "weekly"
	| "biweekly"
	| "quarterly";

export type BillSchedule = {
	frequency: BillFrequency;
	dueDay: number;
	anchorMonth?: number | null;
	anchorDate?: string | null;
};

export function billCadenceLabel(bill: BillSchedule) {
	if (bill.frequency === "weekly")
		return `every ${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][bill.dueDay - 1]}`;
	if (bill.frequency === "biweekly") return "every two weeks";
	if (bill.frequency === "quarterly") return "every 3 months";
	return bill.frequency === "yearly" ? "a year" : "a month";
}

function leap(year: number) {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number) {
	return [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
		month - 1
	] as number;
}

const dateNumber = (date: string) =>
	Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
const fromNumber = (day: number) =>
	new Date(day * 86_400_000).toISOString().slice(0, 10);

export function billOccurrenceForMonth(
	bill: BillSchedule,
	year: number,
	month: number,
) {
	const day = Math.min(bill.dueDay, daysInMonth(year, month));
	const dueDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	const quarter = Math.floor((month - 1) / 3) + 1;
	return {
		dueDate,
		period:
			bill.frequency === "yearly"
				? String(year)
				: bill.frequency === "quarterly"
					? `${year}-Q${quarter}`
					: dueDate.slice(0, 7),
	};
}

export function billOccurrencesForMonth(
	bill: BillSchedule,
	year: number,
	month: number,
) {
	const days = daysInMonth(year, month);
	const result: ReturnType<typeof billOccurrenceForMonth>[] = [];
	for (let day = 1; day <= days; day++) {
		const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
		if (bill.frequency === "monthly")
			result.push(billOccurrenceForMonth(bill, year, month));
		else if (bill.frequency === "yearly" && month === bill.anchorMonth)
			result.push(billOccurrenceForMonth(bill, year, month));
		else if (
			bill.frequency === "quarterly" &&
			(month - (bill.anchorMonth ?? 1) + 12) % 3 === 0
		)
			result.push(billOccurrenceForMonth(bill, year, month));
		else if (
			bill.frequency === "weekly" &&
			((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1 === bill.dueDay
		)
			result.push({ dueDate: date, period: date });
		else if (
			bill.frequency === "biweekly" &&
			bill.anchorDate &&
			(dateNumber(date) - dateNumber(bill.anchorDate)) % 14 === 0
		)
			result.push({ dueDate: date, period: date });
		if (
			bill.frequency === "monthly" ||
			bill.frequency === "yearly" ||
			bill.frequency === "quarterly"
		)
			break;
	}
	return result;
}

function addMonth(year: number, month: number) {
	return month === 12 ? [year + 1, 1] : [year, month + 1];
}

function daysBetween(from: string, to: string) {
	return dateNumber(to) - dateNumber(from);
}

function periodicOccurrences(bill: BillSchedule, today: string) {
	const todayNumber = dateNumber(today);
	if (bill.frequency === "weekly" || bill.frequency === "biweekly") {
		const anchor =
			bill.frequency === "weekly"
				? fromNumber(
						dateNumber(today) -
							((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) +
							((bill.dueDay - 1) % 7),
					)
				: (bill.anchorDate ?? today);
		const step = bill.frequency === "weekly" ? 7 : 14;
		const anchorNumber = dateNumber(anchor);
		const firstIndex = Math.floor((todayNumber - 35 - anchorNumber) / step);
		return Array.from({ length: 16 }, (_, i) => {
			const dueDate = fromNumber(anchorNumber + (firstIndex + i) * step);
			return { dueDate, period: dueDate };
		});
	}
	const occurrences: ReturnType<typeof billOccurrenceForMonth>[] = [];
	let year = Number(today.slice(0, 4)) - 1;
	let month = 1;
	while (year <= Number(today.slice(0, 4)) + 2) {
		if (bill.frequency === "yearly" && month === (bill.anchorMonth ?? 1))
			occurrences.push(billOccurrenceForMonth(bill, year, month));
		else if (
			bill.frequency === "quarterly" &&
			(month - (bill.anchorMonth ?? 1) + 12) % 3 === 0
		)
			occurrences.push(billOccurrenceForMonth(bill, year, month));
		else if (bill.frequency === "monthly")
			occurrences.push(billOccurrenceForMonth(bill, year, month));
		[year, month] = addMonth(year, month) as [number, number];
	}
	return occurrences;
}

/** The occurrence a person needs to act on (decision 62). */
export function billOccurrence(
	bill: BillSchedule,
	today: string,
	linked: boolean | ReadonlySet<string>,
): { dueDate: string; period: string; status: BillStatus } {
	const occurrences = periodicOccurrences(bill, today);
	const isLinked = (period: string) =>
		typeof linked === "boolean" ? linked : linked.has(period);
	if (bill.frequency === "weekly" || bill.frequency === "biweekly") {
		let index = occurrences.findIndex((o) => o.dueDate >= today);
		if (index < 0) index = occurrences.length - 1;
		if (index > 0 && occurrences[index]?.dueDate !== today) index--;
		let current = occurrences[index] as ReturnType<
			typeof billOccurrenceForMonth
		>;
		if (isLinked(current.period) || current.dueDate < today) {
			const next = occurrences[index + 1];
			if (next && next.dueDate <= today) {
				current = next;
			} else if (isLinked(current.period) && next) {
				current = next;
			}
		}
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
	// Monthly, yearly and quarterly schedules use the same seven-day handoff as decision 62.
	let index = occurrences.findIndex((o) => daysBetween(today, o.dueDate) > 7);
	if (index < 0) index = occurrences.length - 1;
	// Include the last missed occurrence until its successor enters the seven-day due window.
	if (index > 0) index--;
	let current = occurrences[index] as ReturnType<typeof billOccurrenceForMonth>;
	if (
		isLinked(current.period) &&
		current.dueDate.slice(0, 7) < today.slice(0, 7)
	) {
		index++;
		current = occurrences[index] as ReturnType<typeof billOccurrenceForMonth>;
	}
	if (
		isLinked(current.period) ||
		(current.dueDate < today && daysBetween(today, current.dueDate) < -7)
	) {
		const next = occurrences[index + 1];
		if (next && daysBetween(today, next.dueDate) <= 7) {
			index++;
			current = next;
		}
	}
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
