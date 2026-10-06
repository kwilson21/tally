import type { BillStatus } from "../bills/status";
import { dayLabel, shortDay } from "../dates";
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
	/** A payment from this bill's merchant at another price, offered instead of matched (spec §8.5, P36 B). */
	priceOffer?: { amountCents: number; date: string } | null;
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
						{billStatusLine(bill, today)}
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
				<a href={href} class={`${look} text-ink no-underline`}>
					{content}
				</a>
			) : (
				<span class={look}>{content}</span>
			)}
		</li>
	);
}
