import type { BillStatus } from "../bills/status";
import { formatCents } from "../money";
import { Button } from "./button";
import { Icon } from "./icons";

export type OccurrencePayment = {
	displayName: string;
	dateLabel: string;
	amountCents: number;
	matchedBy: "auto" | "user";
};

const statusLabel: Record<BillStatus | "not-paid", string> = {
	paid: "Paid",
	overdue: "Overdue",
	due: "Due",
	upcoming: "Upcoming",
	"not-paid": "Not paid",
};

const statusLook = {
	paid: { icon: "check", tone: "text-ok" },
	overdue: { icon: "alert", tone: "text-over" },
	due: { icon: "bills", tone: "text-ink" },
	upcoming: { icon: "bills", tone: "text-muted" },
	"not-paid": { icon: "bills", tone: "text-muted" },
} as const;

export function StatusTag({ status }: { status: BillStatus | "not-paid" }) {
	const look = statusLook[status];
	return (
		<span class="inline-flex shrink-0 items-center gap-1 rounded-control bg-band px-2 text-sm text-ink">
			<span class={look.tone}>
				<Icon name={look.icon} class="size-4" />
			</span>
			{statusLabel[status]}
		</span>
	);
}

/** One occurrence on a bill page, including its real link/unlink controls. */
export function BillOccurrenceRow({
	billId,
	period,
	label,
	status,
	payment,
}: {
	billId: number;
	period: string;
	label: string;
	status: BillStatus | "not-paid";
	payment?: OccurrencePayment;
}) {
	const unlink = `/bills/${billId}/occurrences/${period}/unlink`;
	return (
		<li class="py-2">
			<p class="flex justify-between gap-3">
				<span class="text-lg">{label}</span>
				<StatusTag status={status} />
			</p>
			<p class="text-muted">
				{payment
					? `${payment.displayName} · ${payment.dateLabel} · ${formatCents(payment.amountCents)}${payment.matchedBy === "user" ? " · by hand" : ""}`
					: "No payment linked yet"}
			</p>
			{payment ? (
				<form
					method="post"
					action={unlink}
					hx-post={unlink}
					hx-target="body"
					hx-swap="outerHTML"
				>
					<Button kind="text" type="submit" class="-ml-2">
						Not this one
					</Button>
				</form>
			) : (
				<Button
					kind="text"
					class="-ml-2"
					href={`/bills/${billId}/occurrences/${period}/link#payment-picker`}
				>
					Link a payment
				</Button>
			)}
		</li>
	);
}
