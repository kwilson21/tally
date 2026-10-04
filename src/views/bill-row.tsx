import type { BillStatus } from "../bills/status";
import { dayLabel } from "../dates";
import { formatCents } from "../money";
import { CategoryIcon } from "./category";
import { Icon } from "./icons";

export type BillRowData = {
	id: number;
	name: string;
	amountCents: number;
	status: BillStatus;
	dueDate: string;
	paidDate?: string | null;
	icon: string;
	color: string;
};

const STATUS_HEADING = {
	overdue: { text: "Overdue", icon: "alert", tone: "text-over" },
	due: { text: "Due in the next 7 days", icon: "bills", tone: "text-ink" },
	upcoming: { text: "Upcoming", icon: "bills", tone: "text-muted" },
	paid: { text: "Paid this month", icon: "check", tone: "text-ok" },
} as const;

/** A bill group names status with both an icon and words, never color alone. */
export function BillStatusHeading({ status }: { status: BillStatus }) {
	const look = STATUS_HEADING[status];
	return (
		<h2 class="flex items-center gap-2 text-sm text-muted">
			<span class={look.tone}>
				<Icon name={look.icon} class="size-4" />
			</span>
			{look.text}
		</h2>
	);
}

export function billStatusLine(bill: BillRowData, today: string) {
	if (bill.status === "paid" && bill.paidDate) {
		const late = Math.max(
			0,
			calendarDay(bill.paidDate) - calendarDay(bill.dueDate),
		);
		return `Paid ${dayLabel(bill.paidDate, today)}${late ? `, ${late} ${late === 1 ? "day" : "days"} late` : ""}`;
	}
	return `${bill.status === "overdue" ? "Was due" : "Due"} ${dayLabel(bill.dueDate, today)}`;
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

/** One bill: category, name, status sentence, and its amount. */
export function BillRow({
	bill,
	today,
	href,
}: {
	bill: BillRowData;
	today: string;
	href?: string;
}) {
	const content = (
		<>
			<CategoryIcon icon={bill.icon} color={bill.color} />
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">{bill.name}</span>
				<span class="block truncate leading-6 text-muted">
					{billStatusLine(bill, today)}
				</span>
			</span>
			<span class="shrink-0 text-lg">{formatCents(bill.amountCents)}</span>
		</>
	);
	return (
		<li>
			{href ? (
				<a
					href={href}
					class="flex min-h-16 items-center gap-4 text-ink no-underline"
				>
					{content}
				</a>
			) : (
				<span class="flex min-h-16 items-center gap-4">{content}</span>
			)}
		</li>
	);
}
