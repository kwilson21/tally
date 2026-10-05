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

/** A payment from the bill's merchant at another price, asked about on the occurrence it would pay (P36 B). */
export type OccurrencePriceOffer = {
	transactionId: number;
	/** Who charged it, as a person knows the merchant ("Netflix"). */
	merchant: string;
	amountCents: number;
	dateLabel: string;
	billAmountCents: number;
	frequency: "monthly" | "yearly";
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

/**
 * The question in place of "Link a payment" (P36 B, decision 72): what was charged against what the bill
 * says, what updating does, one primary action and "Not this bill" as terracotta text. Each is its own
 * form, so both work without JavaScript, and the payment's id travels with them so a stale page can't
 * answer for another payment.
 */
function PriceChanged({
	billId,
	period,
	offer,
}: {
	billId: number;
	period: string;
	offer: OccurrencePriceOffer;
}) {
	const answer = (verb: "accept" | "dismiss") =>
		`/bills/${billId}/occurrences/${period}/price/${verb}`;
	const charged = formatCents(offer.amountCents);
	return (
		<>
			<p class="mt-1 text-lg">
				{`${offer.merchant} charged ${charged} on ${offer.dateLabel}, not ${formatCents(offer.billAmountCents)}.`}
			</p>
			<p class="text-muted">
				{`Updating the bill links that payment and makes it ${charged} ${offer.frequency === "monthly" ? "a month" : "a year"}.`}
			</p>
			<form
				method="post"
				action={answer("accept")}
				hx-post={answer("accept")}
				hx-target="body"
				hx-swap="outerHTML"
				class="mt-3"
			>
				<input
					type="hidden"
					name="transaction_id"
					value={offer.transactionId}
				/>
				<Button type="submit" busyLabel="Updating…">
					{`Update the bill to ${charged}`}
				</Button>
			</form>
			<form
				method="post"
				action={answer("dismiss")}
				hx-post={answer("dismiss")}
				hx-target="body"
				hx-swap="outerHTML"
			>
				<input
					type="hidden"
					name="transaction_id"
					value={offer.transactionId}
				/>
				<Button kind="text" type="submit" class="-ml-2">
					Not this bill
				</Button>
			</form>
		</>
	);
}

/** One occurrence on a bill page, including its real link/unlink controls. */
export function BillOccurrenceRow({
	billId,
	period,
	label,
	status,
	payment,
	priceOffer,
}: {
	billId: number;
	period: string;
	label: string;
	status: BillStatus | "not-paid";
	payment?: OccurrencePayment;
	priceOffer?: OccurrencePriceOffer | null;
}) {
	const unlink = `/bills/${billId}/occurrences/${period}/unlink`;
	if (priceOffer && !payment)
		return (
			<li class="py-2">
				<p class="flex justify-between gap-3">
					<span class="text-lg">{label}</span>
					<StatusTag status={status} />
				</p>
				<PriceChanged billId={billId} period={period} offer={priceOffer} />
			</li>
		);
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
