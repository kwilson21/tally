import {
	type BillFrequency,
	type BillStatus,
	billCadenceLabel,
	billScheduleLabel,
	partPaidSentence,
} from "../bills/status";
import { dayLabel, monthDay, shortDay } from "../dates";
import { formatCents } from "../money";
import { CategoryIcon } from "./category";
import { Icon, ROW_OPENS, RowArrow } from "./icons";
import { WhyLink } from "./why-link";

export type BillRowData = {
	id: number;
	name: string;
	amountCents: number;
	status: BillStatus;
	dueDate: string;
	paidDate?: string | null;
	/** What the occurrence's linked payments add up to (decision 101); above zero, a part-paid row says so. */
	paidCents?: number;
	/** A payment from this bill's merchant at another price, offered instead of matched (spec §8.5, P36 B). */
	priceOffer?: { amountCents: number; date: string } | null;
	icon: string;
	color: string;
	frequency?: BillFrequency;
	dueDay?: number;
	/** The month a yearly or quarterly bill is anchored to (`bills.anchor_month`). */
	anchorMonth?: number | null;
	/** False for an inactive bill, whose row shows its schedule instead of a status sentence. Absent counts as active. */
	active?: boolean;
};

const STATUS_HEADING = {
	overdue: {
		text: "Overdue",
		icon: "alert",
		tone: "text-over",
		why: "overdue",
	},
	due: {
		text: "Due in the next 7 days",
		icon: "bills",
		tone: "text-ink",
		why: "due in the next 7 days",
	},
	upcoming: {
		text: "Upcoming",
		icon: "bills",
		tone: "text-muted",
		why: "upcoming",
	},
	paid: {
		text: "Paid this month",
		icon: "check",
		tone: "text-ok",
		why: "paid this month",
	},
} as const;

/**
 * A bill group names status with both an icon and words, never color alone, then a Why? to How Tally works'
 * Bills section (decision 65, #341). The Why? sits beside the heading, not inside it, so the heading's name stays
 * the status; the group's total ends the row.
 */
export function BillStatusHeading({
	status,
	totalCents,
	includes,
}: {
	status: BillStatus;
	totalCents?: number;
	/** The muted line naming the occurrences the total counts that no row lists (`includesLine`, decision 122). */
	includes?: string;
}) {
	const look = STATUS_HEADING[status];
	const heading = (
		<div class="flex items-center gap-2 text-sm text-muted">
			<h2 class="flex min-w-0 items-center gap-2">
				<span class={look.tone}>
					<Icon name={look.icon} class="size-4" />
				</span>
				{look.text}
			</h2>
			<span aria-hidden="true">·</span>
			<WhyLink section="bills" topic={look.why} />
			{totalCents !== undefined && (
				<span class="ml-auto shrink-0">
					{formatCents(totalCents)}
					{status === "upcoming" ? " this month" : ""}
				</span>
			)}
		</div>
	);
	if (!includes) return heading;
	return (
		<>
			{heading}
			<p class="text-sm text-muted">{includes}</p>
		</>
	);
}

/** A bill whose occurrences a status heading counts that no row lists (decision 122): its name, frequency and those dates. */
export type UnlistedBill = {
	name: string;
	frequency: BillFrequency;
	/** The dates a heading counts for this bill, YYYY-MM-DD. */
	dueDates: string[];
};

/**
 * The muted line under a status heading whose total counts occurrences no row lists (decision 122, P136 A): "Includes
 * Daycare's Fridays on Oct 2 and 9", naming up to two bills, then "and N more". A weekly or every-two-weeks bill's
 * dates are named by their weekday; any other bill's by its date. Undefined when no occurrence is unlisted.
 */
export function includesLine(bills: UnlistedBill[]) {
	if (!bills.length) return undefined;
	const named = bills.slice(0, 2).map(unlistedBillWords);
	const more = bills.length - named.length;
	return `Includes ${named.join(", ")}${more ? `, and ${more} more` : ""}`;
}

function unlistedBillWords({ name, frequency, dueDates }: UnlistedBill) {
	const dates = [...dueDates].sort();
	// A date in the month before the one named is written with its month again: "Oct 30 and Nov 6".
	const days = dates.map((date, i) =>
		i > 0 && date.slice(0, 7) === dates[i - 1]?.slice(0, 7)
			? String(Number(date.slice(8, 10)))
			: monthDay(Number(date.slice(5, 7)), Number(date.slice(8, 10))),
	);
	const list =
		days.length > 1
			? `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`
			: days[0];
	if (frequency === "weekly" || frequency === "biweekly") {
		const weekday = new Intl.DateTimeFormat("en-US", {
			weekday: "long",
			timeZone: "UTC",
		}).format(new Date(`${dates[0]}T00:00:00Z`));
		return `${name}'s ${weekday}s on ${list}`;
	}
	return `${name} on ${list}`;
}

export function BillMonthlyTotal({
	monthlyCents,
	stillToPayCents,
	month,
}: {
	monthlyCents: number;
	stillToPayCents: number;
	month: string;
}) {
	const monthName = new Intl.DateTimeFormat("en-US", {
		month: "long",
		timeZone: "UTC",
	}).format(
		new Date(
			Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1),
		),
	);
	return (
		<p class="text-sm text-muted">
			{formatCents(monthlyCents, { wholeDollars: true })} a month in bills,{" "}
			{formatCents(stillToPayCents, { wholeDollars: true })} still to pay in{" "}
			{monthName}
		</p>
	);
}

export function billStatusLine(bill: BillRowData, today: string) {
	// dayLabel starts a line ("Today, Oct 5"); here it follows "Paid" or "Due", so it reads "today".
	const day = (date: string) =>
		dayLabel(date, today).replace(/^Today/, "today");
	if (bill.status === "paid" && bill.paidDate) {
		const late = Math.max(
			0,
			calendarDay(bill.paidDate) - calendarDay(bill.dueDate),
		);
		return `Paid ${day(bill.paidDate)}${late ? `, ${late} ${late === 1 ? "day" : "days"} late` : ""}`;
	}
	// A part-paid occurrence keeps its date's status heading and says what has been paid (decision 101).
	if (bill.status !== "paid" && (bill.paidCents ?? 0) > 0)
		return partPaidSentence(bill.paidCents ?? 0, bill.amountCents);
	return `${bill.status === "overdue" ? "Was due" : "Due"} ${day(bill.dueDate)}`;
}

function calendarDay(value: string) {
	return Math.floor(
		Date.UTC(
			Number(value.slice(0, 4)),
			Number(value.slice(5, 7)) - 1,
			Number(value.slice(8, 10)),
		) / 86400000,
	);
}

/**
 * A row's muted second line: an inactive bill's schedule (#341), else its status sentence, with a weekly or
 * every-two-weeks bill's interval after it.
 */
function secondLine(bill: BillRowData, today: string) {
	if (bill.active === false)
		return billScheduleLabel({
			frequency: bill.frequency ?? "monthly",
			dueDay: bill.dueDay ?? 1,
			anchorMonth: bill.anchorMonth,
		});
	return `${billStatusLine(bill, today)}${
		bill.frequency && ["weekly", "biweekly"].includes(bill.frequency)
			? ` · ${billCadenceLabel({ frequency: bill.frequency, dueDay: bill.dueDay ?? 1 })}`
			: ""
	}`;
}

/**
 * One bill: category, name, status sentence, and its amount. When a payment from the same merchant came at
 * another price, the status sentence is two caption lines instead (P36 B, decision 72): "Price changed?" in
 * ink, then what was paid in muted words. The row grows a line, so they aren't truncated on a phone, and it
 * keeps its place under its status heading and its own amount.
 */
export function BillRow({
	bill,
	today,
	href,
}: {
	bill: BillRowData;
	today: string;
	href?: string;
}) {
	const offer = bill.priceOffer;
	const content = (
		<>
			<CategoryIcon icon={bill.icon} color={bill.color} />
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">{bill.name}</span>
				{offer ? (
					<>
						<span class="block leading-6">Price changed?</span>
						<span class="block leading-6 text-muted">
							{`Paid ${formatCents(offer.amountCents)} on ${shortDay(offer.date, today)}`}
						</span>
					</>
				) : (
					<span class="block truncate leading-6 text-muted">
						{secondLine(bill, today)}
					</span>
				)}
			</span>
			<span class="shrink-0 text-lg">{formatCents(bill.amountCents)}</span>
		</>
	);
	const look = `flex min-h-16 items-center gap-4${offer ? " py-2" : ""}`;
	return (
		<li>
			{href ? (
				<a
					href={href}
					class={`${look} text-ink no-underline ${ROW_OPENS}`}
					data-row=""
				>
					{content}
					<RowArrow />
				</a>
			) : (
				<span class={look}>{content}</span>
			)}
		</li>
	);
}
