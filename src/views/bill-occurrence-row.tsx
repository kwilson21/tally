import type { BillStatus } from "../bills/status";
import { formatCents } from "../money";
import { Button } from "./button";

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

export function StatusTag({ status }: { status: BillStatus | "not-paid" }) {
	const tone =
		status === "overdue"
			? "text-over"
			: status === "paid"
				? "text-ok"
				: "text-muted";
	return <span class={`text-sm ${tone}`}>{statusLabel[status]}</span>;
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
					? `${payment.displayName} · ${payment.dateLabel} · ${formatCents(payment.amountCents)} · ${payment.matchedBy === "user" ? "linked by you" : "matched"}`
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
					<Button kind="text" type="submit">
						Not this one
					</Button>
				</form>
			) : (
				<Button
					kind="text"
					href={`/bills/${billId}/occurrences/${period}/link#payment-picker`}
				>
					Link a payment
				</Button>
			)}
		</li>
	);
}
